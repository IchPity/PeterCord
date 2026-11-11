// Verbindung zum Server: HTTP für Anmeldung und Dateien, ein WebSocket für alles andere.
import { DEFAULT_SERVER } from './config.js';

const T = window.__TAURI__;
export const isApp = !!T;
export const invoke = (cmd, args) => (T ? T.core.invoke(cmd, args) : Promise.resolve(null));

const fallback = isApp ? DEFAULT_SERVER : location.origin;

export const net = {
  server: localStorage.getItem('pc_server') || fallback,
  token: localStorage.getItem('pc_token') || '',
  cid: null,
  online: false,
  onEvent: () => {},
  onState: () => {},
  onAuthFail: () => {},
};

let ws = null;
let seq = 1;
let retry = 0;
let timer = null;
let beat = null;
let wanted = false;
const pending = new Map();

export function setServer(url) {
  net.server = String(url || '').trim().replace(/\/+$/, '') || fallback;
  if (net.server === fallback) localStorage.removeItem('pc_server');
  else localStorage.setItem('pc_server', net.server);
}

export function setToken(token) {
  net.token = token || '';
  if (token) localStorage.setItem('pc_token', token);
  else localStorage.removeItem('pc_token');
}

export async function api(path, body) {
  let res;
  try {
    res = await fetch(net.server + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(net.token ? { Authorization: 'Bearer ' + net.token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Der Server ist nicht erreichbar. Prüfe deine Internetverbindung.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.err) throw new Error(data.err || 'Serverfehler (' + res.status + ')');
  return data;
}

export async function upload(blob, name) {
  let res;
  try {
    res = await fetch(net.server + '/api/upload?name=' + encodeURIComponent(name), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + net.token, 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    });
  } catch {
    throw new Error('Der Upload ist fehlgeschlagen. Prüfe deine Internetverbindung.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.err) throw new Error(data.err || 'Der Upload ist fehlgeschlagen.');
  return data;
}

export const fileUrl = (id) => net.server + '/f/' + id;

export function req(t, data = {}) {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState > 1) lost(ws); // hängt beim Schließen fest: sofort neu verbinden
    if (!ws || ws.readyState !== 1) return reject(new Error('Keine Verbindung zum Server.'));
    const id = seq++;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Der Server antwortet nicht.'));
    }, 15000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ ...data, t, rid: id }));
  });
}

// Für Signale ohne Antwort (WebRTC).
export function push(t, data = {}) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ ...data, t }));
}

function lost(sock) {
  if (ws !== sock) return;
  ws = null;
  clearInterval(beat);
  try { sock.close(); } catch {}
  for (const p of pending.values()) {
    clearTimeout(p.timeout);
    p.reject(new Error('Die Verbindung wurde unterbrochen.'));
  }
  pending.clear();
  net.online = false;
  net.onState();
  if (wanted) timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
}

export function connect() {
  wanted = true;
  clearTimeout(timer);
  if (ws) return;
  if (!net.token) return net.onAuthFail();
  let sock;
  try {
    // Das Token reist als "Subprotokoll" mit, damit es in keiner Adresse steht.
    sock = new WebSocket(net.server.replace(/^http/, 'ws') + '/ws', ['pc', net.token]);
  } catch {
    timer = setTimeout(connect, 5000);
    return;
  }
  ws = sock;
  let waiting = false;
  sock.onopen = () => {
    clearInterval(beat);
    // Herzschlag: Kommt auf ein "ping" bis zum nächsten Takt nichts zurück, gilt die Verbindung als tot.
    beat = setInterval(() => {
      if (ws !== sock) return;
      if (sock.readyState !== 1 || waiting) return lost(sock);
      waiting = true;
      sock.send('ping');
    }, 25000);
  };
  sock.onmessage = (e) => {
    if (ws !== sock) return;
    waiting = false;
    if (e.data === 'pong') return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.re != null) {
      const p = pending.get(m.re);
      if (!p) return;
      pending.delete(m.re);
      clearTimeout(p.timeout);
      if (m.err) p.reject(new Error(m.err));
      else p.resolve(m);
      return;
    }
    if (m.t === 'auth.fail') {
      wanted = false;
      net.onAuthFail();
      return;
    }
    if (m.t === 'ready') {
      retry = 0;
      net.cid = m.cid;
      net.online = true;
      net.onState();
    }
    net.onEvent(m);
  };
  sock.onclose = () => lost(sock);
  sock.onerror = () => {};
}

export function disconnect() {
  wanted = false;
  clearTimeout(timer);
  if (ws) lost(ws);
}

// Nach dem Aufwachen des Rechners oder beim Zurückkehren ins Fenster sofort neu verbinden.
const hurry = () => {
  if (wanted && !ws) {
    retry = 0;
    connect();
  }
};
window.addEventListener('online', hurry);
window.addEventListener('focus', hurry);
