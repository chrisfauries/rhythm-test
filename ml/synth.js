// Generates synthetic takes, with exact labels, from the sound bank (ml/sound-bank.js):
//
//   node ml/synth.js [--pages 1,10,18] [--wav] [--out <folder>]
//
//   dataset/synthetic/claps/<page>/...   every line in the book, clapped by
//                                        your real claps: claps only, and claps
//                                        with the metronome
//   dataset/synthetic/voices/<page>/...  lines from every page, spread over all
//                                        the voices: counts, counts with the
//                                        metronome, clap & count the notes, clap &
//                                        count every beat, and sung on "Da"
//   dataset/synthetic/index.csv          every track and what's in it
//
// Every track also has a twin with mistakes about 20% of the time (early,
// late, missed or extra claps; wrong, missed, early or late words; rushing,
// dragging). Each one is a capture zip like a real take (audio.wav,
// diagnostics.json, manifest.json) plus labels.json, which says exactly where
// every clap and word is, so it opens in the labeler (?label) for checking.
//
// Performances are human-ish, not quantized: on-time sounds land a few ms off
// the beat (less when notes are close together, where a shift is easier to
// hear). Counting and singing follow measurements of a real person
// (ml/measure-voice.js): held beats sustain into the next number, fast
// subdivisions run together, sung notes are legato on one steady pitch with a
// light "D" on each note. Backgrounds vary: real room sound plus, sometimes,
// mains hum, a fan, a running tap, or a TV in another room. Same seed, same tracks.
// --wav also writes a plain .wav next to each zip, for quick listening.
const fs = require("fs");
const path = require("path");
const { wavSamples, wavBytes } = require("./zipread");
const { stretch, augment } = require("./augment");
const { PAGES } = require("./.build/music/book.js");
const R = require("./.build/music/rhythm.js");
const { CLICK_HZ, clickSamples } = require("./.build/audio/click.js");
const { zipBytes } = require("./.build/debug/zip.js");

const ROOT = path.join(__dirname, "..", "dataset");
const BANK = path.join(ROOT, "voices");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const OUT = opt("--out") ? path.resolve(opt("--out")) : path.join(ROOT, "synthetic");
const ONLY_PAGES = opt("--pages")?.split(",") ?? null;
const WAV = args.includes("--wav");

const TEMPO = [60, 160];
const ERROR_SHARE = 0.2;
const LEAD = 0.6; // seconds of room sound before the count-in
const TAIL = 1.2;
// Humanized timing of "perfect" performances: a spread of 4.5% of the gap to the
// nearest neighbouring note, at most 12 ms (sixteenths at 160 bpm: ~4 ms).
const ON_TIME_SHARE = 0.045;
const ON_TIME_MAX_SD = 0.012;
const CLAP_TO_VOWEL = [0.02, 0.105]; // measured in real clap-and-count takes; each take has its own
const VOWEL_AFTER_BEAT = [0.0, 0.04]; // counting without claps
const LAG_JITTER = 0.25; // a take's lag varies this much (share of its range) from word to word
// Loudness, matched to real takes (ml/README.md): claps peak around -8 dBFS,
// words ~29 dB quieter (-38 dBFS loudest 20 ms), metronome bleed through
// headphones ~-50 dBFS. Synthetic tracks use a clearly audible metronome
// instead (clicks peak at about -34..-12 dBFS), so the model learns to ignore it.
const dB = (v) => 10 ** (v / 20);
const VOICE_DB = [-30, -16]; // gain on the bank's clips (normalized to 0.5 peak): words at about -44..-30 dBFS
const CLICK_DB = [-32, -10]; // gain on the click (peak 0.8)
// Singing on one asked-for pitch (measured: notes 0.26 semitones apart, median).
const SING_KEY = 2.5; // the take's note: up to ± this many semitones from the voice's own
const SING_WOBBLE = 0.15; // note-to-note spread, semitones
const SING_DRIFT = 0.3; // slow drift over a take, semitones
const SING_DIP_DB = [-16, -9]; // the dip into each new "D" (measured: about -11 dB)
// About as many voiced tracks per page as before (5 voices x 2.5 lines), spread over all voices.
const VOICED_PER_VARIANT = 12;

let seed = 20261017;
const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const uniform = (a, b) => a + rand() * (b - a);
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
/** Timing jitter for a sound whose nearest neighbouring note is `gap` seconds away. */
const humanize = (gap = Infinity) => {
  const sd = Math.max(0.003, Math.min(ON_TIME_MAX_SD, ON_TIME_SHARE * gap));
  return Math.max(-2.5 * sd, Math.min(2.5 * sd, gauss() * sd));
};
/** For a list of positions (q-units): each one's gap to its nearest neighbour, in seconds. */
const gaps = (positions, secPerQ) => {
  const ps = [...positions].sort((a, b) => a - b);
  return (pos) => {
    const i = ps.findIndex((p) => Math.abs(p - pos) < 1e-6);
    const prev = i > 0 ? pos - ps[i - 1] : Infinity;
    const next = i >= 0 && i < ps.length - 1 ? ps[i + 1] - pos : Infinity;
    return Math.min(prev, next) * secPerQ;
  };
};
const shuffle = (xs) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// --- sound bank ----------------------------------------------------------------
const bank = JSON.parse(fs.readFileSync(path.join(BANK, "bank.json"), "utf8"));
const SR = bank.sampleRate;
const audioCache = new Map();
const load = (rel) => {
  if (!audioCache.has(rel)) audioCache.set(rel, wavSamples(fs.readFileSync(path.join(BANK, rel))).data);
  return audioCache.get(rel);
};
const CLICKS = { accent: clickSamples(SR, CLICK_HZ.accent), normal: clickSamples(SR, CLICK_HZ.normal) };
/** Count words (the bank also has "da", the sung syllable, labeled "sing"). */
const ALL_WORDS = Object.keys(bank.speakers[0].words).filter((w) => w !== "da");
const NUMBERS = new Set(["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"]);
const SING = "sing";

