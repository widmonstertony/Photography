import { createSign } from 'node:crypto';
import https from 'node:https';
import { once } from 'node:events';
import { setTimeout as wait } from 'node:timers/promises';
import { PHOTO_RELEASE_TAG, validPhotoMagic } from './policy.mjs';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'tonytan-photography-uploader/1.0';
const BLOB_PREFIX = Buffer.from('{"content":"');
const BLOB_SUFFIX = Buffer.from('","encoding":"base64"}');

function jsonHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': API_VERSION,
  };
}

function apiPath(value) {
  return value.split('/').map((part) => encodeURIComponent(part)).join('/');
}

async function responseJson(response) {
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const error = new Error(payload?.message || `GITHUB_${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function convertAppManifest(code) {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT, 'X-GitHub-Api-Version': API_VERSION },
    signal: AbortSignal.timeout(20_000),
  });
  return responseJson(response);
}

export async function exchangeOAuthCode(config, code, redirectUri) {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await responseJson(response);
  if (!payload?.access_token) throw new Error(payload?.error || 'OAUTH_TOKEN_MISSING');
  return payload.access_token;
}

export async function authenticatedUser(token) {
  const response = await fetch('https://api.github.com/user', { headers: jsonHeaders(token), signal: AbortSignal.timeout(20_000) });
  return responseJson(response);
}

export class GitHubClient {
  constructor({ owner, repository, branch, config }) {
    this.owner = owner;
    this.repository = repository;
    this.branch = branch;
    this.config = config;
    this.cachedInstallationToken = null;
    this.cachedOriginalsRelease = null;
  }

  appJwt() {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: now - 30, exp: now + 540, iss: String(this.config.appId) })).toString('base64url');
    const content = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(content);
    signer.end();
    return `${content}.${signer.sign(this.config.privateKey).toString('base64url')}`;
  }

  async appRequest(path, options = {}) {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: { ...jsonHeaders(this.appJwt()), ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
    return responseJson(response);
  }

  async validateInstallation(installationId) {
    const installation = await this.appRequest(`/app/installations/${encodeURIComponent(installationId)}`);
    if (installation.account?.login?.toLowerCase() !== this.owner.toLowerCase()) throw new Error('WRONG_INSTALLATION_OWNER');
    const temporary = { ...this.config, installationId: Number(installationId) };
    const client = new GitHubClient({ owner: this.owner, repository: this.repository, branch: this.branch, config: temporary });
    const repositories = await client.request('/installation/repositories?per_page=100');
    const exact = repositories.repositories?.filter((repo) => repo.owner?.login === this.owner && repo.name === this.repository) ?? [];
    if (exact.length !== 1 || repositories.total_count !== 1) throw new Error('INSTALL_ONLY_PHOTOGRAPHY');
    return Number(installationId);
  }

  async installationToken() {
    if (!this.config.installationId) throw new Error('INSTALLATION_MISSING');
    if (this.cachedInstallationToken?.expiresAt > Date.now() + 60_000) return this.cachedInstallationToken.value;
    const payload = await this.appRequest(`/app/installations/${this.config.installationId}/access_tokens`, { method: 'POST', body: '{}' });
    this.cachedInstallationToken = { value: payload.token, expiresAt: Date.parse(payload.expires_at) };
    return payload.token;
  }

  async request(path, options = {}) {
    const token = await this.installationToken();
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: { ...jsonHeaders(token), ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
    return responseJson(response);
  }

  contentEndpoint(path, ref = this.branch) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/contents/${apiPath(path)}?ref=${encodeURIComponent(ref)}`;
  }

  repositoryEndpoint(path) {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}${path}`;
  }

  async getContent(path, ref = this.branch) {
    try {
      return await this.request(this.contentEndpoint(path, ref), { headers: { Accept: 'application/vnd.github.object+json' } });
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async waitForContents({ required = [], any = [] }, { delays = [0, 250, 750, 1_500, 3_000] } = {}) {
    let latest = null;
    for (const delay of delays) {
      if (delay > 0) await wait(delay);
      const [requiredFiles, anyFiles] = await Promise.all([
        Promise.all(required.map((path) => this.getContent(path))),
        Promise.all(any.map((path) => this.getContent(path))),
      ]);
      latest = { required: requiredFiles, any: anyFiles };
      if (requiredFiles.every(Boolean) && (!any.length || anyFiles.some(Boolean))) return latest;
    }
    return latest;
  }

  async putText(path, content, message, sha = null) {
    const body = { message, branch: this.branch, content: Buffer.from(content).toString('base64') };
    if (sha) body.sha = sha;
    return this.request(`/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repository)}/contents/${apiPath(path)}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
  }

  async originalsRelease() {
    if (this.cachedOriginalsRelease) return this.cachedOriginalsRelease;
    try {
      this.cachedOriginalsRelease = await this.request(this.repositoryEndpoint(`/releases/tags/${PHOTO_RELEASE_TAG}`));
      return this.cachedOriginalsRelease;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    try {
      this.cachedOriginalsRelease = await this.request(this.repositoryEndpoint('/releases'), {
        method: 'POST',
        body: JSON.stringify({
          tag_name: PHOTO_RELEASE_TAG,
          target_commitish: this.branch,
          name: 'Original-resolution photography',
          body: 'Original-resolution media for the automotive photography gallery.',
          draft: false,
          prerelease: false,
          generate_release_notes: false,
          make_latest: 'false',
        }),
      });
      return this.cachedOriginalsRelease;
    } catch (error) {
      if (error.status !== 422) throw error;
      this.cachedOriginalsRelease = await this.request(this.repositoryEndpoint(`/releases/tags/${PHOTO_RELEASE_TAG}`));
      return this.cachedOriginalsRelease;
    }
  }

  async originalAssets(names) {
    const release = await this.originalsRelease();
    const wanted = new Set(names);
    const found = new Map();
    for (let page = 1; page <= 10 && found.size < wanted.size; page += 1) {
      const assets = await this.request(this.repositoryEndpoint(`/releases/${encodeURIComponent(release.id)}/assets?per_page=100&page=${page}`));
      for (const asset of assets) if (wanted.has(asset.name)) found.set(asset.name, asset);
      if (assets.length < 100) break;
    }
    return found;
  }

  async listOriginalAssets() {
    const release = await this.originalsRelease();
    const found = [];
    for (let page = 1; page <= 10; page += 1) {
      const assets = await this.request(this.repositoryEndpoint(`/releases/${encodeURIComponent(release.id)}/assets?per_page=100&page=${page}`));
      found.push(...assets);
      if (assets.length < 100) break;
    }
    return found;
  }

  async deleteOriginalAsset(assetId) {
    try {
      await this.request(this.repositoryEndpoint(`/releases/assets/${encodeURIComponent(assetId)}`), { method: 'DELETE' });
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  async uploadOriginalAsset(name, source, { contentType, expectedBytes }) {
    const release = await this.originalsRelease();
    const existing = (await this.originalAssets([name])).get(name);
    if (existing?.state === 'uploaded') {
      if (existing.size !== expectedBytes) throw new Error('PHOTO_ID_CONFLICT');
      let total = 0;
      for await (const value of source) {
        total += Buffer.byteLength(value);
        if (total > expectedBytes) throw new Error('UPLOAD_LENGTH_MISMATCH');
      }
      if (total !== expectedBytes) throw new Error('UPLOAD_LENGTH_MISMATCH');
      return { ...existing, existing: true };
    }
    if (existing) {
      await this.request(this.repositoryEndpoint(`/releases/assets/${encodeURIComponent(existing.id)}`), { method: 'DELETE' });
    }

    const token = await this.installationToken();
    const requestOptions = {
      hostname: 'uploads.github.com',
      path: this.repositoryEndpoint(`/releases/${encodeURIComponent(release.id)}/assets?name=${encodeURIComponent(name)}`),
      method: 'POST',
      headers: { ...jsonHeaders(token), 'Content-Type': contentType, 'Content-Length': expectedBytes },
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = (error) => { if (!settled) { settled = true; reject(error); } };
      const githubRequest = https.request(requestOptions, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size <= 2 * 1024 * 1024) chunks.push(chunk);
          else githubRequest.destroy(new Error('GITHUB_RESPONSE_TOO_LARGE'));
        });
        response.on('end', () => {
          if (settled) return;
          let payload = null;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* handled below */ }
          if (response.statusCode !== 201) {
            const error = new Error(payload?.message || `GITHUB_${response.statusCode}`);
            error.status = response.statusCode;
            finishReject(error);
            return;
          }
          settled = true;
          resolve(payload);
        });
      });
      githubRequest.on('error', finishReject);
      githubRequest.setTimeout(10 * 60 * 1000, () => githubRequest.destroy(new Error('GITHUB_UPLOAD_TIMEOUT')));

      (async () => {
        try {
          let signature = Buffer.alloc(0);
          let total = 0;
          for await (const value of source) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            total += chunk.length;
            if (total > expectedBytes) throw new Error('UPLOAD_LENGTH_MISMATCH');
            if (signature.length < 12) signature = Buffer.concat([signature, chunk.subarray(0, 12 - signature.length)]);
            if (!githubRequest.write(chunk)) await once(githubRequest, 'drain');
          }
          if (total !== expectedBytes) throw new Error('UPLOAD_LENGTH_MISMATCH');
          if (!validPhotoMagic(contentType, signature)) throw new Error('INVALID_IMAGE');
          githubRequest.end();
        } catch (error) {
          githubRequest.destroy(error);
          finishReject(error);
        }
      })();
    });
  }

  async commitBlob(path, blobSha, message) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const referencePath = this.repositoryEndpoint(`/git/ref/heads/${apiPath(this.branch)}`);
      const reference = await this.request(referencePath);
      const parent = await this.request(this.repositoryEndpoint(`/git/commits/${encodeURIComponent(reference.object.sha)}`));
      const tree = await this.request(this.repositoryEndpoint('/git/trees'), {
        method: 'POST',
        body: JSON.stringify({
          base_tree: parent.tree.sha,
          tree: [{ path, mode: '100644', type: 'blob', sha: blobSha }],
        }),
      });
      const commit = await this.request(this.repositoryEndpoint('/git/commits'), {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [reference.object.sha] }),
      });
      try {
        await this.request(this.repositoryEndpoint(`/git/refs/heads/${apiPath(this.branch)}`), {
          method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }),
        });
        return commit;
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === 2) throw error;
      }
    }
    throw new Error('GITHUB_COMMIT_FAILED');
  }

  async commitTextAndDelete(path, content, deletions, message, expectedSha) {
    const blob = await this.request(this.repositoryEndpoint('/git/blobs'), {
      method: 'POST',
      body: JSON.stringify({ content, encoding: 'utf-8' }),
    });
    if (!blob?.sha) throw new Error('GITHUB_BLOB_MISSING');
    const uniqueDeletions = [...new Set(deletions)].filter((candidate) => candidate && candidate !== path);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const referencePath = this.repositoryEndpoint(`/git/ref/heads/${apiPath(this.branch)}`);
      const reference = await this.request(referencePath);
      const current = await this.getContent(path, reference.object.sha);
      if (!current || current.sha !== expectedSha) {
        const error = new Error('GITHUB_CONTENT_CONFLICT');
        error.status = 409;
        throw error;
      }
      const [parent, deletionFiles] = await Promise.all([
        this.request(this.repositoryEndpoint(`/git/commits/${encodeURIComponent(reference.object.sha)}`)),
        Promise.all(uniqueDeletions.map((candidate) => this.getContent(candidate, reference.object.sha))),
      ]);
      const tree = await this.request(this.repositoryEndpoint('/git/trees'), {
        method: 'POST',
        body: JSON.stringify({
          base_tree: parent.tree.sha,
          tree: [
            { path, mode: '100644', type: 'blob', sha: blob.sha },
            ...uniqueDeletions.filter((candidate, index) => deletionFiles[index]).map((candidate) => ({
              path: candidate, mode: '100644', type: 'blob', sha: null,
            })),
          ],
        }),
      });
      const commit = await this.request(this.repositoryEndpoint('/git/commits'), {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [reference.object.sha] }),
      });
      try {
        await this.request(this.repositoryEndpoint(`/git/refs/heads/${apiPath(this.branch)}`), {
          method: 'PATCH', body: JSON.stringify({ sha: commit.sha, force: false }),
        });
        return commit;
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === 2) throw error;
      }
    }
    throw new Error('GITHUB_COMMIT_FAILED');
  }

  async uploadStream(path, source, { contentType, expectedBytes, message }) {
    const token = await this.installationToken();
    const encodedBytes = Math.ceil(expectedBytes / 3) * 4;
    const requestOptions = {
      hostname: 'api.github.com',
      path: this.repositoryEndpoint('/git/blobs'),
      method: 'POST',
      headers: { ...jsonHeaders(token), 'Content-Length': BLOB_PREFIX.length + encodedBytes + BLOB_SUFFIX.length },
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finishReject = (error) => { if (!settled) { settled = true; reject(error); } };
      const githubRequest = https.request(requestOptions, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size <= 2 * 1024 * 1024) chunks.push(chunk);
          else githubRequest.destroy(new Error('GITHUB_RESPONSE_TOO_LARGE'));
        });
        response.on('end', async () => {
          if (settled) return;
          let payload = null;
          try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* handled below */ }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            const error = new Error(payload?.message || `GITHUB_${response.statusCode}`);
            error.status = response.statusCode;
            finishReject(error);
            return;
          }
          try {
            if (!payload?.sha) throw new Error('GITHUB_BLOB_MISSING');
            const commit = await this.commitBlob(path, payload.sha, message);
            if (settled) return;
            settled = true;
            resolve({ blob: payload, commit });
          } catch (error) { finishReject(error); }
        });
      });
      githubRequest.on('error', finishReject);
      githubRequest.setTimeout(5 * 60 * 1000, () => githubRequest.destroy(new Error('GITHUB_UPLOAD_TIMEOUT')));

      (async () => {
        try {
          githubRequest.write(BLOB_PREFIX);
          let carry = Buffer.alloc(0);
          let signature = Buffer.alloc(0);
          let total = 0;
          for await (const value of source) {
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            total += chunk.length;
            if (total > expectedBytes) throw new Error('UPLOAD_LENGTH_MISMATCH');
            if (signature.length < 12) signature = Buffer.concat([signature, chunk.subarray(0, 12 - signature.length)]);
            const combined = carry.length ? Buffer.concat([carry, chunk]) : chunk;
            const complete = combined.length - (combined.length % 3);
            if (complete > 0 && !githubRequest.write(combined.subarray(0, complete).toString('base64'))) await once(githubRequest, 'drain');
            carry = combined.subarray(complete);
          }
          if (total !== expectedBytes) throw new Error('UPLOAD_LENGTH_MISMATCH');
          if (!validPhotoMagic(contentType, signature)) throw new Error('INVALID_IMAGE');
          if (carry.length && !githubRequest.write(carry.toString('base64'))) await once(githubRequest, 'drain');
          githubRequest.end(BLOB_SUFFIX);
        } catch (error) {
          githubRequest.destroy(error);
          finishReject(error);
        }
      })();
    });
  }
}
