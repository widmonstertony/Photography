import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticatedUser, convertAppManifest, exchangeOAuthCode, GitHubClient } from './github.mjs';
import {
  buildGalleryEntry, csrfForSession, galleryMediaTargets, instagramProfileUrl, issueSignedValue, mediaPath, newOpaqueToken,
  normalizeInstagramUsername, normalizePublishedPhoto, originalAssetName, parseCookies, PHOTO_LIMITS, PHOTO_TYPES,
  readSignedValue, secureEqual, updateGalleryEntryMetadata,
} from './policy.mjs';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4030);
const publicOrigin = process.env.PUBLIC_ORIGIN ?? 'https://tonytan.me';
const owner = process.env.PHOTOGRAPHY_GITHUB_OWNER ?? 'widmonstertony';
const repository = process.env.PHOTOGRAPHY_GITHUB_REPOSITORY ?? 'Photography';
const branch = process.env.PHOTOGRAPHY_GITHUB_MEDIA_BRANCH ?? 'media';
const adminLogin = (process.env.ADMIN_LOGIN ?? 'widmonstertony').toLowerCase();
const stateDirectory = process.env.STATE_DIRECTORY ?? '/var/lib/tonytan-photography';
const appConfigPath = join(stateDirectory, 'github-app.json');
const bootstrapTokenPath = join(stateDirectory, 'bootstrap-token');
const sessionSecret = Buffer.from((await readFile(join(stateDirectory, 'session-secret'), 'utf8')).trim(), 'base64url');
if (sessionSecret.length < 32) throw new Error('Photography session secret is invalid.');

let appConfig = await loadAppConfig();
let clientCache = null;
let galleryCache = { expiresAt: 0, value: null };
let uploadActive = false;
const uploadWindows = new Map();

async function loadAppConfig() {
  try {
    const value = JSON.parse(await readFile(appConfigPath, 'utf8'));
    if (!value.appId || !value.clientId || !value.clientSecret || !value.privateKey || !value.slug) return null;
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function saveAppConfig(value) {
  const temporary = `${appConfigPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, appConfigPath);
  appConfig = value;
  clientCache = null;
}

function githubClient(config = appConfig) {
  if (!config) throw new Error('APP_NOT_CONFIGURED');
  if (config === appConfig && clientCache) return clientCache;
  const client = new GitHubClient({ owner, repository, branch, config });
  if (config === appConfig) clientCache = client;
  return client;
}

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function json(response, status, payload, extra = {}) {
  response.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
  response.end(JSON.stringify(payload));
}

function html(response, status, body, extra = {}) {
  response.writeHead(status, securityHeaders({
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  }));
  response.end(body);
}

function redirect(response, location, cookies = []) {
  response.writeHead(303, securityHeaders({ Location: location, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) }));
  response.end();
}

function externalRedirect(response, location) {
  response.writeHead(302, securityHeaders({ Location: location }));
  response.end();
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/photography; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function requestPath(request) {
  const pathname = new URL(request.url, publicOrigin).pathname;
  return pathname.startsWith('/photography/api') ? pathname.slice('/photography/api'.length) || '/' : pathname;
}

function validOrigin(request) {
  return request.headers.origin === publicOrigin;
}

function sessionFor(request) {
  const value = parseCookies(request.headers.cookie).photography_session;
  const session = readSignedValue(value, sessionSecret);
  return session?.login?.toLowerCase() === adminLogin ? { ...session, value } : null;
}

function mutationAuthorized(request) {
  const session = sessionFor(request);
  if (!session || !validOrigin(request)) return null;
  return secureEqual(request.headers['x-csrf-token'], csrfForSession(session.value, sessionSecret)) ? session : null;
}

async function readBody(request, maximum) {
  const declared = Number(request.headers['content-length']);
  if (!Number.isInteger(declared) || declared < 0 || declared > maximum) throw new Error('BODY_TOO_LARGE');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function discardRequest(request) {
  if (request.complete || request.readableEnded || request.destroyed) return;
  await new Promise((resolve) => {
    const finish = () => {
      request.off('end', finish);
      request.off('aborted', finish);
      request.off('error', finish);
      resolve();
    };
    request.once('end', finish);
    request.once('aborted', finish);
    request.once('error', finish);
    request.resume();
  });
}

function setupPage(message = '') {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Configure Photography Publisher</title><style>body{min-height:100vh;margin:0;display:grid;place-items:center;background:#0a0b0d;color:#f3f1eb;font:16px system-ui}main{width:min(520px,calc(100% - 40px));padding:42px;border:1px solid #444;background:#111317}h1{font:42px Georgia;margin:0 0 15px}p{color:#a7aab0;line-height:1.6}label{display:grid;gap:8px;margin:28px 0}input{padding:13px;background:#060708;border:1px solid #555;color:#fff}button{padding:13px 18px;border:0;background:#ff5d3a;font-weight:800;cursor:pointer}.message{color:#ffb19f}</style><main><h1>Photography Publisher</h1><p>One-time setup creates a private GitHub App with write access limited to the selected Photography repository.</p>${message ? `<p class="message">${message}</p>` : ''}<form method="post" action="/photography/api/setup/start"><label>One-time bootstrap code<input name="token" type="password" autocomplete="one-time-code" required></label><button type="submit">Create restricted GitHub App →</button></form></main></html>`;
}

async function loadGallery(client = null) {
  if (galleryCache.value && galleryCache.expiresAt > Date.now()) return galleryCache.value;
  let payload;
  if (client) {
    const content = await client.getContent('gallery.json');
    payload = JSON.parse(Buffer.from(content.content.replaceAll(/\s/g, ''), 'base64').toString('utf8'));
  } else {
    const response = await fetch(`https://raw.githubusercontent.com/${owner}/${repository}/${branch}/gallery.json`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error('GALLERY_UNAVAILABLE');
    payload = await response.json();
  }
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.items)) throw new Error('GALLERY_INVALID');
  try { payload.instagramUsername = normalizeInstagramUsername(payload.instagramUsername); }
  catch { payload.instagramUsername = ''; }
  payload.items = payload.items.slice(0, PHOTO_LIMITS.galleryItems);
  galleryCache = { value: payload, expiresAt: Date.now() + 30_000 };
  return payload;
}

function manifestInstagramUsername(value) {
  try { return normalizeInstagramUsername(value); }
  catch { return ''; }
}

function updatedGallery(manifest, items, options = {}) {
  const instagramUsername = Object.hasOwn(options, 'instagramUsername')
    ? normalizeInstagramUsername(options.instagramUsername)
    : manifestInstagramUsername(manifest.instagramUsername);
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    instagramUsername,
    items: items.slice(0, PHOTO_LIMITS.galleryItems),
  };
}

