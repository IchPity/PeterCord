// Sprachchat und Bildschirmübertragung über WebRTC (direkt von Gerät zu Gerät, der Server vermittelt nur).
import { net, req, push } from './net.js';

// Standard, falls der Server nichts Besseres mitschickt (er liefert zusätzlich TURN, wenn eingerichtet).
const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let ice = DEFAULT_ICE;

export const voice = {
  chat: null,
  peers: new Map(), // cid -> { pc, audio, screen, ... }
  local: null,
  screen: null,
  muted: false,
  deaf: false,
  speaking: new Set(),
  settings: () => ({}),
  volumeOf: () => 1, // Lautstärke (0–1) für eine Verbindung, von der Oberfläche gesetzt
  onChange: () => {},
  onSpeak: () => {},
};

let actx = null;
let meterTimer = null;
const meters = new Map(); // cid -> analyser

function addMeter(cid, stream) {
  try {
    actx ||= new AudioContext();
    if (actx.state === 'suspended') actx.resume();
    const an = actx.createAnalyser();
    an.fftSize = 256;
    actx.createMediaStreamSource(stream).connect(an);
    meters.set(cid, { an, buf: new Uint8Array(an.fftSize), hold: 0 });
  } catch {}
}

function runMeters() {
  clearInterval(meterTimer);
  meterTimer = setInterval(() => {
    let changed = false;
    for (const [cid, m] of meters) {
      m.an.getByteTimeDomainData(m.buf);
      let peak = 0;
      for (let i = 0; i < m.buf.length; i += 4) peak = Math.max(peak, Math.abs(m.buf[i] - 128));
      const loud = peak > 6 && !(cid === net.cid && voice.muted);
      if (loud) m.hold = 3;
      else if (m.hold > 0) m.hold--;
      const on = m.hold > 0;
      if (on !== voice.speaking.has(cid)) {
        on ? voice.speaking.add(cid) : voice.speaking.delete(cid);
        changed = true;
      }
    }
    if (changed) voice.onSpeak();
  }, 150);
}

const signal = (to, data) => push('rtc', { to, data });

function makePeer(cid) {
  let p = voice.peers.get(cid);
  if (p) return p;
  const pc = new RTCPeerConnection({ iceServers: ice });
  p = { cid, pc, polite: net.cid > cid, making: false, ignore: false, audio: new Audio(), screen: null, screenSender: null };
  p.audio.autoplay = true;
  p.audio.muted = voice.deaf;
  p.audio.volume = voice.volumeOf(cid);
  const out = voice.settings().out;
  if (out && p.audio.setSinkId) p.audio.setSinkId(out).catch(() => {});
  voice.peers.set(cid, p);
  for (const t of voice.local.getTracks()) pc.addTrack(t, voice.local);
  if (voice.screen) p.screenSender = pc.addTrack(voice.screen.getVideoTracks()[0], voice.screen);
  pc.onnegotiationneeded = async () => {
    try {
      p.making = true;
      await pc.setLocalDescription();
      signal(cid, { description: pc.localDescription });
    } catch (e) { console.warn(e); } finally { p.making = false; }
  };
  pc.onicecandidate = ({ candidate }) => candidate && signal(cid, { candidate });
  pc.ontrack = ({ track, streams }) => {
    const stream = streams[0] || new MediaStream([track]);
    if (track.kind === 'audio') {
      p.audio.srcObject = stream;
      p.audio.play().catch(() => {});
      addMeter(cid, stream);
    } else {
      p.screen = stream;
      track.onunmute = () => { p.screen = stream; voice.onChange(); };
      voice.onChange();
    }
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
  return p;
}

function dropPeer(cid) {
  const p = voice.peers.get(cid);
  if (!p) return;
  p.pc.close();
  p.audio.srcObject = null;
  voice.peers.delete(cid);
  meters.delete(cid);
  voice.speaking.delete(cid);
}

export async function onRtc(from, data) {
  if (!voice.chat || !data) return;
  const p = makePeer(from);
  const pc = p.pc;
  try {
    if (data.description) {
      const d = data.description;
      const collision = d.type === 'offer' && (p.making || pc.signalingState !== 'stable');
      p.ignore = !p.polite && collision;
      if (p.ignore) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        signal(from, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignore) throw e; }
    }
  } catch (e) { console.warn('rtc', e); }
}

