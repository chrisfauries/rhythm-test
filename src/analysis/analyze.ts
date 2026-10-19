import { Activity, activityInfo } from "../music/activity";
import { beatLength, countDisplay, expectedClaps, expectedCounts, Line, lineLength, placeNotes, pulseLength } from "../music/rhythm";

// Grades one performance of a line, depending on what the student does
// (see music/activity.ts): claps (audio, with video as backup), spoken counts
// (speech), sung notes (voicing), and hand motions (video): hands held
// together through long notes and a silent downward pulse on each rest beat.
// All times here are already latency-corrected and in the audible-clock
// domain, so "0 offset" means exactly on the metronome.

export type Strictness = "lenient" | "normal" | "strict";

const ON_TIME_TOLERANCE: Record<Strictness, number> = {
  lenient: 0.1,
  normal: 0.07,
  strict: 0.045,
};

export interface TakeWord {
  word: string;
  label: string | null;
  time: number;
}

export interface TakeFrame {
  time: number;
  together: boolean | null;
  /** Mean palm height (fraction of frame height, larger = lower), when hands are visible. */
  palmY?: number | null;
  /** Hand length as a fraction of frame height, to scale movements. */
  scale?: number | null;
}

export interface TakeInput {
  line: Line;
  /** Beats per minute, where a beat is the time signature's bottom number. */
  bpm: number;
  /** Audible time of the start of the line (beat 1 of measure 1). */
  startTime: number;
  activity: Activity;
  strictness: Strictness;
  claps: number[];
  words: TakeWord[] | null;
  frames: TakeFrame[] | null;
  /**
   * Vowel onset of the voice near a time, or null if nobody was voicing.
   * Credits counts said on a clap beat, whose words the clap's room echo hides.
   */
  voiceOnsetNear?: (time: number) => number | null;
  /**
   * The count-word model's view of a count (see ml/countModel.ts): which word
   * it heard near a time. Used only where the clap hid the word from speech
   * recognition.
   */
  countModelAt?: (time: number) => { label: string; probs: Record<string, number> } | null;
  countModelRule?: { confirmAbove: number; wrongAbove: number; expectedBelow: number };
  /** Singing: onsets of the sung syllables. */
  sungOnsets?: number[];
  /** Spans where the voice sounds: sustain of sung notes, and counts blended into one word. */
  voicedSpans?: [number, number][];
}

export type ClapStatus = "on-time" | "early" | "late" | "missed" | "seen";
export type HoldStatus = "held" | "released" | "unknown";
export type CountStatus = "correct" | "early" | "late" | "wrong" | "missed";
export type RestStatus = "pulsed" | "missed" | "unknown";

export interface NoteResult {
  id: number;
  measure: number;
  index: number;
  /** Position in q-units from the start of the line. */
  pos: number;
  len: number;
  expectedTime: number;
  status: ClapStatus;
  /** Clap time (audio, or video for "seen"). */
  time?: number;
  offsetMs?: number;
  hold?: {
    status: HoldStatus;
    fraction: number;
    until?: number;
    /**
     * Clapping: how far the hands travelled during the note (for "push them
     * forward"; not scored). Palm height change in hand lengths, and hand size
     * change as a fraction (bigger = toward the camera).
     */
    motion?: { dy: number; ds: number };
  };
}

export interface CountResult {
  id: number;
  pos: number;
  label: string;
  expectedTime: number;
  status: CountStatus;
  heard?: string;
  time?: number;
  offsetMs?: number;
  /** Graded on timing only: a clap on the same beat hid which word it was. */
  unclear?: boolean;
  /** The word was judged by the count-word model, with this confidence. */
  model?: { label: string; conf: number };
  /**
   * Said inside a fast run of counts blended into one word ("one-e-and-a"), or
   * a beat a long note is held through ("ooone-two"): its syllable has no clean
   * start, so only that the voice carried through it counted.
   */
  blended?: boolean;
}

