import { net, isApp, invoke, api, upload, fileUrl, req, connect, disconnect, setToken, setServer } from './net.js';
import {
  h, icon, iconBtn, avatar, initials, toast, fail, popover, closePopover, menu, contextMenu, modal, closeModal, hasModal, ask, promptText,
  emojiPicker, sound, clock, dayKey, dayLabel, size, markdown, STATUS, leave as fadeOut, rangeInput,
} from './ui.js';
import { DOWNLOAD_URL } from './config.js';
import * as fun from './fun.js';
import {
  voice, join, leave, onRtc, onList, toggleMute, toggleDeaf, toggleScreen, setOutput, reloadMic, applyAudio, micTest, testing, micLevel, micError,
} from './voice.js';

const root = document.getElementById('root');
const E = {}; // feste Elemente der Oberfläche
const S = {
  me: null,
  users: new Map(),
  friends: new Map(), // userId -> 'friends' | 'incoming' | 'outgoing'
  dms: new Map(),
  groups: new Map(),
  reads: new Map(), // chatId -> { last, unread }
  voice: new Map(), // chatId -> Teilnehmerliste
  cache: new Map(), // chatId -> { list, done, loading }
  typing: new Map(), // chatId -> Map(userId -> timer)
  opened: new Set(),
  lastChannel: new Map(),
  view: { page: 'friends', group: null, chat: null },
  friendTab: 'online',
  reply: null,
  pending: [],
  stick: true,
  showMembers: localStorage.getItem('pc_members') !== '0',
  built: false,
};

// Darstellung kommt aus js/look.js (läuft vor allem anderen, damit nichts aufblitzt).
const LOOK = window.PCLook || { THEMES: [], ACCENTS: [], DEFAULTS: {}, apply() {} };
const prefs = Object.assign({
  groupNotify: 'all', sound: true, mic: '', out: '', ns: true, ec: true, agc: true, inVol: 1, outVol: 1, vadAuto: true, vadTh: -50, vadSet: false, fps: 30, vol: {},
  ...LOOK.DEFAULTS,
}, JSON.parse(localStorage.getItem('pc_prefs') || '{}'));
const savePrefs = () => localStorage.setItem('pc_prefs', JSON.stringify(prefs));
const applyLook = () => LOOK.apply(prefs);
voice.settings = () => prefs;
voice.volumeOf = (cid) => {
  const p = (S.voice.get(voice.chat) || []).find((x) => x.cid === cid);
  const master = Math.min(1, Math.max(0, prefs.outVol ?? 1));
  return master * (p ? Math.min(1, Math.max(0, prefs.vol[p.uid] ?? 1)) : 1);
};

const openUrl = (url) => {
  if (!/^https?:\/\//i.test(url)) return;
  if (isApp) invoke('open_url', { url }).catch(fail);
  else window.open(url, '_blank', 'noopener');
};

const U = (id) => S.users.get(id) || { id, username: 'unbekannt', display: 'Unbekannt', color: '#5d726c', status: 'offline', custom: '' };
const rd = (id) => {
  let r = S.reads.get(id);
  if (!r) S.reads.set(id, (r = { last: 0, unread: 0 }));
  return r;
};
// Gelöschte Konten heißen intern "~Nummer" und haben keinen sichtbaren Benutzernamen mehr.
const isGone = (u) => String(u.username).startsWith("~");
const handle = (u) => (isGone(u) ? "" : "@" + u.username);
function mergeUsers(list) {
  for (const u of list || []) {
    S.users.set(u.id, u);
    if (S.me && u.id === S.me.id) Object.assign(S.me, u, { status: S.me.status });
  }
}
function chatMeta(id) {
  const dm = S.dms.get(id);
  if (dm) return { type: 'dm', id, user: U(dm.user), name: U(dm.user).display };
  for (const g of S.groups.values()) {
    const c = g.channels.find((x) => x.id === id);
    if (c) return { type: 'channel', id, group: g, channel: c, name: c.name, kind: c.kind };
  }
  return null;
}
const mdCtx = {
  open: openUrl,
  isUser: (name) => [...S.users.values()].some((u) => u.username === name.toLowerCase()),
  isMe: (name) => S.me.username === name.toLowerCase(),
};
const mentionsMe = (m) =>
  m.user !== S.me.id && (m.reply?.user === S.me.id || new RegExp('@' + S.me.username.replace(/\./g, '\\.') + '(?![a-z0-9_])', 'i').test(m.content));

// ======================================================================
// Anmeldung
// ======================================================================
// Logo: fünfmal draufklicken ergibt eine Überraschung.
function logo(px = 44) {
  let n = 0;
  const img = h('img', { src: 'icon.svg', alt: '', width: px, height: px, onclick: () => {
    img.classList.remove('spin');
    void img.offsetWidth;
    img.classList.add('spin');
    if (++n >= 5) { n = 0; fun.confetti({ count: 200 }); toast('Du hast das Geheimnis gefunden. Es gibt keins. 🎉'); }
  } });
  return img;
}

async function showAuth(note) {
  S.built = false;
  setUnread(0);
  let mode = 'login';
  let needCode = false;
  const err = h('p', { class: 'form-err' + (note ? ' info' : ''), role: 'alert' }, note || ''); // Hinweise neutral, Fehler rot
  const user = h('input', { class: 'in', autocomplete: 'username', maxLength: 20, required: true, spellcheck: false });
  const display = h('input', { class: 'in', maxLength: 32, placeholder: 'So sehen dich die anderen' });
  const pass = h('input', { class: 'in', type: 'password', autocomplete: 'current-password', required: true });
  const code = h('input', { class: 'in', autocomplete: 'off' });
  const server = h('input', { class: 'in', value: net.server, spellcheck: false });
  const submit = h('button', { class: 'btn primary big' });
  const swap = h('button', { class: 'link', type: 'button', onclick: () => { mode = mode === 'login' ? 'register' : 'login'; paint(); } });
  const title = h('h1');
  const fDisplay = h('label', { class: 'field' }, h('span', null, 'Anzeigename'), display);
  const fCode = h('label', { class: 'field' }, h('span', null, 'Zugangscode'), code);
  const form = h('form', {
    class: 'auth-card',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      err.className = 'form-err';
      submit.disabled = true;
      try {
        setServer(server.value);
        const body = { username: user.value.trim(), password: pass.value, display: display.value.trim(), code: code.value.trim() };
        const res = await api(mode === 'login' ? '/api/login' : '/api/register', body);
        setToken(res.token);
        if (!isApp && window.Notification?.permission === 'default') Notification.requestPermission();
        start();
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
    h('div', { class: 'brand' }, logo(), h('span', null, 'PeterCord')),
    h('p', { class: 'tagline' }, fun.tagline()),
    title,
    h('label', { class: 'field' }, h('span', null, 'Benutzername'), user),
    fDisplay,
    h('label', { class: 'field' }, h('span', null, 'Passwort'), pass),
    fCode, err, submit, swap,
    h('details', { class: 'adv' }, h('summary', null, 'Anderen Server verwenden'),
      h('label', { class: 'field' }, h('span', null, 'Server-Adresse'), server)),
    !isApp && h('a', { class: 'link dl', href: DOWNLOAD_URL, target: '_blank', rel: 'noopener' }, 'PeterCord für Windows herunterladen'));
  function paint() {
    const reg = mode === 'register';
    title.textContent = reg ? 'Konto erstellen' : 'Schön, dass du da bist';
    submit.textContent = reg ? 'Konto erstellen' : 'Anmelden';
    swap.textContent = reg ? 'Ich habe schon ein Konto' : 'Neu hier? Konto erstellen';
    fDisplay.hidden = !reg;
    fCode.hidden = !(reg && needCode);
    pass.autocomplete = reg ? 'new-password' : 'current-password';
  }
  paint();
  root.replaceChildren(h('div', { class: 'auth' }, form, h('div', { class: 'sticker' }, '📸 Beweisfoto Nr. 1')));
  user.focus();
  api('/api/info').then((i) => { needCode = !!i.code; paint(); }).catch(() => {});
}

async function logout() {
  await leave();
  api('/api/logout', {}).catch(() => {});
  disconnect();
  setToken('');
  S.cache.clear();
  S.view = { page: 'friends', group: null, chat: null };
  showAuth();
}

// ======================================================================
// Grundgerüst
// ======================================================================
function buildShell() {
  S.built = true;
  E.rail = h('nav', { class: 'rail', 'aria-label': 'Gruppen' });
  E.sideTop = h('div', { class: 'side-scroll' });
  E.voicePanel = h('div', { class: 'voice-panel' });
  E.userPanel = h('div', { class: 'user-panel' });
  E.side = h('aside', { class: 'side' }, E.sideTop, E.voicePanel, E.userPanel);
  E.head = h('header', { class: 'head' });
  E.stage = h('div', { class: 'stage', hidden: true });
  E.callbar = h('div', { class: 'callbar', hidden: true });
  E.body = h('div', { class: 'body' });
  E.main = h('main', { class: 'main' }, E.head, E.stage, E.callbar, E.body);
  E.members = h('aside', { class: 'members' });
  E.bar = h('div', { class: 'statusbar', hidden: true });
  root.replaceChildren(E.bar, h('div', { class: 'shell' }, E.rail, E.side, E.main, E.members));
  E.main.addEventListener('dragover', (e) => { if (S.view.page === 'chat') e.preventDefault(); });
  E.main.addEventListener('drop', (e) => {
    if (S.view.page !== 'chat' || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
}

let refreshTimer = null;
function schedule() {
  if (refreshTimer || !S.built) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; refresh(); }, 30);
}
function refresh() {
  if (!S.built) return;
  renderRail();
  renderSide();
  renderHead();
  renderMembers();
  renderCall();
  if (S.view.page === 'friends') renderFriendList();
  const n = [...S.reads.entries()].reduce((a, [id, r]) => a + (chatMeta(id) ? r.unread : 0), 0);
  document.title = (n ? `(${n}) ` : '') + 'PeterCord';
  setUnread(n);
}

// Roter Punkt am Tray-Symbol und in der Taskleiste (nur Desktop-App).
let shownUnread = 0;
function setUnread(n) {
  if (!isApp || n === shownUnread) return;
  shownUnread = n;
  invoke('set_unread', { count: n }).catch(() => {});
}

function renderBar() {
  if (!S.built) return;
  E.bar.hidden = net.online;
  E.bar.textContent = 'Keine Verbindung zum Server. PeterCord versucht es weiter …';
}

// ---------- Leiste links ----------
function badge(n) { return n > 0 ? h('b', { class: 'badge' }, n > 99 ? '99+' : String(n)) : null; }

function renderRail() {
  const incoming = [...S.friends.values()].filter((s) => s === 'incoming').length;
  const dmUnread = [...S.dms.keys()].reduce((a, id) => a + rd(id).unread, 0);
  const tiles = [...S.groups.values()].map((g) => {
    const unread = g.channels.some((c) => rd(c.id).unread > 0);
    const live = g.channels.some((c) => S.voice.get(c.id)?.length);
    return h('button', {
      class: 'tile' + (S.view.group === g.id ? ' on' : '') + (unread ? ' unread' : ''), title: g.name, 'aria-label': g.name,
      onclick: () => selectGroup(g.id),
      oncontextmenu: (e) => contextMenu(e, groupItems(g)),
    }, g.icon ? h('img', { src: fileUrl(g.icon), alt: '', draggable: false }) : initials(g.name), live && h('i', { class: 'live' }));
  });
  E.rail.replaceChildren(
    h('button', { class: 'tile home' + (S.view.group == null ? ' on' : ''), title: 'Freunde und Direktnachrichten', 'aria-label': 'Start', onclick: goHome },
      h('img', { src: 'icon.svg', alt: '', draggable: false }), badge(incoming + dmUnread)),
    h('hr'),
    ...tiles,
    h('button', { class: 'tile add', title: 'Gruppe erstellen oder beitreten', 'aria-label': 'Gruppe hinzufügen', onclick: groupDialog }, icon('plus', 22)));
}

// ---------- Seitenleiste ----------
function voiceRows(chatId) {
  return (S.voice.get(chatId) || []).map((p) => {
    const u = U(p.uid);
    const row = h('button', { class: 'vrow' + (voice.speaking.has(p.cid) ? ' talk' : ''), type: 'button', data: { cid: p.cid }, onclick: () => userCard(u, row, null, 'right') },
      avatar(u, 22), h('span', { class: 'grow cut' }, u.display),
      p.screen && icon('screen', 15), p.deaf ? icon('headOff', 15) : p.muted ? icon('micOff', 15) : null);
    return row;
  });
}

function renderSide() {
  const v = S.view;
  const out = [];
  if (v.group == null) {
    const incoming = [...S.friends.values()].filter((s) => s === 'incoming').length;
    out.push(
      h('div', { class: 'side-head' }, h('span', { class: 'wordmark' }, 'PeterCord')),
      h('button', { class: 'row-btn' + (v.page === 'friends' ? ' on' : ''), onclick: goHome }, icon('users'), h('span', { class: 'grow' }, 'Freunde'), badge(incoming)),
      h('h3', null, 'Direktnachrichten'));
    const dms = [...S.dms.values()]
      .filter((d) => rd(d.id).last > 0 || S.opened.has(d.id) || d.id === v.chat || S.voice.get(d.id)?.length)
      .sort((a, b) => rd(b.id).last - rd(a.id).last);
    if (!dms.length) out.push(h('p', { class: 'hint' }, 'Noch keine Unterhaltungen. Füge unter „Freunde“ jemanden hinzu und schreib los.'));
    for (const d of dms) {
      const u = U(d.user);
      out.push(h('button', { class: 'row-btn dm' + (v.chat === d.id ? ' on' : '') + (rd(d.id).unread ? ' unread' : ''), onclick: () => openChat(d.id),
        oncontextmenu: (e) => contextMenu(e, dmItems(d, u)) },
        avatar(u, 32, true),
        h('span', { class: 'grow cut2' }, h('span', { class: 'cut' }, u.display), u.custom && h('small', { class: 'cut' }, u.custom)),
        S.voice.get(d.id)?.length ? icon('phone', 16) : null, badge(rd(d.id).unread)));
    }
  } else {
    const g = S.groups.get(v.group);
    if (!g) return;
    const owner = g.owner === S.me.id;
    const headBtn = h('button', { class: 'side-head as-btn', onclick: () => groupMenu(g, headBtn), oncontextmenu: (e) => contextMenu(e, groupItems(g)) }, h('span', { class: 'grow cut' }, g.name), icon('chev', 18));
    out.push(headBtn);
    const section = (title, kind) => h('h3', null, title, owner && iconBtn('plus', 'Kanal erstellen', () => channelDialog(g, kind), 'tiny'));
    out.push(section('Textkanäle', 'text'));
    for (const c of g.channels.filter((x) => x.kind === 'text')) {
      const row = h('button', { class: 'row-btn chan' + (v.chat === c.id ? ' on' : '') + (rd(c.id).unread ? ' unread' : ''), onclick: () => openChat(c.id),
        oncontextmenu: (e) => contextMenu(e, channelItems(g, c)) },
        icon('hash', 18), h('span', { class: 'grow cut' }, c.name), badge(rd(c.id).unread),
        owner && h('span', { class: 'ib tiny hover', title: 'Kanal bearbeiten', onclick: (e) => { e.stopPropagation(); channelEdit(g, c); } }, icon('edit', 15)));
      out.push(row);
    }
    out.push(section('Sprachkanäle', 'voice'));
    for (const c of g.channels.filter((x) => x.kind === 'voice')) {
      out.push(h('button', { class: 'row-btn chan' + (voice.chat === c.id ? ' on' : ''), title: 'Sprachkanal betreten', onclick: () => joinVoice(c.id),
        oncontextmenu: (e) => contextMenu(e, channelItems(g, c)) },
        icon('volume', 18), h('span', { class: 'grow cut' }, c.name),
        owner && h('span', { class: 'ib tiny hover', title: 'Kanal bearbeiten', onclick: (e) => { e.stopPropagation(); channelEdit(g, c); } }, icon('edit', 15))),
        h('div', { class: 'vlist' }, voiceRows(c.id)));
    }
  }
  const top = E.sideTop.scrollTop;
  E.sideTop.replaceChildren(...out);
  E.sideTop.scrollTop = top;

  // Sprach-Leiste
  if (voice.chat) {
    const meta = chatMeta(voice.chat);
    E.voicePanel.hidden = false;
    E.voicePanel.replaceChildren(
      h('div', { class: 'grow cut2' }, h('strong', null, 'Sprache verbunden'),
        h('small', { class: 'cut' }, meta ? (meta.type === 'dm' ? 'Anruf mit ' + meta.name : meta.group.name + ' / ' + meta.name) : '')),
      iconBtn('screen', voice.screen ? 'Bildschirm nicht mehr teilen' : 'Bildschirm teilen', () => toggleScreen(), voice.screen ? 'active' : ''),
      iconBtn('hang', 'Auflegen', hangUp, 'danger'));
  } else {
    E.voicePanel.hidden = true;
  }

  const meBtn = h('button', { class: 'me-btn', title: 'Status ändern', onclick: () => statusMenu(meBtn) },
    avatar({ ...S.me, status: S.me.status }, 34, true),
    h('span', { class: 'grow cut2' }, h('span', { class: 'cut' }, S.me.display), h('small', { class: 'cut' }, S.me.custom || STATUS[S.me.status])));
  E.userPanel.replaceChildren(meBtn,
    audioBtn(iconBtn(voice.muted || voice.deaf ? 'micOff' : 'mic', (voice.muted ? 'Mikrofon einschalten' : 'Mikrofon stummschalten') + ' (Rechtsklick: Sprach-Einstellungen)', toggleMute, voice.muted || voice.deaf ? 'off' : '')),
    audioBtn(iconBtn(voice.deaf ? 'headOff' : 'head', (voice.deaf ? 'Ton einschalten' : 'Ton ausschalten') + ' (Rechtsklick: Sprach-Einstellungen)', toggleDeaf, voice.deaf ? 'off' : '')),
    iconBtn('gear', 'Einstellungen', () => settingsDialog()));
}

// Rechtsklick auf Mikrofon oder Kopfhörer öffnet direkt die Sprach-Einstellungen.
function audioBtn(el) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); settingsDialog('voice'); });
  return el;
}

