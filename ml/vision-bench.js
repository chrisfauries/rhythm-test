// Scores the hand/pose model benchmark (ml/vision-bench-run.js) against what
// happened in each take: the claps the microphone heard (when the hands met),
// the rests (when they should pulse down silently), and the long notes (when
// they should stay together). Nothing here needs labels: the audio and the
// music are the answer key.
//
//   node ml/vision-bench.js
//
// Per model:
//   seen at contact   both hands located within 0.1 s of a clap
//   contact AUC       how well hand distance separates claps from the moments
//                     between claps (1 = perfectly, 0.5 = chance)
//   contacts @10%     claps caught when 10% of the in-between moments would
//                     wrongly count as contact
//   holds             share of each long note's frames read as together (same threshold)
//   pulse AUC         how well the drop of the hands separates rest beats from claps
//   ms/frame          median time per frame (and whether it ran on the GPU)
const fs = require("fs");
const path = require("path");
const { readZip } = require("./zipread");
const Book = require("./.build/music/book.js");
const R = require("./.build/music/rhythm.js");

const DIR = path.join(__dirname, "data", "vision-bench");
const index = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "bench", "index.json"), "utf8"));
const models = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((m) => fs.statSync(path.join(DIR, m)).isDirectory()) : [];
// 640x480 video: x and y in 0..1 aren't the same distance.
const ASPECT = 640 / 480;

const median = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const dist = (a, b) => Math.hypot((a[0] - b[0]) * ASPECT, a[1] - b[1]);
const mean = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

/** Per frame: hand distance in body units (null when unknown) and the hands' height in the same units. */
const signal = (frame, kind) => {
  if (kind === "pose" && frame.pose) {
    const p = frame.pose; // 0/1 shoulders, 2/3 elbows, 4/5 wrists, 6/7 pinky, 8/9 index, 10/11 thumb
    if (p[4][3] < 0.5 || p[5][3] < 0.5) return { d: null, y: null };
    const hand = (s) => mean([p[4 + s], p[6 + s], p[8 + s], p[10 + s]]);
    const unit = (dist(p[2], p[4]) + dist(p[3], p[5])) / 2 || 1;
    const a = hand(0);
    const b = hand(1);
    return { d: dist(a, b) / unit, y: (a[1] + b[1]) / 2 / unit };
  }
  if (kind === "hands" && frame.hands) {
    const hs = frame.hands.map((h) => ({ c: mean(h.palm), len: dist(h.palm[0], h.palm[2]) || 1 }));
    if (hs.length >= 2) {
      const unit = (hs[0].len + hs[1].len) / 2;
      return { d: dist(hs[0].c, hs[1].c) / unit, y: (hs[0].c[1] + hs[1].c[1]) / 2 / unit };
    }
    if (hs.length === 1) return { d: null, y: hs[0].c[1] / hs[0].len, one: true };
  }
  return { d: null, y: null };
};

/** Rank-based AUC: chance that a "positive" value beats a "negative" one (lowerIsPositive: smaller wins). */
const auc = (pos, neg, lowerIsPositive) => {
  if (!pos.length || !neg.length) return null;
  let win = 0;
  for (const a of pos) for (const b of neg) win += a === b ? 0.5 : lowerIsPositive ? +(a < b) : +(a > b);
  return win / (pos.length * neg.length);
};

