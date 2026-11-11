// PeterCord Server – ein Cloudflare Worker mit einem Durable Object ("Hub").
// Der Hub hält die komplette Datenbank (SQLite) und alle WebSocket-Verbindungen.
// Dank WebSocket-Hibernation kostet der Server im Leerlauf nichts.
import { DurableObject } from 'cloudflare:workers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization,Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (pathname.startsWith('/api/') || pathname === '/ws' || pathname.startsWith('/f/')) {
      const res = await env.HUB.get(env.HUB.idFromName('main')).fetch(req);
      // Die Antwort auf den WebSocket-Aufbau muss das gewählte Subprotokoll nennen, sonst lehnen Browser die
      // Verbindung ab. Auf dem Weg vom Durable Object hierher geht der Header verloren, also hier neu setzen.
      if (res.webSocket) return new Response(null, { status: 101, webSocket: res.webSocket, headers: { 'Sec-WebSocket-Protocol': 'pc' } });
      return res;
    }
    return env.ASSETS.fetch(req);
  },
};

const MAX_FILE = 10 * 1024 * 1024;
const USER_QUOTA = 500 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const SWEEP = 60 * 1000; // so oft wird nach toten Verbindungen gesucht
const STALE = 150 * 1000; // so lange darf eine Verbindung ohne Lebenszeichen bleiben
const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const COLORS = ['#f2d95c', '#ff8a7a', '#7ad7c1', '#8fb8ff', '#d9a2ff', '#ffb35c', '#9fe07a', '#ff9ecb'];

