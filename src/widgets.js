// Service widgets: talk to a service's own API and return a small set of
// { label, value } fields to show on its card. Everything here runs on the
// server, so API keys/passwords never reach the browser.
import http from 'node:http';
import https from 'node:https';

// ── Low-level request helpers ─────────────────────────────────
function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 5000, insecure = false } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error('invalid url'));
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, { method, headers, rejectUnauthorized: !insecure }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        data += chunk;
        if (data.length > 2_000_000) req.destroy(new Error('response too large'));
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function requestJson(url, opts = {}) {
  const res = await request(url, { ...opts, headers: { accept: 'application/json', ...(opts.headers || {}) } });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    /* leave json null */
  }
  return { ...res, json };
}

// ── Formatting helpers ────────────────────────────────────────
function num(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function fmtNum(v) {
  const n = num(v);
  return n == null ? '—' : n.toLocaleString('en-US');
}

function fmtPct(v) {
  const n = num(v);
  return n == null ? '—' : `${n.toFixed(1)}%`;
}

function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

// ── Providers ─────────────────────────────────────────────────
// Each provider receives the normalised widget config and returns
// { fields: [{ label, value }] }. Throwing is fine — getWidget catches it.

// A wrong password should be reported, not silently retried as v5.
const authError = (msg) => Object.assign(new Error(msg), { authFailed: true });

async function piholeV6(base, w) {
  const password = w.key || w.password;
  let sid = null;
  if (password) {
    const auth = await requestJson(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
      timeoutMs: w.timeoutMs,
      insecure: w.insecure,
    });
    // A JSON response from /api/auth means this *is* a v6 Pi-hole, so an invalid
    // session is a wrong password — surface it rather than falling back to v5.
    if (auth.json && auth.json.session && auth.json.session.valid === false) {
      throw authError('pi-hole: wrong password (use a Pi-hole app password)');
    }
    sid = auth.json?.session?.sid || null;
  }
  const headers = sid ? { 'X-FTL-SID': sid } : {};
  const url = `${base}/api/stats/summary` + (sid ? `?sid=${encodeURIComponent(sid)}` : '');
  const s = await requestJson(url, { headers, timeoutMs: w.timeoutMs, insecure: w.insecure });
  if (s.status === 401) throw authError('pi-hole: unauthorized — check the password');
  const q = s.json?.queries;
  if (!q) throw new Error('no v6 data');
  // Politely end the session so we don't pile up sessions on the Pi-hole.
  if (sid) {
    requestJson(`${base}/api/auth`, { method: 'DELETE', headers, timeoutMs: 2000, insecure: w.insecure }).catch(() => {});
  }
  return [
    { label: 'Queries', value: fmtNum(q.total) },
    { label: 'Blocked', value: fmtNum(q.blocked) },
    { label: 'Blocked', value: fmtPct(q.percent_blocked) },
    { label: 'Domains', value: fmtNum(s.json?.gravity?.domains_being_blocked) },
  ];
}

