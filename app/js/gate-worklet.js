// Läuft im Audio-Thread (nicht vom Hintergrund-Drosseln des Fensters betroffen):
// Mikrofon-Lautstärke, Eingabeempfindlichkeit (Rauschsperre) und Pegelmessung für die Anzeige.
//
// Die automatische Empfindlichkeit entscheidet nicht nur nach Lautstärke, sie erkennt Sprache:
//  1. Grundrauschen: Als Rauschen gilt der Pegel der leisen Momente (10. Perzentil der letzten 1,5 s).
//     Bleibt der Pegel eine halbe Sekunde lang gleichmäßig (Lüfter geht an), wird er direkt übernommen.
//  2. Stimme: Stimmhafte Laute sind periodisch (Autokorrelation zwischen 70 und 400 Hz) und öffnen schon
//     knapp über dem Rauschen. Stimmloses (s, f, sch) muss deutlich lauter sein und einen Moment anhalten –
//     ein Tastenklick klingt dafür zu schnell ab.
//  3. Vorlauf: Der Ton läuft leicht verzögert durch (20 ms). Öffnet die Sperre, greift sie so weit zurück,
//     wie der Laut schon dauert (bis 120 ms) – so fehlt auch der Anfang eines Wortes nicht. Umgestellt wird
//     nur, während nichts zu hören ist; in der nächsten Pause geht es zurück auf 20 ms.
//  4. Redefluss: Bis 1 s nach dem letzten erkannten Laut öffnet jedes Geräusch sofort,
//     damit mitten im Satz nichts abgehackt wird.

const PRE_MIN = 2; // Vorlauf in Abschnitten von 10 ms: mindestens …
const PRE_MAX = 12; // … und höchstens
const FLOOR_MIN = -76; // dB – leiser wird das Grundrauschen nicht angenommen (digitale Stille)
const FLOOR_MAX = -12;
// Abstände zum Grundrauschen in dB
const V_OPEN = 6; // stimmhaft: öffnet
const V_KEEP = 4; // stimmhaft: hält offen
const U_OPEN = 10; // stimmlos: öffnet, wenn es anhält
const A_KEEP = 9; // irgendein Geräusch: hält im Redefluss offen
const V_SAG = 1.2; // so viel darf Stimmhaftes von Abschnitt zu Abschnitt leiser werden …
const V_SAG3 = 1.5; // … und so viel über drei Abschnitte
const U_SAG = 3.5; // so viel darf Stimmloses unter seinen lautesten Abschnitt fallen
// Zeiten in Abschnitten von 10 ms
const U_MIN = 5; // so viele Abschnitte muss Stimmloses anhalten
const HANG_SHORT = 10; // Nachlauf nach einem kurzen Laut
const HANG_LONG = 26; // Nachlauf nach richtiger Sprache
const FLOW = 100; // so lange gilt „im Redefluss“
const HIST = 150; // Fenster für das Grundrauschen

// Filter zweiter Ordnung: [b0, b1, b2, a1, a2]
function biquad(type, f, q) {
  const w = (2 * Math.PI * f) / sampleRate, c = Math.cos(w), a = Math.sin(w) / (2 * q), n = 1 + a;
  const hp = type === 'hp';
  const b = hp ? (1 + c) / 2 : (1 - c) / 2;
  return [b / n, (hp ? -2 * b : 2 * b) / n, b / n, (-2 * c) / n, (1 - a) / n];
}

