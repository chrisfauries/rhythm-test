// Measures how a real person counts and sings in their takes, to make synthetic
// takes sound like them (ml/synth.js):
//
//   node ml/measure-voice.js dataset/chris_fauries
//   node ml/measure-voice.js --generated dataset/synthetic    (the same, for generated takes)
//
// For every labeled word: how much of the time until the next word is voiced
// (does "one" run into "two", or stop?), and how deep the dip between them is.
// For sung takes: how much the pitch moves from note to note.
const fs = require("fs");
const path = require("path");
const { readZip, wavSamples } = require("./zipread");
const { findZips } = require("./zips");
const F = require("./.build/ml/features.js");
const V = require("./.build/audio/voice.js");

const SR = F.FEATURE_RATE;
const GENERATED = process.argv.includes("--generated");
const indexFile = path.join(__dirname, "data", "audio.json");
const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, "utf8")) : { takes: [] };
const byName = new Map(index.takes.filter((t) => (GENERATED ? t.generated : !t.synthetic && !t.generated)).map((t) => [t.name, t]));
const db = (x) => 10 * Math.log10(Math.max(x, 1e-12));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
const q = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))] : NaN);

const pitchAt = (x, c) => require("./pitch").pitchAt(x, c, SR);

const rows = { count: [], sing: [] };
const pitchSteps = [];
const pitchSpread = [];
for (const zip of findZips(process.argv.slice(2).filter((a) => !a.startsWith("--")))) {
  const files = readZip(zip);
  let take = byName.get(path.basename(zip, ".zip"));
  // Generated takes carry exact labels; use them directly (no need to build the dataset first).
  if (GENERATED && files["labels.json"]) {
    const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
    const l = JSON.parse(files["labels.json"].toString("utf8"));
    const m = JSON.parse(files["manifest.json"].toString("utf8"));
    if (m.performance !== "as-written" || !("background" in m)) continue;
    take = { activity: d.settings.activity, tempo: d.settings.tempo, onsets: l.events.filter((e) => e.type === "count").map((e) => ({ t: e.t })) };
  }
  if (!take || !take.onsets.length) continue;
  const kind = take.activity === "sing" ? "sing" : take.activity === "count-notes" ? "count" : null;
  if (!kind) continue;
  const raw = wavSamples(files["audio.wav"]);
  const x = F.toFeatureRate(raw.data, raw.sr);
  const vf = V.voiceFrames(x, SR, 0);
  const ve = V.voicedEnergy(vf);
  const frameAt = (t) => Math.max(0, Math.min(ve.length - 1, Math.round((t - vf.t0) / vf.hop)));
  const beat = 60 / take.tempo;
  const on = take.onsets.map((o) => o.t).sort((a, b) => a - b);
  const pitches = [];
  for (let i = 0; i < on.length - 1; i++) {
    const a = frameAt(on[i]);
    const b = frameAt(on[i + 1]);
    if (b - a < 4) continue;
    let peak = 0;
    for (let f = a; f < Math.min(b, a + 30); f++) peak = Math.max(peak, ve[f]);
    // Voiced share: frames from this onset to the next within 20 dB of the word's peak.
    // Longest silent stretch in the gap (frames more than 20 dB under the peak).
    let voiced = 0, run = 0, longest = 0, dip = Infinity;
    for (let f = a; f < b; f++) {
      if (db(ve[f]) > db(peak) - 20) [voiced, run] = [voiced + 1, 0];
      else longest = Math.max(longest, ++run);
    }
    // The dip: the quietest frame (all energy, not only voiced) in the 80 ms before the next onset, vs this word's peak.
    let epeak = 0;
    for (let f = a; f < Math.min(b, a + 30); f++) epeak = Math.max(epeak, vf.energy[f]);
    for (let f = Math.max(a + 1, b - 16); f <= b; f++) dip = Math.min(dip, Math.max(-40, db(vf.energy[f]) - db(epeak)));
    rows[kind].push({ beats: (on[i + 1] - on[i]) / beat, sec: on[i + 1] - on[i], share: voiced / (b - a), gap: longest * vf.hop, dip });
    if (kind === "sing") pitches.push(pitchAt(x, Math.round((on[i] + Math.min(0.15, 0.4 * (on[i + 1] - on[i]))) * SR)));
  }
  if (kind === "sing") {
    const st = pitches.filter(Boolean).map((p) => 12 * Math.log2(p / 100));
    for (let i = 1; i < st.length; i++) pitchSteps.push(Math.abs(st[i] - st[i - 1]));
    if (st.length > 2) pitchSpread.push(q(st, 0.9) - q(st, 0.1));
  }
}
for (const kind of ["count", "sing"]) {
  console.log(`\n${kind}: ${rows[kind].length} word-to-word gaps`);
  console.log("  gap (beats)   n   seconds   voiced share (median, 25-75%)   longest silence (ms)   dip before next (dB)");
  for (const [lo, hi] of [[0, 0.3], [0.3, 0.6], [0.6, 1.2], [1.2, 2.5], [2.5, 9]]) {
    const r = rows[kind].filter((x) => x.beats >= lo && x.beats < hi);
    if (!r.length) continue;
    const f = (k, s = 1) => (median(r.map((x) => x[k])) * s).toFixed(k === "share" ? 2 : 0);
    console.log(`  ${lo}-${hi}`.padEnd(14), String(r.length).padStart(4), median(r.map((x) => x.sec)).toFixed(2).padStart(8), `   ${f("share")} (${q(r.map((x) => x.share), 0.25).toFixed(2)}-${q(r.map((x) => x.share), 0.75).toFixed(2)})`.padEnd(34), f("gap", 1000).padStart(16), f("dip").padStart(22));
  }
}
console.log(`\nsung pitch: note-to-note step median ${median(pitchSteps).toFixed(2)} semitones (90% under ${q(pitchSteps, 0.9).toFixed(2)}); spread within a take (10-90%) median ${median(pitchSpread).toFixed(2)} semitones`);
