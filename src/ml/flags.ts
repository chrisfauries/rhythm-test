// Which models the app uses (A/B testing): ?model=counts turns on the
// count-word model for counts the clap's echo hides from speech recognition.
const models = (new URLSearchParams(window.location.search).get("model") ?? "").split(",");

export const USE_COUNT_MODEL = models.includes("counts");

/**
 * How grading trusts the count model. Chosen on held-out takes to almost never
 * mark a correct count wrong. Model v4: of 312 counts said correctly under a
 * clap, 91% were confirmed and none marked wrong; of simulated wrong numbers,
 * 49% were caught, 43% left on timing-only credit, 9% slipped through.
 */
export const COUNT_MODEL_RULE = { confirmAbove: 0.4, wrongAbove: 0.8, expectedBelow: 0.08 };
