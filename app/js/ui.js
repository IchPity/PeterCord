// Kleine Bausteine für die Oberfläche – ohne Framework, damit die App leicht bleibt.
import { fileUrl } from './net.js';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'data') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(9).filter((x) => x != null && x !== false && x !== ''));
  return el;
}

const PATHS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  plus: 'M12 5v14M5 12h14',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  volume: 'M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  micOff: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3M4 3l16 18',
  head: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1z',
  headOff: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H5a1 1 0 0 1-1-1zM20 14h-3v6h2a1 1 0 0 0 1-1zM4 3l16 18',
  gear: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M16 4v4M10 10v4M18 16v4',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1z',
  hang: 'M3 15c0-2.500 4-5 9-5s9 2.500 9 5v2l-4.500 1-1-3.500h-7l-1 3.500L3 17z',
  screen: 'M3 5h18v11H3zM8 20h8M12 16v4',
  send: 'M4 12l16-8-6 16-3-6z',
  clip: 'M20 11l-8.500 8.500a5 5 0 0 1-7-7L13 4a3.500 3.500 0 0 1 5 5l-8.500 8.500a2 2 0 0 1-3-3L14 7',
  smile: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.500 14a4 4 0 0 0 7 0M9 9.500v.500M15 9.500v.500',
  reply: 'M10 8L5 12l5 4M5 12h9a5 5 0 0 1 5 5v1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  users: 'M9 11a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7zM2.500 20a6.500 6.500 0 0 1 13 0M16 4.500a3.500 3.500 0 0 1 0 6.500M18 14.500a6 6 0 0 1 3.500 5.500',
  x: 'M6 6l12 12M18 6L6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  check: 'M5 12l5 5 9-10',
  msg: 'M4 5h16v11H9l-5 4z',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  out: 'M10 4H5v16h5M14 8l4 4-4 4M18 12H9',
  down: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  chev: 'M6 9l6 6 6-6',
  palette: 'M12 3a9 9 0 1 0 0 18c.9 0 1.5-.7 1.5-1.5 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.300-4-7.800-9-7.800zM7.500 12.500h.01M9 8h.01M14.500 7.500h.01M17.500 11h.01',
  alert: 'M12 4l9.500 16h-19zM12 10v4M12 17h.01',
};

export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'ic');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PATHS[name] || '');
  svg.append(p);
  return svg;
}

export const STATUS = { online: 'Online', idle: 'Abwesend', dnd: 'Nicht stören', invisible: 'Unsichtbar', offline: 'Offline' };

