import express from 'express';
import { readFileSync, watchFile } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import yaml from 'js-yaml';
import { getWidget } from './widgets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.CONFIG_PATH || join(__dirname, '..', 'config', 'config.yaml');
const PORT = process.env.PORT || 6969;
const startedAt = Date.now();

const DEFAULTS = Object.freeze({
  title: 'Dashify',
  subtitle: '',
  groups: [],
  refresh_interval: 30,
  columns: 3,
  theme: 'dark',
  timeout: 5,           // seconds per health check (per-service override allowed)
  status_cache_ttl: 5,  // seconds the server caches /api/status across clients
  widget_cache_ttl: 30, // seconds the server caches widget API data across clients
});

// Strip server-only secrets (widget API keys/passwords) before sending config
// to the browser. Widget *data* is delivered separately via /api/widgets.
export function publicConfig(cfg) {
  return {
    ...cfg,
    groups: (cfg.groups || []).map((group) => ({
      ...group,
      services: (group.services || []).map((svc) => {
        const { widget, ...rest } = svc;
        return widget ? { ...rest, has_widget: true } : rest;
      }),
    })),
  };
}

export function loadConfig(path = CONFIG_PATH) {
  try {
    const parsed = yaml.load(readFileSync(path, 'utf8')) || {};
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    console.error('Failed to load config:', e.message);
    return { ...DEFAULTS };
  }
}

let config = loadConfig();

// ── Health checks ─────────────────────────────────────────────
// Built on Node's http/https so we can disable TLS verification per
// service (homelab boxes with self-signed certs) without extra deps.
function requestOnce(urlStr, { method, timeoutMs, insecure }) {
  return new Promise((resolvePromise, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error('invalid url'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method,
        rejectUnauthorized: !insecure,
        headers: { 'user-agent': 'Dashify/health-check', accept: '*/*' },
      },
      (res) => {
        res.resume(); // drain so the socket can be freed
        resolvePromise({ status: res.statusCode, location: res.headers.location });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function probe(urlStr, opts, maxRedirects = 5) {
  let current = urlStr;
  for (let i = 0; ; i++) {
    const { status, location } = await requestOnce(current, opts);
    if (status >= 300 && status < 400 && location && i < maxRedirects) {
      current = new URL(location, current).href;
      continue;
    }
    return status;
  }
}

export async function checkService(service, defaults = config) {
  if (!service.check) return { status: 'unknown' };

  const target = service.check_path
    ? new URL(service.check_path, service.url).href
    : service.url;
  const timeoutMs = (service.timeout ?? defaults.timeout ?? 5) * 1000;
  const started = performance.now();

  try {
    const code = await probe(target, {
      method: (service.method || 'GET').toUpperCase(),
      timeoutMs,
      insecure: service.allow_insecure === true,
    });
    const latency = Math.round(performance.now() - started);
    const ok = service.expect_status ? code === service.expect_status : code < 400;
    return { status: ok ? 'up' : 'down', code, latency };
  } catch (e) {
    const latency = Math.round(performance.now() - started);
    const timedOut = e.code === 'ETIMEDOUT' || /timeout/i.test(e.message || '');
    return { status: 'down', error: timedOut ? 'timeout' : 'unreachable', latency };
  }
}

async function computeStatus() {
  const results = {};
  const checks = (config.groups || []).flatMap((group) =>
    (group.services || [])
      .filter((s) => s.check)
      .map(async (s) => {
        results[`${group.name}::${s.name}`] = await checkService(s);
      }),
  );
  await Promise.allSettled(checks);
  return results;
}

async function computeWidgets() {
  const results = {};
  const tasks = (config.groups || []).flatMap((group) =>
    (group.services || [])
      .filter((s) => s.widget && s.widget.type)
      .map(async (s) => {
        // Widgets inherit the service's TLS/timeout settings unless overridden.
        const w = { allow_insecure: s.allow_insecure, timeout: s.timeout, ...s.widget };
        w.url = w.url || s.url;
        results[`${group.name}::${s.name}`] = await getWidget(w);
      }),
  );
  await Promise.allSettled(tasks);
  return results;
}

// Cache results briefly so multiple open tabs/clients share one sweep instead
// of each hammering every service (or its API) on their own timer.
function makeCached(compute, ttlSeconds) {
  let cache = { at: 0, data: null, pending: null };
  const get = (force = false) => {
    const ttl = (ttlSeconds() ?? 0) * 1000;
    const fresh = force || ttl <= 0 || !cache.data || Date.now() - cache.at >= ttl;
    if (!fresh) return Promise.resolve({ data: cache.data, cached: true });
    if (!cache.pending) {
      cache.pending = compute().then(
        (data) => {
          cache = { at: Date.now(), data, pending: null };
          return data;
        },
        (err) => {
          cache.pending = null;
          throw err;
        },
      );
    }
    return cache.pending.then((data) => ({ data, cached: false }));
  };
  const reset = () => {
    cache = { at: 0, data: null, pending: null };
  };
  return { get, reset };
}

const statusCache = makeCached(computeStatus, () => config.status_cache_ttl);
const widgetsCache = makeCached(computeWidgets, () => config.widget_cache_ttl);

// ── App ───────────────────────────────────────────────────────
export const app = express();
app.disable('x-powered-by');
app.use(express.static(join(__dirname, 'public')));

// Serve the user's config directory so they can drop in their own assets
// (e.g. a background image or custom icons) and reference them as /user/<file>.
app.use('/user', express.static(dirname(CONFIG_PATH), { index: false, dotfiles: 'ignore' }));

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.round((Date.now() - startedAt) / 1000) });
});

app.get('/api/config', (_req, res) => {
  res.json(publicConfig(config));
});

app.get('/api/status', async (req, res) => {
  try {
    const { data, cached } = await statusCache.get(req.query.fresh === '1');
    res.set('Cache-Control', 'no-store');
    res.set('X-Dashify-Cache', cached ? 'hit' : 'miss');
    res.json(data);
  } catch {
    res.status(500).json({ error: 'status check failed' });
  }
});

app.get('/api/widgets', async (req, res) => {
  try {
    const { data, cached } = await widgetsCache.get(req.query.fresh === '1');
    res.set('Cache-Control', 'no-store');
    res.set('X-Dashify-Cache', cached ? 'hit' : 'miss');
    res.json(data);
  } catch {
    res.status(500).json({ error: 'widget fetch failed' });
  }
});

export function start(port = PORT) {
  config = loadConfig();
  statusCache.reset();
  widgetsCache.reset();

  const server = app.listen(port, () => {
    console.log(`Dashify running on http://0.0.0.0:${port}`);
  });

  watchFile(CONFIG_PATH, { interval: 1000 }, () => {
    config = loadConfig();
    statusCache.reset();
    widgetsCache.reset();
    console.log('Config reloaded');
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) start();
