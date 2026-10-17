// Which models the app uses (A/B testing): ?model=counts turns on the
// count-word model for counts the clap's echo hides from speech recognition.
const models = (new URLSearchParams(window.location.search).get("model") ?? "").split(",");

export const USE_COUNT_MODEL = models.includes("counts");

/**
 * How grading trusts the count model (chosen on held-out takes: of counts
 * said correctly under a clap, none were marked wrong; of simulated wrong
 * numbers, 79% were caught).
 */
export const COUNT_MODEL_RULE = { confirmAbove: 0.4, wrongAbove: 0.5, expectedBelow: 0.2 };