export function initials(name) {
  const parts = String(name || '?').trim().split(/[\s_.-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatar(user, size = 36, dot = false) {
  const el = h('span', { class: 'av', style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' } });
  if (user.avatar) el.append(h('img', { src: fileUrl(user.avatar), alt: '', loading: 'lazy', draggable: false }));
  else {
    el.style.background = user.color || '#5d726c';
    el.append(initials(user.display));
  }
  if (dot) el.append(h('i', { class: 'dot ' + (user.status || 'offline'), title: STATUS[user.status] || '' }));
  return el;
}

export function iconBtn(name, label, onclick, cls = '') {
  return h('button', { class: 'ib ' + cls, title: label, 'aria-label': label, onclick, type: 'button' }, icon(name));
}

// Entfernt ein Element mit einer Ausblend-Animation (Klasse .out im CSS). Sind Animationen aus,
// verschwindet es sofort – sonst bliebe es eingefroren stehen, bis die Zeit abgelaufen ist.
export function leave(el) {
  if (!el?.isConnected || el.classList.contains('out')) return;
  el.classList.add('out');
  const anim = getComputedStyle(el).animationName;
  if (!anim || anim === 'none') return el.remove();
  const done = () => el.remove();
  el.addEventListener('animationend', (e) => { if (e.target === el) done(); }, { once: true });
  setTimeout(done, 400); // falls animationend ausbleibt (z. B. Fenster im Hintergrund)
}

// Schieberegler, dessen Spur links vom Knopf in der Akzentfarbe gefüllt ist (CSS-Variable --p).
export function rangeInput(props) {
  const r = h('input', { type: 'range', ...props });
  const paint = () => {
    const min = Number(r.min) || 0;
    const max = r.max === '' ? 100 : Number(r.max);
    r.style.setProperty('--p', (max > min ? ((Number(r.value) - min) / (max - min)) * 100 : 0) + '%');
  };
  r.addEventListener('input', paint);
  r.paint = paint; // wer den Wert per Code ändert, ruft danach paint() auf
  paint();
  return r;
}

export function toast(text, kind = '') {
  const el = h('div', { class: 'toast ' + kind }, String(text));
  document.getElementById('toasts').append(el);
  setTimeout(() => leave(el), kind === 'bad' ? 6000 : 3500);
}
export const fail = (e) => toast(e?.message || String(e), 'bad');

const layer = () => document.getElementById('layer');
let popClose = null;

export function closePopover() {
  if (popClose) popClose();
}

export function popover(anchor, content, { align = 'start', side = 'bottom' } = {}) {
  closePopover();
  const el = h('div', { class: 'pop', role: 'dialog' }, content);
  el.style.animation = 'none'; // ohne die Einblend-Skalierung messen, sonst sitzt das Menü ein paar Pixel daneben
  layer().append(el);
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  el.style.animation = '';
  let x = align === 'end' ? a.right - r.width : a.left;
  let y = side === 'top' ? a.top - r.height - 6 : side === 'right' ? a.top : a.bottom + 6;
  if (side === 'right') x = a.right + 8;
  if (side === 'left') { x = a.left - r.width - 8; y = a.top; }
  if (y + r.height > innerHeight - 8) y = Math.max(8, innerHeight - r.height - 8);
  x = Math.max(8, Math.min(x, innerWidth - r.width - 8));
  el.style.left = x + 'px';
  el.style.top = Math.max(8, y) + 'px';
  // Das Menü wächst aus der Ecke, an der es hängt.
  el.style.transformOrigin = side === 'top' ? `${align === 'end' ? 'right' : 'left'} bottom`
    : side === 'right' ? 'left top' : side === 'left' ? 'right top' : `${align === 'end' ? 'right' : 'left'} top`;
  const away = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) close(); };
  const close = () => {
    leave(el);
    document.removeEventListener('mousedown', away, true);
    if (popClose === close) popClose = null;
  };
  popClose = close;
  setTimeout(() => document.addEventListener('mousedown', away, true));
  return close;
}

// Einträge: { label, icon, run, danger } oder '-' als Trennlinie.
export function menu(anchor, items, opts) {
  const list = items.filter(Boolean).filter((it, i, a) => it !== '-' || (i > 0 && i < a.length - 1 && a[i - 1] !== '-'));
  const close = popover(anchor, h('div', { class: 'menu', role: 'menu' }, list.map((it) => it === '-'
    ? h('hr')
    : h('button', { class: 'mi ' + (it.danger ? 'danger' : ''), type: 'button', role: 'menuitem', onclick: () => { close(); it.run(); } },
      it.icon && icon(it.icon, 18), h('span', null, it.label)))), opts);
  return close;
}

// Rechtsklick-Menü an der Mausposition.
export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  const x = e.clientX;
  const y = e.clientY;
  const at = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }), contains: () => false };
  return menu(at, items);
}

const modals = [];
export function closeModal() {
  modals[modals.length - 1]?.();
}
export function hasModal() { return modals.length > 0; }

export function modal(title, body, { wide = false, onClose } = {}) {
  closePopover();
  const prev = document.activeElement;
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', null, h('h2', null, title), iconBtn('x', 'Schließen', () => close())),
    h('div', { class: 'modal-body' }, body));
  const back = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  layer().append(back);
  const close = () => {
    const i = modals.indexOf(close);
    if (i < 0) return;
    modals.splice(i, 1);
    leave(back);
    onClose?.();
    prev?.focus?.();
  };
  modals.push(close);
  setTimeout(() => (box.querySelector('input,textarea,select') || box.querySelector('button.primary'))?.focus());
  return close;
}

export function ask(title, text, okLabel, danger = true) {
  return new Promise((resolve) => {
    let done = false;
    const close = modal(title, [
      h('p', { class: 'lead' }, text),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Abbrechen'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => { done = true; close(); } }, okLabel)),
    ], { onClose: () => resolve(done) });
  });
}

export function promptText(title, label, value = '', okLabel = 'Speichern', maxLength = 40) {
  return new Promise((resolve) => {
    let out = null;
    const input = h('input', { class: 'in', value, maxLength, autocomplete: 'off' });
    const close = modal(title, h('form', { onsubmit: (e) => { e.preventDefault(); out = input.value.trim(); close(); } },
      h('label', { class: 'field' }, h('span', null, label), input),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Abbrechen'),
        h('button', { class: 'btn primary' }, okLabel))), { onClose: () => resolve(out) });
    setTimeout(() => input.select());
  });
}

