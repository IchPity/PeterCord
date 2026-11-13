// Der Quatsch-Teil: Sprüche, Slash-Befehle und Konfetti. PeterCord ist für Freunde – es darf albern sein.

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const TAGLINES = [
  'Der Chat für Leute, die sowieso nur Quatsch schreiben.',
  'Gegründet auf rotem Teppich. Seriosität: 0 %.',
  'Jetzt mit 100 % mehr Beweisfoto.',
  'Hier wird nichts gelöscht. Außer Würde.',
  'Kein Algorithmus, keine Werbung, nur ihr.',
  'Läuft auf Cloudflare und auf Hoffnung.',
  'Bitte nicht auf Discord zeigen, die sind eifersüchtig.',
  'Einer tippt, alle schreiben „haha“.',
];
export const tagline = () => pick(TAGLINES);

const GREETINGS = [
  (n) => `Moin, ${n}!`,
  (n) => `Na, ${n}? Wieder da?`,
  (n) => `Servus, ${n}!`,
  (n) => `${n} betritt den Chat. Applaus.`,
  (n) => `Schön, dass du da bist, ${n}.`,
  (n) => `Hallo ${n}, die anderen warten schon (nicht).`,
];
export const greeting = (name) => pick(GREETINGS)(name);

const PLACEHOLDERS = [
  'Schreib was Kluges … oder Quatsch',
  'Sag was. Irgendwas. Egal was.',
  'Tipp „/würfel“ und lass das Schicksal entscheiden',
  'Heute schon gelacht? Dann schreib es auf',
  'Tipp „/shrug“, wenn dir die Worte fehlen',
  'Ein „/konfetti“ hat noch niemandem geschadet',
];
export const placeholder = (base) => (Math.random() < 0.35 ? pick(PLACEHOLDERS) : base);

export const emptyOnline = () => pick([
  'Gerade ist niemand online. Peinlich still hier.',
  'Alle offline. Die Gelegenheit, endlich mal aufzuräumen.',
  'Keiner da. Du darfst laut Selbstgespräche führen.',
]);
export const emptyAll = () => pick([
  'Noch keine Freunde. Gib oben einen Benutzernamen ein, du schaffst das.',
  'Hier ist es leer wie der Kühlschrank nach dem Spieleabend. Freunde hinzufügen!',
]);
export const emptyRequests = () => pick([
  'Keine offenen Anfragen. Niemand will mit dir befreundet sein. (Scherz.)',
  'Keine Anfragen. Hast du schon allen den Link geschickt?',
]);
export const dmStart = (name, empty) => `Hier beginnt deine Unterhaltung mit ${name}.` + (empty ? pick([' Sag Hallo. Oder ein Meme.', ' Noch ist alles möglich.', ' Mach den ersten Schritt, sei kein Feigling.']) : '');
export const channelStart = (name, empty) => `Hier beginnt der Kanal #${name}.` + (empty ? pick([' Schreib die erste Nachricht. Die Welt wartet.', ' Es ist so still, man hört den Server atmen.', ' Jetzt wäre ein guter Moment für ein Meme.']) : '');

// ---------- Slash-Befehle: ersetzen den Text, bevor er gesendet wird ----------
// Gibt den neuen Text zurück, oder null, wenn es kein Befehl ist.
export function slash(text) {
  const m = /^\/([a-zäöüß]+)(?:\s+([\s\S]*))?$/i.exec(text);
  if (!m) return null;
  const rest = (m[2] || '').trim();
  const join = (face) => (rest ? rest + ' ' : '') + face;
  switch (m[1].toLowerCase()) {
    case 'shrug': return join('¯\\_(ツ)_/¯');
    case 'tableflip': return join('(╯°□°)╯︵ ┻━┻');
    case 'unflip': return join('┬─┬ ノ( ゜-゜ノ)');
    case 'lenny': return join('( ͡° ͜ʖ ͡°)');
    case 'konfetti': return '🎉🎉🎉 ' + (rest || 'Konfetti!') + ' 🎉🎉🎉';
    case 'würfel': case 'wuerfel': { const n = 1 + Math.floor(Math.random() * 6); return `🎲 würfelt eine **${n}**` + (n === 6 ? ' – Glückwunsch!' : n === 1 ? ' – autsch.' : '.'); }
    case 'münze': case 'muenze': return `🪙 Die Münze sagt: **${Math.random() < 0.5 ? 'Kopf' : 'Zahl'}**`;
    default: return null;
  }
}

// ---------- Konfetti ----------
const COLORS = ['#f2d95c', '#ff8a7a', '#ff9ecb', '#c9a2ff', '#8fb8ff', '#5fd4e0', '#7ad7a1', '#ffffff'];
let running = false;

export function confetti(opts = {}) {
  if (running) return;
  if (document.documentElement.classList.contains('calm') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  running = true;
  const cv = document.createElement('canvas');
  cv.setAttribute('aria-hidden', 'true');
  Object.assign(cv.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '95' });
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = (cv.width = innerWidth * dpr);
  const H = (cv.height = innerHeight * dpr);
  document.body.append(cv);
  const ctx = cv.getContext('2d');
  const n = opts.count || 140;
  const bits = Array.from({ length: n }, (_, i) => {
    const left = i % 2 === 0;
    return {
      x: (left ? 0.1 : 0.9) * W, y: H * 0.85,
      vx: (left ? 1 : -1) * (4 + Math.random() * 9) * dpr, vy: -(10 + Math.random() * 15) * dpr,
      w: (6 + Math.random() * 6) * dpr, h: (4 + Math.random() * 5) * dpr,
      r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.4, c: pick(COLORS),
    };
  });
  const t0 = performance.now();
  (function frame(now) {
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.45 * dpr; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.r += b.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (3200 - t) / 800));
      ctx.translate(b.x, b.y); ctx.rotate(b.r);
      ctx.fillStyle = b.c; ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (t < 3200) requestAnimationFrame(frame);
    else { cv.remove(); running = false; }
  })(t0);
}

export const CELEBRATE = /🎉|🥳|🎊/;
