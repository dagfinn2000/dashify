import express from 'express';
import { readFileSync, watchFile } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import yaml from 'js-yaml';
import { getWidget } from './widgets.js';
import { fetchFeed } from './rss.js';

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
  rss: [],              // optional RSS/Atom feed URLs seeded into the side pane
  rss_item_limit: 6,    // max items shown per feed
  rss_cache_ttl: 300,   // seconds the server caches each fetched feed
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

const warnedVars = new Set();

// Substitute ${VAR} / ${VAR:-default} in config values from the process
// environment, so secrets (e.g. widget API keys) can come from a Docker
// Compose .env file instead of being hard-coded in config.yaml.
export function interpolateEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name, def) => {
      const v = process.env[name];
      if (v != null && v !== '') return v;
      if (def != null) return def;
      if (!warnedVars.has(name)) {
        warnedVars.add(name);
        console.warn(`config: environment variable ${name} is not set`);
      }
      return '';
    });
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = interpolateEnv(v);
    return out;
  }
  return value;
}

// RSS settings live in their own file (RSS.yaml) next to config.yaml so the main
// config stays tidy. Its friendly keys map onto the internal rss_* config keys.
const rssConfigPath = (configPath) =>
  process.env.RSS_CONFIG_PATH || join(dirname(configPath), 'RSS.yaml');

function loadRss(path) {
  try {
    const parsed = interpolateEnv(yaml.load(readFileSync(path, 'utf8')) || {});
    const out = {};
    if (parsed.feeds != null) out.rss = parsed.feeds;
    if (parsed.item_limit != null) out.rss_item_limit = parsed.item_limit;
    if (parsed.cache_ttl != null) out.rss_cache_ttl = parsed.cache_ttl;
    return out;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Failed to load RSS.yaml:', e.message);
    return {}; // absent file is fine — feeds can still be added in the browser
  }
}

export function loadConfig(path = CONFIG_PATH) {
  const rss = loadRss(rssConfigPath(path));
  try {
    const parsed = yaml.load(readFileSync(path, 'utf8')) || {};
    return { ...DEFAULTS, ...interpolateEnv(parsed), ...rss };
  } catch (e) {
    console.error('Failed to load config:', e.message);
    return { ...DEFAULTS, ...rss };
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

// Run `task(service)` for every service matching `filter`, collecting the
// results into a map keyed by `group::service`.
async function forEachService(filter, task) {
  const results = {};
  const jobs = (config.groups || []).flatMap((group) =>
    (group.services || [])
      .filter(filter)
      .map(async (s) => {
        results[`${group.name}::${s.name}`] = await task(s);
      }),
  );
  await Promise.allSettled(jobs);
  return results;
}

const computeStatus = () => forEachService((s) => s.check, (s) => checkService(s));

const computeWidgets = () =>
  forEachService(
    (s) => s.widget && s.widget.type,
    // Widgets inherit the service's TLS/timeout settings (and URL) unless overridden.
    (s) => getWidget({ allow_insecure: s.allow_insecure, timeout: s.timeout, ...s.widget, url: s.widget.url || s.url }),
  );

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

// Proxy + parse an RSS/Atom feed so the browser avoids CORS. The pane lets the
// user add feeds at runtime, so the URL is supplied per-request; we accept any
// http(s) URL (this is a single-user LAN dashboard) and cache each one briefly.
const feedCache = new Map(); // url -> { at, data }

app.get('/api/rss', async (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'invalid feed url' });
  }

  const ttl = (config.rss_cache_ttl ?? 300) * 1000;
  const hit = feedCache.get(url);
  if (req.query.fresh !== '1' && hit && ttl > 0 && Date.now() - hit.at < ttl) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Dashify-Cache', 'hit');
    return res.json(hit.data);
  }

  try {
    const data = await fetchFeed(url, {
      timeoutMs: (config.timeout ?? 5) * 1000,
      limit: config.rss_item_limit ?? 6,
    });
    if (feedCache.size > 200) feedCache.clear(); // bound the cache
    feedCache.set(url, { at: Date.now(), data });
    res.set('Cache-Control', 'no-store');
    res.set('X-Dashify-Cache', 'miss');
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message || 'feed fetch failed' });
  }
});

export function start(port = PORT) {
  config = loadConfig();
  statusCache.reset();
  widgetsCache.reset();
  feedCache.clear();

  const server = app.listen(port, () => {
    console.log(`Dashify running on http://0.0.0.0:${port}`);
  });

  const reload = () => {
    config = loadConfig();
    statusCache.reset();
    widgetsCache.reset();
    feedCache.clear();
    console.log('Config reloaded');
  };
  // Watch both the main config and the separate RSS.yaml for live edits.
  watchFile(CONFIG_PATH, { interval: 1000 }, reload);
  watchFile(rssConfigPath(CONFIG_PATH), { interval: 1000 }, reload);

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