/**
 * A spoken word whose sound lasts `body` seconds after its vowel onset: squeezed
 * (pitch unchanged) when shorter than the clip, or with its vowel drawn out
 * ("ooonnne") when longer. `soften` (0..1) quietens the consonant before the
 * vowel, as in quick, run-together counting. `semitones` bends its pitch.
 */
const spoken = (clip, body, { soften = 0, semitones = 0 } = {}) => {
  const x = load(clip.file);
  const natural = clip.seconds - clip.onset;
  let data;
  let onset = clip.onset;
  if (body < natural) {
    const f = Math.max(0.45, body / natural);
    data = f > 0.97 ? Float32Array.from(x) : stretch(x, f, SR);
    onset *= f;
  } else {
    // Draw out the vowel: only its loud part (from the onset to where it falls 8 dB below its
    // peak), so a held "ooonnne" stays at full voice; the word's own ending follows.
    const step = Math.round(0.01 * SR);
    const a = Math.min(x.length - step, Math.round((clip.onset + 0.02) * SR));
    const energy = (i) => {
      let e = 0;
      for (let j = i; j < Math.min(x.length, i + step); j++) e += x[j] * x[j];
      return e / step;
    };
    let peak = 0;
    for (let i = a; i < x.length - step; i += step) peak = Math.max(peak, energy(i));
    let b = a;
    for (let i = a; i < x.length - step; i += step) if (energy(i) > peak * 0.16) b = i + step;
    b = Math.min(x.length, Math.max(b, a + Math.round(0.04 * SR)));
    const mid = x.subarray(a, b);
    const want = body + clip.onset - (x.length - mid.length) / SR;
    const f = Math.min(12, Math.max(1, want / Math.max(1e-3, mid.length / SR)));
    const long = f > 1.03 && mid.length > 0.03 * SR ? stretch(mid, f, SR) : mid;
    data = new Float32Array(a + long.length + (x.length - b));
    data.set(x.subarray(0, a));
    data.set(long, a);
    data.set(x.subarray(b), a + long.length);
  }
  if (Math.abs(semitones) > 0.15) data = augment(data, SR, 1, semitones);
  if (soften) {
    const cut = Math.round(onset * SR);
    for (let i = 0; i < cut && i < data.length; i++) data[i] *= 1 - soften * (1 - i / cut) ** 0.5;
  }
  return { data, onset };
};

/** A clip's samples [from, to) seconds. */
const part = (clip, from, to) => load(clip.file).subarray(Math.round(from * SR), Math.round(to * SR));

/**
 * One sung note: the "D" and the start of the vowel as spoken, then the clip's
 * steadiest stretch of vowel held for the rest of the note, all moved to
 * `pitch` Hz. `body` is how long it sounds after the vowel onset.
 */
const sungNote = (clip, body, pitch) => {
  const v = clip.vowel;
  const head = part(clip, 0, v.from);
  const want = Math.max(0.03, body - (v.from - clip.onset));
  const steady = part(clip, v.from, v.to);
  const held = stretch(steady, Math.max(0.5, want / (steady.length / SR)), SR);
  // Hold it at the loudness the vowel starts with (a singer sustains; a spoken word fades).
  const rmsOf = (y) => Math.sqrt(y.reduce((s, v) => s + v * v, 0) / Math.max(1, y.length));
  const start = rmsOf(part(clip, Math.max(0, v.from - 0.03), v.from));
  const level = Math.max(0.5, Math.min(3, start / Math.max(1e-6, rmsOf(steady))));
  const sag = uniform(0, 0.3); // a slight fall over a long note
  for (let i = 0; i < held.length; i++) held[i] *= level * (1 - (sag * i) / held.length);
  let out = new Float32Array(head.length + held.length);
  out.set(head);
  out.set(held, head.length);
  // A short crossfade from the spoken vowel into the held one, so the join doesn't click.
  const after = part(clip, v.from, v.from + 0.01);
  const x = Math.min(after.length, held.length);
  for (let i = 0; i < x; i++) out[head.length + i] = (held[i] * i + after[i] * (x - i)) / x;
  out = augment(out, SR, 1, 12 * Math.log2(pitch / v.f0));
  // A little natural unsteadiness in loudness (about 5 Hz, a few percent).
  const rate = uniform(4.5, 6);
  const depth = uniform(0.02, 0.06);
  for (let i = 0; i < out.length; i++) out[i] *= 1 + depth * Math.sin((2 * Math.PI * rate * i) / SR);
  return { data: out, onset: clip.onset };
};

// --- one performance -----------------------------------------------------------
/**
 * What happens in a take: claps and words at exact times, before mistakes.
 * Returns { claps: [{t, pos}], words: [{t, label, pos, held?, len?, legato?}] } in
 * seconds from the line start. A counted word knows whether its note goes on
 * past it (`held`: the voice sustains into the next number); a sung one knows
 * its note's length and whether the next note follows straight on (`legato`).
 */