function statusMenu(anchor) {
  menu(anchor, ['online', 'idle', 'dnd', 'invisible'].map((s) => ({
    label: STATUS[s] + (S.me.status === s ? '  ✓' : ''),
    run: () => req('profile.update', { status: s }).catch(fail),
  })).concat([{ label: 'Status-Text ändern', icon: 'edit', run: async () => {
    const t = await promptText('Status-Text', 'Was machst du gerade?', S.me.custom, 'Speichern', 80);
    if (t != null) req('profile.update', { custom: t }).catch(fail);
  } }]), { side: 'top' });
}

// ---------- Kopfzeile ----------
function renderHead() {
  const v = S.view;
  const burger = iconBtn('menu', 'Navigation', () => document.body.classList.toggle('nav'), 'burger');
  if (v.page === 'friends') {
    E.head.replaceChildren(burger, icon('users'), h('h2', null, 'Freunde'));
    return;
  }
  const meta = chatMeta(v.chat);
  if (!meta) return;
  if (meta.type === 'dm') {
    const inCall = voice.chat === v.chat;
    E.head.replaceChildren(burger, avatar(meta.user, 28, true),
      h('h2', { class: 'cut' }, meta.user.display), h('span', { class: 'sub cut' }, meta.user.custom || handle(meta.user)),
      h('span', { class: 'grow' }),
      iconBtn(inCall ? 'hang' : 'phone', inCall ? 'Auflegen' : 'Anrufen', () => (inCall ? hangUp() : joinVoice(v.chat)), inCall ? 'danger' : ''));
  } else {
    E.head.replaceChildren(burger, icon('hash'), h('h2', { class: 'cut' }, meta.name), h('span', { class: 'grow' }),
      iconBtn('users', 'Mitglieder ein- oder ausblenden', () => {
        S.showMembers = !S.showMembers;
        localStorage.setItem('pc_members', S.showMembers ? '1' : '0');
        renderMembers();
      }, S.showMembers ? 'active' : ''));
  }
}

// ---------- Mitglieder ----------
function renderMembers() {
  const g = S.view.group != null && S.groups.get(S.view.group);
  E.members.hidden = !g || !S.showMembers;
  if (E.members.hidden) return;
  const users = g.members.map(U).sort((a, b) => a.display.localeCompare(b.display, 'de'));
  const on = users.filter((u) => u.status !== 'offline');
  const off = users.filter((u) => u.status === 'offline');
  const row = (u) => {
    const el = h('button', { class: 'row-btn member' + (u.status === 'offline' ? ' off' : ''), onclick: () => userCard(u, el, g), oncontextmenu: (e) => { e.preventDefault(); userCard(u, el, g); } },
      avatar(u, 32, true),
      h('span', { class: 'grow cut2' }, h('span', { class: 'cut', style: { color: u.status === 'offline' ? '' : u.color } }, u.display), u.custom && h('small', { class: 'cut' }, u.custom)),
      g.owner === u.id && h('span', { class: 'crown', title: 'Besitzer der Gruppe' }, '♛'));
    return el;
  };
  E.members.replaceChildren(...[
    on.length ? h('h3', null, `Online (${on.length})`) : null, ...on.map(row),
    off.length ? h('h3', null, `Offline (${off.length})`) : null, ...off.map(row)].filter(Boolean));
}

function userCard(u, anchor, group, side = 'left') {
  const state = S.friends.get(u.id);
  const self = u.id === S.me.id;
  const inMyCall = !self && voice.chat && (S.voice.get(voice.chat) || []).some((x) => x.uid === u.id);
  const act = (label, cls, run) => h('button', { class: 'btn ' + cls, type: 'button', onclick: () => { closePopover(); run(); } }, label);
  popover(anchor, h('div', { class: 'card' },
    h('div', { class: 'card-top', style: { background: u.color } }),
    avatar(u, 72, true),
    h('strong', { class: 'card-name' }, u.display),
    h('span', { class: 'sub' }, handle(u)),
    u.custom && h('p', null, u.custom),
    inMyCall && h('label', { class: 'field vol' }, h('span', null, 'Lautstärke im Sprachchat'),
      rangeInput({ min: 0, max: 100, step: 5, value: Math.round((prefs.vol[u.id] ?? 1) * 100), oninput: (e) => {
        prefs.vol[u.id] = e.target.value / 100;
        savePrefs();
        applyVolumes();
      } })),
    !self && !isGone(u) && h('div', { class: 'col' },
      act('Nachricht schreiben', 'primary', () => openDm(u.id)),
      !state && act('Als Freund hinzufügen', '', () => req('friend.add', { username: u.username }).then(() => toast('Anfrage an ' + u.display + ' gesendet')).catch(fail)),
      state === 'incoming' && act('Freundschaftsanfrage annehmen', '', () => req('friend.accept', { user: u.id }).catch(fail)),
      state === 'outgoing' && h('span', { class: 'sub' }, 'Freundschaftsanfrage gesendet'),
      group && group.owner === S.me.id && act('Aus der Gruppe entfernen', 'danger', async () => {
        if (await ask('Mitglied entfernen', `${u.display} aus „${group.name}“ entfernen?`, 'Entfernen')) req('group.kick', { group: group.id, user: u.id }).catch(fail);
      }))), { side });
}