class Gate extends AudioWorkletProcessor {
  constructor() {
    super();
    const fs = sampleRate;
    this.gain = 1; // Eingabelautstärke (0–2)
    this.auto = true; // Empfindlichkeit automatisch
    this.th = -50; // feste Schwelle in dB, wenn nicht automatisch
    this.muted = false;
    this.port.onmessage = (e) => this.set(e.data || {});

    this.open = false;
    this.level = -100; // Pegel für die Anzeige (fällt langsam ab)
    this.g = 0; // aktuelle Verstärkung (weich nachgeführt, damit nichts knackt)
    this.kUp = 1 - Math.exp(-1 / (0.0015 * fs)); // schnell auf
    this.kDown = 1 - Math.exp(-1 / (0.025 * fs)); // sanft zu
    this.di = 0;

    // Gemessen wird in Abschnitten von 10 ms, ohne Rumpeln und Brummen unter 120 Hz.
    // Für die Stimmerkennung folgt ein Tiefpass bei 900 Hz, danach wird auf rund 4 kHz ausgedünnt.
    this.F = Math.round(fs / 100);
    this.dl = new Float32Array((PRE_MAX + 2) * this.F); // Ringspeicher für den Vorlauf
    this.D = PRE_MIN * this.F; // aktueller Vorlauf in Samples
    this.fi = 0;
    this.acc = 0;
    this.n = 0;
    this.k = new Float64Array([...biquad('hp', 120, 0.7071), ...biquad('lp', 900, 0.5412), ...biquad('lp', 900, 1.3066)]);
    this.z = new Float64Array(6);
    this.R = Math.max(1, Math.round(fs / 4000));
    this.ri = 0;
    const fd = fs / this.R;
    this.lagMin = Math.floor(fd / 400);
    this.lagMax = Math.ceil(fd / 70);
    this.W = Math.round(fd * 0.024);
    this.pb = new Float32Array(this.W + this.lagMax);
    this.pi = 0;
    this.lin = new Float64Array(this.pb.length);

    this.hist = new Float32Array(HIST);
    this.voi = new Uint8Array(HIST);
    this.srt = new Float32Array(HIST);
    this.reset();
  }

  set(d) {
    if (typeof d.gain === 'number') this.gain = d.gain;
    if (typeof d.auto === 'boolean') this.auto = d.auto;
    if (typeof d.th === 'number') this.th = d.th;
    if (typeof d.muted === 'boolean') this.muted = d.muted;
    if (d.reset) this.reset(); // anderes Mikrofon: neu einmessen
  }

  reset() {
    this.nf = NaN; // geschätztes Grundrauschen in dB; NaN = noch nicht eingemessen
    this.hi = 0;
    this.hn = 0;
    this.pc = 0;
    this.c = 0;
    this.vf = 0;
    this.sRef = -200; // Pegel, um den es gerade gleichmäßig rauscht
    this.sRun = 0;
    this.sV = 0;
    this.prev = this.prev2 = this.prev3 = -100;
    this.age = 0; // so viele Abschnitte dauert der aktuelle Laut schon
    this.pre = 0; // … und so viele waren es, als die Sperre aufging
    this.vBits = 0; // die letzten vier Abschnitte: stimmhafter Einsatz?
    this.uRun = 0;
    this.uPeak = -200;
    this.uMax = -200;
    this.since = 1e9; // Abschnitte seit dem letzten sicher erkannten Laut
    this.conf = 0;
    this.hang = 0;
    this.vopen = false;
    this.mopen = false;
    this.mhang = 0;
  }

