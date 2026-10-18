import { PlacedNote } from "../../music/rhythm";
import { NoteResult } from "../analyze";
import { Ctx, measuresText } from "./context";
import { isDotted, isTriplet } from "./math";
import { Timing } from "./timing";
import { Evidence } from "./types";

// The same kind of note keeps coming early or late, after the student's
// overall timing (drift or offset) is taken out: notes after rests, after long
// or dotted notes, triplets, sixteenths, eighths.

/** What kind of spot a note is in, for grouping. */
export const figureOf = (ctx: Ctx) => {
  const { placed, beat } = ctx;
  const prevOf = (pos: number) => {
    let prev: PlacedNote | null = null;
    for (const p of placed) if (p.pos < pos - 1e-6) prev = p;
    return prev;
  };
  return (n: NoteResult): string => {
    const prev = prevOf(n.pos);
    if (prev?.note.rest) return "after-rest";
    if (prev && prev.len >= 2 * beat - 1e-6) return "after-long";
    if (prev && isDotted(prev.len, beat)) return "after-dotted";
    if (isTriplet(n.len, beat)) return "triplet";
    if (n.len <= beat / 4 + 1e-6) return "sixteenth";
    if (isDotted(n.len, beat)) return "dotted";
    if (n.len <= beat / 2 + 1e-6) return "eighth";
    return "beat";
  };
};

export const figures = (ctx: Ctx, t: Timing): Evidence[] => {
  const { notes, exp, x0, measureOf, noteGain, noun, click, claimed } = ctx;
  const { timedIdx, offsetOf, model, tolMs } = t;
  const FIGURE: Record<string, { name: string; early: string; late: string }> = {
    "after-rest": {
      name: "notes right after a rest",
      early: "Count the whole rest before you come back in.",
      late: "Get ready during the rest so you come in right on time.",
    },
    "after-long": {
      name: "notes after a long note",
      early: "Hold the long note for its full count before the next one.",
      late: "Keep counting through the long note so the next one comes right on time.",
    },
    "after-dotted": {
      name: "short notes after a dotted note",
      early: "Hold the dotted note longer: the short note comes just before the next beat.",
      late: "The short note after a dotted note is quick: it leads straight into the next beat.",
    },
    triplet: { name: "triplets", early: "Make the three notes even: “1-la-li”.", late: "Make the three notes even: “1-la-li”." },
    sixteenth: {
      name: "sixteenth notes",
      early: "Keep the four sixteenths even, “1-e-&-uh”, and don't squeeze them.",
      late: "Keep the sixteenths even and quick, “1-e-&-uh”, so the next beat comes on time.",
    },
    dotted: { name: "dotted notes", early: "Give the dotted note its full length.", late: "Come in right on the beat for dotted notes." },
    eighth: {
      name: "eighth notes",
      early: "Make the two eighths even, “1-&”, with the “&” exactly halfway.",
      late: "Make the two eighths even, “1-&”, with the “&” exactly halfway.",
    },
    beat: {
      name: "notes on the beat",
      early: `Line each ${noun} up with the ${click}.`,
      late: `Line each ${noun} up with the ${click}.`,
    },
  };
  const kindOf = figureOf(ctx);
  const groups = new Map<string, { all: number[]; early: number[]; late: number[] }>();
  for (const i of timedIdx) {
    if (claimed.has(`n${i}`)) continue;
    const key = kindOf(notes[i]);
    const g = groups.get(key) ?? { all: [], early: [], late: [] };
    g.all.push(i);
    // What's left after the drift or offset already explained.
    const r = offsetOf(i) - model(exp[i] - x0);
    if (Math.abs(r) > tolMs) (r < 0 ? g.early : g.late).push(i);
    groups.set(key, g);
  }
  const out: Evidence[] = [];
  groups.forEach((g, key) => {
    for (const dir of ["early", "late"] as const) {
      const bad = g[dir];
      if (bad.length < 2 || bad.length < 0.4 * g.all.length) continue;
      const f = FIGURE[key];
      out.push({
        kind: "figure",
        area: "steady",
        text: `Your ${f.name} came ${dir} (${bad.length} of ${g.all.length}, ${measuresText(bad.map((i) => measureOf(notes[i].pos)))}). ${f[dir]}`,
        at: notes[bad[0]].pos,
        gain: noteGain(bad.length * 0.5),
        claims: bad.map((i) => `n${i}`),
      });
    }
  });
  return out;
};
