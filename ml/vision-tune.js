// Tunes the pose-based camera tracker on the benchmark videos (ml/vision-bench-run.js,
// pose-lite results) by running them through the app's own pipeline: the
// together/apart rule (src/video/together.ts) and the grader (holds and rest
// pulses in src/analysis/analyze.ts), with each take's recorded claps. Prints
// the live results of the old hand tracker on the same takes for comparison,
// then the best pose settings.
//
//   node ml/vision-tune.js [--model pose-lite] [--curve <unit>]
const fs = require("fs");
const path = require("path");
const { readZip } = require("./zipread");
const A = require("./.build/analysis/analyze.js");
const T = require("./.build/video/together.js");
const Book = require("./.build/music/book.js");

const args = process.argv.slice(2);
const MODEL = args.includes("--model") ? args[args.indexOf("--model") + 1] : "pose-lite";
const DIR = path.join(__dirname, "data", "vision-bench", MODEL);
const ASPECT = 640 / 480;
const index = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "bench", "index.json"), "utf8")).filter((v) =>
  fs.existsSync(path.join(DIR, `${v.name}.json`)),
);

const takes = index.map((v) => {
  const files = readZip(path.join(__dirname, "..", v.zip));
  const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
  const m = JSON.parse(files["manifest.json"].toString("utf8"));
  const ex = Book.findExercise(d.exercise.id)?.exercise ?? Book.customExercise(d.exercise.source, d.exercise.timeSig);
  const run = JSON.parse(fs.readFileSync(path.join(DIR, `${v.name}.json`), "utf8"));
  // Video time -> grader clock.
  const toGrader = (t) => t - m.sync.videoLag - d.offsets.mic + d.wavStartCtx;
  return { name: v.name, d, ex, frames: run.frames.map((f) => ({ ...f, g: toGrader(f.t) })) };
});

const dist = (a, b) => Math.hypot((a[0] - b[0]) * ASPECT, a[1] - b[1]);
const mean = (pts) => [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];

/** Pose frames -> the tracker's frames: hands seen, distance and height in "hand lengths" (unit x forearm). */
const poseFrames = (take, p) => {
  const state = new T.TogetherState({ togetherBelow: p.below, apartAbove: p.above });
  return take.frames.map((f) => {
    const q = f.pose;
    if (!q) return { time: f.g, together: state.update(0, null, f.g * 1000), palmY: null, scale: null };
    const seen = [q[4][3] >= p.vis, q[5][3] >= p.vis];
    const hand = (s) => mean([q[4 + s], q[6 + s], q[8 + s], q[10 + s]]);
    const forearm = (s) => dist(q[2 + s], q[4 + s]);
    const n = seen.filter(Boolean).length;
    const unit = p.k * (n === 2 ? (forearm(0) + forearm(1)) / 2 : seen[0] ? forearm(0) : forearm(1)) || 1;
    const distance = n === 2 ? dist(hand(0), hand(1)) / unit : null;
    const ys = [0, 1].filter((s) => seen[s]).map((s) => hand(s)[1]);
    return {
      time: f.g,
      together: state.update(n, distance, f.g * 1000),
      palmY: ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null,
      scale: n ? unit : null,
    };
  });
};

