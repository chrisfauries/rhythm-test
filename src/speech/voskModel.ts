import { createModel, Model } from "vosk-browser";

// Same approach as the flash-cards app: the model ships in /public and is
// downloaded once with progress.
//
// vosk-browser keeps its own copy: it unpacks the model into IndexedDB (the
// "/vosk" database), in a folder named after the URL it was given, and on
// every start loads that whole database into memory. So the URL must stay the
// same from load to load (a blob: URL is new every time, which saved another
// ~50 MB copy on each refresh and grew the tab to many GB), and copies under
// any other name are deleted before loading.

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

/** Bump when public/model.tar.gz changes, so the saved copy is replaced. */
const MODEL_VERSION = 1;
const MODEL_URL = `${process.env.PUBLIC_URL || "."}/model.tar.gz?v=${MODEL_VERSION}`;
// Where vosk-browser saves it (its worker: "/vosk/" + modelUrl with non-word characters as "_").
const DB_NAME = "/vosk";
const STORE = "FILE_DATA";
const MODEL_DIR = `${DB_NAME}/${MODEL_URL.replace(/[\W]/g, "_")}`;
/** The Cache Storage copy older versions of the app kept. */
const OLD_CACHE = "vosk-model-v1";

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

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/**
 * Deletes every saved model except the current one. Returns whether the
 * current one is saved and fully unpacked (then nothing needs downloading).
 */
const pruneSaved = async (): Promise<boolean> => {
  if (!("indexedDB" in window)) return false;
  // Don't create the database if vosk-browser never made it.
  const dbs = indexedDB.databases ? await indexedDB.databases() : null;
  if (dbs && !dbs.some((d) => d.name === DB_NAME)) return false;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    if (!db.objectStoreNames.contains(STORE)) return false;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    const keys = (await request(store.getAllKeys())) as string[];
    const stale = keys.filter((k) => k !== DB_NAME && k !== MODEL_DIR && !k.startsWith(MODEL_DIR + "/"));
    // Whole folders at a time: everything under each stale top-level folder.
    const folders = new Set(stale.map((k) => k.split("/").slice(0, 3).join("/")));
    for (const f of Array.from(folders)) await request(store.delete(IDBKeyRange.bound(f, f + "/￿")));
    if (folders.size) console.info(`Voice model: deleted ${folders.size} old saved cop${folders.size === 1 ? "y" : "ies"}.`);
    return keys.includes(`${MODEL_DIR}/extracted.ok`);
  } finally {
    db.close();
  }
};

/** Downloads the model with progress, which leaves it in the HTTP cache for vosk-browser's own fetch. */
const download = async () => {
  set({ status: ModelStatus.DOWNLOADING, progress: 0 });
  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status})`);
  const total = parseInt(response.headers.get("content-length") ?? "0", 10);
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (total > 0) set({ progress: Math.min(100, Math.round((received / total) * 100)) });
  }
};

export const loadModel = () => {
  if (!loading) {
    loading = (async () => {
      try {
        if ("caches" in window) caches.delete(OLD_CACHE).catch(() => {});
        const saved = await pruneSaved().catch((err) => {
          console.warn("Could not tidy the saved voice model (non-fatal):", err);
          return false;
        });
        if (!saved) await download();
        set({ status: ModelStatus.INITIALIZING, progress: 100 });
        const model = await createModel(MODEL_URL);
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
