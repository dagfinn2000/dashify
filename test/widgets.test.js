import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getWidget } from '../src/widgets.js';
import { publicConfig } from '../src/server.js';

// Mock API covering each provider's endpoints. A `/v5only` prefix simulates a
// Pi-hole that lacks the v6 REST API, to exercise the v5 fallback path.
let server;
let base;

function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const m = req.method;

    // Glances v3-only sandbox (to exercise the v4→v3 fallback)
    if (p.startsWith('/v3only')) {
      if (p === '/v3only/api/3/cpu') return send(res, 200, { total: 9.9 });
      if (p === '/v3only/api/3/mem') return send(res, 200, { percent: 50 });
      if (p === '/v3only/api/3/fs') return send(res, 200, [{ mnt_point: '/', percent: 10 }]);
      if (p === '/v3only/api/3/load') return send(res, 200, { min1: 1.5, min5: 1, min15: 1, cpucore: 4 });
      return send(res, 404, { error: 'not found' });
    }

    // Glances v4
    if (p === '/api/4/cpu') return send(res, 200, { total: 6.2 });
    if (p === '/api/4/mem') return send(res, 200, { percent: 53.3 });
    if (p === '/api/4/fs') {
      return send(res, 200, [{ mnt_point: '/', percent: 45.1 }, { mnt_point: '/boot', percent: 12 }]);
    }
    if (p === '/api/4/load') return send(res, 200, { min1: 0.7, min5: 0.6, min15: 0.8, cpucore: 16 });

    // Overseerr / Jellyseerr
    if (p === '/api/v1/request/count') {
      return send(res, 200, { total: 46, movie: 30, tv: 16, pending: 3, approved: 40, declined: 0, processing: 1, available: 42 });
    }

    // Pi-hole v5-only sandbox
    if (p.startsWith('/v5only')) {
      if (p === '/v5only/admin/api.php') {
        return send(res, 200, {
          domains_being_blocked: '1,234',
          dns_queries_today: '10,000',
          ads_blocked_today: '2,500',
          ads_percentage_today: '25.0',
        });
      }
      return send(res, 404, { error: 'not found' });
    }

    // Pi-hole v6
    if (p === '/api/auth' && m === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let pw;
        try {
          pw = JSON.parse(body).password;
        } catch {
          /* ignore */
        }
        if (pw === 'wrong') return send(res, 200, { session: { valid: false } });
        return send(res, 200, { session: { valid: true, sid: 'SID123', validity: 1800 } });
      });
      return;
    }
    if (p === '/api/auth' && m === 'DELETE') return send(res, 200, {});
    if (p === '/api/stats/summary') {
      if (req.headers['x-ftl-sid'] !== 'SID123' && url.searchParams.get('sid') !== 'SID123') {
        return send(res, 401, { error: 'unauthorized' });
      }
      return send(res, 200, {
        queries: { total: 20000, blocked: 4000, percent_blocked: 20.0 },
        gravity: { domains_being_blocked: 5678 },
      });
    }

    // Pi-hole v5 (also served at root)
    if (p === '/admin/api.php') {
      return send(res, 200, {
        domains_being_blocked: '1,234',
        dns_queries_today: '10,000',
        ads_blocked_today: '2,500',
        ads_percentage_today: '25.0',
      });
    }

    // Nginx Proxy Manager
    if (p === '/api/tokens' && m === 'POST') return send(res, 200, { token: 'JWT', expires: 'soon' });
    if (p === '/api/nginx/proxy-hosts') {
      return send(res, 200, [{ enabled: 1 }, { enabled: 1 }, { enabled: 0 }]);
    }

    // AdGuard Home
    if (p === '/control/stats') return send(res, 200, { num_dns_queries: 8000, num_blocked_filtering: 800 });

    // Portainer
    if (p === '/api/endpoints') {
      return send(res, 200, [{ Snapshots: [{ RunningContainerCount: 5, StoppedContainerCount: 2 }] }]);
    }

    // Sonarr / Radarr (v3)
    if (p === '/api/v3/series') return send(res, 200, [{}, {}, {}]);
    if (p === '/api/v3/movie') return send(res, 200, [{}, {}]);
    if (p === '/api/v3/queue') return send(res, 200, { totalRecords: 4 });
    if (p === '/api/v3/calendar') return send(res, 200, [{}, {}]);

    // qBittorrent
    if (p === '/api/v2/auth/login') {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'SID=abc; path=/' });
      return res.end('Ok.');
    }
    if (p === '/api/v2/transfer/info') return send(res, 200, { dl_info_speed: 1048576, up_info_speed: 0 });
    if (p === '/api/v2/torrents/info') {
      return send(res, 200, [{ dlspeed: 100, upspeed: 0 }, { dlspeed: 0, upspeed: 0 }]);
    }

    // Jellyfin
    if (p === '/Sessions') return send(res, 200, [{ NowPlayingItem: {} }, {}]);

    // Plex
    if (p === '/status/sessions') return send(res, 200, { MediaContainer: { size: 2, Metadata: [{}, {}] } });

    // Proxmox
    if (p === '/api2/json/nodes') return send(res, 200, { data: [{ status: 'online', cpu: 0.5, mem: 8, maxmem: 16 }] });
    if (p === '/api2/json/cluster/resources') {
      return send(res, 200, { data: [{ status: 'running' }, { status: 'stopped' }] });
    }

    // Uptime Kuma (Prometheus metrics)
    if (p === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('monitor_status{monitor_name="a"} 1\nmonitor_status{monitor_name="b"} 0\n');
    }

    // Generic JSON
    if (p === '/generic') return send(res, 200, { data: { count: 42, ratio: 12.345 }, name: 'ok' });

    send(res, 404, { error: 'not found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const valueOf = (out, label) => out.fields.find((f) => f.label === label)?.value;

test('unknown widget type returns an error', async () => {
  const out = await getWidget({ type: 'nope', url: base });
  assert.match(out.error, /unknown widget type/);
});

test('pi-hole v6 reports queries/blocked/%', async () => {
  const out = await getWidget({ type: 'pihole', url: base, key: 'secret' });
  assert.equal(valueOf(out, 'Queries'), '20,000');
  assert.equal(valueOf(out, 'Blocked'), '4,000');
  assert.equal(valueOf(out, 'Domains'), '5,678');
  assert.ok(out.fields.some((f) => f.label === 'Blocked' && f.value === '20.0%'));
});

test('pi-hole reports a wrong password instead of silently retrying v5', async () => {
  const out = await getWidget({ type: 'pihole', url: base, key: 'wrong' });
  assert.ok(out.error, 'expected an error');
  assert.match(out.error, /wrong password|unauthorized/i);
  assert.ok(!out.fields || out.fields.length === 0, 'must not fall back to v5');
});

test('pi-hole falls back to v5 when v6 is unavailable', async () => {
  const out = await getWidget({ type: 'pihole', url: base + '/v5only', key: 'token' });
  assert.equal(valueOf(out, 'Queries'), '10,000');
  assert.equal(valueOf(out, 'Blocked'), '2,500');
  assert.ok(out.fields.some((f) => f.value === '25.0%'));
});

test('nginx proxy manager counts proxy hosts', async () => {
  const out = await getWidget({ type: 'npm', url: base, username: 'a@b.c', password: 'pw' });
  assert.equal(valueOf(out, 'Proxy hosts'), '3');
  assert.equal(valueOf(out, 'Enabled'), '2');
  assert.equal(valueOf(out, 'Disabled'), '1');
});

test('adguard computes blocked percentage', async () => {
  const out = await getWidget({ type: 'adguard', url: base, username: 'u', password: 'p' });
  assert.equal(valueOf(out, 'Queries'), '8,000');
  assert.equal(valueOf(out, 'Blocked'), '800');
  assert.ok(out.fields.some((f) => f.value === '10.0%'));
});

test('portainer sums container counts', async () => {
  const out = await getWidget({ type: 'portainer', url: base, key: 'k' });
  assert.equal(valueOf(out, 'Running'), '5');
  assert.equal(valueOf(out, 'Stopped'), '2');
});

test('generic json maps fields by dot-path', async () => {
  const out = await getWidget({
    type: 'json',
    url: base + '/generic',
    mappings: [
      { label: 'Count', path: 'data.count', format: 'number' },
      { label: 'Ratio', path: 'data.ratio', format: 'percent' },
      { label: 'Name', path: 'name' },
    ],
  });
  assert.equal(valueOf(out, 'Count'), '42');
  assert.equal(valueOf(out, 'Ratio'), '12.3%');
  assert.equal(valueOf(out, 'Name'), 'ok');
});

test('a failing widget returns an error, not a throw', async () => {
  const out = await getWidget({ type: 'pihole', url: 'http://127.0.0.1:1', timeout: 1 });
  assert.ok(out.error);
});

test('sonarr reports library/queue/upcoming', async () => {
  const out = await getWidget({ type: 'sonarr', url: base, key: 'k' });
  assert.equal(valueOf(out, 'Series'), '3');
  assert.equal(valueOf(out, 'Queue'), '4');
  assert.equal(valueOf(out, 'Upcoming'), '2');
});

test('radarr reports the movie library', async () => {
  const out = await getWidget({ type: 'radarr', url: base, key: 'k' });
  assert.equal(valueOf(out, 'Movies'), '2');
});

test('qbittorrent reports active torrents and rates', async () => {
  const out = await getWidget({ type: 'qbittorrent', url: base, username: 'admin', password: 'p' });
  assert.equal(valueOf(out, 'Active'), '1');
  assert.equal(valueOf(out, 'Torrents'), '2');
  assert.equal(valueOf(out, '↓'), '1.0 MB/s');
});

test('jellyfin counts streams and sessions', async () => {
  const out = await getWidget({ type: 'jellyfin', url: base, key: 'k' });
  assert.equal(valueOf(out, 'Streams'), '1');
  assert.equal(valueOf(out, 'Sessions'), '2');
});

test('plex counts active streams', async () => {
  const out = await getWidget({ type: 'plex', url: base, token: 't' });
  assert.equal(valueOf(out, 'Streams'), '2');
});

test('proxmox reports CPU/RAM/VMs', async () => {
  const out = await getWidget({ type: 'proxmox', url: base, token: 'u!t=x' });
  assert.equal(valueOf(out, 'CPU'), '50.0%');
  assert.equal(valueOf(out, 'RAM'), '50.0%');
  assert.equal(valueOf(out, 'VMs'), '1');
});

test('uptime-kuma tallies monitor_status lines', async () => {
  const out = await getWidget({ type: 'uptime-kuma', url: base, key: 'k' });
  assert.equal(valueOf(out, 'Up'), '1');
  assert.equal(valueOf(out, 'Down'), '1');
  assert.equal(valueOf(out, 'Monitors'), '2');
});

test('glances reports CPU/RAM/Disk/Load', async () => {
  const out = await getWidget({ type: 'glances', url: base });
  assert.equal(valueOf(out, 'CPU'), '6.2%');
  assert.equal(valueOf(out, 'RAM'), '53.3%');
  assert.equal(valueOf(out, 'Disk'), '45.1%'); // the "/" filesystem, not /boot
  assert.equal(valueOf(out, 'Load'), '0.7');
});

test('glances falls back to the v3 API when v4 is unavailable', async () => {
  const out = await getWidget({ type: 'glances', url: base + '/v3only' });
  assert.equal(valueOf(out, 'CPU'), '9.9%');
  assert.equal(valueOf(out, 'Disk'), '10.0%');
});

test('overseerr reports request counts', async () => {
  const out = await getWidget({ type: 'overseerr', url: base, key: 'k' });
  assert.equal(valueOf(out, 'Pending'), '3');
  assert.equal(valueOf(out, 'Processing'), '1');
  assert.equal(valueOf(out, 'Available'), '42');
});

test('jellyseerr is an alias for the overseerr provider', async () => {
  const out = await getWidget({ type: 'jellyseerr', url: base, key: 'k' });
  assert.equal(valueOf(out, 'Pending'), '3');
});

test('publicConfig strips widget secrets but flags has_widget', () => {
  const cfg = {
    title: 'x',
    groups: [
      {
        name: 'G',
        services: [
          { name: 'S', url: 'u', widget: { type: 'pihole', key: 'SUPER_SECRET' } },
          { name: 'S2', url: 'u2' },
        ],
      },
    ],
  };
  const pub = publicConfig(cfg);
  assert.equal(pub.groups[0].services[0].widget, undefined);
  assert.equal(pub.groups[0].services[0].has_widget, true);
  assert.equal(pub.groups[0].services[1].has_widget, undefined);
  assert.ok(!JSON.stringify(pub).includes('SUPER_SECRET'));
});
