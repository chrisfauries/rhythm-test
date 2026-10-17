import { LabelEvent, TakeInfo } from "./labels";
import { assignEvents, beatName, buildBeats, snap } from "./review";

// One 4/4 measure at 60 bpm, line starting at 1 s: quarter, quarter, quarter rest, quarter.
const info = {
  notes: [
    { pos: 0, t: 1, len: 1 },
    { pos: 1, t: 2, len: 1 },
    { pos: 3, t: 4, len: 1 },
  ],
  counts: [
    { pos: 0, t: 1.02, label: "one" },
    { pos: 1, t: 2.02, label: "two" },
    { pos: 3, t: 4.02, label: "four" },
  ],
  rests: [{ pos: 2, t: 3 }],
} as unknown as TakeInfo;

const ev = (id: number, type: LabelEvent["type"], t: number, label?: string): LabelEvent => ({ id, type, t, label, source: "app" });

describe("labeler review", () => {
  it("groups a note and its count into one beat, and gives the rest its own", () => {
    const beats = buildBeats(info, true);
    expect(beats.map((b) => b.pos)).toEqual([0, 1, 2, 3]);
    expect(beats[0].note && beats[0].count?.label).toBe("one");
    expect(beats[2].rest).toBeTruthy();
    expect(beats[2].note).toBeUndefined();
  });

  it("leaves claps and rests out when the activity has no clapping", () => {
    const beats = buildBeats(info, false);
    expect(beats.map((b) => b.pos)).toEqual([0, 1, 3]);
    expect(beats.every((b) => !b.note && !b.rest)).toBe(true);
  });

  it("matches events to beats and keeps the rest as extras", () => {
    const beats = buildBeats(info, true);
    const events = [
      ev(1, "clap", 1.01),
      ev(2, "count", 1.05, "one"),
      ev(3, "clap", 2.6), // between beats: an extra clap
      ev(4, "pulse", 3.1),
      ev(5, "count", 4.03, "three"), // wrong word, still this beat's word
    ];
    const a = assignEvents(beats, events, info);
    expect(a[0].clap?.id).toBe(1);
    expect(a[0].word?.id).toBe(2);
    expect(a[1].clap).toBeNull();
    expect(a[2].pulse?.id).toBe(4);
    expect(a[3].word?.label).toBe("three");
    expect(a.flatMap((x) => x.extras).map((e) => e.id)).toEqual([3]);
  });

  it("names positions by measure and beat", () => {
    expect(beatName(0, 4, 1)).toBe("measure 1, beat 1");
    expect(beatName(5.5, 4, 1)).toBe("measure 2, beat 2 &");
    expect(beatName(2.25, 4, 1)).toBe("measure 1, beat 3 e");
  });

  it("snaps to the nearest sound onset when one is close", () => {
    expect(snap(1, [0.5, 1.04, 1.2])).toBe(1.04);
    expect(snap(1, [0.5, 1.3])).toBe(1);
  });
});
