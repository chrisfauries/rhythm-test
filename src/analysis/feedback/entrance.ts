import { Ctx } from "./context";
import { Timing } from "./timing";
import { Evidence } from "./types";

// Coming in late: the first note (or first few) missed or late after the
// count-in, while the line after it is fine. (Coming in a whole beat early or
// late and staying shifted is found in timing.ts.)

export const entrance = (ctx: Ctx, t: Timing): Evidence[] => {
  const { notes, exp, x0, noteGain, noun, skip, secPerBeat } = ctx;
  const { paired, offsetOf, model, tolMs, cutK } = t;
  if (notes.length < 4 || cutK < 4) return [];
  // The first note heard, and whether the notes after it are on (the student's) beat.
  const first = paired.findIndex((j, i) => j !== null && !skip[i]);
  if (first < 0 || first > 2) return [];
  const settled = paired
    .slice(first + 1, first + 4)
    .every((j, k) => j !== null && Math.abs(offsetOf(first + 1 + k) - model(exp[first + 1 + k] - x0)) <= tolMs);
  if (!settled) return [];
  const missedFirst = notes
    .slice(0, first)
    .map((_, i) => i)
    .filter((i) => !skip[i] && notes[i].status === "missed");
  const lateMs = offsetOf(first) - model(exp[first] - x0);
  const lateFirst = lateMs > Math.max(tolMs, 0.2 * secPerBeat * 1000);
  if (!missedFirst.length && !lateFirst) return [];
  const claims = [...missedFirst, ...(lateFirst ? [first] : [])].map((i) => `n${i}`);
  return [
    {
      kind: "late-entrance",
      area: "steady",
      text: missedFirst.length
        ? `You came in late: the first ${noun} goes right after the count-in. Get ready during the count-in so your first ${noun} lands on “1”.`
        : `Your first ${noun} came late (${Math.round(lateMs)} ms). Get ready during the count-in so it lands right on “1”.`,
      at: notes[0].pos,
      gain: noteGain(claims.length),
      claims,
    },
  ];
};
