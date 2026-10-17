import { Biquad } from "./biquad";
import { ClapDetectorOptions, energyToDb, Onset } from "./ClapDetector";
import { maxVoicedEnergy, voiceFrames } from "./voice";

// Second stage of clap detection. The detector (stage 1) is deliberately
// sensitive so that soft claps after loud ones aren't lost; that also lets
// through some spoken consonants ("t", "k", "s") and room echoes. A candidate
// counts as a clap based on two measurements:
//
//   relVoice  how much louder it is than the voice around it. Every consonant
//             sits next to a much louder vowel; a clap doesn't.
//   rise      how sharply it starts (claps are near-instant; consonants and
//             room echoes build up).
//
// It passes if it is near the voice's loudness but very sharp, or clearly
// louder than the voice and at least moderately sharp (a soft clap riding on
// a loud clap's room echo can't rise far above that echo). The score is the
// margin (in dB) by which it passes, so 0 is the threshold.
//
// Limits come from real takes on a webcam microphone in a live room: claps
// had relVoice >= 0 and rise >= 38; voice sounds with rise > 12 all had
// relVoice <= -5; room echoes have rise <= 7. Decay is still measured for
// diagnostics but not used: a count starting right on the clap fills the
// "tail" and hid real claps.

/** Sensitive first-stage settings; the classifier does the rejecting. */
export const CANDIDATE_OPTIONS: Partial<ClapDetectorOptions> = {
  highpassHz: 1200,
  riseRatio: 4,
  backgroundRatio: 5,
  minEnergy: 3e-7,
  echoDecayMs: 15,
  // 16 kHz microphones (common on webcams and Chromebooks) have nothing above
  // 8 kHz, so check for broadband sound above 3 kHz. Real claps keep >= 0.013
  // of their energy there; the metronome's sine clicks <= 0.007.
  highBandHz: 3000,
  minHighBandRatio: 0.009,
  maxRiseMs: 8,
};

export interface ClapFeatures {
  peakDb: number;
  relVoiceDb: number;
  riseDb: number;
  decayDb: number;
}

export interface ClapCandidate extends Onset {
  features: ClapFeatures;
  score: number;
  isClap: boolean;
}

/** Default threshold offset (dB); positive = more sensitive. */
export const DEFAULT_CLAP_BIAS = 0;
/** Near the voice: must rise very sharply. */
const NEAR_REL_VOICE = -8;
const NEAR_MIN_RISE = 34;
/** Clearly louder than the voice: a moderate rise is enough. */
const CLEAR_REL_VOICE = 6;
const CLEAR_MIN_RISE = 12;
/** Rise margins are worth more per dB than the voice margin. */
const SHAPE_WEIGHT = 1.5;
/** How far one step of the 1–5 sensitivity setting moves the threshold (dB). */
const SENSITIVITY_STEP = 2;

const DECAY_BAND_HZ = 3000;

/** Seconds of audio needed after an onset before it can be classified. */
export const CLASSIFY_DELAY = 0.33;

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Score without the bias; a clap if score + bias > 0. */
export const rawClapScore = (f: ClapFeatures) =>
  Math.max(
    Math.min(f.relVoiceDb - NEAR_REL_VOICE, SHAPE_WEIGHT * (f.riseDb - NEAR_MIN_RISE)),
    Math.min(f.relVoiceDb - CLEAR_REL_VOICE, SHAPE_WEIGHT * (f.riseDb - CLEAR_MIN_RISE))
  );

export const clapBias = (learned: number | null, sensitivity: number) =>
  (learned ?? DEFAULT_CLAP_BIAS) + (clamp(sensitivity, 1, 5) - 3) * SENSITIVITY_STEP;

const meanHighpassEnergy = (
  audio: Float32Array,
  sampleRate: number,
  at: number,
  fromSec: number,
  toSec: number,
  hz: number
) => {
  const h1 = Biquad.highpass(sampleRate, hz);
  const h2 = Biquad.highpass(sampleRate, hz);
  const settle = Math.max(0, at - Math.round(sampleRate * 0.03));
  const a = at + Math.round(fromSec * sampleRate);
  const b = Math.min(audio.length, at + Math.round(toSec * sampleRate));
  let sum = 0;
  let n = 0;
  for (let i = settle; i < b; i++) {
    const y = h2.process(h1.process(audio[i]));
    if (i >= a) {
      sum += y * y;
      n++;
    }
  }
  return n ? sum / n : 1e-12;
};

/**
 * Measure a candidate. audio/audioStart is the recording (any clock, as long
 * as onset.time uses the same one).
 */
export const clapFeatures = (
  audio: Float32Array,
  sampleRate: number,
  audioStart: number,
  onset: Onset
): ClapFeatures => {
  const idx = Math.round((onset.time - audioStart) * sampleRate);
  const frames = voiceFrames(audio, sampleRate, audioStart, idx - sampleRate * 0.32, idx + sampleRate * 0.32);
  const voice = maxVoicedEnergy(frames, onset.time - 0.25, onset.time + 0.25);
  // Decay is measured above 3 kHz, where a vowel starting with the clap adds
  // little but a "t" running on into breath noise still shows.
  const burst = meanHighpassEnergy(audio, sampleRate, idx, 0, 0.006, DECAY_BAND_HZ);
  const tail = meanHighpassEnergy(audio, sampleRate, idx, 0.025, 0.055, DECAY_BAND_HZ);
  const peakDb = energyToDb(onset.peak);
  return {
    peakDb,
    relVoiceDb: peakDb - energyToDb(voice),
    riseDb: peakDb - energyToDb(onset.pre),
    decayDb: energyToDb(burst) - energyToDb(tail),
  };
};

export const classifyCandidate = (
  audio: Float32Array,
  sampleRate: number,
  audioStart: number,
  onset: Onset,
  bias: number
): ClapCandidate => {
  const features = clapFeatures(audio, sampleRate, audioStart, onset);
  const score = rawClapScore(features) + bias;
  return { ...onset, features, score, isClap: score > 0 };
};

/**
 * Learn the threshold from candidates recorded while the student only counted
 * (so none of them are claps): put it just above the most clap-like one, but
 * stay within a sane range of the default.
 */
export const learnClapBias = (speechOnly: ClapFeatures[]) => {
  if (speechOnly.length === 0) return DEFAULT_CLAP_BIAS + 2;
  const worst = Math.max(...speechOnly.map(rawClapScore));
  return clamp(-worst - 1.5, DEFAULT_CLAP_BIAS - 6, DEFAULT_CLAP_BIAS + 3);
};
