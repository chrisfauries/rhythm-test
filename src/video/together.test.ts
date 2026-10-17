import { TogetherState } from "./together";

const tuning = { togetherBelow: 0.9, apartAbove: 1.3 };

// Feed (hands, distance) frames 50 ms apart (a 20 fps webcam).
const run = (frames: [number, number | null][]) => {
  const s = new TogetherState(tuning);
  return frames.map(([hands, d], i) => s.update(hands, d, i * 50));
};

describe("TogetherState", () => {
  it("uses palm distance with hysteresis when both hands are seen", () => {
    expect(run([[2, 2.0], [2, 0.8], [2, 1.1], [2, 1.4]])).toEqual([false, true, true, false]);
  });

  it("counts approaching hands that merge into one detection as together", () => {
    // What a real clap looks like: hands close in, then blur/overlap at contact.
    expect(run([[2, 2.3], [2, 1.8], [2, 1.3], [1, null], [1, null]])).toEqual([false, false, false, true, true]);
  });

  it("counts approaching hands that vanish (motion blur) as together, briefly", () => {
    const out = run([[2, 2.3], [2, 1.8], [0, null], [0, null], [0, null], [0, null], [0, null], [0, null], [0, null], [0, null]]);
    expect(out.slice(2, 4)).toEqual([true, true]);
    // With no hands visible at all it can't stay sure for long.
    expect(out[9]).toBeNull();
  });

  it("does not treat hands moving apart and then lost as together", () => {
    expect(run([[2, 1.4], [2, 1.9], [1, null]])).toEqual([false, false, null]);
  });

  it("stays together through a held note while the hands look like one", () => {
    const frames: [number, number | null][] = [[2, 2.0], [2, 1.2], ...Array<[number, null]>(30).fill([1, null])];
    const out = run(frames);
    expect(out.slice(2).every((t) => t === true)).toBe(true);
  });

  it("comes apart once two separated hands are seen again", () => {
    expect(run([[2, 1.5], [2, 1.0], [1, null], [1, null], [2, 1.6]]).slice(2)).toEqual([true, true, false]);
  });
});
