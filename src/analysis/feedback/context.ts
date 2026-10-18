import { beatLength, countDisplay, countLabel, measureLength, placeNotes, PlacedNote } from "../../music/rhythm";
import { CountResult, NoteResult } from "../analyze";
import { FeedbackInput } from "./types";

// Everything the detectors share about one take: the music, what was heard,
// how to pair sounds with notes, and how to say where something happened.

export type Ctx = ReturnType<typeof makeContext>;

/** "measure 3", "measures 2 and 5", "measures 2, 4 and 6", "measures 1, 2, 3 and 3 more". */
export const measuresText = (measures: number[]) => {
  const ms = Array.from(new Set(measures)).sort((a, b) => a - b);
  if (ms.length === 1) return `measure ${ms[0]}`;
  const shown = ms.length > 4 ? [...ms.slice(0, 3).map(String), `${ms.length - 3} more`] : ms.map(String);
  return `measures ${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const makeContext = (input: FeedbackInput) => {
  const { result, line, activity } = input;
  const { notes, summary } = result;
  const counts: CountResult[] = result.counts ?? [];
  const ts = line.timeSig;
  const mLen = measureLength(ts);
  const beat = beatLength(ts);
  const secPerBeat = beat * result.secPerQ;
  const placed: PlacedNote[] = placeNotes(line);
  const measureOf = (pos: number) => Math.floor(pos / mLen + 1e-6) + 1;
  /** How the student says the spot: "2", "2&", "3e"... */
  const sayAt = (pos: number) => {
    const inM = pos - (measureOf(pos) - 1) * mLen;
    const label = countLabel(inM / beat);
    const n = Math.floor(inM / beat + 1e-4) + 1;
    if (label === "?") return `${n}`;
    if (label === "a") return `${n}uh`;
    const d = countDisplay(label);
    return /^\d+$/.test(d) ? d : `${n}${d}`;
  };
  const spot = (pos: number) => `“${sayAt(pos)}” in measure ${measureOf(pos)}`;
  const noun = activity.sing ? "note" : activity.claps ? "clap" : "count";
  const click = input.metronome ? "click" : "beat";

  // What each area is worth in the overall score (same weights as analyze.ts).
  const parts: Record<"notes" | "counts" | "hands", number> = { notes: 0, counts: 0, hands: 0 };
  if (summary.clapScore !== null) parts.notes = activity.sing ? 0.65 : 0.5;
  if (summary.countScore !== null) parts.counts = 0.35;
  if (summary.holdScore !== null) parts.hands = activity.sing ? 0.35 : 0.15;
  const total = parts.notes + parts.counts + parts.hands || 1;
  const share = (area: keyof typeof parts, lost: number, of: number) => (of ? (parts[area] / total) * Math.min(1, lost / of) : 0);
  // When counting only, notes are graded from their counts: their problems belong to counting.
  const noteArea: "notes" | "counts" = parts.notes ? "notes" : "counts";
  const noteGain = (lost: number) => (parts.notes ? share("notes", lost, notes.length) : share("counts", lost, counts.length));

  // ---- The main stream: what was clapped (or sung, or counted on each note) --
  // Detected onsets, whether or not the grader matched them to a note.
  const detected = [
    ...notes.filter((n) => n.time !== undefined && n.status !== "seen").map((n) => n.time!),
    ...result.extraClaps.map((e) => e.time),
    // (Blended syllables have no clean start to time.)
    ...(parts.notes ? [] : counts.filter((c) => c.time !== undefined && !c.blended).map((c) => c.time!)),
    ...(parts.notes ? [] : result.extraWords.map((e) => e.time)),
  ]
    .sort((a, b) => a - b)
    // (Counting only, a note's time is its count's: keep one of each.)
    .filter((t, k, all) => k === 0 || t - all[k - 1] > 0.005);
  const exp = notes.map((n) => n.expectedTime);
  // Counting only: notes on blended syllables have no sound of their own to pair.
  const skip = notes.map((n) => !parts.notes && counts.some((c) => c.blended && Math.abs(c.pos - n.pos) < 1e-6));
  const gapAt = (i: number) => Math.min(i > 0 ? exp[i] - exp[i - 1] : Infinity, i + 1 < exp.length ? exp[i + 1] - exp[i] : Infinity);
  // The grader's window: half the gap to the nearest note (plus a little), at most 0.6 beats.
  const win = exp.map((_, i) => Math.min(0.6 * secPerBeat, gapAt(i) === Infinity ? 0.6 * secPerBeat : 0.5 * gapAt(i) + 0.06));
  const x0 = result.startTime;
  const lineSec = Math.max(...exp, x0) - x0;
  const measureSec = mLen * result.secPerQ;
  /** Time (s) of a position, and position of a time, on the written grid. */
  const timeOf = (pos: number) => x0 + pos * result.secPerQ;
  const posOf = (time: number) => (time - x0) / result.secPerQ;

  // Runs: notes in a row with no rest (or long note) between them. Students
  // often speed up through a run and find the beat again at the rest.
  const runStarts = notes
    .map((n, i) =>
      i === 0 ||
      notes[i - 1].len >= 2 * beat - 1e-6 ||
      placed.some((p) => p.note.rest && p.pos > notes[i - 1].pos - 1e-6 && p.pos < n.pos - 1e-6)
        ? exp[i] - x0
        : null,
    )
    .filter((x): x is number => x !== null);
  /** When the run holding time x (seconds into the line) started. */
  const runStartAt = (x: number) => {
    let s = runStarts[0] ?? 0;
    for (const r of runStarts) if (r <= x + 1e-6) s = r;
    return s;
  };
  /** Positions of notes tied to the note before (held, never clapped). */
  const tiedAt: number[] = [];
  placed.forEach((p, k) => {
    const prev = placed[k - 1];
    if (prev && !prev.note.rest && prev.note.tie && !p.note.rest) tiedAt.push(p.pos);
  });

  /** Pairs each note with the sound nearest where `at` says it should be: in order, each sound used once. */
  const pair = (at: (i: number) => number): (number | null)[] => {
    const out: (number | null)[] = [];
    let last = -1;
    exp.forEach((_, i) => {
      if (skip[i]) return out.push(null);
      const t = at(i);
      let j = -1;
      for (let k = last + 1; k < detected.length && detected[k] <= t + win[i]; k++) {
        if (Math.abs(detected[k] - t) <= win[i] && (j < 0 || Math.abs(detected[k] - t) < Math.abs(detected[j] - t))) j = k;
      }
      out.push(j >= 0 ? j : null);
      if (j >= 0) last = j;
    });
    return out;
  };
  const unpaired = (p: (number | null)[], from = 0, to = exp.length) =>
    p.slice(from, to).filter((j, i) => j === null && !skip[from + i]).length;

  /** What earlier evidence already explains (see Evidence.claims). */
  const claimed = new Set<string>();

  return {
    input,
    result,
    line,
    activity,
    notes: notes as NoteResult[],
    counts,
    summary,
    ts,
    mLen,
    beat,
    secPerBeat,
    placed,
    measureOf,
    sayAt,
    spot,
    noun,
    click,
    parts,
    share,
    noteArea,
    noteGain,
    detected,
    exp,
    skip,
    win,
    x0,
    lineSec,
    measureSec,
    timeOf,
    posOf,
    runStarts,
    runStartAt,
    tiedAt,
    pair,
    unpaired,
    claimed,
  };
};