// ======================================================================
// Navigation
// ======================================================================
function trimCache(id) {
  const c = S.cache.get(id);
  if (c && c.list.length > 100) { c.list = c.list.slice(-100); c.done = false; }
}

function goHome() {
  trimCache(S.view.chat);
  S.view = { page: 'friends', group: null, chat: null };
  document.body.classList.remove('nav');
  renderMain();
  refresh();
}

function selectGroup(id) {
  const g = S.groups.get(id);
  if (!g) return goHome();
  S.view.group = id;
  const last = S.lastChannel.get(id);
  const chan = g.channels.find((c) => c.id === last && c.kind === 'text') || g.channels.find((c) => c.kind === 'text');
  if (chan) return openChat(chan.id);
  S.view.page = 'empty';
  S.view.chat = null;
  renderMain();
  refresh();
}

async function openDm(userId) {
  try {
    const r = await req('dm.open', { user: userId });
    mergeUsers(r.users);
    S.dms.set(r.dm.id, r.dm);
    S.opened.add(r.dm.id);
    openChat(r.dm.id);
  } catch (e) { fail(e); }
}

async function openChat(id) {
  const meta = chatMeta(id);
  if (!meta) return goHome();
  if (S.view.chat !== id) trimCache(S.view.chat);
  S.view = { page: 'chat', chat: id, group: meta.type === 'dm' ? null : meta.group.id };
  if (meta.type === 'channel') S.lastChannel.set(meta.group.id, id);
  S.reply = null;
  S.pending = [];
  S.stick = true;
  document.body.classList.remove('nav');
  renderMain();
  refresh();
  if (!S.cache.has(id)) {
    const loading = loadHistory(id);
    renderMessages();
    await loading;
  }
  if (S.view.chat !== id || S.view.page !== 'chat') return;
  renderMessages();
  toBottom();
  markRead();
  E.input?.focus();
}

// Lädt die neuesten Nachrichten eines Chats. Was währenddessen eintrifft, wird nachgetragen.
async function loadHistory(id) {
  const c = { list: [], done: false, loading: true, older: false, late: [] };
  S.cache.set(id, c);
  try {
    const r = await req('msg.history', { chat: id });
    mergeUsers(r.users);
    c.list = r.msgs;
    c.done = r.done;
    for (const m of c.late) if (!c.list.some((x) => x.id === m.id)) c.list.push(m);
  } catch (e) {
    if (S.cache.get(id) === c) S.cache.delete(id);
    fail(e);
  }
  c.loading = false;
  c.late = [];
}

function markRead() {
  const id = S.view.chat;
  if (S.view.page !== 'chat' || !id || !document.hasFocus() || !S.stick) return;
  const r = rd(id);
  if (!r.unread) return;
  r.unread = 0;
  req('read', { chat: id }).catch(() => {});
  schedule();
}

function markChatRead(id) {
  const r = rd(id);
  if (!r.unread) return;
  r.unread = 0;
  req('read', { chat: id }).catch(() => {});
  schedule();
}

// ======================================================================
// Hauptbereich
// ======================================================================
function renderMain() {
  const v = S.view;
  E.main.classList.toggle('chatting', v.page === 'chat');
  if (v.page === 'friends') return renderFriends();
  if (v.page === 'empty') {
    E.body.replaceChildren(h('div', { class: 'empty' }, h('h2', null, 'Hier gibt es noch keinen Textkanal'), h('p', null, 'Der Besitzer der Gruppe kann links einen Kanal erstellen.')));
    return;
  }
  const meta = chatMeta(v.chat);
  E.list = h('div', { class: 'msgs', onscroll: onScroll, onmouseover: onHover, onmouseleave: () => E.tools?.remove() });
  E.typing = h('div', { class: 'typing' });
  E.replyBar = h('div', { class: 'replybar', hidden: true });
  E.files = h('div', { class: 'pending', hidden: true });
  E.input = h('textarea', {
    class: 'input', rows: 1, maxLength: 4000,
    placeholder: fun.placeholder(meta.type === 'dm' ? `Nachricht an ${meta.name}` : `Nachricht in #${meta.name}`),
    oninput: () => { grow(); sendTyping(); },
    onkeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      else if (e.key === 'Escape' && S.reply) { S.reply = null; renderReply(); }
      else if (e.key === 'ArrowUp' && !E.input.value) {
        const mine = S.cache.get(S.view.chat)?.list.findLast((m) => m.user === S.me.id);
        if (mine) { e.preventDefault(); editMsg(mine); }
      }
    },
    onpaste: (e) => { if (e.clipboardData?.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } },
  });
  const picker = h('input', { type: 'file', multiple: true, hidden: true, onchange: () => { addFiles(picker.files); picker.value = ''; } });
  const emojiBtn = iconBtn('smile', 'Emoji einfügen', () => emojiPicker(emojiBtn, insertText, { side: 'top', align: 'end' }));
  E.body.replaceChildren(E.list, E.typing,
    h('div', { class: 'composer' }, E.replyBar, E.files,
      h('div', { class: 'compose-row' }, picker, iconBtn('clip', 'Datei anhängen (bis 10 MB)', () => picker.click()), E.input, emojiBtn,
        iconBtn('send', 'Senden', send, 'send'))));
  renderMessages();
}

function grow() {
  E.input.style.height = 'auto';
  E.input.style.height = Math.min(E.input.scrollHeight, 220) + 'px';
}
function insertText(t) {
  const el = E.input;
  el.setRangeText(t, el.selectionStart, el.selectionEnd, 'end');
  el.focus();
  grow();
}

let lastTyping = 0;
function sendTyping() {
  if (Date.now() - lastTyping < 3000 || !E.input.value) return;
  lastTyping = Date.now();
  req('typing', { chat: S.view.chat }).catch(() => {});
}
function renderTyping() {
  if (S.view.page !== 'chat' || !E.typing) return;
  const names = [...(S.typing.get(S.view.chat)?.keys() || [])].map((id) => U(id).display);
  E.typing.textContent = !names.length ? '' : names.length === 1 ? `${names[0]} schreibt …` : names.length === 2 ? `${names[0]} und ${names[1]} schreiben …` : 'Mehrere Leute schreiben …';
}

function addFiles(fileList) {
  for (const file of fileList) {
    if (S.pending.length >= 10) { toast('Mehr als 10 Anhänge pro Nachricht gehen nicht.', 'bad'); break; }
    if (file.size > 10 * 1024 * 1024) { toast(`„${file.name}“ ist größer als 10 MB.`, 'bad'); continue; }
    S.pending.push(file);
  }
  renderPending();
  E.input?.focus();
}
function renderPending() {
  E.files.hidden = !S.pending.length;
  E.files.replaceChildren(...S.pending.map((f, i) => h('span', { class: 'chip' }, icon('clip', 14), h('span', { class: 'cut' }, f.name || 'Bild'),
    h('small', null, size(f.size)), iconBtn('x', 'Anhang entfernen', () => { S.pending.splice(i, 1); renderPending(); }, 'tiny'))));
}
function renderReply() {
  E.replyBar.hidden = !S.reply;
  if (!S.reply) return;
  E.replyBar.replaceChildren(icon('reply', 16), h('span', { class: 'grow cut' }, 'Antwort an ', h('strong', null, U(S.reply.user).display)),
    iconBtn('x', 'Antwort abbrechen', () => { S.reply = null; renderReply(); }, 'tiny'));
}

let sending = false;
async function send() {
  const chat = S.view.chat;
  let text = E.input.value.trim();
  text = fun.slash(text) ?? text;
  const files = S.pending;
  if (sending || (!text && !files.length)) return;
  sending = true;
  const reply = S.reply;
  E.input.value = '';
  grow();
  S.pending = [];
  S.reply = null;
  renderPending();
  renderReply();
  try {
    const ids = [];
    if (files.length) E.typing.textContent = 'Anhänge werden hochgeladen …';
    for (const f of files) ids.push((await upload(f, f.name || 'bild.png')).id);
    await req('msg.send', { chat, content: text, files: ids, reply: reply?.id });
    lastTyping = 0;
  } catch (e) {
    fail(e);
    if (S.view.chat === chat) {
      if (!E.input.value) E.input.value = text;
      S.pending = files;
      S.reply = reply;
      renderPending();
      renderReply();
      grow();
    }
  }
  sending = false;
  renderTyping();
}

// ---------- Nachrichtenliste ----------
function toBottom() { if (E.list) E.list.scrollTop = E.list.scrollHeight; }
function onScroll() {
  const el = E.list;
  S.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  if (S.stick) markRead();
  if (el.scrollTop < 200) loadOlder();
}
async function loadOlder() {
  const id = S.view.chat;
  const c = S.cache.get(id);
  if (!c || c.done || c.loading || c.older || !c.list.length) return;
  c.older = true;
  try {
    const r = await req('msg.history', { chat: id, before: c.list[0].id });
    mergeUsers(r.users);
    c.list = [...r.msgs, ...c.list];
    c.done = r.done;
    if (S.view.chat === id) {
      const before = E.list.scrollHeight - E.list.scrollTop;
      renderMessages();
      E.list.scrollTop = E.list.scrollHeight - before;
    }
  } catch {}
  c.older = false;
}

function fileEl(f) {
  const url = fileUrl(f.id);
  const keep = () => { if (S.stick) toBottom(); };
  if (/^image\/(png|jpeg|gif|webp|avif)/.test(f.type)) return h('img', { class: 'shot', src: url, alt: f.name, loading: 'lazy', onload: keep, onclick: () => lightbox(url, f) });
  if (f.type.startsWith('video/')) return h('video', { class: 'shot', src: url, controls: true, preload: 'metadata', onloadedmetadata: keep });
  if (f.type.startsWith('audio/')) return h('audio', { src: url, controls: true, preload: 'none' });
  return h('button', { class: 'file', type: 'button', title: 'Herunterladen', onclick: () => openUrl(url) }, icon('down', 22),
    h('span', { class: 'cut2' }, h('b', { class: 'cut' }, f.name), h('small', null, size(f.size))));
}

