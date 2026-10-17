import { Biquad } from "./biquad";

// Voicing analysis: finds where someone is *speaking* (periodic, low-frequency
// sound) as opposed to clapping (short, noisy, broadband bursts).
//
// Used for two things:
//   - Timing spoken counts. Vosk's word timestamps are only approximate (its
//     start times often swallow some of the silence before a word), so we use
//     Vosk for *which* word was said and the vowel onset found here for *when*.
//     The vowel onset is also where musicians place a spoken syllable on the
//     beat, so "six" isn't judged early because of its long "s".
//   - Telling claps from consonants. Every spoken "t", "k" or "s" that could
//     look like a clap sits right next to a vowel, and is much quieter than
//     that vowel; a real clap is much louder than the voice around it.

export interface VoiceFrames {
  /** Time of frame 0's center, in the clock of the audio's start time. */
  t0: number;
  /** Seconds between frames. */
  hop: number;
  /** Mean square of the low-passed signal over the frame. */
  energy: Float32Array;
  /** Peak normalized autocorrelation over speech pitch lags (0..1). */
  voicing: Float32Array;
}

const LOWPASS_HZ = 1000;
const TARGET_RATE = 8000;
const WINDOW_SEC = 0.025;
const HOP_SEC = 0.005;
const MIN_PITCH = 75;
const MAX_PITCH = 500;

/**
 * Analyze audio[from, to) (sample indices). audioStart is the time of
 * audio[0]. Frames are centered every 5 ms.
 */
export const voiceFrames = (
  audio: Float32Array,
  sampleRate: number,
  audioStart: number,
  from = 0,
  to = audio.length
): VoiceFrames => {
  from = Math.max(0, Math.floor(from));
  to = Math.min(audio.length, Math.ceil(to));
  const decim = Math.max(1, Math.floor(sampleRate / TARGET_RATE));
  const rate = sampleRate / decim;

  // Low-pass (with a short pre-roll so the filters settle), then decimate.
  const lp1 = Biquad.lowpass(sampleRate, LOWPASS_HZ);
  const lp2 = Biquad.lowpass(sampleRate, LOWPASS_HZ);
  const preroll = Math.min(from, Math.round(sampleRate * 0.02));
  for (let i = from - preroll; i < from; i++) lp2.process(lp1.process(audio[i]));
  const n = Math.floor((to - from) / decim);
  const x = new Float32Array(n);
  for (let k = 0, i = from; k < n; k++) {
    let y = 0;
    for (let d = 0; d < decim; d++, i++) y = lp2.process(lp1.process(audio[i]));
    x[k] = y;
  }

  const W = Math.round(WINDOW_SEC * rate);
  const H = Math.max(1, Math.round(HOP_SEC * rate));
  const lagMin = Math.floor(rate / MAX_PITCH);
  const lagMax = Math.ceil(rate / MIN_PITCH);
  const frames = Math.max(0, Math.floor((n - W - lagMax) / H) + 1);
  const energy = new Float32Array(frames);
  const voicing = new Float32Array(frames);

  for (let f = 0; f < frames; f++) {
    const s = f * H;
    let e0 = 0;
    for (let k = 0; k < W; k++) e0 += x[s + k] * x[s + k];
    energy[f] = e0 / W;
    if (e0 < 1e-12) continue;
    // Energy of the lagged window, updated incrementally as the lag grows.
    let eLag = 0;
    for (let k = 0; k < W; k++) eLag += x[s + lagMin + k] * x[s + lagMin + k];
    let best = 0;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      if (lag > lagMin) {
        const out = x[s + lag - 1];
        const inn = x[s + lag + W - 1];
        eLag += inn * inn - out * out;
      }
      let c = 0;
      for (let k = 0; k < W; k++) c += x[s + k] * x[s + k + lag];
      const r = c / Math.sqrt(e0 * Math.max(eLag, 1e-12));
      if (r > best) best = r;
    }
    voicing[f] = best;
  }

  return {
    t0: audioStart + (from + (W / 2) * decim) / sampleRate,
    hop: (H * decim) / sampleRate,
    energy,
    voicing,
  };
};

