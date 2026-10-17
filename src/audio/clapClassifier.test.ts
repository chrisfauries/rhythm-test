import { CANDIDATE_OPTIONS, ClapCandidate, classifyCandidate, DEFAULT_CLAP_BIAS, learnClapBias } from "./clapClassifier";
import { Biquad } from "./biquad";
import { ClapDetector } from "./ClapDetector";
import { addClap, addClick, addSyllable, makeSignal, rng, SR } from "./testSignals";

/** What a 16 kHz webcam / Chromebook microphone keeps: nothing above ~8 kHz. */
const bandLimit = (x: Float32Array) => {
  const a = Biquad.lowpass(SR, 7000);
  const b = Biquad.lowpass(SR, 7000);
  return Float32Array.from(x, (v) => b.process(a.process(v)));
};

const detect = (x: Float32Array, bias = DEFAULT_CLAP_BIAS): ClapCandidate[] => {
  const det = new ClapDetector(SR, CANDIDATE_OPTIONS);
  const out: ClapCandidate[] = [];
  for (let i = 0; i < x.length; i += 512) {
    for (const o of det.process(x.subarray(i, i + 512), i / SR)) out.push(classifyCandidate(x, SR, 0, o, bias));
  }
  return out;
};

const claps = (cs: ClapCandidate[]) => cs.filter((c) => c.isClap).map((c) => c.time);

describe("clap classifier", () => {
  it("rejects spoken consonants while counting", () => {
    const x = makeSignal(4);
    [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5].forEach((t, i) =>
      addSyllable(x, t, { amp: 0.35, consonant: i % 2 ? "t" : "s" })
    );
    expect(claps(detect(x))).toEqual([]);
  });

  it("keeps claps made while counting, loud and soft", () => {
    const x = makeSignal(4);
    const times = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
    times.forEach((t, i) => {
      addSyllable(x, t + 0.01, { amp: 0.25, consonant: i % 2 ? "t" : "none" });
      addClap(x, t, i % 2 ? 0.6 : 0.12);
    });
    const found = claps(detect(x));
    expect(found).toHaveLength(times.length);
    found.forEach((t, i) => expect(Math.abs(t - times[i])).toBeLessThan(0.003));
  });

  it("ignores loud metronome clicks leaking from speakers", () => {
    const x = makeSignal(3);
    for (let t = 0.3; t < 2.8; t += 0.5) addClick(x, t, 0.6, t < 0.5 ? 1500 : 1000);
    expect(claps(detect(x))).toEqual([]);
  });

  it("catches a soft clap right after a loud one", () => {
    const x = makeSignal(1.5);
    addClap(x, 0.5, 0.9, 0.3);
    addClap(x, 0.75, 0.1);
    expect(claps(detect(x))).toHaveLength(2);
  });

  it("learns a stricter threshold from a student whose counting looks clap-like", () => {
    const x = makeSignal(4);
    [0.5, 1.0, 1.5, 2.0, 2.5, 3.0].forEach((t) => addSyllable(x, t, { amp: 0.4, consonant: "t", burst: 0.6 }));
    const speech = detect(x).map((c) => c.features);
    const bias = learnClapBias(speech);
    expect(detect(x, bias).filter((c) => c.isClap)).toHaveLength(0);
  });

  // Real takes from a webcam mic in a live room: each case below lost claps.
  it("keeps claps on a band-limited mic, including ones that ring with a second peak", () => {
    const x = makeSignal(3);
    const times = [0.5, 1.1, 1.7, 2.3];
    times.forEach((t, i) => {
      addClap(x, t, 0.4, 0.3);
      // Real claps often peak again ~10 ms later, sometimes louder.
      if (i % 2) addClap(x, t + 0.009, 0.5, 0.3);
    });
    const found = claps(detect(bandLimit(x)));
    expect(found).toHaveLength(times.length);
    found.forEach((t, i) => expect(Math.abs(t - times[i])).toBeLessThan(0.003));
  });

  it("times a clap from its own start when a faint sound creeps up just before it", () => {
    const x = makeSignal(1.5);
    const r = rng(5);
    const pre = Math.round(0.48 * SR);
    for (let i = 0; i < 0.02 * SR; i++) x[pre + i] += (r() * 2 * 0.004 * i) / (0.02 * SR);
    addClap(x, 0.5, 0.5);
    const found = detect(bandLimit(x)).filter((c) => c.isClap);
    expect(found).toHaveLength(1);
    expect(Math.abs(found[0].time - 0.5)).toBeLessThan(0.003);
    // The rise is measured from before the faint sound, not from inside it.
    expect(found[0].features.riseDb).toBeGreaterThan(35);
  });
});
