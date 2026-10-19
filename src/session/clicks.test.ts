import { takeClicks } from "./TakeRunner";

describe("count-in and clicks", () => {
  it("counts in four beats in any meter, then accents each downbeat", () => {
    const timing = { countInStart: 0, secPerBeat: 0.5, countInBeats: 4, beatsPerMeasure: 3 };
    // "1, 2, Ready, Go!", then two measures of 3/4: beat 1 of each.
    expect(takeClicks(timing, 6).map((c) => c.accent)).toEqual([true, false, false, false, true, false, false, true, false, false]);
  });

  it("clicks dotted quarters in 6/8: four in the count-in, then 1 and 4 of each measure", () => {
    // 60 to the dotted quarter: an eighth is a third of a second.
    const timing = { countInStart: 0, secPerBeat: 1 / 3, countInBeats: 12, beatsPerMeasure: 6, beatsPerClick: 3 };
    const clicks = takeClicks(timing, 12);
    expect(clicks.map((c) => c.accent)).toEqual([true, false, false, false, true, false, true, false]);
    expect(clicks.map((c) => +c.time.toFixed(3))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
