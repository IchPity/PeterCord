// Sprachchat und Bildschirmübertragung über WebRTC (direkt von Gerät zu Gerät, der Server vermittelt nur).
import { net, req, push } from './net.js';

// Standard, falls der Server nichts Besseres mitschickt (er liefert zusätzlich TURN, wenn eingerichtet).
const DEFAULT_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let ice = DEFAULT_ICE;

export const voice = {
  chat: null,
  peers: new Map(), // cid -> { pc, audio, screen, ... }
  local: null, // der Ton, der an alle geht
  mic: null, // Mikrofon im Anruf (siehe openMic)
  test: null, // eigenes Mikrofon für den Test in den Einstellungen (nur außerhalb eines Anrufs)
  testLoop: null, // im Anruf: das Anruf-Mikrofon wird zum Testen mitgehört
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
    // Eigene Anzeige: grün, wenn wirklich gesendet wird (Empfindlichkeit überschritten, nicht stumm).
    if (voice.mic?.node) {
      const on = voice.mic.open && !voice.muted && !voice.deaf;
      if (on !== voice.speaking.has(net.cid)) {
        on ? voice.speaking.add(net.cid) : voice.speaking.delete(net.cid);
        changed = true;
      }
    }
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

// ---------- Mikrofon ----------
// Kette: Mikrofon → Gate-Worklet (Lautstärke, Empfindlichkeit, Pegel) → MediaStream, der an alle geht.
// Die Automatik der Empfindlichkeit (Spracherkennung, Grundrauschen) steckt komplett in gate-worklet.js.
// Ein Gerätewechsel tauscht nur den Anfang der Kette aus. Die gesendete Spur bleibt dieselbe,
// deshalb muss im laufenden Anruf nichts neu ausgehandelt werden.
async function rawMic() {
  const s = voice.settings();
  const audio = { echoCancellation: s.ec !== false, noiseSuppression: s.ns !== false, autoGainControl: s.agc !== false, channelCount: 1 };
  if (s.mic) audio.deviceId = { ideal: s.mic };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio, video: false });
  } catch (e) {
    throw new Error(micError(e));
  }
}

// Verständliche Meldung, warum das Mikrofon nicht aufgeht. inSettings: Die Meldung erscheint schon in den Sprach-Einstellungen.
export function micError(e, inSettings = false) {
  const n = e?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return (inSettings ? 'Der Zugriff ist noch gesperrt.' : 'PeterCord darf dein Mikrofon nicht benutzen. Erlauben kannst du es unter Einstellungen → Sprache & Video.')
      + ' Fragt PeterCord nicht mehr nach, gib das Mikrofon in den Windows-Einstellungen frei: Datenschutz und Sicherheit → Mikrofon.';
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Kein Mikrofon gefunden. Schließ ein Mikrofon oder Headset an.';
  if (n === 'NotReadableError' || n === 'AbortError') {
    return 'Das Mikrofon ist gerade blockiert – vielleicht benutzt es ein anderes Programm. Schließ das Programm oder wähl unter Einstellungen → Sprache & Video ein anderes Gerät.';
  }
  return 'Kein Zugriff auf das Mikrofon. Erlaube den Zugriff und prüfe, ob ein Mikrofon angeschlossen ist.';
}

function micParams(m) {
  const s = voice.settings();
  m.node?.port.postMessage({
    gain: Math.min(2, Math.max(0, s.inVol ?? 1)),
    auto: s.vadAuto !== false,
    th: s.vadTh ?? -50,
    muted: m === voice.mic && (voice.muted || voice.deaf),
  });
}

