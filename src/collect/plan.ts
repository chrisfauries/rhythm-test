import { Activity } from "../music/activity";

// What a collection session records from one person (?collect).
//
// Guided takes: 25 lines that together cover the book's rhythms (quarters and
// rests through sixteenths, triplets, ties, dotted notes, 3/4, 5/4, 6/4, 6/8),
// every activity, a spread of tempos, and some takes without the click. The
// same list for everyone, so people can be compared take for take.
//
// Sound clips: single words, phrases, held counts, claps and singing, each
// said on the click a few times, cut into one clip per repeat. For building
// synthetic takes from this person's own voice and hands (ml/sound-bank.js).

export interface PlannedTake {
  /** Book exercise id. */
  line: string;
  activity: Activity;
  bpm: number;
  /** The metronome clicks during the line (always during the count-in). */
  click: boolean;
  /** What this take is for. */
  why: string;
}

export const TAKES: PlannedTake[] = [
  { line: "1-A", activity: "clap-count-all", bpm: 80, click: true, why: "Quarters and rests: rest counts and silent claps" },
  { line: "2.5-B", activity: "clap", bpm: 100, click: true, why: "Runs of eighth notes" },
  { line: "3.5-C", activity: "clap-count-notes", bpm: 70, click: true, why: "Half notes: count through the held beat" },
  { line: "4.75-A", activity: "clap-count-all", bpm: 90, click: false, why: "Whole notes and half rests: count every beat of the rest" },
  { line: "5.5-D", activity: "sing", bpm: 72, click: true, why: "3/4 and dotted half notes, sung legato" },
  { line: "7.5-B", activity: "clap-count-notes", bpm: 84, click: true, why: "Ties and dotted half notes" },
  { line: "10-C", activity: "clap-count-all", bpm: 96, click: true, why: "Eighth rests: say the “&” of the rest" },
  { line: "10.75-E", activity: "clap", bpm: 108, click: true, why: "Ties and eighth rests; push forward through long notes" },
  { line: "11-B", activity: "count-notes", bpm: 88, click: false, why: "Dotted quarter and eighth" },
  { line: "13-A", activity: "clap-count-all", bpm: 76, click: true, why: "Dotted notes and off-beat eighths" },
  { line: "14-A", activity: "clap-count-all", bpm: 60, click: true, why: "Sixteenths, slowly: a clear “1 e & uh”" },
  { line: "14-F", activity: "count-notes", bpm: 92, click: true, why: "Sixteenths, quick enough to run together" },
  { line: "15-C", activity: "clap-count-notes", bpm: 80, click: true, why: "“1 e &” (two sixteenths and an eighth)" },
  { line: "16-B", activity: "clap-count-all", bpm: 72, click: true, why: "“1 & uh” (an eighth and two sixteenths)" },
  { line: "16.5-D", activity: "clap", bpm: 120, click: false, why: "Mixed sixteenths, fast" },
  { line: "17-A", activity: "sing", bpm: 66, click: true, why: "Dotted eighth and sixteenth, sung" },
  { line: "18-A", activity: "clap-count-all", bpm: 66, click: true, why: "Triplets: “1 la li”" },
  { line: "18.5-C", activity: "count-notes", bpm: 76, click: true, why: "Triplets mixed with other rhythms" },
  { line: "19.5-B", activity: "clap-count-all", bpm: 50, click: true, why: "6/8: counting 1 to 6, clicking dotted quarters" },
  { line: "26.5-A", activity: "sing", bpm: 46, click: false, why: "6/8 with eighth rests, sung" },
  { line: "22.5-C", activity: "clap-count-notes", bpm: 84, click: true, why: "5/4: counting to 5" },
  { line: "23-B", activity: "clap-count-all", bpm: 60, click: true, why: "Syncopated sixteenths: “1 e (&) uh”" },
  { line: "25-A", activity: "count-notes", bpm: 70, click: true, why: "Sixteenth rests" },
  { line: "30-A", activity: "clap-count-notes", bpm: 90, click: false, why: "6/4: counting to 6" },
  { line: "CC-A", activity: "clap", bpm: 80, click: true, why: "Review: everything mixed" },
];

export type ClipKind = "word" | "phrase" | "held" | "clap" | "sing";

export interface ClipPrompt {
  id: string;
  kind: ClipKind;
  /** What to say (or do), shown large. */
  say: string;
  /** How to do it, one line. */
  how: string;
  /** Syllable labels in order, as the app names them ("one", "and", "a" for "uh", "clap", "sing"). */
  labels: string[];
  /** Where each syllable starts, in beats from the start of a repeat. */
  offsets: number[];
  style: string;
  bpm: number;
  /** Beats per repeat (the sound plus room to breathe). */
  beats: number;
  reps: number;
  /** One repeat in the app's rhythm notation (music/rhythm.ts), `beats` quarter notes long. */
  notation: string;
}

/** The whole prompt as music to show: one measure per repeat (one-beat repeats, four to a measure). */
export const promptMusic = (p: ClipPrompt) => {
  if (p.beats === 1) {
    const measures: string[] = [];
    for (let r = 0; r < p.reps; r += 4) measures.push(Array.from({ length: Math.min(4, p.reps - r) }, () => p.notation).join(" "));
    return { timeSig: "4/4", source: measures.join(" | ") };
  }
  return { timeSig: `${p.beats}/4`, source: Array.from({ length: p.reps }, () => p.notation).join(" | ") };
};

/** How a label is shown: "1", "&", "uh", "e", "la", "li"; claps and sung notes by what to do. */
export const showLabel = (label: string) => (label === "clap" ? "👏" : label === "sing" ? "Da" : shown(label));

