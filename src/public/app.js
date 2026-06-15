/* Dashify – frontend */
(function () {
  let config = null;
  let statusMap = {};
  let refreshTimer = null;

  // ── Boot ────────────────────────────────────────────
  async function init() {
    await loadConfig();
    applyTheme();
    renderGroups();
    await refreshStatus();
    scheduleRefresh();

    document.getElementById('refresh-btn').addEventListener('click', () => {
      clearInterval(refreshTimer);
      refreshStatus().then(scheduleRefresh);
    });
  }

  // ── Config ───────────────────────────────────────────
  async function loadConfig() {
    const res = await fetch('/api/config');
    config = await res.json();

    document.title = config.title || 'Dashify';
    document.getElementById('site-title').textContent = config.title || 'Dashify';
    const sub = document.getElementById('site-subtitle');
    sub.textContent = config.subtitle || '';
    sub.style.display = config.subtitle ? '' : 'none';

    const cols = Math.min(4, Math.max(1, config.columns || 3));
    document.getElementById('groups-container').style.setProperty('--cols', cols);
  }

  // ── Theme ────────────────────────────────────────────
  function applyTheme() {
    const theme = (config?.theme || 'dark') === 'light' ? 'light' : 'dark';
    document.body.className = `theme-${theme}`;
  }

  // ── Render groups ────────────────────────────────────
  function renderGroups() {
    const container = document.getElementById('groups-container');
    container.innerHTML = '';

    (config?.groups || []).forEach(group => {
      const card = document.createElement('div');
      card.className = 'group';

      card.innerHTML = `
        <div class="group-header">
          ${group.icon ? `<span class="group-icon">${group.icon}</span>` : ''}
          <span class="group-name">${esc(group.name)}</span>
        </div>
        <div class="service-list" id="group-${slugify(group.name)}"></div>
      `;

      container.appendChild(card);

      const list = card.querySelector('.service-list');
      (group.services || []).forEach(svc => {
        list.appendChild(buildServiceEl(group, svc));
      });
    });
  }

  function buildServiceEl(group, svc) {
    const a = document.createElement('a');
    a.className = 'service';
    a.href = svc.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.dataset.groupName = group.name;
    a.dataset.svcName = svc.name;

    const dotHtml = svc.check
      ? `<span class="status-dot" data-key="${esc(group.name)}::${esc(svc.name)}"></span>`
      : '';

    a.innerHTML = `
      <span class="service-icon">${svc.icon || '🔗'}</span>
      <span class="service-info">
        <span class="service-name">${esc(svc.name)}</span>
        ${svc.description ? `<span class="service-desc">${esc(svc.description)}</span>` : ''}
      </span>
      ${dotHtml}
    `;

    return a;
  }

  // ── Status ───────────────────────────────────────────
  async function refreshStatus() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('spinning');

    try {
      const res = await fetch('/api/status');
      statusMap = await res.json();
      applyStatus();
      document.getElementById('last-updated').textContent =
        'Updated ' + new Date().toLocaleTimeString();
    } catch {
      document.getElementById('last-updated').textContent = 'Status check failed';
    } finally {
      btn.classList.remove('spinning');
    }
  }

  function applyStatus() {
    document.querySelectorAll('.status-dot[data-key]').forEach(dot => {
      const key = dot.dataset.key;
      const info = statusMap[key];
      dot.className = 'status-dot ' + (info?.status || 'unknown');
      dot.title = statusLabel(info);
    });
  }

  function statusLabel(info) {
    if (!info) return 'Unknown';
    if (info.status === 'up') return `Online (HTTP ${info.code})`;
    if (info.error) return `Offline — ${info.error}`;
    return `Offline (HTTP ${info.code || '?'})`;
  }

  function scheduleRefresh() {
    const interval = (config?.refresh_interval ?? 30) * 1000;
    if (interval > 0) {
      refreshTimer = setInterval(refreshStatus, interval);
    }
  }

  // ── Helpers ──────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugify(s) {
    return String(s).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }

  init();
})();
