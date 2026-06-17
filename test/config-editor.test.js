import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 6977;
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let dir;
let configPath;

before(async () => {
  // Isolated config dir so the write round-trip never touches the repo's config.
  dir = mkdtempSync(join(tmpdir(), 'dashify-'));
  configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, 'title: "Temp"\ngroups: []\n', 'utf8');

  child = spawn(process.execPath, [join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), CONFIG_PATH: configPath },
    stdio: 'ignore',
  });
  await waitFor(`${BASE}/healthz`);
});

after(() => {
  child?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

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

test('GET /api/config/raw returns the raw file and editable flag', async () => {
  const r = await fetch(`${BASE}/api/config/raw`);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.file, 'config');
  assert.match(body.content, /title: "Temp"/);
  assert.equal(body.editable, true);
});

test('POST /api/config/raw rejects invalid YAML without writing', async () => {
  const before = readFileSync(configPath, 'utf8');
  const r = await fetch(`${BASE}/api/config/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'title: "unterminated\ngroups: [1, 2' }),
  });
  assert.equal(r.status, 422);
  assert.match((await r.json()).error, /YAML error/);
  assert.equal(readFileSync(configPath, 'utf8'), before, 'file must be unchanged');
});

test('POST /api/config/raw saves valid YAML and it takes effect live', async () => {
  const next = 'title: "Saved From Browser"\ngroups: []\n';
  const r = await fetch(`${BASE}/api/config/raw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: next }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(readFileSync(configPath, 'utf8'), next, 'file should be written to disk');

  // reloadConfig() runs on save, so the live config reflects it immediately.
  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  assert.equal(cfg.title, 'Saved From Browser');
});
