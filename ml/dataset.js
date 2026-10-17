// Builds the count-word training set from capture zips (and debug bundles).
//
//   node ml/dataset.js <folder-with-zips> [more folders...]
//
// For every expected count in a take performed as written, cuts a log-mel
// patch where an on-time count would be and labels it with the count from
// the notation. Labels from the labeler (<name>.labels.json next to a zip)
// take priority. Writes ml/data/dataset.bin (float32 patches) and
// ml/data/dataset.json (one entry per patch).
const fs = require("fs");
const path = require("path");
const { readZip, wavSamples } = require("./zipread");
const F = require("./.build/ml/features.js");
const { ClapDetector } = require("./.build/audio/ClapDetector.js");
const C = require("./.build/audio/clapClassifier.js");

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

// Deterministic randomness, so rebuilding gives the same dataset.
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

const zips = process.argv.slice(2).flatMap((dir) =>
  fs.statSync(dir).isDirectory()
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".zip")).map((f) => path.join(dir, f))
    : [dir]
);
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
  const labelsFile = zip.replace(/\.zip$/, ".labels.json");
  const labels = fs.existsSync(labelsFile) ? JSON.parse(fs.readFileSync(labelsFile, "utf8")) : null;
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
  if (!counting) {
    // Clap-only take: every clap is a clean clap sample, and its beat is "none".
    for (const c of claps) {
      const a = Math.round((c - 0.02) * F.FEATURE_RATE);
      clapBank.push(x16.slice(a, a + Math.round(0.7 * F.FEATURE_RATE)));
    }
  }
}

for (const take of takes) {
  const { diag: d, x16, manifest, labels, claps } = take;
  const asWritten = !manifest || manifest.performance === "as-written";
  const speech = d.offsets.speech ?? d.offsets.mic + 0.02;
  const anchorOf = (expectedTime) => expectedTime + speech - t0Of(d);
  const notes = d.grader.notes.map((n) => n.expectedTime);
  const counting = d.grader.counts && d.grader.counts.length > 0;

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
      const heard = heardWav(d, c.expectedTime);
      const onClap = claps.some((t) => Math.abs(t - heard) < 0.12);
      for (let k = 0; k < 4; k++) {
        const j = k === 0 ? 0 : (rand() * 2 - 1) * JITTER;
        add(F.melPatch(x16, anchor + j), { take: take.name, label, kind: onClap ? "masked" : "clean", synthetic: false });
      }
      // Synthetic: mix a real clap onto clean counts.
      if (!onClap && clapBank.length) {
        const n = Math.round(F.FEATURE_RATE * (F.PATCH_BEFORE + F.PATCH_AFTER + 0.2));
        for (let k = 0; k < AUG_PER_CLEAN; k++) {
          const start = Math.round((anchor - F.PATCH_BEFORE - 0.1) * F.FEATURE_RATE);
          const mix = x16.slice(Math.max(0, start), Math.max(0, start) + n);
          const clap = clapBank[Math.floor(rand() * clapBank.length)];
          const gain = 0.4 + rand() * 0.9;
          // Clap onset 60 ms before to 30 ms after the vowel onset.
          const at = Math.round((0.1 + F.PATCH_BEFORE + (rand() * 0.09 - 0.06) - 0.02) * F.FEATURE_RATE);
          for (let i = 0; i < clap.length && at + i < mix.length; i++) mix[at + i] += gain * clap[i];
          const j = (rand() * 2 - 1) * JITTER;
          add(F.melPatch(mix, F.PATCH_BEFORE + 0.1 + j), { take: take.name, label, kind: "masked", synthetic: true });
        }
      }
    }
  }

  // "none": beats where nobody spoke (clap-only takes), and the quiet before the count-in.
  if (!counting) {
    for (const t of notes) {
      for (let k = 0; k < 3; k++) {
        add(F.melPatch(x16, anchorOf(t) + (rand() * 2 - 1) * JITTER), { take: take.name, label: "none", kind: "no-count", synthetic: false });
      }
    }
  }
  const firstClick = heardWav(d, d.clicks[0].ctx);
  for (let t = 0.25; t + F.PATCH_AFTER < firstClick - 0.05; t += 0.15) {
    add(F.melPatch(x16, t), { take: take.name, label: "none", kind: "silence", synthetic: false });
  }
}

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
