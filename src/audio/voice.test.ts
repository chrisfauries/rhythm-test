import { addClap, addSyllable, makeSignal, SR } from "./testSignals";
import { maxVoicedEnergy, sungOnsets, voicedSegments, voiceFrames } from "./voice";

describe("voice analysis", () => {
  it("finds the vowel onset of each syllable, whatever consonant comes first", () => {
    const x = makeSignal(3.5);
    const vowels = [0.5, 1.0, 1.5, 2.0, 2.4, 2.8];
    const consonants = ["none", "t", "s", "none", "t", "s"] as const;
    vowels.forEach((t, i) => addSyllable(x, t, { consonant: consonants[i] }));
    const segs = voicedSegments(voiceFrames(x, SR, 0));
    expect(segs).toHaveLength(vowels.length);
    segs.forEach((s, i) => expect(Math.abs(s.onset - vowels[i])).toBeLessThan(0.02));
  });

  it("splits back-to-back syllables at the dip between them", () => {
    const x = makeSignal(1.5);
    addSyllable(x, 0.4, { length: 0.2 });
    addSyllable(x, 0.62, { length: 0.2, amp: 0.15 });
    const segs = voicedSegments(voiceFrames(x, SR, 0));
    expect(segs.map((s) => Math.round(s.onset * 50) / 50)).toEqual([0.4, 0.62]);
  });

  it("does not treat a clap as voice", () => {
    const x = makeSignal(1.5);
    addClap(x, 0.5, 0.8);
    const frames = voiceFrames(x, SR, 0);
    expect(voicedSegments(frames)).toHaveLength(0);
    const y = makeSignal(1.5);
    addSyllable(y, 0.5, { amp: 0.05 });
    // Even a quiet vowel has far more voiced energy than a loud clap.
    expect(maxVoicedEnergy(voiceFrames(y, SR, 0), 0.4, 0.8)).toBeGreaterThan(
      10 * maxVoicedEnergy(frames, 0.4, 0.8)
    );
  });

  it("keeps the vowel onset when a clap lands on it", () => {
    const x = makeSignal(1.5);
    addSyllable(x, 0.6, { consonant: "t" });
    addClap(x, 0.6, 0.5);
    const segs = voicedSegments(voiceFrames(x, SR, 0));
    expect(segs).toHaveLength(1);
    expect(Math.abs(segs[0].onset - 0.6)).toBeLessThan(0.03);
  });

  it("finds sung notes, not wobbles inside a held note or breaths between notes", () => {
    const x = makeSignal(3);
    [0.5, 1.2, 1.9].forEach((t) => addSyllable(x, t, { amp: 0.3, length: 0.55 }));
    // A 7 dB loudness wobble in the middle of the second note.
    for (let i = Math.round(1.42 * SR); i < Math.round(1.48 * SR); i++) x[i] *= 0.45;
    // A faint voiced breath between notes.
    addSyllable(x, 2.7, { amp: 0.01, length: 0.1 });
    const f = voiceFrames(x, SR, 0);
    const onsets = sungOnsets(f, voicedSegments(f));
    expect(onsets).toHaveLength(3);
    onsets.forEach((t, i) => expect(Math.abs(t - [0.5, 1.2, 1.9][i])).toBeLessThan(0.03));
  });
});
