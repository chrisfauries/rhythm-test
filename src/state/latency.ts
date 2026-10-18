// Timing delays without a calibration step.
//
// The microphone delay (click scheduled → heard → clap → recorded) belongs to
// the device; a person's habit of being a little early or late varies from
// take to take. One take can't tell them apart, but many can: after each
// clean clapping take, the delay that would have centered its claps on the
// beat is remembered, and the median of the recent ones is used from then on.
// Until there are enough takes, the browser's own latency estimate is used.
// Calibration (CalibrateScreen) still wins when it has been done, and is
// suggested only when the learned delay looks wrong (Bluetooth, very large, or
// jumping around from take to take).

const KEY = "rhythm-tester-latency";
/** Takes needed before the learned delay is used. */
export const MIN_TAKES = 5;
/** Recent takes the estimate is the median of. */
const KEEP = 15;

type Store = Record<string, number[]>;

const load = (): Store => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** One device = one microphone (by its name); "default" when the browser doesn't say. */
const deviceOf = (micLabel: string) => micLabel.trim() || "default";

export interface Learned {
  /** The delay to use (s), or null until there are enough takes. */
  offset: number | null;
  takes: number;
  /** How much the takes disagree (s, interquartile range). */
  spread: number;
}

export const learnedMicOffset = (micLabel: string): Learned => {
  const xs = load()[deviceOf(micLabel)] ?? [];
  const s = [...xs].sort((a, b) => a - b);
  const spread = s.length >= 4 ? s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)] : 0;
  return { offset: xs.length >= MIN_TAKES ? median(xs) : null, takes: xs.length, spread };
};

/** Remembers the delay that would have centered this take's claps on the beat. */
export const recordTakeDelay = (micLabel: string, delay: number) => {
  if (!Number.isFinite(delay) || delay < 0 || delay > 0.6) return;
  const store = load();
  const key = deviceOf(micLabel);
  store[key] = [...(store[key] ?? []), +delay.toFixed(4)].slice(-KEEP);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private window: nothing is learned, the browser's estimate is used.
  }
};

export const forgetDelays = () => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
};

/**
 * From one take's claps: the delay that would have put them on the beat,
 * or null when the take can't tell (too few claps, too many mistakes, or
 * timing too uneven, e.g. rushing).
 */
export const takeDelay = (usedDelay: number, offsetsMs: number[], notes: number): number | null => {
  if (offsetsMs.length < 8 || offsetsMs.length < 0.7 * notes) return null;
  const s = [...offsetsMs].sort((a, b) => a - b);
  const iqr = s[Math.floor(s.length * 0.75)] - s[Math.floor(s.length * 0.25)];
  if (iqr > 120) return null;
  return usedDelay + median(s) / 1000;
};

/** Why calibration would help on this device, or null when it isn't needed. */
export const calibrationReason = (micLabel: string): string | null => {
  if (/bluetooth|hands-?free|airpods|buds|\bbt\b/i.test(micLabel))
    return "Bluetooth audio adds a large delay that changes from device to device.";
  const l = learnedMicOffset(micLabel);
  if (l.offset !== null && l.offset > 0.18) return "The timing delay on this computer looks large.";
  if (l.takes >= MIN_TAKES && l.spread > 0.06) return "The timing delay on this computer changes from take to take.";
  return null;
};
