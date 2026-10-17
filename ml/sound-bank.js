// Builds the sound bank that synthetic takes (ml/synth.js) are made from:
//
//   node ml/sound-bank.js <folders with real captures> ...
//
//   dataset/voices/<speaker>/<word>-<n>.wav  count words (from ml/voices.py's
//                                             text-to-speech clips: resampled, child
//                                             voices pitched up, silence trimmed)
//   dataset/voices/claps/clap-<n>.wav         real claps from clap-only takes (16,
//                                             spread over loudness and brightness), plus
//                                             every clap in dataset/clap-recordings/*.wav
//                                             (free-form recordings of people clapping)
//   dataset/voices/noise/room-<n>.wav         quiet room sound from before the
//                                             count-in of real takes
//   dataset/voices/chatter/chatter-<n>.wav    TV-like talk for the background
//   dataset/voices/bank.json                  every clip, with where its vowel /
//                                             clap starts
//
// Real people's words or claps can be added later as more folders in the same
// layout (dataset/voices/<speaker>/<word>-<n>.wav) and listed in bank.json.
const fs = require("fs");
const path = require("path");
const { readZip, wavSamples, wavBytes } = require("./zipread");
const { findZips } = require("./zips");
const { augment } = require("./augment");
const F = require("./.build/ml/features.js");
const V = require("./.build/audio/voice.js");

const SR = F.FEATURE_RATE;
const RAW = path.join(__dirname, "data", "tts-raw");
const OUT = path.join(__dirname, "..", "dataset", "voices");
const CLAPS = 16;
const NOISE = 24;
const RECORDINGS = path.join(__dirname, "..", "dataset", "clap-recordings");
const RECORDED_CLAPS = 48;

const db = (x) => 10 * Math.log10(Math.max(x, 1e-12));
const write = (rel, x) => {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wavBytes(x, SR));
  return rel.replace(/\\/g, "/");
};

/** Short-time energy (10 ms frames). */
const frameEnergy = (x) => {
  const n = Math.round(0.01 * SR);
  return Array.from({ length: Math.floor(x.length / n) }, (_, f) => {
    let e = 0;
    for (let i = f * n; i < (f + 1) * n; i++) e += x[i] * x[i];
    return e / n;
  });
};

// --- words ----------------------------------------------------------------
const tts = JSON.parse(fs.readFileSync(path.join(RAW, "speakers.json"), "utf8"));
fs.rmSync(OUT, { recursive: true, force: true });
const bank = { sampleRate: SR, speakers: [], claps: [], noise: [], chatter: [] };

const pitchAt = (x, c) => require("./pitch").pitchAt(x, c, SR);

/**
 * The steadiest stretch of a sung vowel (80 ms, after the consonant):
 * where the pitch moves least. Singing loops this, so a held note stays on pitch.
 */