function lightbox(url, f) {
  modal(f.name, [h('img', { class: 'full', src: url, alt: f.name }),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', onclick: () => openUrl(url) }, 'Im Browser öffnen'))], { wide: true });
}

function msgEl(m, prev) {
  const u = U(m.user);
  const head = !prev || prev.user !== m.user || m.created - prev.created > 300000 || !!m.reply || dayKey(prev.created) !== dayKey(m.created);
  const el = h('div', { class: 'msg' + (head ? ' first' : '') + (mentionsMe(m) ? ' hit' : ''), data: { id: m.id } });
  if (m.reply) {
    el.append(h('button', { class: 'reply-ref', type: 'button', onclick: () => jumpTo(m.reply.id) }, icon('reply', 14),
      m.reply.gone ? h('em', null, 'Nachricht wurde gelöscht') : [h('strong', null, U(m.reply.user).display), h('span', { class: 'cut' }, m.reply.content)]));
  }
  if (head) {
    const av = h('button', { class: 'msg-av', type: 'button', 'aria-label': 'Profil von ' + u.display, onclick: () => userCard(U(m.user), av, null, 'right') }, avatar(u, 38));
    el.append(av, h('div', { class: 'msg-meta' }, h('span', { class: 'author', style: { color: u.color } }, u.display), h('time', null, clock(m.created))));
  } else {
    el.append(h('time', { class: 'gutter' }, clock(m.created)));
  }
  if (m.content) el.append(h('div', { class: 'content' }, markdown(m.content, mdCtx), m.edited && h('span', { class: 'edited' }, ' (bearbeitet)')));
  if (m.files.length) el.append(h('div', { class: 'attach' }, m.files.map(fileEl)));
  if (m.reactions.length) {
    el.append(h('div', { class: 'reacts' }, m.reactions.map((r) => h('button', {
      class: 'react' + (r.users.includes(S.me.id) ? ' mine' : ''), type: 'button', title: r.users.map((id) => U(id).display).join(', '),
      onclick: () => req('react', { id: m.id, emoji: r.emoji }).catch(fail),
    }, r.emoji, h('b', null, String(r.users.length))))));
  }
  return el;
}

function renderMessages() {
  if (S.view.page !== 'chat' || !E.list) return;
  const c = S.cache.get(S.view.chat);
  const meta = chatMeta(S.view.chat);
  const out = [];
  if (!c) {
    out.push(h('div', { class: 'hint center' }, h('p', null, 'Die Nachrichten konnten nicht geladen werden.'),
      h('button', { class: 'btn', type: 'button', onclick: () => openChat(S.view.chat) }, 'Erneut versuchen')));
  } else if (c.loading) out.push(h('p', { class: 'hint center' }, 'Nachrichten werden geladen …'));
  else {
    if (c.done) {
      out.push(h('div', { class: 'intro' },
        h('h2', null, meta.type === 'dm' ? meta.name : '#' + meta.name),
        h('p', null, meta.type === 'dm' ? fun.dmStart(meta.name, !c.list.length) : fun.channelStart(meta.name, !c.list.length))));
    }
    let prev = null;
    for (const m of c.list) {
      if (!prev || dayKey(prev.created) !== dayKey(m.created)) out.push(h('div', { class: 'day' }, h('span', null, dayLabel(m.created))));
      out.push(msgEl(m, prev));
      prev = m;
    }
  }
  E.tools?.remove();
  E.list.replaceChildren(...out);
}

function replaceMsg(m) {
  const c = S.cache.get(m.chat);
  const old = E.list?.querySelector(`.msg[data-id="${m.id}"]`);
  if (!c || !old || S.view.chat !== m.chat) return;
  const stick = S.stick;
  old.replaceWith(msgEl(m, c.list[c.list.indexOf(m) - 1]));
  if (stick) toBottom();
}

function jumpTo(id) {
  const el = E.list.querySelector(`.msg[data-id="${id}"]`);
  if (!el) return toast('Die Nachricht ist weiter oben. Scroll nach oben, um sie zu laden.');
  el.scrollIntoView({ block: 'center', behavior: document.documentElement.classList.contains('calm') ? 'auto' : 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

// Eine einzige Werkzeugleiste wandert zur Nachricht unter dem Mauszeiger.
function onHover(e) {
  const el = e.target.closest?.('.msg');
  if (!el || el.querySelector('.msg-edit')) return;
  if (E.tools?.parentNode === el) return;
  const m = S.cache.get(S.view.chat)?.list.find((x) => x.id === Number(el.dataset.id));
  if (!m) return;
  const meta = chatMeta(m.chat);
  const mine = m.user === S.me.id;
  const canDelete = mine || (meta?.type === 'channel' && meta.group.owner === S.me.id);
  E.tools?.remove();
  const reactBtn = iconBtn('smile', 'Reagieren', () => emojiPicker(reactBtn, (emoji) => req('react', { id: m.id, emoji }).catch(fail), { align: 'end' }));
  E.tools = h('div', { class: 'tools' }, reactBtn,
    iconBtn('reply', 'Antworten', () => { S.reply = m; renderReply(); E.input.focus(); }),
    mine && iconBtn('edit', 'Bearbeiten', () => editMsg(m)),
    canDelete && iconBtn('trash', 'Löschen', async () => {
      if (await ask('Nachricht löschen', 'Die Nachricht wird für alle gelöscht.', 'Löschen')) req('msg.delete', { id: m.id }).catch(fail);
    }, 'danger'));
  el.append(E.tools);
}

function editMsg(m) {
  const el = E.list.querySelector(`.msg[data-id="${m.id}"]`);
  if (!el || el.querySelector('.msg-edit')) return;
  E.tools?.remove();
  const done = () => replaceMsg(m);
  const ta = h('textarea', {
    class: 'input msg-edit', maxLength: 4000, value: m.content,
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(); E.input.focus(); }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = ta.value.trim();
        if (text === m.content) { done(); } else req('msg.edit', { id: m.id, content: text }).catch((ex) => { fail(ex); done(); });
        E.input.focus();
      }
    },
  });
  const box = h('div', { class: 'content' }, ta, h('small', { class: 'sub' }, 'Enter speichert, Esc bricht ab'));
  const old = el.querySelector('.content');
  if (old) old.replaceWith(box); else el.append(box);
  ta.style.height = Math.min(ta.scrollHeight + 4, 220) + 'px';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ======================================================================
// Freunde
// ======================================================================
function renderFriends() {
  const name = h('input', { class: 'in', placeholder: 'Benutzername eingeben', maxLength: 21, spellcheck: false, autocomplete: 'off' });
  E.friendTabs = h('div', { class: 'tabs', role: 'tablist' });
  E.friendList = h('div', { class: 'friend-list' });
  E.body.replaceChildren(h('div', { class: 'friends' },
    h('div', { class: 'hello' }, fun.greeting(S.me.display), h('small', null, 'Wer ist heute für Quatsch zu haben?')),
    h('form', {
      class: 'add-friend',
      onsubmit: async (e) => {
        e.preventDefault();
        const n = name.value.trim();
        if (!n) return;
        try {
          await req('friend.add', { username: n });
          name.value = '';
          toast('Freundschaftsanfrage gesendet');
        } catch (ex) { fail(ex); }
      },
    }, h('label', { class: 'field grow' }, h('span', null, 'Freund hinzufügen'), name), h('button', { class: 'btn primary' }, 'Anfrage senden')),
    E.friendTabs, E.friendList));
  renderFriendList();
}

function renderFriendList() {
  if (!E.friendList?.isConnected) return;
  const all = [...S.friends.entries()].map(([id, state]) => ({ u: U(id), state }));
  const friends = all.filter((f) => f.state === 'friends').sort((a, b) => a.u.display.localeCompare(b.u.display, 'de'));
  const requests = all.filter((f) => f.state !== 'friends');
  const incoming = requests.filter((f) => f.state === 'incoming').length;
  const tabs = [['online', 'Online'], ['all', 'Alle'], ['requests', 'Anfragen']];
  E.friendTabs.replaceChildren(...tabs.map(([key, label]) => h('button', {
    class: 'tab' + (S.friendTab === key ? ' on' : ''), role: 'tab', 'aria-selected': String(S.friendTab === key), type: 'button',
    onclick: () => { S.friendTab = key; renderFriendList(); },
  }, label, key === 'requests' && badge(incoming))));
  const list = S.friendTab === 'requests' ? requests : S.friendTab === 'online' ? friends.filter((f) => f.u.status !== 'offline') : friends;
  const empty = {
    online: fun.emptyOnline(),
    all: fun.emptyAll(),
    requests: fun.emptyRequests(),
  }[S.friendTab];
  E.friendList.replaceChildren(...(list.length ? list.map(({ u, state }) => h('div', { class: 'friend' },
    avatar(u, 40, true),
    h('span', { class: 'grow cut2' }, h('strong', { class: 'cut' }, u.display),
      h('small', { class: 'cut' }, state === 'incoming' ? 'möchte mit dir befreundet sein' : state === 'outgoing' ? 'Anfrage gesendet' : u.custom || STATUS[u.status])),
    state === 'friends' && iconBtn('msg', 'Nachricht schreiben', () => openDm(u.id)),
    state === 'friends' && iconBtn('phone', 'Anrufen', async () => { await openDm(u.id); const dm = [...S.dms.values()].find((d) => d.user === u.id); if (dm) joinVoice(dm.id); }),
    state === 'incoming' && iconBtn('check', 'Annehmen', () => req('friend.accept', { user: u.id }).catch(fail), 'good'),
    iconBtn('x', state === 'friends' ? 'Freund entfernen' : state === 'incoming' ? 'Ablehnen' : 'Anfrage zurückziehen', async () => {
      if (state === 'friends' && !(await ask('Freund entfernen', `${u.display} aus deiner Freundesliste entfernen?`, 'Entfernen'))) return;
      req('friend.remove', { user: u.id }).catch(fail);
    }, 'danger'))) : [h('p', { class: 'hint center' }, empty)]));
}

// ======================================================================
// Gruppen
// ======================================================================
function groupDialog() {
  const name = h('input', { class: 'in', maxLength: 40, placeholder: 'z. B. Zockerrunde' });
  const code = h('input', { class: 'in', maxLength: 60, placeholder: 'Einladungscode', spellcheck: false, autocomplete: 'off' });
  const run = (t, data) => async (e) => {
    e.preventDefault();
    try {
      const r = await req(t, data());
      mergeUsers(r.users);
      S.groups.set(r.group.id, r.group);
      for (const [k, v] of Object.entries(r.voice || {})) S.voice.set(Number(k), v);
      close();
      selectGroup(r.group.id);
    } catch (ex) { fail(ex); }
  };
  const close = modal('Gruppe hinzufügen', [
    h('form', { class: 'split', onsubmit: run('group.create', () => ({ name: name.value })) },
      h('label', { class: 'field grow' }, h('span', null, 'Neue Gruppe erstellen'), name), h('button', { class: 'btn primary' }, 'Erstellen')),
    h('form', { class: 'split', onsubmit: run('group.join', () => ({ invite: code.value })) },
      h('label', { class: 'field grow' }, h('span', null, 'Einer Gruppe beitreten'), code), h('button', { class: 'btn' }, 'Beitreten')),
  ]);
}

function inviteDialog(g) {
  const copy = () => navigator.clipboard.writeText(g.invite).then(() => toast('Code kopiert'), () => toast('Kopieren hat nicht geklappt.', 'bad'));
  modal('Freunde einladen', [
    h('p', { class: 'lead' }, `Gib diesen Code weiter. Wer ihn unter „Gruppe hinzufügen“ eingibt, tritt „${g.name}“ bei.`),
    h('div', { class: 'split' }, h('code', { class: 'invite grow' }, g.invite), h('button', { class: 'btn primary', type: 'button', onclick: copy }, 'Code kopieren')),
  ]);
}

// Einträge für das Gruppenmenü (Klick auf den Gruppennamen oder Rechtsklick auf das Gruppenbild).
function groupItems(g) {
  const owner = g.owner === S.me.id;
  const unread = g.channels.filter((c) => rd(c.id).unread > 0);
  return [
    unread.length && { label: 'Als gelesen markieren', icon: 'check', run: () => unread.forEach((c) => markChatRead(c.id)) },
    { label: 'Freunde einladen', icon: 'plus', run: () => inviteDialog(g) },
    g.invite && { label: 'Einladungscode kopieren', icon: 'copy', run: () => copyText(g.invite, 'Einladungscode kopiert') },
    owner && { label: 'Gruppe bearbeiten', icon: 'edit', run: () => groupSettings(g) },
    '-',
    owner && { label: 'Gruppe löschen', icon: 'trash', danger: true, run: () => deleteGroup(g) },
    { label: 'Gruppe verlassen', icon: 'out', danger: true, run: async () => {
      if (await ask('Gruppe verlassen', `„${g.name}“ wirklich verlassen?` + (owner ? ' Die Gruppe geht an das dienstälteste Mitglied über. Bist du allein, wird sie gelöscht.' : ''), 'Verlassen')) {
        req('group.leave', { group: g.id }).catch(fail);
      }
    } },
  ];
}

function groupMenu(g, anchor) {
  menu(anchor, groupItems(g));
}

async function deleteGroup(g) {
  if (await ask('Gruppe löschen', `„${g.name}“ mit allen Kanälen und Nachrichten endgültig löschen? Das lässt sich nicht rückgängig machen.`, 'Gruppe löschen')) {
    req('group.delete', { group: g.id }).catch(fail);
    return true;
  }
  return false;
}

function channelItems(g, c) {
  const owner = g.owner === S.me.id;
  const voiceKind = c.kind === 'voice';
  return [
    !voiceKind && rd(c.id).unread > 0 && { label: 'Als gelesen markieren', icon: 'check', run: () => markChatRead(c.id) },
    voiceKind && (voice.chat === c.id
      ? { label: 'Sprachkanal verlassen', icon: 'hang', run: hangUp }
      : { label: 'Sprachkanal betreten', icon: 'volume', run: () => joinVoice(c.id) }),
    owner && { label: 'Kanal bearbeiten', icon: 'edit', run: () => channelEdit(g, c) },
    owner && '-',
    owner && { label: 'Kanal löschen', icon: 'trash', danger: true, run: async () => {
      if (await ask('Kanal löschen', `„${c.name}“ mit allen Nachrichten endgültig löschen?`, 'Kanal löschen')) req('channel.delete', { chat: c.id }).catch(fail);
    } },
  ];
}

function dmItems(d, u) {
  const inCall = voice.chat === d.id;
  return [
    rd(d.id).unread > 0 && { label: 'Als gelesen markieren', icon: 'check', run: () => markChatRead(d.id) },
    { label: inCall ? 'Auflegen' : 'Anrufen', icon: inCall ? 'hang' : 'phone', run: () => (inCall ? hangUp() : joinVoice(d.id)) },
    !isGone(u) && { label: 'Benutzernamen kopieren', icon: 'copy', run: () => copyText(u.username, 'Benutzername kopiert') },
  ];
}

function copyText(text, done) {
  navigator.clipboard.writeText(text).then(() => toast(done), () => toast('Kopieren hat nicht geklappt.', 'bad'));
}

function groupSettings(g) {
  const name = h('input', { class: 'in', maxLength: 40, value: g.name });
  const pick = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
    try {
      const f = await upload(await squareImage(pick.files[0], 160), 'icon.webp');
      await req('group.update', { group: g.id, icon: f.id });
      toast('Gruppenbild gespeichert');
    } catch (e) { fail(e); }
  } });
  const close = modal('Gruppe bearbeiten', [
    h('form', { class: 'split', onsubmit: (e) => { e.preventDefault(); req('group.update', { group: g.id, name: name.value }).then(() => toast('Gespeichert'), fail); } },
      h('label', { class: 'field grow' }, h('span', null, 'Name'), name), h('button', { class: 'btn primary' }, 'Speichern')),
    h('div', { class: 'row' }, pick,
      h('button', { class: 'btn', type: 'button', onclick: () => pick.click() }, 'Gruppenbild ändern'),
      g.icon && h('button', { class: 'btn', type: 'button', onclick: () => req('group.update', { group: g.id, icon: null }).then(() => toast('Gruppenbild entfernt'), fail) }, 'Bild entfernen'),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (await ask('Neuer Einladungscode', 'Der alte Code funktioniert danach nicht mehr.', 'Neuen Code erzeugen', false)) req('group.update', { group: g.id, newInvite: true }).then(() => toast('Neuer Code erzeugt'), fail);
      } }, 'Neuen Einladungscode erzeugen')),
    h('hr'),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (await deleteGroup(g)) close();
    } }, 'Gruppe löschen'),
  ]);
}

