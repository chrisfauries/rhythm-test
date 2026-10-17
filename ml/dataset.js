// Builds the count-word training set from capture zips (and debug bundles).
//
//   node ml/dataset.js <folders-with-zips, searched recursively> ...
//
// For every expected count in a take performed as written, cuts a log-mel
// patch where an on-time count would be and labels it with the count from
// the notation. Labels from the labeler (labels.json inside the zip) take
// priority. With AUGMENT=1, each take is also copied (ml/augment.js) at 80
// and 140 bpm and with a higher voice; it's off by default now that real
// recordings at other tempos and voices are being collected.
// Writes ml/data/dataset.bin (float32 patches) and ml/data/dataset.json (one
// entry per patch).
const fs = require("fs");
const path = require("path");
const { readZip, wavSamples } = require("./zipread");
const F = require("./.build/ml/features.js");
const { ClapDetector } = require("./.build/audio/ClapDetector.js");
const C = require("./.build/audio/clapClassifier.js");
const { augment } = require("./augment");

/** Clap times (seconds into audio.wav) from the app's current detector. */
const detectClaps = (data, sr) => {
  const det = new ClapDetector(sr, C.CANDIDATE_OPTIONS);
  const onsets = [];
  for (let i = 0; i < data.length; i += 512) onsets.push(...det.process(data.subarray(i, i + 512), i / sr));
  return onsets.map((o) => C.classifyCandidate(data, sr, 0, o, 0)).filter((c) => c.isClap).map((c) => c.time);
};

const OUT = path.join(__dirname, "data");
const AUG_PER_CLEAN = 12; // synthetic "count under a clap" mixes per clean count
const JITTER = 0.04; // anchor jitter (s), so the model tolerates timing spread
// Augmented versions of each take: other tempos, and a higher voice (random
// +3..+6 semitones: children's formants sit ~15-35% above an adult's, so a
// full octave would sound like no real student). Fewer copies per count than
// the original, so augmentation doesn't swamp the real audio.
const AUG_TEMPOS = [80, 140];
const AUG_SEMITONES = [3, 6];
const COPIES = { real: { jitter: 4, mixes: AUG_PER_CLEAN, none: 3 }, aug: { jitter: 2, mixes: 4, none: 1 } };

// Deterministic randomness, so rebuilding gives the same dataset.
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const zips = require("./zips").findZips(process.argv.slice(2));
if (!zips.length) {
  console.error("usage: node ml/dataset.js <folder-with-zips> ...");
  process.exit(1);
}

const takes = [];
for (const zip of zips) {
  const files = readZip(zip);
  if (!files["diagnostics.json"] || !files["audio.wav"]) continue;
  const diag = JSON.parse(files["diagnostics.json"].toString("utf8"));
  const manifest = files["manifest.json"] ? JSON.parse(files["manifest.json"].toString("utf8")) : null;
  if (manifest?.synthetic) continue; // generated takes are for the audio model (ml/audio-dataset.js)
  // Labels saved by the labeler live inside the zip; older saves sit next to it as <name>.labels.json.
  const labelsFile = zip.replace(/\.zip$/, ".labels.json");
  const labels = files["labels.json"]
    ? JSON.parse(files["labels.json"].toString("utf8"))
    : fs.existsSync(labelsFile)
    ? JSON.parse(fs.readFileSync(labelsFile, "utf8"))
    : null;
  const wav = wavSamples(files["audio.wav"]);
  takes.push({
    name: path.basename(zip, ".zip"),
    diag,
    manifest,
    labels,
    x16: F.toFeatureRate(wav.data, wav.sr),
    claps: detectClaps(wav.data, wav.sr),
  });
}

const patches = [];
const meta = [];
const add = (patch, m) => {
  patches.push(patch);
  meta.push(m);
};

// Real claps without voice, to mix into clean counts and to teach "none".
const clapBank = [];
const t0Of = (d) => d.wavStartCtx;
const heardWav = (d, t) => t + d.offsets.mic - t0Of(d);

for (const take of takes) {
  const { diag: d, x16, claps } = take;
  const counting = d.grader.counts && d.grader.counts.length > 0;
  if (!counting && d.settings?.activity !== "sing") {
    // Clap-only take: every clap is a clean clap sample, and its beat is "none".
    // (Not sing takes: their "claps" are the detector mistaking sung notes.)
    for (const c of claps) {
      const a = Math.round((c - 0.02) * F.FEATURE_RATE);
      clapBank.push(x16.slice(a, a + Math.round(0.7 * F.FEATURE_RATE)));
    }
  }
}

