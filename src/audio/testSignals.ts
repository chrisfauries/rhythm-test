// Synthetic audio for unit tests: claps, metronome clicks and simple spoken
// syllables (a consonant followed by a pitched vowel).

export const SR = 48000;

/** Deterministic pseudo-random noise in [-0.5, 0.5). */
export const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32 - 0.5;
};

export const makeSignal = (seconds: number, noiseAmp = 0.001) => {
  const r = rng(1);
  const x = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < x.length; i++) x[i] = r() * 2 * noiseAmp;
  return x;
};

/** A clap: broadband burst, ~1 ms attack, fast decay, plus a room reverb tail. */
export const addClap = (x: Float32Array, t: number, amp = 0.5, reverb = 0.15) => {
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
export const addClick = (x: Float32Array, t: number, amp = 0.3, freq = 1000) => {
  const start = Math.round(t * SR);
  for (let i = 0; i < SR * 0.06 && start + i < x.length; i++) {
    const env = Math.min(1, i / (SR * 0.003)) * Math.exp(-i / (SR * 0.012));
    x[start + i] += amp * env * Math.sin((2 * Math.PI * freq * i) / SR);
  }
};

export type Consonant = "none" | "t" | "s";

/**
 * A spoken syllable whose vowel starts at `vowelAt`: optional consonant
 * before it ("t": sharp burst + breathy aspiration, "s": long hiss), then a
 * pitched vowel with a 20 ms attack.
 */
export const addSyllable = (
  x: Float32Array,
  vowelAt: number,
  // burst: loudness of a "t" release relative to the vowel (0.15 is typical;
  // 0.6 is an unusually harsh, close-to-the-mic "t").
  { amp = 0.2, consonant = "none" as Consonant, length = 0.22, f0 = 160, burst = 0.15 } = {}
) => {
  const r = rng(Math.round(vowelAt * 977) + 3);
  const v0 = Math.round(vowelAt * SR);
  if (consonant === "t") {
    const b0 = v0 - Math.round(0.06 * SR);
    for (let i = 0; i < 0.06 * SR; i++) {
      const s = i / SR;
      const pop = Math.min(1, s / 0.0005) * Math.exp(-s / 0.004);
      const breath = 0.25 * Math.exp(-s / 0.05);
      // Hiss-like: difference of noise samples tilts it toward high frequencies.
      x[b0 + i] += amp * burst * (pop + breath) * (r() - r());
    }
  } else if (consonant === "s") {
    const s0 = v0 - Math.round(0.1 * SR);
    for (let i = 0; i < 0.1 * SR; i++) {
      const env = Math.min(1, i / (0.03 * SR));
      x[s0 + i] += amp * 0.25 * env * (r() - r());
    }
  }
  const n = Math.round(length * SR);
  for (let i = 0; i < n && v0 + i < x.length; i++) {
    const s = i / SR;
    const env = Math.min(1, s / 0.02) * Math.min(1, (length - s) / 0.04);
    let v = 0;
    for (let k = 1; k * f0 < 3000; k++) v += Math.sin(2 * Math.PI * k * f0 * s) / k;
    x[v0 + i] += amp * 0.5 * env * v;
  }
};