const perform = (line, plan, secPerQ) => {
  const notes = R.expectedClaps(line);
  const clapGap = gaps(
    notes.map((c) => c.pos),
    secPerQ,
  );
  const claps = plan.claps ? notes.map((c) => ({ pos: c.pos, t: c.pos * secPerQ + humanize(clapGap(c.pos)) })) : [];
  // Each person has their own lag from clap (or beat) to vowel; it wobbles a little.
  const range = plan.claps ? CLAP_TO_VOWEL : VOWEL_AFTER_BEAT;
  const lag = uniform(...range);
  const lagNow = () => Math.max(range[0], Math.min(range[1], lag + (rand() - 0.5) * LAG_JITTER * (range[1] - range[0])));
  if (plan.sing) {
    const words = notes.map((c, i) => {
      const next = notes[i + 1];
      const legato = !!next && Math.abs(next.pos - (c.pos + c.len)) < 1e-6;
      return { pos: c.pos, label: SING, t: c.pos * secPerQ + lagNow() + humanize(clapGap(c.pos)), len: c.len * secPerQ, legato };
    });
    return { claps, words };
  }
  if (!plan.countMode) return { claps, words: [] };
  const counts = R.expectedCounts(line, plan.countMode);
  const countGap = gaps(
    counts.map((c) => c.pos),
    secPerQ,
  );
  const words = counts.map((c, i) => {
    const clap = claps.find((k) => Math.abs(k.pos - c.pos) < 1e-6);
    const t = clap ? clap.t + lagNow() : c.pos * secPerQ + lagNow() + humanize(countGap(c.pos));
    const note = notes.find((n) => n.pos <= c.pos + 1e-6 && c.pos < n.pos + n.len - 1e-6);
    const next = counts[i + 1];
    const held = !!note && !!next && next.pos < note.pos + note.len - 1e-6;
    return { pos: c.pos, label: c.label, t, held };
  });
  return { claps, words };
};

/** Mistakes: changes the performance in place and says what was done. */
const addMistakes = (perf, secPerQ, lineSec) => {
  const done = [];
  const kinds = [];
  if (perf.claps.length) kinds.push("early-clap", "late-clap", "missed-clap", "extra-clap");
  const singing = perf.words.length && perf.words[0].label === SING;
  if (perf.words.length) kinds.push(...(singing ? [] : ["wrong-word"]), "missed-word", "early-word", "late-word", "extra-word");
  kinds.push("rushing", "dragging");
  const n = 1 + Math.floor(rand() * 3);
  for (const kind of shuffle(kinds).slice(0, n)) {
    const shift = (list, sign) => {
      for (const e of shuffle(list).slice(0, 1 + Math.floor(rand() * 2))) {
        // Clearly off, but in proportion to the rhythm: a quarter to half the gap to the nearest neighbour (50-200 ms).
        const others = list.filter((o) => o !== e).map((o) => Math.abs(o.t - e.t));
        const gap = others.length ? Math.min(...others) : 0.5;
        const d = sign * Math.max(0.05, Math.min(0.2, uniform(0.25, 0.5) * gap));
        e.t += d;
        // A clapped count moves with its clap.
        if (list === perf.claps) perf.words.filter((w) => Math.abs(w.pos - e.pos) < 1e-6).forEach((w) => (w.t += d));
        done.push({ type: kind, pos: e.pos, ms: Math.round(d * 1000) });
      }
    };
    const drop = (list) => {
      for (const e of shuffle(list).slice(0, 1 + Math.floor(rand() * 2))) {
        list.splice(list.indexOf(e), 1);
        done.push({ type: kind, pos: e.pos });
      }
    };
    if (kind === "early-clap") shift(perf.claps, -1);
    if (kind === "late-clap") shift(perf.claps, 1);
    if (kind === "early-word") shift(perf.words, -1);
    if (kind === "late-word") shift(perf.words, 1);
    if (kind === "missed-clap") drop(perf.claps);
    if (kind === "missed-word") drop(perf.words);
    if (kind === "extra-clap") {
      const t = uniform(0.1, lineSec - 0.1);
      perf.claps.push({ pos: null, t });
      done.push({ type: kind, at: +t.toFixed(3) });
    }
    if (kind === "extra-word") {
      const t = uniform(0.1, lineSec - 0.1);
      const label = singing ? SING : pick(ALL_WORDS);
      perf.words.push({ pos: null, label, t, len: singing ? uniform(0.15, 0.4) : undefined, legato: false, held: false });
      done.push({ type: kind, at: +t.toFixed(3), label });
    }
    if (kind === "wrong-word") {
      for (const w of shuffle(perf.words).slice(0, 1 + Math.floor(rand() * 2))) {
        const said = pick(ALL_WORDS.filter((x) => x !== w.label));
        done.push({ type: kind, pos: w.pos, expected: w.label, said });
        w.label = said;
      }
    }
    if (kind === "rushing" || kind === "dragging") {
      // Gradually faster (or slower): up to 4-10% off by the end of the line.
      const amount = (kind === "rushing" ? -1 : 1) * uniform(0.04, 0.1);
      for (const e of [...perf.claps, ...perf.words]) e.t += (amount * (e.t * e.t)) / (2 * lineSec);
      done.push({ type: kind, percent: Math.round(amount * 100) });
    }
  }
  perf.claps.sort((a, b) => a.t - b.t);
  perf.words.sort((a, b) => a.t - b.t);
  return done;
};

/**
 * One "structural" mistake instead (the feedback engine's diagnoses): giving
 * up, stopping, starting over, coming in a beat off, a figure played as
 * another, clapping during a long or tied note, cutting a long note short.
 * Changes the performance in place; returns what was done ([] if this line
 * has nothing it applies to).
 */
