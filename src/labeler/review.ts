import { countDisplay } from "../music/rhythm";
import { countsFromEvents, LabelEvent, TakeInfo } from "./labels";

// The labeler's beat-by-beat review: groups what the music expects at each
// position (a clap, a count, a rest pulse) with the events labeled near it,
// so a person can check one beat at a time instead of editing a timeline.

export interface Beat {
  /** Position in q-units from the start of the line; also the beat's key. */
  pos: number;
  /** Earliest expected event time (seconds into audio.wav). */
  t: number;
  /** A note starts here (expects a clap in clapping activities). */
  note?: { t: number; len: number };
  /** A count is expected here (index into info.counts). */
  count?: { i: number; t: number; label: string };
  /** A rest (or a later beat of a long rest) starts here: expects a pulse. */
  rest?: { t: number };
}

export interface BeatEvents {
  clap: LabelEvent | null;
  word: LabelEvent | null;
  pulse: LabelEvent | null;
  /** Events near this beat that match nothing the music expects. */
  extras: LabelEvent[];
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

export const buildBeats = (info: TakeInfo, claps: boolean): Beat[] => {
  const beats: Beat[] = [];
  const at = (pos: number, t: number) => {
    let b = beats.find((x) => same(x.pos, pos));
    if (!b) beats.push((b = { pos, t }));
    b.t = Math.min(b.t, t);
    return b;
  };
  if (claps) for (const n of info.notes) at(n.pos, n.t).note = { t: n.t, len: n.len };
  info.counts.forEach((c, i) => (at(c.pos, c.t).count = { i, t: c.t, label: c.label }));
  if (claps) for (const r of info.rests) at(r.pos, r.t).rest = { t: r.t };
  return beats.sort((a, b) => a.pos - b.pos);
};

/** Nearest unused event of each expected time, within half the gap to its neighbors and [lo, hi] of it. */
const match = (times: number[], events: LabelEvent[], lo: number, hi: number) => {
  const used = new Set<number>();
  return times.map((t, i) => {
    const a = Math.max(t - lo, i > 0 ? (times[i - 1] + t) / 2 : -Infinity);
    const b = Math.min(t + hi, i < times.length - 1 ? (t + times[i + 1]) / 2 : Infinity);
    const e = events.filter((x) => !used.has(x.id) && x.t >= a && x.t < b).sort((x, y) => Math.abs(x.t - t) - Math.abs(y.t - t))[0];
    if (!e) return null;
    used.add(e.id);
    return e;
  });
};

/** Which labeled events belong to each beat; anything left over is an extra on its nearest beat. */
export const assignEvents = (beats: Beat[], events: LabelEvent[], info: TakeInfo): BeatEvents[] => {
  const out: BeatEvents[] = beats.map(() => ({ clap: null, word: null, pulse: null, extras: [] }));
  const used = new Set<number>();
  const noteBeats = beats.map((b, i) => [b, i] as const).filter(([b]) => b.note);
  match(
    noteBeats.map(([b]) => b.note!.t),
    events.filter((e) => e.type === "clap"),
    0.25,
    0.35
  ).forEach((e, k) => {
    if (e) {
      out[noteBeats[k][1]].clap = e;
      used.add(e.id);
    }
  });
  const restBeats = beats.map((b, i) => [b, i] as const).filter(([b]) => b.rest);
  match(
    restBeats.map(([b]) => b.rest!.t),
    events.filter((e) => e.type === "pulse"),
    0.4,
    0.5
  ).forEach((e, k) => {
    if (e) {
      out[restBeats[k][1]].pulse = e;
      used.add(e.id);
    }
  });
  // Counts use the same matching as the saved labels file, so the review shows what gets saved.
  const counted = countsFromEvents(events, info);
  const words = events.filter((e) => e.type === "count");
  beats.forEach((b, i) => {
    if (!b.count) return;
    const c = counted[b.count.i];
    const e = c.t === null ? undefined : words.find((w) => !used.has(w.id) && same(w.t, c.t!));
    if (e) {
      out[i].word = e;
      used.add(e.id);
    }
  });
  for (const e of events) {
    if (used.has(e.id) || !beats.length) continue;
    let best = 0;
    beats.forEach((b, i) => {
      if (Math.abs(b.t - e.t) < Math.abs(beats[best].t - e.t)) best = i;
    });
    out[best].extras.push(e);
  }
  return out;
};

/** "measure 2, beat 3" (and "&" / "e" / "uh" for off-beat positions). */
export const beatName = (pos: number, measureLen: number, beatLen: number) => {
  const m = Math.floor(pos / measureLen + 1e-6);
  const inM = pos - m * measureLen;
  const beat = Math.floor(inM / beatLen + 1e-6);
  const frac = inM / beatLen - beat;
  const part = Math.abs(frac) < 1e-3 ? "" : Math.abs(frac - 0.5) < 1e-3 ? " &" : Math.abs(frac - 0.25) < 1e-3 ? " e" : Math.abs(frac - 0.75) < 1e-3 ? " uh" : "+";
  return `measure ${m + 1}, beat ${beat + 1}${part}`;
};

/** The nearest onset within `within` seconds of t, else t (so added events land on the actual sound). */
export const snap = (t: number, onsets: number[], within = 0.15) => {
  let best: number | null = null;
  for (const o of onsets) if (Math.abs(o - t) <= within && (best === null || Math.abs(o - t) < Math.abs(best - t))) best = o;
  return best ?? t;
};

/** How a count word is shown: 1–9, "&", "e", "uh" (labels say "a"), "Da" for a sung note ("sing"), "?" when unsure. */
export const wordDisplay = (label: string) => (label === "a" ? "uh" : label === "sing" ? "Da" : countDisplay(label));
