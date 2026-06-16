import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { checkService } from '../src/server.js';

// A tiny configurable HTTP server stands in for a real service.
let server;
let base;
let tcp;
let tcpPort;
const routes = {
  '/': (res) => res.end('ok'),
  '/health': (res) => res.end('healthy'),
  '/missing': (res) => {
    res.statusCode = 404;
    res.end('nope');
  },
  '/teapot': (res) => {
    res.statusCode = 418;
    res.end('teapot');
  },
  '/slow': (res) => setTimeout(() => res.end('late'), 300),
};

before(async () => {
  server = http.createServer((req, res) => {
    const handler = routes[req.url] || routes['/missing'];
    handler(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  tcp = net.createServer((s) => s.end());
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  tcpPort = tcp.address().port;
});

after(() => {
  server.close();
  tcp.close();
});

const defaults = { timeout: 5 };

test('unchecked service reports unknown', async () => {
  const r = await checkService({ url: base }, defaults);
  assert.equal(r.status, 'unknown');
});

test('reachable service is up and reports latency', async () => {
  const r = await checkService({ url: base, check: true }, defaults);
  assert.equal(r.status, 'up');
  assert.equal(r.code, 200);
  assert.equal(typeof r.latency, 'number');
});

test('check_path is resolved against the base url', async () => {
  const r = await checkService({ url: base, check: true, check_path: '/health' }, defaults);
  assert.equal(r.status, 'up');
  assert.equal(r.code, 200);
});

test('4xx responses are reported as down', async () => {
  const r = await checkService({ url: base + '/missing', check: true }, defaults);
  assert.equal(r.status, 'down');
  assert.equal(r.code, 404);
});

test('expect_status enforces an exact code', async () => {
  const up = await checkService({ url: base + '/teapot', check: true, expect_status: 418 }, defaults);
  assert.equal(up.status, 'up');
  const down = await checkService({ url: base + '/teapot', check: true, expect_status: 200 }, defaults);
  assert.equal(down.status, 'down');
});

test('a slow service times out', async () => {
  const r = await checkService({ url: base + '/slow', check: true, timeout: 0.1 }, defaults);
  assert.equal(r.status, 'down');
  assert.equal(r.error, 'timeout');
});

test('an unreachable host is reported as down', async () => {
  // Port 1 is reserved and never listening.
  const r = await checkService({ url: 'http://127.0.0.1:1', check: true, timeout: 1 }, defaults);
  assert.equal(r.status, 'down');
  assert.equal(r.error, 'unreachable');
});

test('check: tcp reports up for an open port', async () => {
  const r = await checkService({ url: `127.0.0.1:${tcpPort}`, check: 'tcp' }, defaults);
  assert.equal(r.status, 'up');
  assert.equal(typeof r.latency, 'number');
});

test('check: tcp reports down for a closed port', async () => {
  const r = await checkService({ url: '127.0.0.1:1', check: 'tcp', timeout: 1 }, defaults);
  assert.equal(r.status, 'down');
});

test('check: tcp accepts explicit host/port', async () => {
  const r = await checkService({ host: '127.0.0.1', port: tcpPort, check: 'tcp' }, defaults);
  assert.equal(r.status, 'up');
});
