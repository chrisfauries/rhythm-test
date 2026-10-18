import { activityInfo, Activity } from "../music/activity";
import { expectedClaps, expectedCounts, parseLine } from "../music/rhythm";
import { analyzeTake, TakeFrame, TakeWord } from "./analyze";
import { feedback } from "./feedback";

// Each test performs a line with one kind of mistake (60 bpm: one beat per
// second, the line starts at t=10), grades it, and checks the top tip.

const QUARTERS = "q q q q | q q q q | q q q q | q q q q";

const take = (
  source: string,
  opts: {
    activity?: Activity;
    claps?: (t: number, i: number, pos: number) => number | null;
    /** More claps (times), e.g. where there's no note. */
    extra?: number[];
    words?: TakeWord[] | null;
    frames?: TakeFrame[] | null;
    voicedSpans?: [number, number][];
    metronome?: boolean;
    bpm?: number;
  } = {},
) => {
  const line = parseLine(source, "4/4");
  const activity = opts.activity ?? "clap";
  const bpm = opts.bpm ?? 60;
  const secPerQ = 60 / bpm;
  const claps = expectedClaps(line)
    .map((c, i) => (opts.claps ? opts.claps(10 + c.pos * secPerQ, i, c.pos) : 10 + c.pos * secPerQ))
    .filter((t): t is number => t !== null)
    .concat(opts.extra ?? [])
    .sort((a, b) => a - b);
  const result = analyzeTake({
    line,
    bpm,
    startTime: 10,
    activity,
    strictness: "normal",
    claps,
    words: opts.words ?? null,
    frames: opts.frames ?? null,
    voicedSpans: opts.voicedSpans,
  });
  return feedback({ result, line, activity: activityInfo(activity), bpm, metronome: opts.metronome ?? true });
};

/** Every count of the line said on time, then changed by `edit`. */
const spoken = (source: string, mode: "notes" | "all", edit: (w: TakeWord[]) => TakeWord[] = (w) => w) => {
  const line = parseLine(source, "4/4");
  return edit(expectedCounts(line, mode).map((c) => ({ word: c.label, label: c.label, time: 10 + c.pos })));
};

