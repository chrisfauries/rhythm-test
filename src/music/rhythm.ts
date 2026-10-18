// Core rhythm model: parsing a compact text notation into measures of notes,
// and deriving the expected claps / spoken counts for a line.
//
// Notation (one token per note, measures separated by "|"):
//   w h q 8 16 32     whole, half, quarter, eighth, sixteenth, 32nd
//   suffix "."        dotted (".." double dotted)   e.g.  q.  h.  8.
//   suffix "r"        rest                          e.g.  qr  8r  q.r
//   suffix "~"        tied to the next note         e.g.  h~ | q
//   mr                full-measure rest (any meter)
//   3( ... )          triplet: three notes in the time of two  e.g. 3( 8 8 8 )
//   [ ... ]           beamed group (8ths and shorter, rests allowed inside) e.g. [ 8 8 8 8 ]
//                     When a line has no brackets, notes are beamed automatically by beat;
//                     when it has any, only bracketed notes are beamed (others get flags).
// Example: "q q qr q | h. q | [ 8 8 ] q [ 3( 8 8 8 ) ] q"
//
// All positions/durations are measured in quarter notes ("q-units").

export type BaseDuration = "w" | "h" | "q" | "8" | "16" | "32";

export interface Tuplet {
  /** Shared by all notes in the same tuplet group within a line. */
  id: number;
  /** n notes in the time of `occupied`. */
  notes: number;
  occupied: number;
}

export interface RhythmNote {
  base: BaseDuration;
  dots: number;
  rest: boolean;
  /** This note is tied to the following note (no new clap on the next note). */
  tie: boolean;
  /** A whole-measure rest; its length is the measure length. */
  measureRest?: boolean;
  tuplet?: Tuplet;
  /** Beam group id (shared by the notes of one beamed group within a line). */
  beam?: number;
}

export interface TimeSignature {
  num: number;
  den: number;
}

export interface Line {
  timeSig: TimeSignature;
  measures: RhythmNote[][];
  /** Beams are written out with [ ] (as in the book), rather than drawn automatically by beat. */
  explicitBeams?: boolean;
}

const BASE_Q: Record<BaseDuration, number> = {
  w: 4,
  h: 2,
  q: 1,
  "8": 0.5,
  "16": 0.25,
  "32": 0.125,
};

const EPS = 1e-6;

export const measureLength = (ts: TimeSignature) => (ts.num * 4) / ts.den;

/** Length of one counted beat in q-units (the time signature's bottom number). */
export const beatLength = (ts: TimeSignature) => 4 / ts.den;

export const noteLength = (n: RhythmNote, ts: TimeSignature) => {
  if (n.measureRest) return measureLength(ts);
  let len = BASE_Q[n.base];
  let add = len / 2;
  for (let i = 0; i < n.dots; i++) {
    len += add;
    add /= 2;
  }
  if (n.tuplet) len = (len * n.tuplet.occupied) / n.tuplet.notes;
  return len;
};

export const parseTimeSig = (text: string): TimeSignature => {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text);
  if (!m) throw new RhythmParseError(`"${text}" is not a time signature.`);
  const ts = { num: parseInt(m[1], 10), den: parseInt(m[2], 10) };
  if (![2, 4, 8, 16].includes(ts.den) || ts.num < 1 || ts.num > 16) {
    throw new RhythmParseError(`Unsupported time signature ${text}.`);
  }
  return ts;
};

export const timeSigText = (ts: TimeSignature) => `${ts.num}/${ts.den}`;

const TOKEN = /^(w|h|q|8|16|32)(\.{0,2})(r)?(~)?$/;

export class RhythmParseError extends Error {}

