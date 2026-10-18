import { Ctx, measuresText } from "./context";
import { Evidence } from "./types";

// Morphed rhythms: a figure performed as a different one, e.g. sixteenths
// ("1-e-&-uh") played as a triplet ("1-la-li"), even eighths swung, a dotted
// rhythm flattened into even eighths, "1 & uh" flipped into "1 e &".
//
// A figure's shape is local, so it's measured locally: between the sound on
// the beat and the sound on the next beat, each sound in between as a
// fraction of that span. That doesn't depend on the tempo or a drift, so it
// runs in tier 1, before the timing fit (which then leaves these notes out:
// a morphed figure would otherwise look like a drift).

/** Figures within one beat: where each note starts, as a fraction of the beat. */
const FIGURES: Record<string, number[]> = {
  eighths: [0, 0.5],
  "long-short": [0, 0.7],
  sixteenths: [0, 0.25, 0.5, 0.75],
  triplet: [0, 1 / 3, 2 / 3],
  "eighth-two-sixteenths": [0, 0.5, 0.75],
  "two-sixteenths-eighth": [0, 0.25, 0.5],
  "sixteenth-eighth-sixteenth": [0, 0.25, 0.75],
};
/** The written figure (name) for a beat's onsets; "long-short" also covers dotted eighth–sixteenth and triplet quarter–eighth. */
const written = (fr: number[]) => {
  const close = (a: number[], b: number[], tol = 0.02) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
  if (close(fr, [0, 0.75]) || close(fr, [0, 2 / 3])) return "long-short";
  return Object.keys(FIGURES).find((k) => close(fr, FIGURES[k])) ?? null;
};
/** Swaps students really make (written → performed). */
const SWAPS: Record<string, string[]> = {
  eighths: ["long-short"],
  "long-short": ["eighths"],
  sixteenths: ["triplet"],
  triplet: ["sixteenths", "eighth-two-sixteenths", "two-sixteenths-eighth"],
  "eighth-two-sixteenths": ["two-sixteenths-eighth", "triplet"],
  "two-sixteenths-eighth": ["eighth-two-sixteenths", "triplet"],
  "sixteenth-eighth-sixteenth": ["triplet"],
};
const rms = (a: number[], b: number[]) => Math.sqrt(a.reduce((s, x, i) => s + (x - b[i]) ** 2, 0) / a.length);

const SAY: Record<string, string> = {
  eighths: "even eighths (“1-&”)",
  "long-short": "long-short",
  sixteenths: "sixteenths (“1-e-&-uh”)",
  triplet: "a triplet (“1-la-li”)",
  "eighth-two-sixteenths": "“1-&-uh”",
  "two-sixteenths-eighth": "“1-e-&”",
  "sixteenth-eighth-sixteenth": "“1-e-uh”",
};
const advice = (from: string) => {
  if (from === "eighths") return "Make the eighths even: the “&” comes exactly halfway through the beat.";
  if (from === "long-short") return "Make it long-short: hold the first note, and the short one comes just before the next beat.";
  if (from === "sixteenths") return "Four even notes in the beat, not three: “1-e-&-uh”.";
  if (from === "triplet") return "Three even notes in the beat: “1-la-li”.";
  if (from === "eighth-two-sixteenths") return "The long note comes first: “1 (&)-&-uh”, then two quick ones.";
  if (from === "two-sixteenths-eighth") return "Two quick notes first, then the long one: “1-e-&”.";
  return `Play it as written: ${SAY[from]}.`;
};

