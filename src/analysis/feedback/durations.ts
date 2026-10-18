import { Ctx, measuresText } from "./context";
import { Timing } from "./timing";
import { Evidence } from "./types";

// Note lengths: extra sounds that are really a long note played wrong.
//   - a clap on a tied note (the tie means hold, don't clap again)
//   - a long note cut short: the next note came in early, during it
//   - a clap again during a long note (on its held beats)

/** "half note", "dotted half note", ... for 4/4-style meters; otherwise "N-beat note". */
const lengthName = (len: number, beat: number) => {
  const beats = len / beat;
  const name: Record<string, string> = { "2": "half note", "3": "dotted half note", "4": "whole note", "1.5": "dotted quarter note" };
  return beat === 1 && name[String(beats)] ? name[String(beats)] : `long note (${+beats.toFixed(2)} beats)`;
};

export const durations = (ctx: Ctx, t: Timing): Evidence[] => {
  const { notes, detected, x0, posOf, tiedAt, beat, measureOf, noteGain, share, parts, activity, claimed } = ctx;
  const { paired, cutPos, model } = t;
  if (!parts.notes) return [];
  const used = new Set(paired.filter((j): j is number => j !== null));
  // Unpaired sounds, placed on the grid after taking the student's timing out.
  const extras = detected
    .map((time, j) => ({ j, pos: posOf(time - model(time - x0) / 1000) }))
    .filter((e) => !used.has(e.j) && !claimed.has(`s${e.j}`) && e.pos < cutPos - 1e-6 && e.pos > 0);
  const out: Evidence[] = [];
  const again = activity.sing ? "sang a new “Da”" : "clapped";
  const extraGain = (k: number) => Math.min(share("notes", k * 0.5, notes.length), share("notes", notes.length, notes.length));

  // Clapping a tied note.
  const onTie = extras.filter((e) => tiedAt.some((p) => Math.abs(e.pos - p) <= 0.2 * beat));
  if (onTie.length) {
    out.push({
      kind: "tie-clap",
      area: "notes",
      text: `You ${again} on a tied note (${measuresText(onTie.map((e) => measureOf(e.pos)))}). A tie joins two notes into one long one: ${
        activity.sing ? "keep the sound going" : "keep your hands together"
      } through it instead.`,
      at: onTie[0].pos,
      gain: extraGain(onTie.length),
      claims: onTie.map((e) => `s${e.j}`),
    });
  }

  // During a long note: cut short (the next note is missing: this was it) or an extra clap.
  const rest = extras.filter((e) => !onTie.includes(e));
  const cut: { e: (typeof rest)[number]; n: number; next: number }[] = [];
  const during: { e: (typeof rest)[number]; n: number }[] = [];
  for (const e of rest) {
    const n = notes.findIndex((x) => x.len >= 1.5 * beat - 1e-6 && e.pos >= x.pos + 0.5 * beat && e.pos < x.pos + x.len - 0.3 * beat);
    if (n < 0) continue;
    const next = n + 1;
    if (next < notes.length && paired[next] === null && notes[next].status === "missed" && !claimed.has(`n${next}`))
      cut.push({ e, n, next });
    else during.push({ e, n });
  }
  if (cut.length) {
    const c = cut[0];
    const n = notes[c.n];
    out.push({
      kind: "cut-short",
      area: "notes",
      text: `You cut the ${lengthName(n.len, beat)} in measure ${measureOf(n.pos)} short${
        cut.length > 1 ? ` (and ${cut.length - 1} more)` : ""
      }: the next ${ctx.noun} came too soon. It lasts ${+(n.len / beat).toFixed(2)} beats: count them all before the next ${ctx.noun}.`,
      at: n.pos,
      gain: noteGain(cut.length) + extraGain(cut.length),
      claims: cut.flatMap((x) => [`s${x.e.j}`, `n${x.next}`]),
    });
  }
  if (during.length) {
    const n = notes[during[0].n];
    out.push({
      kind: "held-beat-clap",
      area: "notes",
      text: `You ${again} during a long note (${measuresText(during.map((x) => measureOf(notes[x.n].pos)))}). A ${lengthName(n.len, beat)} gets one ${
        ctx.noun
      }, then ${activity.sing ? "you hold the sound" : "your hands stay together"} for ${+(n.len / beat).toFixed(2)} beats.`,
      at: n.pos,
      gain: extraGain(during.length),
      claims: during.map((x) => `s${x.e.j}`),
    });
  }
  return out;
};