const STRUCTURAL = [
  "gave-up",
  "stopped",
  "restart",
  "late-start",
  "early-start",
  "morph-triplet",
  "morph-swing",
  "held-beat-clap",
  "tie-clap",
  "cut-short",
];
const STRUCTURAL_SHARE = 1 / 3;
const addStructural = (perf, line, secPerQ, lineSec, endSec) => {
  const beat = R.beatLength(line.timeSig);
  const mLen = R.measureLength(line.timeSig);
  const beatSec = beat * secPerQ;
  const measures = line.measures.length;
  const notes = R.expectedClaps(line);
  const all = () => [...perf.claps, ...perf.words];
  const keep = (f) => {
    perf.claps = perf.claps.filter(f);
    perf.words = perf.words.filter(f);
  };
  const frac = (pos) => pos / beat - Math.floor(pos / beat + 1e-6);
  const longs = notes.filter((n, i) => n.len >= 2 * beat - 1e-6 && notes[i + 1] && Math.abs(notes[i + 1].pos - n.pos - n.len) < 1e-6);
  const tied = R.placeNotes(line).filter((p, k, ps) => k > 0 && !ps[k - 1].note.rest && ps[k - 1].note.tie && !p.note.rest);
  for (const kind of shuffle(STRUCTURAL)) {
    if (kind === "gave-up" && measures >= 4) {
      const from = Math.floor(measures / 2 + rand() * (measures / 2 - 1)) * mLen;
      keep((e) => e.pos === null || e.pos < from - 1e-6);
      return [{ type: kind, pos: from }];
    }
    if (kind === "stopped" && measures >= 5) {
      const from = (1 + Math.floor(rand() * (measures - 3))) * mLen;
      const to = from + 1.5 * mLen;
      if (notes.filter((n) => n.pos >= from - 1e-6 && n.pos < to).length < 3) continue;
      keep((e) => e.pos === null || e.pos < from - 1e-6 || e.pos >= to - 1e-6);
      return [{ type: kind, pos: from, to }];
    }
    if (kind === "restart" && measures >= 4) {
      // Stop after one or two measures, pause about a measure, start again from the top.
      const from = (1 + Math.floor(rand() * 2)) * mLen;
      const again = from * secPerQ + uniform(0.8, 1.5) * mLen * secPerQ;
      const before = all().filter((e) => e.pos !== null && e.pos < from - 1e-6);
      const copy = all()
        .filter((e) => e.pos !== null)
        .map((e) => ({ ...e, t: e.t + again, pos: e.pos + 1000 }))
        .filter((e) => e.t < endSec - 0.3);
      keep((e) => e.pos === null || e.pos < from - 1e-6);
      perf.claps.push(...copy.filter((e) => !("label" in e)));
      perf.words.push(...copy.filter((e) => "label" in e));
      return before.length >= 3 ? [{ type: kind, pos: from }] : [];
    }
    if (kind === "late-start" || kind === "early-start") {
      const d = (kind === "late-start" ? 1 : -1) * beatSec;
      for (const e of all()) e.t += d;
      return [{ type: kind }];
    }
    if (kind === "morph-triplet") {
      // Every beat of four sixteenths comes out as a triplet (said "1-la-li").
      const beats = new Set(notes.filter((n) => Math.abs(frac(n.pos) - 0.25) < 1e-6).map((n) => Math.floor(n.pos / beat + 1e-6)));
      const full = [...beats].filter((b) => [0, 0.25, 0.5, 0.75].every((f) => notes.some((n) => Math.abs(n.pos - (b + f) * beat) < 1e-6)));
      if (full.length < 2) continue;
      for (const b of full) {
        // Claps and words each keep their own beat start (the voice lags the hands).
        for (const list of [perf.claps, perf.words]) {
          const t0 = list.find((e) => e.pos !== null && Math.abs(e.pos - b * beat) < 1e-6)?.t;
          if (t0 === undefined) continue;
          for (const e of list) {
            if (e.pos === null || e.pos <= b * beat + 1e-6 || e.pos >= (b + 1) * beat - 1e-6) continue;
            const f = frac(e.pos);
            if (Math.abs(f - 0.75) < 1e-6) {
              e.drop = true;
              continue;
            }
            e.t = t0 + (f < 0.4 ? 1 / 3 : 2 / 3) * beatSec;
            if (e.label === SING) e.len = beatSec / 3;
            else if (e.label !== undefined) e.label = f < 0.4 ? "la" : "li";
          }
        }
      }
      keep((e) => !e.drop);
      return [{ type: kind, beats: full.length }];
    }
    if (kind === "morph-swing") {
      // Every pair of even eighths comes out long-short.
      const ands = notes.filter(
        (n) =>
          Math.abs(frac(n.pos) - 0.5) < 1e-6 &&
          notes.some((m) => Math.abs(m.pos - (n.pos - beat / 2)) < 1e-6) &&
          Math.abs(n.len - beat / 2) < 1e-6,
      );
      if (ands.length < 3) continue;
      const d = uniform(0.14, 0.2) * beatSec;
      for (const e of all()) if (e.pos !== null && ands.some((n) => Math.abs(n.pos - e.pos) < 1e-6)) e.t += d;
      return [{ type: kind, notes: ands.length }];
    }
    if (kind === "held-beat-clap" && perf.claps.length && longs.length) {
      const n = pick(longs);
      perf.claps.push({ pos: null, t: (n.pos + beat) * secPerQ });
      return [{ type: kind, pos: n.pos + beat }];
    }
    if (kind === "tie-clap" && perf.claps.length && tied.length) {
      const p = pick(tied);
      perf.claps.push({ pos: null, t: p.pos * secPerQ });
      return [{ type: kind, pos: p.pos }];
    }
    if (kind === "cut-short" && perf.claps.length && longs.length) {
      const n = pick(longs);
      const next = n.pos + n.len;
      for (const e of all()) if (e.pos !== null && Math.abs(e.pos - next) < 1e-6) e.t -= beatSec;
      return [{ type: kind, pos: next }];
    }
  }
  return [];
};