/** A beat inside a rest, where the student should make a silent pulse. */
export interface RestResult {
  id: number;
  measure: number;
  index: number;
  pos: number;
  expectedTime: number;
  status: RestStatus;
  /** When the hands reached the bottom of the pulse. */
  time?: number;
}

export interface ExtraEvent {
  time: number;
  pos: number;
  text?: string;
}

export interface TakeSummary {
  /** Notes: claps, or sung notes. Null when the notes are only counted. */
  clapScore: number | null;
  countScore: number | null;
  /** Hand motions (holds and rest pulses), or how well sung notes were sustained. */
  holdScore: number | null;
  overall: number;
  /** Mean signed clap offset (ms) of matched claps; negative = rushing. */
  meanOffsetMs: number | null;
  tendency: "rushing" | "dragging" | "steady" | null;
}

export interface TakeResult {
  activity: Activity;
  notes: NoteResult[];
  counts: CountResult[] | null;
  /** Rest pulses (null when not graded: no clapping, or no camera). */
  rests: RestResult[] | null;
  extraClaps: ExtraEvent[];
  extraWords: ExtraEvent[];
  summary: TakeSummary;
  /** Seconds per quarter note, for converting positions to times. */
  secPerQ: number;
  startTime: number;
}

/**
 * Monotonic alignment of expected events to detected events (both sorted).
 * Returns, for each expected index, the matched detected index or null.
 */
export const align = (
  expected: number[],
  detected: number[],
  windows: number[],
  mismatchCost: (i: number, j: number) => number = () => 0,
): (number | null)[] => {
  const n = expected.length;
  const m = detected.length;
  const SKIP = 1;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  const move: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i][j];
      if (c === Infinity) continue;
      if (i < n && c + SKIP < cost[i + 1][j]) {
        cost[i + 1][j] = c + SKIP;
        move[i + 1][j] = 1; // expected missed
      }
      if (j < m && c + SKIP < cost[i][j + 1]) {
        cost[i][j + 1] = c + SKIP;
        move[i][j + 1] = 2; // extra detection
      }
      if (i < n && j < m) {
        const dt = Math.abs(detected[j] - expected[i]);
        if (dt <= windows[i]) {
          const mc = c + 0.9 * (dt / windows[i]) ** 2 + mismatchCost(i, j);
          if (mc < cost[i + 1][j + 1]) {
            cost[i + 1][j + 1] = mc;
            move[i + 1][j + 1] = 3;
          }
        }
      }
    }
  }
  const out: (number | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const mv = move[i][j];
    if (mv === 3) {
      out[i - 1] = j - 1;
      i--;
      j--;
    } else if (mv === 1) i--;
    else j--;
  }
  return out;
};

const gapWindows = (times: number[], base: number, cap: number) =>
  times.map((t, i) => {
    const prev = i > 0 ? t - times[i - 1] : Infinity;
    const next = i < times.length - 1 ? times[i + 1] - t : Infinity;
    const gap = Math.min(prev, next);
    return Math.min(cap, gap === Infinity ? cap : 0.5 * gap + base);
  });

/**
 * Counts this close together are said as one connected word by musicians
 * ("oneanna"): their syllables run into each other with no clean starts, so
 * they aren't timed one by one. A 16th at 75 bpm is 0.2 s.
 */
const BLEND_GAP = 0.2;

/**
 * Subdivision words. Which one was said is graded on timing only when another
 * of them is heard in its place: in connected counting "& a" sounds like
 * "an-na", and on held-out real takes the audio model got "a" right 1 time
 * in 15 and "e" 13 in 23. The numbers carry where the student is in the bar.
 */
/** A number this soon after a subdivision can merge with it into one syllable ("a-two"). */
const MERGE_GAP = 0.3;

export const SUBDIVISIONS = new Set(["e", "and", "a", "la", "li"]);

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Rest pulses: palms drop at least this far (in hand lengths) below their usual height. */
const PULSE_DEPTH = 0.8;

/** Hands that drop out of view for this long while moving down made a pulse (off the bottom of the frame). */
const PULSE_DROPOUT = 0.18;