  // Wie periodisch sind die letzten 24 ms? 1 = reiner Ton, um 0,3 = Rauschen.
  voicing() {
    const { pb, lin, W, lagMin, lagMax } = this;
    const N = pb.length;
    for (let i = 0, j = this.pi; i < N; i++) { lin[i] = pb[j]; if (++j >= N) j = 0; }
    const base = N - W;
    let e0 = 0;
    for (let i = base; i < N; i++) e0 += lin[i] * lin[i];
    if (e0 < 1e-14) return 0;
    let el = 0; // Energie des verschobenen Fensters, wandert mit
    for (let i = base - lagMin; i < N - lagMin; i++) el += lin[i] * lin[i];
    let best = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      let num = 0;
      for (let i = base; i < N; i++) num += lin[i] * lin[i - lag];
      if (num > 0 && el > 0) { const r = num / Math.sqrt(e0 * el + 1e-20); if (r > best) best = r; }
      if (lag < lagMax) { const a = lin[base - lag - 1], b = lin[N - lag - 1]; el += a * a - b * b; }
    }
    return best;
  }

  // Grundrauschen nachführen. Digitale Stille zählt mit: Manche Mikrofone (oder vorgeschaltete Programme)
  // liefern zwischen den Wörtern exakt null – dann ist das Rauschen eben „ganz unten“.
  learn(lv, voiced) {
    const { hist, voi } = this;
    hist[this.hi] = lv;
    voi[this.hi] = voiced ? 1 : 0;
    this.hi = (this.hi + 1) % HIST;
    if (this.hn < HIST) this.hn++;

    if (Math.abs(lv - this.sRef) <= 3) {
      this.sRun++;
      if (voiced) this.sV++;
      this.sRef += (lv - this.sRef) * 0.02;
    } else {
      this.sRef = lv;
      this.sRun = 0;
      this.sV = 0;
    }
    // Gleichmäßig = Rauschen. Klingt es nach Stimme (Brummen, gehaltener Ton), erst nach 3 s.
    const steady = this.sRun >= 50 && (this.sV < 0.3 * this.sRun || this.sRun >= 300);
    if (steady && this.hn > this.sRun + 1) this.hn = this.sRun + 1; // was davor war, zählt nicht mehr

    const known = this.nf === this.nf;
    if (++this.pc >= 3 || !known) {
      this.pc = 0;
      const n = this.hn, s = this.srt;
      let v = 0;
      for (let k = 0, j = this.hi; k < n; k++) { if (--j < 0) j = HIST - 1; s[k] = hist[j]; v += voi[j]; }
      s.fill(Infinity, n);
      s.sort();
      this.c = s[Math.floor(n * 0.1)];
      this.vf = v / n;
    }
    if (!known) { if (this.hn >= 15) this.nf = this.c; return; }
    if (steady) this.nf += (this.sRef - 1 - this.nf) * 0.08;
    else if (this.c < this.nf) this.nf += (this.c - this.nf) * 0.25; // leiser geworden: schnell folgen
    else this.nf = Math.min(this.c, this.nf + (this.vf < 0.2 ? 0.03 : 0.005)); // lauter: vorsichtig, bei Sprache kaum
  }

  // Automatik: Ist das Sprache? Gibt die Schwelle für die Anzeige zurück.
  detect(lv) {
    const known = this.nf === this.nf;
    const nf = known ? Math.min(FLOOR_MAX, Math.max(FLOOR_MIN, this.nf)) : FLOOR_MIN;
    const above = lv - nf;
    const voiced = known && above > 3 && this.voicing() > 0.6;
    const prev = this.prev, prev3 = this.prev3;
    this.prev3 = this.prev2;
    this.prev2 = prev;
    this.prev = lv;
    this.age = above >= V_OPEN ? this.age + 1 : 0;

    // Stimmhaft: drei der letzten vier Abschnitte, jeweils ohne leiser zu werden
    // (ein Schlag auf den Tisch schwingt auch nach, klingt dabei aber ab).
    const rising = voiced && above >= V_OPEN && lv >= prev - V_SAG && lv >= prev3 - V_SAG3;
    const vb = this.vBits = ((this.vBits << 1) | (rising ? 1 : 0)) & 15;
    const vOk = (vb & 1) === 1 && (vb & 1) + ((vb >> 1) & 1) + ((vb >> 2) & 1) + (vb >> 3) >= 3;
    // Stimmlos: beginnt mit einem Anstieg und bleibt dann gleichmäßig laut. Der erste Abschnitt darf
    // herausragen (der Knall eines p, t oder k), ab dem zweiten muss der Pegel halten.
    this.uPeak = Math.max(lv, this.uPeak - 0.5);
    if (above < U_OPEN || lv < this.uPeak - 10 || (voiced && lv < prev - V_SAG)) this.uRun = 0;
    else if (this.uRun === 0) { if (lv >= prev) this.uRun = 1; }
    else if (this.uRun >= 2 && lv < this.uMax - U_SAG) this.uRun = 0; // klingt ab
    else if (++this.uRun >= 2) this.uMax = this.uRun === 2 ? lv : Math.max(this.uMax, lv);

    const speech = known && (vOk || (this.uRun >= U_MIN && this.uRun <= 50)); // sicher erkannte Sprache
    this.since = speech ? 0 : this.since + 1;
    const flow = this.since < FLOW;
    const active = known && (above >= A_KEEP || (voiced && above >= V_KEEP));

    if (!this.vopen && (speech || (flow && active))) { this.vopen = true; this.conf = 0; this.hang = 0; this.pre = this.age; }
    if (this.vopen) {
      const lag = Math.ceil(this.D / this.F); // der Ton hängt um den Vorlauf hinterher
      if (speech) this.hang = Math.max(this.hang, lag + (++this.conf >= 12 ? HANG_LONG : HANG_SHORT));
      else if (flow && active) this.hang = Math.max(this.hang, lag + HANG_SHORT);
      else if (--this.hang <= 0) this.vopen = false;
    }
    this.learn(lv, voiced);
    return nf + V_OPEN;
  }

  frame(pw, g) {
    const lv = Math.max(-100, 10 * Math.log10(pw + 1e-12)); // Pegel am Mikrofon
    const gdb = this.gain > 0.001 ? 20 * Math.log10(this.gain) : -60;
    const post = Math.max(-100, lv + gdb); // Pegel, wie er gesendet würde
    this.level = Math.max(post, this.level - 2.2);

    const autoTh = this.detect(lv) + gdb;
    // Von Hand: feste Schwelle.
    if (post > this.th) { this.mopen = true; this.mhang = PRE_MIN + HANG_LONG; }
    else if (this.mopen && --this.mhang <= 0) this.mopen = false;

    this.open = this.auto ? this.vopen : this.mopen;
    // Vorlauf umstellen – nur solange nichts zu hören ist, dann knackt es nicht.
    if (g < 0.02) this.D = (this.open && this.auto ? Math.min(PRE_MAX, Math.max(PRE_MIN, this.pre + 1)) : PRE_MIN) * this.F;
    if (++this.n & 1) this.port.postMessage({ level: this.level, open: this.open, th: this.auto ? autoTh : this.th });
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    const inp = inputs[0] && inputs[0][0]; // fehlt, solange kein Mikrofon angeschlossen ist
    const { dl, pb, k, z, F, R, kUp, kDown } = this;
    const hb0 = k[0], hb1 = k[1], hb2 = k[2], ha1 = k[3], ha2 = k[4];
    const pb0 = k[5], pb1 = k[6], pb2 = k[7], pa1 = k[8], pa2 = k[9];
    const qb0 = k[10], qb1 = k[11], qb2 = k[12], qa1 = k[13], qa2 = k[14];
    let h1 = z[0], h2 = z[1], p1 = z[2], p2 = z[3], q1 = z[4], q2 = z[5];
    const L = dl.length, PN = pb.length;
    let { di, g, fi, acc, ri, pi, D } = this;
    let target = this.open && !this.muted ? this.gain : 0;
    for (let i = 0; i < out.length; i++) {
      const x = inp ? inp[i] : 0;
      const y = hb0 * x + h1; // Hochpass
      h1 = hb1 * x - ha1 * y + h2;
      h2 = hb2 * x - ha2 * y;
      acc += y * y;
      const u = pb0 * y + p1; // Tiefpass, zwei Stufen
      p1 = pb1 * y - pa1 * u + p2;
      p2 = pb2 * y - pa2 * u;
      const v = qb0 * u + q1;
      q1 = qb1 * u - qa1 * v + q2;
      q2 = qb2 * u - qa2 * v;
      if (++ri >= R) { ri = 0; pb[pi] = v; if (++pi >= PN) pi = 0; }
      if (++fi >= F) {
        // Nichts mehr drin: Filter leeren, statt mit winzigen Zahlen weiterzurechnen.
        if (acc < 1e-24 * F) h1 = h2 = p1 = p2 = q1 = q2 = 0;
        this.pi = pi;
        this.frame(acc / F, g);
        fi = 0;
        acc = 0;
        D = this.D;
        target = this.open && !this.muted ? this.gain : 0;
      }
      dl[di] = x;
      const d = dl[di >= D ? di - D : di - D + L];
      if (++di >= L) di = 0;
      g += (target - g) * (target > g ? kUp : kDown);
      const s = d * g;
      out[i] = s > 1 ? 1 : s < -1 ? -1 : s;
    }
    if (Math.abs(target - g) < 1e-5) g = target; // ganz zu heißt wirklich still
    z[0] = h1; z[1] = h2; z[2] = p1; z[3] = p2; z[4] = q1; z[5] = q2;
    this.di = di;
    this.g = g;
    this.fi = fi;
    this.acc = acc;
    this.ri = ri;
    this.pi = pi;
    return true;
  }
}
registerProcessor('pc-gate', Gate);