const steadyVowel = (x, onset) => {
  const step = Math.round(0.01 * SR);
  const track = [];
  const rms = (c) => {
    let e = 0;
    for (let i = c - (step >> 1); i < c + (step >> 1); i++) e += x[i] * x[i];
    return e / step;
  };
  for (let c = Math.round((onset + 0.03) * SR); c < x.length - 0.04 * SR; c += step) track.push({ c, f0: pitchAt(x, c), e: rms(c) });
  const loudest = Math.max(...track.map((p) => p.e));
  let best = null;
  const len = Math.min(8, track.length);
  for (let i = 0; i + len <= track.length; i++) {
    const seg = track.slice(i, i + len);
    // Steady in pitch, and still near full voice (not the fading end of the word).
    if (seg.some((p) => !p.f0 || db(p.e) < db(loudest) - 6)) continue;
    const st = seg.map((p) => 12 * Math.log2(p.f0));
    const spread = Math.max(...st) - Math.min(...st);
    if (!best || spread < best.spread) best = { spread, from: seg[0].c, to: seg[seg.length - 1].c, f0: 2 ** (st.reduce((a, b) => a + b) / st.length / 12) };
  }
  return best && { from: +(best.from / SR).toFixed(4), to: +(best.to / SR).toFixed(4), f0: +best.f0.toFixed(1), spread: +best.spread.toFixed(2) };
};
/** The median pitch (Hz) of a raw voice's "dah"s, before any shift. */
const voicePitch = (dir) => {
  const f0s = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("da-"))) {
    const raw = wavSamples(fs.readFileSync(path.join(dir, f)));
    const x = F.toFeatureRate(raw.data, raw.sr);
    for (let c = Math.round(0.1 * SR); c < x.length - 0.1 * SR; c += Math.round(0.02 * SR)) {
      const p = pitchAt(x, c);
      if (p) f0s.push(p);
    }
  }
  f0s.sort((a, b) => a - b);
  return f0s.length ? f0s[f0s.length >> 1] : null;
};
const median = (xs) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
// Children: a light voice moved up to a child's pitch (230-290 Hz). A voice that would need more
// than 7 semitones sounds like a cartoon, so it stays an adult (unless that adult is already in).
const CHILD_HZ = [230, 290];
const MAX_CHILD_SHIFT = 7;
// More children from the higher adult voices' clips (pitched up, they're new speakers).
const EXTRA_CHILDREN = ["kokoro-af_sarah", "kokoro-af_jessica", "kokoro-af_bella", "kokoro-bf_emma", "piper-southern_english_female", "piper-vctk-40", "piper-vctk-3", "piper-l2arctic-11", "piper-amy", "piper-alba", "piper-ljspeech"];
const names = new Set(tts.speakers.filter((s) => !s.semitones).map((s) => s.name));
const all = [...tts.speakers, ...EXTRA_CHILDREN.map((base) => ({ ...tts.speakers.find((s) => s.name === base), name: `${base}-child`, from: base, semitones: 1 }))];
let childN = 0;
for (const spk of all) {
  const dir = path.join(RAW, spk.from ?? spk.name);
  if (spk.semitones) {
    const f0 = voicePitch(dir);
    const target = CHILD_HZ[0] + ((childN++ * 0.37) % 1) * (CHILD_HZ[1] - CHILD_HZ[0]);
    const needed = f0 ? 12 * Math.log2(CHILD_HZ[0] / f0) : 0;
    const shift = f0 ? Math.min(MAX_CHILD_SHIFT, 12 * Math.log2(target / f0)) : spk.semitones;
    if (needed > MAX_CHILD_SHIFT) {
      const adult = spk.name.replace(/-child$/, "");
      console.log(`  ${spk.name}: too low for a child (${Math.round(f0)} Hz)${names.has(adult) ? ", left out" : `, used as an adult (${adult})`}`);
      if (names.has(adult)) continue;
      spk.name = adult;
      spk.semitones = 0;
      names.add(adult);
    } else {
      spk.semitones = +Math.max(0, shift).toFixed(2);
      console.log(`  ${spk.name}: ${Math.round(f0)} Hz, +${spk.semitones} semitones`);
    }
  }
  const words = {};
  for (const word of tts.words) {
    words[word] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.startsWith(`${word}-`)).sort()) {
      const raw = wavSamples(fs.readFileSync(path.join(dir, f)));
      let x = F.toFeatureRate(raw.data, raw.sr);
      if (spk.semitones) x = augment(x, SR, 1, spk.semitones);
      // Trim to the sound: from 20 ms before it rises above -40 dB of its peak to 30 ms after it falls below.
      const e = frameEnergy(x);
      const peak = Math.max(...e);
      // A voice that stops while still loud was cut off by the text-to-speech engine.
      if (db(e[e.length - 2]) > db(peak) - 25) console.warn(`  WARNING: ${spk.name}/${f} ends abruptly (cut off?)`);
      const on = e.map((v) => db(v) > db(peak) - 40);
      const a = Math.max(0, on.indexOf(true) * 0.01 - 0.02);
      const b = Math.min(x.length / SR, (on.lastIndexOf(true) + 1) * 0.01 + 0.03);
      x = x.slice(Math.round(a * SR), Math.round(b * SR));
      const fade = Math.round(0.01 * SR);
      for (let i = 0; i < fade; i++) {
        x[i] *= i / fade;
        x[x.length - 1 - i] *= i / fade;
      }
      // Normalize to the same loudness; synth.js varies it.
      let s = 0;
      for (const v of x) s = Math.max(s, Math.abs(v));
      for (let i = 0; i < x.length; i++) x[i] *= 0.5 / s;
      // The vowel onset (where a counted syllable sits on the beat), as the app finds it.
      const vf = V.voiceFrames(x, SR, 0);
      const segs = V.voicedSegments(vf);
      const loudest = segs.reduce((m, g) => Math.max(m, g.peak), 0);
      const first = segs.find((g) => db(g.peak) > db(loudest) - 10);
      const onset = first ? first.onset : 0.03;
      const clip = { file: write(path.join(spk.name, f), x), onset: +onset.toFixed(4), seconds: +(x.length / SR).toFixed(4) };
      if (word === "da") clip.vowel = steadyVowel(x, onset);
      words[word].push(clip);
    }
  }
  // Sung "dah"s without a steady pitched stretch can't be held on one note.
  if (words.da) words.da = words.da.filter((c) => c.vowel);
  // ...and ones whose pitch is far from the voice's usual (a misread octave, or a squeak).
  if (words.da?.length) {
    const mid = median(words.da.map((c) => c.vowel.f0));
    words.da = words.da.filter((c) => c.vowel.f0 > 0.75 * mid && c.vowel.f0 < 1.33 * mid && c.vowel.spread < 1.5);
  }
  if (!words.da?.length) console.warn(`  WARNING: ${spk.name} has no usable sung "dah"`);
  bank.speakers.push({ name: spk.name, engine: spk.engine, child: spk.name.endsWith("-child"), source: `${spk.engine} ${spk.model}${spk.speakerId != null ? ` speaker ${spk.speakerId}` : ""}${spk.semitones ? `, +${spk.semitones} semitones` : ""}`, words });
  console.log(`${spk.name}: ${tts.words.length} words`);
}