async function channelDialog(g, kind) {
  const name = await promptText(kind === 'voice' ? 'Sprachkanal erstellen' : 'Textkanal erstellen', 'Name des Kanals', '', 'Erstellen', 32);
  if (name) req('channel.create', { group: g.id, name, kind }).catch(fail);
}

function channelEdit(g, c) {
  const name = h('input', { class: 'in', maxLength: 32, value: c.name });
  const close = modal('Kanal bearbeiten', [
    h('form', { class: 'split', onsubmit: (e) => { e.preventDefault(); req('channel.update', { chat: c.id, name: name.value }).then(close, fail); } },
      h('label', { class: 'field grow' }, h('span', null, 'Name'), name), h('button', { class: 'btn primary' }, 'Speichern')),
    h('hr'),
    h('button', { class: 'btn danger', type: 'button', onclick: async () => {
      if (await ask('Kanal löschen', `„${c.name}“ mit allen Nachrichten endgültig löschen?`, 'Kanal löschen')) { close(); req('channel.delete', { chat: c.id }).catch(fail); }
    } }, 'Kanal löschen'),
  ]);
}

// Schneidet ein Bild quadratisch zu und verkleinert es (für Profil- und Gruppenbilder).
async function squareImage(file, px) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw new Error('Dieses Bild lässt sich nicht lesen. Nimm ein PNG oder JPG.'); }
  const s = Math.min(bmp.width, bmp.height);
  const cv = h('canvas', { width: px, height: px });
  cv.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, px, px);
  return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('Das Bild konnte nicht gelesen werden.'))), 'image/webp', 0.85));
}

// ======================================================================
// Sprache
// ======================================================================
async function joinVoice(chat) {
  stopRing();
  if (voice.chat === chat) return;
  try {
    await join(chat);
    if (prefs.sound) sound.join();
  } catch (e) { fail(e); }
}
async function hangUp() {
  await leave();
  if (prefs.sound) sound.leave();
}

// Setzt für alle Leute im eigenen Sprachchat die gespeicherte Lautstärke.
function applyVolumes() {
  for (const p of S.voice.get(voice.chat) || []) {
    const peer = voice.peers.get(p.cid);
    if (peer) peer.audio.volume = voice.volumeOf(p.cid);
  }
}

const videos = new Map(); // cid -> <video>
function renderCall() {
  applyVolumes();
  // Anrufleiste in Direktnachrichten
  const v = S.view;
  const list = v.page === 'chat' && S.dms.has(v.chat) ? S.voice.get(v.chat) || [] : [];
  E.callbar.hidden = !list.length;
  if (list.length) {
    const inCall = voice.chat === v.chat;
    E.callbar.replaceChildren(
      h('div', { class: 'row' }, list.map((p) => h('span', { class: 'call-av' + (voice.speaking.has(p.cid) ? ' talk' : ''), data: { cid: p.cid }, title: U(p.uid).display, onclick: (e) => userCard(U(p.uid), e.currentTarget, null, 'bottom') }, avatar(U(p.uid), 44)))),
      h('span', { class: 'grow' }, inCall ? 'Ihr seid im Anruf' : 'Anruf läuft'),
      ...(inCall
        ? [iconBtn('screen', voice.screen ? 'Bildschirm nicht mehr teilen' : 'Bildschirm teilen', () => toggleScreen(), voice.screen ? 'active' : ''),
          h('button', { class: 'btn danger', type: 'button', onclick: hangUp }, 'Auflegen')]
        : [h('button', { class: 'btn primary', type: 'button', onclick: () => joinVoice(v.chat) }, 'Beitreten')]));
  }
  // Bühne für geteilte Bildschirme
  const room = voice.chat ? S.voice.get(voice.chat) || [] : [];
  const live = new Map();
  for (const p of room) {
    const peer = voice.peers.get(p.cid);
    if (p.screen && peer?.screen) live.set(p.cid, { stream: peer.screen, name: U(p.uid).display });
  }
  for (const [cid, el] of videos) if (!live.has(cid)) { el.remove(); videos.delete(cid); }
  for (const [cid, { stream, name }] of live) {
    let wrap = videos.get(cid);
    if (!wrap) {
      const vid = h('video', { autoplay: true, muted: true, playsInline: true, title: 'Doppelklick für Vollbild', ondblclick: () => vid.requestFullscreen?.() });
      wrap = h('figure', null, vid, h('figcaption', null, `${name} teilt den Bildschirm`));
      videos.set(cid, wrap);
      E.stage.append(wrap);
    }
    const vid = wrap.firstChild;
    if (vid.srcObject !== stream) { vid.srcObject = stream; vid.play().catch(() => {}); }
  }
  E.stage.hidden = !videos.size;
}

voice.onChange = schedule;
voice.onSpeak = () => {
  for (const el of document.querySelectorAll('[data-cid]')) el.classList.toggle('talk', voice.speaking.has(el.dataset.cid));
};

let ring = null;
function stopRing() {
  if (!ring) return;
  clearInterval(ring.timer);
  fadeOut(ring.el);
  ring = null;
}
function showRing(chat, from) {
  if (voice.chat === chat || S.me.status === 'dnd') return;
  stopRing();
  const u = U(from);
  const el = h('div', { class: 'ring', role: 'alertdialog', 'aria-label': 'Eingehender Anruf' },
    avatar(u, 48), h('div', { class: 'grow cut2' }, h('strong', { class: 'cut' }, u.display), h('small', null, 'ruft dich an')),
    h('button', { class: 'btn primary', type: 'button', onclick: async () => { stopRing(); await openChat(chat); joinVoice(chat); } }, 'Annehmen'),
    h('button', { class: 'btn', type: 'button', onclick: stopRing }, 'Ablehnen'));
  document.getElementById('layer').append(el);
  let n = 0;
  const beep = () => { if (++n > 12) return stopRing(); if (prefs.sound) sound.ring(); };
  ring = { chat, el, timer: setInterval(beep, 2500) };
  beep();
  if (isApp) { invoke('notify', { title: 'Eingehender Anruf', body: `${u.display} ruft dich an` }).catch(() => {}); invoke('attention').catch(() => {}); }
}