const rows = [];
for (const model of models) {
  const kinds = model.startsWith("pose") || model === "holistic" ? ["pose"] : ["hands"];
  if (model === "holistic") kinds.push("hands");
  for (const kind of kinds) {
    const label = model === "holistic" ? `holistic (${kind === "pose" ? "body" : "hands"})` : model;
    const acc = {
      claps: 0,
      seen: 0,
      cMin: [],
      aMax: [],
      holds: [],
      restDip: [],
      clapDip: [],
      ms: [],
      delegate: new Set(),
      videos: 0,
      oneHand: 0,
    };
    for (const v of index) {
      const file = path.join(DIR, model, `${v.name}.json`);
      if (!fs.existsSync(file)) continue;
      const run = JSON.parse(fs.readFileSync(file, "utf8"));
      acc.videos++;
      acc.delegate.add(run.delegate);
      acc.ms.push(...run.ms);
      const files = readZip(path.join(__dirname, "..", v.zip));
      const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
      const m = JSON.parse(files["manifest.json"].toString("utf8"));
      // Grader clock -> video time: wav = grader + mic offset - wav start; video = wav + videoLag.
      const toVideo = (g) => g + d.offsets.mic - d.wavStartCtx + m.sync.videoLag;
      const sig = run.frames.map((f) => ({ t: f.t, ...signal(f, kind) }));
      const near = (t, w) => sig.filter((s) => Math.abs(s.t - t) <= w);
      const ex = Book.findExercise(d.exercise.id)?.exercise;
      const beat = ex ? R.beatLength(ex.line.timeSig) : 1;
      const secPerQ = d.grader.secPerQ;
      const notes = d.grader.notes;
      const longs = notes
        .filter((n) => n.len >= 2 * beat - 1e-6)
        .map((n) => [toVideo(n.expectedTime) + 0.2 * beat * secPerQ, toVideo(n.expectedTime) + (n.len - 0.3 * beat) * secPerQ]);
      const inLong = (t) => longs.some(([a, b]) => t >= a - 0.1 && t <= b + 0.1);
      const clapTimes = notes.filter((n) => n.time != null && ["on-time", "early", "late"].includes(n.status)).map((n) => toVideo(n.time));
      for (const c of clapTimes) {
        acc.claps++;
        const w = near(c, 0.12);
        const ds = w.map((s) => s.d).filter((x) => x != null);
        if (near(c, 0.1).some((s) => s.d != null)) acc.seen++;
        if (w.some((s) => s.one)) acc.oneHand++;
        acc.cMin.push(ds.length ? Math.min(...ds) : Infinity);
      }
      // Moments the hands should be apart: halfway between claps a good way apart, outside long notes.
      const sorted = [...clapTimes].sort((a, b) => a - b);
      for (let i = 0; i + 1 < sorted.length; i++) {
        if (sorted[i + 1] - sorted[i] < 0.45) continue;
        const mid = (sorted[i] + sorted[i + 1]) / 2;
        if (inLong(mid)) continue;
        const ds = near(mid, 0.06)
          .map((s) => s.d)
          .filter((x) => x != null);
        if (ds.length) acc.aMax.push(Math.max(...ds));
      }
      acc.longs = (acc.longs ?? []).concat(longs.map(([a, b]) => sig.filter((s) => s.t >= a && s.t <= b).map((s) => s.d)));
      // Drops: how far the hands go down just after a moment, against just before it.
      const dip = (t) => {
        const before = median(sig.filter((s) => s.t >= t - 0.35 && s.t <= t - 0.15).map((s) => s.y));
        const after = sig
          .filter((s) => s.t >= t - 0.05 && s.t <= t + 0.3)
          .map((s) => s.y)
          .filter((y) => y != null);
        return before == null || !after.length ? null : Math.max(...after) - before;
      };
      for (const r of d.grader.rests ?? []) {
        const x = dip(toVideo(r.expectedTime));
        if (x != null) acc.restDip.push(x);
      }
      for (const c of clapTimes) {
        const x = dip(c);
        if (x != null) acc.clapDip.push(x);
      }
    }
    if (!acc.videos) continue;
    // The contact threshold: 10% of the in-between moments would count as contact.
    const aSorted = [...acc.aMax].sort((a, b) => a - b);
    const thr = aSorted[Math.floor(aSorted.length * 0.1)] ?? Infinity;
    const holdShares = (acc.longs ?? []).map((ds) => {
      const known = ds.filter((x) => x != null);
      return ds.length ? known.filter((x) => x <= thr).length / ds.length : null;
    });
    rows.push({
      label,
      videos: acc.videos,
      seen: acc.seen / acc.claps,
      contactAuc: auc(acc.cMin, acc.aMax, true),
      at10: acc.cMin.filter((x) => x <= thr).length / acc.claps,
      holds: median(holdShares),
      pulseAuc: auc(acc.restDip, acc.clapDip, false),
      pulses: acc.restDip.length,
      ms: median(acc.ms),
      delegate: [...acc.delegate].join("/"),
      oneHand: acc.oneHand / acc.claps,
    });
  }
}

const pct = (x) => (x == null ? "   -" : `${Math.round(x * 100)}%`.padStart(4));
const f2 = (x) => (x == null ? "   -" : x.toFixed(2));
console.log(`${"model".padEnd(22)} videos  seen at contact  contact AUC  contacts@10%  holds  pulse AUC  ms/frame`);
for (const r of rows)
  console.log(
    `${r.label.padEnd(22)} ${String(r.videos).padStart(6)}  ${pct(r.seen).padStart(15)}  ${f2(r.contactAuc).padStart(11)}  ${pct(r.at10).padStart(12)}  ${pct(r.holds).padStart(5)}  ${f2(r.pulseAuc).padStart(9)}  ${String(r.ms).padStart(5)} ${r.delegate}`,
  );
