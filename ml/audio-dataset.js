// Builds the audio model's training set from capture zips (and debug bundles).
//
//   node ml/audio-dataset.js <folders-with-zips, searched recursively> ...
//
// Every take becomes its whole log-mel spectrogram (features.ts melFrames)
// plus per-frame targets for the model's outputs:
//   clap    a clap starts here
//   onset   a voiced syllable (spoken count or sung "Da") starts here
//   voiced  someone is voicing here
//   word    which syllable starts here (only near onsets)
// Targets come from the app's own detectors, checked against the notation:
// in a take performed as written, the grader matched every note to a clap and
// every count to a vowel onset, so those matched times are the labels.
// Anything uncertain (a note the grader couldn't match, a detected sound that
// matches no note) is masked (-1): the model is neither rewarded nor punished
// there. Labels from the labeler (labels.json in the zip) replace all of this.
//
// Count-only takes are also copied with real claps mixed in on every count,
// as if clapped and counted, so the model learns words under claps.
//
// Writes ml/data/audio.bin (float32 mel frames), ml/data/audio-targets.bin
// (float32 [frame][clap, onset, voiced, word]) and ml/data/audio.json.
const fs = require("fs");
const path = require("path");
const { readZip, wavSamples } = require("./zipread");
const { findZips } = require("./zips");
const F = require("./.build/ml/features.js");
const V = require("./.build/audio/voice.js");
const { ClapDetector } = require("./.build/audio/ClapDetector.js");
const C = require("./.build/audio/clapClassifier.js");
const R = require("./.build/music/rhythm.js");
const Book = require("./.build/music/book.js");

const OUT = path.join(__dirname, "data");
const SEC = F.FRAME_SEC;
const MASK = -1;
/** The sung syllable's class; spoken counts use their count labels. */
const SING = "sing";
/** Copies of each count-only take with claps mixed in. */
const CLAP_COPIES = 2;
// Real clap-and-count takes: the vowel starts 23-105 ms (median 62) after the clap.
const CLAP_LEAD = [0.02, 0.105];

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const detectClaps = (data, sr) => {
  const det = new ClapDetector(sr, C.CANDIDATE_OPTIONS);
  const onsets = [];
  for (let i = 0; i < data.length; i += 512) onsets.push(...det.process(data.subarray(i, i + 512), i / sr));
  return onsets.map((o) => C.classifyCandidate(data, sr, 0, o, 0)).filter((c) => c.isClap).map((c) => c.time);
};

const zips = findZips(process.argv.slice(2));
if (!zips.length) {
  console.error("usage: node ml/audio-dataset.js <folder-with-zips> ...");
  process.exit(1);
}

/** Per-frame targets for a take of `frames` frames. */
const newTargets = (frames) => ({
  clap: new Float32Array(frames),
  onset: new Float32Array(frames),
  voiced: new Float32Array(frames),
  word: new Float32Array(frames).fill(MASK),
});
const frameOf = (t) => Math.round(t / SEC);
/** Mask [t0, t1] (seconds) of a target, except where it is already positive. */
const mask = (arr, t0, t1) => {
  for (let k = Math.max(0, frameOf(t0)); k <= Math.min(arr.length - 1, frameOf(t1)); k++) if (arr[k] <= 0) arr[k] = MASK;
};
/** An event at `t`: 1 on its frame, softer on the neighbors (timing is only good to ~10 ms). */
const SPREAD = [0.2, 0.6, 1, 0.6, 0.2];
const mark = (arr, t) => {
  const k = frameOf(t);
  SPREAD.forEach((v, j) => {
    const i = k + j - 2;
    if (i >= 0 && i < arr.length) arr[i] = Math.max(arr[i] === MASK ? 0 : arr[i], v);
  });
};

