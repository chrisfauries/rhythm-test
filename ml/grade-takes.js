// Grades captures with the audio model, as the app does, against the music as
// written (no labels needed), and lists the lowest-scoring takes with every
// beat it marked down. A take you played cleanly should score 100%: anything
// it flags there is the model's or the grader's mistake, not yours.
//
//   npm run ml:grade-takes [-- <zip or folder>...] [--rules] [--all]
//
// --rules grades what the take's own detectors recorded at the time (clap
// detector, voicing rules, Vosk) instead. Calibration takes are skipped.
// Shows the 15 lowest takes; --all shows every take. Under each take: the
// feedback the student would see (★ the top tip, · the others).
const path = require("path");
const { readZip, wavSamples } = require("./zipread");
const { findZips } = require("./zips");
const A = require("./.build/analysis/analyze.js");
const FB = require("./.build/analysis/feedback.js");
const M = require("./.build/ml/audioModel.js");
const V = require("./.build/audio/voice.js");
const Book = require("./.build/music/book.js");
const Act = require("./.build/music/activity.js");
const R = require("./.build/music/rhythm.js");

const args = process.argv.slice(2);
// --json <file>: also write every take's full feedback (to compare versions of the engine).
const JSON_OUT = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const snapshot = [];
process.on("exit", () => JSON_OUT && require("fs").writeFileSync(JSON_OUT, JSON.stringify(snapshot, null, 1)));
const RULES = args.includes("--rules");
const ALL = args.includes("--all");
const paths = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--json");
const model = RULES ? null : new M.AudioModel(require("../public/models/audio.json"));
const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);