// --- rendering -----------------------------------------------------------------
const mixIn = (out, clip, at, gain) => {
  const a = Math.round(at * SR);
  for (let i = 0; i < clip.length; i++) {
    const j = a + i;
    if (j >= 0 && j < out.length) out[j] += gain * clip[i];
  }
};

/** Mixes `data` in from `at` seconds, cut at `endSec` (into the clip) with a `fadeSec` fade-out. */
const mixShaped = (out, data, at, gain, endSec = Infinity, fadeSec = 0.03) => {
  const end = Math.min(data.length, Math.max(0, Math.round(endSec * SR)));
  const fade = Math.max(1, Math.min(end, Math.round(fadeSec * SR)));
  const a = Math.round(at * SR);
  for (let i = 0; i < end; i++) {
    const j = a + i;
    if (j >= 0 && j < out.length) out[j] += gain * data[i] * Math.min(1, (end - i) / fade);
  }
};

/** Room sound over the whole track: random clips of real rooms, crossfaded. */
const roomNoise = (out, gain) => {
  const fade = Math.round(0.05 * SR);
  let at = 0;
  while (at < out.length) {
    const clip = load(pick(bank.noise).file);
    for (let i = 0; i < clip.length && at + i < out.length; i++) {
      const w = Math.min(1, i / fade, (clip.length - 1 - i) / fade);
      out[at + i] += gain * w * clip[i];
    }
    at += clip.length - fade;
  }
};

// Other things going on in the room.
/** One-pole low-pass, in place. */
const lowpass = (x, hz) => {
  const a = Math.exp((-2 * Math.PI * hz) / SR);
  let y = 0;
  for (let i = 0; i < x.length; i++) x[i] = y = (1 - a) * x[i] + a * y;
  return x;
};
const highpass = (x, hz) => {
  const lp = lowpass(Float32Array.from(x), hz);
  for (let i = 0; i < x.length; i++) x[i] -= lp[i];
  return x;
};
/** Adds x with its peak at `peakDb` dBFS, from sample `at`, faded in and out over `fade` seconds. */
const addBed = (out, x, peakDb, at = 0, fade = 0.3) => {
  let peak = 1e-9;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = dB(peakDb) / peak;
  const f = Math.round(fade * SR);
  for (let i = 0; i < x.length && at + i < out.length; i++) out[at + i] += g * x[i] * Math.min(1, (i + 1) / f, (x.length - i) / f);
};
const BEDS = {
  /** Mains hum: 50 or 60 Hz and its harmonics (a fridge, lights, a charger). */
  hum: (n) => {
    const f0 = pick([50, 60]);
    const amps = Array.from({ length: 8 }, (_, k) => (rand() < 0.6 ? 1 : 0.2) / (k + 1) ** uniform(0.5, 1.5));
    const ph = amps.map(() => rand() * 2 * Math.PI);
    const wob = uniform(0.1, 0.5);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let v = 0;
      for (let k = 0; k < 8; k++) v += amps[k] * Math.sin(2 * Math.PI * f0 * (k + 1) * t + ph[k]);
      x[i] = v * (1 + 0.15 * Math.sin(2 * Math.PI * wob * t));
    }
    return { x, db: uniform(-62, -46) };
  },
  /** A fan, air conditioning or traffic rumble: low-passed noise. */
  fan: (n) => {
    const x = new Float32Array(n).map(() => rand() * 2 - 1);
    lowpass(lowpass(x, uniform(120, 1500)), uniform(300, 3000));
    return { x, db: uniform(-58, -42) };
  },
  /** A running tap or kettle: bright, bubbling noise, for part of the take. */
  water: (n) => {
    const len = Math.min(n, Math.round(uniform(0.4, 1) * n));
    const x = highpass(
      new Float32Array(len).map(() => rand() * 2 - 1),
      uniform(600, 1500),
    );
    lowpass(x, uniform(3500, 7000));
    let env = 0;
    for (let i = 0; i < len; i++) {
      if (rand() < 200 / SR) env = Math.min(2, env + uniform(0.3, 1));
      env *= 0.9995;
      x[i] *= 0.6 + 0.4 * env;
    }
    return { x, db: uniform(-52, -36), at: Math.floor(rand() * (n - len + 1)) };
  },
  /** A TV or radio in another room: talk (no count words), muffled and echoey, well under the student. */
  tv: (n, voiceLevel) => {
    const x = new Float32Array(n);
    let at = Math.round(uniform(-1, 0.5) * SR);
    while (at < n) {
      const clip = load(pick(bank.chatter).file);
      for (let i = 0; i < clip.length; i++) if (at + i >= 0 && at + i < n) x[at + i] += clip[i];
      at += clip.length + Math.round(uniform(0.1, 0.6) * SR);
    }
    highpass(x, uniform(200, 400));
    lowpass(lowpass(x, uniform(2500, 4000)), 5000);
    // Room echo: a few feedback delays (Schroeder comb filters).
    const y = Float32Array.from(x);
    for (const ms of [29.7, 37.1, 41.1, 43.7]) {
      const d = Math.round((ms / 1000) * SR);
      const fb = uniform(0.6, 0.8);
      const c = new Float32Array(n);
      for (let i = 0; i < n; i++) c[i] = x[i] + (i >= d ? fb * c[i - d] : 0);
      for (let i = 0; i < n; i++) y[i] += 0.25 * c[i];
    }
    // The bank's clips peak at 0.5, so the student's words peak around 0.5 * voiceLevel.
    return { x: y, db: 20 * Math.log10(0.5 * voiceLevel) - uniform(10, 24) };
  },
};
const BED_CHANCE = { hum: 0.3, fan: 0.3, water: 0.12, tv: 0.2 };

