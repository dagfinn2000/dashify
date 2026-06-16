// Service widgets: talk to a service's own API and return a small set of
// { label, value } fields to show on its card. Everything here runs on the
// server, so API keys/passwords never reach the browser.
import http from 'node:http';
import https from 'node:https';

// ── Low-level request helpers ─────────────────────────────────
// Exported so other server modules (e.g. rss.js) reuse one HTTP path.
// Pass maxRedirects > 0 to follow 3xx redirects (feeds commonly 301 from
// http→https or to add `www`); it defaults to 0 so widget calls are unaffected.
export function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 5000, insecure = false, maxRedirects = 0 } = {}) {
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
      if (maxRedirects > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // drain so the socket is freed
        const next = new URL(res.headers.location, url).href;
        resolve(request(next, { method, headers, body, timeoutMs, insecure, maxRedirects: maxRedirects - 1 }));
        return;
      }
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

// Bytes/second → human-readable transfer rate.
function fmtRate(bytesPerSec) {
  let n = num(bytesPerSec);
  if (n == null) return '—';
  if (n < 1) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
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

// Sonarr / Radarr share the v3 API: library size, queue, and upcoming (7 days).
async function arr(w, kind) {
  const base = trimSlash(w.url);
  const key = w.key || w.apikey || w.api_key || w.token || '';
  const opt = { headers: { 'X-Api-Key': key }, timeoutMs: w.timeoutMs, insecure: w.insecure };
  const libPath = kind === 'radarr' ? 'movie' : 'series';
  const lib = await requestJson(`${base}/api/v3/${libPath}`, opt);
  if (lib.status === 401) throw new Error(`${kind}: unauthorized — check the API key`);
  const queue = await requestJson(`${base}/api/v3/queue?page=1&pageSize=1`, opt);
  const start = new Date().toISOString();
  const end = new Date(Date.now() + 7 * 864e5).toISOString();
  const cal = await requestJson(`${base}/api/v3/calendar?start=${start}&end=${end}`, opt);
  return {
    fields: [
      { label: kind === 'radarr' ? 'Movies' : 'Series', value: fmtNum(Array.isArray(lib.json) ? lib.json.length : null) },
      { label: 'Queue', value: fmtNum(queue.json?.totalRecords) },
      { label: 'Upcoming', value: fmtNum(Array.isArray(cal.json) ? cal.json.length : null) },
    ],
  };
}
const sonarr = (w) => arr(w, 'sonarr');
const radarr = (w) => arr(w, 'radarr');

async function qbittorrent(w) {
  const base = trimSlash(w.url);
  const user = w.username || w.user || 'admin';
  const pass = w.password || w.pass || w.key || '';
  const login = await request(`${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Referer: base },
    body: `username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`,
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie && !/ok/i.test(login.body || '')) throw new Error('qbittorrent: login failed');
  const opt = { headers: cookie ? { Cookie: cookie } : {}, timeoutMs: w.timeoutMs, insecure: w.insecure };
  const info = await requestJson(`${base}/api/v2/transfer/info`, opt);
  const torrents = await requestJson(`${base}/api/v2/torrents/info`, opt);
  const list = Array.isArray(torrents.json) ? torrents.json : [];
  const active = list.filter((t) => (num(t.dlspeed) || 0) + (num(t.upspeed) || 0) > 0).length;
  return {
    fields: [
      { label: 'Active', value: fmtNum(active) },
      { label: 'Torrents', value: fmtNum(list.length) },
      { label: '↓', value: fmtRate(info.json?.dl_info_speed) },
      { label: '↑', value: fmtRate(info.json?.up_info_speed) },
    ],
  };
}

async function transmission(w) {
  const base = trimSlash(w.url);
  const rpc = /\/transmission\/rpc$/.test(base) ? base : `${base}/transmission/rpc`;
  const headers = { 'content-type': 'application/json' };
  if (w.username || w.password) {
    headers.authorization = 'Basic ' + Buffer.from(`${w.username || ''}:${w.password || w.key || ''}`).toString('base64');
  }
  const body = JSON.stringify({ method: 'session-stats' });
  let r = await request(rpc, { method: 'POST', headers, body, timeoutMs: w.timeoutMs, insecure: w.insecure });
  if (r.status === 409) {
    // Transmission hands back the required CSRF session id on the first 409.
    headers['x-transmission-session-id'] = r.headers['x-transmission-session-id'] || '';
    r = await request(rpc, { method: 'POST', headers, body, timeoutMs: w.timeoutMs, insecure: w.insecure });
  }
  let j = null;
  try {
    j = JSON.parse(r.body);
  } catch {
    /* leave null */
  }
  const s = j?.arguments;
  if (!s) throw new Error('transmission: no data');
  return {
    fields: [
      { label: 'Active', value: fmtNum(s.activeTorrentCount) },
      { label: 'Torrents', value: fmtNum(s.torrentCount) },
      { label: '↓', value: fmtRate(s.downloadSpeed) },
      { label: '↑', value: fmtRate(s.uploadSpeed) },
    ],
  };
}

// Jellyfin / Emby: count sessions and how many are actively streaming.
async function jellyfin(w) {
  const base = trimSlash(w.url);
  const key = w.key || w.apikey || w.api_key || w.token || '';
  const r = await requestJson(`${base}/Sessions`, {
    headers: { 'X-Emby-Token': key },
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  if (r.status === 401) throw new Error('jellyfin: unauthorized — check the API key');
  const sessions = Array.isArray(r.json) ? r.json : [];
  return {
    fields: [
      { label: 'Streams', value: fmtNum(sessions.filter((s) => s.NowPlayingItem).length) },
      { label: 'Sessions', value: fmtNum(sessions.length) },
    ],
  };
}

async function plex(w) {
  const base = trimSlash(w.url);
  const token = w.token || w.key || w.apikey || '';
  const r = await requestJson(`${base}/status/sessions?X-Plex-Token=${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' },
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  });
  if (r.status === 401) throw new Error('plex: unauthorized — check the token');
  const mc = r.json?.MediaContainer;
  if (!mc) throw new Error('plex: no data');
  const streams = mc.size ?? (Array.isArray(mc.Metadata) ? mc.Metadata.length : 0);
  return { fields: [{ label: 'Streams', value: fmtNum(streams) }] };
}

// Proxmox VE via an API token (tokenid + secret, or a prebuilt token string).
async function proxmox(w) {
  const base = trimSlash(w.url);
  const token = w.token || (w.tokenid && w.secret ? `${w.tokenid}=${w.secret}` : w.key || '');
  const opt = {
    headers: token ? { Authorization: `PVEAPIToken=${token}` } : {},
    timeoutMs: w.timeoutMs,
    insecure: w.insecure,
  };
  const nodes = await requestJson(`${base}/api2/json/nodes`, opt);
  if (nodes.status === 401) throw new Error('proxmox: unauthorized — check the API token');
  let cpu = 0;
  let mem = 0;
  let maxmem = 0;
  let online = 0;
  for (const n of nodes.json?.data || []) {
    if (n.status === 'online') {
      cpu += num(n.cpu) || 0;
      mem += num(n.mem) || 0;
      maxmem += num(n.maxmem) || 0;
      online++;
    }
  }
  const vms = await requestJson(`${base}/api2/json/cluster/resources?type=vm`, opt);
  const running = (vms.json?.data || []).filter((v) => v.status === 'running').length;
  return {
    fields: [
      { label: 'CPU', value: fmtPct(online ? (cpu / online) * 100 : null) },
      { label: 'RAM', value: fmtPct(maxmem ? (mem / maxmem) * 100 : null) },
      { label: 'VMs', value: fmtNum(running) },
    ],
  };
}

// Uptime Kuma exposes a Prometheus /metrics endpoint (basic auth: API key as
// the password). We tally monitor_status lines (1 = up).
async function uptimekuma(w) {
  const base = trimSlash(w.url);
  const key = w.key || w.apikey || w.token || w.password || '';
  const headers = key ? { authorization: 'Basic ' + Buffer.from(`:${key}`).toString('base64') } : {};
  const r = await request(`${base}/metrics`, { headers, timeoutMs: w.timeoutMs, insecure: w.insecure });
  if (r.status === 401) throw new Error('uptime-kuma: unauthorized — check the API key');
  let up = 0;
  let total = 0;
  for (const line of (r.body || '').split('\n')) {
    if (!line.startsWith('monitor_status')) continue;
    const m = line.match(/\s(\d+)\s*$/);
    if (!m) continue;
    total++;
    if (m[1] === '1') up++;
  }
  if (!total) throw new Error('uptime-kuma: no monitors found');
  return {
    fields: [
      { label: 'Up', value: fmtNum(up) },
      { label: 'Down', value: fmtNum(total - up) },
      { label: 'Monitors', value: fmtNum(total) },
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
  sonarr,
  radarr,
  qbittorrent,
  qbit: qbittorrent,
  transmission,
  jellyfin,
  emby: jellyfin,
  plex,
  proxmox,
  pve: proxmox,
  'uptime-kuma': uptimekuma,
  uptimekuma,
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
