import { ClapDetector, Onset } from "./ClapDetector";

const SR = 48000;

// Deterministic pseudo-random noise.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32 - 0.5;
};

const makeSignal = (seconds: number, noiseAmp = 0.001) => {
  const r = rng(1);
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = r() * 2 * noiseAmp;
  return x;
};

/** A clap: broadband burst, ~1 ms attack, fast decay, plus a room reverb tail. */
const addClap = (x: Float32Array, t: number, amp = 0.5, reverb = 0.15) => {
  const r = rng(Math.round(t * 1000) + 7);
  const start = Math.round(t * SR);
  for (let i = 0; i < SR * 0.4 && start + i < x.length; i++) {
    const s = i / SR;
    const direct = Math.min(1, s / 0.001) * Math.exp(-s / 0.006);
    const tail = s > 0.005 ? reverb * Math.exp(-(s - 0.005) / 0.08) : 0;
    x[start + i] += r() * 2 * amp * (direct + tail);
  }
};

/** A metronome-style sine click (same shape the app plays). */
const addClick = (x: Float32Array, t: number, amp = 0.3, freq = 1000) => {
  const start = Math.round(t * SR);
  for (let i = 0; i < SR * 0.06 && start + i < x.length; i++) {
    const env = Math.min(1, i / (SR * 0.003)) * Math.exp(-i / (SR * 0.012));
    x[start + i] += amp * env * Math.sin((2 * Math.PI * freq * i) / SR);
  }
};

const run = (x: Float32Array, det = new ClapDetector(SR)): Onset[] => {
  const out: Onset[] = [];
  for (let i = 0; i < x.length; i += 512) {
    out.push(...det.process(x.subarray(i, i + 512), i / SR));
  }
  return out.filter((o) => !o.gated);
};

describe("ClapDetector", () => {
  it("finds each clap once with ~1 ms timing accuracy", () => {
    const times = [0.5, 1.0, 1.25, 1.5, 1.625, 1.75, 2.5];
    const x = makeSignal(3.2);
    times.forEach((t) => addClap(x, t));
    const onsets = run(x);
    expect(onsets).toHaveLength(times.length);
    onsets.forEach((o, i) => expect(Math.abs(o.time - times[i])).toBeLessThan(0.002));
  });

  it("does not double-trigger on a loud clap in a reverberant room", () => {
    const x = makeSignal(1.5);
    addClap(x, 0.5, 0.95, 0.4);
    expect(run(x)).toHaveLength(1);
  });

  it("catches a soft clap right after a loud one", () => {
    const x = makeSignal(1.5);
    addClap(x, 0.5, 0.9);
    addClap(x, 0.65, 0.3);
    expect(run(x)).toHaveLength(2);
  });

  it("ignores sine metronome clicks", () => {
    const x = makeSignal(3);
    for (let t = 0.3; t < 2.8; t += 0.5) addClick(x, t, 0.4);
    expect(run(x)).toHaveLength(0);
  });

  it("ignores slow-onset noise like a spoken 's'", () => {
    const x = makeSignal(1.5);
    const r = rng(99);
    const start = Math.round(0.5 * SR);
    for (let i = 0; i < SR * 0.25; i++) {
      const s = i / SR;
      const env = Math.min(1, s / 0.06) * Math.min(1, (0.25 - s) / 0.05);
      x[start + i] += r() * 2 * 0.15 * env;
    }
    expect(run(x)).toHaveLength(0);
  });

  it("gates quiet onsets near known click times but keeps loud claps", () => {
    const x = makeSignal(2);
    addClap(x, 0.5, 0.04); // as quiet as click bleed would be
    addClap(x, 1.5, 0.5);
    const det = new ClapDetector(SR);
    det.setGates(
      [
        { start: 0.45, end: 0.6 },
        { start: 1.45, end: 1.6 },
      ],
      0.01
    );
    const onsets = run(x, det);
    expect(onsets).toHaveLength(1);
    expect(onsets[0].time).toBeCloseTo(1.5, 2);
  });
});
