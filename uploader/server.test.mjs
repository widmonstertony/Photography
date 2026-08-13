import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

let child;
let origin;
let stateDirectory;

async function unusedPort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'photography-uploader-test-'));
  await writeFile(join(stateDirectory, 'session-secret'), `${Buffer.alloc(48, 7).toString('base64url')}\n`, { mode: 0o600 });
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: import.meta.dirname,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'widmonstertony/Personal-Website',
      STATE_DIRECTORY: stateDirectory,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_ORIGIN: origin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Uploader test startup timed out.')), 5_000);
    child.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes('Photography uploader listening')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Uploader exited during test startup (${code}).`));
    });
  });
});

after(async () => {
  if (child?.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
});

test('serves bounded unauthenticated health and session state', async () => {
  const health = await fetch(`${origin}/photography/api/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, configured: false });

  const session = await fetch(`${origin}/photography/api/session`);
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    configured: false,
    authenticated: false,
    csrfToken: null,
  });
});

test('allows the one-time setup form to post only to self or GitHub', async () => {
  const response = await fetch(`${origin}/photography/api/setup`);
  assert.equal(response.status, 200);
  const policy = response.headers.get('content-security-policy');
  assert.match(policy, /form-action 'self' https:\/\/github\.com/);
  assert.match(await response.text(), /One-time bootstrap code/);
});

test('rejects uploads without an authenticated same-origin session', async () => {
  const response = await fetch(`${origin}/photography/api/upload/original?id=automotive-test&extension=jpg`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', Origin: 'https://attacker.example' },
    body: Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'FORBIDDEN' });
});

test('rejects metadata edits without an authenticated same-origin session', async () => {
  const response = await fetch(`${origin}/photography/api/photos/automotive-test`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ title: { en: 'Changed', zh: '已修改' } }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'FORBIDDEN' });
});

test('rejects permanent deletions without an authenticated same-origin session', async () => {
  const response = await fetch(`${origin}/photography/api/photos/automotive-test`, {
    method: 'DELETE',
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'FORBIDDEN' });
});

test('rejects Instagram setting changes without an authenticated same-origin session', async () => {
  const response = await fetch(`${origin}/photography/api/settings/instagram`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({ username: 'attacker' }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'FORBIDDEN' });
});
