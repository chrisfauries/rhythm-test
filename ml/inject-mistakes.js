// Tests the feedback engine's detectors on real performances: takes that were
// played cleanly, with one kind of mistake put in (stopping, starting over,
// coming in a beat off, clapping during a long note, a figure played as
// another, ...). For each kind: how often the feedback names it first, names
// it at all, and what it said instead.
//
//   npm run ml:inject-mistakes [-- --show N] [--real-only | --synth-only]
//
// Bases: Chris's captures in dataset/ (what the audio model heard, so real
// human timing), and a fixed sample of clean synthetic takes (their labels),
// which add lines with ties and triplets.
const path = require("path");
const { readZip, wavSamples } = require("./zipread");
const { findZips } = require("./zips");
const A = require("./.build/analysis/analyze.js");
const FB = require("./.build/analysis/feedback.js");
const M = require("./.build/ml/audioModel.js");
const Book = require("./.build/music/book.js");
const Act = require("./.build/music/activity.js");
const R = require("./.build/music/rhythm.js");

const args = process.argv.slice(2);
const show = args.includes("--show") ? +args[args.indexOf("--show") + 1] : 0;
const REAL = !args.includes("--synth-only");
const SYNTH = !args.includes("--real-only");
// --only <mistake>: just that one; --base <text>: only bases whose name contains it.
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const BASE = args.includes("--base") ? args[args.indexOf("--base") + 1] : null;

// ---- Bases: clean performances as grader input ------------------------------
/** A take as the grader sees it: { name, line, bpm, startTime, activity, info, claps, words, sung, voiced, frames } */
const loadBases = () => {
  const bases = [];
  if (REAL) {
    const model = new M.AudioModel(require("../public/models/audio.json"));
    for (const zip of findZips(["dataset"])) {
      if (/calibrate|synthetic/.test(zip)) continue;
      const files = readZip(zip);
      if (!files["diagnostics.json"] || !files["audio.wav"]) continue;
      const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
      const ex = Book.findExercise(d.exercise.id)?.exercise;
      if (!ex) continue;
      const { sr, data } = wavSamples(files["audio.wav"]);
      const heard = M.modelGraderInput(model, data, sr, d.wavStartCtx, { mic: d.offsets.mic, speech: d.offsets.speech }).input;
      const activity = Act.activityOfSettings(d.settings);
      bases.push({
        name: path.basename(zip, ".zip"),
        real: true,
        line: ex.line,
        bpm: d.exercise.tempo,
        startTime: d.timing.lineStart,
        activity,
        info: Act.activityInfo(activity),
        claps: heard.claps,
        words: heard.words,
        sung: heard.sungOnsets,
        voiced: heard.voicedSpans,
        frames: d.grader.input.frames ?? null,
        metronome: d.settings.metronomeDuringLine !== false,
      });
    }
  }
  if (SYNTH) {
    for (const zip of findZips(["dataset/synthetic"])) {
      // The same fixed tenth of the clean takes as check-feedback.js.
      if ([...zip].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 10 !== 0) continue;
      const files = readZip(zip);
      if (!files["labels.json"]) continue;
      const m = JSON.parse(files["manifest.json"].toString("utf8"));
      if ((m.mistakes ?? []).length) continue;
      const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
      const ex = Book.findExercise(d.exercise.id)?.exercise;
      if (!ex) continue;
      const ev = JSON.parse(files["labels.json"].toString("utf8")).events;
      const activity = Act.activityOfSettings(d.settings);
      bases.push({
        name: path.basename(zip, ".zip"),
        real: false,
        line: ex.line,
        bpm: d.exercise.tempo,
        startTime: d.timing.lineStart,
        activity,
        info: Act.activityInfo(activity),
        claps: ev.filter((e) => e.type === "clap").map((e) => e.t),
        words: ev.filter((e) => e.type === "count" && e.label !== "sing").map((e) => ({ word: e.label, label: e.label, time: e.t })),
        sung: ev.filter((e) => e.type === "count" && e.label === "sing").map((e) => e.t),
        voiced: undefined,
        frames: null,
        metronome: d.settings.metronomeDuringLine !== false,
      });
    }
  }
  return bases;
};

const grade = (b) => {
  const result = A.analyzeTake({
    line: b.line,
    bpm: b.bpm,
    startTime: b.startTime,
    activity: b.activity,
    strictness: "normal",
    claps: b.info.claps ? b.claps : [],
    words: b.info.countMode ? b.words : null,
    frames: b.frames,
    sungOnsets: b.info.sing ? b.sung : undefined,
    voicedSpans: b.info.sing || b.info.countMode ? b.voiced : undefined,
  });
  return FB.feedback({ result, line: b.line, activity: b.info, bpm: b.bpm, metronome: b.metronome });
};

