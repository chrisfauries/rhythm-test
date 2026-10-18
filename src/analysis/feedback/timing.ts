import { Ctx, measuresText } from "./context";
import { lineFit, median, quadratic } from "./math";
import { morph } from "./morph";
import { stops } from "./stops";
import { Evidence } from "./types";

// Tier 1: which sound belongs to which note, and what explains the student's
// timing as a whole. It follows the student's tempo note by note, then picks
// the simplest explanation that fits: a steady offset, a drift (from some
// measure on, or gradually), speeding up through each run of notes, or a
// skipped or added beat. Later detectors judge each note against it, so a
// drifting student isn't told every note was off.

export interface Timing {
  /** For each note, the index of its sound in ctx.detected (null: none). */
  paired: (number | null)[];
  /** Notes from here on aren't judged one by one (a slip shifted them). */
  cutK: number;
  /** Position of note cutK (Infinity when nothing is cut). */
  cutPos: number;
  /** Notes with a sound, before the cut. */
  timedIdx: number[];
  /** A paired note's offset (ms) from the written grid. */
  offsetOf: (i: number) => number;
  /** Where the student's timing says a note at time x (s into the line) lands, ms from the grid. */
  model: (x: number) => number;
  /** How far off is "off" (ms). */
  tolMs: number;
}

type Fit = { drift: boolean; runs?: boolean; f: (x: number) => number };

