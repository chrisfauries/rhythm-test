import { VoicedSegment } from "../audio/voice";
import { refineWordTimes } from "./wordTiming";

const seg = (onset: number, len = 0.2): VoicedSegment => ({
  onset,
  start: onset - 0.01,
  end: onset + len,
  peakTime: onset + 0.05,
  peak: 1,
});

describe("refineWordTimes", () => {
  const onsets = [1.0, 1.5, 2.0, 2.5, 3.0];
  const segments = onsets.map((o) => seg(o));

  it("moves words that Vosk reports early onto their vowel onsets", () => {
    // Vosk-style: starts 180 ms early, ends roughly right.
    const words = onsets.map((o) => ({ time: o - 0.18, end: o + 0.18 }));
    refineWordTimes(words, segments).forEach((t, i) => expect(t).toBeCloseTo(onsets[i], 5));
  });

  it("handles words reported late, and uneven errors", () => {
    const errs = [0.12, -0.2, 0.05, -0.15, 0.1];
    const words = onsets.map((o, i) => ({ time: o + errs[i], end: o + errs[i] + 0.25 }));
    refineWordTimes(words, segments).forEach((t, i) => expect(t).toBeCloseTo(onsets[i], 5));
  });

  it("keeps the first syllable of a two-syllable word and doesn't reuse segments", () => {
    // "seven" = two segments, then "and".
    const segs = [seg(1.0, 0.12), seg(1.16, 0.12), seg(1.5)];
    const words = [
      { time: 0.9, end: 1.3 },
      { time: 1.42, end: 1.7 },
    ];
    expect(refineWordTimes(words, segs)).toEqual([1.0, 1.5]);
  });

  it("falls back to the shifted Vosk time when no voice was found", () => {
    const words = [
      { time: 0.82, end: 1.2 },
      { time: 5.0, end: 5.3 },
    ];
    const out = refineWordTimes(words, [seg(1.0)]);
    expect(out[0]).toBeCloseTo(1.0, 5);
    expect(out[1]).toBeCloseTo(5.18, 5);
  });

  it("ignores the silence Vosk sometimes stretches a first word over", () => {
    // Seen in a real take: "one" reported from 0.0 to 3.69 s, with a stray
    // sound at 0.32 s and the actual word at 3.42 s.
    const segs = [seg(0.32, 0.05), seg(3.42), seg(4.2), seg(4.95)];
    const words = [
      { time: 0.0, end: 3.69 },
      { time: 4.14, end: 4.44 },
      { time: 4.89, end: 5.19 },
    ];
    const out = refineWordTimes(words, segs);
    expect(out[0]).toBeCloseTo(3.42, 5);
    expect(out[1]).toBeCloseTo(4.2, 5);
    expect(out[2]).toBeCloseTo(4.95, 5);
  });
});
