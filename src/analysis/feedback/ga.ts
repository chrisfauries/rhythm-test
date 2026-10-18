import { Ctx } from "./context";
import { Evidence, Feedback, Tip } from "./types";

// The general algorithm: takes all the detectors' evidence and distills it
// into what the student reads. Ranks each piece by how much of the score it
// would win back, weighted by how much it explains; drops evidence that
// something stronger already explains; picks the top tip and a few more; and
// says in a few words why each score isn't 100%. A clean take gets praise and
// a next step instead.

/** How much each explanation is worth, per point of score it accounts for. */
export const WEIGHT: Record<string, number> = {
  "no-claps": 100,
  "no-voice": 100,
  "added-beat": 3,
  "skipped-beat": 3,
  "late-start": 3,
  "early-start": 3,
  restart: 3,
  "gave-up": 3,
  stopped: 2.5,
  morph: 2.0,
  "cut-short": 2.0,
  "late-entrance": 1.8,
  "tie-clap": 1.6,
  "held-beat-clap": 1.6,
  "sub-words": 1.5,
  forward: 1.0,
  rushing: 2.2,
  "rushing-runs": 2.2,
  "dragging-runs": 2.2,
  dragging: 2.2,
  early: 1.6,
  late: 1.6,
  figure: 1.8,
  "wrong-numbers": 1.6,
  "held-counts": 1.4,
  "rest-counts": 1.4,
  "silent-rests": 1.3,
  "count-timing": 1.2,
  missed: 1.2,
  holds: 1.2,
  sustain: 1.2,
  pulses: 1.1,
  extra: 1.0,
  timing: 1.0,
  "extra-words": 1.0,
  quiet: 0.8,
};

/** Evidence mostly explained by something ranked above it adds nothing. */
const OVERLAP = 0.5;

export const distill = (ctx: Ctx, evidence: Evidence[]): Feedback => {
  const { summary, noteArea, input, noun } = ctx;
  const ranked = evidence
    .filter((e) => e.gain > 0 || e.kind.startsWith("no-"))
    .map((e) => ({ e, rank: e.gain * (WEIGHT[e.kind] ?? 1) }))
    .sort((a, b) => b.rank - a.rank);
  const explained = new Set<string>();
  const tips: Tip[] = [];
  for (const { e, rank } of ranked) {
    const claims = e.claims ?? [];
    if (claims.length && claims.filter((c) => explained.has(c)).length >= OVERLAP * claims.length) continue;
    claims.forEach((c) => explained.add(c));
    tips.push({ kind: e.kind, area: e.area, text: e.text, at: e.at, gain: e.gain, rank });
  }

  const reasons: Feedback["reasons"] = {};
  for (const area of ["notes", "counts", "hands"] as const) {
    const score = area === "notes" ? summary.clapScore : area === "counts" ? summary.countScore : summary.holdScore;
    if (score === null || score >= 0.995) continue;
    const t = tips.find((x) => x.area === area || (area === noteArea && x.area === "steady"));
    if (t) reasons[area] = reasonText(t);
  }
  const useful = tips.filter((t) => t.gain >= 0.005 || t.kind.startsWith("no-"));
  if (!useful.length) {
    const next = Math.min(200, Math.round((input.bpm + 8) / 4) * 4);
    return {
      top: {
        kind: "praise",
        area: "steady",
        text:
          summary.overall >= 0.95
            ? input.metronome
              ? `Rock solid! Ready for more? Try it at ${next} BPM, or turn off the click while you perform (Settings) and keep the beat yourself.`
              : `Rock solid, even without the click! Try it at ${next} BPM.`
            : `Nice and steady! Try it once more and aim for every ${noun} right on the beat.`,
        gain: 0,
        rank: 0,
      },
      more: [],
      reasons,
    };
  }
  return { top: useful[0], more: useful.slice(1, 4), reasons };
};

/** A few words for under a score. */
const reasonText = (t: Tip) => {
  const short: Record<string, string> = {
    "added-beat": "an added beat shifted the rest",
    "skipped-beat": "a skipped beat shifted the rest",
    "late-start": "came in a beat late",
    "early-start": "came in a beat early",
    restart: "started over",
    "gave-up": "stopped before the end",
    stopped: "stopped partway",
    morph: "a rhythm played as another",
    "cut-short": "long notes cut short",
    "late-entrance": "came in late",
    "tie-clap": "clapped a tied note",
    "held-beat-clap": "clapped during long notes",
    "sub-words": "wrong subdivision words",
    forward: "hands not pushed forward",
    rushing: "sped up",
    dragging: "slowed down",
    "rushing-runs": "sped up through notes in a row",
    "dragging-runs": "slowed down through notes in a row",
    early: "a little early throughout",
    late: "a little late throughout",
    "wrong-numbers": "wrong counts",
    "held-counts": "long notes not counted through",
    "rest-counts": "rests not counted",
    "silent-rests": "counted on rests",
    "count-timing": "counts not with the claps",
    holds: "hands came apart early",
    sustain: "long notes stopped early",
    pulses: "rests not pulsed",
    extra: "extra claps",
    "extra-words": "extra words",
    quiet: "claps too quiet",
    timing: "a few early or late",
  };
  if (t.kind === "figure") return t.text.replace(/^Your (.*?) came (early|late).*$/, "$1 $2");
  if (t.kind === "missed") return t.text.startsWith("I didn't hear") ? "counts not heard" : "missed notes";
  return short[t.kind] ?? "";
};