/**
 * Counting, the way a person does it (ml/measure-voice.js): a held beat sustains
 * into the next number; quick subdivisions run together as one sound, with the
 * "e & a" lighter than the numbers; eighths fill most of the gap; slower words
 * are said at their natural length.
 */
const speakLine = (out, words, speaker, lineStart, voiceLevel) => {
  // This take's way of counting: how lightly the in-between syllables are said, and their pitch.
  const offbeatGain = uniform(0.55, 0.9);
  const offbeatPitch = -uniform(0, 1.2);
  const fill = uniform(0.55, 0.85); // how much of an eighth's gap the voice fills
  words.forEach((w, i) => {
    const next = words[i + 1];
    const gap = next ? next.t - w.t : Infinity;
    const clips = [...speaker.words[w.label]].sort((a, b) => a.seconds - b.seconds);
    // Quick counting uses the quickly-said takes of each word.
    const clip = gap < 0.3 ? pick(clips.slice(0, 3)) : pick(clips);
    const natural = clip.seconds - clip.onset;
    let body;
    if (next && w.held)
      body = gap + 0.04; // "ooonnne-two": straight into the next number
    else if (gap < 0.2)
      body = gap + 0.03; // "1e&a" as one sound
    else if (gap < 0.45) body = gap * Math.min(1, fill * uniform(0.9, 1.1));
    else body = Math.min(natural, gap * 0.85);
    const offbeat = !NUMBERS.has(w.label);
    const fast = gap < 0.3 || (i > 0 && w.t - words[i - 1].t < 0.3);
    const word = spoken(clip, body, {
      soften: fast ? uniform(0.3, 0.7) : 0,
      semitones: offbeat ? offbeatPitch + gauss() * 0.3 : gauss() * 0.4,
    });
    const gain = voiceLevel * (offbeat ? offbeatGain : 1) * uniform(0.85, 1.15);
    // A connected word ends just after the next one's vowel starts (under that word's consonant).
    const endSec = next ? word.onset + body + 0.02 : Infinity;
    mixShaped(out, word.data, lineStart + w.t - word.onset, gain, endSec, next && (w.held || gap < 0.2) ? 0.05 : 0.03);
  });
};

/**
 * Singing on "Da": one pitch for the take (the note the student was asked to
 * sing), a little wobble, legato from note to note with a light "D" and a dip of
 * about 11 dB, breaking only at rests and the end.
 */
const singLine = (out, words, speaker, lineStart, voiceLevel) => {
  const clips = speaker.words.da;
  const main = pick(clips);
  const other = pick(clips);
  const key = main.vowel.f0 * 2 ** (uniform(-SING_KEY, SING_KEY) / 12);
  const lineSec = words.length ? words[words.length - 1].t + 1 : 1;
  const driftPhase = rand() * 2 * Math.PI;
  const dip = dB(uniform(...SING_DIP_DB));
  // Legato only while the next note still comes about when written (a mistake can move it).
  const flows = (a, b) => !!a && !!b && a.legato && b.t - a.t < a.len * 1.5 + 0.1 && b.t > a.t + 0.05;
  words.forEach((w, i) => {
    const next = words[i + 1];
    const legato = flows(w, next);
    const body = legato ? next.t - w.t + 0.03 : w.len * (w.len > 1.2 ? uniform(0.7, 0.92) : uniform(0.85, 0.95));
    const drift = SING_DRIFT * Math.sin(driftPhase + (2 * Math.PI * w.t) / Math.max(4, lineSec));
    // Each clip is moved to the take's note from its own steady pitch, so switching clips keeps the note.
    const clip = rand() < 0.2 ? other : main;
    const note = sungNote(clip, Math.max(0.08, body), key * 2 ** ((gauss() * SING_WOBBLE + drift) / 12));
    const data = note.data;
    // Coming out of a legato note, the "D" is lighter than when starting fresh.
    if (flows(words[i - 1], w)) {
      const cut = Math.round(note.onset * SR);
      const light = uniform(0.45, 0.8);
      for (let j = 0; j < cut && j < data.length; j++) data[j] *= light;
    }
    // Before a legato change, sink to the dip over the last 60 ms; the next note's "D" takes over.
    if (legato) {
      const dipAt = Math.round((note.onset + next.t - w.t) * SR);
      const ramp = Math.round(0.06 * SR);
      for (let j = Math.max(0, dipAt - ramp); j < data.length; j++) data[j] *= 1 - (1 - dip) * Math.min(1, (j - (dipAt - ramp)) / ramp);
    }
    mixShaped(out, data, lineStart + w.t - note.onset, voiceLevel * uniform(0.9, 1.1), note.onset + body, legato ? 0.03 : 0.08);
  });
};