async function openMic() {
  const raw = await rawMic();
  const m = { raw, ctx: null, src: null, node: null, stream: raw, level: -100, open: true, th: -50 };
  try {
    m.ctx = new AudioContext();
    await m.ctx.audioWorklet.addModule(new URL('./gate-worklet.js', import.meta.url));
    m.node = new AudioWorkletNode(m.ctx, 'pc-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    m.node.port.onmessage = (e) => { m.level = e.data.level; m.open = e.data.open; m.th = e.data.th; };
    const dest = m.ctx.createMediaStreamDestination();
    m.node.connect(dest);
    m.src = m.ctx.createMediaStreamSource(raw);
    m.src.connect(m.node);
    m.stream = dest.stream;
    if (m.ctx.state === 'suspended') m.ctx.resume().catch(() => {});
    micParams(m);
  } catch (e) {
    // Ohne AudioWorklet geht es auch – dann eben ohne Lautstärke und Empfindlichkeit.
    console.warn('mic', e);
    m.ctx?.close().catch(() => {});
    m.ctx = m.node = m.src = null;
    m.stream = raw;
  }
  return m;
}

async function swapMicSource(m) {
  const raw = await rawMic();
  if (!m.node) {
    // Ohne Worklet: die Spur bei allen Verbindungen direkt austauschen.
    const track = raw.getAudioTracks()[0];
    if (m === voice.mic) {
      for (const p of voice.peers.values()) {
        for (const tx of p.pc.getSenders()) if (tx.track?.kind === 'audio') tx.replaceTrack(track).catch(() => {});
      }
    }
    m.raw.getTracks().forEach((t) => t.stop());
    m.raw = m.stream = raw;
    if (m === voice.mic) { voice.local = raw; applyMute(); addMeter(net.cid, raw); }
    return;
  }
  m.src?.disconnect();
  m.raw.getTracks().forEach((t) => t.stop());
  m.raw = raw;
  m.src = m.ctx.createMediaStreamSource(raw);
  m.src.connect(m.node);
  // Ein anderes Gerät oder eine andere Sprachverarbeitung rauscht anders: Die Automatik misst neu ein.
  m.node.port.postMessage({ reset: true });
}

function closeMic(m) {
  if (!m) return;
  m.raw.getTracks().forEach((t) => t.stop());
  m.stream.getTracks().forEach((t) => t.stop());
  m.ctx?.close().catch(() => {});
}

function testSink(m) {
  const out = voice.settings().out || '';
  if (m.ctx?.setSinkId) m.ctx.setSinkId(out).catch(() => {});
}

// Anderes Gerät oder geänderte Sprachverarbeitung: Mikrofon neu öffnen, ohne den Anruf zu unterbrechen.
export async function reloadMic() {
  for (const m of [voice.mic, voice.test]) if (m) await swapMicSource(m);
}

// Lautstärken und Empfindlichkeit sofort übernehmen.
export function applyAudio() {
  for (const m of [voice.mic, voice.test]) if (m) micParams(m);
  for (const p of voice.peers.values()) p.audio.volume = voice.volumeOf(p.cid);
}

// Mikrofontest: Man hört sich selbst. Im Anruf wird einfach das Anruf-Mikrofon mitgehört.
export async function micTest(on) {
  if (on) {
    if (voice.test || voice.testLoop) return;
    if (voice.mic?.node) {
      voice.mic.node.connect(voice.mic.ctx.destination);
      testSink(voice.mic);
      voice.testLoop = voice.mic;
      return;
    }
    const m = await openMic();
    if (m.node) m.node.connect(m.ctx.destination);
    testSink(m);
    voice.test = m;
  } else {
    if (voice.testLoop) {
      try { voice.testLoop.node.disconnect(voice.testLoop.ctx.destination); } catch {}
      voice.testLoop = null;
    }
    closeMic(voice.test);
    voice.test = null;
  }
}
export const testing = () => !!(voice.test || voice.testLoop);

// Aktueller Pegel für die Anzeige in den Einstellungen – aus dem Test oder dem laufenden Anruf.
// open: Das kommt gerade bei den anderen an. muted: im Anruf stummgeschaltet.
export function micLevel() {
  const m = voice.test || voice.mic;
  if (!m?.node) return null;
  const muted = m === voice.mic && (voice.muted || voice.deaf);
  return { level: m.level, open: m.open && !muted, th: m.th, muted };
}

function applyMute() {
  if (voice.local) for (const t of voice.local.getAudioTracks()) t.enabled = !voice.muted && !voice.deaf;
  if (voice.mic) micParams(voice.mic);
  for (const p of voice.peers.values()) p.audio.muted = voice.deaf;
}

function sendState() {
  if (voice.chat) req('voice.state', { muted: voice.muted || voice.deaf, deaf: voice.deaf, screen: !!voice.screen }).catch(() => {});
  voice.onChange();
}

export async function join(chat) {
  if (voice.chat === chat) return;
  if (voice.chat) await leave();
  if (voice.test) await micTest(false); // ein laufender Test gibt das Gerät frei
  const mic = await openMic();
  voice.mic = mic;
  voice.local = mic.stream;
  applyMute();
  let res;
  try {
    res = await req('voice.join', { chat, muted: voice.muted || voice.deaf, deaf: voice.deaf });
  } catch (e) {
    closeMic(mic);
    voice.mic = voice.local = null;
    throw e;
  }
  voice.chat = chat;
  ice = Array.isArray(res.ice) && res.ice.length ? res.ice : DEFAULT_ICE;
  if (!mic.node) addMeter(net.cid, mic.raw);
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
  // Die AudioContexts würden sonst im Leerlauf weiterrechnen.
  actx?.close().catch(() => {});
  actx = null;
  voice.speaking.clear();
  voice.testLoop = null;
  closeMic(voice.mic);
  voice.mic = null;
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
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { max: Number(voice.settings().fps) || 30 } }, audio: false });
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
  for (const m of [voice.test, voice.testLoop]) if (m) testSink(m);
}