const rawTakes = [];
for (const zip of zips) {
  const files = readZip(zip);
  if (!files["diagnostics.json"] || !files["audio.wav"]) continue;
  const diag = JSON.parse(files["diagnostics.json"].toString("utf8"));
  const manifest = files["manifest.json"] ? JSON.parse(files["manifest.json"].toString("utf8")) : null;
  const labelsFile = zip.replace(/\.zip$/, ".labels.json");
  const labels = files["labels.json"]
    ? JSON.parse(files["labels.json"].toString("utf8"))
    : fs.existsSync(labelsFile)
    ? JSON.parse(fs.readFileSync(labelsFile, "utf8"))
    : null;
  const asWritten = !manifest || manifest.performance === "as-written";
  if (!asWritten && !labels) {
    console.log(`  skipping ${path.basename(zip)}: performed with mistakes and not labeled yet`);
    continue;
  }
  rawTakes.push({ name: path.basename(zip, ".zip"), diag, labels, synthetic: !!manifest?.synthetic, speaker: manifest?.synthetic ? manifest.studentId : null, wav: wavSamples(files["audio.wav"]) });
}

/** What the student was doing (music/activity.ts); older bundles only say whether speech was on. */
const activityOf = (d) => {
  if (d.settings?.activity) return d.settings.activity;
  if (d.exercise.id === "calibrate-counts") return "count-notes";
  if (d.exercise.id === "calibrate-claps" || d.settings?.useSpeech === false) return "clap";
  return d.settings?.countMode === "all" ? "clap-count-all" : "clap-count-notes";
};

/** What the take's audio contains, as event times (seconds into audio.wav). */
const eventsOf = (take) => {
  const { diag: d, labels, wav } = take;
  const activity = activityOf(d);
  const claps = activity.includes("clap");
  // The counts the student should say, by today's conventions (music/rhythm.ts
  // expectedCounts): older captures stored their grader's counts, made before
  // "count everything" included the rests.
  const mode = activity === "clap-count-all" ? "all" : activity === "clap-count-notes" || activity === "count-notes" ? "notes" : null;
  const ex = d.exercise.source ? Book.findExercise(d.exercise.id)?.exercise ?? Book.customExercise(d.exercise.source, d.exercise.timeSig) : null;
  const expectedCounts =
    mode && ex && d.grader.secPerQ != null
      ? R.expectedCounts(ex.line, mode).map((c) => {
          const old = (d.grader.counts ?? []).find((o) => Math.abs(o.pos - c.pos) < 1e-6 && o.label === c.label);
          return { label: c.label, expectedTime: d.grader.startTime + c.pos * d.grader.secPerQ, time: old?.time ?? null, status: old?.status, unclear: old?.unclear };
        })
      : d.grader.counts ?? [];
  const counting = expectedCounts.length > 0;
  const sing = activity === "sing";
  const t0 = d.wavStartCtx;
  const mic = d.offsets.mic;
  const speech = d.offsets.speech ?? mic + 0.02;
  const heard = (t) => t + mic - t0;
  const spoken = (t) => t + speech - t0;
  const vf = V.voiceFrames(wav.data, wav.sr, 0);
  const runs = V.voiceRuns(vf);
  const segments = V.voicedSegments(vf);
  // Synthetic takes (ml/synth.js) know exactly where every sound is: nothing is unsure there.
  const exact = take.synthetic;
  const ev = { activity, exact, clapTimes: [], clapUnsure: [], onsets: [], onsetUnsure: [], runs, segments, detected: exact ? [] : detectClaps(wav.data, wav.sr) };

  if (labels) {
    for (const e of labels.events) {
      if (e.type === "clap") ev.clapTimes.push(e.t);
      if (e.type === "count") {
        if (e.label && e.label !== "?") ev.onsets.push({ t: e.t, word: e.label });
        else ev.onsetUnsure.push([e.t - 0.1, e.t + 0.1]);
      }
    }
    if (sing) for (const n of d.grader.notes) if (n.time != null) ev.onsets.push({ t: spoken(n.time), word: SING });
    return ev;
  }

  if (claps) {
    for (const n of d.grader.notes) {
      if (n.time != null && ["on-time", "early", "late"].includes(n.status)) ev.clapTimes.push(heard(n.time));
      else ev.clapUnsure.push([heard(n.expectedTime) - 0.2, heard(n.expectedTime) + 0.2]);
    }
  }
  // A vowel onset for each count / sung note: the grader's match, else the
  // voice onset nearest where it should be (what grading uses under claps).
  const voice = (expected, matched, word, vosk) => {
    const t = matched ?? V.voiceOnsetNear(vf, expected, runs);
    if (t === null || ev.onsets.some((o) => Math.abs(o.t - t) < 0.05)) ev.onsetUnsure.push([expected - 0.25, expected + 0.25]);
    else ev.onsets.push({ t, word, vosk });
  };
  // `vosk`: whether speech recognition heard this count's word right (the app today).
  const voskHeard = (c) => ["correct", "early", "late"].includes(c.status) && !c.unclear;
  if (counting) for (const c of expectedCounts) voice(spoken(c.expectedTime), c.time != null ? spoken(c.time) : null, c.label, voskHeard(c));
  if (sing) for (const n of d.grader.notes) voice(spoken(n.expectedTime), n.time != null ? spoken(n.time) : null, SING);
  return ev;
};

