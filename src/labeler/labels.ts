import { beatLength, parseLine, placeNotes } from "../music/rhythm";

// Labels for one capture: what really happened, as events on audio.wav's
// timeline. Saved as <capture>.labels.json next to the zip; ml/dataset.js
// reads them in place of the "performed as written" assumption.

export type EventType = "clap" | "count" | "pulse";

export interface LabelEvent {
  id: number;
  type: EventType;
  /** Seconds into audio.wav. */
  t: number;
  /** Count word ("one", "and", "e", "a", ... or "?" when unsure). */
  label?: string;
  /** Who put it there: the app's detectors, the count model, or a person. */
  source: "app" | "model" | "human";
}

export interface ExpectedCount {
  pos: number;
  label: string;
  /** Where an on-time count's vowel would start (seconds into audio.wav). */
  t: number;
}

export interface LabelsFile {
  format: "rhythm-tester-labels";
  version: 1;
  take: string;
  savedAt: string;
  events: LabelEvent[];
  /** Per expected count: the word labeled there, or null if nothing was said. */
  counts: { pos: number; label: string | null; t: number | null }[];
}

export const COUNT_KEYS: Record<string, string> = {
  "1": "one",
  "2": "two",
  "3": "three",
  "4": "four",
  "5": "five",
  "6": "six",
  "7": "seven",
  "8": "eight",
  "9": "nine",
  n: "and",
  e: "e",
  a: "a",
  u: "a",
  t: "trip",
  l: "let",
  "?": "?",
};

/** Take details the labeler needs, from diagnostics.json (any capture or debug bundle). */
export const takeInfo = (diag: any) => {
  const t0: number = diag.wavStartCtx;
  const mic: number = diag.offsets.mic;
  const speech: number = diag.offsets.speech ?? mic + 0.02;
  const video: number = diag.offsets.video ?? 0;
  const heard = (t: number) => t + mic - t0;
  const spoken = (t: number) => t + speech - t0;
  const notes: { pos: number; t: number; len: number }[] = diag.grader.notes.map((n: any) => ({
    pos: n.pos,
    len: n.len,
    t: heard(n.expectedTime),
  }));
  const counts: ExpectedCount[] = (diag.grader.counts ?? []).map((c: any) => ({ pos: c.pos, label: c.label, t: spoken(c.expectedTime) }));
  // Rest pulses from the notation: one at the start of every rest, and one on
  // each later beat of a long rest (the teaching convention; see TODO.md).
  const line = parseLine(diag.exercise.source, diag.exercise.timeSig);
  const beat = beatLength(line.timeSig);
  const secPerQ = diag.timing.secPerBeat / beat;
  const lineStart: number = diag.timing.lineStartWav;
  const rests: { pos: number; t: number }[] = [];
  for (const p of placeNotes(line)) {
    if (!p.note.rest) continue;
    rests.push({ pos: p.pos, t: lineStart + p.pos * secPerQ });
    for (let b = Math.floor(p.pos / beat + 1e-6) + 1; b * beat < p.pos + p.len - 1e-6; b++) {
      rests.push({ pos: b * beat, t: lineStart + b * beat * secPerQ });
    }
  }
  return {
    heard,
    spoken,
    fromVideo: (t: number) => t + video + mic - t0,
    notes,
    counts,
    rests,
    beats: (diag.clicks as { wav: number }[]).map((c) => c.wav),
    lineStart: diag.timing.lineStartWav as number,
    secPerBeat: diag.timing.secPerBeat as number,
    beatsPerMeasure: diag.timing.beatsPerMeasure as number,
    countInBeats: diag.timing.countInBeats as number,
  };
};

export type TakeInfo = ReturnType<typeof takeInfo>;

/** Starting labels: what the app (and the count model, if it ran) detected. */
export const prefill = (diag: any, info: TakeInfo): LabelEvent[] => {
  const events: LabelEvent[] = [];
  let id = 1;
  for (const c of diag.candidates ?? []) {
    if (c.isClap && !c.gated) events.push({ id: id++, type: "clap", t: c.wav, source: "app" });
  }
  for (const c of diag.grader.counts ?? []) {
    if (c.time === undefined || c.time === null) continue;
    const label = c.heard ?? (c.unclear ? "?" : undefined);
    events.push({ id: id++, type: "count", t: info.spoken(c.time), label, source: c.model ? "model" : "app" });
  }
  for (const w of diag.grader.extraWords ?? []) {
    events.push({ id: id++, type: "count", t: info.spoken(w.time), label: w.text ?? "?", source: "app" });
  }
  for (const r of diag.grader.rests ?? []) {
    if (r.status === "pulsed" && r.time != null) events.push({ id: id++, type: "pulse", t: info.fromVideo(r.time), source: "app" });
  }
  return events.sort((a, b) => a.t - b.t);
};

/** Assign each expected count the labeled word nearest to it (within half the gap to its neighbors). */
export const countsFromEvents = (events: LabelEvent[], info: TakeInfo) => {
  const words = events.filter((e) => e.type === "count");
  const used = new Set<number>();
  return info.counts.map((c, i) => {
    const prev = i > 0 ? info.counts[i - 1].t : -Infinity;
    const next = i < info.counts.length - 1 ? info.counts[i + 1].t : Infinity;
    const lo = Math.max(c.t - 0.35, (prev + c.t) / 2);
    const hi = Math.min(c.t + 0.45, (c.t + next) / 2);
    const cand = words.filter((w) => !used.has(w.id) && w.t >= lo && w.t < hi).sort((a, b) => Math.abs(a.t - c.t) - Math.abs(b.t - c.t))[0];
    if (!cand) return { pos: c.pos, label: null, t: null };
    used.add(cand.id);
    return { pos: c.pos, label: cand.label ?? "?", t: cand.t };
  });
};

export const labelsFile = (take: string, events: LabelEvent[], info: TakeInfo): LabelsFile => ({
  format: "rhythm-tester-labels",
  version: 1,
  take,
  savedAt: new Date().toISOString(),
  events: [...events].sort((a, b) => a.t - b.t),
  counts: countsFromEvents(events, info),
});
