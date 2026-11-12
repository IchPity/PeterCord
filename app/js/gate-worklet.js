// Läuft im Audio-Thread (nicht vom Hintergrund-Drosseln des Fensters betroffen):
// Mikrofon-Lautstärke, Eingabeempfindlichkeit (Rauschsperre) und Pegelmessung für die Anzeige.
class Gate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.gain = 1; // Eingabelautstärke (0–2)
    this.auto = true; // Empfindlichkeit automatisch
    this.th = -50; // feste Schwelle in dB, wenn nicht automatisch
    this.muted = false;
    this.floor = -60; // geschätztes Grundrauschen
    this.level = -100; // Pegel für die Anzeige (fällt langsam ab)
    this.open = false;
    this.hold = 0;
    this.g = 0; // aktuelle Verstärkung (weich nachgeführt, damit nichts knackt)
    this.n = 0;
    this.port.onmessage = (e) => Object.assign(this, e.data);
  }

  process(inputs, outputs) {
    const inp = inputs[0][0];
    const out = outputs[0][0];
    if (!inp || !out) return true;
    let sum = 0;
    for (let i = 0; i < inp.length; i++) { const s = inp[i] * this.gain; sum += s * s; }
    const db = 10 * Math.log10(sum / inp.length + 1e-12);
    this.level = Math.max(db, this.level - 0.6);
    // Grundrauschen: folgt sofort nach unten, steigt nur langsam (≈ 1,5 dB pro Sekunde).
    if (db < this.floor) this.floor = Math.max(db, -90);
    else this.floor += 0.004;
    const th = this.auto ? Math.min(-30, Math.max(-65, this.floor + 14)) : this.th;
    if (db > th) { this.open = true; this.hold = Math.round((0.35 * sampleRate) / inp.length); }
    else if (this.hold > 0) this.hold--;
    else this.open = false;
    const target = this.open && !this.muted ? this.gain : 0;
    const k = target > this.g ? 0.004 : 0.0015; // schnell auf, sanft zu
    let g = this.g;
    for (let i = 0; i < inp.length; i++) {
      g += (target - g) * k;
      const s = inp[i] * g;
      out[i] = s > 1 ? 1 : s < -1 ? -1 : s;
    }
    this.g = g;
    if (++this.n % 8 === 0) this.port.postMessage({ level: this.level, open: this.open, th });
    return true;
  }
}
registerProcessor('pc-gate', Gate);
