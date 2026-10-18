// Small numeric helpers for the feedback detectors.

/** Least squares y = a + b·x (null if x doesn't vary). */
export const lineFit = (xs: number[], ys: number[]) => {
  const n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  const sxx = xs.reduce((a, v) => a + (v - mx) ** 2, 0);
  if (sxx <= 1e-9) return null;
  const b = xs.reduce((a, v, i) => a + (v - mx) * (ys[i] - my), 0) / sxx;
  return { a: my - b * mx, b };
};

/** Least squares y = c0 + c1·x + c2·x² (null if it can't be solved). */
export const quadratic = (xs: number[], ys: number[]): [number, number, number] | null => {
  const S = [0, 0, 0, 0, 0];
  const T = [0, 0, 0];
  xs.forEach((x, i) => {
    for (let k = 0; k < 5; k++) S[k] += x ** k;
    for (let k = 0; k < 3; k++) T[k] += ys[i] * x ** k;
  });
  const m = [
    [S[0], S[1], S[2], T[0]],
    [S[1], S[2], S[3], T[1]],
    [S[2], S[3], S[4], T[2]],
  ];
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    if (Math.abs(m[p][c]) < 1e-9) return null;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
};

export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
export const isDotted = (len: number, beat: number) => near(len, beat * 1.5) || near(len, beat * 0.75) || near(len, beat * 3);
export const isTriplet = (len: number, beat: number) => near(len, beat / 3) || near(len, (2 * beat) / 3) || near(len, beat / 6);