export const morph = (ctx: Ctx, paired: (number | null)[], cutK: number, trace?: (line: string) => void): Evidence[] => {
  const { notes, counts, detected, beat, skip, measureOf, noteGain, secPerBeat } = ctx;
  // Notes by beat, and the note starting each beat.
  const beats = new Map<number, number[]>();
  notes.forEach((n, i) => {
    // (Every written note shapes the figure, even one whose count blended in.)
    if (i >= cutK) return;
    const b = Math.floor(n.pos / beat + 1e-6);
    beats.set(b, [...(beats.get(b) ?? []), i]);
  });
  const onBeat = (b: number) => notes.findIndex((n) => Math.abs(n.pos - b * beat) < 1e-6);
  // Anchors are the sounds on the beats, found beat by beat: each one where
  // the previous anchor says the student's beat is now (so a drift is
  // followed). Not from the note pairing: a morphed figure can throw that off.
  const anchors = new Map<number, number>();
  {
    const firstOffs = paired
      .map((j, i) => (j === null ? null : detected[j] - ctx.exp[i]))
      .filter((x): x is number => x !== null)
      .slice(0, 4)
      .sort((x, y) => x - y);
    let off = firstOffs.length ? firstOffs[Math.floor(firstOffs.length / 2)] : 0;
    const lastBeat = Math.ceil((notes[notes.length - 1]?.pos ?? 0) / beat) + 1;
    for (let b = 0; b <= lastBeat; b++) {
      const i = onBeat(b);
      if (i < 0) continue;
      const t = ctx.exp[i] + off;
      let best: number | null = null;
      for (const d of detected)
        if (Math.abs(d - t) <= 0.25 * secPerBeat && (best === null || Math.abs(d - t) < Math.abs(best - t))) best = d;
      // (A blended count has no onset of its own: use where the beat should be.)
      if (best === null && skip[i]) best = t;
      if (best === null) continue;
      anchors.set(b, best);
      off = best - ctx.exp[i];
    }
  }
  const anchor = (b: number) => anchors.get(b) ?? null;
  const found = new Map<string, { beats: number[]; notes: number[]; sounds: number[] }>();
  /** Beats of each written figure whose shape could be measured. */
  const measured = new Map<string, number>();
  beats.forEach((idx, b) => {
    const start = b * beat;
    const fr = idx.map((i) => (notes[i].pos - start) / beat);
    const name = written(fr);
    if (!name || fr[0] > 1e-6 || !SWAPS[name]) return;
    // Syllables blended into a fast count have no onset of their own: with
    // any after the first, the beat's shape can't be judged ("1-e-&-uh" said
    // as one word is right, and would look like fewer notes).
    if (idx.slice(1).some((i) => skip[i])) return trace?.(`beat ${b} ${name}: blended`);
    // Anchors: the sounds on this beat and on the next one.
    const a = anchor(b);
    if (a === null) return trace?.(`beat ${b} ${name}: no sound on the beat`);
    // The next beat's sound, or (a rest or held note there) one beat on.
    const z = anchor(b + 1) ?? a + secPerBeat;
    const span = z - a;
    if (span < 0.6 * secPerBeat || span > 1.5 * secPerBeat) return;
    const inside = detected.map((t, j) => ({ t, j })).filter((s) => s.t > a + 0.04 * span && s.t < z - 0.04 * span);
    if (!inside.length) return;
    const p = [0, ...inside.map((s) => (s.t - a) / span)];
    measured.set(name, (measured.get(name) ?? 0) + 1);
    trace?.(`beat ${b} ${name}: ${p.map((x) => x.toFixed(2)).join(" ")}`);
    // The figure the sounds fit best (same number of notes).
    let best: { k: string; err: number } | null = null;
    for (const [k, f] of Object.entries(FIGURES)) {
      if (f.length !== p.length) continue;
      const err = rms(p, f);
      if (!best || err < best.err) best = { k, err };
    }
    if (!best || best.k === name || !SWAPS[name].includes(best.k) || best.err > 0.06) return;
    const own = FIGURES[name];
    if (own.length === p.length && name !== "long-short" && rms(p, own) < 0.09) return;
    const key = `${name}>${best.k}`;
    const g = found.get(key) ?? { beats: [], notes: [], sounds: [] };
    g.beats.push(b);
    g.notes.push(...idx);
    g.sounds.push(detected.indexOf(a), ...inside.map((s) => s.j));
    found.set(key, g);
  });
  const out: Evidence[] = [];
  found.forEach((g, key) => {
    const [from, to] = key.split(">");
    // A habit, not a slip or two: most of the beats that could be measured.
    const of = measured.get(from) ?? g.beats.length;
    if (g.beats.length < 2 || g.beats.length < 0.5 * of) return;
    const measures = measuresText(g.beats.map((b) => measureOf(b * beat)));
    const text =
      from === "eighths"
        ? `Your eighth notes came out uneven, long-short like a swing (${measures}). ${advice(from)}`
        : from === "long-short"
          ? `Your long-short rhythm came out as even eighths (${measures}). ${advice(from)}`
          : `You played ${SAY[from]} as ${SAY[to]} (${measures}). ${advice(from)}`;
    out.push({
      kind: "morph",
      area: "steady",
      text,
      at: g.beats[0] * beat,
      gain: noteGain(g.notes.filter((i) => notes[i].status !== "on-time").length + 0.5 * g.beats.length),
      // The beats' notes, sounds and counts (the words usually follow the hands).
      claims: [
        ...g.notes.map((i) => `n${i}`),
        ...g.sounds.map((j) => `s${j}`),
        ...counts
          .map((c, k) => (g.beats.some((b) => c.pos >= b * beat - 1e-6 && c.pos < (b + 1) * beat - 1e-6) ? `c${k}` : ""))
          .filter(Boolean),
      ],
    });
  });
  return out;
};
