// Tempo and voice augmentation for the training set: makes a take sound as if
// it had been performed at another tempo, or by a higher voice.
//
// Tempo uses WSOLA time-stretching (pitch unchanged). Voice pitch-shifts by
// stretching and then resampling, which moves the formants along with the
// pitch, as a smaller vocal tract does. That's why the shifts stay small
// (children's formants are only ~15-35% above an adult's).

/** WSOLA: output is `factor` times as long as `x`, with the same pitch. */
const stretch = (x, factor, sr) => {
  const N = Math.round(0.03 * sr); // 30 ms frames
  const hs = N >> 1; // output hop
  const ha = hs / factor; // input hop
  const tol = Math.round(0.01 * sr); // search ±10 ms for the best-matching frame
  const w = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const outLen = Math.round(x.length * factor);
  const out = new Float32Array(outLen + N);
  const norm = new Float32Array(outLen + N);
  let prev = 0;
  // Near the end of the input, keep reading around its last frame (the search below finds the
  // best continuation, so a held sound carries on) until the output is the asked-for length.
  const lastStart = Math.max(0, x.length - N - tol);
  if (x.length < N + tol) return Float32Array.from({ length: outLen }, (_, i) => x[Math.floor((i / outLen) * x.length)]); // too short to stretch
  for (let k = 0; ; k++) {
    const nominal = Math.min(lastStart, Math.round(k * ha));
    const outPos = k * hs;
    if (outPos >= outLen) break;
    let best = nominal;
    if (k > 0) {
      // Pick the frame whose start best matches how the previous frame goes on (over the
      // part they overlap, which is always inside the input).
      const ref = prev + hs;
      let bestCorr = -Infinity;
      for (let d = -tol; d <= tol; d += 2) {
        const s = nominal + d;
        if (s < 0 || s + N > x.length) continue;
        let c = 0;
        for (let i = 0; i < N - hs; i += 2) c += x[s + i] * x[ref + i];
        if (c > bestCorr) {
          bestCorr = c;
          best = s;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      out[outPos + i] += x[best + i] * w[i];
      norm[outPos + i] += w[i];
    }
    prev = best;
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) out[i] /= norm[i];
  return out.subarray(0, outLen);
};

/** Reads `x` at `ratio` samples per output sample (windowed sinc, low-passed when speeding up). */
const resample = (x, ratio) => {
  const out = new Float32Array(Math.floor(x.length / ratio));
  const cutoff = Math.min(1, 1 / ratio);
  const taps = 16;
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const c = Math.floor(pos);
    let sum = 0;
    for (let j = c - taps + 1; j <= c + taps; j++) {
      if (j < 0 || j >= x.length) continue;
      const t = pos - j;
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
      const win = 0.5 + 0.5 * Math.cos((Math.PI * t) / taps);
      sum += x[j] * cutoff * sinc * win;
    }
    out[i] = sum;
  }
  return out;
};

/**
 * The take as if performed with every time scaled by `timeScale` (0.714 = 100 → 140 bpm)
 * and the voice shifted up `semitones`. Times in the result are original times × timeScale.
 */
const augment = (x, sr, timeScale, semitones) => {
  const r = 2 ** (semitones / 12);
  const s = stretch(x, timeScale * r, sr);
  return r === 1 ? s : resample(s, r);
};

module.exports = { stretch, resample, augment };