function checkUploadRate(session) {
  const now = Date.now();
  const current = uploadWindows.get(session.login) ?? [];
  const recent = current.filter((time) => time > now - 3_600_000);
  if (recent.length >= PHOTO_LIMITS.uploadsPerHour) return false;
  recent.push(now);
  uploadWindows.set(session.login, recent);
  return true;
}

async function handleSetup(request, response, url, path) {
  if (path === '/setup' && request.method === 'GET') {
    if (appConfig?.installationId) { redirect(response, '/photography/manage'); return true; }
    html(response, 200, setupPage());
    return true;
  }
  if (path === '/setup/start' && request.method === 'POST') {
    if (appConfig) { json(response, 409, { error: 'ALREADY_CONFIGURED' }); return true; }
    const form = new URLSearchParams(await readBody(request, 4096));
    const supplied = form.get('token') ?? '';
    let expected = '';
    try { expected = (await readFile(bootstrapTokenPath, 'utf8')).trim(); } catch { /* handled below */ }
    if (!expected || !secureEqual(supplied, expected)) { html(response, 403, setupPage('The bootstrap code is not valid.')); return true; }
    const state = newOpaqueToken();
    const manifest = {
      name: 'Tony Tan Photography Publisher',
      url: `${publicOrigin}/photography`,
      description: 'Private automotive photography publisher for Tony Tan.',
      redirect_url: `${publicOrigin}/photography/api/setup/callback`,
      callback_urls: [`${publicOrigin}/photography/api/auth/callback`],
      setup_url: `${publicOrigin}/photography/api/setup/installed`,
      public: false,
      default_events: [],
      default_permissions: { contents: 'write' },
      request_oauth_on_install: false,
    };
    html(response, 200, `<!doctype html><html lang="en"><meta charset="utf-8"><title>Register publisher</title><style>body{background:#0a0b0d;color:#fff;font:16px system-ui;padding:50px}button{padding:14px 20px;background:#ff5d3a;border:0;font-weight:800}</style><h1>Continue on GitHub</h1><p>GitHub will show the exact one-repository permission before creating the app.</p><form action="https://github.com/settings/apps/new?state=${encodeURIComponent(state)}" method="post"><input type="hidden" name="manifest" value="${String(JSON.stringify(manifest)).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}"><button type="submit">Review and create GitHub App →</button></form></html>`, { 'Set-Cookie': cookie('photography_setup_state', state, 3600) });
    return true;
  }
  if (path === '/setup/callback' && request.method === 'GET') {
    const state = parseCookies(request.headers.cookie).photography_setup_state;
    if (!state || !secureEqual(url.searchParams.get('state'), state) || !url.searchParams.get('code') || appConfig) { json(response, 403, { error: 'INVALID_SETUP_CALLBACK' }); return true; }
    const result = await convertAppManifest(url.searchParams.get('code'));
    await saveAppConfig({ appId: result.id, clientId: result.client_id, clientSecret: result.client_secret, privateKey: result.pem, slug: result.slug, installationId: null });
    await unlink(bootstrapTokenPath).catch(() => {});
    redirect(response, `https://github.com/apps/${encodeURIComponent(result.slug)}/installations/new`, [cookie('photography_setup_state', '', 0)]);
    return true;
  }
  if (path === '/setup/installed' && request.method === 'GET') {
    if (!appConfig || appConfig.installationId || !url.searchParams.get('installation_id')) { redirect(response, '/photography/manage'); return true; }
    const installationId = await githubClient().validateInstallation(url.searchParams.get('installation_id'));
    await saveAppConfig({ ...appConfig, installationId });
    redirect(response, '/photography/manage?installed=1');
    return true;
  }
  return false;
}

