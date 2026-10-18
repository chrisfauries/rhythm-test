// Developer tools, chosen in Settings → Tools and remembered in this browser.
// URL params still work and win: ?model=rules / ?model=rules,counts, ?training.
// Read once at load; changing one reloads the page.

export interface Tools {
  /** What grades a take: the audio model, or the clap detector, voicing rules and Vosk. */
  grader: "model" | "rules";
  /** With the rules: the old count-word model for counts hidden under claps. */
  countModel: boolean;
  /** Training mode: a "Capture" button after each take. */
  training: boolean;
}

const KEY = "rhythm-tester-tools";
const DEFAULTS: Tools = { grader: "model", countModel: false, training: false };

const stored = (): Tools => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
};

const params = new URLSearchParams(window.location.search);
const models = params.get("model")?.split(",") ?? null;

/** The tools as saved, ignoring URL params (what Settings shows). */
export const SAVED_TOOLS = stored();

/** The tools in effect for this page load. */
export const TOOLS: Tools = {
  grader: models ? (models.includes("rules") ? "rules" : "model") : SAVED_TOOLS.grader,
  countModel: models ? models.includes("counts") : SAVED_TOOLS.countModel,
  training: params.has("training") || SAVED_TOOLS.training,
};

/** Whether a URL param is overriding a saved choice right now. */
export const URL_OVERRIDES = {
  grader: models !== null,
  training: params.has("training"),
};

export const saveTools = (patch: Partial<Tools>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...SAVED_TOOLS, ...patch }));
  } catch {
    // Private window or blocked storage: the URL params still work.
  }
  window.location.reload();
};

/** Opens another page of the app (?label, ?results, ?collect) in a new tab. */
export const openPage = (page: "label" | "results" | "collect") => window.open(`${window.location.pathname}?${page}`, "_blank");