export const parseLine = (source: string, timeSig: TimeSignature | string): Line => {
  const ts = typeof timeSig === "string" ? parseTimeSig(timeSig) : timeSig;
  const measureTexts = source
    .split("|")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (measureTexts.length === 0) {
    throw new RhythmParseError("The rhythm is empty.");
  }

  let tupletId = 0;
  let beamId = 0;
  const explicitBeams = /[[\]]/.test(source);
  const measures = measureTexts.map((text, mi) => {
    const where = `Measure ${mi + 1}`;
    const tokens = text
      .replace(/\(/g, " ( ")
      .replace(/\)/g, " ) ")
      .replace(/\[/g, " [ ")
      .replace(/\]/g, " ] ")
      .split(/\s+/)
      .filter((t) => t.length > 0);
    const notes: RhythmNote[] = [];
    let tuplet: Tuplet | null = null;
    let tupletStart = 0;
    let beam: number | null = null;
    let beamStart = 0;

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok === "3" && tokens[i + 1] === "(") {
        if (tuplet) throw new RhythmParseError(`${where}: triplets can't be nested.`);
        tuplet = { id: tupletId++, notes: 3, occupied: 2 };
        tupletStart = notes.length;
        i++;
        continue;
      }
      if (tok === ")") {
        if (!tuplet) throw new RhythmParseError(`${where}: unexpected ")".`);
        if (notes.length === tupletStart) {
          throw new RhythmParseError(`${where}: empty triplet.`);
        }
        tuplet = null;
        continue;
      }
      if (tok === "[") {
        if (beam !== null) throw new RhythmParseError(`${where}: beams can't be nested.`);
        beam = beamId++;
        beamStart = notes.length;
        continue;
      }
      if (tok === "]") {
        if (beam === null) throw new RhythmParseError(`${where}: unexpected "]".`);
        const group = notes.slice(beamStart);
        if (group.length < 2) throw new RhythmParseError(`${where}: a beam needs at least two notes.`);
        if (group.some((n) => !n.rest && !["8", "16", "32"].includes(n.base))) {
          throw new RhythmParseError(`${where}: only 8ths and shorter can be beamed.`);
        }
        if (group[0].rest || group[group.length - 1].rest) {
          throw new RhythmParseError(`${where}: a beam must start and end on a note.`);
        }
        beam = null;
        continue;
      }
      if (tok === "mr") {
        notes.push({ base: "w", dots: 0, rest: true, tie: false, measureRest: true });
        continue;
      }
      const m = TOKEN.exec(tok);
      if (!m) {
        throw new RhythmParseError(`${where}: "${tok}" is not a note. Use w, h, q, 8, 16 or 32 with optional ".", "r" or "~".`);
      }
      notes.push({
        base: m[1] as BaseDuration,
        dots: m[2].length,
        rest: !!m[3],
        tie: !!m[4],
        ...(tuplet ? { tuplet } : {}),
        ...(beam !== null ? { beam } : {}),
      });
    }
    if (tuplet) throw new RhythmParseError(`${where}: missing ")" after triplet.`);
    if (beam !== null) throw new RhythmParseError(`${where}: missing "]" after beamed notes.`);
    if (notes.some((n) => n.measureRest) && notes.length > 1) {
      throw new RhythmParseError(`${where}: "mr" must be the only thing in its measure.`);
    }

    const total = notes.reduce((acc, n) => acc + noteLength(n, ts), 0);
    if (Math.abs(total - measureLength(ts)) > EPS) {
      const have = +(total / beatLength(ts)).toFixed(3);
      throw new RhythmParseError(`${where} has ${have} beats but ${timeSigText(ts)} needs ${ts.num}.`);
    }
    return notes;
  });

  measures.forEach((notes, mi) =>
    notes.forEach((n, ni) => {
      if (!n.tie) return;
      const next = notes[ni + 1] ?? measures[mi + 1]?.[0];
      if (n.rest || !next || next.rest) {
        throw new RhythmParseError(`Measure ${mi + 1}: a tie must connect two notes (not rests).`);
      }
    }),
  );

  return { timeSig: ts, measures, ...(explicitBeams ? { explicitBeams } : {}) };
};

/** Line length in q-units. */
export const lineLength = (line: Line) => line.measures.length * measureLength(line.timeSig);

