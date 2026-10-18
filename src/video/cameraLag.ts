// The camera's delay, measured on every take instead of calibrated: the
// camera sees the hands meet and the microphone hears the clap, the same
// moment, so the typical gap between the two is how late the camera is.

/** Median gap (s) from each clap to the nearest moment the hands came together; null with too few pairs. */
export const cameraLag = (frames: { time: number; together: boolean | null }[], claps: number[]) => {
  const contacts: number[] = [];
  let before = false;
  for (const f of frames) {
    const now = f.together === true;
    if (now && !before) contacts.push(f.time);
    before = now;
  }
  const gaps: number[] = [];
  for (const c of claps) {
    let best: number | null = null;
    for (const t of contacts) if (Math.abs(t - c) <= 0.3 && (best === null || Math.abs(t - c) < Math.abs(best - c))) best = t;
    if (best !== null) gaps.push(best - c);
  }
  if (gaps.length < 5) return null;
  gaps.sort((a, b) => a - b);
  const lag = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
  return { lag, pairs: gaps.length };
};
