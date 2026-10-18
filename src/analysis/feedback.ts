import { makeContext } from "./feedback/context";
import { counting } from "./feedback/counts";
import { durations } from "./feedback/durations";
import { entrance } from "./feedback/entrance";
import { figures } from "./feedback/figures";
import { distill } from "./feedback/ga";
import { hands } from "./feedback/hands";
import { residual } from "./feedback/residual";
import { setup } from "./feedback/setup";
import { timing } from "./feedback/timing";
import { Evidence, Feedback, FeedbackInput } from "./feedback/types";

export type { Feedback, FeedbackInput, Tip, TipArea } from "./feedback/types";

// Feedback: what the student should do differently on their next try, in
// plain sentences, most helpful first. It reads the grader's result
// (analyze.ts) and explains it, diagnosing the cause instead of listing
// symptoms.
//
// Detectors (feedback/*.ts) each look at part of the take and report
// evidence: a candidate tip, how much of the score fixing it would win back,
// and what it explains (which notes, counts, sounds). They run in tiers:
//   1. timing.ts: which sound belongs to which note, and what explains the
//      timing as a whole (steady, drifting, rushing through runs, a skipped or
//      added beat, coming in a beat off, stopping or starting over: stops.ts;
//      a figure played as another: morph.ts, measured beat by beat first).
//      Everything later is judged against it.
//   2. patterns: coming in late (entrance.ts), long and tied notes played
//      wrong (durations.ts), figures that keep coming early or late
//      (figures.ts).
//   3. residual.ts: single notes off the beat, missed notes, extra sounds,
//      only where no pattern explains them; then counting (counts.ts) and
//      hands (hands.ts).
// The general algorithm (ga.ts) weighs the evidence, drops what something
// stronger already explains, and distills the rest into the top tip, a few
// more, and a reason under each score.

export const feedback = (input: FeedbackInput): Feedback => {
  const ctx = makeContext(input);
  const evidence: Evidence[] = [...setup(ctx)];
  const t = timing(ctx);
  evidence.push(...t.evidence);
  // Tier 2 and 3: each detector sees what the ones before it explained.
  const run = (found: Evidence[]) => {
    found.forEach((e) => e.claims?.forEach((c) => ctx.claimed.add(c)));
    evidence.push(...found);
  };
  run(entrance(ctx, t.timing));
  run(durations(ctx, t.timing));
  run(figures(ctx, t.timing));
  run(residual(ctx, t.timing));
  run(counting(ctx, t.timing));
  run(hands(ctx));
  return distill(ctx, evidence);
};
