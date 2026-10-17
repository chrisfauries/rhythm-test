import { melPatch, N_MELS, PATCH_FRAMES } from "./features";

// The count-word model: a small CNN over a log-mel patch around an expected
// count, saying which count word (or "none") was spoken there. Trained in
// ml/train.py; its weights are a JSON file that this runs in plain
// TypeScript (no ML library needed in the browser).

interface ConvLayer {
  type: "conv";
  inC: number;
  outC: number;
  w: string; // base64 float32 [outC][inC][3][3]
  b: string; // base64 float32 [outC]
}
interface PoolLayer {
  type: "pool"; // 2x2 max pool
}
interface GapLayer {
  type: "gap"; // global average pool
}
interface LinearLayer {
  type: "linear";
  in: number;
  out: number;
  w: string; // base64 float32 [out][in]
  b: string;
}
type Layer = ConvLayer | PoolLayer | GapLayer | LinearLayer;

export interface CountModelFile {
  format: "rhythm-tester-count-model";
  version: number;
  classes: string[];
  frames: number;
  mels: number;
  trainedOn?: string;
  layers: Layer[];
}

export interface CountPrediction {
  label: string;
  conf: number;
  probs: Record<string, number>;
}

const f32 = (b64: string) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
};

type Tensor = { c: number; h: number; w: number; d: Float32Array };

const conv3 = (x: Tensor, inC: number, outC: number, W: Float32Array, B: Float32Array): Tensor => {
  const { h, w } = x;
  const out = new Float32Array(outC * h * w);
  for (let o = 0; o < outC; o++) {
    const ob = o * h * w;
    for (let i = 0; i < h * w; i++) out[ob + i] = B[o];
    for (let c = 0; c < inC; c++) {
      const xb = c * h * w;
      for (let ky = 0; ky < 3; ky++) {
        for (let kx = 0; kx < 3; kx++) {
          const k = W[((o * inC + c) * 3 + ky) * 3 + kx];
          if (k === 0) continue;
          const dy = ky - 1;
          const dx = kx - 1;
          for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
            const row = ob + y * w;
            const src = xb + (y + dy) * w + dx;
            for (let xx = Math.max(0, -dx); xx < Math.min(w, w - dx); xx++) out[row + xx] += k * x.d[src + xx];
          }
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
  return { c: outC, h, w, d: out };
};

const pool2 = (x: Tensor): Tensor => {
  const h = Math.floor(x.h / 2);
  const w = Math.floor(x.w / 2);
  const out = new Float32Array(x.c * h * w);
  for (let c = 0; c < x.c; c++) {
    for (let y = 0; y < h; y++) {
      for (let xx = 0; xx < w; xx++) {
        const b = c * x.h * x.w + 2 * y * x.w + 2 * xx;
        out[c * h * w + y * w + xx] = Math.max(x.d[b], x.d[b + 1], x.d[b + x.w], x.d[b + x.w + 1]);
      }
    }
  }
  return { c: x.c, h, w, d: out };
};

export class CountModel {
  private readonly layers: (
    | { type: "conv"; inC: number; outC: number; w: Float32Array; b: Float32Array }
    | { type: "pool" }
    | { type: "gap" }
    | { type: "linear"; in: number; out: number; w: Float32Array; b: Float32Array }
  )[];
  readonly classes: string[];

  constructor(readonly file: CountModelFile) {
    if (file.frames !== PATCH_FRAMES || file.mels !== N_MELS) {
      throw new Error(`Model expects ${file.frames}x${file.mels} patches, features give ${PATCH_FRAMES}x${N_MELS}`);
    }
    this.classes = file.classes;
    this.layers = file.layers.map((l) =>
      l.type === "conv" || l.type === "linear" ? { ...l, w: f32(l.w), b: f32(l.b) } : l
    ) as CountModel["layers"];
  }

  /** Raw class probabilities for one patch from melPatch(). */
  probs(patch: Float32Array): Float32Array {
    let x: Tensor = { c: 1, h: PATCH_FRAMES, w: N_MELS, d: patch };
    let v: Float32Array | null = null;
    for (const l of this.layers) {
      if (l.type === "conv") x = conv3(x, l.inC, l.outC, l.w, l.b);
      else if (l.type === "pool") x = pool2(x);
      else if (l.type === "gap") {
        v = new Float32Array(x.c);
        const n = x.h * x.w;
        for (let c = 0; c < x.c; c++) {
          let s = 0;
          for (let i = 0; i < n; i++) s += x.d[c * n + i];
          v[c] = s / n;
        }
      } else {
        const inp = v!;
        const out = new Float32Array(l.out);
        for (let o = 0; o < l.out; o++) {
          let s = l.b[o];
          for (let i = 0; i < l.in; i++) s += l.w[o * l.in + i] * inp[i];
          out[o] = s;
        }
        v = out;
      }
    }
    const logits = v!;
    const max = Math.max(...Array.from(logits));
    const e = Array.from(logits, (z) => Math.exp(z - max));
    const sum = e.reduce((a, b) => a + b, 0);
    return Float32Array.from(e, (z) => z / sum);
  }

  /** Which count word was said around `anchor` seconds into the 16 kHz audio. */
  predict(x16: Float32Array, anchor: number): CountPrediction {
    const p = this.probs(melPatch(x16, anchor));
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    const probs: Record<string, number> = {};
    this.classes.forEach((c, i) => (probs[c] = p[i]));
    return { label: this.classes[best], conf: p[best], probs };
  }
}

let loading: Promise<CountModel | null> | null = null;

/** Loads public/models/counts.json once (null if it isn't there). */
export const loadCountModel = () => {
  if (!loading) {
    loading = fetch(`${process.env.PUBLIC_URL}/models/counts.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((f: CountModelFile | null) => (f ? new CountModel(f) : null))
      .catch((err) => {
        console.warn("Count model not available:", err);
        return null;
      });
  }
  return loading;
};