/** Patches from one version of a take: `x16` is its audio, with every time scaled by `scale`. */
const addTake = (take, x16, scale, aug) => {
  const { diag: d, manifest, labels } = take;
  const copies = aug ? COPIES.aug : COPIES.real;
  const claps = take.claps.map((t) => t * scale);
  const asWritten = !manifest || manifest.performance === "as-written";
  const speech = d.offsets.speech ?? d.offsets.mic + 0.02;
  const anchorOf = (expectedTime) => (expectedTime + speech - t0Of(d)) * scale;
  const notes = d.grader.notes.map((n) => n.expectedTime);
  const counting = d.grader.counts && d.grader.counts.length > 0;
  const base = { take: take.name, aug: aug?.name ?? "", tempo: aug?.tempo ?? d.exercise.tempo, semitones: aug?.semitones ?? 0 };

  if (counting && (asWritten || labels)) {
    for (const c of d.grader.counts) {
      let label = c.label;
      if (labels?.counts) {
        const l = labels.counts.find((x) => Math.abs(x.pos - c.pos) < 1e-6);
        if (!l || l.label === "?") continue; // unsure: leave it out
        label = l.label ?? "none";
      }
      const anchor = anchorOf(c.expectedTime);
      // "Under a clap" when a clap was actually heard on this count.
      const heard = heardWav(d, c.expectedTime) * scale;
      const onClap = claps.some((t) => Math.abs(t - heard) < 0.12);
      // Slowing a take down smears its claps (WSOLA repeats bits of the attack, like a flam),
      // so slowed versions only get claps mixed in from the unmodified clap bank.
      if (onClap && scale > 1) continue;
      for (let k = 0; k < copies.jitter; k++) {
        const j = k === 0 ? 0 : (rand() * 2 - 1) * JITTER;
        add(F.melPatch(x16, anchor + j), { ...base, label, kind: onClap ? "masked" : "clean", synthetic: false });
      }
      // Synthetic: mix a real clap onto clean counts.
      if (!onClap && clapBank.length) {
        const n = Math.round(F.FEATURE_RATE * (F.PATCH_BEFORE + F.PATCH_AFTER + 0.2));
        for (let k = 0; k < copies.mixes; k++) {
          const start = Math.round((anchor - F.PATCH_BEFORE - 0.1) * F.FEATURE_RATE);
          const mix = x16.slice(Math.max(0, start), Math.max(0, start) + n);
          const clap = clapBank[Math.floor(rand() * clapBank.length)];
          const gain = 0.4 + rand() * 0.9;
          // Clap onset 60 ms before to 30 ms after the vowel onset.
          const at = Math.round((0.1 + F.PATCH_BEFORE + (rand() * 0.09 - 0.06) - 0.02) * F.FEATURE_RATE);
          for (let i = 0; i < clap.length && at + i < mix.length; i++) mix[at + i] += gain * clap[i];
          const j = (rand() * 2 - 1) * JITTER;
          add(F.melPatch(mix, F.PATCH_BEFORE + 0.1 + j), { ...base, label, kind: "masked", synthetic: true });
        }
      }
    }
  }

  // "none": beats where nobody spoke (clap-only takes), and the quiet before the count-in.
  if (!counting) {
    for (const t of notes) {
      for (let k = 0; k < copies.none; k++) {
        add(F.melPatch(x16, anchorOf(t) + (rand() * 2 - 1) * JITTER), { ...base, label: "none", kind: "no-count", synthetic: false });
      }
    }
  }
  if (!aug) {
    const firstClick = heardWav(d, d.clicks[0].ctx);
    for (let t = 0.25; t + F.PATCH_AFTER < firstClick - 0.05; t += 0.15) {
      add(F.melPatch(x16, t), { ...base, label: "none", kind: "silence", synthetic: false });
    }
  }
};

const augmentOn = process.env.AUGMENT === "1";
for (const take of takes) {
  addTake(take, take.x16, 1, null);
  if (!augmentOn) continue;
  const tempo = take.diag.exercise.tempo;
  const variants = [tempo, ...AUG_TEMPOS.filter((t) => Math.abs(t - tempo) > 10)];
  for (const target of variants) {
    for (const pitched of target === tempo ? [true] : [false, true]) {
      const semitones = pitched ? AUG_SEMITONES[0] + rand() * (AUG_SEMITONES[1] - AUG_SEMITONES[0]) : 0;
      const scale = tempo / target;
      const name = [target !== tempo && `${target}bpm`, pitched && `+${semitones.toFixed(1)}st`].filter(Boolean).join(" ");
      addTake(take, augment(take.x16, F.FEATURE_RATE, scale, semitones), scale, { name, tempo: target, semitones });
    }
  }
  process.stdout.write(".");
}
process.stdout.write("\n");

fs.mkdirSync(OUT, { recursive: true });
const P = F.PATCH_FRAMES * F.N_MELS;
const all = new Float32Array(patches.length * P);
patches.forEach((p, i) => all.set(p, i * P));
fs.writeFileSync(path.join(OUT, "dataset.bin"), Buffer.from(all.buffer));
fs.writeFileSync(
  path.join(OUT, "dataset.json"),
  JSON.stringify({ frames: F.PATCH_FRAMES, mels: F.N_MELS, takes: takes.map((t) => t.name), examples: meta })
);
const tally = {};
for (const m of meta) {
  const k = `${m.kind}${m.synthetic ? "*" : ""}`;
  tally[k] = tally[k] || {};
  tally[k][m.label] = (tally[k][m.label] || 0) + 1;
}
console.log(`${takes.length} takes, ${meta.length} patches (${F.PATCH_FRAMES}x${F.N_MELS}); clap bank ${clapBank.length}`);
for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(10)} ${JSON.stringify(v)}`);