/** Builds one track: audio and its capture-zip contents. */
const makeTake = (ex, plan) => {
  const ts = ex.line.timeSig;
  // As the app (TakeRunner): the tempo is in pulses (dotted quarters in 6/8),
  // with a click per pulse and four count-in clicks, whatever the meter.
  const bpm = plan.bpm;
  const beatsPerClick = R.beatsPerPulse(ts);
  const secPerBeat = 60 / bpm / beatsPerClick;
  const secPerQ = secPerBeat / R.beatLength(ts);
  const countInBeats = 4 * beatsPerClick;
  const lineBeats = R.lineBeats(ex.line);
  const lineStart = LEAD + countInBeats * secPerBeat;
  const lineSec = lineBeats * secPerBeat;
  const total = lineStart + lineSec + TAIL;
  const out = new Float32Array(Math.ceil(total * SR));

  const perf = perform(ex.line, plan, secPerQ);
  let mistakes = [];
  if (plan.mistakes && rand() < STRUCTURAL_SHARE) mistakes = addStructural(perf, ex.line, secPerQ, lineSec, total - lineStart);
  if (plan.mistakes && !mistakes.length) mistakes = addMistakes(perf, secPerQ, lineSec);
  perf.claps.sort((a, b) => a.t - b.t);
  perf.words.sort((a, b) => a.t - b.t);

  roomNoise(out, uniform(0.5, 2));
  // Sometimes more going on in the room: up to two of hum, fan, tap, TV.
  const voiceLevel = dB(uniform(...VOICE_DB));
  const background = shuffle(Object.keys(BEDS))
    .filter((b) => rand() < BED_CHANCE[b] && (b !== "tv" || bank.chatter?.length))
    .slice(0, 2);
  for (const b of background) {
    const bed = BEDS[b](out.length, voiceLevel);
    addBed(out, bed.x, bed.db, bed.at ?? 0, b === "water" ? 0.4 : 0.3);
  }
  const clicks = Array.from({ length: (countInBeats + lineBeats) / beatsPerClick }, (_, i) => ({
    i,
    t: LEAD + i * beatsPerClick * secPerBeat,
    accent: i < 4 ? i === 0 : ((i - 4) * beatsPerClick) % ts.num === 0,
  }));
  if (plan.metronome) {
    const level = dB(uniform(...CLICK_DB));
    for (const c of clicks) mixIn(out, c.accent ? CLICKS.accent : CLICKS.normal, c.t, level);
  }
  const clapLevel = uniform(0.6, 1.4);
  for (const c of perf.claps) {
    const clip = pick(bank.claps);
    mixIn(out, load(clip.file), lineStart + c.t - clip.onset, clapLevel * uniform(0.7, 1.3));
  }
  const speaker = plan.speaker && bank.speakers.find((s) => s.name === plan.speaker);
  if (perf.words.length && plan.sing) singLine(out, perf.words, speaker, lineStart, voiceLevel);
  else if (perf.words.length) speakLine(out, perf.words, speaker, lineStart, voiceLevel);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] *= 0.95 / peak;

  // Capture files: the timeline is audio.wav's, with no latency (the clock *is* the wav).
  const timing = {
    countInStart: LEAD,
    lineStart,
    lineEnd: lineStart + lineSec,
    secPerBeat,
    countInBeats,
    beatsPerMeasure: ts.num,
    beatsPerClick,
    countInStartWav: LEAD,
    lineStartWav: lineStart,
    lineEndWav: lineStart + lineSec,
  };
  const exercise = { id: ex.id, title: ex.title, source: ex.source, timeSig: ex.timeSig, tempo: bpm, activity: plan.activity };
  const diag = {
    version: 1,
    synthetic: true,
    exercise,
    settings: { tempo: bpm, activity: plan.activity, strictness: "normal", metronomeDuringLine: !!plan.metronome },
    wavStartCtx: 0,
    offsets: { mic: 0, speech: 0, video: 0 },
    timing,
    clicks: clicks.map((c) => ({ i: c.i, ctx: c.t, wav: c.t })),
    audio: { sampleRate: SR, seconds: +(out.length / SR).toFixed(4) },
    grader: {
      notes: R.expectedClaps(ex.line).map((c) => ({
        id: c.id,
        measure: c.measure,
        index: c.index,
        pos: c.pos,
        len: c.len,
        expectedTime: lineStart + c.pos * secPerQ,
      })),
      counts: plan.countMode
        ? R.expectedCounts(ex.line, plan.countMode).map((c) => ({
            id: c.id,
            pos: c.pos,
            label: c.label,
            expectedTime: lineStart + c.pos * secPerQ,
          }))
        : [],
      rests: [],
    },
  };
  let id = 1;
  const events = [
    ...perf.claps.map((c) => ({ id: id++, type: "clap", t: +(lineStart + c.t).toFixed(4), source: "synthetic" })),
    ...perf.words.map((w) => ({ id: id++, type: "count", t: +(lineStart + w.t).toFixed(4), label: w.label, source: "synthetic" })),
  ].sort((a, b) => a.t - b.t);
  const labels = {
    format: "rhythm-tester-labels",
    version: 1,
    take: plan.name,
    savedAt: new Date(0).toISOString(),
    events,
    counts: diag.grader.counts.map((c) => {
      const w = perf.words.find((x) => x.pos !== null && Math.abs(x.pos - c.pos) < 1e-6);
      return { pos: c.pos, label: w ? w.label : null, t: w ? +(lineStart + w.t).toFixed(4) : null };
    }),
    reviewed: [],
  };
  const manifest = {
    format: "rhythm-tester-capture",
    formatVersion: 1,
    synthetic: true,
    generator: "ml/synth.js",
    name: plan.name,
    studentId: plan.speaker ?? "claps",
    performance: mistakes.length ? "with-mistakes" : "as-written",
    mistakes,
    variant: plan.variant,
    speaker: speaker?.source ?? null,
    background,
    exercise,
    files: { audio: "audio.wav", diagnostics: "diagnostics.json", labels: "labels.json" },
  };
  return { out, diag, labels, manifest, mistakes, background };
};

