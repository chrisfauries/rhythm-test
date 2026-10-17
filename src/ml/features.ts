import { Resampler } from "../audio/Resampler";

// Log-mel spectrogram patches around an expected count, the input of the
// count-word model. The same code runs in the browser and in the training
// pipeline (ml/), so features always match.

export const FEATURE_RATE = 16000;
const N_FFT = 512;
const WIN = 400; // 25 ms
const HOP = 160; // 10 ms
export const N_MELS = 40;
const F_MIN = 60;
const F_MAX = 7600;
/** Patch: from 0.2 s before to 0.5 s after the anchor (where an on-time vowel would start). */
export const PATCH_BEFORE = 0.2;
export const PATCH_AFTER = 0.5;
export const PATCH_FRAMES = Math.round((PATCH_BEFORE + PATCH_AFTER) / (HOP / FEATURE_RATE));

const hann = Float64Array.from({ length: WIN }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / WIN));

const melOf = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const hzOf = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

/** Triangular mel filters over the FFT bins: [band][bin] weights (sparse as [start, weights]). */
const MEL_FILTERS: { start: number; w: Float64Array }[] = (() => {
  const bins = N_FFT / 2 + 1;
  const lo = melOf(F_MIN);
  const hi = melOf(F_MAX);
  const centers = Array.from({ length: N_MELS + 2 }, (_, i) => hzOf(lo + ((hi - lo) * i) / (N_MELS + 1)));
  const binHz = FEATURE_RATE / N_FFT;
  return Array.from({ length: N_MELS }, (_, m) => {
    const [a, c, b] = [centers[m], centers[m + 1], centers[m + 2]];
    const start = Math.floor(a / binHz);
    const end = Math.min(bins - 1, Math.ceil(b / binHz));
    const w = new Float64Array(end - start + 1);
    for (let k = start; k <= end; k++) {
      const hz = k * binHz;
      w[k - start] = Math.max(0, Math.min((hz - a) / (c - a), (b - hz) / (b - c)));
    }
    return { start, w };
  });
})();

export const fft = (re: Float64Array, im: Float64Array) => {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k);
        const s = Math.sin(ang * k);
        const p = i + k + len / 2;
        const xr = re[p] * c - im[p] * s;
        const xi = re[p] * s + im[p] * c;
        re[p] = re[i + k] - xr;
        im[p] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
};

/** Resample a whole recording to the feature rate (as the app does for Vosk). */
export const toFeatureRate = (audio: Float32Array, sampleRate: number) => {
  const rs = new Resampler(sampleRate, FEATURE_RATE);
  const parts: Float32Array[] = [];
  for (let i = 0; i < audio.length; i += 4096) parts.push(rs.process(audio.subarray(i, i + 4096)));
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/**
 * Log-mel patch [PATCH_FRAMES][N_MELS] (row-major) around `anchor` seconds
 * into `x16` (audio at FEATURE_RATE), normalized to zero mean, unit variance.
 */
export const melPatch = (x16: Float32Array, anchor: number): Float32Array => {
  const out = new Float32Array(PATCH_FRAMES * N_MELS);
  const first = Math.round((anchor - PATCH_BEFORE) * FEATURE_RATE) - WIN / 2;
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  for (let f = 0; f < PATCH_FRAMES; f++) {
    re.fill(0);
    im.fill(0);
    const s = first + f * HOP;
    for (let n = 0; n < WIN; n++) {
      const i = s + n;
      re[n] = i >= 0 && i < x16.length ? x16[i] * hann[n] : 0;
    }
    fft(re, im);
    for (let m = 0; m < N_MELS; m++) {
      const { start, w } = MEL_FILTERS[m];
      let e = 0;
      for (let k = 0; k < w.length; k++) e += w[k] * (re[start + k] ** 2 + im[start + k] ** 2);
      out[f * N_MELS + m] = Math.log(e + 1e-8);
    }
  }
  let mean = 0;
  for (let i = 0; i < out.length; i++) mean += out[i];
  mean /= out.length;
  let sd = 0;
  for (let i = 0; i < out.length; i++) sd += (out[i] - mean) ** 2;
  sd = Math.sqrt(sd / out.length) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / sd;
  return out;
};
