// Darstellung (Farbschema, Akzentfarbe, Schriftgröße …). Läuft als normales Skript im <head>,
// also bevor irgendetwas gezeichnet wird – so blitzt beim Start nie das falsche Farbschema auf.
// app.js benutzt dieselben Funktionen über window.PCLook, wenn in den Einstellungen etwas geändert wird.
(function () {
  'use strict';

  // [Schlüssel, Name, Vorschaufarben: Leiste, Fläche, Kachel]
  var THEMES = [
    ['system', 'Wie Windows', null],
    ['wald', 'Kiefernwald', ['#0d1716', '#192826', '#294340']],
    ['nacht', 'Mitternacht', ['#0b101b', '#161d2c', '#27324a']],
    ['graphit', 'Graphit', ['#111214', '#1d1e21', '#2e3035']],
    ['schwarz', 'Schwarz', ['#000000', '#0a0a0a', '#1f1f1f']],
    ['hell', 'Hell', ['#e3e9e6', '#f8faf9', '#ffffff']],
  ];
  var ACCENTS = [
    ['#f2d95c', 'Buttergelb'],
    ['#ffb35c', 'Orange'],
    ['#ff8a7a', 'Koralle'],
    ['#ff9ecb', 'Rosa'],
    ['#c9a2ff', 'Flieder'],
    ['#8fb8ff', 'Himmelblau'],
    ['#5fd4e0', 'Türkis'],
    ['#7ad7a1', 'Minze'],
  ];
  var DEFAULTS = { theme: 'wald', accent: '#f2d95c', msgSize: 15, density: 'cozy', corners: 'round', motion: true, photo: true, veil: 62 };

  var dark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var last = DEFAULTS;

  function hexRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Relative Helligkeit nach WCAG – entscheidet, ob auf der Akzentfarbe dunkle oder helle Schrift steht.
  function luminance(rgb) {
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function resolveTheme(theme) {
    if (theme === 'system') return dark && !dark.matches ? 'hell' : 'wald';
    return THEMES.some(function (t) { return t[0] === theme && t[2]; }) ? theme : DEFAULTS.theme;
  }

  function apply(p) {
    p = p || {};
    last = p;
    var root = document.documentElement;
    var theme = resolveTheme(p.theme || DEFAULTS.theme);
    root.dataset.theme = theme;
    var rgb = hexRgb(p.accent) || hexRgb(DEFAULTS.accent);
    var accent = '#' + rgb.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-ink', luminance(rgb) > 0.36 ? '#17150a' : '#ffffff');
    var size = Math.min(20, Math.max(13, Number(p.msgSize) || DEFAULTS.msgSize));
    root.style.setProperty('--msg-fs', size + 'px');
    root.dataset.density = p.density === 'compact' ? 'compact' : 'cozy';
    root.dataset.corners = p.corners === 'soft' || p.corners === 'sharp' ? p.corners : 'round';
    root.classList.toggle('calm', p.motion === false);
    root.dataset.photo = p.photo === false ? 'off' : 'on';
    root.style.setProperty('--veil', String(Math.min(95, Math.max(40, Number(p.veil) || DEFAULTS.veil))));
    var light = theme === 'hell';
    var meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = light ? 'light' : 'dark';
  }

  // „Wie Windows“ folgt dem Wechsel zwischen hellem und dunklem Modus sofort.
  if (dark) {
    var follow = function () { if ((last.theme || DEFAULTS.theme) === 'system') apply(last); };
    if (dark.addEventListener) dark.addEventListener('change', follow);
    else if (dark.addListener) dark.addListener(follow);
  }

  var saved = {};
  try { saved = JSON.parse(localStorage.getItem('pc_prefs') || '{}') || {}; } catch (e) { saved = {}; }
  apply(saved);

  window.PCLook = { THEMES: THEMES, ACCENTS: ACCENTS, DEFAULTS: DEFAULTS, apply: apply, resolveTheme: resolveTheme };
})();