// --- what to make ----------------------------------------------------------------
const jobs = [];
const pages = PAGES.filter((p) => !ONLY_PAGES || ONLY_PAGES.includes(p.id));
const tempo = () => Math.round(uniform(TEMPO[0], TEMPO[1]));
const withTwins = (base) => [base, ...(rand() < ERROR_SHARE ? [{ ...base, bpm: tempo(), mistakes: true }] : [])];
const voices = bank.speakers.filter((s) => s.words.da?.length);
const queue = [];
for (const page of pages) {
  // 1) Every line, clapped: claps alone, and claps with the metronome.
  for (const ex of page.exercises) {
    for (const variant of ["claps", "claps+metronome"]) {
      for (const job of withTwins({
        set: "claps",
        page: page.id,
        ex,
        variant,
        activity: "clap",
        claps: true,
        metronome: variant.includes("metronome"),
        bpm: tempo(),
      }))
        jobs.push(job);
    }
  }
  // 2) Lines from the page, counted or sung by the voices in turn (each voice gets about the same share).
  for (const variant of ["counts", "counts+metronome", "counts+claps", "counts-all+claps", "sing"]) {
    for (let k = 0; k < VOICED_PER_VARIANT; k++) {
      if (!queue.length) queue.push(...shuffle(voices));
      const s = queue.shift();
      const clapped = variant.includes("claps");
      const singing = variant === "sing";
      const mode = variant === "counts-all+claps" ? "all" : "notes";
      const plan = {
        set: "voices",
        page: page.id,
        ex: pick(page.exercises),
        // Clapping and singing tracks: half of them with the metronome.
        variant: (clapped || singing) && rand() < 0.5 ? `${variant}+metronome` : variant,
        speaker: s.name,
        activity: singing ? "sing" : clapped ? `clap-count-${mode}` : "count-notes",
        claps: clapped,
        countMode: singing ? null : mode,
        sing: singing,
        bpm: tempo(),
      };
      plan.metronome = plan.variant.includes("metronome");
      for (const job of withTwins(plan)) jobs.push(job);
    }
  }
}

// --- write --------------------------------------------------------------------------
// A full run replaces the previous set.
if (!ONLY_PAGES) fs.rmSync(OUT, { recursive: true, force: true });
const csv = ["set,page,line,file,activity,variant,speaker,bpm,seconds,background,performance,mistakes"];
let seconds = 0;
const started = Date.now();
// Compound meters: the tempo is the dotted quarter, so keep it in a dotted-quarter range (40-90).
for (const job of jobs) if (R.isCompound(job.ex.line.timeSig)) job.bpm = Math.round(40 + (job.bpm - TEMPO[0]) / 2);
jobs.forEach((job, n) => {
  const safeId = job.ex.id.replace(/[^\w.-]/g, "_");
  job.name = [safeId, job.speaker, job.variant.replace(/\+/g, "-"), `${job.bpm}bpm`, job.mistakes && "mistakes"].filter(Boolean).join("_");
  const take = makeTake(job.ex, job);
  const dir = path.join(OUT, job.set, job.page.replace(/[^\w.-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  const wav = wavBytes(take.out, SR);
  const json = (o) => new Uint8Array(Buffer.from(JSON.stringify(o, null, 1)));
  const zip = zipBytes([
    { name: "manifest.json", data: json(take.manifest) },
    { name: "audio.wav", data: new Uint8Array(wav) },
    { name: "diagnostics.json", data: json(take.diag) },
    { name: "labels.json", data: json(take.labels) },
  ]);
  fs.writeFileSync(path.join(dir, `${job.name}.zip`), zip);
  if (WAV) fs.writeFileSync(path.join(dir, `${job.name}.wav`), wav);
  const secs = take.out.length / SR;
  seconds += secs;
  const desc = take.mistakes
    .map(
      (m) =>
        m.type +
        (m.pos != null ? `@${+m.pos.toFixed(3)}` : "") +
        (m.said ? `:${m.expected}->${m.said}` : "") +
        (m.ms ? `:${m.ms}ms` : "") +
        (m.percent ? `:${m.percent}%` : ""),
    )
    .join(" ");
  csv.push(
    [
      job.set,
      job.page,
      job.ex.id,
      path.relative(OUT, path.join(dir, `${job.name}.zip`)).replace(/\\/g, "/"),
      job.activity,
      job.variant,
      job.speaker ?? "",
      job.bpm,
      secs.toFixed(1),
      take.background.join("+"),
      take.manifest.performance,
      `"${desc}"`,
    ].join(","),
  );
  if ((n + 1) % 500 === 0) console.log(`  ${n + 1}/${jobs.length} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
});
fs.writeFileSync(path.join(OUT, "index.csv"), csv.join("\n") + "\n");
const count = (set) => jobs.filter((j) => j.set === set).length;
const withMistakes = jobs.filter((j) => j.mistakes).length;
console.log(
  `${jobs.length} tracks (${count("claps")} clapped, ${count("voices")} counted or sung by ${voices.length} voices; ${withMistakes} with mistakes), ${(seconds / 3600).toFixed(1)} h of audio, in ${((Date.now() - started) / 1000).toFixed(0)} s -> ${OUT}`,
);