// --- claps and room noise from real takes -----------------------------------
const candidates = [];
const quiet = [];
for (const zip of findZips(process.argv.slice(2))) {
  const files = readZip(zip);
  if (!files["diagnostics.json"] || !files["audio.wav"]) continue;
  const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
  const raw = wavSamples(files["audio.wav"]);
  const x = F.toFeatureRate(raw.data, raw.sr);
  const t0 = d.wavStartCtx;
  // Room sound: before the first click, when no voice was detected.
  const firstClick = d.clicks?.[0]?.wav ?? 0;
  const runs = (d.voiceRuns ?? []).map((r) => [r.startWav, r.endWav]);
  if (firstClick > 0.4 && !runs.some(([a]) => a < firstClick)) quiet.push(x.slice(Math.round(0.05 * SR), Math.round((firstClick - 0.05) * SR)));
  if (d.settings?.activity !== "clap") continue;
  const times = d.grader.notes.filter((n) => n.time != null && n.status !== "seen").map((n) => n.time + d.offsets.mic - t0).sort((a, b) => a - b);
  times.forEach((c, i) => {
    // Only claps with room to ring out (the next clap at least 0.35 s later).
    const next = times[i + 1] ?? Infinity;
    if (next - c < 0.35 || (i > 0 && c - times[i - 1] < 0.2)) return;
    const clip = x.slice(Math.round((c - 0.01) * SR), Math.round((c + 0.32) * SR));
    const fade = Math.round(0.03 * SR);
    for (let j = 0; j < fade; j++) clip[clip.length - 1 - j] *= j / fade;
    // Loudness and brightness (energy above 2 kHz), to pick a varied set.
    let peak = 0;
    let hi = 0;
    let all = 0;
    for (let j = 1; j < Math.round(0.05 * SR); j++) {
      peak = Math.max(peak, Math.abs(clip[j]));
      const dlt = clip[j] - clip[j - 1];
      hi += dlt * dlt;
      all += clip[j] * clip[j];
    }
    candidates.push({ clip, take: path.basename(zip, ".zip"), level: db(peak * peak), bright: hi / Math.max(all, 1e-12) });
  });
}
// A 4x4 grid of loudness x brightness quartiles, one clap from each cell.
const rankOf = (key) => {
  const sorted = [...candidates].sort((a, b) => a[key] - b[key]);
  return (c) => Math.min(3, Math.floor((sorted.indexOf(c) / sorted.length) * 4));
};
const levelQ = rankOf("level");
const brightQ = rankOf("bright");
for (let l = 0; l < 4; l++) {
  for (let b = 0; b < 4; b++) {
    const cell = candidates.filter((c) => levelQ(c) === l && brightQ(c) === b);
    const c = cell[Math.floor(cell.length / 2)];
    if (!c || bank.claps.length >= CLAPS) continue;
    const n = bank.claps.length + 1;
    bank.claps.push({ file: write(path.join("claps", `clap-${String(n).padStart(2, "0")}.wav`), c.clip), onset: 0.01, from: c.take, levelDb: +c.level.toFixed(1) });
  }
}
quiet
  .filter((q) => q.length > 0.2 * SR)
  .slice(0, NOISE)
  .forEach((q, i) => bank.noise.push({ file: write(path.join("noise", `room-${String(i + 1).padStart(2, "0")}.wav`), q), seconds: +(q.length / SR).toFixed(3) }));