/** Frame targets from a take's events. */
const targetsOf = (frames, ev) => {
  const tg = newTargets(frames);
  // Sounds the detectors found that match nothing expected: unknown.
  if (ev.activity.includes("clap")) for (const t of ev.detected) if (!ev.clapTimes.some((c) => Math.abs(c - t) < 0.05)) mask(tg.clap, t - 0.04, t + 0.04);
  for (const [a, b] of ev.clapUnsure) mask(tg.clap, a, b);
  for (const [a, b] of ev.onsetUnsure) {
    mask(tg.onset, a, b);
    mask(tg.voiced, a, b);
  }
  const voicedRun = (s) => ev.runs.some((r) => r.end >= s.start && r.start <= s.end);
  if (!ev.exact) for (const s of ev.segments) if (voicedRun(s) && !ev.onsets.some((o) => Math.abs(o.t - s.onset) < 0.1)) mask(tg.onset, s.onset - 0.04, s.onset + 0.04);
  // Voicing: detector runs that belong to a labeled syllable; other runs are unknown.
  for (const r of ev.runs) {
    const ours = ev.onsets.some((o) => o.t >= r.start - 0.06 && o.t <= r.end);
    for (let k = Math.max(0, frameOf(r.start)); k <= Math.min(frames - 1, frameOf(r.end)); k++) tg.voiced[k] = ours ? 1 : tg.voiced[k] === 1 ? 1 : MASK;
  }
  for (const t of ev.clapTimes) mark(tg.clap, t);
  for (const o of ev.onsets) {
    mark(tg.onset, o.t);
    const k = frameOf(o.t);
    for (let i = Math.max(0, k - 2); i <= Math.min(frames - 1, k + 2); i++) tg.word[i] = WORDS.indexOf(o.word);
  }
  return tg;
};

const all = rawTakes.map((t) => ({ ...t, ev: eventsOf(t) }));
const WORDS = [...new Set(all.flatMap((t) => t.ev.onsets.map((o) => o.word)))].sort((a, b) => (a === SING) - (b === SING) || a.localeCompare(b));

// Clean claps to mix in: from clap-only takes, each up to the next clap (at most 0.5 s), faded out.
const bank = [];
for (const t of all) {
  if (t.ev.activity !== "clap" || t.synthetic) continue;
  const x16 = F.toFeatureRate(t.wav.data, t.wav.sr);
  const times = [...t.ev.clapTimes].sort((a, b) => a - b);
  times.forEach((c, i) => {
    const a = Math.round((c - 0.01) * F.FEATURE_RATE);
    const end = Math.min(c + 0.5, (times[i + 1] ?? Infinity) - 0.03);
    const clip = x16.slice(Math.max(0, a), Math.round(end * F.FEATURE_RATE));
    const fade = Math.min(clip.length, Math.round(0.03 * F.FEATURE_RATE));
    for (let j = 0; j < fade; j++) clip[clip.length - 1 - j] *= j / fade;
    if (clip.length > 0.1 * F.FEATURE_RATE) bank.push(clip);
  });
}

