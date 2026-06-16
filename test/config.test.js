import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolateEnv } from '../src/server.js';

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
