import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { interpolateEnv, loadConfig } from '../src/server.js';

test('substitutes ${VAR} from the environment', () => {
  process.env.DASHIFY_TEST_TOKEN = 's3cret';
  assert.equal(interpolateEnv('${DASHIFY_TEST_TOKEN}'), 's3cret');
  assert.equal(interpolateEnv('Bearer ${DASHIFY_TEST_TOKEN}!'), 'Bearer s3cret!');
});

test('uses ${VAR:-default} when the var is unset', () => {
  delete process.env.DASHIFY_TEST_MISSING;
  assert.equal(interpolateEnv('${DASHIFY_TEST_MISSING:-fallback}'), 'fallback');
});

test('an unset var with no default becomes empty', () => {
  delete process.env.DASHIFY_TEST_MISSING2;
  assert.equal(interpolateEnv('${DASHIFY_TEST_MISSING2}'), '');
});

test('interpolates recursively through objects and arrays', () => {
  process.env.DASHIFY_TEST_PW = 'pw';
  const out = interpolateEnv({
    a: '${DASHIFY_TEST_PW}',
    nested: { key: '${DASHIFY_TEST_PW}' },
    list: ['${DASHIFY_TEST_PW}', 'plain'],
    untouched: 42,
    flag: true,
  });
  assert.equal(out.a, 'pw');
  assert.equal(out.nested.key, 'pw');
  assert.deepEqual(out.list, ['pw', 'plain']);
  assert.equal(out.untouched, 42);
  assert.equal(out.flag, true);
});

test('loads RSS settings from a sibling RSS.yaml', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashify-cfg-'));
  writeFileSync(join(dir, 'config.yaml'), 'title: T\n');
  writeFileSync(
    join(dir, 'RSS.yaml'),
    'feeds:\n  - https://e.example/feed\nitem_limit: 9\ncache_ttl: 42\n',
  );
  const cfg = loadConfig(join(dir, 'config.yaml'));
  assert.deepEqual(cfg.rss, ['https://e.example/feed']);
  assert.equal(cfg.rss_item_limit, 9);
  assert.equal(cfg.rss_cache_ttl, 42);
  assert.equal(cfg.title, 'T'); // main config still applies
});

test('config without an RSS.yaml falls back to the defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashify-cfg-'));
  writeFileSync(join(dir, 'config.yaml'), 'title: T\n');
  const cfg = loadConfig(join(dir, 'config.yaml'));
  assert.deepEqual(cfg.rss, []);
  assert.equal(cfg.rss_item_limit, 6);
  assert.equal(cfg.rss_cache_ttl, 300);
});

test('a valid config reports no config_error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashify-cfg-'));
  writeFileSync(join(dir, 'config.yaml'), 'title: T\n');
  const cfg = loadConfig(join(dir, 'config.yaml'));
  assert.equal(cfg.config_error, null);
});

test('surfaces a config.yaml parse error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashify-cfg-'));
  writeFileSync(join(dir, 'config.yaml'), 'title: "unterminated\nbroken: [1, 2\n');
  const cfg = loadConfig(join(dir, 'config.yaml'));
  assert.ok(cfg.config_error, 'expected a config_error');
  assert.match(cfg.config_error, /config\.yaml/);
  assert.deepEqual(cfg.groups, []); // still falls back to defaults so the app runs
});

test('surfaces an RSS.yaml parse error while keeping the main config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashify-cfg-'));
  writeFileSync(join(dir, 'config.yaml'), 'title: T\n');
  writeFileSync(join(dir, 'RSS.yaml'), 'feeds: [unclosed\n');
  const cfg = loadConfig(join(dir, 'config.yaml'));
  assert.equal(cfg.title, 'T');
  assert.ok(cfg.config_error, 'expected a config_error');
  assert.match(cfg.config_error, /RSS\.yaml/);
});