/**
 * Times of downward hand pulses (silent claps on rests). Two signs:
 *   - the palms dip well below their usual height (lowest point), or
 *   - the palms were moving down and then left the camera's view for a while
 *     (students sitting low in the frame pulse right off the bottom edge).
 * Claps also lose the hands briefly (blur, overlap), but only for a frame or
 * two and without the downward motion.
 */
export const findPulses = (frames: TakeFrame[]): number[] => {
  const seen = frames.filter((f) => f.palmY != null && f.scale != null);
  const y0 = median(seen.map((f) => f.palmY!));
  const scale = median(seen.map((f) => f.scale!));
  if (y0 === null || scale === null || scale <= 0) return [];
  const depth = (f: TakeFrame) => (f.palmY! - y0) / scale;
  const pulses = seen
    .filter((f, i) => depth(f) >= PULSE_DEPTH && f.palmY! >= (seen[i - 1]?.palmY ?? -1) && f.palmY! >= (seen[i + 1]?.palmY ?? -1))
    .map((f) => f.time);

  let i = 0;
  while (i < frames.length) {
    if (frames[i].palmY != null) {
      i++;
      continue;
    }
    let j = i;
    while (j < frames.length && frames[j].palmY == null) j++;
    const before = frames
      .slice(0, i)
      .filter((f) => f.palmY != null)
      .slice(-3);
    const last = before[before.length - 1];
    const goneFrom = last?.time ?? frames[i].time;
    const goneUntil = j < frames.length ? frames[j].time : frames[frames.length - 1].time;
    const movingDown = before.length >= 2 && depth(last) - depth(before[0]) > 0.15 && frames[i].time - last.time < 0.15;
    if (movingDown && goneUntil - goneFrom >= PULSE_DROPOUT) {
      const mid = (goneFrom + goneUntil) / 2;
      if (!pulses.some((t) => Math.abs(t - mid) < 0.25)) pulses.push(mid);
    }
    i = j;
  }
  return pulses.sort((a, b) => a - b);
};