// ---- Helpers on a base ---------------------------------------------------------
const secPerQ = (b) => 60 / b.bpm / R.beatLength(b.line.timeSig);
const timeOf = (b, pos) => b.startTime + pos * secPerQ(b);
const beatSec = (b) => R.beatLength(b.line.timeSig) * secPerQ(b);
/** The stream the notes are heard in: claps, sung "Da"s, or (counting only) the words' times. */
const main = (b) => (b.info.claps ? "claps" : b.info.sing ? "sung" : "words");
const tOf = (e) => (typeof e === "number" ? e : e.time);
const moveEv = (e, dt) => (typeof e === "number" ? e + dt : { ...e, time: e.time + dt });
/** Applies f to every event stream (claps, words, sung) and the voiced spans. */
const everywhere = (b, f, spans) => ({
  ...b,
  claps: f(b.claps),
  words: f(b.words),
  sung: f(b.sung),
  voiced: b.voiced && spans ? spans(b.voiced) : b.voiced,
});
const cutSpans = (from, to) => (vs) =>
  vs.flatMap(([s, e]) => (e <= from || s >= to ? [[s, e]] : [s < from ? [s, from] : null, e > to ? [to, e] : null].filter(Boolean)));
/** Each written note (ties merged) with the base's event nearest it in the main stream. */
const notesWithEvents = (b) => {
  const evs = b[main(b)];
  return R.expectedClaps(b.line).map((n) => {
    const t = timeOf(b, n.pos);
    let best = null;
    for (const e of evs) if (!best || Math.abs(tOf(e) - t) < Math.abs(tOf(best) - t)) best = e;
    return { ...n, t, ev: best && Math.abs(tOf(best) - t) < 0.1 ? best : null };
  });
};
const placed = (b) => R.placeNotes(b.line);
const lineEnd = (b) => timeOf(b, R.lineBeats(b.line) * R.beatLength(b.line.timeSig));
const mSec = (b) => R.measureLength(b.line.timeSig) * secPerQ(b);