describe("feedback", () => {
  it("praises a clean take and suggests a next step", () => {
    const f = take(QUARTERS);
    expect(f.top.kind).toBe("praise");
    expect(f.top.text).toMatch(/68 BPM/);
    expect(f.more).toHaveLength(0);
  });

  it("says when nothing was heard", () => {
    const f = take(QUARTERS, { claps: () => null });
    expect(f.top.kind).toBe("no-claps");
  });

  it("finds one added beat instead of a line of misses", () => {
    // A rest in measure 2 held a beat too long: everything after it is a beat late.
    // (After all quarter notes a shift by a beat can't be told from one miss; real lines vary.)
    const f = take("q q q q | q qr q q | h 8 8 q | q 8 8 h", { claps: (t, i, pos) => (pos >= 6 ? t + 1 : t) });
    expect(f.top.kind).toBe("added-beat");
    expect(f.top.text).toMatch(/measure 2/);
    expect(f.top.text).toMatch(/the rest/);
    expect(f.more.some((t) => t.kind === "missed")).toBe(false);
  });

  it("finds a skipped beat", () => {
    const f = take("q q q q | h q q | h 8 8 q | 8 8 q h", { claps: (t, i, pos) => (pos >= 6 ? t - 1 : t) });
    expect(f.top.kind).toBe("skipped-beat");
    expect(f.top.text).toMatch(/measure 2/);
    expect(f.top.text).toMatch(/long note/);
  });

  it("finds where the student started to rush", () => {
    // Steady for two measures, then 30 ms earlier on every beat.
    const f = take(QUARTERS, { claps: (t, i, pos) => t - Math.max(0, pos - 8) * 0.03 });
    expect(f.top.kind).toBe("rushing");
    expect(f.top.text).toMatch(/from measure 3/);
  });

  it("finds rushing through notes in a row, back on the beat after each rest", () => {
    // Each run of quarters gets 60 ms earlier per note; the note after a rest is on time.
    const source = "q q q q | q qr q q | q q qr q | q q q qr";
    const starts = [0, 6, 11];
    const f = take(source, {
      claps: (t, i, pos) => t - 0.06 * (pos - Math.max(...starts.filter((s) => s <= pos))),
    });
    expect(f.top.kind).toBe("rushing-runs");
    expect(f.top.text).toMatch(/notes in a row/);
    expect(f.top.text).toMatch(/put you back on it/);
  });

  it("still calls a steady speed-up through rests a drift", () => {
    const f = take("q q q q | q qr q q | q q qr q | q q q qr", { claps: (t, i, pos) => t - pos * 0.02 });
    expect(f.top.kind).toBe("rushing");
  });

  it("finds dragging without the click", () => {
    const f = take(QUARTERS, { claps: (t, i, pos) => t + pos * 0.015, metronome: false });
    expect(f.top.kind).toBe("dragging");
    expect(f.top.text).toMatch(/tap your foot/);
  });

  it("finds a steady offset", () => {
    const f = take(QUARTERS, { claps: (t) => t - 0.09 });
    expect(f.top.kind).toBe("early");
    expect(f.top.text).toMatch(/about 90 ms/);
  });

  it("names the figure that keeps going wrong", () => {
    // The note after each rest comes in early.
    const f = take("q qr q q | q qr q q | q qr q q | q q q q", { claps: (t, i, pos) => ([2, 6, 10].includes(pos) ? t - 0.15 : t) });
    expect(f.top.kind).toBe("figure");
    expect(f.top.text).toMatch(/notes right after a rest came early/);
    expect(f.top.text).toMatch(/measures 1, 2 and 3/);
  });

  it("explains scores that aren't 100%", () => {
    const f = take("q qr q q | q qr q q | q qr q q | q q q q", { claps: (t, i, pos) => ([2, 6, 10].includes(pos) ? t - 0.15 : t) });
    expect(f.reasons.notes).toBe("notes right after a rest early");
  });

  it("reports one missed clap with where it was", () => {
    const f = take(QUARTERS, { claps: (t, i) => (i === 6 ? null : t) });
    expect(f.top.kind).toBe("missed");
    expect(f.top.text).toBe("You missed the clap on “3” in measure 2.");
  });

  it("asks for counts through long notes", () => {
    const source = "h q q | h h | q q h | w";
    const words = spoken(source, "notes", (w) => w.filter((x) => !(x.label === "two" && x.time === 10 + 5)));
    const f = take(source, { activity: "count-notes", claps: () => null, words });
    expect(f.top.kind).toBe("held-counts");
    expect(f.top.text).toMatch(/say “2” on “2” in measure 2/);
  });

  it("finds a lost count", () => {
    const source = QUARTERS;
    const words = spoken(source, "notes", (w) => w.map((x, i) => (i === 9 ? { ...x, word: "three", label: "three" } : x)));
    const f = take(source, { activity: "clap-count-notes", words });
    expect(f.top.kind).toBe("wrong-numbers");
    expect(f.top.text).toMatch(/You said “3” where it should be “2” \(measure 3\)/);
  });

  it("asks for silent rests when counting the notes", () => {
    const source = "q qr q q | q qr q q | q q q q | q q q q";
    const words = [...spoken(source, "notes"), { word: "two", label: "two", time: 11 }, { word: "two", label: "two", time: 15 }];
    const f = take(source, { activity: "clap-count-notes", words });
    expect(f.top.kind).toBe("silent-rests");
  });

  // ---- Stopping, starting over, coming in ----------------------------------
  const SIX = "q q h | q qr [ 8 8 ] q | h q q | q [ 8 8 ] h | q q q q | h h";

  it("finds where the student gave up", () => {
    const f = take(SIX, { claps: (t, i, pos) => (pos >= 8 ? null : t) });
    expect(f.top.kind).toBe("gave-up");
    expect(f.top.text).toMatch(/stopped clapping in measure 3/);
    expect(f.more.some((t) => t.kind === "missed")).toBe(false);
  });

  it("finds a stop and coming back in", () => {
    const f = take(SIX, { claps: (t, i, pos) => (pos >= 8 && pos < 14 ? null : t) });
    expect(f.top.kind).toBe("stopped");
    expect(f.top.text).toMatch(/stopped in measure 3 and came back in measure 4/);
  });

  it("finds starting over", () => {
    // Two measures, a measure's pause, then the line again from the start.
    const line = parseLine(SIX, "4/4");
    const again = expectedClaps(line)
      .map((c) => 10 + 12 + c.pos)
      .filter((t) => t < 10 + 24 + 1);
    const f = take(SIX, { claps: (t, i, pos) => (pos >= 8 ? null : t), extra: again });
    expect(f.top.kind).toBe("restart");
    expect(f.top.text).toMatch(/started over in measure 3/);
  });

  it("finds coming in a beat late, and staying a beat behind", () => {
    const f = take(SIX, { claps: (t) => t + 1 });
    expect(f.top.kind).toBe("late-start");
    expect(f.top.text).toMatch(/came in a beat late after the count-in/);
  });

  it("finds coming in a beat early", () => {
    const f = take(SIX, { claps: (t) => t - 1 });
    expect(f.top.kind).toBe("early-start");
  });

  it("finds a missed first note as coming in late", () => {
    const f = take(SIX, { claps: (t, i) => (i === 0 ? null : t) });
    expect(f.top.kind).toBe("late-entrance");
    expect(f.top.text).toMatch(/You came in late/);
  });

  // ---- Note lengths --------------------------------------------------------
  it("finds a clap during a long note", () => {
    const f = take("q q h | q q h | q q h | q q h", { extra: [10 + 3, 10 + 7] });
    expect(f.top.kind).toBe("held-beat-clap");
    expect(f.top.text).toMatch(/A half note gets one clap/);
    expect(f.more.some((t) => t.kind === "extra")).toBe(false);
  });

  it("finds a long note cut short", () => {
    // The note after the half note comes a beat early, inside it.
    const f = take("q q h | q q h | q q h | q q h", { claps: (t, i, pos) => (pos === 4 ? t - 1 : t) });
    expect(f.top.kind).toBe("cut-short");
    expect(f.top.text).toMatch(/cut the half note in measure 1 short/);
    expect(f.more.some((t) => t.kind === "missed" || t.kind === "extra")).toBe(false);
  });

  it("finds a clap on a tied note", () => {
    const f = take("q q h~ | q q q q | q q h~ | q q q q", { extra: [10 + 4, 10 + 12] });
    expect(f.top.kind).toBe("tie-clap");
  });

  // ---- Figures played as other figures -------------------------------------
  const where = (pos: number) => pos - Math.floor(pos);
  it("finds sixteenths played as a triplet", () => {
    const f = take("[ 16 16 16 16 ] q [ 16 16 16 16 ] q | [ 16 16 16 16 ] q q q | q q q q | q q h", {
      claps: (t, i, pos) => (where(pos) === 0.25 ? t + 1 / 12 : where(pos) === 0.5 ? t + 1 / 6 : where(pos) === 0.75 ? null : t),
    });
    expect(f.top.kind).toBe("morph");
    expect(f.top.text).toMatch(/sixteenths .* as a triplet/);
    // The figure explains those notes: no separate tip for them.
    expect(f.more.some((t) => t.kind === "figure" || t.kind === "missed" || t.kind === "timing")).toBe(false);
  });

  it("finds swung eighths", () => {
    const f = take("[ 8 8 ] q [ 8 8 ] q | [ 8 8 ] [ 8 8 ] q q | q q q q | q q h", {
      claps: (t, i, pos) => (where(pos) === 0.5 ? t + 1 / 6 : t),
    });
    expect(f.top.kind).toBe("morph");
    expect(f.top.text).toMatch(/long-short like a swing/);
  });

  it("doesn't call one late “&” a swing", () => {
    const f = take("[ 8 8 ] q [ 8 8 ] q | [ 8 8 ] [ 8 8 ] q q | q q q q | q q h", {
      claps: (t, i, pos) => (pos === 2.5 ? t + 1 / 6 : t),
    });
    expect([f.top, ...f.more].some((t) => t.kind === "morph")).toBe(false);
  });

  // ---- Counting ----------------------------------------------------------
  it("finds the wrong subdivision word, said again and again", () => {
    const source = "[ 16 16 16 16 ] q [ 16 16 16 16 ] q | [ 16 16 16 16 ] q q q | q q q q | q q h";
    const words = spoken(source, "notes", (w) => w.map((x) => (x.label === "e" ? { ...x, word: "and", label: "and" } : x)));
    const f = take(source, { activity: "count-notes", claps: () => null, words });
    expect(f.top.kind).toBe("sub-words");
    expect(f.top.text).toMatch(/You said “&” where the count is “e”/);
  });

  // ---- Hands ---------------------------------------------------------------
  const holdFrames = (move: boolean) => {
    const frames: TakeFrame[] = [];
    for (let t = 9.5; t < 26; t += 0.05) {
      const inHalf = (t - 10) % 4 >= 2 && (t - 10) % 4 < 3.8;
      const s = inHalf && move ? ((t - 10) % 4) - 2 : 0;
      frames.push({ time: t, together: inHalf || Math.abs(((t - 10) % 1) - 0.5) > 0.3, palmY: 0.5 + 0.1 * s, scale: 0.2 * (1 + 0.2 * s) });
    }
    return frames;
  };
  it("asks for the hands to push forward through long notes", () => {
    const f = take("q q h | q q h | q q h | q q h", { frames: holdFrames(false) });
    expect([f.top, ...f.more].some((t) => t.kind === "forward")).toBe(true);
  });

  it("doesn't ask when the hands move through long notes", () => {
    const f = take("q q h | q q h | q q h | q q h", { frames: holdFrames(true) });
    expect([f.top, ...f.more].some((t) => t.kind === "forward")).toBe(false);
  });

  it("asks for long notes to be held", () => {
    const frames: TakeFrame[] = [];
    for (let t = 9.5; t < 26; t += 0.05) frames.push({ time: t, together: !(t > 12.4 && t < 14) && Math.abs(((t - 10) % 1) - 0.5) > 0.3 });
    const f = take("q q h | q q h | q q h | q q h", { frames });
    expect(f.top.kind).toBe("holds");
  });
});