export const analyzeTake = (input: TakeInput): TakeResult => {
  const { line, bpm, startTime, strictness } = input;
  const info = activityInfo(input.activity);
  const secPerBeat = 60 / bpm;
  const secPerQ = secPerBeat / beatLength(line.timeSig);
  const beat = beatLength(line.timeSig);
  // Rest pulses and holds go by the felt beat: a dotted quarter in 6/8.
  const felt = pulseLength(line.timeSig);
  const toTime = (pos: number) => startTime + pos * secPerQ;
  const toPos = (time: number) => (time - startTime) / secPerQ;
  const lineEnd = toTime(lineLength(line));
  const inLine = (t: number) => t > startTime - secPerBeat * 0.6 && t < lineEnd + secPerBeat * 0.4;
  const baseTol = ON_TIME_TOLERANCE[strictness];
  const speechTol = Math.max(0.12, 2 * baseTol);

  // ---- Notes: clapped or sung -------------------------------------------
  const expected = expectedClaps(line);
  const expTimes = expected.map((c) => toTime(c.pos));
  const onsets = (info.sing ? (input.sungOnsets ?? []) : info.claps ? input.claps : []).filter(inLine).sort((a, b) => a - b);
  const windows = gapWindows(expTimes, 0.06, secPerBeat * 0.6);
  const matched = align(expTimes, onsets, windows);
  const noteTol = info.sing ? speechTol : baseTol;

  // Video "contact" moments (hands come together) as a backup for soft claps.
  const contacts: number[] = [];
  if (input.frames && info.claps) {
    let prev: boolean | null = null;
    for (const f of input.frames) {
      if (f.together === true && prev !== true) contacts.push(f.time);
      if (f.together !== null) prev = f.together;
    }
  }

  const notes: NoteResult[] = expected.map((c, i) => {
    const expectedTime = expTimes[i];
    const gap = Math.min(
      i > 0 ? expectedTime - expTimes[i - 1] : Infinity,
      i < expTimes.length - 1 ? expTimes[i + 1] - expectedTime : Infinity,
    );
    const tol = Math.min(noteTol, 0.3 * gap);
    const base = { id: c.id, measure: c.measure, index: c.index, pos: c.pos, len: c.len, expectedTime };
    const j = matched[i];
    if (j !== null) {
      const offset = onsets[j] - expectedTime;
      const status: ClapStatus = Math.abs(offset) <= tol ? "on-time" : offset < 0 ? "early" : "late";
      return { ...base, status, time: onsets[j], offsetMs: Math.round(offset * 1000) };
    }
    const seen = contacts.find((t) => Math.abs(t - expectedTime) <= windows[i] && !onsets.some((a) => Math.abs(a - t) < 0.12));
    if (seen !== undefined) {
      return { ...base, status: "seen", time: seen, offsetMs: Math.round((seen - expectedTime) * 1000) };
    }
    return { ...base, status: "missed" };
  });

  // ---- Holds (clapping: hands stay together through any note longer than a beat, dotted quarters too; in 6/8, longer than a dotted quarter) ---
  if (input.frames && info.claps) {
    for (const note of notes) {
      if (note.len <= felt + 1e-6) continue;
      const from = note.expectedTime + 0.2 * secPerBeat;
      const to = note.expectedTime + note.len * secPerQ - 0.3 * secPerBeat;
      const known = input.frames.filter((f) => f.time >= from && f.time <= to && f.together !== null);
      if (known.length < 3) {
        note.hold = { status: "unknown", fraction: 0 };
        continue;
      }
      const together = known.filter((f) => f.together).length;
      const fraction = together / known.length;
      const firstApart = known.find((f) => !f.together)?.time;
      note.hold = {
        status: fraction >= 0.7 ? "held" : "released",
        fraction,
        until: fraction >= 0.7 ? undefined : firstApart,
      };
      // Travel while together, from where the hands met.
      const tracked = known.filter((f) => f.together && f.palmY != null && f.scale);
      if (tracked.length >= 3) {
        const y0 = tracked[0].palmY!;
        const s0 = tracked[0].scale!;
        note.hold.motion = {
          dy: Math.max(...tracked.map((f) => Math.abs(f.palmY! - y0))) / s0,
          ds: Math.max(...tracked.map((f) => Math.abs(f.scale! - s0))) / s0,
        };
      }
    }
  }

  // ---- Sustain (singing: the voice lasts through each note of 1+ beats) --
  const voiced = input.voicedSpans ?? [];
  const voicedIn = (a: number, b: number) =>
    voiced.reduce((sum, [s, e]) => sum + Math.max(0, Math.min(b, e) - Math.max(a, s)), 0) / (b - a);
  // (Without voicing information there's nothing to judge sustain by.)
  if (info.sing && input.voicedSpans) {
    for (const note of notes) {
      if (note.len < beat - 1e-6) continue;
      // Leave room for the next "Da" (its consonant briefly stops the voice).
      const from = note.expectedTime + 0.25 * secPerBeat;
      const to = note.expectedTime + note.len * secPerQ - 0.25 * secPerBeat;
      if (to - from < 0.1) continue;
      const fraction = Math.min(1, voicedIn(from, to));
      note.hold = { status: fraction >= 0.7 ? "held" : "released", fraction };
      if (fraction < 0.7) {
        const span = voiced.find(([s, e]) => s <= from + 0.05 && e > from);
        note.hold.until = span ? span[1] : from;
      }
    }
  }

  // ---- Rest pulses (clapping, with the camera) --------------------------
  let rests: RestResult[] | null = null;
  const tracked = input.frames?.filter((f) => f.palmY != null) ?? [];
  if (info.claps && tracked.length) {
    const pulses = findPulses(input.frames!);
    const used = new Set<number>();
    const list: RestResult[] = [];
    for (const p of placeNotes(line)) {
      // Every rest gets a pulse, however short (an eighth rest too), and a
      // rest longer than a beat one on each of its beats (each dotted quarter in 6/8).
      if (!p.note.rest) continue;
      for (let k = 0; k === 0 || k * felt < p.len - 1e-6; k++) {
        const pos = p.pos + k * felt;
        const t = toTime(pos);
        // Look for it while the rest (this beat of it) lasts: at least 0.15 s, at most 0.3 s.
        const lasts = Math.min(felt, p.len - k * felt) * secPerQ;
        const until = t + Math.min(0.3, Math.max(0.15, lasts));
        const base = { id: list.length, measure: p.measure, index: p.index, pos, expectedTime: t };
        const pulse = pulses.find((x) => x >= t - 0.15 && x <= until && !used.has(x));
        if (pulse !== undefined) used.add(pulse);
        if (pulse !== undefined) list.push({ ...base, status: "pulsed", time: pulse });
        else if (tracked.some((f) => f.time >= t - 0.3 && f.time <= t + 0.4)) list.push({ ...base, status: "missed" });
        else list.push({ ...base, status: "unknown" });
      }
    }
    rests = list;
  }

  const matchedSet = new Set(matched.filter((j): j is number => j !== null));
  const extraClaps: ExtraEvent[] = onsets
    .filter((_, j) => !matchedSet.has(j))
    .map((time) => ({ time, pos: toPos(time), text: info.sing ? "Extra note sung" : undefined }));

  // ---- Spoken counts -----------------------------------------------------
  let counts: CountResult[] | null = null;
  const extraWords: ExtraEvent[] = [];
  if (info.countMode && input.words) {
    const expCounts = expectedCounts(line, info.countMode);
    const cTimes = expCounts.map((c) => toTime(c.pos));
    const words = input.words.filter((w) => inLine(w.time)).sort((a, b) => a.time - b.time);
    const wTimes = words.map((w) => w.time);
    const cWindows = gapWindows(cTimes, 0.15, secPerBeat * 0.75);
    const wordMatch = align(cTimes, wTimes, cWindows, (i, j) => (words[j].label === expCounts[i].label ? 0 : 0.8));
    const clapPositions = info.claps ? expected.map((c) => c.pos) : [];
    const voicedAt = (t: number) => voiced.some(([s, e]) => s <= t && t <= e);
    // In a fast run (the count before it is close), with the voice carrying on.
    const heldBeat = (pos: number) => expected.some((n) => pos > n.pos + 1e-6 && pos < n.pos + n.len - 1e-6);
    const blendedRun = (i: number) => i > 0 && cTimes[i] - cTimes[i - 1] < BLEND_GAP && voicedAt(cTimes[i]);
    counts = expCounts.map((c, i) => {
      const expectedTime = cTimes[i];
      const base = { id: c.id, pos: c.pos, label: c.label, expectedTime };
      const gap = Math.min(
        i > 0 ? expectedTime - cTimes[i - 1] : Infinity,
        i < cTimes.length - 1 ? cTimes[i + 1] - expectedTime : Infinity,
      );
      const tol = Math.min(speechTol, 0.45 * gap);
      const timing = (offset: number): CountStatus => (Math.abs(offset) <= tol ? "correct" : offset < 0 ? "early" : "late");
      const j = wordMatch[i];
      const sub = SUBDIVISIONS.has(c.label);
      // A beat a long note is held through: the voice carries on into it ("ooone-two").
      if (j === null && heldBeat(c.pos) && voicedAt(expectedTime - 0.03) && voicedAt(expectedTime + 0.03)) {
        return { ...base, status: "correct" as const, unclear: true, blended: true };
      }
      if (j === null && blendedRun(i)) {
        // Blended into its neighbor: "a-three" is often one onset. Credit it
        // if a word was heard there (any word for a subdivision, near its own
        // time for a number).
        const near = words.find((w) => Math.abs(w.time - expectedTime) <= (sub ? 2 * gap : cWindows[i]));
        if (near) return { ...base, status: "correct" as const, unclear: true, blended: true };
      }
      if (j === null) {
        // On a clap beat the clap's room echo hides the word, but the voice
        // still shows: grade when it started.
        const onClap = clapPositions.some((p) => Math.abs(p - c.pos) < 1e-6);
        const t = onClap && input.voiceOnsetNear ? input.voiceOnsetNear(expectedTime) : null;
        if (t !== null && Math.abs(t - expectedTime) <= cWindows[i]) {
          const offset = t - expectedTime;
          const timed = { ...base, time: t, offsetMs: Math.round(offset * 1000) };
          const pred = input.countModelAt?.(expectedTime) ?? null;
          const rule = input.countModelRule;
          if (pred && rule && c.label in pred.probs) {
            const pe = pred.probs[c.label];
            const [topLabel, topP] = Object.entries(pred.probs).sort((a, b) => b[1] - a[1])[0];
            if (topLabel === c.label || pe >= rule.confirmAbove) {
              return { ...timed, status: timing(offset), heard: c.label, model: { label: c.label, conf: pe } };
            }
            if (topLabel !== "none" && topP >= rule.wrongAbove && pe < rule.expectedBelow) {
              return { ...timed, status: "wrong" as const, heard: topLabel, model: { label: topLabel, conf: topP } };
            }
          }
          return { ...timed, status: timing(offset), unclear: true };
        }
        return { ...base, status: "missed" as const };
      }
      const w = words[j];
      const offset = w.time - expectedTime;
      const heard = { ...base, heard: w.label ?? w.word, time: w.time, offsetMs: Math.round(offset * 1000) };
      const swapped = w.label !== c.label;
      const heardSub = w.label !== null && SUBDIVISIONS.has(w.label);
      // "a-two" said as one word: the number's onset often takes the subdivision's label.
      const merged = !sub && heardSub && i > 0 && SUBDIVISIONS.has(expCounts[i - 1].label) && gap < MERGE_GAP;
      if (swapped && !(sub && heardSub) && !merged) return { ...heard, status: "wrong" as const };
      // A subdivision inside a blended run has no clean start to time.
      const blended = sub && blendedRun(i);
      const status = blended ? ("correct" as const) : timing(offset);
      return { ...heard, status, ...(swapped ? { unclear: true } : {}), ...(blended ? { blended: true } : {}) };
    });
    const used = new Set(wordMatch.filter((j): j is number => j !== null));
    // A blended run often shows a syllable twice; extra subdivisions inside one aren't mistakes.
    const inRun = (t: number) => cTimes.some((ct, i) => blendedRun(i) && Math.abs(t - ct) < BLEND_GAP);
    words.forEach((w, j) => {
      if (used.has(j) || (w.label !== null && SUBDIVISIONS.has(w.label) && inRun(w.time))) return;
      extraWords.push({ time: w.time, pos: toPos(w.time), text: w.label ? countDisplay(w.label) : w.word });
    });
  }

  // Counting only: each note is graded by the count said at its start.
  if (!info.claps && !info.sing && counts) {
    const graded = counts;
    notes.forEach((n) => {
      const c = graded.find((x) => Math.abs(x.pos - n.pos) < 1e-6);
      if (!c || c.status === "wrong" || c.status === "missed") return;
      if (c.time === undefined) {
        // Blended into the counts around it: said, but with no start of its own.
        if (c.blended) n.status = "on-time";
        return;
      }
      n.status = c.status === "correct" ? "on-time" : c.status;
      n.time = c.time;
      n.offsetMs = c.offsetMs;
    });
  }

  // ---- Summary -------------------------------------------------------------
  const CLAP_CREDIT: Record<ClapStatus, number> = { "on-time": 1, early: 0.5, late: 0.5, seen: 0.75, missed: 0 };
  const COUNT_CREDIT: Record<CountStatus, number> = { correct: 1, early: 0.5, late: 0.5, wrong: 0, missed: 0 };
  const extraPenalty = Math.min(extraClaps.length * 0.5, notes.length);
  const clapScore =
    info.claps || info.sing
      ? notes.length
        ? Math.max(0, notes.reduce((a, n) => a + CLAP_CREDIT[n.status], 0) - extraPenalty) / notes.length
        : 1
      : null;
  const countScore =
    counts && counts.length
      ? Math.max(0, counts.reduce((a, c) => a + COUNT_CREDIT[c.status], 0) - Math.min(extraWords.length * 0.5, counts.length)) /
        counts.length
      : null;
  const holds = notes.filter((n) => n.hold && n.hold.status !== "unknown");
  const knownRests = rests?.filter((r) => r.status !== "unknown") ?? [];
  const motions = holds.length + knownRests.length;
  const holdScore = motions
    ? (holds.filter((n) => n.hold!.status === "held").length + knownRests.filter((r) => r.status === "pulsed").length) / motions
    : null;

  const parts: [number, number][] = [];
  if (clapScore !== null) parts.push([clapScore, info.sing ? 0.65 : 0.5]);
  if (countScore !== null) parts.push([countScore, 0.35]);
  if (holdScore !== null) parts.push([holdScore, info.sing ? 0.35 : 0.15]);
  const weight = parts.reduce((a, [, w]) => a + w, 0);
  const overall = weight ? parts.reduce((a, [s, w]) => a + s * w, 0) / weight : 0;

  const offsets = notes.filter((n) => n.offsetMs !== undefined && n.status !== "seen").map((n) => n.offsetMs!);
  const meanOffsetMs = offsets.length ? Math.round(offsets.reduce((a, b) => a + b, 0) / offsets.length) : null;
  const tendency = meanOffsetMs === null ? null : meanOffsetMs < -25 ? "rushing" : meanOffsetMs > 25 ? "dragging" : "steady";

  return {
    activity: info.id,
    notes,
    counts,
    rests,
    extraClaps,
    extraWords,
    summary: { clapScore, countScore, holdScore, overall, meanOffsetMs, tendency },
    secPerQ,
    startTime,
  };
};

