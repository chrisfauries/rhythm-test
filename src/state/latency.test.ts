import { calibrationReason, forgetDelays, learnedMicOffset, MIN_TAKES, recordTakeDelay, takeDelay } from "./latency";

describe("learned timing delay", () => {
  beforeEach(() => forgetDelays());

  it("uses nothing until enough takes, then the median", () => {
    const mic = "USB mic";
    [0.08, 0.1, 0.09].forEach((d) => recordTakeDelay(mic, d));
    expect(learnedMicOffset(mic).offset).toBeNull();
    [0.3, 0.095].forEach((d) => recordTakeDelay(mic, d));
    const l = learnedMicOffset(mic);
    expect(l.takes).toBe(MIN_TAKES);
    // One odd take doesn't move it.
    expect(l.offset).toBeCloseTo(0.095, 3);
  });

  it("keeps each microphone separate", () => {
    for (let i = 0; i < MIN_TAKES; i++) recordTakeDelay("webcam", 0.08);
    expect(learnedMicOffset("webcam").offset).toBeCloseTo(0.08, 3);
    expect(learnedMicOffset("headset").offset).toBeNull();
  });

  it("learns from a clean take: the delay that centers its claps", () => {
    // Claps 30 ms late on average with a 72 ms estimate: the device's delay is about 102 ms.
    const offsets = [25, 35, 30, 28, 32, 31, 29, 30, 27, 33];
    expect(takeDelay(0.072, offsets, 10)).toBeCloseTo(0.102, 3);
  });

  it("doesn't learn from takes that can't tell", () => {
    expect(takeDelay(0.072, [30, 30, 30], 3)).toBeNull(); // too few claps
    expect(takeDelay(0.072, [30, 30, 30, 30, 30, 30, 30, 30], 20)).toBeNull(); // most notes missed
    expect(takeDelay(0.072, [-150, -100, -50, 0, 50, 100, 150, 200, 250, 300], 10)).toBeNull(); // rushing or dragging
  });

  it("suggests calibrating only when something looks wrong", () => {
    expect(calibrationReason("Realtek microphone")).toBeNull();
    expect(calibrationReason("Headset (AirPods Pro) Hands-Free")).toMatch(/Bluetooth/);
    for (let i = 0; i < MIN_TAKES; i++) recordTakeDelay("slow", 0.25);
    expect(calibrationReason("slow")).toMatch(/large/);
    [0.05, 0.2, 0.08, 0.17, 0.06, 0.19].forEach((d) => recordTakeDelay("jumpy", d));
    expect(calibrationReason("jumpy")).toMatch(/changes/);
  });
});