async function handleAuth(request, response, url, path) {
  if (path === '/auth/start' && request.method === 'GET') {
    if (!appConfig?.installationId) { redirect(response, '/photography/manage'); return true; }
    const state = newOpaqueToken();
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.searchParams.set('client_id', appConfig.clientId);
    authorize.searchParams.set('redirect_uri', `${publicOrigin}/photography/api/auth/callback`);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('login', adminLogin);
    authorize.searchParams.set('allow_signup', 'false');
    redirect(response, authorize.toString(), [cookie('photography_oauth_state', state, 600)]);
    return true;
  }
  if (path === '/auth/callback' && request.method === 'GET') {
    const state = parseCookies(request.headers.cookie).photography_oauth_state;
    if (!state || !secureEqual(url.searchParams.get('state'), state) || !url.searchParams.get('code') || !appConfig?.installationId) { json(response, 403, { error: 'INVALID_AUTH_CALLBACK' }); return true; }
    const token = await exchangeOAuthCode(appConfig, url.searchParams.get('code'), `${publicOrigin}/photography/api/auth/callback`);
    const user = await authenticatedUser(token);
    if (user.login?.toLowerCase() !== adminLogin) { json(response, 403, { error: 'ADMIN_ONLY' }); return true; }
    const session = issueSignedValue({ login: adminLogin }, sessionSecret, 8 * 60 * 60);
    redirect(response, '/photography/manage', [cookie('photography_session', session, 8 * 60 * 60), cookie('photography_oauth_state', '', 0)]);
    return true;
  }
  if (path === '/auth/logout' && request.method === 'POST') {
    const session = mutationAuthorized(request);
    if (!session) { json(response, 403, { error: 'FORBIDDEN' }); return true; }
    json(response, 200, { ok: true }, { 'Set-Cookie': cookie('photography_session', '', 0) });
    return true;
  }
  return false;
}

