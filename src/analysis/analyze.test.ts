import { parseLine } from "../music/rhythm";
import { align, analyzeTake, calibrate, TakeInput } from "./analyze";

const line = parseLine("q q h | qr 8 8 q q", "4/4");
// 60 bpm: one beat per second, line starts at t=10.
const base: TakeInput = {
  line,
  bpm: 60,
  startTime: 10,
  activity: "clap-count-notes",
  strictness: "normal",
  claps: [],
  words: null,
  frames: null,
};
const perfect = [10, 11, 12, 15, 15.5, 16, 17];

describe("align", () => {
  it("does not let one missing clap shift the rest", () => {
    const m = align([0, 1, 2, 3], [0.02, 2.01, 3.0], [0.4, 0.4, 0.4, 0.4]);
    expect(m).toEqual([0, null, 1, 2]);
  });
});

describe("analyzeTake", () => {
  it("scores a perfect performance at 100%", () => {
    const r = analyzeTake({ ...base, claps: perfect });
    expect(r.notes.every((n) => n.status === "on-time")).toBe(true);
    expect(r.summary.clapScore).toBe(1);
    expect(r.extraClaps).toHaveLength(0);
  });

  it("flags early, late, missed and extra claps", () => {
    const claps = [10, 10.85, 12.15, 15.5, 15.75, 16, 17];
    const r = analyzeTake({ ...base, claps });
    expect(r.notes.map((n) => n.status)).toEqual([
      "on-time",
      "early",
      "late",
      "missed",
      "on-time",
      "on-time",
      "on-time",
    ]);
    expect(r.extraClaps.map((e) => e.time)).toEqual([15.75]);
    expect(r.notes[1].offsetMs).toBe(-150);
  });

  it("uses the camera when a clap was too soft to hear", () => {
    const frames = [
      { time: 14.9, together: false },
      { time: 15.0, together: true },
      { time: 15.1, together: false },
    ];
    const claps = perfect.filter((t) => t !== 15);
    const r = analyzeTake({ ...base, claps, frames });
    expect(r.notes[3].status).toBe("seen");
  });

  it("checks that half notes are held", () => {
    const held = [];
    for (let t = 11.5; t < 14.8; t += 0.1) held.push({ time: t, together: t < 12.1 || t > 12.6 ? false : true });
    const releasedEarly = analyzeTake({ ...base, claps: perfect, frames: held });
    expect(releasedEarly.notes[2].hold?.status).toBe("released");

    const good = held.map((f) => ({ ...f, together: f.time >= 12 && f.time < 13.9 }));
    expect(analyzeTake({ ...base, claps: perfect, frames: good }).notes[2].hold?.status).toBe("held");
  });

  it("grades spoken counts, including wrong words", () => {
    const words = [
      { word: "one", label: "one", time: 10.02 },
      { word: "two", label: "two", time: 11.0 },
      { word: "three", label: "three", time: 12.0 },
      { word: "four", label: "four", time: 13.0 },
      // measure 2: rest on 1, then "2 and 3 4"
      { word: "two", label: "two", time: 15.0 },
      { word: "three", label: "three", time: 15.5 }, // should be "and"
      { word: "three", label: "three", time: 16.0 },
      { word: "four", label: "four", time: 17.0 },
    ];
    const r = analyzeTake({ ...base, claps: perfect, words });
    expect(r.counts!.map((c) => `${c.label}:${c.status}`)).toEqual([
      "one:correct",
      "two:correct",
      "three:correct",
      "four:correct",
      "two:correct",
      "and:wrong",
      "three:correct",
      "four:correct",
    ]);
  });

  it("checks for a silent hand pulse on each rest beat", () => {
    // Palms sit at 0.6 of the frame height; hands are 0.1 of it long.
    const frames = (dipAt: number | null) =>
      Array.from({ length: 80 }, (_, i) => {
        const time = 10 + i * 0.1;
        const palmY = dipAt !== null && Math.abs(time - dipAt) < 0.15 ? 0.6 + 0.25 * (1 - Math.abs(time - dipAt) / 0.15) : 0.6;
        return { time, together: false, palmY, scale: 0.1 };
      });
    const pulsed = analyzeTake({ ...base, claps: perfect, frames: frames(14.05) });
    expect(pulsed.rests!.map((r) => r.status)).toEqual(["pulsed"]);
    expect(pulsed.summary.holdScore).not.toBeNull();
    const missed = analyzeTake({ ...base, claps: perfect, frames: frames(null) });
    expect(missed.rests!.map((r) => r.status)).toEqual(["missed"]);
    // No pulses expected when not clapping.
    expect(analyzeTake({ ...base, activity: "count-notes", frames: frames(14.05) }).rests).toBeNull();
  });

  it("counts a pulse that goes off the bottom of the camera's view", () => {
    // Palms move down, then the camera loses them for 0.3 s around the rest beat.
    const frames = Array.from({ length: 80 }, (_, i) => {
      const time = 10 + i * 0.05;
      const gone = time > 13.9 && time < 14.25;
      const palmY = gone ? null : time > 13.75 && time <= 13.9 ? 0.6 + (time - 13.75) * 0.6 : 0.6;
      return { time, together: gone ? null : false, palmY, scale: gone ? null : 0.1 };
    });
    expect(analyzeTake({ ...base, claps: perfect, frames }).rests!.map((r) => r.status)).toEqual(["pulsed"]);
    // Hands lost just as briefly at a clap (no downward motion) is not a pulse.
    const clapBlur = frames.map((f) => (f.time > 12.0 && f.time < 12.1 ? { ...f, palmY: null, scale: null } : f));
    expect(analyzeTake({ ...base, claps: perfect, frames: clapBlur }).rests!.length).toBe(1);
  });

  it("credits a count on a clap beat by its timing when the clap hid the word", () => {
    const words = [
      { word: "one", label: "one", time: 10.0 },
      { word: "two", label: "two", time: 11.0 },
      // "three" (on a clap) and "four" (held beat, no clap) not recognized
      { word: "two", label: "two", time: 15.0 },
      { word: "and", label: "and", time: 15.5 },
      { word: "three", label: "three", time: 16.0 },
      { word: "four", label: "four", time: 17.0 },
    ];
    const voiceOnsetNear = (t: number) => t + 0.03;
    const r = analyzeTake({ ...base, claps: perfect, words, voiceOnsetNear });
    const three = r.counts!.find((c) => c.label === "three" && c.pos === 2)!;
    expect(three.status).toBe("correct");
    expect(three.unclear).toBe(true);
    // Beat 4 is inside the half note: no clap there, so no excuse.
    expect(r.counts!.find((c) => c.label === "four" && c.pos === 3)!.status).toBe("missed");
  });

  it("grades notes from their counts when counting only", () => {
    const words = [10, 11, 12, 13, 15, 15.5, 16, 17].map((time, i) => {
      const label = ["one", "two", "three", "four", "two", "and", "three", "four"][i];
      return { word: label, label, time: i === 1 ? time + 0.2 : time };
    });
    const r = analyzeTake({ ...base, activity: "count-notes", claps: [], words });
    expect(r.summary.clapScore).toBeNull();
    expect(r.notes.map((n) => n.status)).toEqual(["on-time", "late", "on-time", "on-time", "on-time", "on-time", "on-time"]);
  });

  it("grades sung notes and how long each is held", () => {
    const sung = { ...base, activity: "sing" as const, sungOnsets: perfect };
    const full = analyzeTake({ ...sung, voicedSpans: perfect.map((t, i): [number, number] => [t, [11, 12, 14, 15.5, 16, 17, 18][i] - 0.05]) });
    expect(full.notes.every((n) => n.status === "on-time")).toBe(true);
    expect(full.notes[2].hold?.status).toBe("held");
    // The half note's "Da" stops after one beat.
    const short = analyzeTake({ ...sung, voicedSpans: [[12, 12.9]] });
    expect(short.notes[2].hold?.status).toBe("released");
  });

  it("reports a rushing tendency", () => {
    const r = analyzeTake({ ...base, claps: perfect.map((t) => t - 0.05) });
    expect(r.summary.tendency).toBe("rushing");
  });
});

describe("calibrate", () => {
  it("measures the median sensor delay", () => {
    const beats = [1, 2, 3, 4, 5, 6, 7, 8];
    const claps = beats.map((b, i) => b + 0.08 + (i % 2 ? 0.01 : -0.01));
    const words = beats.map((b) => ({ word: "one", label: "one", time: b + 0.15 }));
    const r = calibrate(beats, claps, words, null);
    expect(r.micOffset).toBeCloseTo(0.08, 2);
    expect(r.speechOffset).toBeCloseTo(0.15, 2);
    expect(r.videoOffset).toBeNull();
  });
});
