/* Dashify – frontend */
(function () {
  const THEME_KEY = 'dashify-theme';
  const ICON_CDN = 'https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons';
  const EMOJI_RE = /\p{Extended_Pictographic}/u;

  // Keyword → dashboard-icons slug, only for names that differ from the repo's
  // hyphenated slug. Anything not listed (Jellyfin, Portainer, …) falls through
  // to slug normalisation, then an svg→png→monogram fallback chain, so *any*
  // icon in the repo stays referenceable by its slug.
  const ICON_ALIASES = {
    pihole: 'pi-hole',
    adguard: 'adguard-home',
    adguardhome: 'adguard-home',
    npm: 'nginx-proxy-manager',
    nginxproxymanager: 'nginx-proxy-manager',
    uptimekuma: 'uptime-kuma',
    homeassistant: 'home-assistant',
    hass: 'home-assistant',
    pve: 'proxmox',
    proxmoxve: 'proxmox',
    bitwarden: 'vaultwarden',
    qbit: 'qbittorrent',
    truenas: 'truenas-scale',
    unificontroller: 'unifi',
  };

  const CLOCK_KEY = 'dashify-clock';
  let config = null;
  let statusMap = {};
  let widgetMap = {};
  let refreshTimer = null;
  let clockTimer = null;
  let clock24 = (() => {
    try {
      return localStorage.getItem(CLOCK_KEY) !== '12';
    } catch {
      return true;
    }
  })();

  const $ = (id) => document.getElementById(id);

  // ── Boot ────────────────────────────────────────────
  async function init() {
    await loadConfig();
    applyTheme();
    applyBackground();
    applyAppearance();
    renderGroups();
    await refreshAll();
    scheduleRefresh();
    wireControls();
    startClock();
  }

  function wireControls() {
    $('refresh-btn').addEventListener('click', () => {
      clearInterval(refreshTimer);
      refreshAll(true).then(scheduleRefresh);
    });

    $('theme-btn').addEventListener('click', toggleTheme);

    $('clock-format-btn').addEventListener('click', toggleClockFormat);
    const clock = $('clock');
    clock.addEventListener('click', toggleClockFormat);
    clock.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleClockFormat();
      }
    });

    buildColorPanel();
    $('palette-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });
    document.addEventListener('click', (e) => {
      const panel = $('color-panel');
      if (
        panel &&
        panel.classList.contains('open') &&
        !panel.contains(e.target) &&
        !$('palette-btn').contains(e.target)
      ) {
        togglePanel(false);
      }
    });

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
  const SUN_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

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
    btn.innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
    btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    btn.title = btn.getAttribute('aria-label');
    applyColors();
  }

  function toggleTheme() {
    const current = document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    applyTheme();
  }

  // ── Clock ────────────────────────────────────────────
  function formatTime(d) {
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    if (clock24) return `${String(d.getHours()).padStart(2, '0')}:${m}:${s}`;
    const ampm = d.getHours() < 12 ? 'AM' : 'PM';
    const h = d.getHours() % 12 || 12;
    return `${h}:${m}:${s} ${ampm}`;
  }

  function updateClock() {
    const el = $('clock');
    if (el) el.textContent = formatTime(new Date());
  }

  function startClock() {
    clearInterval(clockTimer);
    updateClock();
    clockTimer = setInterval(updateClock, 1000);
    $('clock-format-btn').textContent = clock24 ? '24h' : '12h';
  }

  function toggleClockFormat() {
    clock24 = !clock24;
    try {
      localStorage.setItem(CLOCK_KEY, clock24 ? '24' : '12');
    } catch {}
    $('clock-format-btn').textContent = clock24 ? '24h' : '12h';
    updateClock();
    // keep the "Updated" timestamp consistent with the chosen format
    if (statusMap && Object.keys(statusMap).length) {
      $('last-updated').textContent = 'Updated ' + formatTime(new Date());
    }
  }

  // ── Background ───────────────────────────────────────
  function applyBackground() {
    const root = document.documentElement;
    const bg = config?.background;
    if (!bg) {
      document.body.classList.remove('has-bg');
      root.style.removeProperty('--bg-image');
      return;
    }
    const url = resolveAssetUrl(bg).replace(/["\\]/g, encodeURIComponent);
    root.style.setProperty('--bg-image', `url("${url}")`);
    root.style.setProperty('--bg-blur', `${Number(config.background_blur) || 0}px`);
    const dim = config.background_dim;
    root.style.setProperty('--bg-dim', String(dim == null ? 0.5 : Math.min(1, Math.max(0, dim))));
    document.body.classList.add('has-bg');
  }

  // ── Appearance (card translucency + custom colours) ──
  function applyAppearance() {
    const root = document.documentElement;
    const opacity = config?.card_opacity;
    root.style.setProperty('--card-opacity', `${(opacity == null ? 1 : Math.min(1, Math.max(0, opacity))) * 100}%`);
    root.style.setProperty('--card-blur', `${Number(config?.card_blur) || 0}px`);
  }

  // Colours come from three layers, lowest to highest precedence:
  //   1. the theme CSS class, 2. config.yaml `colors`, 3. the in-page editor
  //      (per-theme, saved in this browser). Re-run on every theme change.
  const COLORS_KEY = 'dashify-colors';
  const COLOR_FIELDS = [
    ['accent', 'Accent'],
    ['bg', 'Background'],
    ['bg-card', 'Card'],
    ['bg-card-hover', 'Card hover'],
    ['header-bg', 'Header'],
    ['border', 'Border'],
    ['text', 'Text'],
    ['text-muted', 'Muted text'],
    ['text-dim', 'Dim text'],
    ['up', 'Online'],
    ['down', 'Offline'],
    ['unknown', 'Unknown'],
  ];

  // The CSS variables config / the editor are allowed to override.
  const OVERRIDABLE = COLOR_FIELDS.map(([key]) => key);

  let colorOverrides = (() => {
    try {
      const o = JSON.parse(localStorage.getItem(COLORS_KEY)) || {};
      return { dark: o.dark || {}, light: o.light || {} };
    } catch {
      return { dark: {}, light: {} };
    }
  })();

  const currentTheme = () =>
    document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';

  function persistColors() {
    try {
      localStorage.setItem(COLORS_KEY, JSON.stringify(colorOverrides));
    } catch {}
  }

  function applyColors() {
    const root = document.documentElement;
    OVERRIDABLE.forEach((k) => root.style.removeProperty(`--${k}`));
    const theme = currentTheme();

    // 2) config-provided colours (flat keys apply to both themes)
    const colors = config?.colors;
    if (colors && typeof colors === 'object') {
      const { dark, light, ...flat } = colors;
      const map = { ...flat, ...((theme === 'light' ? light : dark) || {}) };
      for (const [key, value] of Object.entries(map)) {
        const name = String(key).replace(/_/g, '-');
        if (OVERRIDABLE.includes(name) && typeof value === 'string') {
          root.style.setProperty(`--${name}`, value.replace(/[<>]/g, ''));
        }
      }
    }

    // 3) in-page editor overrides for the active theme (highest precedence)
    for (const [name, value] of Object.entries(colorOverrides[theme] || {})) {
      if (OVERRIDABLE.includes(name) && typeof value === 'string') {
        root.style.setProperty(`--${name}`, value);
      }
    }

    syncColorInputs();
  }

  // ── In-page colour editor ────────────────────────────
  function toHex(color) {
    if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
    const el = document.createElement('span');
    el.style.color = color || '#000';
    document.body.appendChild(el);
    const rgb = getComputedStyle(el).color.match(/\d+/g);
    el.remove();
    if (!rgb) return '#000000';
    return '#' + rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }

  function buildColorPanel() {
    const panel = document.createElement('div');
    panel.id = 'color-panel';
    panel.className = 'color-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Customize colours');
    panel.innerHTML = `
      <div class="cp-header">
        <span>Colours · <span class="cp-theme"></span></span>
        <button class="cp-close icon-btn" type="button" aria-label="Close">✕</button>
      </div>
      <div class="cp-rows"></div>
      <div class="cp-footer">
        <button class="cp-copy" type="button">Copy YAML</button>
        <button class="cp-reset" type="button">Reset</button>
        <span class="cp-note">Saved in this browser</span>
      </div>
    `;
    const rows = panel.querySelector('.cp-rows');
    COLOR_FIELDS.forEach(([key, label]) => {
      const row = document.createElement('label');
      row.className = 'cp-row';
      row.innerHTML = `<span class="cp-label">${label}</span>`;
      const input = document.createElement('input');
      input.type = 'color';
      input.dataset.key = key;
      input.addEventListener('input', () => {
        colorOverrides[currentTheme()][key] = input.value;
        persistColors();
        applyColors();
      });
      row.appendChild(input);
      rows.appendChild(row);
    });
    panel.querySelector('.cp-close').addEventListener('click', () => togglePanel(false));
    panel.querySelector('.cp-reset').addEventListener('click', () => {
      colorOverrides[currentTheme()] = {};
      persistColors();
      applyColors();
    });
    panel.querySelector('.cp-copy').addEventListener('click', copyColorYaml);
    document.body.appendChild(panel);
  }

  function syncColorInputs() {
    const panel = $('color-panel');
    if (!panel) return;
    panel.querySelector('.cp-theme').textContent = currentTheme();
    const cs = getComputedStyle(document.documentElement);
    panel.querySelectorAll('input[type=color]').forEach((inp) => {
      inp.value = toHex(cs.getPropertyValue(`--${inp.dataset.key}`).trim());
    });
  }

  function togglePanel(force) {
    const panel = $('color-panel');
    if (!panel) return;
    const show = force == null ? !panel.classList.contains('open') : force;
    panel.classList.toggle('open', show);
    if (show) syncColorInputs();
  }

  function copyColorYaml() {
    const theme = currentTheme();
    const map = colorOverrides[theme] || {};
    const keys = Object.keys(map);
    const note = $('color-panel').querySelector('.cp-note');
    if (!keys.length) {
      note.textContent = 'Nothing customised yet';
      return;
    }
    const yaml = `colors:\n  ${theme}:\n` + keys.map((k) => `    ${k}: "${map[k]}"`).join('\n') + '\n';
    const done = () => {
      note.textContent = 'Copied YAML!';
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(yaml).then(done, done);
    else done();
  }

  // ── Resizable cards (column span, remembered per browser) ──
  const SPANS_KEY = 'dashify-spans';
  let spanOverrides = (() => {
    try {
      return JSON.parse(localStorage.getItem(SPANS_KEY)) || {};
    } catch {
      return {};
    }
  })();

  const gridCols = () => Math.min(4, Math.max(1, config?.columns || 3));

  function spanFor(group) {
    const v = spanOverrides[group.name] ?? group.width ?? 1;
    return Math.min(gridCols(), Math.max(1, parseInt(v, 10) || 1));
  }

  function persistSpans() {
    try {
      localStorage.setItem(SPANS_KEY, JSON.stringify(spanOverrides));
    } catch {}
  }

  function addResizeHandle(card, group) {
    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    handle.title = 'Drag to resize · double-click to reset';
    card.appendChild(handle);

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const container = $('groups-container');
      const cols = gridCols();
      const gap = parseFloat(getComputedStyle(container).columnGap) || 18;
      const colWidth = (container.clientWidth - gap * (cols - 1)) / cols;
      const startX = e.clientX;
      const startWidth = card.offsetWidth;
      handle.setPointerCapture(e.pointerId);
      card.classList.add('resizing');

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let span = Math.round((startWidth + dx + gap) / (colWidth + gap));
        span = Math.min(cols, Math.max(1, span));
        card.style.setProperty('--span', span);
      };
      const onUp = () => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        card.classList.remove('resizing');
        spanOverrides[group.name] = parseInt(card.style.getPropertyValue('--span'), 10) || 1;
        persistSpans();
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    });

    handle.addEventListener('dblclick', () => {
      delete spanOverrides[group.name];
      persistSpans();
      card.style.setProperty('--span', spanFor(group));
    });
  }

  // ── Icons ────────────────────────────────────────────
  function slugify(s) {
    return String(s ?? '')
      .toLowerCase()
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function resolveSlug(value) {
    const base = slugify(value);
    return ICON_ALIASES[base.replace(/-/g, '')] || ICON_ALIASES[base] || base;
  }

  function iconFormat() {
    const f = (config?.icon_format || 'svg').toLowerCase();
    return ['svg', 'png', 'webp'].includes(f) ? f : 'svg';
  }

  const cdnIcon = (slug, fmt) => `${ICON_CDN}/${fmt}/${slug}.${fmt}`;

  // Use external URLs, data/blob URIs and root-absolute paths verbatim;
  // everything else is treated as a file in the user's config dir (/user/).
  const isAbsoluteUrl = (v) =>
    /^(https?:)?\/\//i.test(v) || /^(data|blob):/i.test(v) || String(v).startsWith('/');

  const userAsset = (v) => '/user/' + String(v).replace(/^\/+/, '');

  // The CDN source for a slug, plus the PNG fallback the repo always ships.
  function slugIcon(value) {
    const slug = resolveSlug(value);
    const fmt = iconFormat();
    return { src: cdnIcon(slug, fmt), pngFallback: fmt === 'png' ? null : cdnIcon(slug, 'png') };
  }

  // Decide what an `icon` value means: external URL, local /user asset, or slug.
  function classifyIcon(raw) {
    if (isAbsoluteUrl(raw)) return { type: 'url', src: raw };
    if (/\.[a-z0-9]{2,5}$/i.test(raw)) return { type: 'asset', src: userAsset(raw) };
    return { type: 'slug' };
  }

  function resolveAssetUrl(value) {
    return isAbsoluteUrl(value) ? value : userAsset(value);
  }

  function hashHue(s) {
    let h = 0;
    s = String(s);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  function monogram(name) {
    const span = document.createElement('span');
    span.className = 'icon icon-monogram';
    const t = String(name || '').trim();
    span.textContent = (t[0] || '?').toUpperCase();
    span.style.setProperty('--mono-hue', hashHue(t || '?'));
    return span;
  }

  function iconImg(src, pngFallback, name) {
    const img = document.createElement('img');
    img.className = 'icon icon-img';
    img.loading = 'lazy';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.src = src;
    let triedPng = false;
    img.addEventListener('error', function onErr() {
      if (pngFallback && !triedPng) {
        triedPng = true;
        img.src = pngFallback;
        return;
      }
      img.removeEventListener('error', onErr);
      img.replaceWith(monogram(name));
    });
    return img;
  }

  // Returns an icon node, or null when `derive` is false and no icon is given.
  function buildIcon(raw, name, derive) {
    raw = (raw || '').toString().trim();

    if (raw && EMOJI_RE.test(raw)) {
      const span = document.createElement('span');
      span.className = 'icon icon-emoji';
      span.textContent = raw;
      return span;
    }

    let src;
    let pngFallback = null;

    if (raw) {
      const c = classifyIcon(raw);
      if (c.type === 'slug') ({ src, pngFallback } = slugIcon(raw));
      else src = c.src;
    } else if (derive) {
      ({ src, pngFallback } = slugIcon(name));
    } else {
      return null;
    }

    return iconImg(src, pngFallback, name);
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
      card.style.setProperty('--span', spanFor(group));
      card.innerHTML = `
        <div class="group-header">
          <span class="group-name">${esc(group.name)}</span>
        </div>
        <div class="service-list"></div>
      `;

      const iconNode = buildIcon(group.icon, group.name, false);
      if (iconNode) {
        const wrap = document.createElement('span');
        wrap.className = 'group-icon';
        wrap.appendChild(iconNode);
        const header = card.querySelector('.group-header');
        header.insertBefore(wrap, header.firstChild);
      }

      container.appendChild(card);
      addResizeHandle(card, group);

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
    a.dataset.key = `${group.name}::${svc.name}`;

    const dotHtml = svc.check
      ? `<span class="status-dot unknown" role="img" data-key="${esc(group.name)}::${esc(svc.name)}" aria-label="Checking…" title="Checking…"></span>`
      : '';

    a.innerHTML = `
      <span class="service-info">
        <span class="service-name">${esc(svc.name)}</span>
        ${svc.description ? `<span class="service-desc">${esc(svc.description)}</span>` : ''}
        <span class="service-stats" style="display:none"></span>
      </span>
      ${dotHtml}
    `;

    const wrap = document.createElement('span');
    wrap.className = 'service-icon';
    wrap.appendChild(buildIcon(svc.icon, svc.name, true));
    a.insertBefore(wrap, a.firstChild);

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
      $('last-updated').textContent = 'Updated ' + formatTime(new Date());
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
      refreshTimer = setInterval(refreshAll, interval);
    }
  }

  function refreshAll(force = false) {
    return Promise.all([refreshStatus(force), refreshWidgets(force)]);
  }

  // ── Widgets (per-service API data) ───────────────────
  async function refreshWidgets(force = false) {
    try {
      const res = await fetch('/api/widgets' + (force ? '?fresh=1' : ''));
      widgetMap = await res.json();
      applyWidgets();
    } catch {
      /* leave previous widget data in place */
    }
  }

  function applyWidgets() {
    document.querySelectorAll('.service[data-key]').forEach((a) => {
      const host = a.querySelector('.service-stats');
      if (!host) return;
      const w = widgetMap[a.dataset.key];
      const fields = w && Array.isArray(w.fields) ? w.fields : [];

      if (!fields.length) {
        // Show the reason a widget produced nothing, so it's debuggable.
        if (w && w.error) {
          host.innerHTML = `<span class="widget-error" title="${esc(w.error)}">${esc(w.error)}</span>`;
          host.style.display = '';
        } else {
          host.innerHTML = '';
          host.style.display = 'none';
        }
        return;
      }

      host.innerHTML = fields
        .map(
          (f) =>
            `<span class="stat"><span class="stat-value">${esc(f.value)}</span>` +
            `<span class="stat-label">${esc(f.label)}</span></span>`,
        )
        .join('');
      host.style.display = '';
    });
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
