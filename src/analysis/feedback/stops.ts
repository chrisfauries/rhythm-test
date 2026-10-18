import { Ctx, measuresText } from "./context";
import { Evidence } from "./types";

// Stopping: the student gave up before the end, stopped and came back in, or
// stopped and started the line over. Each explains a stretch of missed notes
// (and, for a restart, the sounds after it) better than "you missed 12 claps".
// Runs in tier 1: notes after a restart or give-up can't be timed.

export interface Stops {
  evidence: Evidence[];
  /** Notes from here on aren't judged one by one. */
  cutK: number;
}

export const stops = (ctx: Ctx, paired: (number | null)[]): Stops => {
  const { notes, counts, exp, detected, win, skip, secPerBeat, measureSec, measureOf, noteGain, parts, activity } = ctx;
  const evidence: Evidence[] = [];
  const n = notes.length;
  const heard = paired.map((j) => j !== null);
  const playedIdx = heard.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
  if (n < 4 || playedIdx.length < 2) return { evidence, cutK: n };
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
  // Clapping and counting: if the voice carried on, the student didn't stop (the claps just weren't heard).
  const voiceIn = (a: number, b: number) =>
    parts.notes && parts.counts ? counts.some((c) => c.time !== undefined && c.time >= a - 0.05 && c.time <= b + 0.05) : false;
  const what = activity.sing ? "singing" : activity.claps ? "clapping" : "counting";

  // ---- Started over: the sounds after a stop match the start of the line ----
  const lastSound = detected[detected.length - 1] ?? 0;
  for (const j0 of detected.map((_, j) => j)) {
    const shift = detected[j0] - exp[0];
    if (shift < measureSec - 0.1) continue;
    // Something was played before it, and it isn't simply the next note.
    const before = playedIdx.filter((i) => detected[paired[i]!] < detected[j0] - 0.05);
    if (before.length < 2) continue;
    const resumeAt = before[before.length - 1] + 1;
    // Before stopping, the student was playing in time (else it's not a restart: e.g. the whole line a beat off).
    if (before.length < 0.7 * range(0, resumeAt).filter((i) => !skip[i]).length) continue;
    // A restart follows a pause: silence at least a beat longer than the music's own gap there.
    const silence = detected[j0] - (detected[j0 - 1] ?? -Infinity);
    const writtenGap = resumeAt < n ? exp[resumeAt] - exp[resumeAt - 1] : 0;
    if (silence < Math.max(1.5 * secPerBeat, writtenGap + secPerBeat)) continue;
    const usedHere = paired.slice(resumeAt).filter((j) => j !== null && j >= j0).length;
    // The line from note `from`, moved by `shift`, against the sounds from j0 on.
    const match = (from: number, shift: number) => {
      let last = j0 - 1;
      let matched = 0;
      let fits = 0;
      for (let i = from; i < n; i++) {
        const t = exp[i] + shift;
        if (t > lastSound + 0.3) break;
        if (skip[i]) continue;
        fits++;
        let j = -1;
        for (let k = last + 1; k < detected.length && detected[k] <= t + win[i]; k++) {
          if (Math.abs(detected[k] - t) <= win[i] && (j < 0 || Math.abs(detected[k] - t) < Math.abs(detected[j] - t))) j = k;
        }
        if (j >= 0) {
          matched++;
          last = j;
        }
      }
      return { matched, fits };
    };
    // Starting over has to explain the sounds clearly better than carrying on
    // in time with the beat (as the tempo-follower paired them), and at least
    // as well as carrying on from the next note after the pause (on a line
    // whose measures repeat they look alike; with the click going, a student
    // who carries on comes back in time, so a tie is a restart).
    const again = match(0, shift);
    const carryOn = resumeAt < n ? match(resumeAt, detected[j0] - exp[resumeAt]).matched : 0;
    if (again.matched >= 6 && again.matched >= 0.75 * again.fits && again.matched >= usedHere + 3 && again.matched >= carryOn) {
      const cutK = resumeAt;
      const at = notes[Math.min(cutK, n - 1)].pos;
      evidence.push({
        kind: "restart",
        area: "steady",
        text: `You stopped and started over in measure ${measureOf(at)}. Next time keep going instead: even after a mistake, come back in on the next note and finish the line.`,
        at,
        gain: noteGain(notes.slice(cutK).filter((x) => x.status !== "on-time").length),
        claims: [...range(cutK, n).map((i) => `n${i}`), ...range(j0, detected.length).map((j) => `s${j}`)],
      });
      return { evidence, cutK };
    }
  }

  // ---- Gave up: nothing from some note to the end -------------------------
  const lastPlayed = playedIdx[playedIdx.length - 1];
  const tail = range(lastPlayed + 1, n).filter((i) => !skip[i]);
  const tailSec = tail.length ? exp[n - 1] - exp[lastPlayed + 1] + secPerBeat : 0;
  const lateSounds = detected.some((d) => d > exp[lastPlayed] + 1.5 * secPerBeat);
  if (tail.length >= 3 && tailSec >= Math.min(measureSec, 4 * secPerBeat) && !lateSounds && !voiceIn(exp[lastPlayed + 1], exp[n - 1])) {
    const at = notes[lastPlayed + 1].pos;
    evidence.push({
      kind: "gave-up",
      area: "steady",
      text: `You stopped ${what} in measure ${measureOf(at)}. Keep going to the end, even after a mistake: finishing the line matters more than a perfect start.`,
      at,
      gain: noteGain(tail.length),
      claims: tail.map((i) => `n${i}`),
    });
    return { evidence, cutK: lastPlayed + 1 };
  }

  // ---- Stopped and came back: a silent stretch, then on with the line --------
  const gaps: { from: number; to: number }[] = [];
  for (let k = 0; k + 1 < playedIdx.length; k++) {
    const a = playedIdx[k];
    const b = playedIdx[k + 1];
    const missing = range(a + 1, b).filter((i) => !skip[i] && notes[i].status === "missed");
    // More than a measure with nothing where three or more notes should be (two missed claps aren't a stop).
    if (missing.length < 3 || exp[b] - exp[a] < Math.max(3 * secPerBeat, measureSec + secPerBeat) - 1e-6) continue;
    if (voiceIn(exp[a + 1], exp[b - 1])) continue;
    gaps.push({ from: a + 1, to: b });
  }
  if (gaps.length) {
    const all = gaps.flatMap((g) => range(g.from, g.to));
    const g = gaps[0];
    const backIn = measureOf(notes[g.to].pos);
    const stoppedIn = measureOf(notes[g.from].pos);
    evidence.push({
      kind: "stopped",
      area: "steady",
      text:
        gaps.length === 1
          ? `You stopped in measure ${stoppedIn}${backIn !== stoppedIn ? ` and came back in measure ${backIn}` : ""}. Keep going even when something goes wrong: keep counting in your head and come back in on the next note.`
          : `You stopped a few times (${measuresText(gaps.map((x) => measureOf(notes[x.from].pos)))}). Keep going even when something goes wrong: keep counting in your head and come back in on the next note.`,
      at: notes[g.from].pos,
      gain: noteGain(all.length),
      claims: all.map((i) => `n${i}`),
    });
  }
  return { evidence, cutK: n };
};