// ======================================================================
// Einstellungen
// ======================================================================
// Die Einstellungen sind in Reiter aufgeteilt. Jeder Reiter wird beim ersten Öffnen gebaut und bleibt dann erhalten,
// damit beim Hin- und Herwechseln nichts Eingetipptes verloren geht.
function settingsDialog(start = 'profile') {
  const cleanups = [];
  const pages = [
    ['profile', 'Profil', 'users', profilePage],
    ['look', 'Darstellung', 'palette', lookPage],
    ['voice', 'Sprache & Video', 'mic', () => voicePage(cleanups)],
    ['notify', 'Benachrichtigungen', 'msg', notifyPage],
    ['account', 'Konto', 'edit', accountPage],
    ['app', isApp ? 'App' : 'Desktop-App', 'screen', appPage],
  ];
  const built = new Map();
  const nav = h('nav', { class: 'set-nav', role: 'tablist', 'aria-label': 'Bereiche' });
  const pane = h('div', { class: 'set-pane', role: 'tabpanel' });
  const show = (key) => {
    const page = pages.find((p) => p[0] === key) || pages[0];
    if (!built.has(page[0])) built.set(page[0], h('div', { class: 'set-page' }, h('h3', null, page[1]), page[3]()));
    pane.replaceChildren(built.get(page[0]));
    pane.scrollTop = 0; // jeder Reiter beginnt oben, nicht dort, wo der vorige aufgehört hat
    nav.replaceChildren(...pages.map(([k, label, ic]) => h('button', {
      class: 'set-tab' + (k === page[0] ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(k === page[0]), onclick: () => show(k),
    }, icon(ic, 18), h('span', null, label))));
  };
  show(start);
  modal('Einstellungen', h('div', { class: 'settings' }, nav, pane), {
    wide: true,
    onClose: () => { for (const f of cleanups) f(); },
  });
}

const settingsSel = (value, options, onchange) => {
  const s = h('select', { class: 'in', onchange: () => onchange(s.value) }, options.map(([v, l]) => h('option', { value: v }, l)));
  s.value = value;
  return s;
};
const settingsCheck = (label, key, after) => h('label', { class: 'check' },
  h('input', { type: 'checkbox', checked: prefs[key] !== false, onchange: (e) => { prefs[key] = e.target.checked; savePrefs(); after?.(); } }), label);
const pct = (v) => Math.round(v * 100) + ' %';

function profilePage() {
  const me = S.me;
  const display = h('input', { class: 'in', maxLength: 32, value: me.display });
  const custom = h('input', { class: 'in', maxLength: 80, value: me.custom, placeholder: 'Was machst du gerade?' });
  let color = me.color;
  const swatches = h('div', { class: 'swatches' });
  const paintSwatches = () => swatches.replaceChildren(...['#f2d95c', '#ff8a7a', '#7ad7c1', '#8fb8ff', '#d9a2ff', '#ffb35c', '#9fe07a', '#ff9ecb', '#e8efe9'].map((c) =>
    h('button', { type: 'button', class: c === color ? 'on' : '', style: { background: c }, 'aria-label': 'Farbe ' + c, onclick: () => { color = c; paintSwatches(); } })));
  paintSwatches();
  const pick = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
    try {
      const f = await upload(await squareImage(pick.files[0], 160), 'avatar.webp');
      await req('profile.update', { avatar: f.id });
      toast('Profilbild gespeichert');
    } catch (e) { fail(e); }
  } });
  return h('form', { onsubmit: (e) => { e.preventDefault(); req('profile.update', { display: display.value, custom: custom.value, color }).then(() => toast('Profil gespeichert'), fail); } },
    h('div', { class: 'split' }, h('label', { class: 'field grow' }, h('span', null, 'Anzeigename'), display), h('label', { class: 'field grow' }, h('span', null, 'Status-Text'), custom)),
    h('div', { class: 'field' }, h('span', null, 'Farbe'), swatches),
    h('div', { class: 'row' }, pick, h('button', { class: 'btn primary' }, 'Profil speichern'),
      h('button', { class: 'btn', type: 'button', onclick: () => pick.click() }, 'Profilbild ändern'),
      me.avatar && h('button', { class: 'btn', type: 'button', onclick: () => req('profile.update', { avatar: null }).then(() => toast('Profilbild entfernt'), fail) }, 'Bild entfernen')));
}

// Darstellung: Alles wirkt sofort. Die Vorschau zeigt, wie Nachrichten aussehen, weil der Chat hinter dem Fenster verdeckt ist.
function lookPage() {
  const D = LOOK.DEFAULTS;
  const set = (key, value) => { prefs[key] = value; savePrefs(); applyLook(); paint(); };
  const radio = (on, el) => { el.classList.toggle('on', on); el.setAttribute('aria-checked', String(on)); };

  // ---- Farbschema ----
  const themeBtns = LOOK.THEMES.map(([key, name, c]) => {
    const preview = h('span', { class: 'preview' + (c ? '' : ' system') });
    if (c) {
      preview.style.setProperty('--chip', c[2]);
      preview.append(h('i', { style: { background: c[0] } }), h('i', { style: { background: c[1] } }));
    }
    return h('button', { class: 'theme-card', type: 'button', role: 'radio', data: { key }, onclick: () => set('theme', key) },
      preview, h('span', { class: 'name' }, h('span', { class: 'cut' }, name), icon('check', 16)));
  });

  // ---- Akzentfarbe ----
  const accentBtns = LOOK.ACCENTS.map(([color, name]) => h('button', {
    type: 'button', role: 'radio', title: name, 'aria-label': name, data: { color }, style: { background: color }, onclick: () => set('accent', color),
  }));
  const custom = h('input', { type: 'color', value: prefs.accent, 'aria-label': 'Eigene Akzentfarbe', oninput: () => set('accent', custom.value) });
  const customWrap = h('label', { class: 'swatch-custom', title: 'Eigene Farbe wählen' }, custom);

  // ---- Nachrichten ----
  const sizeVal = h('b');
  const sizeIn = rangeInput({ min: 13, max: 20, step: 1, value: prefs.msgSize, 'aria-label': 'Schriftgröße der Nachrichten', oninput: () => set('msgSize', Number(sizeIn.value)) });
  const friend = { display: 'Lena', color: '#8fb8ff' };
  const fake = (u, time, text, first) => h('div', { class: 'msg' + (first ? ' first' : '') },
    first && h('span', { class: 'msg-av' }, avatar(u, 38)),
    first && h('div', { class: 'msg-meta' }, h('span', { class: 'author', style: { color: u.color } }, u.display), h('time', null, time)),
    h('div', { class: 'content' }, markdown(text, mdCtx)));
  const preview = h('div', { class: 'look-preview', 'aria-hidden': 'true' },
    fake(friend, '19:42', `Hey @${S.me.username}, kommst du heute Abend noch in den Sprachchat?`, true),
    fake(S.me, '19:44', 'Klar, ich bin um acht da 🎧', true),
    h('div', { class: 'msg' }, h('div', { class: 'content' }, markdown('Bring **gute Laune** mit, ich hab `Snacks`.', mdCtx)),
      h('div', { class: 'reacts' }, h('span', { class: 'react mine' }, '👍', h('b', null, '2')), h('span', { class: 'react' }, '😂', h('b', null, '1')))));

  // ---- Umschalter ----
  const segs = [];
  const seg = (key, options, label) => {
    const el = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label }, options.map(([value, text]) =>
      h('button', { type: 'button', role: 'radio', data: { value }, onclick: () => set(key, value) }, text)));
    segs.push([el, key]);
    return el;
  };
  const motion = h('input', { type: 'checkbox', onchange: () => set('motion', motion.checked) });
  const photo = h('input', { type: 'checkbox', onchange: () => set('photo', photo.checked) });
  const veilVal = h('b');
  const veilIn = rangeInput({ min: 40, max: 95, step: 1, value: prefs.veil, 'aria-label': 'Abdunklung über dem Foto', oninput: () => set('veil', Number(veilIn.value)) });

  function paint() {
    for (const b of themeBtns) radio(prefs.theme === b.dataset.key, b);
    const known = accentBtns.some((b) => b.dataset.color === prefs.accent);
    for (const b of accentBtns) radio(prefs.accent === b.dataset.color, b);
    customWrap.classList.toggle('on', !known);
    customWrap.style.background = known ? '' : prefs.accent;
    if (custom.value !== prefs.accent) custom.value = prefs.accent;
    sizeIn.value = prefs.msgSize;
    sizeIn.paint();
    sizeVal.textContent = prefs.msgSize + ' px' + (prefs.msgSize === D.msgSize ? ' · Standard' : '');
    for (const [el, key] of segs) for (const b of el.children) radio(prefs[key] === b.dataset.value, b);
    motion.checked = prefs.motion !== false;
    photo.checked = prefs.photo !== false;
    veilIn.value = prefs.veil;
    veilIn.paint();
    veilVal.textContent = prefs.veil + ' %';
  }
  paint();

  return [
    h('p', { class: 'sub' }, 'Änderungen gelten sofort und nur auf diesem Gerät.'),
    h('h4', null, 'Farbschema'),
    h('div', { class: 'themes', role: 'radiogroup', 'aria-label': 'Farbschema' }, themeBtns),
    h('h4', null, 'Akzentfarbe'),
    h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Akzentfarbe' }, accentBtns, customWrap),
    h('p', { class: 'sub' }, 'Die Akzentfarbe färbt Knöpfe, Markierungen, Erwähnungen und die offene Gruppe.'),
    h('h4', null, 'Nachrichten'),
    preview,
    h('label', { class: 'field range' }, h('span', null, 'Schriftgröße', sizeVal), sizeIn),
    h('div', { class: 'look-row' }, h('span', null, 'Abstand', h('small', null, 'Kompakt zeigt mehr Nachrichten auf einmal.')),
      seg('density', [['cozy', 'Gemütlich'], ['compact', 'Kompakt']], 'Abstand zwischen Nachrichten')),
    h('h4', null, 'Oberfläche'),
    h('div', { class: 'look-row' }, h('span', null, 'Ecken', h('small', null, 'Wie rund Knöpfe, Fenster und Bilder sind.')),
      seg('corners', [['round', 'Rund'], ['soft', 'Dezent'], ['sharp', 'Eckig']], 'Ecken')),
    h('label', { class: 'check' }, motion, 'Weiche Animationen'),
    h('h4', null, 'Hintergrundfoto'),
    h('label', { class: 'check' }, photo, 'Foto im Hintergrund zeigen'),
    h('label', { class: 'field range' }, h('span', null, 'Abdunklung', veilVal), veilIn),
    h('p', { class: 'sub' }, 'Sind in Windows die Animationseffekte ausgeschaltet, bewegt sich auch PeterCord nicht.'),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => {
      for (const k of Object.keys(D)) prefs[k] = D[k];
      savePrefs();
      applyLook();
      paint();
      toast('Darstellung zurückgesetzt');
    } }, 'Auf Standard zurücksetzen')),
  ];
}

