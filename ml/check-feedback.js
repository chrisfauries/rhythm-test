// Checks the feedback engine (src/analysis/feedback.ts) on synthetic takes
// with mistakes, graded from their exact labels (so the model's hearing is
// out of the picture): does the feedback name the mistakes that were put in,
// and does it invent ones that weren't (a skipped beat, rushing)?
//
//   npm run ml:check-feedback [-- <folder>] [--show N]
const path = require("path");
const { readZip } = require("./zipread");
const { findZips } = require("./zips");
const A = require("./.build/analysis/analyze.js");
const FB = require("./.build/analysis/feedback.js");
const Book = require("./.build/music/book.js");
const Act = require("./.build/music/activity.js");

const args = process.argv.slice(2);
// --json <file>: also write every take's full feedback (to compare versions of the engine).
const JSON_OUT = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const snapshot = [];
process.on("exit", () => JSON_OUT && require("fs").writeFileSync(JSON_OUT, JSON.stringify(snapshot, null, 1)));
const show = args.includes("--show") ? +args[args.indexOf("--show") + 1] : 0;
const folders = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--show" && args[i - 1] !== "--json");
// Which tip kinds count as naming each injected mistake.
const NAMES = {
  rushing: ["rushing", "early"],
  dragging: ["dragging", "late"],
  "missed-clap": ["missed", "added-beat", "skipped-beat", "late-entrance", "cut-short"],
  "extra-clap": ["extra", "held-beat-clap", "tie-clap", "cut-short"],
  "early-clap": ["figure", "early", "rushing", "timing", "cut-short"],
  "late-clap": ["figure", "late", "dragging", "timing", "late-entrance"],
  "wrong-word": ["wrong-numbers"],
  "missed-word": ["missed", "held-counts", "rest-counts"],
  "extra-word": ["extra-words", "silent-rests", "extra"],
  "early-word": ["figure", "early", "count-timing", "rushing", "timing"],
  "late-word": ["figure", "late", "count-timing", "dragging", "timing"],
  // One "structural" mistake (synth.js addStructural).
  "gave-up": ["gave-up"],
  stopped: ["stopped"],
  restart: ["restart"],
  "late-start": ["late-start"],
  "early-start": ["early-start"],
  "morph-triplet": ["morph"],
  "morph-swing": ["morph"],
  "held-beat-clap": ["held-beat-clap", "tie-clap"],
  "tie-clap": ["tie-clap"],
  "cut-short": ["cut-short"],
};
// Diagnoses that should only appear when that mistake was made.
const INVENTED = [
  "added-beat",
  "skipped-beat",
  "rushing",
  "dragging",
  "rushing-runs",
  "dragging-runs",
  "late-start",
  "early-start",
  "restart",
  "gave-up",
  "stopped",
  "morph",
  "sub-words",
];
const stats = {};
const examples = [];
let n = 0;
let cleanPraise = 0;
let clean = 0;
for (const zip of findZips(folders.length ? folders : ["dataset/synthetic"])) {
  const files = readZip(zip);
  if (!files["labels.json"]) continue;
  const m = JSON.parse(files["manifest.json"].toString("utf8"));
  const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
  const labels = JSON.parse(files["labels.json"].toString("utf8"));
  const mistakes = m.mistakes ?? [];
  // A sample of clean takes, for praise: the same one every run, so runs compare.
  if (!mistakes.length && [...zip].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 10 !== 0) continue;
  const ex = Book.findExercise(d.exercise.id)?.exercise ?? Book.customExercise(d.exercise.source, d.exercise.timeSig);
  const activity = Act.activityOfSettings(d.settings);
  const info = Act.activityInfo(activity);
  const ev = labels.events;
  const words = ev.filter((e) => e.type === "count" && e.label !== "sing").map((e) => ({ word: e.label, label: e.label, time: e.t }));
  const result = A.analyzeTake({
    line: ex.line,
    bpm: d.exercise.tempo,
    startTime: d.timing.lineStart,
    activity,
    strictness: "normal",
    claps: ev.filter((e) => e.type === "clap").map((e) => e.t),
    words: info.countMode ? words : null,
    frames: null,
    sungOnsets: info.sing ? ev.filter((e) => e.type === "count" && e.label === "sing").map((e) => e.t) : undefined,
  });
  const fb = FB.feedback({
    result,
    line: ex.line,
    activity: info,
    bpm: d.exercise.tempo,
    metronome: d.settings.metronomeDuringLine !== false,
  });
  if (JSON_OUT) snapshot.push({ take: zip, fb });
  const kinds = [fb.top, ...fb.more].map((t) => t.kind);
  n++;
  if (!mistakes.length) {
    clean++;
    if (fb.top.kind === "praise") cleanPraise++;
    else if (examples.length < show) examples.push({ name: path.basename(zip), put: "none", top: fb.top.text });
    continue;
  }
  const types = [...new Set(mistakes.map((x) => x.type))];
  for (const t of types) {
    const s = (stats[t] ??= { takes: 0, named: 0, top: 0 });
    s.takes++;
    if (kinds.some((k) => NAMES[t]?.includes(k))) s.named++;
    if (NAMES[t]?.includes(fb.top.kind)) s.top++;
  }
  const invented = kinds.filter((k) => INVENTED.includes(k) && !types.some((t) => NAMES[t]?.includes(k)));
  for (const k of invented) (stats[`(invented) ${k}`] ??= { takes: 0, named: 0, top: 0 }).takes++;
  if (examples.length < show && Math.random() < 0.05)
    examples.push({ name: path.basename(zip), put: types.join(", "), top: fb.top.text, more: fb.more.map((t) => t.text) });
}
console.log(`${n} synthetic takes graded from their labels (${clean} clean: ${cleanPraise} got praise)\n`);
console.log("mistake put in".padEnd(26), "takes   named anywhere   named first");
for (const [t, s] of Object.entries(stats).sort()) {
  if (t.startsWith("(")) continue;
  console.log(
    t.padEnd(26),
    String(s.takes).padStart(5),
    `${Math.round((100 * s.named) / s.takes)}%`.padStart(14),
    `${Math.round((100 * s.top) / s.takes)}%`.padStart(13),
  );
}
const inv = Object.entries(stats).filter(([t]) => t.startsWith("("));
console.log(`\ninvented (named but not put in): ${inv.map(([t, s]) => `${t.slice(11)} ${s.takes}`).join(", ") || "none"}`);
for (const e of examples) console.log(`\n${e.name} [${e.put}]\n  ★ ${e.top}${(e.more ?? []).map((x) => `\n  · ${x}`).join("")}`);