// ---- Mistakes: each returns a changed base, or null when it can't apply -------
const MISTAKES = {
  "gave-up": (b) => {
    if (b.line.measures.length < 4) return null;
    const from = timeOf(b, Math.floor(b.line.measures.length / 2) * R.measureLength(b.line.timeSig)) - 0.1;
    return everywhere(b, (xs) => xs.filter((e) => tOf(e) < from), cutSpans(from, Infinity));
  },
  stopped: (b) => {
    if (b.line.measures.length < 5) return null;
    const m = Math.floor(b.line.measures.length / 2) - 1;
    const from = timeOf(b, m * R.measureLength(b.line.timeSig)) - 0.1;
    const to = from + 1.5 * mSec(b);
    const out = everywhere(b, (xs) => xs.filter((e) => tOf(e) < from || tOf(e) > to), cutSpans(from, to));
    // Only if at least three notes go silent.
    const silent = notesWithEvents(b).filter((n) => n.t > from && n.t < to).length;
    return silent >= 3 ? out : null;
  },
  restart: (b) => {
    if (b.line.measures.length < 4) return null;
    const from = timeOf(b, 2 * R.measureLength(b.line.timeSig)) - 0.1;
    const again = from + mSec(b); // a measure's pause, then the line from the start
    const dt = again - b.startTime;
    const end = lineEnd(b) + 1;
    const restarted = (xs) => [...xs.filter((e) => tOf(e) < from), ...xs.map((e) => moveEv(e, dt)).filter((e) => tOf(e) < end)];
    return everywhere(b, restarted, (vs) => [
      ...cutSpans(from, Infinity)(vs),
      ...vs.map(([s, e]) => [s + dt, e + dt]).filter(([s]) => s < end),
    ]);
  },
  "late-start": (b) =>
    everywhere(
      b,
      (xs) => xs.map((e) => moveEv(e, beatSec(b))),
      (vs) => vs.map(([s, e]) => [s + beatSec(b), e + beatSec(b)]),
    ),
  "early-start": (b) =>
    everywhere(
      b,
      (xs) => xs.map((e) => moveEv(e, -beatSec(b))),
      (vs) => vs.map(([s, e]) => [s - beatSec(b), e - beatSec(b)]),
    ),
  "late-entrance": (b) => {
    // The first note missed (both its clap and its count).
    const ns = notesWithEvents(b);
    if (!ns[0]?.ev || ns.length < 5) return null;
    const t = ns[0].t;
    return everywhere(b, (xs) => xs.filter((e) => Math.abs(tOf(e) - t) > 0.12), cutSpans(t - 0.1, t + 0.5 * beatSec(b)));
  },
  "held-beat-clap": (b) => {
    if (!b.info.claps) return null;
    const longs = notesWithEvents(b).filter((n) => n.len >= 2 * R.beatLength(b.line.timeSig) - 1e-6);
    if (!longs.length) return null;
    const extra = longs.map((n) => n.t + beatSec(b));
    return { ...b, claps: [...b.claps, ...extra.slice(0, 2)].sort((x, y) => x - y) };
  },
  "cut-short": (b) => {
    if (!b.info.claps) return null;
    const ns = notesWithEvents(b);
    // A long note followed straight away by the next note (not a rest).
    const k = ns.findIndex(
      (n, i) =>
        n.len >= 2 * R.beatLength(b.line.timeSig) - 1e-6 &&
        ns[i + 1]?.ev &&
        i + 1 < ns.length - 1 &&
        Math.abs(ns[i + 1].pos - n.pos - n.len) < 1e-6,
    );
    if (k < 0) return null;
    const next = ns[k + 1];
    return { ...b, claps: b.claps.map((c) => (c === next.ev ? c - beatSec(b) : c)).sort((x, y) => x - y) };
  },
  "tie-clap": (b) => {
    if (!b.info.claps) return null;
    const ps = placed(b);
    const tied = ps.filter((p, k) => k > 0 && !ps[k - 1].note.rest && ps[k - 1].note.tie && !p.note.rest);
    if (!tied.length) return null;
    return { ...b, claps: [...b.claps, ...tied.slice(0, 2).map((p) => timeOf(b, p.pos))].sort((x, y) => x - y) };
  },
  // A figure played as another, everywhere it appears (as students do).
  ...Object.fromEntries(
    [
      ["sixteenths>triplet", [0, 0.25, 0.5, 0.75], [0, 1 / 3, 2 / 3], ["la", "li"]],
      ["eighths>swing", [0, 0.5], [0, 2 / 3], null],
      ["dotted>even", [0, 0.75], [0, 0.5], null],
      ["triplet>sixteenths", [0, 1 / 3, 2 / 3], [0, 0.25, 0.5, 0.75], ["e", "and", "a"]],
    ].map(([name, from, to, newWords]) => [
      `morph ${name}`,
      (b) => {
        const beat = R.beatLength(b.line.timeSig);
        const ns = notesWithEvents(b);
        const byBeat = new Map();
        for (const n of ns) {
          const k = Math.floor(n.pos / beat + 1e-6);
          byBeat.set(k, [...(byBeat.get(k) ?? []), n]);
        }
        const hits = [...byBeat.entries()].filter(
          ([k, g]) =>
            g.length === from.length && g.every((n, i) => Math.abs((n.pos - k * beat) / beat - from[i]) < 0.02) && g.every((n) => n.ev),
        );
        if (hits.length < 2) return null;
        const drop = new Set();
        const add = [];
        const addWords = [];
        for (const [k, g] of hits) {
          const t0 = timeOf(b, k * beat);
          const off = tOf(g[0].ev) - t0;
          g.forEach((n) => drop.add(n.t));
          to.forEach((f, i) => {
            add.push(t0 + off + f * beatSec(b));
            if (newWords && i > 0)
              addWords.push({
                word: newWords[i - 1] ?? newWords[0],
                label: newWords[i - 1] ?? newWords[0],
                time: t0 + off + f * beatSec(b),
              });
          });
        }
        const near = (t) => [...drop].some((d) => Math.abs(t - d) < 0.1);
        const stream = main(b);
        const out = {
          ...b,
          [stream]: [...b[stream].filter((e) => !near(tOf(e))), ...(stream === "words" ? [] : add)].sort((x, y) => tOf(x) - tOf(y)),
        };
        if (b.info.countMode) {
          // The counts follow the claps: the beat's number stays, the rest move (and change words when the count changes).
          const words = b.words.filter(
            (w) => !near(w.time) || /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/.test(w.label),
          );
          const moved = newWords
            ? addWords
            : hits.flatMap(([k, g]) =>
                g.slice(1).map((n) => ({
                  ...(b.words.find((w) => Math.abs(w.time - n.t) < 0.1) ?? { word: "and", label: "and" }),
                  time: timeOf(b, k * beat) + (tOf(g[0].ev) - timeOf(b, k * beat)) + to[1] * beatSec(b),
                })),
              );
          out.words = [...words, ...moved].sort((x, y) => x.time - y.time);
        }
        return out;
      },
    ]),
  ),
  "sub-words": (b) => {
    if (!b.info.countMode) return null;
    const es = b.words.filter((w) => w.label === "e");
    if (es.length < 3) return null;
    return { ...b, words: b.words.map((w) => (w.label === "e" ? { ...w, word: "and", label: "and" } : w)) };
  },
  forward: (b) => {
    if (!b.info.claps || !b.frames?.some((f) => f.scale)) return null;
    const longs = notesWithEvents(b).filter((n) => n.len >= 2 * R.beatLength(b.line.timeSig) - 1e-6);
    if (longs.length < 2) return null;
    // Hands together and still through every long note.
    const frames = b.frames.map((f) => {
      const n = longs.find((x) => f.time >= x.t && f.time <= x.t + x.len * secPerQ(b));
      if (!n) return f;
      const first = b.frames.find((g) => g.time >= n.t && g.scale);
      return first ? { ...f, together: true, palmY: first.palmY, scale: first.scale } : f;
    });
    return { ...b, frames };
  },
};
const KEEPS_CAMERA = new Set(["held-beat-clap", "tie-clap", "forward", "sub-words"]);
const NAMED = {
  "gave-up": ["gave-up"],
  stopped: ["stopped"],
  restart: ["restart"],
  "late-start": ["late-start"],
  "early-start": ["early-start"],
  "late-entrance": ["late-entrance"],
  // (On a tied note the beat after the start is the tied note itself.)
  "held-beat-clap": ["held-beat-clap", "tie-clap"],
  "cut-short": ["cut-short"],
  "tie-clap": ["tie-clap"],
  "sub-words": ["sub-words"],
  forward: ["forward"],
};
const named = (m) => NAMED[m] ?? (m.startsWith("morph") ? ["morph"] : [m]);

