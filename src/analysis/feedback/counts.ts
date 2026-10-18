import { countDisplay } from "../../music/rhythm";
import { CountResult, SUBDIVISIONS } from "../analyze";
import { Ctx, measuresText, plural } from "./context";
import { Timing } from "./timing";
import { Evidence } from "./types";

// Counting: lost place (wrong numbers), long notes or rests not counted,
// counts said where rests should be silent, counts not with the claps.

/**
 * Subdivision swaps the audio model makes itself, so they can't be told from
 * the student's: "uh" heard as "&" in clean takes (14-A, 14-E), still with
 * model v4 (real "uh" is rare: right 2 of 18 held out). Remove once the model
 * hears it (TODO.md).
 */
const MISHEARD = new Set(["a>and"]);

export const counting = (ctx: Ctx, t: Timing): Evidence[] => {
  const { counts, notes, placed, result, activity, measureOf, spot, sayAt, share, parts, beat, claimed } = ctx;
  if (!counts.length) return [];
  const out: Evidence[] = [];
  const idx = new Map(counts.map((c, i) => [c, i]));
  const claim = (cs: CountResult[]) => cs.map((c) => `c${idx.get(c)}`);
  const open = (c: CountResult) => c.pos < t.cutPos - 1e-6 && !claimed.has(`c${idx.get(c)}`);

  // The wrong subdivision word, again and again ("&" for "e"). The grader gives
  // these timing credit (the model can mix them up), so only a consistent
  // swap is reported, and not inside fast runs where syllables blend.
  const say = (label: string) => (label === "a" ? "uh" : countDisplay(label));
  const swaps = new Map<string, CountResult[]>();
  for (const c of counts) {
    if (!open(c) || c.blended || !c.heard || c.heard === c.label || c.status === "wrong" || c.status === "missed") continue;
    if (!SUBDIVISIONS.has(c.label) || !SUBDIVISIONS.has(c.heard)) continue;
    const key = `${c.label}>${c.heard}`;
    if (MISHEARD.has(key)) continue;
    swaps.set(key, [...(swaps.get(key) ?? []), c]);
  }
  swaps.forEach((cs, key) => {
    const [want, said] = key.split(">");
    const of = counts.filter((c) => c.label === want && !c.blended).length;
    if (cs.length < 3 || cs.length < 0.5 * of) return;
    out.push({
      kind: "sub-words",
      area: "counts",
      text: `You said “${say(said)}” where the count is “${say(want)}” (${measuresText(cs.map((c) => measureOf(c.pos)))}). “e” is a quarter of the way through the beat, “&” halfway, “uh” three quarters${
        want === "la" || want === "li" || said === "la" || said === "li" ? "; triplets are “1-la-li”" : ""
      }.`,
      at: cs[0].pos,
      gain: share("counts", cs.length * 0.5, counts.length),
      claims: claim(cs),
    });
  });

  const wrong = counts.filter((c) => c.status === "wrong" && open(c));
  const numbers = wrong.filter((c) => /^\d+$/.test(countDisplay(c.label)));
  if (numbers.length) {
    const c = numbers[0];
    out.push({
      kind: "wrong-numbers",
      area: "counts",
      text: `You said “${countDisplay(c.heard ?? "?")}” where it should be “${countDisplay(c.label)}” (${measuresText(
        numbers.map((x) => measureOf(x.pos)),
      )}). Start every measure on “1” and count every beat, rests and long notes too.`,
      at: c.pos,
      gain: share("counts", numbers.length, counts.length),
      claims: claim(numbers),
    });
  }
  const subs = wrong.filter((c) => !/^\d+$/.test(countDisplay(c.label)));
  if (subs.length) {
    const c = subs[0];
    out.push({
      kind: "wrong-numbers",
      area: "counts",
      text: `You said “${countDisplay(c.heard ?? "?")}” where it should be “${sayAt(c.pos)}” (${measuresText(
        subs.map((x) => measureOf(x.pos)),
      )}). Look at where the note falls in the beat: “e” is a quarter of the way, “&” halfway, “uh” three quarters.`,
      at: c.pos,
      gain: share("counts", subs.length, counts.length),
      claims: claim(subs),
    });
  }
  const missedCounts = counts.filter((c) => c.status === "missed" && open(c));
  const noteAt = (pos: number) => notes.some((n) => Math.abs(n.pos - pos) < 1e-6);
  const heldAt = (pos: number) => notes.some((n) => pos > n.pos + 1e-6 && pos < n.pos + n.len - 1e-6);
  const held = missedCounts.filter((c) => heldAt(c.pos));
  const onRest = missedCounts.filter((c) => !noteAt(c.pos) && !heldAt(c.pos));
  const onNote = missedCounts.filter((c) => noteAt(c.pos));
  if (held.length) {
    const c = held[0];
    out.push({
      kind: "held-counts",
      area: "counts",
      text: `Keep counting through long notes: hold the sound and say “${countDisplay(c.label)}” on ${spot(c.pos)}${
        held.length > 1 ? ` (and ${plural(held.length - 1, "more place")}: ${measuresText(held.map((x) => measureOf(x.pos)))})` : ""
      }.`,
      at: c.pos,
      gain: share("counts", held.length, counts.length),
      claims: claim(held),
    });
  }
  if (onRest.length) {
    out.push({
      kind: "rest-counts",
      area: "counts",
      text: `Say the counts on the rests too (${measuresText(onRest.map((c) => measureOf(c.pos)))}): in “count everything” every beat gets a count.`,
      at: onRest[0].pos,
      gain: share("counts", onRest.length, counts.length),
      claims: claim(onRest),
    });
  }
  if (onNote.length) {
    out.push({
      kind: "missed",
      area: "counts",
      text:
        onNote.length === 1
          ? `I didn't hear you say “${countDisplay(onNote[0].label)}” on ${spot(onNote[0].pos)}. Say every count out loud${
              activity.claps ? ", even while you clap" : ""
            }.`
          : `I didn't hear ${plural(onNote.length, "count")} (${measuresText(onNote.map((c) => measureOf(c.pos)))}). Say every count out loud${
              activity.claps ? ", even while you clap" : ""
            }.`,
      at: onNote[0].pos,
      gain: share("counts", onNote.length, counts.length),
      claims: claim(onNote),
    });
  }
  const extraWords = result.extraWords
    .map((e, k) => ({ e, k }))
    .filter(({ e, k }) => e.pos < t.cutPos - 1e-6 && e.pos > -beat && !claimed.has(`w${k}`));
  if (extraWords.length) {
    const onRestWords = extraWords.filter(({ e }) => placed.some((p) => p.note.rest && e.pos >= p.pos - 0.25 && e.pos < p.pos + p.len));
    const silent = activity.countMode === "notes" && onRestWords.length >= extraWords.length / 2;
    out.push({
      kind: silent ? "silent-rests" : "extra-words",
      area: "counts",
      text: silent
        ? `Rests are silent when you count the notes: don't say a count on the rest (${measuresText(onRestWords.map(({ e }) => measureOf(e.pos)))}).`
        : `I heard ${extraWords.length === 1 ? "an extra word" : `${extraWords.length} extra words`} (${measuresText(
            extraWords.map(({ e }) => measureOf(e.pos)),
          )}). Say only the counts, one per ${activity.countMode === "notes" ? "note" : "beat or note"}.`,
      at: extraWords[0].e.pos,
      gain: share("counts", extraWords.length * 0.5, counts.length),
      claims: extraWords.map(({ k }) => `w${k}`),
    });
  }
  // Counts off the beat while the claps are fine: the voice isn't with the hands.
  if (parts.notes) {
    const offCounts = counts.filter((c) => (c.status === "early" || c.status === "late") && open(c));
    if (offCounts.length && offCounts.length < Math.max(2, 0.3 * counts.length)) {
      const c = offCounts[0];
      out.push({
        kind: "timing",
        area: "counts",
        text:
          offCounts.length === 1
            ? `You said “${countDisplay(c.label)}” on ${spot(c.pos)} a little ${c.status}. Say it right on the beat, together with the clap.`
            : `${plural(offCounts.length, "count")} came early or late (${measuresText(offCounts.map((x) => measureOf(x.pos)))}). Say each one right on the beat.`,
        at: c.pos,
        gain: share("counts", offCounts.length * 0.5, counts.length),
        claims: claim(offCounts),
      });
    }
    if (offCounts.length >= Math.max(2, 0.3 * counts.length)) {
      const late = offCounts.filter((c) => c.status === "late").length >= offCounts.length / 2;
      out.push({
        kind: "count-timing",
        area: "counts",
        text: `Your counts came ${late ? "after" : "before"} your claps (${measuresText(
          offCounts.map((c) => measureOf(c.pos)),
        )}). Say each count together with its clap, right on the beat.`,
        at: offCounts[0].pos,
        gain: share("counts", offCounts.length * 0.5, counts.length),
        claims: claim(offCounts),
      });
    }
  }
  return out;
};