export const EMOJI = '😀 😁 😂 🤣 😊 😇 🙂 😉 😍 😘 😋 😜 🤪 🤔 🤨 😐 😴 🥱 😎 🤓 🥳 😏 😒 😔 😢 😭 😤 😡 🤬 🤯 😱 🥶 🥵 🤢 🤡 💀 👻 👽 🤖 💩 👍 👎 👏 🙌 🙏 🤝 💪 👀 🫡 🤷 🤦 ✌️ 🤞 🫶 ❤️ 🧡 💛 💚 💙 💜 🖤 💔 🔥 ✨ ⭐ 🎉 🎊 💯 ✅ ❌ ❓ ❗ 💤 💬 🎮 🕹️ 🎧 🎵 🍕 🍔 🍟 🍺 🍻 ☕ 🍰 ⚽ 🏆 🚀 💻 📱 💸 🐶 🐱 🐸 🦆 🌙 ☀️ 🌈'.split(' ');

export function emojiPicker(anchor, onPick, opts) {
  const close = popover(anchor, h('div', { class: 'emoji-grid' }, EMOJI.map((e) =>
    h('button', { type: 'button', onclick: () => { close(); onPick(e); } }, e))), opts);
}

// ---------- Töne (ohne Audiodateien) ----------
let actx = null;
let actxIdle = null;
function tone(freq, start, dur, vol = 0.07) {
  actx ||= new AudioContext();
  if (actx.state === 'suspended') actx.resume();
  // Ein offener AudioContext kostet dauerhaft Rechenzeit, auch wenn nichts zu hören ist – nach dem Ton wieder schließen.
  clearTimeout(actxIdle);
  actxIdle = setTimeout(() => {
    actx?.close().catch(() => {});
    actx = null;
  }, 3000);
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = 'sine';
  o.frequency.value = freq;
  const t = actx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
export const sound = {
  message() { try { tone(660, 0, 0.12); tone(880, 0.09, 0.18); } catch {} },
  join() { try { tone(520, 0, 0.1); tone(780, 0.1, 0.16); } catch {} },
  leave() { try { tone(780, 0, 0.1); tone(520, 0.1, 0.16); } catch {} },
  ring() { try { tone(740, 0, 0.25, 0.09); tone(932, 0.28, 0.25, 0.09); tone(740, 0.56, 0.3, 0.09); } catch {} },
};

// ---------- Zeit ----------
const tf = new Intl.DateTimeFormat('de', { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('de', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
export const clock = (ts) => tf.format(ts);
export const dayKey = (ts) => new Date(ts).toDateString();
export function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Heute';
  if (d.toDateString() === yest.toDateString()) return 'Gestern';
  return df.format(d);
}
export function size(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1).replace('.', ',') + ' MB';
}

// ---------- Nachrichtentext: sicheres Mini-Markdown (baut nur DOM-Knoten, nie HTML-Strings) ----------
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\*[^*\n]+?\*)|(~~[^~\n]+?~~)|(https?:\/\/[^\s<>"]+)|(@[a-z0-9_.]{2,20})/gi;

function inline(text, ctx, out) {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    const s = m[0];
    if (m[1]) out.append(h('code', null, s.slice(1, -1)));
    else if (m[2]) { const b = h('strong'); inline(s.slice(2, -2), ctx, b); out.append(b); }
    else if (m[3]) { const i = h('em'); inline(s.slice(1, -1), ctx, i); out.append(i); }
    else if (m[4]) { const d = h('s'); inline(s.slice(2, -2), ctx, d); out.append(d); }
    else if (m[5]) {
      const tail = s.match(/[.,!?;:)\]]+$/)?.[0] || '';
      const url = tail ? s.slice(0, -tail.length) : s;
      out.append(h('a', { href: url, onclick: (e) => { e.preventDefault(); ctx.open(url); } }, url), tail);
    } else if (m[6]) {
      const name = s.slice(1).replace(/\.+$/, '');
      if (ctx.isUser(name)) out.append(h('span', { class: 'mention' + (ctx.isMe(name) ? ' me' : '') }, '@' + name), s.slice(1 + name.length));
      else out.append(s);
    }
  }
  if (last < text.length) out.append(text.slice(last));
}

export function markdown(text, ctx) {
  const frag = document.createDocumentFragment();
  const parts = text.split(/```(?:\w*\n)?([\s\S]*?)```/);
  parts.forEach((part, i) => {
    if (i % 2) frag.append(h('pre', null, h('code', null, part.replace(/\n$/, ''))));
    else if (part) inline(part, ctx, frag);
  });
  return frag;
}
