import { TOOLS } from "../state/tools";

// Which models the app uses (Settings → Tools, or ?model= in the URL). The
// audio model (ml/audioModel.ts) grades by default; "rules" goes back to the
// clap detector, voicing rules and Vosk, optionally with the old count-word model.
export const USE_AUDIO_MODEL = TOOLS.grader === "model";

export const USE_COUNT_MODEL = !USE_AUDIO_MODEL && TOOLS.countModel;

/**
 * How grading trusts the count model. Chosen on held-out takes to almost never
 * mark a correct count wrong. Model v4: of 312 counts said correctly under a
 * clap, 91% were confirmed and none marked wrong; of simulated wrong numbers,
 * 49% were caught, 43% left on timing-only credit, 9% slipped through.
 */
export const COUNT_MODEL_RULE = { confirmAbove: 0.4, wrongAbove: 0.8, expectedBelow: 0.08 };