class Err extends Error {}
const now = () => Date.now();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
const enc = (s) => new TextEncoder().encode(s);
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc(s)));
async function pbkdf(pass, salt) {
  const key = await crypto.subtle.importKey('raw', enc(pass), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt), iterations: 100000 }, key, 256));
}
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : 0);

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.hits = new Map(); // einfaches Rate-Limit im Speicher
    this.gone = null; // Socket, der gerade geschlossen wird
    this.migrate();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display TEXT NOT NULL, pass TEXT NOT NULL, salt TEXT NOT NULL, color TEXT NOT NULL, avatar TEXT,
        status TEXT NOT NULL DEFAULT 'online', custom TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS friends(a INTEGER NOT NULL, b INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(a,b));
      CREATE TABLE IF NOT EXISTS groups(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner_id INTEGER NOT NULL,
        icon TEXT, invite TEXT NOT NULL UNIQUE, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS group_members(group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined INTEGER NOT NULL,
        PRIMARY KEY(group_id,user_id));
      CREATE TABLE IF NOT EXISTS chats(id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, group_id INTEGER,
        name TEXT, kind TEXT NOT NULL DEFAULT 'text', pos INTEGER NOT NULL DEFAULT 0, ua INTEGER, ub INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS chats_dm ON chats(ua,ub) WHERE type='dm';
      CREATE INDEX IF NOT EXISTS chats_group ON chats(group_id);
      CREATE TABLE IF NOT EXISTS reads(chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read INTEGER NOT NULL,
        PRIMARY KEY(chat_id,user_id));
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        content TEXT NOT NULL, files TEXT, reply_to INTEGER, created INTEGER NOT NULL, edited INTEGER);
      CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id,id);
      CREATE TABLE IF NOT EXISTS reactions(message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, emoji TEXT NOT NULL,
        PRIMARY KEY(message_id,user_id,emoji));
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
        size INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS file_chunks(file_id TEXT NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(file_id,idx));
    `);
  }

  all(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  get(q, ...a) { return this.sql.exec(q, ...a).toArray()[0] ?? null; }
  run(q, ...a) { this.sql.exec(q, ...a); }

  limit(key, max, windowMs) {
    const t = now();
    const list = (this.hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= max) { this.hits.set(key, list); return false; }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.clear();
    return true;
  }

  // ---------- HTTP ----------
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === '/ws') return await this.openSocket(req, url);
      if (url.pathname.startsWith('/f/') && req.method === 'GET') return this.serveFile(url.pathname.split('/')[2]);
      if (url.pathname === '/api/info') return json({ name: 'PeterCord', code: !!this.env.REGISTER_CODE });
      if (req.method === 'POST') {
        if (url.pathname === '/api/register') return await this.register(req);
        if (url.pathname === '/api/login') return await this.login(req);
        if (url.pathname === '/api/logout') return await this.logout(req);
        if (url.pathname === '/api/upload') return await this.upload(req, url);
        if (url.pathname.startsWith('/api/admin/')) return await this.admin(req, url.pathname.slice(11));
      }
      return json({ err: 'Nicht gefunden' }, 404);
    } catch (e) {
      if (e instanceof Err) return json({ err: e.message }, 400);
      console.error(e);
      return json({ err: 'Serverfehler' }, 500);
    }
  }

  async register(req) {
    const ip = req.headers.get('CF-Connecting-IP') || '?';
    const b = await req.json();
    const username = str(b.username, 40).toLowerCase();
    const password = String(b.password ?? '');
    if (!/^[a-z0-9_.]{2,20}$/.test(username)) throw new Err('Benutzername: 2–20 Zeichen, nur a–z, 0–9, Punkt und Unterstrich.');
    if (password.length < 6 || password.length > 200) throw new Err('Das Passwort braucht mindestens 6 Zeichen.');
    if (this.env.REGISTER_CODE && b.code !== this.env.REGISTER_CODE) throw new Err('Der Zugangscode stimmt nicht.');
    if (this.get('SELECT id FROM users WHERE username=?', username)) throw new Err('Dieser Benutzername ist schon vergeben.');
    if (!this.limit('reg:' + ip, 20, 3600e3)) throw new Err('Zu viele Registrierungen. Versuch es später noch einmal.');
    const salt = rand(16);
    const pass = await pbkdf(password, salt);
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    const u = this.get('INSERT INTO users(username,display,pass,salt,color,created) VALUES(?,?,?,?,?,?) RETURNING id',
      username, str(b.display, 32) || username, pass, salt, color, now());
    return json({ token: await this.newSession(u.id) });
  }

  async login(req) {
    const ip = req.headers.get('CF-Connecting-IP') || '?';
    if (!this.limit('login:' + ip, 15, 600e3)) throw new Err('Zu viele Versuche. Warte ein paar Minuten.');
    const b = await req.json();
    const u = this.get('SELECT * FROM users WHERE username=?', str(b.username, 40));
    if (!u || (await pbkdf(String(b.password ?? ''), u.salt)) !== u.pass) throw new Err('Benutzername oder Passwort ist falsch.');
    return json({ token: await this.newSession(u.id) });
  }

  async logout(req) {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (token) this.run('DELETE FROM sessions WHERE hash=?', await sha256(token));
    return json({ ok: true });
  }

  // Verwaltung für den Betreiber: Konten auflisten, Passwort neu setzen, Konto löschen. Geht nur mit dem
  // Admin-Schlüssel (Worker-Secret ADMIN_KEY) – siehe "npm run nutzer / passwort / konto-loeschen" in ENTWICKLUNG.md.
  async admin(req, action) {
    const ip = req.headers.get('CF-Connecting-IP') || '?';
    if (!this.limit('admin:' + ip, 20, 600e3)) throw new Err('Zu viele Versuche. Warte ein paar Minuten.');
    const key = this.env.ADMIN_KEY || '';
    const given = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (key.length < 20 || (await sha256(given)) !== (await sha256(key))) return json({ err: 'Nicht erlaubt.' }, 403);
    const b = await req.json().catch(() => ({}));
    if (action === 'users') {
      const users = this.all(`SELECT u.id, u.username, u.display, u.created,
          (SELECT COUNT(*) FROM messages m WHERE m.user_id=u.id) AS messages,
          (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.user_id=u.id) AS bytes,
          (SELECT COUNT(*) FROM group_members g WHERE g.user_id=u.id) AS groups
        FROM users u WHERE u.pass!='' ORDER BY u.id`);
      return json({ users: users.map((u) => ({ ...u, online: this.sockets(u.id).length > 0 })) });
    }
    const u = this.get('SELECT * FROM users WHERE username=?', str(b.username, 40));
    if (!u || this.isGone(u.id)) throw new Err('Diesen Benutzernamen gibt es nicht.');
    if (action === 'delete') {
      this.deleteAccount(u, null);
      return json({ ok: true });
    }
    if (action === 'password') {
      const pw = String(b.password ?? '');
      if (pw.length < 6 || pw.length > 200) throw new Err('Das Passwort braucht mindestens 6 Zeichen.');
      const salt = rand(16);
      this.run('UPDATE users SET pass=?, salt=? WHERE id=?', await pbkdf(pw, salt), salt, u.id);
      this.logoutEverywhere(u.id, null);
      return json({ ok: true });
    }
    return json({ err: 'Nicht gefunden' }, 404);
  }

  // Beendet alle Sitzungen eines Kontos (außer der Verbindung "keep").
  logoutEverywhere(uid, keep) {
    this.run('DELETE FROM sessions WHERE user_id=?', uid);
    for (const sock of this.ctx.getWebSockets('u:' + uid)) {
      const att = sock.deserializeAttachment();
      if (sock === keep || !att || att.dead) continue;
      try { sock.send(JSON.stringify({ t: 'auth.fail' })); } catch {}
      this.reap(sock, att, 4001);
    }
  }

  // ICE-Server für den Sprachchat. STUN reicht in den meisten Heimnetzen. Ist ein TURN-Schlüssel von
  // Cloudflare Realtime hinterlegt (Secrets TURN_KEY_ID und TURN_KEY_TOKEN), klappen Anrufe auch hinter
  // strengen Firewalls – der Ton läuft dann notfalls über Cloudflare statt direkt von Gerät zu Gerät.
  async iceServers() {
    const stun = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
    const { TURN_KEY_ID: id, TURN_KEY_TOKEN: token } = this.env;
    if (!id || !token) return [stun];
    if (this.ice && this.ice.until > now()) return this.ice.list;
    try {
      const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
      });
      const data = await res.json();
      const turn = [].concat(data.iceServers || [])
        .filter((x) => x && x.username && x.credential)
        .map((x) => ({ urls: [].concat(x.urls).filter((u) => !/:53(\?|$)/.test(u)), username: x.username, credential: x.credential }));
      if (!turn.length) throw new Error('TURN: unerwartete Antwort ' + res.status);
      // Zugangsdaten gelten 24 Stunden; nach einer Stunde gibt es frische, damit kein Anruf mittendrin abläuft.
      this.ice = { list: [stun, ...turn], until: now() + 3600e3 };
      return this.ice.list;
    } catch (e) {
      console.error(e);
      return [stun];
    }
  }

  async newSession(uid) {
    const token = rand(32);
    this.run('INSERT INTO sessions(hash,user_id,created) VALUES(?,?,?)', await sha256(token), uid, now());
    return token;
  }

  async auth(token) {
    if (!token || token.length > 100) return null;
    const s = this.get('SELECT user_id FROM sessions WHERE hash=?', await sha256(token));
    return s ? s.user_id : null;
  }

  async upload(req, url) {
    const uid = await this.auth((req.headers.get('Authorization') || '').replace(/^Bearer /, ''));
    if (!uid) return json({ err: 'Nicht angemeldet' }, 401);
    if (Number(req.headers.get('Content-Length') || 0) > MAX_FILE) throw new Err('Die Datei ist größer als 10 MB.');
    const buf = await req.arrayBuffer();
    if (!buf.byteLength) throw new Err('Die Datei ist leer.');
    if (buf.byteLength > MAX_FILE) throw new Err('Die Datei ist größer als 10 MB.');
    const used = this.get('SELECT COALESCE(SUM(size),0) AS s FROM files WHERE user_id=?', uid).s;
    if (used + buf.byteLength > USER_QUOTA) throw new Err('Dein Speicherplatz (500 MB) ist voll.');
    if (!this.limit('up:' + uid, 30, 60e3)) throw new Err('Zu viele Uploads. Warte kurz.');
    const id = rand(16);
    const name = str(url.searchParams.get('name'), 120).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'datei';
    const type = str(req.headers.get('Content-Type'), 100) || 'application/octet-stream';
    this.run('INSERT INTO files(id,user_id,name,type,size,created) VALUES(?,?,?,?,?,?)', id, uid, name, type, buf.byteLength, now());
    for (let i = 0, off = 0; off < buf.byteLength; i++, off += CHUNK) {
      this.run('INSERT INTO file_chunks(file_id,idx,data) VALUES(?,?,?)', id, i, buf.slice(off, off + CHUNK));
    }
    return json({ id, name, type, size: buf.byteLength });
  }

  serveFile(id) {
    const f = this.get('SELECT * FROM files WHERE id=?', String(id || ''));
    if (!f) return new Response('Nicht gefunden', { status: 404, headers: CORS });
    const out = new Uint8Array(f.size);
    let off = 0;
    for (const row of this.sql.exec('SELECT data FROM file_chunks WHERE file_id=? ORDER BY idx', f.id)) {
      out.set(new Uint8Array(row.data), off);
      off += row.data.byteLength;
    }
    const inline = /^(image\/(png|jpeg|gif|webp|avif)|audio\/|video\/)/.test(f.type);
    return new Response(out, {
      headers: {
        ...CORS,
        'Content-Type': inline ? f.type : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      },
    });
  }

  // ---------- WebSocket ----------
  async openSocket(req, url) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket erwartet', { status: 426 });
    // Das Sitzungs-Token kommt als zweites "Subprotokoll" – so steht es in keiner Adresse und keinem Log.
    const offered = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((x) => x.trim());
    const uid = await this.auth(offered[1]);
    const [client, server] = Object.values(new WebSocketPair());
    const accept = () => new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'pc' } });
    if (!uid) {
      this.ctx.acceptWebSocket(server, []);
      server.send(JSON.stringify({ t: 'auth.fail' }));
      server.close(4001, 'auth');
      return accept();
    }
    const cid = rand(8);
    const wasOnline = this.sockets(uid).length > 0;
    this.ctx.acceptWebSocket(server, ['u:' + uid, 'c:' + cid]);
    server.serializeAttachment({ uid, cid, at: now(), voice: null, muted: false, deaf: false, screen: false });
    server.send(JSON.stringify(this.ready(uid, cid)));
    if (!wasOnline) this.pushUser(uid);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now() + SWEEP);
    return accept();
  }

  // Wecker: Verbindungen ohne Lebenszeichen (Rechner im Ruhezustand, Netz weg) gelten als offline.
  async alarm() {
    const cutoff = now() - STALE;
    let alive = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (!att?.uid) continue;
      if (att.dead) { try { ws.close(4000, 'timeout'); } catch {} continue; }
      const seen = Math.max(att.at || 0, this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0);
      if (seen < cutoff) this.reap(ws, att);
      else alive++;
    }
    if (alive) await this.ctx.storage.setAlarm(now() + SWEEP);
  }

  reap(ws, att, code = 4000) {
    ws.serializeAttachment({ ...att, dead: true, voice: null });
    if (att.voice) this.pushVoice(att.voice);
    if (!this.sockets(att.uid).length) this.pushUser(att.uid);
    try { ws.close(code, 'bye'); } catch {}
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > 100000) return;
    const att = ws.deserializeAttachment();
    if (!att?.uid || att.dead) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try {
      const rtc = m.t === 'rtc';
      if (!this.limit((rtc ? 'rtc:' : 'op:') + att.uid, rtc ? 800 : 80, 10000)) throw new Err('Zu viele Anfragen. Warte kurz.');
      const res = (await this.handle(ws, att, m)) || {};
      if (m.rid != null) ws.send(JSON.stringify({ re: m.rid, ok: true, ...res }));
    } catch (e) {
      if (!(e instanceof Err)) console.error(e);
      if (m.rid != null) ws.send(JSON.stringify({ re: m.rid, err: e instanceof Err ? e.message : 'Serverfehler' }));
    }
  }

  webSocketClose(ws) { this.dropSocket(ws); try { ws.close(1000); } catch {} }
  webSocketError(ws) { this.dropSocket(ws); }

  dropSocket(ws) {
    const att = ws.deserializeAttachment();
    if (!att?.uid || att.dead) return;
    this.gone = ws;
    try {
      if (att.voice) this.pushVoice(att.voice);
      if (!this.sockets(att.uid).length) this.pushUser(att.uid);
    } finally { this.gone = null; }
  }

  sockets(uid) { return this.ctx.getWebSockets('u:' + uid).filter((w) => w !== this.gone && !w.deserializeAttachment()?.dead); }

  toUsers(uids, obj, except) {
    const s = JSON.stringify(obj);
    for (const uid of new Set(uids)) {
      for (const ws of this.sockets(uid)) {
        if (ws !== except) try { ws.send(s); } catch {}
      }
    }
  }

  // ---------- Daten-Helfer ----------
  pub(u) {
    if (!u) return null;
    const online = this.sockets(u.id).length > 0;
    return {
      id: u.id, username: u.username, display: u.display, color: u.color, avatar: u.avatar, custom: u.custom,
      status: online && u.status !== 'invisible' ? u.status : 'offline',
    };
  }
  isGone(id) { return !this.get("SELECT 1 AS x FROM users WHERE id=? AND pass!=''", id); }
  user(id) { return this.pub(this.get('SELECT * FROM users WHERE id=?', id)); }
  users(ids) {
    const list = [...new Set(ids)];
    if (!list.length) return [];
    return this.all(`SELECT * FROM users WHERE id IN (${list.map(() => '?').join(',')})`, ...list).map((u) => this.pub(u));
  }

  related(uid) {
    return this.all(
      `SELECT b AS id FROM friends WHERE a=? UNION SELECT a FROM friends WHERE b=?
       UNION SELECT m2.user_id FROM group_members m1 JOIN group_members m2 ON m1.group_id=m2.group_id WHERE m1.user_id=?
       UNION SELECT ub FROM chats WHERE type='dm' AND ua=? UNION SELECT ua FROM chats WHERE type='dm' AND ub=?`,
      uid, uid, uid, uid, uid).map((r) => r.id);
  }

  pushUser(uid) {
    const user = this.user(uid);
    if (user) this.toUsers([uid, ...this.related(uid)], { t: 'user', user });
  }

  access(uid, chatId) {
    const chat = this.get('SELECT * FROM chats WHERE id=?', int(chatId));
    if (!chat) return null;
    if (chat.type === 'dm') return chat.ua === uid || chat.ub === uid ? { chat, members: [chat.ua, chat.ub] } : null;
    const members = this.all('SELECT user_id FROM group_members WHERE group_id=?', chat.group_id).map((r) => r.user_id);
    return members.includes(uid) ? { chat, members } : null;
  }
  need(uid, chatId) {
    const acc = this.access(uid, chatId);
    if (!acc) throw new Err('Kein Zugriff auf diesen Chat.');
    return acc;
  }

  group(gid) {
    const g = this.get('SELECT * FROM groups WHERE id=?', gid);
    if (!g) return null;
    return {
      id: g.id, name: g.name, icon: g.icon, owner: g.owner_id, invite: g.invite,
      channels: this.all('SELECT id,name,kind FROM chats WHERE group_id=? ORDER BY pos,id', gid),
      members: this.all('SELECT user_id FROM group_members WHERE group_id=? ORDER BY joined', gid).map((r) => r.user_id),
    };
  }
  pushGroup(gid) {
    const group = this.group(gid);
    if (group) this.toUsers(group.members, { t: 'group', group, users: this.users(group.members) });
    return group;
  }
  ownGroup(uid, gid) {
    const g = this.get('SELECT * FROM groups WHERE id=?', int(gid));
    if (!g || g.owner_id !== uid) throw new Err('Das darf nur der Besitzer der Gruppe.');
    return g;
  }

  friendState(uid, other) {
    const out = this.get('SELECT state FROM friends WHERE a=? AND b=?', uid, other);
    const inc = this.get('SELECT state FROM friends WHERE a=? AND b=?', other, uid);
    if (out?.state === 'accepted' || inc?.state === 'accepted') return 'friends';
    if (out) return 'outgoing';
    if (inc) return 'incoming';
    return 'none';
  }
  pushFriend(a, b) {
    this.toUsers([a], { t: 'friend', id: b, state: this.friendState(a, b), users: this.users([b]) });
    this.toUsers([b], { t: 'friend', id: a, state: this.friendState(b, a), users: this.users([a]) });
  }

  msgs(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    const reacts = new Map();
    for (const r of this.all(`SELECT message_id,user_id,emoji FROM reactions WHERE message_id IN (${marks})`, ...ids)) {
      const list = reacts.get(r.message_id) || [];
      let e = list.find((x) => x.emoji === r.emoji);
      if (!e) list.push((e = { emoji: r.emoji, users: [] }));
      e.users.push(r.user_id);
      reacts.set(r.message_id, list);
    }
    const replyIds = [...new Set(rows.map((r) => r.reply_to).filter(Boolean))];
    const replies = new Map();
    if (replyIds.length) {
      for (const r of this.all(`SELECT id,user_id,content,files FROM messages WHERE id IN (${replyIds.map(() => '?').join(',')})`, ...replyIds)) {
        replies.set(r.id, { id: r.id, user: r.user_id, content: r.content.slice(0, 120) || (r.files ? 'Anhang' : '') });
      }
    }
    return rows.map((r) => ({
      id: r.id, chat: r.chat_id, user: r.user_id, content: r.content, files: r.files ? JSON.parse(r.files) : [],
      reply: r.reply_to ? replies.get(r.reply_to) || { id: r.reply_to, gone: true } : null,
      created: r.created, edited: r.edited, reactions: reacts.get(r.id) || [],
    }));
  }

  // Löscht eine Datei, sobald sie nirgends mehr gebraucht wird (Nachricht, Profilbild, Gruppenbild).
  dropFile(id) {
    if (!id) return;
    if (this.get('SELECT 1 AS x FROM users WHERE avatar=? LIMIT 1', id) || this.get('SELECT 1 AS x FROM groups WHERE icon=? LIMIT 1', id)
      || this.get('SELECT 1 AS x FROM messages WHERE files LIKE ? LIMIT 1', '%' + id + '%')) return;
    this.run('DELETE FROM file_chunks WHERE file_id=?', id);
    this.run('DELETE FROM files WHERE id=?', id);
  }
  dropFiles(list) {
    for (const filesJson of list) if (filesJson) for (const f of JSON.parse(filesJson)) this.dropFile(f.id);
  }
  deleteChat(chatId) {
    const files = this.all('SELECT files FROM messages WHERE chat_id=? AND files IS NOT NULL', chatId).map((r) => r.files);
    this.run('DELETE FROM reactions WHERE message_id IN (SELECT id FROM messages WHERE chat_id=?)', chatId);
    this.run('DELETE FROM messages WHERE chat_id=?', chatId);
    this.dropFiles(files);
    this.run('DELETE FROM reads WHERE chat_id=?', chatId);
    this.run('DELETE FROM chats WHERE id=?', chatId);
    this.kickVoice((a) => a.voice === chatId);
  }
  deleteGroup(gid) {
    const members = this.all('SELECT user_id FROM group_members WHERE group_id=?', gid).map((r) => r.user_id);
    for (const c of this.all('SELECT id FROM chats WHERE group_id=?', gid)) this.deleteChat(c.id);
    const icon = this.get('SELECT icon FROM groups WHERE id=?', gid)?.icon;
    this.run('DELETE FROM group_members WHERE group_id=?', gid);
    this.run('DELETE FROM groups WHERE id=?', gid);
    this.dropFile(icon);
    this.toUsers(members, { t: 'group.gone', id: gid });
  }
  // Löscht ein Konto: raus aus allen Gruppen, Freundschaften und Sitzungen weg. Nachrichten bleiben stehen,
  // gehören aber nur noch einem namenlosen "Gelöschten Konto". Die Verbindung "keep" darf noch die Antwort erhalten.
  deleteAccount(u, keep) {
    const uid = u.id;
    const audience = this.related(uid); // alle, die das Konto kannten, erfahren von der Löschung
    for (const r of this.all('SELECT group_id FROM group_members WHERE user_id=?', uid)) this.leaveGroup(r.group_id, uid);
    const friends = this.all('SELECT a,b FROM friends WHERE a=? OR b=?', uid, uid).map((r) => (r.a === uid ? r.b : r.a));
    this.run('DELETE FROM friends WHERE a=? OR b=?', uid, uid);
    this.run('DELETE FROM sessions WHERE user_id=?', uid);
    this.run("UPDATE users SET username=?, display='Gelöschtes Konto', pass='', salt='', color='#5d726c', avatar=NULL, custom='', status='invisible' WHERE id=?", '~' + uid, uid);
    this.dropFile(u.avatar);
    // Unterhaltungen, in denen nie etwas stand oder deren Gegenüber auch schon weg ist, verschwinden ganz.
    for (const c of this.all("SELECT id,ua,ub FROM chats WHERE type='dm' AND (ua=? OR ub=?)", uid, uid)) {
      const empty = !this.get('SELECT 1 AS x FROM messages WHERE chat_id=? LIMIT 1', c.id);
      if (empty || this.isGone(c.ua === uid ? c.ub : c.ua)) this.deleteChat(c.id);
    }
    for (const other of friends) this.toUsers([other], { t: 'friend', id: uid, state: 'none', users: [] });
    for (const sock of this.ctx.getWebSockets('u:' + uid)) {
      const att = sock.deserializeAttachment();
      if (!att || att.dead) continue;
      if (sock === keep) {
        sock.serializeAttachment({ ...att, dead: true, voice: null });
        if (att.voice) this.pushVoice(att.voice);
      } else {
        try { sock.send(JSON.stringify({ t: 'auth.fail' })); } catch {}
        this.reap(sock, att, 4001);
      }
    }
    this.toUsers([uid, ...audience], { t: 'user', user: this.user(uid) });
    this.purgeGone();
  }
  // Gelöschte Konten, von denen weder Nachrichten noch Unterhaltungen übrig sind, restlos entfernen.
  purgeGone() {
    this.run(`DELETE FROM users WHERE pass='' AND id NOT IN (SELECT user_id FROM messages)
      AND id NOT IN (SELECT ua FROM chats WHERE type='dm') AND id NOT IN (SELECT ub FROM chats WHERE type='dm')`);
    this.run('DELETE FROM reactions WHERE user_id NOT IN (SELECT id FROM users)');
    this.run('DELETE FROM reads WHERE user_id NOT IN (SELECT id FROM users)');
    this.run('DELETE FROM friends WHERE a NOT IN (SELECT id FROM users) OR b NOT IN (SELECT id FROM users)');
  }
  // Entfernt ein Mitglied. Geht der Besitzer, übernimmt das dienstälteste Mitglied; ist niemand mehr da, wird die Gruppe gelöscht.
  leaveGroup(gid, target) {
    const g = this.get('SELECT * FROM groups WHERE id=?', gid);
    if (!g || !this.get('SELECT 1 AS x FROM group_members WHERE group_id=? AND user_id=?', gid, target)) return;
    this.run('DELETE FROM group_members WHERE group_id=? AND user_id=?', gid, target);
    const chans = this.all('SELECT id FROM chats WHERE group_id=?', gid).map((c) => c.id);
    this.kickVoice((a) => a.uid === target && chans.includes(a.voice));
    for (const id of chans) this.run('DELETE FROM reads WHERE chat_id=? AND user_id=?', id, target);
    this.toUsers([target], { t: 'group.gone', id: gid });
    if (g.owner_id === target) {
      const next = this.get('SELECT user_id FROM group_members WHERE group_id=? ORDER BY joined LIMIT 1', gid);
      if (!next) return this.deleteGroup(gid);
      this.run('UPDATE groups SET owner_id=? WHERE id=?', next.user_id, gid);
    }
    this.pushGroup(gid);
  }

  // ---------- Sprache ----------
  voiceList(chatId) {
    const list = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === this.gone) continue;
      const a = ws.deserializeAttachment();
      if (a?.voice === chatId) list.push({ cid: a.cid, uid: a.uid, muted: a.muted, deaf: a.deaf, screen: a.screen });
    }
    return list;
  }
  pushVoice(chatId) {
    const acc = this.get('SELECT id FROM chats WHERE id=?', chatId) && this.accessMembers(chatId);
    if (acc) this.toUsers(acc, { t: 'voice', chat: chatId, list: this.voiceList(chatId) });
  }
  accessMembers(chatId) {
    const chat = this.get('SELECT * FROM chats WHERE id=?', chatId);
    if (!chat) return null;
    if (chat.type === 'dm') return [chat.ua, chat.ub];
    return this.all('SELECT user_id FROM group_members WHERE group_id=?', chat.group_id).map((r) => r.user_id);
  }
  leaveVoice(ws, att) {
    const chat = att.voice;
    if (!chat) return;
    ws.serializeAttachment({ ...att, voice: null, screen: false });
    this.pushVoice(chat);
  }
  // Wirft alle Sockets aus dem Sprachkanal, auf die der Filter passt.
  kickVoice(match) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.voice && match(a)) {
        const chat = a.voice;
        ws.serializeAttachment({ ...a, voice: null, screen: false });
        try { ws.send(JSON.stringify({ t: 'voice.kick' })); } catch {}
        this.pushVoice(chat);
      }
    }
  }

  // ---------- Startpaket ----------
  ready(uid, cid) {
    const meRow = this.get('SELECT * FROM users WHERE id=?', uid);
    const friends = [];
    const ids = new Set(this.related(uid));
    for (const r of this.all('SELECT a,b FROM friends WHERE a=? OR b=?', uid, uid)) {
      const other = r.a === uid ? r.b : r.a;
      if (!friends.some((f) => f.id === other)) friends.push({ id: other, state: this.friendState(uid, other) });
    }
    const dms = this.all("SELECT id,ua,ub FROM chats WHERE type='dm' AND (ua=? OR ub=?)", uid, uid)
      .map((c) => ({ id: c.id, user: c.ua === uid ? c.ub : c.ua }));
    const groups = this.all('SELECT group_id FROM group_members WHERE user_id=? ORDER BY joined', uid).map((r) => this.group(r.group_id));
    const chatIds = [...dms.map((d) => d.id), ...groups.flatMap((g) => g.channels.map((c) => c.id))];
    const reads = {};
    const voice = {};
    for (const id of chatIds) {
      const read = this.get('SELECT last_read FROM reads WHERE chat_id=? AND user_id=?', id, uid)?.last_read || 0;
      const last = this.get('SELECT MAX(id) AS m FROM messages WHERE chat_id=?', id).m || 0;
      const unread = last > read
        ? this.get('SELECT COUNT(*) AS c FROM messages WHERE chat_id=? AND id>? AND user_id!=?', id, read, uid).c : 0;
      reads[id] = { last, unread };
    }
    const allowed = new Set(chatIds);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.voice && allowed.has(a.voice)) (voice[a.voice] ||= []).push({ cid: a.cid, uid: a.uid, muted: a.muted, deaf: a.deaf, screen: a.screen });
    }
    ids.delete(uid);
    return {
      t: 'ready', cid, me: { ...this.pub(meRow), status: meRow.status }, users: this.users([...ids]),
      friends, dms, groups, reads, voice,
    };
  }

  // ---------- Befehle ----------
  async handle(ws, att, m) {
    const uid = att.uid;
    switch (m.t) {
      case 'msg.send': {
        if (!this.limit('msg:' + uid, 12, 8000)) throw new Err('Du schreibst zu schnell. Warte kurz.');
        const { chat, members } = this.need(uid, m.chat);
        if (chat.kind === 'voice') throw new Err('In Sprachkanälen kann man nicht schreiben.');
        if (chat.type === 'dm' && this.isGone(chat.ua === uid ? chat.ub : chat.ua)) throw new Err('Dieses Konto wurde gelöscht.');
        const content = str(m.content, 4000);
        const files = [];
        for (const fid of Array.isArray(m.files) ? m.files.slice(0, 10) : []) {
          const f = this.get('SELECT id,name,type,size FROM files WHERE id=? AND user_id=?', String(fid), uid);
          if (f) files.push(f);
        }
        if (!content && !files.length) throw new Err('Die Nachricht ist leer.');
        const reply = m.reply && this.get('SELECT id FROM messages WHERE id=? AND chat_id=?', int(m.reply), chat.id) ? int(m.reply) : null;
        const row = this.get('INSERT INTO messages(chat_id,user_id,content,files,reply_to,created) VALUES(?,?,?,?,?,?) RETURNING *',
          chat.id, uid, content, files.length ? JSON.stringify(files) : null, reply, now());
        this.run('INSERT OR REPLACE INTO reads(chat_id,user_id,last_read) VALUES(?,?,?)', chat.id, uid, row.id);
        const msg = this.msgs([row])[0];
        this.toUsers(members, { t: 'msg', msg });
        return { msg };
      }
      case 'msg.edit': {
        const row = this.get('SELECT * FROM messages WHERE id=?', int(m.id));
        if (!row || row.user_id !== uid) throw new Err('Du kannst nur eigene Nachrichten bearbeiten.');
        const { members } = this.need(uid, row.chat_id);
        const content = str(m.content, 4000);
        if (!content && !row.files) throw new Err('Die Nachricht ist leer.');
        const edited = now();
        this.run('UPDATE messages SET content=?, edited=? WHERE id=?', content, edited, row.id);
        this.toUsers(members, { t: 'msg.edit', chat: row.chat_id, id: row.id, content, edited });
        return;
      }
      case 'msg.delete': {
        const row = this.get('SELECT * FROM messages WHERE id=?', int(m.id));
        if (!row) return;
        const { chat, members } = this.need(uid, row.chat_id);
        const owner = chat.group_id && this.get('SELECT owner_id FROM groups WHERE id=?', chat.group_id)?.owner_id === uid;
        if (row.user_id !== uid && !owner) throw new Err('Du kannst diese Nachricht nicht löschen.');
        this.run('DELETE FROM reactions WHERE message_id=?', row.id);
        this.run('DELETE FROM messages WHERE id=?', row.id);
        this.dropFiles([row.files]);
        this.toUsers(members, { t: 'msg.delete', chat: row.chat_id, id: row.id });
        return;
      }
      case 'msg.history': {
        const { chat } = this.need(uid, m.chat);
        const before = int(m.before) || Number.MAX_SAFE_INTEGER;
        const rows = this.all('SELECT * FROM messages WHERE chat_id=? AND id<? ORDER BY id DESC LIMIT 50', chat.id, before).reverse();
        return { msgs: this.msgs(rows), users: this.users(rows.map((r) => r.user_id)), done: rows.length < 50 };
      }
      case 'react': {
        const row = this.get('SELECT id,chat_id FROM messages WHERE id=?', int(m.id));
        if (!row) return;
        const { members } = this.need(uid, row.chat_id);
        const emoji = str(m.emoji, 16);
        if (!emoji) return;
        const has = this.get('SELECT 1 AS x FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', row.id, uid, emoji);
        if (has) this.run('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?', row.id, uid, emoji);
        else {
          if (this.get('SELECT COUNT(DISTINCT emoji) AS c FROM reactions WHERE message_id=?', row.id).c >= 20) throw new Err('Mehr Reaktionen passen nicht auf eine Nachricht.');
          this.run('INSERT INTO reactions(message_id,user_id,emoji) VALUES(?,?,?)', row.id, uid, emoji);
        }
        this.toUsers(members, { t: 'react', chat: row.chat_id, id: row.id, emoji, user: uid, on: !has });
        return;
      }
      case 'typing': {
        const { chat, members } = this.need(uid, m.chat);
        this.toUsers(members.filter((x) => x !== uid), { t: 'typing', chat: chat.id, user: uid });
        return;
      }
      case 'read': {
        const { chat } = this.need(uid, m.chat);
        const last = this.get('SELECT MAX(id) AS m FROM messages WHERE chat_id=?', chat.id).m || 0;
        this.run('INSERT OR REPLACE INTO reads(chat_id,user_id,last_read) VALUES(?,?,?)', chat.id, uid, last);
        this.toUsers([uid], { t: 'read', chat: chat.id }, ws);
        return;
      }

      case 'friend.add': {
        const other = this.get('SELECT id FROM users WHERE username=?', str(m.username, 40).replace(/^@/, ''));
        if (!other || this.isGone(other.id)) throw new Err('Diesen Benutzernamen gibt es nicht.');
        if (other.id === uid) throw new Err('Das bist du selbst.');
        const state = this.friendState(uid, other.id);
        if (state === 'friends') throw new Err('Ihr seid schon befreundet.');
        if (state === 'outgoing') throw new Err('Die Anfrage ist schon unterwegs.');
        if (state === 'incoming') this.run("UPDATE friends SET state='accepted' WHERE a=? AND b=?", other.id, uid);
        else this.run("INSERT INTO friends(a,b,state) VALUES(?,?,'pending')", uid, other.id);
        this.pushFriend(uid, other.id);
        this.pushUser(uid); this.pushUser(other.id);
        return;
      }
      case 'friend.accept': {
        const other = int(m.user);
        if (this.friendState(uid, other) !== 'incoming') throw new Err('Diese Anfrage gibt es nicht mehr.');
        this.run("UPDATE friends SET state='accepted' WHERE a=? AND b=?", other, uid);
        this.pushFriend(uid, other);
        return;
      }
      case 'friend.remove': {
        const other = int(m.user);
        this.run('DELETE FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)', uid, other, other, uid);
        this.pushFriend(uid, other);
        return;
      }
      case 'dm.open': {
        const other = int(m.user);
        if (other === uid || !this.get('SELECT id FROM users WHERE id=?', other)) throw new Err('Diesen Benutzer gibt es nicht.');
        const [ua, ub] = uid < other ? [uid, other] : [other, uid];
        let chat = this.get("SELECT id FROM chats WHERE type='dm' AND ua=? AND ub=?", ua, ub);
        if (!chat) {
          if (!this.related(uid).includes(other)) throw new Err('Ihr müsst befreundet sein oder eine Gruppe teilen.');
          chat = this.get("INSERT INTO chats(type,ua,ub) VALUES('dm',?,?) RETURNING id", ua, ub);
          this.toUsers([other], { t: 'dm', dm: { id: chat.id, user: uid }, users: this.users([uid]) });
          this.toUsers([uid], { t: 'dm', dm: { id: chat.id, user: other }, users: this.users([other]) }, ws);
        }
        return { dm: { id: chat.id, user: other }, users: this.users([other]) };
      }

      case 'group.create': {
        const name = str(m.name, 40);
        if (!name) throw new Err('Die Gruppe braucht einen Namen.');
        if (this.get('SELECT COUNT(*) AS c FROM group_members WHERE user_id=?', uid).c >= 50) throw new Err('Du bist schon in 50 Gruppen.');
        const g = this.get('INSERT INTO groups(name,owner_id,invite,created) VALUES(?,?,?,?) RETURNING id', name, uid, rand(4), now());
        this.run('INSERT INTO group_members(group_id,user_id,joined) VALUES(?,?,?)', g.id, uid, now());
        this.run("INSERT INTO chats(type,group_id,name,kind,pos) VALUES('channel',?,?,'text',0)", g.id, 'allgemein');
        this.run("INSERT INTO chats(type,group_id,name,kind,pos) VALUES('channel',?,?,'voice',1)", g.id, 'Sprechzimmer');
        return { group: this.pushGroup(g.id) };
      }
      case 'group.join': {
        const code = str(m.invite, 200).split('/').pop().toLowerCase();
        const g = this.get('SELECT id FROM groups WHERE invite=?', code);
        if (!g) throw new Err('Dieser Einladungscode ist ungültig.');
        if (!this.limit('join:' + uid, 20, 600e3)) throw new Err('Zu viele Versuche. Warte kurz.');
        if (!this.get('SELECT 1 AS x FROM group_members WHERE group_id=? AND user_id=?', g.id, uid)) {
          if (this.get('SELECT COUNT(*) AS c FROM group_members WHERE group_id=?', g.id).c >= 200) throw new Err('Die Gruppe ist voll.');
          this.run('INSERT INTO group_members(group_id,user_id,joined) VALUES(?,?,?)', g.id, uid, now());
          for (const c of this.all('SELECT id FROM chats WHERE group_id=?', g.id)) {
            const last = this.get('SELECT MAX(id) AS m FROM messages WHERE chat_id=?', c.id).m || 0;
            this.run('INSERT OR REPLACE INTO reads(chat_id,user_id,last_read) VALUES(?,?,?)', c.id, uid, last);
          }
        }
        const group = this.pushGroup(g.id);
        const voice = {};
        for (const c of group.channels) { const l = this.voiceList(c.id); if (l.length) voice[c.id] = l; }
        return { group, users: this.users(group.members), voice };
      }
      case 'group.update': {
        const g = this.ownGroup(uid, m.group);
        const name = m.name !== undefined ? str(m.name, 40) : g.name;
        if (!name) throw new Err('Die Gruppe braucht einen Namen.');
        let icon = g.icon;
        if (m.icon !== undefined) icon = m.icon && this.get('SELECT id FROM files WHERE id=? AND user_id=?', String(m.icon), uid) ? String(m.icon) : null;
        const invite = m.newInvite ? rand(4) : g.invite;
        this.run('UPDATE groups SET name=?, icon=?, invite=? WHERE id=?', name, icon, invite, g.id);
        if (icon !== g.icon) this.dropFile(g.icon);
        this.pushGroup(g.id);
        return;
      }
      case 'group.delete': {
        this.deleteGroup(this.ownGroup(uid, m.group).id);
        return;
      }
      case 'group.leave': {
        this.leaveGroup(int(m.group), uid);
        return;
      }
      case 'group.kick': {
        const g = this.ownGroup(uid, m.group);
        if (int(m.user) === uid) throw new Err('Du kannst dich nicht selbst entfernen.');
        this.leaveGroup(g.id, int(m.user));
        return;
      }
      case 'channel.create': {
        const g = this.ownGroup(uid, m.group);
        const name = str(m.name, 32);
        if (!name) throw new Err('Der Kanal braucht einen Namen.');
        if (this.get('SELECT COUNT(*) AS c FROM chats WHERE group_id=?', g.id).c >= 50) throw new Err('Mehr als 50 Kanäle gehen nicht.');
        const pos = (this.get('SELECT MAX(pos) AS p FROM chats WHERE group_id=?', g.id).p || 0) + 1;
        this.run("INSERT INTO chats(type,group_id,name,kind,pos) VALUES('channel',?,?,?,?)", g.id, name, m.kind === 'voice' ? 'voice' : 'text', pos);
        this.pushGroup(g.id);
        return;
      }
      case 'channel.update':
      case 'channel.delete': {
        const chat = this.get("SELECT * FROM chats WHERE id=? AND type='channel'", int(m.chat));
        if (!chat) return;
        this.ownGroup(uid, chat.group_id);
        if (m.t === 'channel.delete') this.deleteChat(chat.id);
        else {
          const name = str(m.name, 32);
          if (!name) throw new Err('Der Kanal braucht einen Namen.');
          this.run('UPDATE chats SET name=? WHERE id=?', name, chat.id);
        }
        this.pushGroup(chat.group_id);
        return;
      }

      case 'profile.update': {
        const u = this.get('SELECT * FROM users WHERE id=?', uid);
        const display = m.display !== undefined ? str(m.display, 32) || u.username : u.display;
        const color = /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : u.color;
        const custom = m.custom !== undefined ? str(m.custom, 80) : u.custom;
        const status = STATUSES.includes(m.status) ? m.status : u.status;
        let avatar = u.avatar;
        if (m.avatar !== undefined) {
          avatar = m.avatar && this.get('SELECT id FROM files WHERE id=? AND user_id=?', String(m.avatar), uid) ? String(m.avatar) : null;
        }
        this.run('UPDATE users SET display=?, color=?, custom=?, status=?, avatar=? WHERE id=?', display, color, custom, status, avatar, uid);
        if (avatar !== u.avatar) this.dropFile(u.avatar);
        this.pushUser(uid);
        this.toUsers([uid], { t: 'me', status });
        return;
      }
      case 'password.change': {
        const u = this.get('SELECT * FROM users WHERE id=?', uid);
        if ((await pbkdf(String(m.old ?? ''), u.salt)) !== u.pass) throw new Err('Das aktuelle Passwort stimmt nicht.');
        const pw = String(m.new ?? '');
        if (pw.length < 6 || pw.length > 200) throw new Err('Das Passwort braucht mindestens 6 Zeichen.');
        const salt = rand(16);
        this.run('UPDATE users SET pass=?, salt=? WHERE id=?', await pbkdf(pw, salt), salt, uid);
        this.logoutEverywhere(uid, ws);
        return { token: await this.newSession(uid) };
      }
      case 'account.delete': {
        const u = this.get('SELECT * FROM users WHERE id=?', uid);
        if ((await pbkdf(String(m.password ?? ''), u.salt)) !== u.pass) throw new Err('Das Passwort stimmt nicht.');
        this.deleteAccount(u, ws);
        return;
      }

      case 'voice.join': {
        const ice = await this.iceServers();
        att = ws.deserializeAttachment(); // könnte sich während der Abfrage geändert haben
        if (!att || att.dead) return;
        const { chat, members } = this.need(uid, m.chat);
        if (chat.type !== 'dm' && chat.kind !== 'voice') throw new Err('Das ist kein Sprachkanal.');
        if (chat.type === 'dm' && this.isGone(chat.ua === uid ? chat.ub : chat.ua)) throw new Err('Dieses Konto wurde gelöscht.');
        if (att.voice === chat.id) return { list: this.voiceList(chat.id), ice };
        if (att.voice) this.leaveVoice(ws, att);
        const before = this.voiceList(chat.id);
        if (before.length >= 12) throw new Err('Der Sprachkanal ist voll (12 Personen).');
        ws.serializeAttachment({ ...att, voice: chat.id, muted: !!m.muted, deaf: !!m.deaf, screen: false });
        this.pushVoice(chat.id);
        if (chat.type === 'dm' && !before.length) this.toUsers(members.filter((x) => x !== uid), { t: 'ring', chat: chat.id, from: uid });
        return { list: this.voiceList(chat.id), ice };
      }
      case 'voice.leave': {
        this.leaveVoice(ws, att);
        return;
      }
      case 'voice.state': {
        if (!att.voice) return;
        ws.serializeAttachment({ ...att, muted: !!m.muted, deaf: !!m.deaf, screen: !!m.screen });
        this.pushVoice(att.voice);
        return;
      }
      case 'rtc': {
        if (!att.voice) return;
        const peer = this.ctx.getWebSockets('c:' + str(m.to, 32))[0];
        if (peer && peer.deserializeAttachment()?.voice === att.voice) {
          try { peer.send(JSON.stringify({ t: 'rtc', from: att.cid, data: m.data })); } catch {}
        }
        return;
      }
      default:
        throw new Err('Unbekannter Befehl.');
    }
  }
}
