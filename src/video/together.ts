// Decides from hand-tracking results whether the hands are together.
//
// From real takes (webcam at ~20 fps): two hands are tracked well as they
// come together, but at contact the frame is motion-blurred and the pressed
// palms are seen edge-on, so MediaPipe usually reports one hand or none. So
// hands that were approaching and then merge count as together, and stay
// together while they still look like one hand (a held note). They only come
// apart when two separate hands are seen again.

export interface TogetherTuning {
  /** Hands count as together below this palm distance (hand lengths). */
  togetherBelow: number;
  /** ...and apart again only above this one. */
  apartAbove: number;
}

/** Approaching hands closer than this (hand lengths) that then merge are together. */
const APPROACH_REACH = 2.6;
/** How long after the last two-hand frame a merge still counts. */
const MERGE_MS = 400;

export class TogetherState {
  private together = false;
  private lastTwoAt = -Infinity;
  private lastDistance: number | null = null;
  private approaching = false;

  constructor(public tuning: TogetherTuning) {}

  /** Returns together / apart, or null when it can't tell. */
  update(hands: number, distance: number | null, nowMs: number): boolean | null {
    if (hands >= 2 && distance !== null) {
      const prev = nowMs - this.lastTwoAt < MERGE_MS ? this.lastDistance : null;
      this.approaching = prev !== null && distance < prev && distance < APPROACH_REACH;
      if (this.together && distance > this.tuning.apartAbove) this.together = false;
      else if (!this.together && distance < this.tuning.togetherBelow) this.together = true;
      this.lastTwoAt = nowMs;
      this.lastDistance = distance;
      return this.together;
    }
    const recent = nowMs - this.lastTwoAt < MERGE_MS;
    if (!this.together && this.approaching && recent) this.together = true;
    if (this.together && (hands === 1 || recent)) return true;
    this.together = false;
    return null;
  }
}