const NUMBERS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const SHOW: Record<string, string> = { and: "&", a: "uh", e: "e", la: "la", li: "li" };
const shown = (label: string) => SHOW[label] ?? String(NUMBERS.indexOf(label) + 1);

const word = (label: string, style: "normal" | "quick" | "long"): ClipPrompt => ({
  id: `${label}_${style}`,
  kind: "word",
  say: style === "long" ? `${shown(label)}…` : shown(label),
  how:
    style === "normal"
      ? "Say it on the click, the way you count."
      : style === "quick"
        ? "Short and crisp, on every click."
        : "Stretch it out, like a held note: “ooone”.",
  labels: [label],
  offsets: [0],
  style,
  bpm: style === "quick" ? 100 : style === "long" ? 70 : 80,
  beats: style === "quick" ? 1 : 2,
  reps: style === "quick" ? 4 : 3,
  notation: style === "quick" ? "q" : style === "long" ? "h" : "q qr",
});

const PHRASE_NOTATION: Record<string, string> = {
  "one-e-and-a": "[ 16 16 16 16 ] qr",
  "one-and-a": "[ 8 16 16 ] qr",
  "one-e-and": "[ 16 16 8 ] qr",
  "one-e-a": "[ 16 8 16 ] qr",
  "one-la-li": "[ 3( 8 8 8 ) ] qr",
  "one-and-two-and": "[ 8 8 ] [ 8 8 ] qr",
  "one-two-three-four": "q q q q qr",
};

const phrase = (labels: string[], offsets: number[], len: number, tempo: "slow" | "fast"): ClipPrompt => ({
  id: `${labels.join("-")}_${tempo}`,
  kind: "phrase",
  say: labels.map(shown).join(" "),
  how: tempo === "slow" ? "Count it on the click, evenly." : "Count it quickly, the way you would in a fast piece.",
  labels,
  offsets,
  style: tempo,
  bpm: tempo === "slow" ? 60 : 100,
  beats: len + 1,
  reps: 3,
  notation: PHRASE_NOTATION[labels.join("-")],
});

const held = (beats: number): ClipPrompt => {
  const labels = NUMBERS.slice(0, beats);
  return {
    id: `held-${beats}`,
    kind: "held",
    say: labels.map((l, i) => (i === 0 ? "ooone" : shown(l))).join("-"),
    how: `A ${beats}-beat note: hold the sound and say each beat's number on the click.`,
    labels,
    offsets: labels.map((_, i) => i),
    style: "held",
    bpm: 80,
    beats: beats + 1,
    reps: 2,
    notation: beats === 2 ? "h qr" : beats === 3 ? "h. qr" : "w qr",
  };
};

export const PROMPTS: ClipPrompt[] = [
  ...NUMBERS.map((n) => word(n, "normal")),
  ...["e", "and", "a", "la", "li"].map((n) => word(n, "normal")),
  ...["one", "two", "three", "four", "e", "and", "a"].map((n) => word(n, "quick")),
  ...["one", "two", "three", "four", "and"].map((n) => word(n, "long")),
  ...(["slow", "fast"] as const).flatMap((t) => [
    phrase(["one", "e", "and", "a"], [0, 0.25, 0.5, 0.75], 1, t),
    phrase(["one", "and", "a"], [0, 0.5, 0.75], 1, t),
    phrase(["one", "e", "and"], [0, 0.25, 0.5], 1, t),
    phrase(["one", "e", "a"], [0, 0.25, 0.75], 1, t),
    phrase(["one", "la", "li"], [0, 1 / 3, 2 / 3], 1, t),
    phrase(["one", "and", "two", "and"], [0, 0.5, 1, 1.5], 2, t),
    phrase(["one", "two", "three", "four"], [0, 1, 2, 3], 4, t),
  ]),
  held(2),
  held(3),
  held(4),
  ...(["soft", "normal", "loud"] as const).map((s): ClipPrompt => ({
    id: `clap_${s}`,
    kind: "clap",
    say: s === "soft" ? "Soft clap" : s === "loud" ? "Loud clap" : "Clap",
    how: `${s === "soft" ? "A soft" : s === "loud" ? "A loud" : "A normal"} clap on every click.`,
    labels: ["clap"],
    offsets: [0],
    style: s,
    bpm: 80,
    beats: 1,
    reps: 8,
    notation: "q",
  })),
  {
    id: "clap_eighths",
    kind: "clap",
    say: "Clap eighth notes",
    how: "Two even claps per click, for four clicks.",
    labels: Array(8).fill("clap"),
    offsets: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5],
    style: "run",
    bpm: 90,
    beats: 5,
    reps: 2,
    notation: "[ 8 8 ] [ 8 8 ] [ 8 8 ] [ 8 8 ] qr",
  },
  {
    id: "sing_short",
    kind: "sing",
    say: "Da",
    how: "Sing a short “Da” on every click, on one comfortable note.",
    labels: ["sing"],
    offsets: [0],
    style: "short",
    bpm: 80,
    beats: 1,
    reps: 8,
    notation: "q",
  },
  {
    id: "sing_held",
    kind: "sing",
    say: "Daaa",
    how: "Sing “Daaa” and hold it for two clicks.",
    labels: ["sing"],
    offsets: [0],
    style: "held",
    bpm: 80,
    beats: 3,
    reps: 3,
    notation: "h qr",
  },
  {
    id: "sing_legato",
    kind: "sing",
    say: "Da Da Da Da",
    how: "One “Da” per click, joined smoothly, like a sung line.",
    labels: ["sing", "sing", "sing", "sing"],
    offsets: [0, 1, 2, 3],
    notation: "q q q q qr",
    style: "legato",
    bpm: 80,
    beats: 5,
    reps: 2,
  },
];
