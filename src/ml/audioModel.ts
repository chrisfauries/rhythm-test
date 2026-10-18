import { FRAME_SEC, melFrames, N_MELS, toFeatureRate } from "./features";

// The audio model: one network for everything the microphone hears. It reads
// a whole take's log-mel frames (features.ts) and says, for every 10 ms frame,
//   - does a clap start here?
//   - does a voiced sound (a spoken count, a sung "Da") start here, and which
//     word is it?
//   - is someone voicing here (for held sung notes)?
// events() turns that into the event lists the grader takes: clap times,
// words with times, sung onsets and voiced spans. Trained in
// ml/train_audio.py; this runs its weights in plain TypeScript.

interface Conv2dLayer {
  type: "conv2d"; // 3x3, same padding, ReLU, over [channel][time][mel]
  inC: number;
  outC: number;
  w: string; // base64 float32 [outC][inC][3][3]
  b: string;
}
interface PoolFreqLayer {
  type: "poolf"; // max pool 2 along the mel axis only (time resolution is kept)
}
interface FlattenLayer {
  type: "flatten"; // [channel][time][mel] -> [channel*mel][time]
}
interface Conv1dLayer {
  type: "conv1d"; // over time, same padding
  inC: number;
  outC: number;
  k: number;
  dil: number;
  relu: boolean;
  /** Add the input back (inC === outC). */
  residual: boolean;
  w: string; // base64 float32 [outC][inC][k]
  b: string;
}
type Layer = Conv2dLayer | PoolFreqLayer | FlattenLayer | Conv1dLayer;

export interface AudioModelFile {
  format: "rhythm-tester-audio-model";
  version: number;
  mels: number;
  frameSec: number;
  /** Output channels: 0 clap onset, 1 voice onset, 2 voicing, then one per word. */
  words: string[];
  thresholds: { clap: number; onset: number; voiced: number };
  trainedOn?: string;
  layers: Layer[];
}

export interface AudioClap {
  /** Seconds into the audio given to events(). */
  time: number;
  conf: number;
}
export interface AudioOnset {
  time: number;
  conf: number;
  /** Best word ("one", "and", "la", ..., or "sing" for a sung syllable). */
  word: string;
  wordConf: number;
  probs: Record<string, number>;
}
export interface AudioEvents {
  claps: AudioClap[];
  /** Every voiced onset, spoken or sung. */
  onsets: AudioOnset[];
  voicedSpans: [number, number][];
}

/** The network's per-frame outputs (probabilities). */
export interface AudioFrames {
  frames: number;
  clap: Float32Array;
  onset: Float32Array;
  voiced: Float32Array;
  /** [frame][word] softmax. */
  words: Float32Array;
}

const f32 = (b64: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
};

type Loaded =
  | {
      type: "conv2d";
      inC: number;
      outC: number;
      w: Float32Array;
      b: Float32Array;
    }
  | { type: "poolf" }
  | { type: "flatten" }
  | {
      type: "conv1d";
      inC: number;
      outC: number;
      k: number;
      dil: number;
      relu: boolean;
      residual: boolean;
      w: Float32Array;
      b: Float32Array;
    };

