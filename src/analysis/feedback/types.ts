import { ActivityInfo } from "../../music/activity";
import { Line } from "../../music/rhythm";
import { TakeResult } from "../analyze";

export type TipArea = "setup" | "steady" | "notes" | "counts" | "hands";

export interface Tip {
  /** What kind of problem (stable, for tests and analytics). */
  kind: string;
  area: TipArea;
  /** One or two sentences for the student: what happened, where, and what to do next time. */
  text: string;
  /** Where to look: the first position (q-units from the start of the line) it's about. */
  at?: number;
  /** Rough share of the overall score fixing this would win back (0–1). */
  gain: number;
  /** Ranking: gain weighted by how much the tip explains. */
  rank: number;
}

export interface Feedback {
  /** The single most helpful thing to work on (or praise and a next step). */
  top: Tip;
  /** The next most helpful tips, at most three. */
  more: Tip[];
  /** Why each score isn't 100%, in a few words. */
  reasons: Partial<Record<"notes" | "counts" | "hands", string>>;
}

export interface FeedbackInput {
  result: TakeResult;
  line: Line;
  activity: ActivityInfo;
  bpm: number;
  /** Was the metronome clicking during the line (not just the count-in)? */
  metronome: boolean;
  /**
   * Is the device's delay known (calibrated, or learned from earlier takes)?
   * When it's only the browser's estimate, "always a little early/late" needs
   * a bigger offset before it's reported. Default: known.
   */
  latencyKnown?: boolean;
}

/**
 * What one detector found: a candidate tip plus what it explains. The general
 * algorithm (ga.ts) weighs all the evidence and picks what to say.
 */
export interface Evidence {
  kind: string;
  area: TipArea;
  text: string;
  at?: number;
  /** Rough share of the overall score fixing this would win back (0–1). */
  gain: number;
  /**
   * What this explains: notes "n3", counts "c5", detected sounds "s7" (index
   * into Ctx.detected), extra words "w2". Later detectors leave claimed things
   * alone, and the GA drops evidence that something stronger already explains.
   */
  claims?: string[];
}