async function handleUpload(request, response, url, path) {
  const match = path.match(/^\/upload\/(original|preview)$/);
  if (!match || request.method !== 'POST') return false;
  const session = mutationAuthorized(request);
  if (!session) { await discardRequest(request); json(response, 403, { error: 'FORBIDDEN' }); return true; }
  if (uploadActive || !checkUploadRate(session)) { await discardRequest(request); json(response, 429, { error: 'UPLOAD_BUSY' }, { 'Retry-After': '15' }); return true; }
  const kind = match[1];
  const extension = String(url.searchParams.get('extension') ?? '').toLowerCase();
  const id = String(url.searchParams.get('id') ?? '');
  const expectedType = PHOTO_TYPES[kind].get(extension);
  const contentType = String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const expectedBytes = Number(request.headers['content-length']);
  const maximum = kind === 'original' ? PHOTO_LIMITS.originalBytes : PHOTO_LIMITS.previewBytes;
  if (!expectedType || contentType !== expectedType || !Number.isInteger(expectedBytes) || expectedBytes < 12 || expectedBytes > maximum) { await discardRequest(request); json(response, 400, { error: 'INVALID_UPLOAD' }); return true; }
  let target;
  try { target = kind === 'original' ? originalAssetName(id, extension) : mediaPath(kind, id, extension); }
  catch { await discardRequest(request); json(response, 400, { error: 'INVALID_UPLOAD' }); return true; }
  uploadActive = true;
  try {
    const client = githubClient();
    if (kind === 'original') {
      const asset = await client.uploadOriginalAsset(target, request, { contentType, expectedBytes });
      json(response, asset.existing ? 200 : 201, { ok: true, path: target, existing: asset.existing === true });
      return true;
    }
    const existing = await client.getContent(target);
    if (existing) {
      await discardRequest(request);
      if (existing.size !== expectedBytes) { json(response, 409, { error: 'PHOTO_ID_CONFLICT' }); return true; }
      json(response, 200, { ok: true, path: target, existing: true });
      return true;
    }
    await client.uploadStream(target, request, { contentType, expectedBytes, message: `Publish ${kind} ${id}` });
    json(response, 201, { ok: true, path: target });
  } catch (error) {
    await discardRequest(request);
    console.error(`Photography media upload failed: kind=${kind} bytes=${expectedBytes} github_status=${Number.isInteger(error.status) ? error.status : 'network'} code=${error.message}`);
    if (['INVALID_IMAGE', 'UPLOAD_LENGTH_MISMATCH'].includes(error.message)) json(response, 400, { error: error.message === 'INVALID_IMAGE' ? 'INVALID_IMAGE' : 'INVALID_UPLOAD' });
    else if (error.message === 'PHOTO_ID_CONFLICT') json(response, 409, { error: 'PHOTO_ID_CONFLICT' });
    else json(response, 502, { error: 'GITHUB_UPLOAD_FAILED' });
  } finally { uploadActive = false; }
  return true;
}