/** How a set of tracker frames does in the app, with the take's own recorded claps. */
const score = (take, frames, acc) => {
  const { d, ex } = take;
  const rec = d.grader.input;
  const result = A.analyzeTake({
    line: ex.line,
    bpm: 60 / d.timing.secPerBeat,
    startTime: d.timing.lineStart,
    activity: d.settings.activity,
    strictness: "normal",
    claps: rec.claps,
    words: null,
    frames,
  });
  const near = (t, w) => frames.filter((f) => Math.abs(f.time - t) <= w);
  const claps = result.notes
    .filter((n) => n.time != null && ["on-time", "early", "late"].includes(n.status))
    .map((n) => n.time)
    .sort((a, b) => a - b);
  for (const c of claps) {
    acc.claps++;
    if (near(c, 0.12).some((f) => f.together === true)) acc.contacts++;
  }
  // On a rest the hands pulse down held apart: any "together" there is false.
  for (const r of result.rests ?? []) {
    const w = near(r.expectedTime + 0.1, 0.1).filter((f) => f.together !== null);
    if (!w.length) continue;
    acc.mids++;
    if (w.some((f) => f.together === true)) acc.falseTogether++;
  }
  for (const n of result.notes) if (n.hold && n.hold.status !== "unknown") (acc.holds++, n.hold.status === "held" && acc.held++);
  for (const r of result.rests ?? []) if (r.status !== "unknown") (acc.rests++, r.status === "pulsed" && acc.pulsed++);
  // Pulses found at claps (outside rests) are false alarms.
  const pulses = A.findPulses(frames);
  const restTimes = (result.rests ?? []).map((r) => r.expectedTime);
  acc.pulsesAtClaps += claps.filter(
    (c) => pulses.some((p) => Math.abs(p - c) < 0.15) && !restTimes.some((r) => Math.abs(r - c) < 0.4),
  ).length;
};

const summarize = (acc) => ({
  contacts: acc.contacts / acc.claps,
  falseTogether: acc.falseTogether / acc.mids,
  holds: acc.held / acc.holds,
  pulses: acc.pulsed / acc.rests,
  falsePulses: acc.pulsesAtClaps / acc.claps,
});
const fresh = () => ({ claps: 0, contacts: 0, mids: 0, falseTogether: 0, holds: 0, held: 0, rests: 0, pulsed: 0, pulsesAtClaps: 0 });
const pct = (x) => `${Math.round(x * 100)}%`.padStart(4);
const show = (label, s) =>
  console.log(
    `${label.padEnd(44)} contacts ${pct(s.contacts)}  together on rests ${pct(s.falseTogether)}  holds ${pct(s.holds)}  rest pulses ${pct(s.pulses)}  pulses at claps ${pct(s.falsePulses)}`,
  );

// The old hand tracker, as it ran live on these takes.
const live = fresh();
for (const t of takes) score(t, t.d.grader.input.frames, live);
console.log(`${takes.length} takes\n`);
show("live: legacy hands lite + merge rule", summarize(live));

// --curve <k>: one line of together thresholds at that unit, to see the trade-off.
if (args.includes("--curve")) {
  const k = +args[args.indexOf("--curve") + 1];
  console.log("");
  for (const below of [0.8, 1.0, 1.1, 1.2, 1.3, 1.4, 1.6, 1.8]) {
    const acc = fresh();
    for (const t of takes) score(t, poseFrames(t, { k, below, above: below + 0.2, vis: 0.5 }), acc);
    show(`k ${k}, together < ${below}, apart > ${(below + 0.2).toFixed(1)}`, summarize(acc));
  }
  process.exit(0);
}

// Pose settings: the hand-length unit (fraction of a forearm), together/apart thresholds, wrist visibility.
const results = [];
for (const k of [0.35, 0.4, 0.45, 0.5])
  for (const below of [0.6, 0.8, 1.0, 1.2, 1.4])
    for (const gap of [0.2, 0.4])
      for (const vis of [0.3, 0.5]) {
        const p = { k, below, above: below + gap, vis };
        const acc = fresh();
        for (const t of takes) score(t, poseFrames(t, p), acc);
        const s = summarize(acc);
        // What matters: contacts and holds seen, few false "together" and false pulses, rests pulsed.
        const value = s.contacts + s.holds + s.pulses - 2 * s.falseTogether - 2 * s.falsePulses;
        results.push({ p, s, value });
      }
results.sort((a, b) => b.value - a.value);
console.log("\nbest pose settings:");
for (const r of results.slice(0, 8)) show(`k ${r.p.k}, together < ${r.p.below}, apart > ${r.p.above}, vis ${r.p.vis}`, r.s);
