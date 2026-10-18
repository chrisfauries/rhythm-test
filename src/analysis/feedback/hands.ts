import { Ctx, measuresText } from "./context";
import { Evidence } from "./types";

// Hands (or voice) through long notes and rests: holds, singing through long
// notes, silent claps on rests.

export const hands = (ctx: Ctx): Evidence[] => {
  const { notes, result, activity, measureOf, share } = ctx;
  const out: Evidence[] = [];
  const released = notes.filter((n) => n.hold?.status === "released");
  const holdsKnown = notes.filter((n) => n.hold && n.hold.status !== "unknown").length;
  const pulsesKnown = result.rests?.filter((r) => r.status !== "unknown") ?? [];
  const motions = holdsKnown + pulsesKnown.length;
  if (released.length) {
    out.push({
      kind: activity.sing ? "sustain" : "holds",
      area: "hands",
      text: activity.sing
        ? `Hold long notes all the way: your “Daaa” stopped early (${measuresText(released.map((n) => measureOf(n.pos)))}). Keep singing until the next note.`
        : `Keep your hands together for the whole long note (${measuresText(
            released.map((n) => measureOf(n.pos)),
          )}): they came apart early. Push them forward until the next note.`,
      at: released[0].pos,
      gain: share("hands", released.length, motions),
    });
  }
  // Long notes held but not moved: hands together and still, instead of pushing forward.
  // (Thresholds: below what Chris's own takes show; still uncalibrated against students.)
  const still = notes.filter((n) => n.hold?.status === "held" && n.hold.motion && n.hold.motion.dy < 0.15 && n.hold.motion.ds < 0.05);
  if (!activity.sing && still.length >= 2) {
    out.push({
      kind: "forward",
      area: "hands",
      text: `Push your hands forward through long notes (${measuresText(still.map((n) => measureOf(n.pos)))}): keep them together and move them away from you until the next note.`,
      at: still[0].pos,
      gain: share("hands", still.length * 0.5, motions),
    });
  }
  const noPulse = pulsesKnown.filter((r) => r.status === "missed");
  if (noPulse.length) {
    out.push({
      kind: "pulses",
      area: "hands",
      text: `Pulse your hands down on every rest (${measuresText(noPulse.map((r) => measureOf(r.pos)))}), and keep your hands where the camera can see them.`,
      at: noPulse[0].pos,
      gain: share("hands", noPulse.length, motions),
    });
  }
  return out;
};