async function piholeV5(base, w) {
  const token = w.key || w.password;
  const authParam = token ? `&auth=${encodeURIComponent(token)}` : '';
  const r = await requestJson(`${base}/admin/api.php?summary${authParam}`, {
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  const j = r.json;
  if (!j || j.dns_queries_today == null) throw new Error('pi-hole: no data');
  return [
    { label: 'Queries', value: fmtNum(j.dns_queries_today) },
    { label: 'Blocked', value: fmtNum(j.ads_blocked_today) },
    { label: 'Blocked', value: fmtPct(j.ads_percentage_today) },
    { label: 'Domains', value: fmtNum(j.domains_being_blocked) },
  ];
}

async function pihole(w) {
  const base = trimSlash(w.url);
  try {
    return { fields: await piholeV6(base, w) }; // Pi-hole v6 (REST API)
  } catch (e) {
    if (e.authFailed) throw e; // don't mask a wrong password with a v5 retry
    return { fields: await piholeV5(base, w) }; // fall back to v5 (api.php)
  }
}

async function adguard(w) {
  const base = trimSlash(w.url);
  const headers = {};
  if (w.username || w.password || w.key) {
    const creds = `${w.username || ''}:${w.password || w.key || ''}`;
    headers.authorization = 'Basic ' + Buffer.from(creds).toString('base64');
  }
  const r = await requestJson(`${base}/control/stats`, { headers, timeoutMs: w.timeoutMs, insecure: w.insecure });
  const j = r.json;
  if (!j || j.num_dns_queries == null) throw new Error('adguard: no data');
  const total = num(j.num_dns_queries);
  const blocked = num(j.num_blocked_filtering);
  const pct = total ? (blocked / total) * 100 : 0;
  return {
    fields: [
      { label: 'Queries', value: fmtNum(total) },
      { label: 'Blocked', value: fmtNum(blocked) },
      { label: 'Blocked', value: fmtPct(pct) },
    ],
  };
}

async function npm(w) {
  const base = trimSlash(w.url);
  const identity = w.username || w.identity || w.email;
  const secret = w.password || w.secret || w.key;
  const auth = await requestJson(`${base}/api/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identity, secret }),
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  const token = auth.json?.token;
  if (!token) throw new Error('npm: auth failed');
  const r = await requestJson(`${base}/api/nginx/proxy-hosts`, {
    headers: { authorization: `Bearer ${token}` },
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  const hosts = Array.isArray(r.json) ? r.json : [];
  const enabled = hosts.filter((h) => h.enabled).length;
  return {
    fields: [
      { label: 'Proxy hosts', value: fmtNum(hosts.length) },
      { label: 'Enabled', value: fmtNum(enabled) },
      { label: 'Disabled', value: fmtNum(hosts.length - enabled) },
    ],
  };
}

async function portainer(w) {
  const base = trimSlash(w.url);
  const r = await requestJson(`${base}/api/endpoints`, {
    headers: { 'X-API-Key': w.key || w.token || '' },
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  const endpoints = Array.isArray(r.json) ? r.json : [];
  let running = 0;
  let stopped = 0;
  for (const e of endpoints) {
    const snap = e.Snapshots && e.Snapshots[0];
    if (snap) {
      running += num(snap.RunningContainerCount) || 0;
      stopped += num(snap.StoppedContainerCount) || 0;
    }
  }
  return {
    fields: [
      { label: 'Running', value: fmtNum(running) },
      { label: 'Stopped', value: fmtNum(stopped) },
    ],
  };
}

// Generic provider: fetch any JSON API and map fields by dot-path.
// widget: { type: json, url, headers?, method?, body?, mappings: [{label, path, format?, suffix?}] }
async function json(w) {
  const r = await requestJson(w.url, {
    method: w.method || 'GET',
    headers: w.headers || {},
    body: w.body ? (typeof w.body === 'string' ? w.body : JSON.stringify(w.body)) : null,
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  if (r.json == null) throw new Error('json: invalid response');
  const maps = w.mappings || w.fields || [];
  return {
    fields: maps.map((m) => {
      let v = getPath(r.json, m.path);
      if (m.format === 'number') v = fmtNum(v);
      else if (m.format === 'percent') v = fmtPct(v);
      else v = v == null ? '—' : String(v);
      if (m.suffix && v !== '—') v = `${v}${m.suffix}`;
      return { label: m.label, value: v };
    }),
  };
}

const PROVIDERS = {
  pihole,
  'pi-hole': pihole,
  adguard,
  'adguard-home': adguard,
  npm,
  'nginx-proxy-manager': npm,
  portainer,
  json,
};

export function listProviders() {
  return Object.keys(PROVIDERS);
}

export async function getWidget(widget) {
  const type = String(widget?.type || '').toLowerCase();
  const provider = PROVIDERS[type];
  if (!provider) return { error: `unknown widget type: ${widget?.type}` };

  const w = {
    ...widget,
    timeoutMs: (widget.timeout ?? 5) * 1000,
    insecure: widget.allow_insecure === true,
  };

  try {
    const out = await provider(w);
    return out && Array.isArray(out.fields) ? { fields: out.fields.filter((f) => f && f.value != null) } : { fields: [] };
  } catch (e) {
    return { error: e.message || 'widget error' };
  }
}
