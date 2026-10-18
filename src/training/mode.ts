import { TOOLS } from "../state/tools";

// Training mode (Settings → Tools, or ?training in the URL): adds a "Capture"
// button after each take that saves everything about it (audio, video,
// metronome, detections, grading) as one zip, for labeling and model training.
export const TRAINING = TOOLS.training;

/** Capture zip format, bumped whenever its contents change shape. */
export const CAPTURE_FORMAT_VERSION = 1;