/** 3x3 conv + ReLU over [c][t][f]. */
const conv2d = (x: Float32Array, inC: number, T: number, F: number, outC: number, W: Float32Array, B: Float32Array) => {
  const out = new Float32Array(outC * T * F);
  for (let o = 0; o < outC; o++) {
    const ob = o * T * F;
    out.fill(B[o], ob, ob + T * F);
    for (let c = 0; c < inC; c++) {
      const xb = c * T * F;
      for (let ky = 0; ky < 3; ky++) {
        const dy = ky - 1;
        for (let kx = 0; kx < 3; kx++) {
          const k = W[((o * inC + c) * 3 + ky) * 3 + kx];
          if (k === 0) continue;
          const dx = kx - 1;
          const f0 = Math.max(0, -dx);
          const f1 = Math.min(F, F - dx);
          for (let t = Math.max(0, -dy); t < Math.min(T, T - dy); t++) {
            const row = ob + t * F;
            const src = xb + (t + dy) * F + dx;
            for (let f = f0; f < f1; f++) out[row + f] += k * x[src + f];
          }
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
  return out;
};

const poolFreq = (x: Float32Array, C: number, T: number, F: number) => {
  const H = Math.floor(F / 2);
  const out = new Float32Array(C * T * H);
  for (let c = 0; c < C; c++) {
    for (let t = 0; t < T; t++) {
      const s = (c * T + t) * F;
      const d = (c * T + t) * H;
      for (let h = 0; h < H; h++) out[d + h] = Math.max(x[s + 2 * h], x[s + 2 * h + 1]);
    }
  }
  return out;
};

/** [c][t][f] -> [c*F + f][t]. */
const flatten = (x: Float32Array, C: number, T: number, F: number) => {
  const out = new Float32Array(C * F * T);
  for (let c = 0; c < C; c++) for (let t = 0; t < T; t++) for (let f = 0; f < F; f++) out[(c * F + f) * T + t] = x[(c * T + t) * F + f];
  return out;
};

const conv1d = (x: Float32Array, T: number, l: Extract<Loaded, { type: "conv1d" }>) => {
  const { inC, outC, k: K, dil, w: W, b: B } = l;
  const pad = (dil * (K - 1)) / 2;
  const out = new Float32Array(outC * T);
  for (let o = 0; o < outC; o++) {
    const ob = o * T;
    out.fill(B[o], ob, ob + T);
    for (let c = 0; c < inC; c++) {
      const xb = c * T;
      for (let k = 0; k < K; k++) {
        const w = W[(o * inC + c) * K + k];
        if (w === 0) continue;
        const shift = k * dil - pad;
        const t0 = Math.max(0, -shift);
        const t1 = Math.min(T, T - shift);
        for (let t = t0; t < t1; t++) out[ob + t] += w * x[xb + t + shift];
      }
    }
  }
  if (l.relu) for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
  if (l.residual) for (let i = 0; i < out.length; i++) out[i] += x[i];
  return out;
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** Local maxima at or above `thr`, at least `gap` frames apart (the higher one wins). */
export const peaks = (p: Float32Array, thr: number, gap: number): number[] => {
  const cand: number[] = [];
  for (let i = 0; i < p.length; i++) {
    if (p[i] < thr) continue;
    if (i > 0 && p[i - 1] > p[i]) continue;
    if (i + 1 < p.length && p[i + 1] >= p[i]) continue;
    cand.push(i);
  }
  cand.sort((a, b) => p[b] - p[a]);
  const kept: number[] = [];
  for (const i of cand) if (kept.every((j) => Math.abs(i - j) >= gap)) kept.push(i);
  return kept.sort((a, b) => a - b);
};

/** Sub-frame position of a peak (parabola through it and its neighbors), in frames. */
const refine = (p: Float32Array, i: number) => {
  if (i <= 0 || i + 1 >= p.length) return i;
  const [a, b, c] = [p[i - 1], p[i], p[i + 1]];
  const d = a - 2 * b + c;
  return d < 0 ? i + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : i;
};

/** Minimum spacing of two claps / two voice onsets (a 16th at 200 bpm is 75 ms). */
const CLAP_GAP = 5;
const ONSET_GAP = 6;

export class AudioModel {
  private readonly layers: Loaded[];

  constructor(readonly file: AudioModelFile) {
    if (file.mels !== N_MELS || Math.abs(file.frameSec - FRAME_SEC) > 1e-9) {
      throw new Error(`Audio model expects ${file.mels} mels every ${file.frameSec}s, features give ${N_MELS} every ${FRAME_SEC}s`);
    }
    this.layers = file.layers.map((l) => (l.type === "conv2d" || l.type === "conv1d" ? { ...l, w: f32(l.w), b: f32(l.b) } : l)) as Loaded[];
  }

  /** Per-frame probabilities for log-mel frames from melFrames(). */
  run(mel: { frames: number; data: Float32Array }): AudioFrames {
    const T = mel.frames;
    // Start as [1][T][F]: melFrames is [t][f] already.
    let x = mel.data;
    let C = 1;
    let F = N_MELS;
    let flat = false;
    for (const l of this.layers) {
      if (l.type === "conv2d") {
        x = conv2d(x, C, T, F, l.outC, l.w, l.b);
        C = l.outC;
      } else if (l.type === "poolf") {
        x = poolFreq(x, C, T, F);
        F = Math.floor(F / 2);
      } else if (l.type === "flatten") {
        x = flatten(x, C, T, F);
        C *= F;
        F = 1;
        flat = true;
      } else {
        if (!flat) throw new Error("conv1d before flatten");
        x = conv1d(x, T, l);
        C = l.outC;
      }
    }
    const nw = this.file.words.length;
    const clap = new Float32Array(T);
    const onset = new Float32Array(T);
    const voiced = new Float32Array(T);
    const words = new Float32Array(T * nw);
    for (let t = 0; t < T; t++) {
      clap[t] = sigmoid(x[t]);
      onset[t] = sigmoid(x[T + t]);
      voiced[t] = sigmoid(x[2 * T + t]);
      let max = -Infinity;
      for (let w = 0; w < nw; w++) max = Math.max(max, x[(3 + w) * T + t]);
      let sum = 0;
      for (let w = 0; w < nw; w++) sum += words[t * nw + w] = Math.exp(x[(3 + w) * T + t] - max);
      for (let w = 0; w < nw; w++) words[t * nw + w] /= sum;
    }
    return { frames: T, clap, onset, voiced, words };
  }

  /** Events from per-frame outputs; times are seconds into the audio. */
  eventsFrom(out: AudioFrames): AudioEvents {
    const { clap: thrClap, onset: thrOnset, voiced: thrVoiced } = this.file.thresholds;
    const words = this.file.words;
    const nw = words.length;
    const sec = this.file.frameSec;
    const claps = peaks(out.clap, thrClap, CLAP_GAP).map((i) => ({
      time: refine(out.clap, i) * sec,
      conf: out.clap[i],
    }));
    const onsets = peaks(out.onset, thrOnset, ONSET_GAP).map((i) => {
      // The word: the onset frame and its neighbors, averaged.
      const probs: Record<string, number> = {};
      let n = 0;
      const p = new Float32Array(nw);
      for (let t = Math.max(0, i - 1); t <= Math.min(out.frames - 1, i + 1); t++, n++)
        for (let w = 0; w < nw; w++) p[w] += out.words[t * nw + w];
      let best = 0;
      for (let w = 0; w < nw; w++) {
        p[w] /= n;
        probs[words[w]] = p[w];
        if (p[w] > p[best]) best = w;
      }
      return {
        time: refine(out.onset, i) * sec,
        conf: out.onset[i],
        word: words[best],
        wordConf: p[best],
        probs,
      };
    });
    // Voicing: runs above threshold, bridging 1-2 frame gaps, at least 40 ms long.
    const voicedSpans: [number, number][] = [];
    let start = -1;
    let last = -1;
    for (let t = 0; t <= out.frames; t++) {
      const on = t < out.frames && out.voiced[t] >= thrVoiced;
      if (on) {
        if (start < 0) start = t;
        last = t;
      } else if (start >= 0 && t - last > 2) {
        if (last - start + 1 >= 4) voicedSpans.push([start * sec, (last + 1) * sec]);
        start = -1;
      }
    }
    return { claps, onsets, voicedSpans };
  }

  /** Everything the model hears in a recording at FEATURE_RATE (features.ts). */
  events(x16: Float32Array): AudioEvents {
    return this.eventsFrom(this.run(melFrames(x16)));
  }
}

let loading: Promise<AudioModel | null> | null = null;

/** Loads public/models/audio.json once (null if it isn't there). */
export const loadAudioModel = () => {
  if (!loading) {
    loading = fetch(`${process.env.PUBLIC_URL}/models/audio.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f: AudioModelFile | null) => (f ? new AudioModel(f) : null))
      .catch((err) => {
        console.warn("Audio model not available:", err);
        return null;
      });
  }
  return loading;
};

/** What the grader takes from the audio model (see analysis/analyze.ts TakeInput). */
export interface ModelGraderInput {
  claps: number[];
  words: { word: string; label: string; time: number }[];
  sungOnsets: number[];
  voicedSpans: [number, number][];
}

/**
 * Runs the model on a take's recording and moves its events onto the grader's
 * clock: claps by the mic delay, voice onsets (vowel starts, like the voicing
 * rules give) by the speech delay. `t0` is the clock time of the recording's
 * first sample.
 */
export const modelGraderInput = (
  model: AudioModel,
  data: Float32Array,
  sampleRate: number,
  t0: number,
  offsets: { mic: number; speech: number },
): { input: ModelGraderInput; events: AudioEvents } => {
  const events = model.events(toFeatureRate(data, sampleRate));
  const heard = (t: number) => t0 + t - offsets.mic;
  const spoken = (t: number) => t0 + t - offsets.speech;
  return {
    events,
    input: {
      claps: events.claps.map((c) => heard(c.time)),
      words: events.onsets.filter((o) => o.word !== "sing").map((o) => ({ word: o.word, label: o.word, time: spoken(o.time) })),
      // Singing: every voice onset is a sung note, whatever word it sounded most like.
      sungOnsets: events.onsets.map((o) => spoken(o.time)),
      voicedSpans: events.voicedSpans.map(([s, e]): [number, number] => [spoken(s), spoken(e)]),
    },
  };
};