/** Weight (0..1) for how voice-like a frame is. Noise and claps score ~0. */
const voicedWeight = (v: number) => Math.max(0, Math.min(1, (v - 0.5) / 0.3));

/** Energy that counts as voice: frame energy scaled by how periodic it is. */
export const voicedEnergy = (f: VoiceFrames) => {
  const out = new Float32Array(f.energy.length);
  for (let i = 0; i < out.length; i++) out[i] = f.energy[i] * voicedWeight(f.voicing[i]);
  return out;
};

/** Largest voiced energy among frames centered in [from, to]. */
export const maxVoicedEnergy = (f: VoiceFrames, from: number, to: number) => {
  const a = Math.max(0, Math.ceil((from - f.t0) / f.hop));
  const b = Math.min(f.energy.length - 1, Math.floor((to - f.t0) / f.hop));
  let best = 0;
  for (let i = a; i <= b; i++) {
    const v = f.energy[i] * voicedWeight(f.voicing[i]);
    if (v > best) best = v;
  }
  return best;
};

export interface VoicedSegment {
  /** Vowel onset: where the energy first comes within 6 dB of the peak. */
  onset: number;
  start: number;
  end: number;
  peakTime: number;
  peak: number;
}

const db = (e: number) => 10 * Math.log10(Math.max(e, 1e-14));

/**
 * Split voiced audio into syllable-like segments: runs of voiced energy,
 * divided wherever the energy dips 6 dB below the peaks on both sides (as it
 * does between "one" and "and").
 */
export const voicedSegments = (f: VoiceFrames, minEnergy = 1e-7): VoicedSegment[] => {
  const v = voicedEnergy(f);
  const sorted = Array.from(v).filter((e) => e > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const ref = sorted[Math.floor(sorted.length * 0.98)];
  const thr = Math.max(minEnergy, ref * 10 ** -2.5);
  const time = (i: number) => f.t0 + i * f.hop;

  // Runs above threshold, bridging gaps of up to 2 frames.
  const runs: [number, number][] = [];
  let i = 0;
  while (i < v.length) {
    if (v[i] < thr) {
      i++;
      continue;
    }
    let j = i;
    let last = i;
    while (j < v.length && j - last <= 3) {
      if (v[j] >= thr) last = j;
      j++;
    }
    runs.push([i, last]);
    i = last + 1;
  }

  const segments: VoicedSegment[] = [];
  const DIP = 6;
  for (const [a, b] of runs) {
    if (b - a < 3) continue; // shorter than ~20 ms: not a syllable
    // Split at dips that are DIP dB below the peak before them and the rise after.
    const cuts: number[] = [a];
    let peak = -Infinity;
    let minDb = Infinity;
    let minIdx = -1;
    for (let q = a; q <= b; q++) {
      const d = db(v[q]);
      if (minIdx >= 0 && d >= minDb + DIP && peak >= minDb + DIP) {
        cuts.push(minIdx);
        peak = d;
        minDb = Infinity;
        minIdx = -1;
      } else if (d > peak) {
        peak = d;
        minDb = Infinity;
        minIdx = -1;
      } else if (d < minDb) {
        minDb = d;
        minIdx = q;
      }
    }
    cuts.push(b + 1);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const s = cuts[c];
      const e = cuts[c + 1] - 1;
      if (e - s < 3) continue;
      let p = s;
      for (let q = s; q <= e; q++) if (v[q] > v[p]) p = q;
      const target = v[p] * 10 ** (-DIP / 10);
      let o = s;
      while (o < p && v[o] < target) o++;
      // Interpolate the crossing between frames o-1 and o.
      let onset = time(o);
      if (o > s && v[o] > v[o - 1]) {
        const frac = (target - v[o - 1]) / (v[o] - v[o - 1]);
        onset = time(o - 1) + frac * f.hop;
      }
      segments.push({ onset, start: time(s), end: time(e), peakTime: time(p), peak: v[p] });
    }
  }
  return segments;
};

export interface VoiceRun {
  start: number;
  end: number;
}

