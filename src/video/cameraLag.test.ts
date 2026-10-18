import { cameraLag } from "./cameraLag";

/** Camera frames at 20 fps where the hands come together `lag` seconds after each clap. */
const frames = (claps: number[], lag: number) => {
  const out: { time: number; together: boolean | null }[] = [];
  for (let t = 0; t < 12; t += 0.05) out.push({ time: t, together: claps.some((c) => t >= c + lag && t < c + lag + 0.15) });
  return out;
};

describe("camera delay from claps", () => {
  const claps = [1, 2, 3, 4, 5, 6, 7, 8];

  it("finds how late the camera sees the hands meet", () => {
    const r = cameraLag(frames(claps, 0.1), claps);
    expect(r?.pairs).toBe(8);
    expect(r!.lag).toBeGreaterThan(0.07);
    expect(r!.lag).toBeLessThan(0.15);
  });

  it("gives up with too few claps seen", () => {
    expect(cameraLag(frames([1, 2], 0.1), [1, 2])).toBeNull();
  });
});