// --- free-form clap recordings (people clapping however they like) ----------------
// Claps are found by their sharp rise in high-passed energy; each must be the
// loudest thing within 150 ms and within 25 dB of the recording's loudest clap.
if (fs.existsSync(RECORDINGS)) {
  const found = [];
  for (const f of fs.readdirSync(RECORDINGS).filter((f) => /\.wav$/i.test(f)).sort()) {
    const raw = wavSamples(fs.readFileSync(path.join(RECORDINGS, f)));
    const x = F.toFeatureRate(raw.data, raw.sr);
    const n = Math.round(0.005 * SR);
    const env = [];
    for (let i = 1; i + n < x.length; i += n) {
      let e = 0;
      for (let j = i; j < i + n; j++) e += (x[j] - x[j - 1]) ** 2;
      env.push(e / n);
    }
    const top = Math.max(...env);
    const win = 30; // 150 ms
    for (let k = 1; k < env.length; k++) {
      // Loud enough, and a sharp rise: at least 15 dB above the quietest of the previous 30 ms.
      if (db(env[k]) < db(top) - 25 || db(env[k]) < db(Math.min(...env.slice(Math.max(0, k - 6), k))) + 15) continue;
      let peak = true;
      for (let j = Math.max(0, k - win); j < Math.min(env.length, k + win); j++) if (env[j] > env[k]) peak = false;
      if (!peak) continue;
      const at = k * n;
      const clip = x.slice(Math.max(0, at - Math.round(0.01 * SR)), at + Math.round(0.32 * SR));
      const fade = Math.round(0.03 * SR);
      for (let j = 0; j < fade; j++) clip[clip.length - 1 - j] *= j / fade;
      found.push({ clip, from: f });
    }
  }
  // An even spread across the recordings.
  const every = Math.max(1, found.length / RECORDED_CLAPS);
  for (let i = 0; i < found.length && bank.claps.length < CLAPS + RECORDED_CLAPS; i += every) {
    const c = found[Math.floor(i)];
    const n = bank.claps.length + 1;
    bank.claps.push({ file: write(path.join("claps", `clap-${String(n).padStart(2, "0")}.wav`), c.clip), onset: 0.01, from: c.from });
  }
  console.log(`${found.length} claps found in ${RECORDINGS}`);
}

// --- background talk ------------------------------------------------------------------
const chatterDir = path.join(RAW, "chatter");
if (fs.existsSync(chatterDir)) {
  for (const f of fs.readdirSync(chatterDir).sort()) {
    const raw = wavSamples(fs.readFileSync(path.join(chatterDir, f)));
    const x = F.toFeatureRate(raw.data, raw.sr);
    let s = 0;
    for (const v of x) s = Math.max(s, Math.abs(v));
    for (let i = 0; i < x.length; i++) x[i] *= 0.5 / s;
    bank.chatter.push({ file: write(path.join("chatter", f), x), seconds: +(x.length / SR).toFixed(3) });
  }
}

fs.writeFileSync(path.join(OUT, "bank.json"), JSON.stringify(bank, null, 1));
console.log(`${bank.claps.length} claps (${candidates.length} clean ones in clap takes), ${bank.noise.length} room-noise clips, ${bank.chatter.length} chatter clips -> ${OUT}`);
