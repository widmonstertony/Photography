import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubClient } from './github.mjs';

test('waits for required media and any supported original to become visible', async () => {
  const client = new GitHubClient({ owner: 'owner', repository: 'repo', branch: 'media', config: {} });
  const attempts = new Map();
  client.getContent = async (path) => {
    const count = (attempts.get(path) ?? 0) + 1;
    attempts.set(path, count);
    return count > 1 && path !== 'missing.png' ? { path } : null;
  };

  const result = await client.waitForContents(
    { required: ['preview.webp'], any: ['original.jpg', 'missing.png'] },
    { delays: [0, 0] },
  );

  assert.deepEqual(result.required, [{ path: 'preview.webp' }]);
  assert.deepEqual(result.any, [{ path: 'original.jpg' }, null]);
});

test('commits an uploaded blob without force-updating the media branch', async () => {
  const client = new GitHubClient({ owner: 'owner', repository: 'repo', branch: 'media', config: {} });
  const calls = [];
  client.request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith('/git/ref/heads/media')) return { object: { sha: 'parent-commit' } };
    if (path.endsWith('/git/refs/heads/media')) return { object: { sha: 'new-commit' } };
    if (path.endsWith('/git/commits/parent-commit')) return { tree: { sha: 'parent-tree' } };
    if (path.endsWith('/git/trees')) return { sha: 'new-tree' };
    if (path.endsWith('/git/commits')) return { sha: 'new-commit' };
    throw new Error(`Unexpected request: ${path}`);
  };

  const result = await client.commitBlob('originals/2026/photo.jpg', 'blob-sha', 'Publish original photo');

  assert.equal(result.sha, 'new-commit');
  const treeBody = JSON.parse(calls.find(({ path }) => path.endsWith('/git/trees')).options.body);
  assert.deepEqual(treeBody, {
    base_tree: 'parent-tree',
    tree: [{ path: 'originals/2026/photo.jpg', mode: '100644', type: 'blob', sha: 'blob-sha' }],
  });
  const referenceUpdate = calls.find(({ path, options }) => path.endsWith('/git/refs/heads/media') && options.method === 'PATCH');
  assert.deepEqual(JSON.parse(referenceUpdate.options.body), { sha: 'new-commit', force: false });
});

test('creates the dedicated originals release and finds an uploaded asset', async () => {
  const client = new GitHubClient({ owner: 'owner', repository: 'repo', branch: 'media', config: {} });
  const calls = [];
  client.request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith('/releases/tags/photography-originals-v1')) {
      const error = new Error('missing');
      error.status = 404;
      throw error;
    }
    if (path.endsWith('/releases') && options.method === 'POST') return { id: 42 };
    if (path.includes('/releases/42/assets')) return [
      { id: 7, name: 'car.jpg', state: 'uploaded', size: 35_505_442, browser_download_url: 'https://github.com/owner/repo/releases/download/photography-originals-v1/car.jpg' },
    ];
    throw new Error(`Unexpected request: ${path}`);
  };

  const assets = await client.originalAssets(['car.jpg']);

  assert.equal(assets.get('car.jpg').size, 35_505_442);
  const create = calls.find(({ path, options }) => path.endsWith('/releases') && options.method === 'POST');
  assert.deepEqual(JSON.parse(create.options.body), {
    tag_name: 'photography-originals-v1', target_commitish: 'media', name: 'Original-resolution photography',
    body: 'Original-resolution media for the automotive photography gallery.', draft: false, prerelease: false,
    generate_release_notes: false, make_latest: 'false',
  });
});

test('lists release assets so an interrupted mobile upload can resume', async () => {
  const client = new GitHubClient({ owner: 'owner', repository: 'repo', branch: 'media', config: {} });
  client.originalsRelease = async () => ({ id: 42 });
  client.request = async (path) => {
    if (path.includes('page=1')) return [
      { id: 7, name: 'dsc05142-msqbl0zp-tyhzxc.jpg', state: 'uploaded', size: 35_505_442 },
    ];
    throw new Error(`Unexpected request: ${path}`);
  };

  const assets = await client.listOriginalAssets();

  assert.equal(assets.length, 1);
  assert.equal(assets[0].name, 'dsc05142-msqbl0zp-tyhzxc.jpg');
});

test('atomically removes repository media with the gallery record', async () => {
  const client = new GitHubClient({ owner: 'owner', repository: 'repo', branch: 'media', config: {} });
  const calls = [];
  client.request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.endsWith('/git/blobs')) return { sha: 'gallery-blob' };
    if (path.endsWith('/git/ref/heads/media')) return { object: { sha: 'parent-commit' } };
    if (path.includes('/contents/gallery.json?ref=parent-commit')) return { sha: 'expected-gallery' };
    if (path.includes('/contents/previews/2026/photo.jpg?ref=parent-commit')) return { sha: 'preview-blob' };
    if (path.endsWith('/git/commits/parent-commit')) return { tree: { sha: 'parent-tree' } };
    if (path.endsWith('/git/trees')) return { sha: 'new-tree' };
    if (path.endsWith('/git/commits')) return { sha: 'new-commit' };
    if (path.endsWith('/git/refs/heads/media')) return {};
    throw new Error(`Unexpected request: ${path}`);
  };

  await client.commitTextAndDelete(
    'gallery.json', '{"items":[]}', ['previews/2026/photo.jpg'], 'Delete photograph photo', 'expected-gallery',
  );

  const treeBody = JSON.parse(calls.find(({ path }) => path.endsWith('/git/trees')).options.body);
  assert.deepEqual(treeBody.tree, [
    { path: 'gallery.json', mode: '100644', type: 'blob', sha: 'gallery-blob' },
    { path: 'previews/2026/photo.jpg', mode: '100644', type: 'blob', sha: null },
  ]);
  const referenceUpdate = calls.find(({ path, options }) => path.endsWith('/git/refs/heads/media') && options.method === 'PATCH');
  assert.deepEqual(JSON.parse(referenceUpdate.options.body), { sha: 'new-commit', force: false });
});

test('deletes a release asset without treating an already-missing asset as a failure', async () => {
  const client = new GitHubClient({ owner: 'owner', repository: 'repo', branch: 'media', config: {} });
  const methods = [];
  client.request = async (path, options = {}) => {
    methods.push({ path, method: options.method });
    if (path.endsWith('/releases/assets/7')) return null;
    const error = new Error('missing');
    error.status = 404;
    throw error;
  };

  assert.equal(await client.deleteOriginalAsset(7), true);
  assert.equal(await client.deleteOriginalAsset(8), false);
  assert.deepEqual(methods.map(({ method }) => method), ['DELETE', 'DELETE']);
});