/** Number of counted beats in the line. */
export const lineBeats = (line: Line) => line.measures.length * line.timeSig.num;

/** A note as placed on the line's timeline. Positions are in q-units. */
export interface PlacedNote {
  measure: number;
  index: number;
  pos: number;
  len: number;
  note: RhythmNote;
}

export const placeNotes = (line: Line): PlacedNote[] => {
  const placed: PlacedNote[] = [];
  const mLen = measureLength(line.timeSig);
  line.measures.forEach((notes, measure) => {
    let pos = measure * mLen;
    notes.forEach((note, index) => {
      const len = noteLength(note, line.timeSig);
      // Snap to a 1/48-quarter grid (covers 32nds and triplets) to avoid float drift.
      placed.push({ measure, index, pos: Math.round(pos * 48) / 48, len, note });
      pos += len;
    });
  });
  return placed;
};

/** A note the student should clap: its onset and how long it sounds (ties merged). */
export interface ExpectedClap {
  id: number;
  measure: number;
  /** Index of the note within its measure. */
  index: number;
  pos: number;
  len: number;
}

export const expectedClaps = (line: Line): ExpectedClap[] => {
  const claps: ExpectedClap[] = [];
  let tiedFromPrev = false;
  for (const p of placeNotes(line)) {
    if (p.note.rest) {
      tiedFromPrev = false;
      continue;
    }
    if (tiedFromPrev) {
      claps[claps.length - 1].len += p.len;
    } else {
      claps.push({ id: claps.length, measure: p.measure, index: p.index, pos: p.pos, len: p.len });
    }
    tiedFromPrev = p.note.tie;
  }
  return claps;
};

export const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

/** The count syllable for a position (in beats) within a measure: 1, e, &, a; triplets 1, la, li. */
export const countLabel = (beatInMeasure: number): string => {
  const whole = Math.floor(beatInMeasure + 1e-4);
  const frac = beatInMeasure - whole;
  if (near(frac, 0)) return NUMBER_WORDS[whole] ?? String(whole + 1);
  if (near(frac, 0.5)) return "and";
  if (near(frac, 0.25)) return "e";
  if (near(frac, 0.75)) return "a";
  if (near(frac, 1 / 3)) return "la";
  if (near(frac, 2 / 3)) return "li";
  return "?";
};

/** How a count is written on the page. */
export const countDisplay = (label: string) => {
  const i = NUMBER_WORDS.indexOf(label);
  if (i >= 0) return String(i + 1);
  if (label === "and") return "&";
  return label;
};

export type CountMode =
  /** Say the count of every note (wherever you'd clap); keep counting through held notes; rests are silent. */
  | "notes"
  /**
   * "Count everything": say the count of every note and every rest, and every
   * beat of a long rest (a whole rest is "1 2 3 4"), plus held beats as in "notes".
   */
  | "all";

export interface ExpectedCount {
  id: number;
  /** Position in q-units. */
  pos: number;
  label: string;
}

export const expectedCounts = (line: Line, mode: CountMode): ExpectedCount[] => {
  const beat = beatLength(line.timeSig);
  const mLen = measureLength(line.timeSig);
  const positions = new Map<number, number>();
  const add = (pos: number) => positions.set(Math.round(pos * 48), pos);

  for (const c of expectedClaps(line)) {
    add(c.pos);
    // Keep counting the beats a long note is held through.
    for (let b = Math.floor(c.pos / beat + EPS) + 1; b * beat < c.pos + c.len - EPS; b++) {
      add(b * beat);
    }
  }
  if (mode === "all") {
    for (let b = 0; b < lineBeats(line); b++) add(b * beat);
    // Rests off the beat too: the "&" of an eighth rest.
    for (const p of placeNotes(line)) if (p.note.rest) add(p.pos);
  }

  return Array.from(positions.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, pos], id) => ({
      id,
      pos,
      label: countLabel((pos % mLen) / beat),
    }));
};
