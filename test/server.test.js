import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 6975;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, [join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitFor(`${BASE}/healthz`);
});

after(() => child?.kill());

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start in time');
}

test('GET /healthz returns ok', async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.uptime, 'number');
});

test('GET /api/config returns the parsed config', async () => {
  const r = await fetch(`${BASE}/api/config`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.groups));
  assert.ok('title' in body);
});

test('GET /api/status returns an object and a cache header', async () => {
  const r = await fetch(`${BASE}/api/status`);
  assert.equal(r.status, 200);
  assert.ok(r.headers.has('x-dashify-cache'));
  const body = await r.json();
  assert.equal(typeof body, 'object');
});

test('the second /api/status hit is served from cache', async () => {
  await fetch(`${BASE}/api/status?fresh=1`); // prime the cache
  const r = await fetch(`${BASE}/api/status`);
  assert.equal(r.headers.get('x-dashify-cache'), 'hit');
});

test('GET / serves the frontend shell', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Dashify/);
});

test('GET /user does not expose the raw config files', async () => {
  // config.yaml / RSS.yaml may hold inline secrets, so /user must not serve them
  // even though they live in the config directory (assets like images still are).
  for (const file of ['config.yaml', 'RSS.yaml']) {
    const r = await fetch(`${BASE}/user/${file}`);
    assert.equal(r.status, 404, `${file} must not be reachable under /user`);
  }
});

test('GET /api/config never leaks widget secrets', async () => {
  const r = await fetch(`${BASE}/api/config`);
  const text = await r.text();
  // Widget blocks (which carry keys/passwords) are stripped before the config
  // reaches the browser; only a has_widget flag remains.
  assert.ok(!/"widget"\s*:/.test(text), 'widget block leaked to client');
});

test('GET /api/widgets returns an object', async () => {
  const r = await fetch(`${BASE}/api/widgets`);
  assert.equal(r.status, 200);
  assert.equal(typeof (await r.json()), 'object');
});