function voicePage(cleanups) {
  // ---- Geräte ----
  const micSel = h('select', { class: 'in', onchange: async () => {
    prefs.mic = micSel.value;
    savePrefs();
    try { await reloadMic(); } catch (e) { fail(e); }
  } });
  const outSel = h('select', { class: 'in', onchange: () => { prefs.out = outSel.value; savePrefs(); setOutput(outSel.value); } });
  // ---- Mikrofonzugriff ----
  // Wer die Anfrage beim ersten Mal abgelehnt hat, kann den Zugriff hier jederzeit nachträglich erlauben.
  const accessTitle = h('strong');
  const accessText = h('p');
  const accessBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    accessBtn.disabled = true;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      toast('Mikrofonzugriff erlaubt');
    } catch (e) { toast(micError(e, true), 'bad'); }
    accessBtn.disabled = false;
    fillDevices();
  } }, 'Mikrofonzugriff erlauben');
  const accessBox = h('div', { class: 'access', hidden: true }, icon('alert', 22), h('div', { class: 'grow cut2' }, accessTitle, accessText), accessBtn);
  // Die Berechtigung kann sich auch außerhalb ändern (Browser-Schloss, Windows-Einstellungen) – dann sofort neu anzeigen.
  let perm = null;
  navigator.permissions?.query({ name: 'microphone' }).then((p) => {
    perm = p;
    p.onchange = () => fillDevices();
    cleanups.push(() => { p.onchange = null; });
    fillDevices();
  }).catch(() => {});
  function paintAccess(list) {
    const mics = list.filter((d) => d.kind === 'audioinput');
    const state = perm?.state;
    // Ohne Zugriff liefert der Browser keine Gerätenamen – das ist der Hinweis, falls die Berechtigungs-Abfrage fehlt.
    const granted = state === 'granted' || list.some((d) => d.label);
    const denied = state === 'denied';
    accessBox.classList.toggle('bad', denied);
    if (!granted) {
      accessTitle.textContent = denied ? 'Mikrofonzugriff abgelehnt' : 'PeterCord darf dein Mikrofon noch nicht benutzen';
      accessText.textContent = denied
        ? 'Kein Problem, das lässt sich ändern: Klick auf den Knopf. Fragt PeterCord nicht nach, gib das Mikrofon in den Windows-Einstellungen frei (Datenschutz und Sicherheit → Mikrofon).'
        : 'Ohne Zugriff hören dich die anderen im Sprachchat nicht, und die Gerätenamen bleiben leer.';
      accessBtn.textContent = denied ? 'Erneut versuchen' : 'Mikrofonzugriff erlauben';
      accessBtn.hidden = false;
    } else if (!mics.length) {
      accessTitle.textContent = 'Kein Mikrofon gefunden';
      accessText.textContent = 'Schließ ein Mikrofon oder Headset an. Es erscheint dann sofort hier.';
      accessBtn.hidden = true;
    }
    accessBox.hidden = granted && mics.length > 0;
  }
  async function fillDevices() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch {}
    const opts = (kind) => [h('option', { value: '' }, 'Standardgerät (Windows)'),
      ...list.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => h('option', { value: d.deviceId }, d.label || `${kind === 'audioinput' ? 'Mikrofon' : 'Lautsprecher'} ${i + 1}`))];
    micSel.replaceChildren(...opts('audioinput'));
    outSel.replaceChildren(...opts('audiooutput'));
    micSel.value = prefs.mic;
    if (micSel.value !== prefs.mic) micSel.value = '';
    outSel.value = prefs.out;
    if (outSel.value !== prefs.out) outSel.value = '';
    paintAccess(list);
  }
  fillDevices();
  const onDevices = () => fillDevices();
  navigator.mediaDevices?.addEventListener?.('devicechange', onDevices);
  cleanups.push(() => navigator.mediaDevices?.removeEventListener?.('devicechange', onDevices));
  const noSink = !('setSinkId' in HTMLMediaElement.prototype);

  // ---- Lautstärken ----
  const slider = (key, max, label) => {
    const val = h('b', null, pct(prefs[key]));
    const r = rangeInput({ min: 0, max, step: 0.05, value: prefs[key], 'aria-label': label, oninput: () => {
      prefs[key] = Number(r.value);
      val.textContent = pct(prefs[key]);
      savePrefs();
      applyAudio();
    } });
    return h('label', { class: 'field grow range' }, h('span', null, label, val), r);
  };

  // ---- Pegel, Empfindlichkeit, Test ----
  const DB = 80; // Anzeigebereich: -80 dB bis 0 dB
  const at = (db) => Math.min(100, Math.max(0, ((db + DB) / DB) * 100)) + '%';
  const fmtDb = (v) => `${String(Math.round(v)).replace('-', '−')} dB`;
  const fill = h('i', { class: 'meter-fill' });
  const mark = h('i', { class: 'meter-th' });
  const meter = h('div', { class: 'meter', 'aria-hidden': 'true' }, fill, mark);
  const meterNote = h('small', { class: 'sub' });
  const thVal = h('b', null, '');
  const vadHint = h('p', { class: 'sub' });
  const vad = rangeInput({ min: -DB, max: 0, step: 1, value: prefs.vadTh, 'aria-label': 'Schwelle der Eingabeempfindlichkeit', oninput: () => {
    prefs.vadTh = Number(vad.value);
    prefs.vadSet = true;
    savePrefs();
    applyAudio();
  } });
  const vadWrap = h('div', { class: 'vad' }, h('div', { class: 'vad-head' }, h('span', null, 'Schwelle'), thVal), meter, vad);
  let autoTh = null; // zuletzt gemessene Schwelle der Automatik
  const syncVad = () => {
    const auto = prefs.vadAuto !== false;
    // Wer zum ersten Mal von Hand einstellt, startet dort, wo die Automatik gerade stand –
    // ein Stück höher, weil eine feste Schwelle keine Sprache erkennt.
    if (!auto && !prefs.vadSet && autoTh != null) {
      prefs.vadTh = Math.min(-10, Math.max(-DB, Math.round(autoTh + 4)));
      savePrefs();
    }
    vad.value = prefs.vadTh;
    vad.paint();
    vad.hidden = auto;
    vadWrap.classList.toggle('auto', auto);
    vadHint.textContent = auto
      ? 'PeterCord erkennt deine Stimme und stellt sich laufend auf die Umgebung ein: Lüfter, Tastatur und Mausklicks bleiben draußen, leise Wortanfänge kommen trotzdem an. Die farbige Markierung zeigt, ab welchem Pegel die Automatik gerade hinhört.'
      : 'Alles unterhalb der farbigen Markierung wird nicht übertragen. Zieh den Regler knapp über den Pegel, den die Anzeige zeigt, wenn du nichts sagst. Eine feste Schwelle erkennt keine Sprache – laute Tastenklicks kommen durch.';
  };
  syncVad();
  const testBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    testBtn.disabled = true;
    try { await micTest(!testing()); } catch (e) { fail(e); }
    testBtn.disabled = false;
  } });

  let alive = true;
  cleanups.push(() => { alive = false; micTest(false); });
  const tick = () => {
    if (!alive) return;
    requestAnimationFrame(tick);
    if (!meter.isConnected) return;
    const L = micLevel();
    const on = testing();
    testBtn.textContent = on ? 'Test beenden' : 'Mikrofon testen';
    testBtn.classList.toggle('primary', !on);
    const auto = prefs.vadAuto !== false;
    if (L) {
      if (auto) autoTh = L.th;
      fill.style.width = at(L.level);
      fill.classList.toggle('open', L.open);
      mark.style.left = at(L.th);
      mark.hidden = false;
      thVal.textContent = auto ? `${fmtDb(L.th)} · automatisch` : fmtDb(prefs.vadTh);
      meterNote.textContent = L.muted ? 'Du bist stummgeschaltet – gerade wird nichts übertragen.'
        : on ? 'Sprich etwas – du hörst dich selbst. Grün heißt: Das kommt bei den anderen an.'
        : 'Pegel deines Mikrofons im laufenden Anruf. Grün heißt: Das kommt bei den anderen an.';
    } else {
      fill.style.width = '0';
      mark.style.left = at(prefs.vadTh);
      mark.hidden = auto;
      thVal.textContent = auto ? 'automatisch' : fmtDb(prefs.vadTh);
      meterNote.textContent = 'Starte den Test, um zu sehen, wie laut dein Mikrofon ist. Am besten mit Kopfhörern.';
    }
  };
  requestAnimationFrame(tick);

  return [
    accessBox,
    h('div', { class: 'split' },
      h('label', { class: 'field grow' }, h('span', null, 'Eingabegerät (Mikrofon)'), micSel),
      h('label', { class: 'field grow' }, h('span', null, 'Ausgabegerät (Lautsprecher, Kopfhörer)'), outSel)),
    noSink && h('p', { class: 'sub' }, 'Dieser Browser kann das Ausgabegerät nicht wechseln. In der Desktop-App geht es.'),
    h('div', { class: 'split' }, slider('inVol', 2, 'Eingabelautstärke'), slider('outVol', 1, 'Ausgabelautstärke')),

    h('h4', null, 'Mikrofontest'),
    h('div', { class: 'row' }, testBtn, meterNote),

    h('h4', null, 'Eingabeempfindlichkeit'),
    settingsCheck('Automatisch einstellen (empfohlen)', 'vadAuto', () => { syncVad(); applyAudio(); }),
    vadWrap,
    vadHint,

    h('h4', null, 'Sprachverarbeitung'),
    settingsCheck('Hintergrundgeräusche unterdrücken', 'ns', () => reloadMic().catch(fail)),
    settingsCheck('Echo unterdrücken (wichtig ohne Kopfhörer)', 'ec', () => reloadMic().catch(fail)),
    settingsCheck('Mikrofonlautstärke automatisch anpassen', 'agc', () => reloadMic().catch(fail)),
    h('p', { class: 'sub' }, 'Änderungen gelten sofort, auch mitten im Anruf. Die Lautstärke einzelner Leute stellst du im Sprachchat per Klick auf ihren Namen ein.'),

    h('h4', null, 'Bildschirm teilen'),
    h('label', { class: 'field' }, h('span', null, 'Bildrate'),
      settingsSel(String(prefs.fps), [['15', '15 Bilder/s – spart Leistung und Bandbreite'], ['30', '30 Bilder/s – Standard'], ['60', '60 Bilder/s – flüssig, für Spiele']], (v) => { prefs.fps = Number(v); savePrefs(); })),
    h('p', { class: 'sub' }, 'Gilt ab dem nächsten Mal, wenn du deinen Bildschirm teilst.'),
  ];
}

function notifyPage() {
  return [
    h('label', { class: 'field' }, h('span', null, 'In Gruppen benachrichtigen bei'),
      settingsSel(prefs.groupNotify, [['all', 'allen Nachrichten'], ['mentions', 'Erwähnungen und Antworten'], ['none', 'nichts']], (v) => { prefs.groupNotify = v; savePrefs(); })),
    settingsCheck('Töne abspielen (Nachrichten, Anrufe, Betreten und Verlassen im Sprachchat)', 'sound'),
    h('p', { class: 'sub' }, 'Direktnachrichten melden sich immer. Mit dem Status „Nicht stören“ bleibt alles still.'),
  ];
}

function accountPage() {
  const me = S.me;
  const oldPw = h('input', { class: 'in', type: 'password', autocomplete: 'current-password' });
  const newPw = h('input', { class: 'in', type: 'password', autocomplete: 'new-password' });
  return [
    h('p', { class: 'sub' }, 'Angemeldet als @' + me.username),
    h('form', { class: 'split', onsubmit: (e) => {
      e.preventDefault();
      req('password.change', { old: oldPw.value, new: newPw.value }).then((r) => {
        if (r.token) setToken(r.token); // alle anderen Geräte wurden abgemeldet, dieses bleibt angemeldet
        oldPw.value = newPw.value = '';
        toast('Passwort geändert. Andere Geräte wurden abgemeldet.');
      }, fail);
    } },
      h('label', { class: 'field grow' }, h('span', null, 'Aktuelles Passwort'), oldPw), h('label', { class: 'field grow' }, h('span', null, 'Neues Passwort'), newPw),
      h('button', { class: 'btn' }, 'Passwort ändern')),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => { closeModal(); logout(); } }, 'Abmelden'),
      h('button', { class: 'btn danger', type: 'button', onclick: deleteAccountDialog }, 'Konto löschen')),
  ];
}

function appPage() {
  const version = h('span', { class: 'sub' }, isApp ? '' : 'Web-Version');
  if (!isApp) {
    return [
      h('p', { class: 'sub' }, 'Als Windows-App liegt PeterCord im Infobereich und meldet neue Nachrichten zuverlässig.'),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: DOWNLOAD_URL, target: '_blank', rel: 'noopener' }, 'Für Windows herunterladen'), version),
    ];
  }
  const auto = h('input', { type: 'checkbox', onchange: () => invoke('autostart_set', { enabled: auto.checked }).catch((e) => { auto.checked = !auto.checked; fail(e); }) });
  invoke('app_version').then((v) => (version.textContent = 'Version ' + v)).catch(() => {});
  invoke('autostart_get').then((v) => (auto.checked = !!v)).catch(() => {});
  return [
    h('label', { class: 'check' }, auto, 'PeterCord mit Windows starten (unauffällig im Infobereich)'),
    h('p', { class: 'sub' }, 'Das Schließen-Kreuz versteckt PeterCord nur. Ganz beenden geht per Rechtsklick auf das Symbol im Infobereich.'),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => checkUpdate('manual') }, 'Nach Updates suchen'), version),
  ];
}

function deleteAccountDialog() {
  const pw = h('input', { class: 'in', type: 'password', autocomplete: 'current-password', required: true });
  const close = modal('Konto löschen', h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      try { await req('account.delete', { password: pw.value }); } catch (ex) { return fail(ex); }
      while (hasModal()) closeModal();
      await leave(true);
      disconnect();
      setToken('');
      S.cache.clear();
      S.view = { page: 'friends', group: null, chat: null };
      showAuth('Dein Konto wurde gelöscht.');
    },
  },
    h('p', { class: 'lead' }, 'Dein Konto, deine Freundesliste und deine Mitgliedschaften in Gruppen werden endgültig entfernt. Deine Nachrichten bleiben stehen, zeigen aber nur noch „Gelöschtes Konto“.'),
    h('label', { class: 'field' }, h('span', null, 'Passwort zur Bestätigung'), pw),
    h('div', { class: 'row end' },
      h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Abbrechen'),
      h('button', { class: 'btn danger' }, 'Konto endgültig löschen'))));
}