/**
 * Stretches where someone is voicing (singing, or a count's vowel), found from
 * periodicity alone. Looser than voicedSegments: under a clap's room echo the
 * voice is still periodic in the low band even when its words can't be
 * recognized, while claps and their echo never are (in real takes, claps
 * alone never gave a run of 40 ms or more).
 */
export const voiceRuns = (f: VoiceFrames, minVoicing = 0.5, minSec = 0.04): VoiceRun[] => {
  const energies = Array.from(f.energy).filter((e, i) => f.voicing[i] >= minVoicing && e > 0);
  if (energies.length === 0) return [];
  energies.sort((a, b) => a - b);
  const floor = Math.max(1e-9, energies[Math.floor(energies.length * 0.98)] * 1e-3);
  const on = (i: number) => f.voicing[i] >= minVoicing && f.energy[i] >= floor;
  const time = (i: number) => f.t0 + i * f.hop;
  const runs: VoiceRun[] = [];
  let i = 0;
  while (i < f.energy.length) {
    if (!on(i)) {
      i++;
      continue;
    }
    let last = i;
    let j = i + 1;
    while (j < f.energy.length && j - last <= 2) {
      if (on(j)) last = j;
      j++;
    }
    if (time(last) - time(i) + f.hop >= minSec) runs.push({ start: time(i), end: time(last) });
    i = last + 1;
  }
  return runs;
};

/**
 * The vowel onset of the voice nearest an expected time: the strongest
 * voiced moment in [time - 0.1, time + 0.3], traced back to where it first
 * came within 6 dB of that peak. Returns null when there is no voicing run
 * of at least `minSec` there.
 */
export const voiceOnsetNear = (
  f: VoiceFrames,
  time: number,
  runs: VoiceRun[],
  minVoicing = 0.5,
  minSec = 0.04
): number | null => {
  const from = time - 0.1;
  const to = time + 0.3;
  if (!runs.some((r) => r.end >= from && r.start <= to && r.end - r.start + f.hop >= minSec)) return null;
  const ve = (i: number) => (f.voicing[i] >= minVoicing ? f.energy[i] : 0);
  const a = Math.max(0, Math.ceil((from - f.t0) / f.hop));
  const b = Math.min(f.energy.length - 1, Math.floor((to - f.t0) / f.hop));
  let p = -1;
  for (let i = a; i <= b; i++) if (p < 0 || ve(i) > ve(p)) p = i;
  if (p < 0 || ve(p) <= 0) return null;
  const target = ve(p) / 4;
  let o = p;
  while (o > 0 && ve(o - 1) >= target) o--;
  return f.t0 + o * f.hop;
};

/**
 * Starts of sung syllables ("Da"): loud voiced segments (within 12 dB of the
 * take's loudest singing, at least 60 ms long) that follow a real break, i.e.
 * the voice dropped at least 10 dB since the previous one. In a real take,
 * the "D" of each new note dipped 11+ dB, while loudness wobbles inside a
 * held note dipped only 6-9 dB, and breath/room noise between notes was
 * 15-25 dB quieter than the singing.
 */
export const sungOnsets = (f: VoiceFrames, segments: VoicedSegment[], minDipDb = 10, floorDb = 12): number[] => {
  if (!segments.length) return [];
  const peaks = segments.map((s) => s.peak).sort((a, b) => b - a);
  const ref = peaks[Math.floor(peaks.length * 0.1)];
  const loud = segments.filter((s) => db(s.peak) >= db(ref) - floorDb && s.end - s.start >= 0.06);
  const ve = voicedEnergy(f);
  const out: number[] = [];
  let prev: VoicedSegment | null = null;
  for (const s of loud) {
    if (prev) {
      const a = Math.max(0, Math.round((prev.peakTime - f.t0) / f.hop));
      const b = Math.min(ve.length - 1, Math.round((s.peakTime - f.t0) / f.hop));
      let low = Infinity;
      for (let i = a; i <= b; i++) low = Math.min(low, ve[i]);
      if (db(Math.min(prev.peak, s.peak)) - db(low) < minDipDb) continue; // same note, still sounding
    }
    out.push(s.onset);
    prev = s;
  }
  return out;
};