module.exports = { loadBases, grade, MISTAKES, named };

// ---- Run ---------------------------------------------------------------------
if (require.main === module) {
  const bases = loadBases();
  const stats = {};
  const examples = {};
  let clean = 0;
  let cleanNew = 0;
  const NEW = new Set([
    "late-start",
    "early-start",
    "restart",
    "gave-up",
    "stopped",
    "morph",
    "cut-short",
    "late-entrance",
    "tie-clap",
    "held-beat-clap",
    "sub-words",
    "forward",
  ]);
  for (const b of bases) {
    if (BASE && !b.name.includes(BASE)) continue;
    const before = grade(b);
    clean++;
    if ([before.top, ...before.more].some((t) => NEW.has(t.kind))) cleanNew++;
    for (const [m, inject] of Object.entries(MISTAKES)) {
      if (ONLY && m !== ONLY) continue;
      let changed = inject(b);
      // Moving or removing claps in the audio would leave the camera still seeing
      // them where they were (a contradiction no real take has): drop the camera.
      if (changed && !KEEPS_CAMERA.has(m)) changed = { ...changed, frames: null };
      if (!changed) continue;
      const fb = grade(changed);
      const kinds = [fb.top, ...fb.more].map((t) => t.kind);
      const s = (stats[m] ??= { takes: 0, top: 0, any: 0, instead: {} });
      s.takes++;
      if (named(m).includes(kinds[0])) s.top++;
      if (kinds.some((k) => named(m).includes(k))) s.any++;
      else s.instead[kinds[0]] = (s.instead[kinds[0]] ?? 0) + 1;
      if (!named(m).includes(kinds[0])) (examples[m] ??= []).push({ name: b.name, top: fb.top.text, more: fb.more.map((t) => t.text) });
    }
  }
  console.log(
    `${clean} clean takes as bases (${bases.filter((b) => b.real).length} real, ${bases.filter((b) => !b.real).length} synthetic); ${cleanNew} of them already get a new-kind tip\n`,
  );
  console.log("mistake put in".padEnd(26), "takes   named first   named at all   said instead (when not named)");
  for (const [m, s] of Object.entries(stats)) {
    const instead = Object.entries(s.instead)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    console.log(
      m.padEnd(26),
      String(s.takes).padStart(5),
      `${Math.round((100 * s.top) / s.takes)}%`.padStart(13),
      `${Math.round((100 * s.any) / s.takes)}%`.padStart(14),
      "  " + instead,
    );
  }
  if (show)
    for (const [m, ex] of Object.entries(examples))
      for (const e of ex.slice(0, show)) console.log(`\n[${m}] ${e.name}\n  ★ ${e.top}${e.more.map((x) => `\n  · ${x}`).join("")}`);
}