// ======================================================================
// Updates (nur Desktop-App)
// ======================================================================
// Beim Start wird ein Update sofort eingespielt (wie man es von Chat-Apps kennt). Läuft PeterCord schon,
// erscheint nur ein Hinweis – niemand soll mitten im Gespräch rausfliegen.
let updateShown = false;
async function checkUpdate(mode = 'timer') {
  if (!isApp) return;
  try {
    const up = await invoke('check_update');
    if (!up) {
      localStorage.removeItem('pc_update_try');
      if (mode === 'manual') toast('PeterCord ist aktuell.');
      return;
    }
    // Sicherung gegen Endlosschleifen: Jede Version wird nur einmal automatisch versucht.
    if (mode === 'start' && localStorage.getItem('pc_update_try') !== up.version) {
      localStorage.setItem('pc_update_try', up.version);
      const note = h('div', { class: 'update' }, h('span', { class: 'grow' }, h('strong', null, `PeterCord ${up.version} wird installiert … `), 'Die App startet gleich neu.'));
      document.getElementById('layer').append(note);
      try {
        await invoke('install_update');
        return;
      } catch (e) {
        note.remove();
        console.warn('update', e);
      }
    }
    if (updateShown && mode !== 'manual') return;
    updateShown = true;
    document.querySelector('.update')?.remove();
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => installUpdate(btn) }, 'Jetzt aktualisieren');
    document.getElementById('layer').append(h('div', { class: 'update' },
      h('span', { class: 'grow' }, h('strong', null, `PeterCord ${up.version} ist da. `), 'Das Update dauert nur einen Moment.'), btn,
      iconBtn('x', 'Später', (e) => fadeOut(e.currentTarget.parentNode))));
  } catch (e) {
    if (mode === 'manual') toast('Die Update-Suche ist fehlgeschlagen: ' + e, 'bad');
  }
}
async function installUpdate(btn) {
  btn.disabled = true;
  btn.textContent = 'Wird installiert …';
  try { await invoke('install_update'); } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Jetzt aktualisieren';
    toast('Das Update ist fehlgeschlagen: ' + e, 'bad');
  }
}

// ======================================================================
// Ereignisse vom Server
// ======================================================================
function notifyFor(m) {
  if (m.user === S.me.id || S.me.status === 'dnd') return;
  const here = S.view.chat === m.chat && document.hasFocus() && !document.hidden && S.stick;
  if (here) return;
  const meta = chatMeta(m.chat);
  if (!meta) return;
  if (meta.type === 'channel' && !(prefs.groupNotify === 'all' || (prefs.groupNotify === 'mentions' && mentionsMe(m)))) return;
  if (prefs.sound) sound.message();
  if (document.hasFocus()) return;
  const title = meta.type === 'dm' ? U(m.user).display : `${U(m.user).display} in #${meta.name}`;
  const body = m.content.slice(0, 160) || 'hat einen Anhang gesendet';
  if (isApp) { invoke('notify', { title, body }).catch(() => {}); invoke('attention').catch(() => {}); }
  else if (window.Notification?.permission === 'granted') new Notification(title, { body, icon: 'icon.svg' });
}

function onEvent(m) {
  switch (m.t) {
    case 'ready': {
      S.me = m.me;
      S.users = new Map(m.users.map((u) => [u.id, u]));
      S.users.set(m.me.id, { ...m.me, status: m.me.status === 'invisible' ? 'offline' : m.me.status });
      S.friends = new Map(m.friends.map((f) => [f.id, f.state]));
      S.dms = new Map(m.dms.map((d) => [d.id, d]));
      S.groups = new Map(m.groups.map((g) => [g.id, g]));
      S.reads = new Map(Object.entries(m.reads).map(([k, v]) => [Number(k), v]));
      S.voice = new Map(Object.entries(m.voice).map(([k, v]) => [Number(k), v]));
      S.cache.clear();
      S.typing.clear();
      if (voice.chat) { leave(true); toast('Die Verbindung war kurz weg. Der Sprachchat wurde beendet.', 'bad'); }
      if (!S.built) {
        buildShell();
        renderBar();
        goHome();
        break;
      }
      renderBar();
      if (S.view.page === 'chat' && chatMeta(S.view.chat)) {
        // Wieder verbunden: Verlauf im Hintergrund neu laden, das Eingabefeld bleibt unberührt.
        const id = S.view.chat;
        refresh();
        loadHistory(id).then(() => {
          if (S.view.chat !== id || S.view.page !== 'chat') return;
          const stick = S.stick;
          renderMessages();
          if (stick) toBottom();
          markRead();
        });
      } else if (S.view.page === 'friends') refresh();
      else goHome();
      break;
    }
    case 'user': {
      const old = S.users.get(m.user.id);
      mergeUsers([m.user]);
      // Neuer Name, neue Farbe oder neues Bild: sichtbare Nachrichten neu zeichnen.
      if (old && (old.display !== m.user.display || old.color !== m.user.color || old.avatar !== m.user.avatar) && S.view.page === 'chat' && E.list?.isConnected) {
        const top = E.list.scrollTop;
        renderMessages();
        E.list.scrollTop = top;
      }
      schedule();
      break;
    }
    case 'me':
      S.me.status = m.status;
      schedule();
      break;
    case 'friend':
      mergeUsers(m.users);
      if (m.state === 'none') S.friends.delete(m.id);
      else {
        if (m.state === 'incoming' && S.friends.get(m.id) !== 'incoming') {
          toast(`${U(m.id).display} möchte mit dir befreundet sein`);
          if (prefs.sound && S.me.status !== 'dnd') sound.message();
        }
        S.friends.set(m.id, m.state);
      }
      schedule();
      break;
    case 'dm':
      mergeUsers(m.users);
      S.dms.set(m.dm.id, m.dm);
      schedule();
      break;
    case 'group': {
      mergeUsers(m.users);
      S.groups.set(m.group.id, m.group);
      if (S.view.group === m.group.id && S.view.page === 'chat' && !chatMeta(S.view.chat)) selectGroup(m.group.id);
      else if (S.view.group === m.group.id && S.view.page === 'empty') selectGroup(m.group.id);
      if (voice.chat && !chatMeta(voice.chat)) leave(true);
      schedule();
      break;
    }
    case 'group.gone': {
      const g = S.groups.get(m.id);
      S.groups.delete(m.id);
      if (g) for (const c of g.channels) { S.cache.delete(c.id); S.voice.delete(c.id); }
      if (voice.chat && !chatMeta(voice.chat)) leave(true);
      if (S.view.group === m.id) { goHome(); if (g) toast(`Du bist nicht mehr in „${g.name}“.`); }
      schedule();
      break;
    }
    case 'msg': {
      const msg = m.msg;
      const r = rd(msg.chat);
      r.last = Math.max(r.last, msg.id);
      const t = S.typing.get(msg.chat);
      if (t?.has(msg.user)) { clearTimeout(t.get(msg.user)); t.delete(msg.user); renderTyping(); }
      const c = S.cache.get(msg.chat);
      const current = S.view.page === 'chat' && S.view.chat === msg.chat;
      if (c?.loading) c.late.push(msg);
      else if (c) {
        const prev = c.list[c.list.length - 1];
        c.list.push(msg);
        if (current) {
          const stick = S.stick || msg.user === S.me.id;
          E.list.querySelector('.hint')?.remove();
          if (!prev || dayKey(prev.created) !== dayKey(msg.created)) E.list.append(h('div', { class: 'day' }, h('span', null, dayLabel(msg.created))));
          const el = msgEl(msg, prev);
          el.classList.add('new'); // nur live eintreffende Nachrichten blenden sanft ein, nicht der ganze Verlauf
          E.list.append(el);
          if (stick) { toBottom(); S.stick = true; }
          if (fun.CELEBRATE.test(msg.content || '')) fun.confetti();
        }
      }
      if (msg.user !== S.me.id) {
        if (current && document.hasFocus() && S.stick) req('read', { chat: msg.chat }).catch(() => {});
        else r.unread++;
        notifyFor(msg);
      }
      schedule();
      break;
    }
    case 'msg.edit': {
      const msg = S.cache.get(m.chat)?.list.find((x) => x.id === m.id);
      if (msg) { msg.content = m.content; msg.edited = m.edited; replaceMsg(msg); }
      break;
    }
    case 'msg.delete': {
      const c = S.cache.get(m.chat);
      if (!c) break;
      c.list = c.list.filter((x) => x.id !== m.id);
      for (const x of c.list) if (x.reply?.id === m.id) x.reply = { id: m.id, gone: true };
      if (S.view.chat === m.chat && S.view.page === 'chat') {
        const top = E.list.scrollTop;
        renderMessages();
        E.list.scrollTop = top;
      }
      break;
    }
    case 'react': {
      const msg = S.cache.get(m.chat)?.list.find((x) => x.id === m.id);
      if (!msg) break;
      let r = msg.reactions.find((x) => x.emoji === m.emoji);
      if (m.on) {
        if (!r) msg.reactions.push((r = { emoji: m.emoji, users: [] }));
        if (!r.users.includes(m.user)) r.users.push(m.user);
      } else if (r) {
        r.users = r.users.filter((id) => id !== m.user);
        if (!r.users.length) msg.reactions = msg.reactions.filter((x) => x !== r);
      }
      replaceMsg(msg);
      break;
    }
    case 'typing': {
      let t = S.typing.get(m.chat);
      if (!t) S.typing.set(m.chat, (t = new Map()));
      clearTimeout(t.get(m.user));
      t.set(m.user, setTimeout(() => { t.delete(m.user); renderTyping(); }, 6000));
      renderTyping();
      break;
    }
    case 'read':
      rd(m.chat).unread = 0;
      schedule();
      break;
    case 'voice': {
      const before = S.voice.get(m.chat)?.length || 0;
      if (m.list.length) S.voice.set(m.chat, m.list);
      else S.voice.delete(m.chat);
      if (voice.chat === m.chat) {
        onList(m.list);
        if (prefs.sound && m.list.length !== before) (m.list.length > before ? sound.join : sound.leave)();
      }
      if (ring?.chat === m.chat && !m.list.length) stopRing();
      schedule();
      break;
    }
    case 'voice.kick':
      leave(true);
      break;
    case 'ring':
      showRing(m.chat, m.from);
      break;
    case 'rtc':
      onRtc(m.from, m.data);
      break;
  }
}

// ======================================================================
// Start
// ======================================================================
net.onEvent = onEvent;
net.onState = () => {
  renderBar();
  if (!net.online && voice.chat) leave(true);
};
net.onAuthFail = () => {
  setToken('');
  showAuth('Deine Anmeldung ist abgelaufen. Melde dich bitte neu an.');
};

function start() {
  root.replaceChildren(h('div', { class: 'auth' }, h('div', { class: 'col' },
    h('p', { class: 'hint' }, 'PeterCord verbindet …'),
    h('button', { class: 'link', type: 'button', onclick: () => { disconnect(); showAuth(); } }, 'Zur Anmeldung'))));
  connect();
}

window.addEventListener('focus', markRead);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (hasModal()) closeModal();
  else closePopover();
});
// Rechtsklick-Menü des Browsers nur in Textfeldern zulassen (wirkt in der App sonst fremd).
if (isApp) document.addEventListener('contextmenu', (e) => { if (!e.target.closest('input,textarea,a,.content')) e.preventDefault(); });

if (net.token) start();
else showAuth();

if (isApp) {
  checkUpdate('start');
  setInterval(() => checkUpdate('timer'), 30 * 60 * 1000);
}