async function handleUploadLookup(request, response, url, path) {
  if (request.method !== 'GET' || !['/upload/status', '/upload/resume'].includes(path)) return false;
  if (!sessionFor(request)) { json(response, 403, { error: 'FORBIDDEN' }); return true; }
  const extension = String(url.searchParams.get('extension') ?? '').toLowerCase();
  const expectedBytes = Number(url.searchParams.get('bytes'));
  if (!PHOTO_TYPES.original.has(extension) || !Number.isInteger(expectedBytes) || expectedBytes < 12 || expectedBytes > PHOTO_LIMITS.originalBytes) {
    json(response, 400, { error: 'INVALID_UPLOAD' });
    return true;
  }

  const client = githubClient();
  if (path === '/upload/status') {
    let name;
    try { name = originalAssetName(String(url.searchParams.get('id') ?? ''), extension); }
    catch { json(response, 400, { error: 'INVALID_UPLOAD' }); return true; }
    const asset = (await client.originalAssets([name])).get(name);
    json(response, 200, { uploaded: asset?.state === 'uploaded' && asset.size === expectedBytes });
    return true;
  }

  const slug = String(url.searchParams.get('slug') ?? '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,29})$/.test(slug)) { json(response, 400, { error: 'INVALID_UPLOAD' }); return true; }
  const gallery = await loadGallery(client);
  const publishedIds = new Set(gallery.items.map((item) => item.id));
  const suffix = `.${extension}`;
  const matches = (await client.listOriginalAssets())
    .filter((asset) => asset.state === 'uploaded' && asset.size === expectedBytes && asset.name.startsWith(`${slug}-`) && asset.name.endsWith(suffix))
    .map((asset) => ({ asset, id: asset.name.slice(0, -suffix.length) }))
    .filter(({ asset, id }) => {
      if (publishedIds.has(id)) return false;
      try { return originalAssetName(id, extension) === asset.name; } catch { return false; }
    })
    .sort((left, right) => Date.parse(right.asset.updated_at ?? right.asset.created_at ?? 0) - Date.parse(left.asset.updated_at ?? left.asset.created_at ?? 0));
  json(response, 200, { id: matches[0]?.id ?? null });
  return true;
}

async function publishPhoto(request, response) {
  const session = mutationAuthorized(request);
  if (!session) { json(response, 403, { error: 'FORBIDDEN' }); return; }
  let photo;
  try { photo = normalizePublishedPhoto(JSON.parse(await readBody(request, PHOTO_LIMITS.jsonBytes))); }
  catch (error) { json(response, 400, { error: error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_METADATA' }); return; }
  const client = githubClient();
  const extensions = [...PHOTO_TYPES.original.keys()];
  const assetCandidates = extensions.map((extension) => originalAssetName(photo.id, extension));
  const legacyCandidates = extensions.map((extension) => mediaPath('original', photo.id, extension));
  const previewCandidates = [...PHOTO_TYPES.preview.keys()].map((extension) => mediaPath('preview', photo.id, extension));
  const [visiblePreviews, legacyFiles, assets] = await Promise.all([
    client.waitForContents({ any: previewCandidates }),
    Promise.all(legacyCandidates.map((candidate) => client.getContent(candidate))),
    client.originalAssets(assetCandidates),
  ]);
  const releaseAsset = assetCandidates.map((name) => assets.get(name)).find((asset) => asset?.state === 'uploaded');
  const legacyPath = legacyCandidates.find((candidate, index) => legacyFiles[index]);
  const previewPath = previewCandidates.find((candidate, index) => visiblePreviews?.any[index]);
  const originalLocation = releaseAsset?.browser_download_url ?? legacyPath;
  if (!originalLocation || !previewPath) { json(response, 409, { error: 'UPLOAD_INCOMPLETE' }); return; }
  const entry = buildGalleryEntry(photo, originalLocation, previewPath, owner, repository);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifestFile = await client.getContent('gallery.json');
    const manifest = JSON.parse(Buffer.from(manifestFile.content.replaceAll(/\s/g, ''), 'base64').toString('utf8'));
    const existing = manifest.items.find((item) => item.id === photo.id);
    if (existing) { json(response, 200, { ok: true, item: existing, existing: true }); return; }
    const previous = photo.featured ? manifest.items.map((item) => ({ ...item, featured: false })) : manifest.items;
    const updated = updatedGallery(manifest, [entry, ...previous]);
    try {
      await client.putText('gallery.json', `${JSON.stringify(updated, null, 2)}\n`, `Publish photograph ${photo.id}`, manifestFile.sha);
      galleryCache = { value: updated, expiresAt: Date.now() + 30_000 };
      json(response, 201, { ok: true, item: entry });
      return;
    } catch (error) {
      if (error.status !== 409 || attempt === 1) throw error;
    }
  }
}

async function updatePhotoMetadata(request, response, id) {
  const session = mutationAuthorized(request);
  if (!session) { json(response, 403, { error: 'FORBIDDEN' }); return; }
  let metadata;
  try { metadata = JSON.parse(await readBody(request, PHOTO_LIMITS.jsonBytes)); }
  catch (error) { json(response, 400, { error: error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_METADATA' }); return; }

  const client = githubClient();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifestFile = await client.getContent('gallery.json');
    const manifest = JSON.parse(Buffer.from(manifestFile.content.replaceAll(/\s/g, ''), 'base64').toString('utf8'));
    const itemIndex = manifest.items.findIndex((item) => item.id === id);
    if (itemIndex < 0) { json(response, 404, { error: 'PHOTO_NOT_FOUND' }); return; }

    let edited;
    try { edited = updateGalleryEntryMetadata(manifest.items[itemIndex], metadata); }
    catch { json(response, 400, { error: 'INVALID_METADATA' }); return; }

    const items = manifest.items.map((item, index) => {
      if (index === itemIndex) return edited;
      return edited.featured ? { ...item, featured: false } : item;
    });
    const updated = updatedGallery(manifest, items);
    try {
      await client.putText('gallery.json', `${JSON.stringify(updated, null, 2)}\n`, `Update photograph ${id}`, manifestFile.sha);
      galleryCache = { value: updated, expiresAt: Date.now() + 30_000 };
      json(response, 200, { ok: true, item: edited });
      return;
    } catch (error) {
      if (error.status !== 409 || attempt === 1) throw error;
    }
  }
}

async function deletePhoto(request, response, id) {
  const session = mutationAuthorized(request);
  if (!session) { json(response, 403, { error: 'FORBIDDEN' }); return; }
  const client = githubClient();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const manifestFile = await client.getContent('gallery.json');
    const manifest = JSON.parse(Buffer.from(manifestFile.content.replaceAll(/\s/g, ''), 'base64').toString('utf8'));
    const item = manifest.items.find((candidate) => candidate.id === id);
    if (!item) { json(response, 404, { error: 'PHOTO_NOT_FOUND' }); return; }
    const targets = galleryMediaTargets(item, owner, repository, branch);

    if (targets.releaseOriginalName) {
      const asset = (await client.originalAssets([targets.releaseOriginalName])).get(targets.releaseOriginalName);
      if (asset) await client.deleteOriginalAsset(asset.id);
    }

    const updated = updatedGallery(manifest, manifest.items.filter((candidate) => candidate.id !== id));
    const repositoryPaths = [targets.previewPath, targets.repositoryOriginalPath].filter(Boolean);
    try {
      await client.commitTextAndDelete(
        'gallery.json',
        `${JSON.stringify(updated, null, 2)}\n`,
        repositoryPaths,
        `Permanently delete photograph ${id}`,
        manifestFile.sha,
      );
      galleryCache = { value: updated, expiresAt: Date.now() + 30_000 };
      json(response, 200, { ok: true, id });
      return;
    } catch (error) {
      if (error.status !== 409 || attempt === 2) throw error;
    }
  }
}

async function updateInstagramAccount(request, response) {
  const session = mutationAuthorized(request);
  if (!session) { json(response, 403, { error: 'FORBIDDEN' }); return; }
  let username;
  try { username = normalizeInstagramUsername(JSON.parse(await readBody(request, PHOTO_LIMITS.jsonBytes)).username); }
  catch (error) {
    json(response, 400, { error: error.message === 'BODY_TOO_LARGE' ? 'BODY_TOO_LARGE' : 'INVALID_INSTAGRAM_USERNAME' });
    return;
  }

  const client = githubClient();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const manifestFile = await client.getContent('gallery.json');
    const manifest = JSON.parse(Buffer.from(manifestFile.content.replaceAll(/\s/g, ''), 'base64').toString('utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.items)) { json(response, 409, { error: 'GALLERY_INVALID' }); return; }
    const updated = updatedGallery(manifest, manifest.items, { instagramUsername: username });
    try {
      await client.putText('gallery.json', `${JSON.stringify(updated, null, 2)}\n`, 'Update Instagram photography link', manifestFile.sha);
      galleryCache = { value: updated, expiresAt: Date.now() + 30_000 };
      json(response, 200, { ok: true, instagramUsername: username });
      return;
    } catch (error) {
      if (error.status !== 409 || attempt === 1) throw error;
    }
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, publicOrigin);
  const path = requestPath(request);
  try {
    if (request.method === 'GET' && path === '/healthz') { json(response, 200, { ok: true, configured: Boolean(appConfig?.installationId) }); return; }
    if ((request.method === 'GET' || request.method === 'HEAD') && path.replace(/\/$/, '') === '/photography/instagram') {
      const gallery = await loadGallery(appConfig?.installationId ? githubClient() : null);
      const location = instagramProfileUrl(gallery.instagramUsername);
      if (!location) { json(response, 404, { error: 'INSTAGRAM_NOT_CONFIGURED' }); return; }
      externalRedirect(response, location);
      return;
    }
    if (request.method === 'GET' && path === '/gallery') {
      const gallery = await loadGallery(appConfig?.installationId ? githubClient() : null);
      json(response, 200, gallery, { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=60' });
      return;
    }
    if (request.method === 'GET' && path === '/session') {
      const session = sessionFor(request);
      json(response, 200, {
        configured: Boolean(appConfig?.installationId), authenticated: Boolean(session),
        csrfToken: session ? csrfForSession(session.value, sessionSecret) : null,
      });
      return;
    }
    if (await handleSetup(request, response, url, path)) return;
    if (await handleAuth(request, response, url, path)) return;
    if (await handleUploadLookup(request, response, url, path)) return;
    if (await handleUpload(request, response, url, path)) return;
    if (request.method === 'POST' && path === '/publish') { await publishPhoto(request, response); return; }
    if (request.method === 'PATCH' && path === '/settings/instagram') { await updateInstagramAccount(request, response); return; }
    const editMatch = path.match(/^\/photos\/([a-z0-9][a-z0-9-]{7,63})$/);
    if (request.method === 'PATCH' && editMatch) { await updatePhotoMetadata(request, response, editMatch[1]); return; }
    if (request.method === 'DELETE' && editMatch) { await deletePhoto(request, response, editMatch[1]); return; }
    response.writeHead(404, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    response.end('Not found.');
  } catch (error) {
    console.error('Photography uploader request failed:', error.message);
    if (!response.headersSent) json(response, 500, { error: 'INTERNAL_ERROR' });
    else response.destroy();
  }
});

server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.listen(port, host, () => console.log(`Photography uploader listening on http://${host}:${port}`));

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