export const timing = (ctx: Ctx): { evidence: Evidence[]; timing: Timing } => {
  const { notes, exp, detected, win, skip, x0, lineSec, measureSec, secPerBeat, runStarts, runStartAt, pair, unpaired, placed, beat } = ctx;
  const { measureOf, noteGain, share, parts, activity, input, noun } = ctx;
  const evidence: Evidence[] = [];

  // Follow the student's tempo: fit how their timing moves (a steady offset, a
  // drift from some measure on, or a gradual speed change), pair the sounds to
  // where that says they should be, and repeat until it settles. Drift then
  // shows as drift instead of a run of misses and extras.
  const fitTiming = (xs: number[], ys: number[]): Fit => {
    const n = ys.length;
    const flatAt = median(ys);
    let best: Fit & { score: number } = { drift: false, f: () => flatAt, score: Infinity };
    if (!n) return best;
    const score = (f: (x: number) => number, params: number) => {
      const sse = ys.reduce((a, y, i) => a + (y - f(xs[i])) ** 2, 0);
      return n * Math.log(sse / n + 25) + params * Math.log(n) * 2;
    };
    best.score = score(best.f, 1);
    if (n < 6) return best;
    const linear = (h: number[]) => {
      const mh = h.reduce((a, v) => a + v, 0) / n;
      const my = ys.reduce((a, v) => a + v, 0) / n;
      const shh = h.reduce((a, v) => a + (v - mh) ** 2, 0);
      if (shh <= 1e-9) return null;
      const b = h.reduce((a, v, i) => a + (v - mh) * (ys[i] - my), 0) / shh;
      return { a: my - b * mh, b };
    };
    // A drift that starts at a measure line (at the start: a straight drift).
    for (let m = 0; m * measureSec < lineSec - measureSec / 2; m++) {
      const c = m * measureSec;
      const h = xs.map((x) => Math.max(0, x - c));
      if (h.filter((v) => v > 0).length < 4) continue;
      const l = linear(h);
      if (!l) continue;
      const f = (x: number) => l.a + l.b * Math.max(0, x - c);
      const s = score(f, m ? 3 : 2);
      if (s < best.score) best = { drift: true, f, score: s };
    }
    // A gradual speed change: offset = a + b·x + c·x².
    const q = quadratic(xs, ys);
    if (q) {
      const f = (x: number) => q[0] + q[1] * x + q[2] * x * x;
      const s = score(f, 3);
      if (s < best.score) best = { drift: true, f, score: s };
    }
    // Speeding up (or slowing down) through each run of notes, back on the
    // beat after every rest. Needs at least two runs to tell from a drift.
    const perRun = new Map<number, number>();
    xs.forEach((x) => perRun.set(runStartAt(x), (perRun.get(runStartAt(x)) ?? 0) + 1));
    if (Array.from(perRun.values()).filter((c) => c >= 3).length >= 2) {
      const l = linear(xs.map((x) => x - runStartAt(x)));
      if (l) {
        const f = (x: number) => l.a + l.b * (x - runStartAt(x));
        const s = score(f, 2);
        if (s < best.score) best = { drift: false, runs: true, f, score: s };
      }
    }
    return best;
  };
  const fitPaired = (p: (number | null)[], upTo = exp.length) => {
    const idx = p.map((j, i) => (j === null || i >= upTo ? -1 : i)).filter((i) => i >= 0);
    return fitTiming(
      idx.map((i) => exp[i] - x0),
      idx.map((i) => (detected[p[i]!] - exp[i]) * 1000),
    );
  };
  // Track note by note: expect each note where the last few paired ones say
  // the student's beat is now, like a listener following someone who speeds up.
  // (Notes in `aside` aren't paired, and sounds in `taken` aren't used.)
  const track = (aside: (i: number) => boolean = () => false, taken: Set<number> = new Set()): (number | null)[] => {
    const out: (number | null)[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    let last = -1;
    exp.forEach((t, i) => {
      if (skip[i] || aside(i)) return out.push(null);
      const n = xs.length;
      let guess = 0;
      if (n >= 3) {
        const k = Math.max(0, n - 8);
        const l = lineFit(xs.slice(k), ys.slice(k));
        guess = l ? l.a + l.b * (t - x0) : ys[n - 1];
      } else if (n) guess = ys[n - 1];
      const nearest = (at: number) => {
        let j = -1;
        for (let k = last + 1; k < detected.length && detected[k] <= at + win[i]; k++) {
          if (taken.has(k)) continue;
          if (Math.abs(detected[k] - at) <= win[i] && (j < 0 || Math.abs(detected[k] - at) < Math.abs(detected[j] - at))) j = k;
        }
        return j;
      };
      let j = nearest(t + guess);
      // After a rest the student may have found the beat again: if a sound is
      // nearer the beat than where the drift was heading, start afresh there.
      // (Only clearly: a drift that carries on through the rest is still a drift.)
      if (n && guess !== 0 && runStarts.some((r) => Math.abs(r - (t - x0)) < 1e-6)) {
        const g = nearest(t);
        const h = nearest(t + ys[n - 1]);
        const dGrid = g >= 0 ? Math.abs(detected[g] - t) : Infinity;
        const dGuess = j >= 0 ? Math.abs(detected[j] - t - guess) : Infinity;
        const dSame = h >= 0 ? Math.abs(detected[h] - t - ys[n - 1]) : Infinity;
        if (dGrid <= 0.08 && dGrid + 0.05 < Math.min(dGuess, dSame)) {
          j = g;
          xs.length = 0;
          ys.length = 0;
        }
      }
      out.push(j >= 0 ? j : null);
      if (j >= 0) {
        last = j;
        xs.push(t - x0);
        ys.push(detected[j] - t);
      }
    });
    return out;
  };
  let paired = track();
  // Figures played as other figures (a local shape, measured beat by beat):
  // those notes stay out of the timing fit, or they'd look like a drift.
  const morphed = morph(ctx, paired, exp.length);
  evidence.push(...morphed);
  morphed.forEach((e) => e.claims?.forEach((c) => ctx.claimed.add(c)));
  const shaped = (i: number) => ctx.claimed.has(`n${i}`);
  const unshaped = (p: (number | null)[]) => p.map((j, i) => (shaped(i) ? null : j));
  // Pair the rest again without them: a morphed beat can throw the pairing
  // off by a note for everything after it.
  if (morphed.length) {
    const taken = new Set(detected.map((_, j) => j).filter((j) => ctx.claimed.has(`s${j}`)));
    paired = track(shaped, taken);
  }
  let cutK = exp.length;
  let cutPos = Infinity;
  let fit = fitPaired(unshaped(paired));
  const followMissed = unpaired(paired);

  // ---- A skipped or added beat: everything after one spot is shifted --------
  // (From the very first note: came in early or late after the count-in.)
  // The slip that explains the whole line best: on the grid before note k,
  // shifted by s from note k on. It has to explain the take clearly better
  // than the grid and than a drifting tempo.
  const findSlip = () => {
    if (exp.length < 6 || detected.length < 4) return null;
    let best: { k: number; s: number; misses: number } | null = null;
    for (const s of [secPerBeat, -secPerBeat, 2 * secPerBeat, -2 * secPerBeat]) {
      for (let k = 0; k <= exp.length - 3; k++) {
        const p = pair((i) => exp[i] + (i >= k ? s : 0));
        const tail = exp.length - k;
        const misses = unpaired(p);
        if (unpaired(p, k) <= 0.25 * tail && (!best || misses < best.misses)) best = { k, s, misses };
      }
    }
    const grid = unpaired(pair((i) => exp[i]));
    return best && grid - best.misses >= Math.max(3, 0.25 * (exp.length - best.k)) && best.misses + 2 <= followMissed ? best : null;
  };
  const slip = findSlip();
  // Stopped, gave up or started over. On a line whose measures repeat,
  // starting over can look like a skipped beat: the restart wins, unless the
  // whole line was simply shifted from its first note (one shift explains it all).
  const stopped = stops(ctx, paired);
  const restarted = stopped.evidence.some((e) => e.kind === "restart") && slip?.k !== 0;

  let slipped = false;
  if (slip && !restarted) {
    const best = slip;
    {
      const n = notes[best.k];
      cutPos = n.pos;
      cutK = best.k;
      const added = best.s > 0;
      const beats = Math.round(Math.abs(best.s) / secPerBeat);
      // What came just before: a rest or a long note is the usual cause.
      const before = placed.filter((p) => p.pos < n.pos - 1e-6 && p.pos >= (notes[best!.k - 1]?.pos ?? 0) - 1e-6);
      const rest = before.some((p) => p.note.rest);
      const long = before.some((p) => !p.note.rest && p.len >= 2 * beat - 1e-6);
      const cause = rest ? "the rest" : long ? "the long note" : null;
      const how = added
        ? cause
          ? `Count ${cause} carefully and come back in right on the beat after it.`
          : "Keep going with the click, even if you lose your place."
        : cause
          ? `Give ${cause} its full count before the next note.`
          : "Count every beat in your head so none gets skipped.";
      const lost = notes.slice(best.k).filter((x) => x.status !== "on-time").length;
      const amount = beats === 1 ? "a beat" : `${beats} beats`;
      evidence.push({
        kind: best.k === 0 ? (added ? "late-start" : "early-start") : added ? "added-beat" : "skipped-beat",
        area: "steady",
        text:
          best.k === 0
            ? `You came in ${amount} ${added ? "late" : "early"} after the count-in, so the whole line was ${amount} ${
                added ? "behind" : "ahead of"
              } the ${ctx.click}. The rhythm itself was right! Come in right after the last count-in click, on “1”.`
            : `In measure ${measureOf(n.pos)} you ${added ? "added" : "skipped"} ${amount}, so everything after it came ${amount} ${
                added ? "late" : "early"
              }. The rhythm itself was right! ${how}`,
        at: n.pos,
        gain: noteGain(lost) + (parts.notes && parts.counts ? share("counts", lost, notes.length) : 0),
        claims: notes.map((_, i) => `n${i}`).slice(best.k),
      });
      // Before the slip, judge timing on the grid.
      paired = pair((i) => exp[i]);
      fit = fitPaired(unshaped(paired), cutK);
      slipped = true;
    }
  }

  // ---- Stopped, gave up or started over: notes after that can't be timed ----
  if (!slipped) {
    evidence.push(...stopped.evidence);
    if (stopped.cutK < exp.length) {
      cutK = stopped.cutK;
      cutPos = notes[cutK].pos;
      fit = fitPaired(unshaped(paired), cutK);
    }
  }

  // ---- Timing: drift, a steady offset ------------------------------------------
  const timedIdx = paired.map((j, i) => (j === null || i >= cutK || shaped(i) ? -1 : i)).filter((i) => i >= 0);
  const offsetOf = (i: number) => (detected[paired[i]!] - exp[i]) * 1000;
  const ys = timedIdx.map(offsetOf);
  // How far off is "off": just under the smallest offset the grader called early or late.
  const offTimes = notes.filter((n) => n.status === "early" || n.status === "late").map((n) => Math.abs(n.offsetMs!));
  const tolMs = offTimes.length ? Math.max(35, Math.min(100, Math.min(...offTimes) - 5)) : 70;
  let model = fit.f;
  // Notes the grader marked off (or missed) that the student's own timing explains.
  const explainedBy = (f: (x: number) => number) => {
    const explained = timedIdx.filter((i) => notes[i].status !== "on-time" && Math.abs(offsetOf(i) - f(exp[i] - x0)) <= tolMs);
    const recovered = notes.map((n, i) => (n.status === "missed" && paired[i] !== null ? i : -1)).filter((i) => i >= 0);
    // (A recovered note still far from where the timing puts it is its own problem: not claimed.)
    const fits = (i: number) => Math.abs(offsetOf(i) - f(exp[i] - x0)) <= tolMs;
    return {
      count: explained.length + recovered.length,
      claims: Array.from(new Set([...explained, ...recovered.filter(fits)])).map((i) => `n${i}`),
    };
  };
  let drifting = false;
  if (fit.runs && timedIdx.length >= 6) {
    // Where each run ended up, against where it started.
    const runs = new Map<number, number[]>();
    for (const i of timedIdx) {
      const r = runStartAt(exp[i] - x0);
      runs.set(r, [...(runs.get(r) ?? []), i]);
    }
    const drifts = Array.from(runs.entries())
      .filter(([, idx]) => idx.length >= 2)
      .map(([r, idx]) => ({ r, idx, change: fit.f(exp[idx[idx.length - 1]] - x0) - fit.f(r) }));
    const worst = drifts.reduce((a, d) => (Math.abs(d.change) > Math.abs(a.change) ? d : a), drifts[0]);
    const rushing = worst ? worst.change < 0 : false;
    // Runs where the student really did end up off the beat that way.
    const showing = drifts.filter((d) => {
      const first = offsetOf(d.idx[0]);
      const last = offsetOf(d.idx[d.idx.length - 1]);
      return (rushing ? first - last : last - first) > tolMs / 2 && Math.abs(last) > tolMs;
    });
    if (worst && Math.abs(worst.change) >= Math.max(60, 1.2 * tolMs) && showing.length >= 2) {
      const most = Math.max(...showing.map((d) => Math.abs(offsetOf(d.idx[d.idx.length - 1]))));
      const why = explainedBy(fit.f);
      drifting = true;
      evidence.push({
        kind: rushing ? "rushing-runs" : "dragging-runs",
        area: "steady",
        text: `You ${rushing ? "sped up" : "slowed down"} through notes in a row (${measuresText(
          showing.map((d) => measureOf(notes[d.idx[d.idx.length - 1]].pos)),
        )}): by the end of a run you were up to ${Math.round(most)} ms ${rushing ? "ahead of" : "behind"} the beat, then the rest put you back on it. ${
          rushing
            ? `Keep notes in a row as steady as the ${ctx.click}: count the beats and don't let them hurry you.`
            : `Keep notes in a row moving with the ${ctx.click} all the way to the rest.`
        }`,
        at: notes[worst.idx[0]].pos,
        gain: noteGain(why.count),
        claims: why.claims,
      });
    } else {
      model = () => median(ys);
    }
  }
  if (fit.drift && timedIdx.length >= 6) {
    const xFirst = exp[timedIdx[0]] - x0;
    const xLast = exp[timedIdx[timedIdx.length - 1]] - x0;
    const start = fit.f(xFirst);
    const change = fit.f(xLast) - start;
    const away = timedIdx.filter((i) => Math.sign(offsetOf(i) - start) === Math.sign(change) && Math.abs(offsetOf(i) - start) > tolMs);
    if (Math.abs(change) >= Math.max(60, 1.2 * tolMs) && away.length >= 2) {
      const rushing = change < 0;
      const begin = timedIdx.find((i) => Math.abs(fit.f(exp[i] - x0) - start) > tolMs / 2) ?? timedIdx[0];
      const from = measureOf(notes[begin].pos);
      // The tempo by the end, from how fast the offset was changing there.
      const slope = (fit.f(xLast) - fit.f(xLast - 0.5)) / 0.5 / 1000;
      const endBpm = Math.round(input.bpm / (1 + slope));
      const tempoText = Math.abs(endBpm - input.bpm) >= 3 ? ` (from ${input.bpm} to about ${endBpm} BPM)` : "";
      const why = explainedBy(fit.f);
      drifting = true;
      evidence.push({
        kind: rushing ? "rushing" : "dragging",
        area: "steady",
        text: `You ${rushing ? "sped up" : "slowed down"} ${from > 1 ? `from measure ${from}` : "as you went"}${tempoText}: by the end you were ${Math.round(
          Math.abs(change),
        )} ms ${rushing ? "ahead of" : "behind"} the beat. ${
          input.metronome
            ? `Listen for the click on every beat and ${rushing ? "let it lead you" : "keep up with it"}.`
            : `Without the click, tap your foot to keep the beat ${rushing ? "from running ahead" : "moving"}.`
        }`,
        at: notes[begin].pos,
        gain: noteGain(why.count),
        claims: why.claims,
      });
    } else {
      model = () => median(ys);
    }
  }
  if (!drifting && ys.length >= 4) {
    // Always a little early or late, all the way through.
    const med = median(ys);
    const side = ys.filter((y) => Math.sign(y) === Math.sign(med) && Math.abs(y) >= 15).length;
    const off = notes
      .map((n, i) => ({ n, i }))
      .filter(
        ({ n }) => (n.status === "early" || n.status === "late") && Math.sign(n.offsetMs!) === Math.sign(med) && n.pos < cutPos - 1e-6,
      );
    if (Math.abs(med) >= 35 && side >= 0.7 * ys.length && off.length) {
      const early = med < 0;
      const what = activity.sing ? "Your notes" : activity.claps ? "Your claps" : "Your counts";
      evidence.push({
        kind: early ? "early" : "late",
        area: "steady",
        text: `${what} came a little ${early ? "before" : "after"} the beat all the way through (about ${Math.round(Math.abs(med))} ms). ${
          early
            ? `Wait for the ${ctx.click} and ${noun} with it, not ahead of it.`
            : `Get ready just before each beat so you ${noun} right on it.`
        }`,
        at: notes[timedIdx[0]].pos,
        gain: noteGain(off.length),
        // (Only the notes the offset fully explains; one far beyond it is its own problem.)
        claims: off.filter(({ i }) => paired[i] !== null && Math.abs(offsetOf(i) - med) <= tolMs).map(({ i }) => `n${i}`),
      });
    }
    model = () => med;
  }

  return { evidence, timing: { paired, cutK, cutPos, timedIdx, offsetOf, model, tolMs } };
};