const takes = [];
const melParts = [];
const targetParts = [];
let offset = 0;
const addVersion = (name, group, src, x16, ev) => {
  const mel = F.melFrames(x16);
  const tg = targetsOf(mel.frames, ev);
  const packed = new Float32Array(mel.frames * 4);
  for (let k = 0; k < mel.frames; k++) {
    packed[k * 4] = tg.clap[k];
    packed[k * 4 + 1] = tg.onset[k];
    packed[k * 4 + 2] = tg.voiced[k];
    packed[k * 4 + 3] = tg.word[k];
  }
  melParts.push(mel.data);
  targetParts.push(packed);
  takes.push({
    name,
    group,
    activity: ev.activity,
    /** A copy of a real take with claps mixed in. */
    synthetic: name !== group,
    /** Generated from scratch (ml/synth.js). */
    generated: src.synthetic,
    /** Which generated voice ("claps" for clap-only tracks); null for real takes. */
    speaker: src.speaker ?? null,
    tempo: src.diag.exercise.tempo,
    offset,
    frames: mel.frames,
    claps: ev.clapTimes,
    onsets: ev.onsets.map((o) => ({ t: o.t, word: o.word, vosk: o.vosk, underClap: ev.clapTimes.some((c) => Math.abs(o.t - c) < 0.15) })),
  });
  offset += mel.frames;
};

for (const t of all) {
  const x16 = F.toFeatureRate(t.wav.data, t.wav.sr);
  addVersion(t.name, t.name, t, x16, t.ev);
  // A count-only take, clapped: a real clap shortly before every count's vowel.
  if (!t.synthetic && t.ev.activity.startsWith("count") && bank.length) {
    for (let copy = 0; copy < CLAP_COPIES; copy++) {
      const mixed = Float32Array.from(x16);
      const clapTimes = [];
      for (const o of t.ev.onsets) {
        const c = o.t - (CLAP_LEAD[0] + rand() * (CLAP_LEAD[1] - CLAP_LEAD[0]));
        const clip = bank[Math.floor(rand() * bank.length)];
        const gain = 0.5 + rand();
        const at = Math.round((c - 0.01) * F.FEATURE_RATE);
        for (let j = 0; j < clip.length && at + j < mixed.length; j++) if (at + j >= 0) mixed[at + j] += gain * clip[j];
        clapTimes.push(c);
      }
      addVersion(`${t.name} +claps${copy + 1}`, t.name, t, mixed, { ...t.ev, activity: "clap-" + t.ev.activity, clapTimes, clapUnsure: [], detected: [] });
    }
  }
  process.stdout.write(".");
}
process.stdout.write("\n");

fs.mkdirSync(OUT, { recursive: true });
const write = (file, parts) => {
  const fd = fs.openSync(path.join(OUT, file), "w");
  for (const p of parts) fs.writeSync(fd, Buffer.from(p.buffer, p.byteOffset, p.byteLength));
  fs.closeSync(fd);
};
write("audio.bin", melParts);
write("audio-targets.bin", targetParts);
fs.writeFileSync(path.join(OUT, "audio.json"), JSON.stringify({ mels: F.N_MELS, frameSec: SEC, words: WORDS, takes }));

const real = takes.filter((t) => !t.synthetic);
const tally = {};
for (const t of takes) for (const o of t.onsets) tally[o.word] = (tally[o.word] ?? 0) + 1;
console.log(`${real.length} takes (+${takes.length - real.length} with claps mixed in), ${(offset * SEC / 60).toFixed(1)} min of audio; clap bank ${bank.length}`);
console.log(`  claps ${takes.reduce((n, t) => n + t.claps.length, 0)}, syllables ${JSON.stringify(tally)}`);
