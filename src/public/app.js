/* Dashify – frontend */
(function () {
  const THEME_KEY = 'dashify-theme';
  let config = null;
  let statusMap = {};
  let refreshTimer = null;

  const $ = (id) => document.getElementById(id);

  // ── Boot ────────────────────────────────────────────
  async function init() {
    await loadConfig();
    applyTheme();
    renderGroups();
    await refreshStatus();
    scheduleRefresh();
    wireControls();
  }

  function wireControls() {
    $('refresh-btn').addEventListener('click', () => {
      clearInterval(refreshTimer);
      refreshStatus(true).then(scheduleRefresh);
    });

    $('theme-btn').addEventListener('click', toggleTheme);

    const filter = $('filter');
    filter.addEventListener('input', applyFilter);

    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== filter) {
        e.preventDefault();
        filter.focus();
      } else if (e.key === 'Escape' && document.activeElement === filter) {
        filter.value = '';
        applyFilter();
        filter.blur();
      }
    });

    // Follow the system theme live when no explicit preference is set.
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (!storedTheme()) applyTheme();
    });
  }

  // ── Config ───────────────────────────────────────────
  async function loadConfig() {
    const res = await fetch('/api/config');
    config = await res.json();

    document.title = config.title || 'Dashify';
    $('site-title').textContent = config.title || 'Dashify';
    const sub = $('site-subtitle');
    sub.textContent = config.subtitle || '';
    sub.style.display = config.subtitle ? '' : 'none';

    const cols = Math.min(4, Math.max(1, config.columns || 3));
    $('groups-container').style.setProperty('--cols', cols);
  }

  // ── Theme ────────────────────────────────────────────
  function storedTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'light' || t === 'dark' ? t : null;
    } catch {
      return null;
    }
  }

  function systemTheme() {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function resolveTheme() {
    const saved = storedTheme();
    if (saved) return saved;
    const configured = config?.theme || 'dark';
    if (configured === 'auto' || configured === 'system') return systemTheme();
    return configured === 'light' ? 'light' : 'dark';
  }

  function applyTheme() {
    const theme = resolveTheme();
    document.documentElement.className = `theme-${theme}`;
    const btn = $('theme-btn');
    btn.textContent = theme === 'dark' ? '☀️' : '🌙';
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = btn.getAttribute('aria-label');
  }

  function toggleTheme() {
    const current = document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    applyTheme();
  }

  // ── Render groups ────────────────────────────────────
  function renderGroups() {
    const container = $('groups-container');
    container.innerHTML = '';

    const groups = config?.groups || [];
    if (!groups.length) {
      container.innerHTML =
        '<div class="empty-state">No services configured yet.<br>' +
        'Add some to <code>config/config.yaml</code> and refresh.</div>';
      return;
    }

    groups.forEach((group) => {
      const card = document.createElement('div');
      card.className = 'group';

      card.innerHTML = `
        <div class="group-header">
          ${group.icon ? `<span class="group-icon">${esc(group.icon)}</span>` : ''}
          <span class="group-name">${esc(group.name)}</span>
        </div>
        <div class="service-list"></div>
      `;

      container.appendChild(card);

      const list = card.querySelector('.service-list');
      (group.services || []).forEach((svc) => {
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
    a.dataset.svcName = svc.name || '';
    a.dataset.desc = svc.description || '';

    const dotHtml = svc.check
      ? `<span class="status-dot unknown" role="img" data-key="${esc(group.name)}::${esc(svc.name)}" aria-label="Checking…" title="Checking…"></span>`
      : '';

    a.innerHTML = `
      <span class="service-icon">${esc(svc.icon || '🔗')}</span>
      <span class="service-info">
        <span class="service-name">${esc(svc.name)}</span>
        ${svc.description ? `<span class="service-desc">${esc(svc.description)}</span>` : ''}
      </span>
      ${dotHtml}
    `;

    return a;
  }

  // ── Status ───────────────────────────────────────────
  async function refreshStatus(force = false) {
    const btn = $('refresh-btn');
    btn.classList.add('spinning');

    try {
      const res = await fetch('/api/status' + (force ? '?fresh=1' : ''));
      statusMap = await res.json();
      applyStatus();
      $('last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch {
      $('last-updated').textContent = 'Status check failed';
    } finally {
      btn.classList.remove('spinning');
    }
  }

  function applyStatus() {
    document.querySelectorAll('.status-dot[data-key]').forEach((dot) => {
      const info = statusMap[dot.dataset.key];
      const label = statusLabel(info);
      dot.className = 'status-dot ' + (info?.status || 'unknown');
      dot.title = label;
      dot.setAttribute('aria-label', label);
    });
    updateSummary();
  }

  function updateSummary() {
    let up = 0;
    let total = 0;
    document.querySelectorAll('.status-dot[data-key]').forEach((dot) => {
      const info = statusMap[dot.dataset.key];
      if (!info || info.status === 'unknown') return;
      total += 1;
      if (info.status === 'up') up += 1;
    });

    const el = $('status-summary');
    if (!total) {
      el.textContent = '';
      el.className = 'status-summary';
      return;
    }
    el.textContent = `${up}/${total} up`;
    el.className = 'status-summary ' + (up === total ? 'ok' : up === 0 ? 'down' : 'warn');
  }

  function statusLabel(info) {
    if (!info) return 'Checking…';
    const ms = info.latency != null ? ` · ${info.latency} ms` : '';
    if (info.status === 'up') return `Online (HTTP ${info.code})${ms}`;
    if (info.status === 'unknown') return 'Checking…';
    if (info.error) return `Offline — ${info.error}${ms}`;
    return `Offline (HTTP ${info.code ?? '?'})${ms}`;
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    const interval = (config?.refresh_interval ?? 30) * 1000;
    if (interval > 0) {
      refreshTimer = setInterval(refreshStatus, interval);
    }
  }

  // ── Filter ───────────────────────────────────────────
  function applyFilter() {
    const q = ($('filter').value || '').trim().toLowerCase();
    document.querySelectorAll('.group').forEach((group) => {
      let visible = 0;
      group.querySelectorAll('.service').forEach((svc) => {
        const hay = `${svc.dataset.svcName} ${svc.dataset.desc}`.toLowerCase();
        const show = !q || hay.includes(q);
        svc.style.display = show ? '' : 'none';
        if (show) visible += 1;
      });
      group.style.display = visible ? '' : 'none';
    });
  }

  // ── Helpers ──────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  init();
})();