// ---- Calibration ------------------------------------------------------------

export interface CalibrationResult {
  micOffset: number | null;
  speechOffset: number | null;
  videoOffset: number | null;
  claps: number;
  words: number;
  contacts: number;
}

/**
 * Given the audible times of the beats the student clapped and counted along
 * with, measure how late each sensor reports events. Uses medians so a stray
 * clap or word doesn't skew the result.
 */
export const calibrate = (
  beatTimes: number[],
  rawClaps: number[],
  rawWords: TakeWord[],
  rawFrames: TakeFrame[] | null,
): CalibrationResult => {
  const nearestOffsets = (events: number[], lo: number, hi: number) =>
    beatTimes
      .map((b) => {
        const cand = events.filter((t) => t - b >= lo && t - b <= hi);
        if (!cand.length) return null;
        return cand.reduce((best, t) => (Math.abs(t - b) < Math.abs(best - b) ? t : best)) - b;
      })
      .filter((x): x is number => x !== null);

  // Windows are wide (but narrower than a beat) because uncalibrated delays,
  // e.g. with Bluetooth headphones, can be a few hundred ms.
  const clapOffsets = nearestOffsets(rawClaps, -0.15, 0.45);
  const wordOffsets = nearestOffsets(
    rawWords.filter((w) => w.label !== null).map((w) => w.time),
    -0.2,
    0.45,
  );
  const contacts: number[] = [];
  if (rawFrames) {
    let prev: boolean | null = null;
    for (const f of rawFrames) {
      if (f.together === true && prev !== true) contacts.push(f.time);
      if (f.together !== null) prev = f.together;
    }
  }
  const contactOffsets = nearestOffsets(contacts, -0.25, 0.45);
  const enough = (xs: number[]) => (xs.length >= Math.max(3, beatTimes.length / 3) ? median(xs) : null);
  return {
    micOffset: enough(clapOffsets),
    speechOffset: enough(wordOffsets),
    videoOffset: enough(contactOffsets),
    claps: clapOffsets.length,
    words: wordOffsets.length,
    contacts: contactOffsets.length,
  };
};
