import { CountMode } from "./rhythm";

// What the student does during a take. Hand motions (silent pulses on rests,
// hands held together through long notes) go with clapping.

export type Activity = "clap-count-all" | "clap-count-notes" | "clap" | "count-notes" | "sing";

export interface ActivityInfo {
  id: Activity;
  label: string;
  /** Instruction shown to the student. */
  hint: string;
  claps: boolean;
  /** Which counts are spoken, or null when nothing is counted aloud. */
  countMode: CountMode | null;
  /** Sings "Da" on each note, sustained. */
  sing: boolean;
}

export const ACTIVITIES: ActivityInfo[] = [
  {
    id: "clap-count-all",
    label: "Clap & count every beat",
    hint: "Clap the notes and say every beat, rests too. Pulse your hands down on rests; hold them together through long notes.",
    claps: true,
    countMode: "all",
    sing: false,
  },
  {
    id: "clap-count-notes",
    label: "Clap & count the notes",
    hint: "Clap the notes and say their counts, sustaining long notes into their last beat. Rests are silent: pulse your hands down.",
    claps: true,
    countMode: "notes",
    sing: false,
  },
  {
    id: "clap",
    label: "Clap only",
    hint: "Clap the notes without counting aloud. Pulse your hands down on rests; hold them together through long notes.",
    claps: true,
    countMode: null,
    sing: false,
  },
  {
    id: "count-notes",
    label: "Count only",
    hint: "Say the counts of the notes, sustaining long notes into their last beat. No clapping; rests are silent.",
    claps: false,
    countMode: "notes",
    sing: false,
  },
  {
    id: "sing",
    label: "Sing on “Da”",
    hint: "Sing one “Da” on each note and hold it for the note's full length. No clapping; rests are silent.",
    claps: false,
    countMode: null,
    sing: true,
  },
];

export const activityInfo = (a: Activity): ActivityInfo => ACTIVITIES.find((x) => x.id === a) ?? ACTIVITIES[0];
