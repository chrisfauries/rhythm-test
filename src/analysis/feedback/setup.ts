import { Ctx } from "./context";
import { Evidence } from "./types";

// Nothing heard at all: fix the setup (microphone, distance) before anything else.
export const setup = (ctx: Ctx): Evidence[] => {
  const { notes, counts, result, activity } = ctx;
  const out: Evidence[] = [];
  const heardNotes = notes.filter((n) => n.status !== "missed").length + result.extraClaps.length;
  if ((activity.claps || activity.sing) && notes.length >= 3 && heardNotes === 0) {
    out.push({
      kind: "no-claps",
      area: "setup",
      text: activity.sing
        ? "I couldn't hear you singing. Sing out on “Da”, and check that the right microphone is chosen in Settings."
        : "I couldn't hear any claps. Clap closer to the microphone, and check that the right one is chosen in Settings.",
      gain: 1,
    });
  }
  if (activity.countMode && counts.length >= 3 && counts.every((c) => c.status === "missed") && !result.extraWords.length) {
    out.push({
      kind: "no-voice",
      area: "setup",
      text: "I couldn't hear your counting. Count out loud, clearly, and check that the right microphone is chosen in Settings.",
      gain: 1,
    });
  }
  return out;
};