// Der Server schickt nach jeder Änderung die komplette Teilnehmerliste.
export function onList(list) {
  if (!voice.chat) return;
  const cids = new Set(list.map((x) => x.cid));
  for (const cid of [...voice.peers.keys()]) if (!cids.has(cid)) dropPeer(cid);
  for (const x of list) {
    const p = voice.peers.get(x.cid);
    if (p && !x.screen) p.screen = null;
  }
}

function applyMute() {
  if (voice.local) for (const t of voice.local.getAudioTracks()) t.enabled = !voice.muted && !voice.deaf;
  for (const p of voice.peers.values()) p.audio.muted = voice.deaf;
}

function sendState() {
  if (voice.chat) req('voice.state', { muted: voice.muted || voice.deaf, deaf: voice.deaf, screen: !!voice.screen }).catch(() => {});
  voice.onChange();
}

export async function join(chat) {
  if (voice.chat === chat) return;
  if (voice.chat) await leave();
  const s = voice.settings();
  const audio = { echoCancellation: true, noiseSuppression: s.ns !== false, autoGainControl: true };
  if (s.mic) audio.deviceId = { ideal: s.mic };
  try {
    voice.local = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch {
    throw new Error('Kein Zugriff auf das Mikrofon. Erlaube den Zugriff und prüfe, ob ein Mikrofon angeschlossen ist.');
  }
  applyMute();
  let res;
  try {
    res = await req('voice.join', { chat, muted: voice.muted || voice.deaf, deaf: voice.deaf });
  } catch (e) {
    voice.local.getTracks().forEach((t) => t.stop());
    voice.local = null;
    throw e;
  }
  voice.chat = chat;
  ice = Array.isArray(res.ice) && res.ice.length ? res.ice : DEFAULT_ICE;
  addMeter(net.cid, voice.local);
  runMeters();
  for (const x of res.list) if (x.cid !== net.cid) makePeer(x.cid);
  voice.onChange();
}

// local=true: Der Server weiß schon Bescheid (Verbindung weg oder aus dem Kanal entfernt).
export async function leave(local = false) {
  if (!voice.chat) return;
  voice.chat = null;
  if (!local) req('voice.leave').catch(() => {});
  clearInterval(meterTimer);
  for (const cid of [...voice.peers.keys()]) dropPeer(cid);
  meters.clear();
  // Der AudioContext für die Sprech-Anzeige würde sonst im Leerlauf weiterrechnen.
  actx?.close().catch(() => {});
  actx = null;
  voice.speaking.clear();
  voice.local?.getTracks().forEach((t) => t.stop());
  voice.screen?.getTracks().forEach((t) => t.stop());
  voice.local = voice.screen = null;
  voice.onChange();
}

export function toggleMute() {
  if (voice.deaf) voice.deaf = false;
  else voice.muted = !voice.muted;
  applyMute();
  sendState();
}

export function toggleDeaf() {
  voice.deaf = !voice.deaf;
  applyMute();
  sendState();
}

export async function toggleScreen() {
  if (!voice.chat) return;
  if (voice.screen) {
    for (const p of voice.peers.values()) {
      if (p.screenSender) { try { p.pc.removeTrack(p.screenSender); } catch {} p.screenSender = null; }
    }
    voice.screen.getTracks().forEach((t) => t.stop());
    voice.screen = null;
    return sendState();
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: 20 } }, audio: false });
  } catch {
    return; // Auswahl abgebrochen
  }
  if (!voice.chat) return stream.getTracks().forEach((t) => t.stop());
  voice.screen = stream;
  const track = stream.getVideoTracks()[0];
  track.onended = () => { if (voice.screen === stream) toggleScreen(); };
  for (const p of voice.peers.values()) p.screenSender = p.pc.addTrack(track, stream);
  sendState();
}

export function setOutput(id) {
  for (const p of voice.peers.values()) if (p.audio.setSinkId) p.audio.setSinkId(id || '').catch(() => {});
}
