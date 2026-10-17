import { createModel, Model } from "vosk-browser";

// Same approach as the flash-cards app: the model ships in /public, is
// downloaded once with progress, and cached in Cache Storage so later visits
// (and offline use) skip the download.

export enum ModelStatus {
  NOT_STARTED = "Preparing...",
  DOWNLOADING = "Downloading...",
  INITIALIZING = "Initializing...",
  READY = "Ready!",
  ERROR = "Error...",
}

export interface ModelState {
  status: ModelStatus;
  progress: number;
  error: string | null;
  model: Model | null;
}

const CACHE_NAME = "vosk-model-v1";
const MODEL_URL = `${process.env.PUBLIC_URL || "."}/model.tar.gz`;

let state: ModelState = {
  status: ModelStatus.NOT_STARTED,
  progress: 0,
  error: null,
  model: null,
};
const listeners = new Set<(s: ModelState) => void>();
let loading: Promise<Model | null> | null = null;

const set = (patch: Partial<ModelState>) => {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn(state));
};

export const getModelState = () => state;

export const subscribeModel = (fn: (s: ModelState) => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

const download = async (): Promise<Blob> => {
  const cache = "caches" in window ? await caches.open(CACHE_NAME) : null;
  const cached = await cache?.match(MODEL_URL);
  if (cached) {
    set({ status: ModelStatus.INITIALIZING, progress: 100 });
    return cached.blob();
  }

  set({ status: ModelStatus.DOWNLOADING, progress: 0 });
  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status})`);
  const total = parseInt(response.headers.get("content-length") ?? "0", 10);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) set({ progress: Math.min(100, Math.round((received / total) * 100)) });
  }
  const blob = new Blob(chunks, { type: "application/gzip" });
  try {
    await cache?.put(MODEL_URL, new Response(blob, { headers: { "Content-Type": "application/gzip" } }));
  } catch (err) {
    console.warn("Could not cache the voice model (non-fatal):", err);
  }
  return blob;
};

export const loadModel = () => {
  if (!loading) {
    loading = (async () => {
      try {
        const blob = await download();
        set({ status: ModelStatus.INITIALIZING });
        const model = await createModel(URL.createObjectURL(blob));
        model.setLogLevel(-1);
        set({ status: ModelStatus.READY, model });
        return model;
      } catch (err: any) {
        console.error("Voice model failed to load:", err);
        set({ status: ModelStatus.ERROR, error: err?.message ?? "Unknown error" });
        loading = null;
        return null;
      }
    })();
  }
  return loading;
};
