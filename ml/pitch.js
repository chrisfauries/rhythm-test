// Pitch (f0) of a voice, for the sound bank and for measuring real singing.
/** f0 (Hz) of x around sample c, by autocorrelation over 70-600 Hz (null if not clearly pitched). */
const pitchAt = (x, c, SR) => {
  const n = Math.round(0.03 * SR);
  const a = c - (n >> 1);
  const minLag = Math.floor(SR / 600);
  const maxLag = Math.ceil(SR / 70);
  if (a < 0 || a + n + maxLag >= x.length) return null;
  const r = new Float32Array(maxLag + 2);
  for (let L = minLag; L <= maxLag + 1; L++) {
    let s = 0, e1 = 0, e2 = 0;
    for (let i = 0; i < n; i++) {
      s += x[a + i] * x[a + i + L];
      e1 += x[a + i] ** 2;
      e2 += x[a + i + L] ** 2;
    }
    r[L] = s / Math.sqrt(e1 * e2 + 1e-12);
  }
  let top = 0;
  for (let L = minLag; L <= maxLag; L++) top = Math.max(top, r[L]);
  if (top < 0.6) return null;
  // The shortest lag that's a local peak nearly as strong as the best (avoids octave-down errors).
  for (let L = minLag + 1; L <= maxLag; L++) {
    if (r[L] >= 0.88 * top && r[L] >= r[L - 1] && r[L] >= r[L + 1]) {
      // Parabolic refinement of the peak.
      const d = (r[L - 1] - r[L + 1]) / (2 * (r[L - 1] - 2 * r[L] + r[L + 1]) || 1);
      return SR / (L + Math.max(-0.5, Math.min(0.5, d)));
    }
  }
  return null;
};

module.exports = { pitchAt };
