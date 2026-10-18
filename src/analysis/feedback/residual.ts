import { Ctx, measuresText, plural } from "./context";
import { figureOf } from "./figures";
import { Timing } from "./timing";
import { Evidence } from "./types";

// Tier 3: what's left after the patterns. Single notes off the beat, missed
// notes, claps seen but not heard, and extra sounds, each only where no
// earlier evidence already explains it.

export const residual = (ctx: Ctx, t: Timing): Evidence[] => {
  const {
    notes,
    exp,
    x0,
    detected,
    placed,
    result,
    activity,
    measureOf,
    spot,
    noun,
    click,
    noteArea,
    noteGain,
    share,
    parts,
    beat,
    claimed,
  } = ctx;
  const { paired, cutK, cutPos, timedIdx, offsetOf, model, tolMs } = t;
  const out: Evidence[] = [];

  // Single notes off the beat that no pattern explains.
  const stray = timedIdx.filter((i) => {
    const r = offsetOf(i) - model(exp[i] - x0);
    return Math.abs(r) > tolMs && notes[i].status !== "on-time" && !claimed.has(`n${i}`);
  });
  if (stray.length) {
    const early = (i: number) => offsetOf(i) - model(exp[i] - x0) < 0;
    const n = notes[stray[0]];
    out.push({
      kind: "timing",
      area: noteArea,
      text:
        stray.length === 1
          ? `Your ${noun} on ${spot(n.pos)} came ${early(stray[0]) ? "early" : "late"}. Play that spot slowly with the click, then at full speed.`
          : `${plural(stray.length, noun)} came early or late (${measuresText(stray.map((i) => measureOf(notes[i].pos)))}). Line each one up with the ${click}.`,
      at: n.pos,
      gain: noteGain(stray.length * 0.5),
      claims: stray.map((i) => `n${i}`),
    });
  }

  // Notes the grader missed that no sound belongs to, even following the student's tempo.
  const missed = notes
    .map((n, i) => ({ n, i }))
    .filter(({ n, i }) => paired[i] === null && n.status === "missed" && i < cutK && !claimed.has(`n${i}`));
  if (missed.length) {
    const kindOf = figureOf(ctx);
    const afterRest = missed.filter(({ n }) => kindOf(n) === "after-rest").length;
    out.push({
      kind: "missed",
      area: noteArea,
      text:
        missed.length === 1
          ? `You missed the ${noun} on ${spot(missed[0].n.pos)}.`
          : `You missed ${plural(missed.length, noun)} (${measuresText(missed.map(({ n }) => measureOf(n.pos)))})${
              afterRest >= missed.length / 2 ? ", mostly right after a rest: get ready during the rest" : ""
            }.`,
      at: missed[0].n.pos,
      gain: noteGain(missed.length),
      claims: missed.map(({ i }) => `n${i}`),
    });
  }
  const seen = notes.filter((n) => n.status === "seen");
  if (seen.length) {
    out.push({
      kind: "quiet",
      area: "notes",
      text: `I could see ${seen.length === 1 ? "one clap" : `${seen.length} claps`} but not hear ${seen.length === 1 ? "it" : "them"} (${measuresText(
        seen.map((n) => measureOf(n.pos)),
      )}). Clap a little louder.`,
      at: seen[0].pos,
      gain: noteGain(seen.length * 0.25),
    });
  }

  // Sounds that belong to no note.
  const used = new Set(paired.filter((j): j is number => j !== null));
  const extras = parts.notes
    ? detected
        .map((time, j) => ({ time, j, pos: (time - x0) / result.secPerQ }))
        .filter(({ time, j }) => !used.has(j) && !claimed.has(`s${j}`) && time < x0 + cutPos * result.secPerQ - 0.05)
        .filter((e) => e.pos > -beat && notes.every((n) => n.status !== "seen" || Math.abs(n.time! - e.time) > 0.05))
    : [];
  if (extras.length) {
    const onRest = extras.filter((e) => placed.some((p) => p.note.rest && e.pos >= p.pos - 0.25 && e.pos < p.pos + p.len)).length;
    out.push({
      kind: "extra",
      area: "notes",
      text: activity.sing
        ? `You sang ${extras.length === 1 ? "an extra “Da”" : `${extras.length} extra “Da”s`} (${measuresText(
            extras.map((e) => measureOf(e.pos)),
          )}). Sing one “Da” per note, and hold it until the next one.`
        : `You clapped ${extras.length === 1 ? "once" : `${extras.length} times`} where there's no note (${measuresText(extras.map((e) => measureOf(e.pos)))}).${
            onRest >= extras.length / 2 ? " On rests, pulse your hands down silently instead." : ""
          }`,
      at: extras[0].pos,
      gain: Math.min(share("notes", extras.length * 0.5, notes.length), share("notes", notes.length, notes.length)),
      claims: extras.map((e) => `s${e.j}`),
    });
  }
  return out;
};
