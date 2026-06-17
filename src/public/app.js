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
  const GLYPH_KEY = 'dashify-glyphs';
  const RSS_KEY = 'dashify-rss';
  const RSS_PANE_KEY = 'dashify-rss-pane';
  const COLLAPSED_KEY = 'dashify-collapsed';
  const ORDER_KEY = 'dashify-group-order';
  const SERVICE_ORDER_KEY = 'dashify-service-order';
  const ACTIVE_TAB_KEY = 'dashify-active-tab';
  let config = null;
  let statusMap = {};
  let widgetMap = {};
  let feeds = [];
  let refreshTimer = null;
  let clockTimer = null;
  let activeTab = null;
  // localStorage wrapper that never throws (private mode / storage disabled).
  const store = {
    get: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
    getJSON: (key, fallback) => {
      try {
        const v = JSON.parse(localStorage.getItem(key));
        return v == null ? fallback : v;
      } catch {
        return fallback;
      }
    },
    setJSON: (key, value) => store.set(key, JSON.stringify(value)),
  };

  let clock24 = store.get(CLOCK_KEY) !== '12';

  const $ = (id) => document.getElementById(id);

  // ── Boot ────────────────────────────────────────────
  async function init() {
    await loadConfig();
    activeTab = store.get(ACTIVE_TAB_KEY);
    applyTheme();
    applyGlyphs();
    applyBackground();
    applyAppearance();
    feeds = loadFeeds();
    applyRssPane();
    applyHeaderExtras();
    document.body.classList.add('app-loading'); // shimmer until first data arrives
    renderGroups();
    renderFeeds();
    await refreshAll();
    document.body.classList.remove('app-loading');
    clearStaleSkeletons();
    scheduleRefresh();
    wireControls();
    startClock();
    startWeather();
  }

  // Hide any widget skeletons that never received data (e.g. the first widget
  // fetch failed) so a placeholder doesn't shimmer forever.
  function clearStaleSkeletons() {
    document.querySelectorAll('.service-stats').forEach((host) => {
      if (host.querySelector('.stat-skel')) {
        host.innerHTML = '';
        host.style.display = 'none';
      }
    });
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

    buildSettingsModal();
    $('settings-btn').addEventListener('click', openSettings);

    $('rss-toggle').addEventListener('click', toggleRssPane);
    $('rss-add').addEventListener('submit', onAddFeed);
    $('rss-refresh').addEventListener('click', () => loadAllFeeds(true));

    $('web-search').addEventListener('submit', onWebSearch);

    // Swallow the click that immediately follows a drag so a reordered service
    // link doesn't navigate (capture phase, before the anchor's own handler).
    document.addEventListener(
      'click',
      (e) => {
        if (suppressNextClick) {
          e.preventDefault();
          e.stopPropagation();
          suppressNextClick = false;
        }
      },
      true,
    );

    const filter = $('filter');
    filter.addEventListener('input', applyFilter);

    document.addEventListener('keydown', (e) => {
      // Don't steal "/" while the user is typing in a field (e.g. the feed box).
      if (e.key === '/' && !isTypingTarget(e.target)) {
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

    showConfigError(config.config_error);
  }

  // Show a dismissible banner when the server couldn't parse config.yaml /
  // RSS.yaml, instead of silently rendering an empty default dashboard.
  function showConfigError(msg) {
    const el = $('config-error');
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      '<span class="config-error-text"></span>' +
      '<button class="config-error-close" type="button" aria-label="Dismiss">✕</button>';
    el.querySelector('.config-error-text').textContent = '⚠ ' + msg;
    el.querySelector('.config-error-close').addEventListener('click', () => {
      el.hidden = true;
    });
    el.hidden = false;
  }

  // ── Theme ────────────────────────────────────────────
  const SUN_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function storedTheme() {
    const t = store.get(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
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
    store.set(THEME_KEY, next);
    applyTheme();
  }

  // ── Colourblind-safe status glyphs (✓ / ✕ / ?) ───────
  // A per-browser toggle, defaulting to config.status_glyphs. When on, status
  // dots also carry a shape so up/down/unknown don't rely on colour alone.
  function resolveGlyphs() {
    const v = store.get(GLYPH_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
    return config?.status_glyphs === true;
  }

  function applyGlyphs() {
    const on = resolveGlyphs();
    document.documentElement.classList.toggle('glyphs', on);
    const cb = document.querySelector('.cp-glyphs');
    if (cb) cb.checked = on;
  }

  function setGlyphs(on) {
    store.set(GLYPH_KEY, on ? '1' : '0');
    applyGlyphs();
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
    store.set(CLOCK_KEY, clock24 ? '24' : '12');
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

  // Colours come from four layers, lowest to highest precedence:
  //   1. the theme CSS class, 2. config.yaml `colors`, 3. a selected preset
  //   theme, 4. the in-page editor (all per-theme, saved in this browser).
  //   Re-run on every theme change.
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

  // ── Preset themes ────────────────────────────────────
  // Curated palettes selectable from the colour panel. `base: true` entries are
  // the built-in Dark/Light themes (no overrides — just the CSS class). Each
  // palette maps onto the overridable CSS variables above.
  const PRESET_KEY = 'dashify-preset';
  const PRESETS = [
    // Built-ins
    { id: 'dark', name: 'Dark', mode: 'dark', base: true, swatch: ['#0f1117', '#6c8ef7', '#4ade80', '#f87171'] },
    { id: 'light', name: 'Light', mode: 'light', base: true, swatch: ['#f1f5f9', '#4f6ef0', '#16a34a', '#dc2626'] },

    // Dark palettes (earthy / warm leaning)
    { id: 'dracula', name: 'Dracula', mode: 'dark', colors: { bg: '#282a36', 'bg-card': '#343746', 'bg-card-hover': '#424458', border: '#44475a', text: '#f8f8f2', 'text-muted': '#a9adc8', 'text-dim': '#6272a4', accent: '#bd93f9', up: '#50fa7b', down: '#ff5555', unknown: '#6272a4', 'header-bg': '#21222c' } },
    { id: 'catppuccin-mocha', name: 'Catppuccin Mocha', mode: 'dark', colors: { bg: '#1e1e2e', 'bg-card': '#313244', 'bg-card-hover': '#45475a', border: '#313244', text: '#cdd6f4', 'text-muted': '#a6adc8', 'text-dim': '#7f849c', accent: '#cba6f7', up: '#a6e3a1', down: '#f38ba8', unknown: '#6c7086', 'header-bg': '#181825' } },
    { id: 'gruvbox', name: 'Gruvbox', mode: 'dark', colors: { bg: '#282828', 'bg-card': '#3c3836', 'bg-card-hover': '#504945', border: '#504945', text: '#ebdbb2', 'text-muted': '#bdae93', 'text-dim': '#928374', accent: '#fabd2f', up: '#b8bb26', down: '#fb4934', unknown: '#928374', 'header-bg': '#1d2021' } },
    { id: 'everforest', name: 'Everforest', mode: 'dark', colors: { bg: '#2d353b', 'bg-card': '#343f44', 'bg-card-hover': '#3d484d', border: '#475258', text: '#d3c6aa', 'text-muted': '#9da9a0', 'text-dim': '#859289', accent: '#83c092', up: '#a7c080', down: '#e67e80', unknown: '#859289', 'header-bg': '#272e33' } },
    { id: 'kanagawa', name: 'Kanagawa', mode: 'dark', colors: { bg: '#1f1f28', 'bg-card': '#2a2a37', 'bg-card-hover': '#363646', border: '#54546d', text: '#dcd7ba', 'text-muted': '#c8c093', 'text-dim': '#727169', accent: '#e6c384', up: '#76946a', down: '#c34043', unknown: '#727169', 'header-bg': '#16161d' } },
    { id: 'rose-pine', name: 'Rosé Pine', mode: 'dark', colors: { bg: '#191724', 'bg-card': '#1f1d2e', 'bg-card-hover': '#26233a', border: '#26233a', text: '#e0def4', 'text-muted': '#908caa', 'text-dim': '#6e6a86', accent: '#ebbcba', up: '#9ccfd8', down: '#eb6f92', unknown: '#6e6a86', 'header-bg': '#1f1d2e' } },
    { id: 'zenburn', name: 'Zenburn', mode: 'dark', colors: { bg: '#3f3f3f', 'bg-card': '#4a4a4a', 'bg-card-hover': '#565650', border: '#5f5f5f', text: '#dcdccc', 'text-muted': '#c0c0a8', 'text-dim': '#989890', accent: '#dfaf8f', up: '#7f9f7f', down: '#cc9393', unknown: '#989890', 'header-bg': '#383838' } },

    // Light palettes (earthy / warm leaning)
    { id: 'everforest-light', name: 'Everforest Light', mode: 'light', colors: { bg: '#fdf6e3', 'bg-card': '#f4f0d9', 'bg-card-hover': '#efebd4', border: '#e0dcc7', text: '#5c6a72', 'text-muted': '#829181', 'text-dim': '#939f91', accent: '#35a77c', up: '#8da101', down: '#f85552', unknown: '#a6b0a0', 'header-bg': '#f4f0d9' } },
    { id: 'gruvbox-light', name: 'Gruvbox Light', mode: 'light', colors: { bg: '#f2e5bc', 'bg-card': '#fbf1c7', 'bg-card-hover': '#ebdbb2', border: '#d5c4a1', text: '#3c3836', 'text-muted': '#665c54', 'text-dim': '#7c6f64', accent: '#af3a03', up: '#79740e', down: '#9d0006', unknown: '#a89984', 'header-bg': '#ebdbb2' } },
    { id: 'kanagawa-lotus', name: 'Kanagawa Lotus', mode: 'light', colors: { bg: '#e5ddb0', 'bg-card': '#f2ecbc', 'bg-card-hover': '#dcd5ac', border: '#d5cea3', text: '#545464', 'text-muted': '#716e61', 'text-dim': '#8a8980', accent: '#624c83', up: '#6f894e', down: '#c84053', unknown: '#8a8980', 'header-bg': '#dcd5ac' } },
    { id: 'selenized-light', name: 'Selenized Light', mode: 'light', colors: { bg: '#ece3cc', 'bg-card': '#fbf3db', 'bg-card-hover': '#e0d6ba', border: '#d5cdb6', text: '#3a4d53', 'text-muted': '#53676d', 'text-dim': '#909995', accent: '#c25d1e', up: '#489100', down: '#d2212d', unknown: '#909995', 'header-bg': '#e0d6ba' } },
    { id: 'solarized-light', name: 'Solarized Light', mode: 'light', colors: { bg: '#fdf6e3', 'bg-card': '#eee8d5', 'bg-card-hover': '#e7e1cd', border: '#d3cbb8', text: '#657b83', 'text-muted': '#839496', 'text-dim': '#93a1a1', accent: '#b58900', up: '#859900', down: '#dc322f', unknown: '#93a1a1', 'header-bg': '#eee8d5' } },
    { id: 'catppuccin-latte', name: 'Catppuccin Latte', mode: 'light', colors: { bg: '#eff1f5', 'bg-card': '#ffffff', 'bg-card-hover': '#e6e9ef', border: '#ccd0da', text: '#4c4f69', 'text-muted': '#6c6f85', 'text-dim': '#8c8fa1', accent: '#8839ef', up: '#40a02b', down: '#d20f39', unknown: '#9ca0b0', 'header-bg': '#e6e9ef' } },
    { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', mode: 'light', colors: { bg: '#faf4ed', 'bg-card': '#fffaf3', 'bg-card-hover': '#f2e9e1', border: '#dfdad9', text: '#575279', 'text-muted': '#797593', 'text-dim': '#9893a5', accent: '#907aa9', up: '#286983', down: '#b4637a', unknown: '#9893a5', 'header-bg': '#fffaf3' } },
  ];

  const presetById = (id) => PRESETS.find((p) => p.id === id);
  const presetSwatch = (p) => (p.colors ? [p.colors.bg, p.colors.accent, p.colors.up, p.colors.down] : p.swatch);

  // Which preset is chosen for each mode (so the dark/light toggle can flip
  // between, say, Dracula and Gruvbox Light). null = the built-in base. Unknown
  // ids (e.g. a preset that was renamed or removed) fall back to the base.
  let presetSelection = (() => {
    const o = store.getJSON(PRESET_KEY, {});
    const valid = (id) => (presetById(id) ? id : null);
    return { dark: valid(o.dark), light: valid(o.light) };
  })();

  function persistPreset() {
    store.setJSON(PRESET_KEY, presetSelection);
  }

  let colorOverrides = (() => {
    const o = store.getJSON(COLORS_KEY, {});
    return { dark: o.dark || {}, light: o.light || {} };
  })();

  const currentTheme = () =>
    document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';

  function persistColors() {
    store.setJSON(COLORS_KEY, colorOverrides);
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

    // 3) a selected preset theme for the active mode
    const preset = presetById(presetSelection[theme]);
    if (preset && preset.colors) {
      for (const [name, value] of Object.entries(preset.colors)) {
        if (OVERRIDABLE.includes(name)) root.style.setProperty(`--${name}`, value);
      }
    }

    // 4) in-page editor overrides for the active theme (highest precedence)
    for (const [name, value] of Object.entries(colorOverrides[theme] || {})) {
      if (OVERRIDABLE.includes(name) && typeof value === 'string') {
        root.style.setProperty(`--${name}`, value);
      }
    }

    syncColorInputs();
    syncPresetSelection();
  }

  // Apply a preset: switch to its mode, remember it for that mode, and clear any
  // manual tweaks so the theme shows cleanly. Base (Dark/Light) entries just
  // clear the preset for their mode.
  function selectPreset(id) {
    const preset = presetById(id);
    if (!preset) return;
    const mode = preset.mode;
    presetSelection[mode] = preset.base ? null : id;
    persistPreset();
    colorOverrides[mode] = {};
    persistColors();
    store.set(THEME_KEY, mode);
    applyTheme();
  }

  function syncPresetSelection() {
    const panel = $('color-panel');
    if (!panel) return;
    const theme = currentTheme();
    const activeId = presetSelection[theme] || theme; // base id === mode
    panel.querySelectorAll('.cp-preset').forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === activeId);
    });
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
    panel.setAttribute('aria-label', 'Themes and colours');
    panel.innerHTML = `
      <div class="cp-header">
        <span>Theme</span>
        <button class="cp-close icon-btn" type="button" aria-label="Close">✕</button>
      </div>
      <div class="cp-presets"></div>
      <div class="cp-section-label">Fine-tune · <span class="cp-theme"></span></div>
      <div class="cp-rows"></div>
      <label class="cp-check"><input type="checkbox" class="cp-glyphs" /><span>Colourblind glyphs (✓ ✕ ?)</span></label>
      <div class="cp-footer">
        <button class="cp-copy" type="button">Copy YAML</button>
        <button class="cp-reset" type="button">Reset</button>
        <span class="cp-note">Saved in this browser</span>
      </div>
    `;

    const presets = panel.querySelector('.cp-presets');
    PRESETS.forEach((p) => {
      const [bg, accent, up, down] = presetSwatch(p);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cp-preset';
      btn.dataset.preset = p.id;
      btn.title = p.name;
      btn.innerHTML =
        `<span class="cp-preset-swatch" style="background:${bg}">` +
        `<i style="background:${accent}"></i><i style="background:${up}"></i><i style="background:${down}"></i>` +
        `</span><span class="cp-preset-name">${esc(p.name)}</span>`;
      btn.addEventListener('click', () => selectPreset(p.id));
      presets.appendChild(btn);
    });

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
      const theme = currentTheme();
      colorOverrides[theme] = {};
      persistColors();
      presetSelection[theme] = null; // back to the built-in base theme
      persistPreset();
      applyColors();
    });
    panel.querySelector('.cp-copy').addEventListener('click', copyColorYaml);
    const glyphCb = panel.querySelector('.cp-glyphs');
    glyphCb.checked = resolveGlyphs();
    glyphCb.addEventListener('change', () => setGlyphs(glyphCb.checked));
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
    if (show) {
      syncColorInputs();
      syncPresetSelection();
    }
  }

  function copyColorYaml() {
    const theme = currentTheme();
    // Export the full effective palette (preset + manual tweaks) so a chosen
    // theme can be baked into config.yaml for every device.
    const preset = presetById(presetSelection[theme]);
    const map = { ...((preset && preset.colors) || {}), ...(colorOverrides[theme] || {}) };
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
  let spanOverrides = store.getJSON(SPANS_KEY, {});

  const gridCols = () => Math.min(4, Math.max(1, config?.columns || 3));

  function spanFor(group) {
    const v = spanOverrides[group.name] ?? group.width ?? 1;
    return Math.min(gridCols(), Math.max(1, parseInt(v, 10) || 1));
  }

  function persistSpans() {
    store.setJSON(SPANS_KEY, spanOverrides);
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

  // ── Tabs (group sections, remembered per browser) ────
  // A group's tab is its `tab:`, or the top-level `default_tab` (or "Main").
  const groupTab = (g) => String(g?.tab ?? config?.default_tab ?? 'Main');

  // Tabs only appear once at least one group opts in with a `tab:` — so an
  // existing tab-less config renders exactly as before.
  const usesTabs = () => (config?.groups || []).some((g) => g.tab != null && g.tab !== '');

  function tabList() {
    const seen = [];
    for (const g of config?.groups || []) {
      const t = groupTab(g);
      if (!seen.includes(t)) seen.push(t);
    }
    return seen;
  }

  function renderTabs() {
    const bar = $('tab-bar');
    if (!bar) return;
    if (!usesTabs()) {
      bar.hidden = true;
      bar.innerHTML = '';
      return;
    }
    const tabs = tabList();
    if (!tabs.includes(activeTab)) activeTab = tabs[0];
    bar.innerHTML = '';
    tabs.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab' + (t === activeTab ? ' active' : '');
      btn.dataset.tab = t;
      btn.textContent = t;
      btn.addEventListener('click', () => switchTab(t));
      bar.appendChild(btn);
    });
    bar.hidden = false;
  }

  function switchTab(t) {
    activeTab = t;
    store.set(ACTIVE_TAB_KEY, t);
    $('tab-bar')
      .querySelectorAll('.tab')
      .forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    applyFilter();
  }

  // ── Service order (drag-to-reorder within a group) ───
  let serviceOrders = store.getJSON(SERVICE_ORDER_KEY, {});

  // Saved order first (in its stored sequence), then any new services in config order.
  function orderedServices(group) {
    const order = serviceOrders[group.name];
    const svcs = group.services || [];
    if (!Array.isArray(order) || !order.length) return svcs;
    const rank = (s) => {
      const i = order.indexOf(s.name);
      return i === -1 ? Infinity : i;
    };
    return [...svcs].sort((a, b) => rank(a) - rank(b));
  }

  function saveServiceOrder(groupName, listEl) {
    serviceOrders[groupName] = [...listEl.querySelectorAll('.service')].map((s) => s.dataset.svcName);
    store.setJSON(SERVICE_ORDER_KEY, serviceOrders);
  }

  // ── Render groups ────────────────────────────────────
  function renderGroups() {
    const container = $('groups-container');
    container.innerHTML = '';

    const groups = orderedGroups(config?.groups || []);
    renderTabs();
    if (!groups.length) {
      container.innerHTML =
        '<div class="empty-state">No services configured yet.<br>' +
        'Add some to <code>config/config.yaml</code> and refresh.</div>';
      return;
    }

    const collapsed = loadCollapsed();
    groups.forEach((group) => {
      const card = document.createElement('div');
      card.className = 'group' + (collapsed.has(group.name) ? ' collapsed' : '');
      card.dataset.group = group.name;
      card.dataset.tab = groupTab(group);
      card.style.setProperty('--span', spanFor(group));
      card.innerHTML = `
        <div class="group-header">
          <span class="group-drag" title="Drag to reorder" aria-hidden="true">⠿</span>
          <span class="group-name">${esc(group.name)}</span>
          <span class="group-collapse" aria-hidden="true">▾</span>
        </div>
        <div class="service-list"></div>
      `;

      const header = card.querySelector('.group-header');
      const iconNode = buildIcon(group.icon, group.name, false);
      if (iconNode) {
        const wrap = document.createElement('span');
        wrap.className = 'group-icon';
        wrap.appendChild(iconNode);
        header.insertBefore(wrap, header.querySelector('.group-name'));
      }
      // Click the header (but not the drag grip) to collapse/expand.
      header.addEventListener('click', (e) => {
        if (e.target.closest('.group-drag')) return;
        toggleCollapse(group.name, card);
      });

      container.appendChild(card);
      addResizeHandle(card, group);
      enableGroupDrag(card);

      const list = card.querySelector('.service-list');
      orderedServices(group).forEach((svc) => {
        list.appendChild(buildServiceEl(group, svc));
      });
    });

    applyFilter(); // apply the active tab (and any live filter text)
  }

  function buildServiceEl(group, svc) {
    const a = document.createElement('a');
    a.className = 'service';
    a.href = svc.url || '#';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.draggable = false; // the grip drives reordering, not the whole link
    a.dataset.svcName = svc.name || '';
    a.dataset.desc = svc.description || '';
    a.dataset.key = `${group.name}::${svc.name}`;

    const sparkHtml = svc.check && config?.sparklines ? '<span class="svc-spark" aria-hidden="true"></span>' : '';
    const dotHtml = svc.check
      ? `<span class="service-status">${sparkHtml}<span class="svc-uptime"></span>` +
        `<span class="status-dot unknown" role="img" data-key="${esc(group.name)}::${esc(svc.name)}" aria-label="Checking…" title="Checking…"></span></span>`
      : '';

    a.innerHTML = `
      <span class="service-drag" title="Drag to reorder" aria-hidden="true">⠿</span>
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
    a.insertBefore(wrap, a.querySelector('.service-info'));

    // Services that expose a widget get a shimmer placeholder until the first
    // /api/widgets response replaces it (or clearStaleSkeletons hides it).
    if (svc.has_widget) {
      const host = a.querySelector('.service-stats');
      host.innerHTML = '<span class="stat-skel"></span><span class="stat-skel"></span><span class="stat-skel"></span>';
      host.style.display = '';
    }

    enableServiceDrag(a, group);
    return a;
  }

  // ── Status ───────────────────────────────────────────
  async function refreshStatus(force = false) {
    const btn = $('refresh-btn');
    btn.classList.add('refreshing');

    try {
      const res = await fetch('/api/status' + (force ? '?fresh=1' : ''));
      statusMap = await res.json();
      applyStatus();
      $('last-updated').textContent = 'Updated ' + formatTime(new Date());
    } catch {
      $('last-updated').textContent = 'Status check failed';
    } finally {
      btn.classList.remove('refreshing');
    }
  }

  function applyStatus() {
    document.querySelectorAll('.status-dot[data-key]').forEach((dot) => {
      const info = statusMap[dot.dataset.key];
      const label = statusLabel(info);
      dot.className = 'status-dot ' + (info?.status || 'unknown');
      dot.title = label;
      dot.setAttribute('aria-label', label);

      const uptimeEl = dot.parentElement && dot.parentElement.querySelector('.svc-uptime');
      if (uptimeEl) {
        uptimeEl.textContent = info && info.uptime24 != null ? `${info.uptime24}%` : '';
      }

      const sparkEl = dot.parentElement && dot.parentElement.querySelector('.svc-spark');
      if (sparkEl) renderSpark(sparkEl, info && info.spark);
    });
    updateSummary();
  }

  // Inline latency sparkline (opt-in via `sparklines: true`). Bars scale to the
  // tallest sample in the window; down samples draw full-height in the down
  // colour so outages stand out at a glance.
  function renderSpark(el, spark) {
    if (!Array.isArray(spark) || !spark.length) {
      el.innerHTML = '';
      el.style.display = 'none';
      return;
    }
    const W = 2;
    const GAP = 1;
    const H = 14;
    const max = Math.max(1, ...spark.map((s) => (typeof s.ms === 'number' ? s.ms : 0)));
    const width = spark.length * W + (spark.length - 1) * GAP;
    const bars = spark
      .map((s, i) => {
        const ms = typeof s.ms === 'number' ? s.ms : 0;
        const h = s.up ? Math.max(2, Math.round((ms / max) * H)) : H;
        return `<rect class="spark-bar ${s.up ? 'up' : 'down'}" x="${i * (W + GAP)}" y="${H - h}" width="${W}" height="${h}"></rect>`;
      })
      .join('');
    el.innerHTML = `<svg viewBox="0 0 ${width} ${H}" width="${width}" height="${H}" preserveAspectRatio="none">${bars}</svg>`;
    el.style.display = '';
    const last = spark[spark.length - 1];
    el.title =
      last && typeof last.ms === 'number'
        ? `Latency · last ${last.ms} ms, peak ${max} ms (${spark.length} checks)`
        : `Last ${spark.length} checks`;
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
    if (!info || info.status === 'unknown') return 'Checking…';
    const ms = info.latency != null ? ` · ${info.latency} ms` : '';
    const up = info.uptime24 != null ? ` · ${info.uptime24}% 24h` : '';
    // TCP checks have no HTTP code.
    const http = info.code != null ? ` (HTTP ${info.code})` : '';
    if (info.status === 'up') return `Online${http}${ms}${up}`;
    if (info.error) return `Offline — ${info.error}${ms}${up}`;
    return `Offline${http}${ms}${up}`;
  }

  function scheduleRefresh() {
    clearInterval(refreshTimer);
    const interval = (config?.refresh_interval ?? 30) * 1000;
    if (interval > 0) {
      refreshTimer = setInterval(refreshAll, interval);
    }
  }

  function refreshAll(force = false) {
    return Promise.all([refreshStatus(force), refreshWidgets(force), loadAllFeeds(force)]);
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

  // ── RSS feeds (side pane) ────────────────────────────
  function loadFeeds() {
    const stored = store.getJSON(RSS_KEY, null);
    if (Array.isArray(stored)) return stored.filter((u) => typeof u === 'string');
    // First run: seed from config.rss (entries may be strings or { url }).
    return (config?.rss || [])
      .map((f) => (typeof f === 'string' ? f : f && f.url))
      .filter((u) => typeof u === 'string' && u);
  }

  function persistFeeds() {
    store.setJSON(RSS_KEY, feeds);
  }

  const rssItemLimit = () => Math.min(20, Math.max(1, parseInt(config?.rss_item_limit, 10) || 6));

  function feedHost(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function timeAgo(dateStr) {
    const t = Date.parse(dateStr);
    if (!Number.isFinite(t)) return '';
    const secs = Math.max(0, (Date.now() - t) / 1000);
    if (secs < 60) return 'now';
    const mins = secs / 60;
    if (mins < 60) return `${Math.floor(mins)}m`;
    const hours = mins / 60;
    if (hours < 24) return `${Math.floor(hours)}h`;
    const days = hours / 24;
    if (days < 7) return `${Math.floor(days)}d`;
    return new Date(t).toLocaleDateString();
  }

  function buildFeedCard(url) {
    const card = document.createElement('div');
    card.className = 'rss-feed';
    card.dataset.url = url;
    card.innerHTML = `
      <div class="rss-feed-head">
        <span class="rss-feed-title" title="${esc(url)}">${esc(feedHost(url))}</span>
        <button class="rss-remove" type="button" aria-label="Remove feed" title="Remove feed">✕</button>
      </div>
      <div class="rss-items"><div class="rss-loading">Loading…</div></div>
    `;
    card.querySelector('.rss-remove').addEventListener('click', () => removeFeed(url));
    return card;
  }

  function renderFeeds() {
    const list = $('rss-list');
    if (!list) return;
    list.innerHTML = '';
    if (!feeds.length) {
      list.innerHTML = '<div class="rss-empty">No feeds yet — add an RSS or Atom URL above.</div>';
      return;
    }
    feeds.forEach((url) => list.appendChild(buildFeedCard(url)));
  }

  function loadAllFeeds(force = false) {
    // Skip the network when the pane is hidden; reload on reopen instead.
    if (document.body.classList.contains('rss-hidden')) return Promise.resolve();
    const cards = document.querySelectorAll('#rss-list .rss-feed');
    return Promise.all([...cards].map((card) => loadFeedInto(card, force)));
  }

  async function loadFeedInto(card, force) {
    const url = card.dataset.url;
    const host = card.querySelector('.rss-items');
    try {
      const res = await fetch('/api/rss?url=' + encodeURIComponent(url) + (force ? '&fresh=1' : ''));
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.title) card.querySelector('.rss-feed-title').textContent = data.title;

      const items = (data.items || []).slice(0, rssItemLimit());
      if (!items.length) {
        host.innerHTML = '<div class="rss-empty">No items.</div>';
        return;
      }
      host.innerHTML = items
        .map((it) => {
          const date = it.date ? `<span class="rss-item-date">${esc(timeAgo(it.date))}</span>` : '';
          return (
            `<a class="rss-item" href="${esc(it.link || '#')}" target="_blank" rel="noopener noreferrer">` +
            `<span class="rss-item-title">${esc(it.title || '(untitled)')}</span>${date}</a>`
          );
        })
        .join('');
    } catch (e) {
      host.innerHTML = `<div class="rss-error" title="${esc(e.message || '')}">${esc(e.message || 'Failed to load')}</div>`;
    }
  }

  function onAddFeed(e) {
    e.preventDefault();
    const input = $('rss-url');
    let url = (input.value || '').trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    input.value = '';
    if (feeds.includes(url)) return;

    feeds.push(url);
    persistFeeds();
    const list = $('rss-list');
    const empty = list.querySelector('.rss-empty');
    if (empty) empty.remove();
    const card = buildFeedCard(url);
    list.appendChild(card);
    loadFeedInto(card, true);
  }

  function removeFeed(url) {
    feeds = feeds.filter((u) => u !== url);
    persistFeeds();
    renderFeeds();
    loadAllFeeds(false);
  }

  function applyRssPane() {
    const open = store.get(RSS_PANE_KEY) !== 'closed';
    document.body.classList.toggle('rss-hidden', !open);
    const btn = $('rss-toggle');
    if (btn) {
      btn.setAttribute('aria-pressed', String(open));
      btn.title = open ? 'Hide feeds' : 'Show feeds';
    }
  }

  function toggleRssPane() {
    const willOpen = document.body.classList.contains('rss-hidden');
    store.set(RSS_PANE_KEY, willOpen ? 'open' : 'closed');
    applyRssPane();
    if (willOpen) loadAllFeeds(false);
  }

  // ── Groups: collapse + reorder (remembered per browser) ──
  function loadCollapsed() {
    return new Set(store.getJSON(COLLAPSED_KEY, []));
  }

  function toggleCollapse(name, card) {
    const set = loadCollapsed();
    if (set.has(name)) set.delete(name);
    else set.add(name);
    card.classList.toggle('collapsed', set.has(name));
    store.setJSON(COLLAPSED_KEY, [...set]);
  }

  function loadOrder() {
    const o = store.getJSON(ORDER_KEY, null);
    return Array.isArray(o) ? o : [];
  }

  // Saved order first (in its stored sequence), then any new groups in config order.
  function orderedGroups(groups) {
    const order = loadOrder();
    if (!order.length) return groups;
    const rank = (g) => {
      const i = order.indexOf(g.name);
      return i === -1 ? Infinity : i;
    };
    return [...groups].sort((a, b) => rank(a) - rank(b));
  }

  function saveOrder() {
    const names = [...document.querySelectorAll('#groups-container .group')].map((c) => c.dataset.group);
    store.setJSON(ORDER_KEY, names);
  }

  // Set right after a drag so the synthetic click that follows is swallowed.
  let suppressNextClick = false;

  // Pointer-based dragging from a grip handle. Replaces HTML5 drag-and-drop so
  // reordering works with touch as well as a mouse. A small movement threshold
  // distinguishes a drag from a tap.
  //
  // The move/up listeners live on `window`, NOT the grip: the first reorder
  // re-parents the dragged card (and the grip inside it), and the browser
  // releases pointer capture when a captured element is moved — which would
  // freeze the drag after one step. Listening on the window sidesteps that, and
  // `touch-action: none` on the grip (CSS) stops touch drags from scrolling.
  function makePointerDrag(handle, { onStart, onMove, onEnd }) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button && e.button !== 0) return; // primary button / touch only
      const sx = e.clientX;
      const sy = e.clientY;
      let active = false;

      const move = (ev) => {
        if (!active) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
          active = true;
          document.body.classList.add('dragging-active');
          onStart(ev.clientX, ev.clientY);
        }
        ev.preventDefault(); // keep touch from scrolling / selecting mid-drag
        onMove(ev.clientX, ev.clientY);
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        if (active) {
          document.body.classList.remove('dragging-active');
          onEnd();
          suppressNextClick = true;
          setTimeout(() => {
            suppressNextClick = false;
          }, 60);
        }
      };

      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      e.preventDefault();
      e.stopPropagation();
    });

    // The grip's own click must never navigate (service) or collapse (group).
    handle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // Float the dragged item under the cursor (a "ghost") while a same-size
  // placeholder marks the drop slot. Keeping the real item OUT of grid flow is
  // what stops the other cards from being shoved around under the pointer — the
  // bit that made live reordering feel chaotic. The order is committed on drop.
  //   item        – the element being dragged
  //   container   – () => the element the placeholder lives in
  //   dropBefore  – (x, y) => the sibling to insert the placeholder before (or null = end)
  //   onCommit    – called after the item is dropped into the placeholder's slot
  function ghostDrag(handle, { item, container, dropBefore, onCommit }) {
    let placeholder = null;
    let savedStyle = '';
    let offX = 0;
    let offY = 0;

    const moveGhost = (x, y) => {
      item.style.left = `${x - offX}px`;
      item.style.top = `${y - offY}px`;
    };

    const placePlaceholder = (x, y) => {
      const cont = container();
      const before = dropBefore(x, y);
      if (before) {
        if (before !== placeholder) cont.insertBefore(placeholder, before);
      } else if (placeholder !== cont.lastElementChild) {
        cont.appendChild(placeholder);
      }
    };

    makePointerDrag(handle, {
      onStart: (x, y) => {
        const r = item.getBoundingClientRect();
        offX = x - r.left;
        offY = y - r.top;

        placeholder = document.createElement('div');
        placeholder.className = `${item.className} drag-placeholder`;
        placeholder.style.cssText = `height:${r.height}px`;
        // Match the grid span so the layout doesn't jump when swapping in/out.
        const span = item.style.getPropertyValue('--span');
        if (span) placeholder.style.setProperty('--span', span);
        item.after(placeholder);

        // Detach to <body> so position:fixed isn't clipped by an overflow:hidden
        // ancestor (group cards clip; service rows live inside one).
        savedStyle = item.getAttribute('style') || '';
        item.classList.add('dragging');
        document.body.appendChild(item);
        item.style.cssText =
          `${savedStyle};position:fixed;margin:0;width:${r.width}px;height:${r.height}px;` +
          `z-index:1000;pointer-events:none;`;
        moveGhost(x, y);
      },
      onMove: (x, y) => {
        moveGhost(x, y);
        placePlaceholder(x, y);
      },
      onEnd: () => {
        placeholder.replaceWith(item);
        placeholder = null;
        item.classList.remove('dragging');
        if (savedStyle) item.setAttribute('style', savedStyle);
        else item.removeAttribute('style');
        onCommit();
      },
    });
  }

  function enableGroupDrag(card) {
    const handle = card.querySelector('.group-drag');
    if (!handle) return;
    ghostDrag(handle, {
      item: card,
      container: () => $('groups-container'),
      dropBefore: groupDropBefore,
      onCommit: saveOrder,
    });
  }

  // The card the dragged one should sit *before* in reading order (top→bottom,
  // left→right), or null to drop at the end. Walking the cards in DOM order and
  // returning the first that's "after" the pointer is monotonic, so live
  // reordering settles instead of oscillating the way nearest-by-distance did.
  // Hidden cards (other tabs / filtered out) have a zero-size rect — skip them.
  function groupDropBefore(x, y) {
    const cards = document.querySelectorAll('#groups-container .group:not(.dragging):not(.drag-placeholder)');
    for (const el of cards) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const rowDelta = y - cy;
      if (rowDelta < -r.height / 2) return el; // pointer is in a row above this card
      if (Math.abs(rowDelta) <= r.height / 2 && x < cx) return el; // same row, left of it
    }
    return null;
  }

  // ── Services: drag-to-reorder within a group ─────────
  function enableServiceDrag(a, group) {
    const handle = a.querySelector('.service-drag');
    if (!handle) return;
    // The list is captured at drag start: services only reorder within their own
    // group, so the placeholder stays in this one list.
    let list = null;
    ghostDrag(handle, {
      item: a,
      container: () => list,
      dropBefore: (_x, y) => nearestService(list, y),
      onCommit: () => {
        if (list) saveServiceOrder(group.name, list);
      },
    });
    // ghostDrag reads container() on start, so resolve the list just before.
    handle.addEventListener(
      'pointerdown',
      () => {
        list = a.closest('.service-list');
      },
      true,
    );
  }

  // First service whose vertical midpoint is below the pointer (insert before it).
  function nearestService(list, y) {
    if (!list) return null;
    const items = list.querySelectorAll('.service:not(.dragging):not(.drag-placeholder)');
    for (const el of items) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return el;
    }
    return null;
  }

  // ── Header extras: web search + weather ──────────────
  function applyHeaderExtras() {
    const search = $('web-search');
    if (search) search.hidden = config?.search === false;
  }

  function onWebSearch(e) {
    e.preventDefault();
    const input = $('web-search-input');
    const q = (input.value || '').trim();
    if (!q) return;
    const tpl = typeof config?.search === 'string' ? config.search : 'https://www.google.com/search?q=%s';
    window.open(tpl.replace('%s', encodeURIComponent(q)), '_blank', 'noopener');
    input.value = '';
  }

  // Small condition icons keyed off the WMO weather code Open-Meteo returns.
  const WEATHER_ICONS = {
    sun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    cloudSun: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6V4M4 9H2M5.1 5.1 3.7 3.7M10.5 7.5A3.5 3.5 0 0 0 4 9"/><path d="M16.5 19a4 4 0 0 0 .2-8 5 5 0 0 0-9.3-1.2A3.6 3.6 0 0 0 7 19z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.5A3.5 3.5 0 0 0 6.5 19z"/></svg>',
    rain: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 13a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.4A3.5 3.5 0 0 0 6 13z"/><path d="M8 17v2M12 17v2M16 17v2"/></svg>',
    snow: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 13a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.4A3.5 3.5 0 0 0 6 13z"/><path d="M8 18h.01M12 18h.01M16 18h.01M10 21h.01M14 21h.01"/></svg>',
    thunder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 12a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.4A3.5 3.5 0 0 0 6 12z"/><path d="M12 14l-2 4h3l-2 4"/></svg>',
  };

  function weatherIcon(code) {
    const c = Number(code);
    if (!Number.isFinite(c)) return '';
    let key = 'cloud';
    if (c === 0) key = 'sun';
    else if (c === 1 || c === 2) key = 'cloudSun';
    else if (c === 3 || c === 45 || c === 48) key = 'cloud';
    else if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) key = 'rain';
    else if ((c >= 71 && c <= 77) || c === 85 || c === 86) key = 'snow';
    else if (c >= 95) key = 'thunder';
    return WEATHER_ICONS[key];
  }

  function startWeather() {
    const w = config?.weather;
    const el = $('weather');
    // Off when there's no weather block, weather:false, weather.enabled:false,
    // or no coordinates — so it's a plain config.yaml toggle.
    if (!el || !w || w === false || w.enabled === false || w.latitude == null || w.longitude == null) return;
    const unit = /f/i.test(w.units || w.unit || 'celsius') ? 'fahrenheit' : 'celsius';
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(w.latitude)}` +
      `&longitude=${encodeURIComponent(w.longitude)}&current=temperature_2m,weather_code&temperature_unit=${unit}`;
    const fetchWeather = async () => {
      try {
        const data = await (await fetch(url)).json();
        const t = data?.current?.temperature_2m;
        if (t == null) return;
        const unitLabel = data?.current_units?.temperature_2m || (unit === 'fahrenheit' ? '°F' : '°C');
        el.innerHTML = weatherIcon(data?.current?.weather_code);
        const temp = document.createElement('span');
        temp.className = 'weather-temp';
        temp.textContent = `${Math.round(t)}${unitLabel}`;
        el.appendChild(temp);
        el.hidden = false;
      } catch {
        /* keep the previous value */
      }
    };
    fetchWeather();
    setInterval(fetchWeather, 15 * 60 * 1000);
  }

  // ── Filter ───────────────────────────────────────────
  function applyFilter() {
    const q = ($('filter').value || '').trim().toLowerCase();
    const tabbed = usesTabs();
    document.querySelectorAll('.group').forEach((group) => {
      // While filtering, search across every tab; otherwise honour the active tab.
      const inTab = !tabbed || !!q || group.dataset.tab === activeTab;
      let visible = 0;
      group.querySelectorAll('.service').forEach((svc) => {
        const hay = `${svc.dataset.svcName} ${svc.dataset.desc}`.toLowerCase();
        const show = !q || hay.includes(q);
        svc.style.display = show ? '' : 'none';
        if (show) visible += 1;
      });
      group.style.display = inTab && visible ? '' : 'none';
    });
  }

  // ── Settings modal (config editor + backup) ─────────
  const BACKUP_PREFIX = 'dashify-';
  let settingsEl = null;

  function buildSettingsModal() {
    const overlay = document.createElement('div');
    overlay.id = 'settings-overlay';
    overlay.className = 'modal-overlay';
    overlay.hidden = true;
    const editorPane = (file, title) => `
      <section class="modal-pane" data-pane="${file}" ${file === 'config' ? '' : 'hidden'}>
        <textarea class="cfg-editor" data-file="${file}" spellcheck="false" autocomplete="off" autocapitalize="off" wrap="off" aria-label="${title}"></textarea>
        <div class="cfg-foot">
          <button class="cfg-save btn-accent" data-file="${file}" type="button">Save</button>
          <button class="cfg-revert btn" data-file="${file}" type="button">Revert</button>
          <span class="cfg-msg" data-file="${file}"></span>
        </div>
      </section>`;
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="modal-head">
          <span class="modal-title">Settings</span>
          <button class="modal-close icon-btn" type="button" aria-label="Close">✕</button>
        </div>
        <div class="modal-tabs" role="tablist">
          <button class="modal-tab active" data-pane="config" type="button">config.yaml</button>
          <button class="modal-tab" data-pane="rss" type="button">RSS.yaml</button>
          <button class="modal-tab" data-pane="backup" type="button">Backup</button>
        </div>
        <div class="modal-body">
          ${editorPane('config', 'config.yaml')}
          ${editorPane('rss', 'RSS.yaml')}
          <section class="modal-pane" data-pane="backup" hidden>
            <p class="modal-note">Your layout (group &amp; service order, column sizes, collapsed groups), in-browser theme tweaks, clock format, and feed list live in <strong>this browser only</strong>. Export them to carry your setup to another device or browser.</p>
            <div class="cfg-foot">
              <button class="backup-export btn-accent" type="button">Export file</button>
              <button class="backup-import btn" type="button">Import file…</button>
              <button class="backup-copy btn" type="button">Copy</button>
              <span class="cfg-msg backup-msg"></span>
            </div>
            <input class="backup-file" type="file" accept="application/json,.json" hidden />
          </section>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    settingsEl = overlay;

    overlay.querySelectorAll('.modal-tab').forEach((tab) => {
      tab.addEventListener('click', () => showPane(tab.dataset.pane));
    });
    overlay.querySelector('.modal-close').addEventListener('click', closeSettings);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSettings();
    });
    overlay.querySelectorAll('.cfg-save').forEach((b) =>
      b.addEventListener('click', () => saveRaw(b.dataset.file)),
    );
    overlay.querySelectorAll('.cfg-revert').forEach((b) =>
      b.addEventListener('click', () => loadRaw(b.dataset.file)),
    );

    overlay.querySelector('.backup-export').addEventListener('click', exportBackup);
    overlay.querySelector('.backup-copy').addEventListener('click', copyBackup);
    const fileInput = overlay.querySelector('.backup-file');
    overlay.querySelector('.backup-import').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      importBackupText(await f.text());
      fileInput.value = '';
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.hidden) closeSettings();
    });
  }

  function showPane(name) {
    if (!settingsEl) return;
    settingsEl.querySelectorAll('.modal-tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.pane === name),
    );
    settingsEl.querySelectorAll('.modal-pane').forEach((p) => {
      p.hidden = p.dataset.pane !== name;
    });
  }

  function openSettings() {
    if (!settingsEl) return;
    settingsEl.hidden = false;
    document.body.classList.add('modal-open');
    showPane('config');
    loadRaw('config');
    loadRaw('rss');
  }

  function closeSettings() {
    if (settingsEl) settingsEl.hidden = true;
    document.body.classList.remove('modal-open');
  }

  const cfgEl = (cls, file) => settingsEl.querySelector(`.${cls}[data-file="${file}"]`);

  function setCfgMsg(file, text, cls = '') {
    const el = cfgEl('cfg-msg', file);
    if (el) {
      el.textContent = text;
      el.className = 'cfg-msg' + (cls ? ' ' + cls : '');
    }
  }

  async function loadRaw(file) {
    const ta = cfgEl('cfg-editor', file);
    const save = cfgEl('cfg-save', file);
    if (!ta) return;
    setCfgMsg(file, 'Loading…');
    try {
      const res = await fetch('/api/config/raw?file=' + encodeURIComponent(file));
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) {
        ta.value = '';
        ta.disabled = true;
        save.disabled = true;
        setCfgMsg(file, 'Editing is disabled (config_editor: false in config.yaml).', 'warn');
        return;
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      ta.value = data.content || '';
      ta.disabled = false;
      if (data.editable) {
        save.disabled = false;
        setCfgMsg(file, '');
      } else {
        save.disabled = true;
        setCfgMsg(file, 'File is read-only — can’t save here (see the Docker mount note in the README).', 'warn');
      }
    } catch (e) {
      setCfgMsg(file, e.message || 'Failed to load', 'err');
    }
  }

  async function saveRaw(file) {
    const ta = cfgEl('cfg-editor', file);
    const save = cfgEl('cfg-save', file);
    if (!ta) return;
    save.disabled = true;
    setCfgMsg(file, 'Saving…');
    try {
      const res = await fetch('/api/config/raw?file=' + encodeURIComponent(file), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: ta.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCfgMsg(file, data.error || `HTTP ${res.status}`, 'err');
        save.disabled = false;
        return;
      }
      setCfgMsg(file, 'Saved ✓ — reloading…', 'ok');
      setTimeout(() => location.reload(), 650);
    } catch (e) {
      setCfgMsg(file, e.message || 'Save failed', 'err');
      save.disabled = false;
    }
  }

  // ── Backup: export / import the per-browser customizations ──
  function collectBackup() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(BACKUP_PREFIX)) out[k] = localStorage.getItem(k);
      }
    } catch {}
    return out;
  }

  const backupJson = () =>
    JSON.stringify({ _dashify_backup: 1, exported: new Date().toISOString(), data: collectBackup() }, null, 2);

  function setBackupMsg(text, cls = '') {
    const el = settingsEl && settingsEl.querySelector('.backup-msg');
    if (el) {
      el.textContent = text;
      el.className = 'cfg-msg backup-msg' + (cls ? ' ' + cls : '');
    }
  }

  function exportBackup() {
    try {
      const blob = new Blob([backupJson()], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'dashify-settings.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBackupMsg('Exported dashify-settings.json', 'ok');
    } catch (e) {
      setBackupMsg(e.message || 'Export failed', 'err');
    }
  }

  function copyBackup() {
    const text = backupJson();
    const done = () => setBackupMsg('Copied to clipboard', 'ok');
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => setBackupMsg('Copy failed', 'err'));
    else done();
  }

  function importBackupText(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      setBackupMsg('Not a valid JSON file', 'err');
      return;
    }
    // Accept either a wrapped export ({ data: {…} }) or a flat key map.
    const data = obj && typeof obj.data === 'object' && obj.data ? obj.data : obj;
    if (!data || typeof data !== 'object') {
      setBackupMsg('Not a Dashify backup', 'err');
      return;
    }
    let n = 0;
    try {
      for (const [k, v] of Object.entries(data)) {
        if (k.startsWith(BACKUP_PREFIX) && typeof v === 'string') {
          localStorage.setItem(k, v);
          n++;
        }
      }
    } catch {
      setBackupMsg('Storage unavailable in this browser', 'err');
      return;
    }
    if (!n) {
      setBackupMsg('No Dashify settings found in that file', 'err');
      return;
    }
    setBackupMsg(`Imported ${n} settings — reloading…`, 'ok');
    setTimeout(() => location.reload(), 650);
  }

  // ── Helpers ──────────────────────────────────────────
  // True when the keyboard event originated in an editable field, so global
  // single-key shortcuts (like "/") shouldn't fire.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  init();
})();
