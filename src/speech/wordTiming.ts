import { VoicedSegment } from "../audio/voice";

// Vosk's word start times are only approximate: it often counts part of the
// silence before a word as part of the word, so a count can look 100–200 ms
// early, by a different amount each take. Here each recognized word is moved
// to the vowel onset of the voiced segment it covers, which is accurate to a
// few ms and is also where a spoken count is perceived to land on the beat.

export interface TimedWord {
  time: number;
  end: number;
}

const MAX_WORD = 0.8;
const LONG_WORD_KEEP = 0.5;

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Returns a refined time for each word (same order). Words with no matching
 * voiced segment keep their Vosk time, shifted by the take's typical error.
 */
export const refineWordTimes = (words: TimedWord[], segments: VoicedSegment[]): number[] => {
  if (words.length === 0) return [];
  if (segments.length === 0) return words.map((w) => w.time);

  // Vosk sometimes stretches a word back over seconds of silence before it
  // (seen at the start of a take). A count is never that long, so only its
  // last part can hold the word.
  words = words.map((w) => (w.end - w.time > MAX_WORD ? { time: w.end - LONG_WORD_KEEP, end: w.end } : w));

  // 1. Typical Vosk error this take, from each word's best-overlapping segment.
  const errors: number[] = [];
  for (const w of words) {
    let best: VoicedSegment | null = null;
    let bestOv = 0;
    for (const s of segments) {
      const ov = overlap(w.time, w.end, s.start, s.end);
      if (ov > bestOv) {
        bestOv = ov;
        best = s;
      }
    }
    if (best) errors.push(best.onset - w.time);
  }
  const shift = errors.length ? Math.max(-0.3, Math.min(0.3, median(errors))) : 0;

  // 2. Assign in order; each segment belongs to at most one word.
  const out: number[] = [];
  let lastOnset = -Infinity;
  let segFrom = 0;
  for (const w of words) {
    const a = w.time + shift;
    const b = Math.max(w.end + shift, a + 0.08);
    let pick: VoicedSegment | null = null;
    for (let k = segFrom; k < segments.length; k++) {
      const s = segments[k];
      if (s.start > b) break;
      if (s.onset <= lastOnset + 0.05) continue;
      // Earliest segment that covers a real part of the word (first syllable).
      const ov = overlap(a, b, s.start, s.end);
      if (ov >= Math.min(0.03, 0.4 * (s.end - s.start))) {
        pick = s;
        segFrom = k + 1;
        break;
      }
    }
    if (!pick) {
      // Nothing overlapping: take a nearby onset if there is one.
      let nearest: VoicedSegment | null = null;
      for (let k = segFrom; k < segments.length; k++) {
        const s = segments[k];
        if (s.onset <= lastOnset + 0.05) continue;
        const inReach = s.onset >= a - 0.12 && s.onset <= b + 0.02;
        if (inReach && (!nearest || Math.abs(s.onset - a) < Math.abs(nearest.onset - a))) {
          nearest = s;
        }
      }
      pick = nearest;
      if (pick) segFrom = segments.indexOf(pick) + 1;
    }
    const time = pick ? pick.onset : a;
    out.push(time);
    lastOnset = time;
  }
  return out;
};