const takes = [];
for (const zip of findZips(paths.length ? paths : ["dataset"])) {
  if (/calibrate|synthetic/.test(zip)) continue;
  const files = readZip(zip);
  if (!files["diagnostics.json"] || !files["audio.wav"]) continue;
  const diag = JSON.parse(files["diagnostics.json"].toString("utf8"));
  if (!diag.exercise?.source) continue;
  const { sr, data } = wavSamples(files["audio.wav"]);
  const t0 = diag.wavStartCtx;
  const ex = Book.findExercise(diag.exercise.id)?.exercise ?? Book.customExercise(diag.exercise.source, diag.exercise.timeSig);
  const line = ex.line;
  const activity = Act.activityOfSettings(diag.settings);
  const info = Act.activityInfo(activity);
  const speech = diag.offsets.speech;
  const vf = V.voiceFrames(data, sr, t0);
  const runs = V.voiceRuns(vf);
  const rec = diag.grader.input;
  const heard = model ? M.modelGraderInput(model, data, sr, t0, { mic: diag.offsets.mic, speech }).input : null;
  const result = A.analyzeTake({
    line,
    bpm: diag.exercise.tempo,
    startTime: diag.timing.lineStart,
    activity,
    strictness: diag.settings.strictness ?? "normal",
    claps: heard ? heard.claps : rec.claps,
    words: info.countMode ? (heard ? heard.words : rec.words) : null,
    frames: rec.frames,
    // The audio model hears counts under claps itself; the rules' voice
    // detector would take a clap's ring for a voice onset.
    voiceOnsetNear: info.claps && (!heard || process.env.MASKED_RULE)
      ? (t) => {
          const o = V.voiceOnsetNear(vf, t + speech, runs);
          return o === null ? null : o - speech;
        }
      : undefined,
    sungOnsets: !info.sing ? undefined : heard ? heard.sungOnsets : V.sungOnsets(vf, V.voicedSegments(vf)).map((t) => t - speech),
    voicedSpans: !info.sing && !info.countMode ? undefined : heard ? heard.voicedSpans : runs.map((r) => [r.start - speech, r.end - speech]),
  });

  // Where a position is, as the student would say it: "m3 2&".
  const mLen = R.measureLength(line.timeSig);
  const beat = R.beatLength(line.timeSig);
  const at = (pos) => {
    const m = Math.floor(pos / mLen + 1e-6);
    const inM = pos - m * mLen;
    const label = R.countLabel(inM / beat);
    const word = label === "?" ? `+${(inM / beat).toFixed(2)}` : label === "a" ? `${Math.floor(inM / beat + 1e-4) + 1}uh` : /^[a-z]+$/.test(R.countDisplay(label)) || R.countDisplay(label) === "&" ? `${Math.floor(inM / beat + 1e-4) + 1}${R.countDisplay(label)}` : R.countDisplay(label);
    return `m${m + 1} ${word}`;
  };
  const say = (l) => (l === "a" ? "uh" : l === "sing" ? "Da" : R.countDisplay(l));
  const ms = (x) => `${x > 0 ? "+" : ""}${x} ms`;
  const noun = info.sing ? "note" : info.claps ? "clap" : "note";
  const flags = [];
  if (info.claps || info.sing)
    for (const n of result.notes) {
      if (n.status === "missed") flags.push({ pos: n.pos, text: `${noun} missed` });
      else if (n.status === "early" || n.status === "late") flags.push({ pos: n.pos, text: `${noun} ${n.status} ${ms(n.offsetMs)}` });
      else if (n.status === "seen") flags.push({ pos: n.pos, text: `${noun} only seen on camera` });
      if (n.hold?.status === "released") flags.push({ pos: n.pos, text: info.sing ? `not sustained (${pct(n.hold.fraction)} voiced)` : `hands not held together (${pct(n.hold.fraction)})` });
    }
  for (const c of result.counts ?? []) {
    if (c.status === "missed") flags.push({ pos: c.pos, text: `count "${say(c.label)}" missed` });
    else if (c.status === "wrong") flags.push({ pos: c.pos, text: `count "${say(c.label)}" heard as "${say(c.heard)}"` });
    else if (c.status === "early" || c.status === "late") flags.push({ pos: c.pos, text: `count "${say(c.label)}" ${c.status} ${ms(c.offsetMs)}` });
  }
  for (const r of result.rests ?? []) if (r.status === "missed") flags.push({ pos: r.pos, text: "rest pulse missed" });
  for (const e of result.extraClaps) flags.push({ pos: e.pos, text: `extra ${noun}`, time: e.time });
  for (const e of result.extraWords) flags.push({ pos: e.pos, text: `extra word "${e.text}"`, time: e.time });
  flags.sort((a, b) => a.pos - b.pos);
  const wav = (t) => (t + diag.offsets.mic - t0).toFixed(2);
  const fb = FB.feedback({ result, line, activity: info, bpm: diag.exercise.tempo, metronome: diag.settings.metronomeDuringLine !== false });
  if (JSON_OUT) snapshot.push({ take: zip, fb });
  takes.push({
    name: path.basename(zip, ".zip"),
    s: result.summary,
    fb,
    flags: flags.map((f) => `${at(Math.max(0, f.pos))} (${wav(result.startTime + f.pos * result.secPerQ)} s): ${f.text}`),
  });
}

takes.sort((a, b) => a.s.overall - b.s.overall);
console.log(`${takes.length} takes graded by ${RULES ? "the rules and Vosk (as recorded)" : "the audio model"} against the music as written`);
console.log(`mean overall ${pct(takes.reduce((a, t) => a + t.s.overall, 0) / takes.length)}; ${takes.filter((t) => t.s.overall > 0.995).length} at 100%\n`);
for (const t of ALL ? takes : takes.slice(0, 15)) {
  const parts = [["notes", t.s.clapScore], ["counts", t.s.countScore], ["holds", t.s.holdScore]].filter(([, v]) => v != null).map(([k, v]) => `${k} ${pct(v)}`);
  console.log(`${pct(t.s.overall).padStart(4)}  ${t.name}   (${parts.join(", ")})`);
  console.log(`      ★ ${t.fb.top.text}`);
  for (const m of t.fb.more) console.log(`      · ${m.text}`);
  for (const f of t.flags) console.log(`        ${f}`);
}
