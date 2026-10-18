import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Staff, { StaffLayout } from "../components/Staff";
import { Button, Card } from "../components/ui";
import { downloadBlob } from "../debug/debugBundle";
import { makeZip } from "../debug/zip";
import { findPulses } from "../analysis/analyze";
import { CANDIDATE_OPTIONS, classifyCandidate } from "../audio/clapClassifier";
import { ClapDetector } from "../audio/ClapDetector";
import { useClickTrack } from "../audio/useClickTrack";
import { voiceFrames, voiceOnsetNear, voiceRuns } from "../audio/voice";
import { activityInfo, activityOfSettings } from "../music/activity";
import { loadCountModel } from "../ml/countModel";
import { fft, toFeatureRate } from "../ml/features";
import { beatLength, parseLine } from "../music/rhythm";
import { estimateLag } from "../training/capture";
import { json, parseWav, readZip } from "./files";
import { COUNT_KEYS, countsFromEvents, EventType, LabelEvent, labelsFile, prefill, TakeInfo, takeInfo } from "./labels";
import { buildBeats, snap, wordDisplay } from "./review";
import Timeline, { View } from "./Timeline";

// Labeler (Settings → Tools, or ?label): open a capture zip and fix what the
// student really did on the timeline. It starts with what the app (and the
// count model) found; a person adds, removes and moves marks (right-click
// adds or removes, drag moves), and saves labels.json into the zip, which the
// ML scripts use for training. Saving marks the whole take as checked.

interface Take {
  name: string;
  diag: any;
  manifest: any;
  info: TakeInfo;
  claps: boolean;
  audio: Float32Array;
  sampleRate: number;
  videoUrl: string | null;
  audioUrl: string;
  /** media time = wav time + lag */
  lag: number;
  spectrogram: {
    cols: number;
    bins: number;
    hop: number;
    data: Uint8ClampedArray;
  };
  hands: {
    wav: number;
    together: boolean | null;
    landmarks?: { points: number[][] }[];
  }[];
  /** Every sharp sound the clap detector noticed (claps or not), for snapping added claps. */
  onsets: number[];
  /** Where a voice starts near t, for placing added counts. */
  voiceAt: (t: number) => number | null;
}

const SPEC_N = 512;
const SPEC_HOP = 160;
const SPEC_BINS = 128; // 0–4 kHz at 16 kHz / 512

const spectrogram = (audio: Float32Array, sampleRate: number) => {
  const x = toFeatureRate(audio, sampleRate);
  const cols = Math.floor((x.length - SPEC_N) / SPEC_HOP);
  const db = new Float32Array(cols * SPEC_BINS);
  const re = new Float64Array(SPEC_N);
  const im = new Float64Array(SPEC_N);
  let max = -Infinity;
  for (let c = 0; c < cols; c++) {
    for (let n = 0; n < SPEC_N; n++) {
      re[n] = x[c * SPEC_HOP + n] * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / SPEC_N));
      im[n] = 0;
    }
    fft(re, im);
    for (let b = 0; b < SPEC_BINS; b++) {
      const v = 10 * Math.log10(re[b] ** 2 + im[b] ** 2 + 1e-12);
      db[c * SPEC_BINS + b] = v;
      if (v > max) max = v;
    }
  }
  const data = new Uint8ClampedArray(db.length);
  for (let i = 0; i < db.length; i++) data[i] = ((db[i] - (max - 75)) / 75) * 255;
  return { cols, bins: SPEC_BINS, hop: SPEC_HOP / 16000, data };
};

const loadTake = async (
  zip: File,
  labels: File | null,
): Promise<{
  take: Take;
  events: LabelEvent[];
  reviewed: number[];
  files: Map<string, Uint8Array>;
}> => {
  const files = await readZip(zip);
  const diag = json(files.get("diagnostics.json"));
  if (!diag || !files.get("audio.wav")) throw new Error("This zip has no diagnostics.json / audio.wav");
  const manifest = json(files.get("manifest.json"));
  const { data: audio, sampleRate } = parseWav(files.get("audio.wav")!);
  const info = takeInfo(diag);
  const videoName = Array.from(files.keys()).find((n) => n.startsWith("camera."));
  const videoBytes = videoName ? files.get(videoName)! : null;
  let lag = manifest?.sync?.videoLag ?? null;
  if (videoBytes && lag === null) {
    try {
      const buf = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(videoBytes.slice().buffer);
      lag = estimateLag(audio, sampleRate, buf.getChannelData(0), sampleRate);
    } catch {
      lag = diag.video?.startedAtWav != null ? -diag.video.startedAtWav : 0;
    }
  }
  // Sharp sounds, from the current clap detector.
  const sounds: { t: number; isClap: boolean }[] = [];
  const det = new ClapDetector(sampleRate, CANDIDATE_OPTIONS);
  for (let i = 0; i < audio.length; i += 512) {
    for (const o of det.process(audio.subarray(i, i + 512), i / sampleRate)) {
      sounds.push({
        t: o.time,
        isClap: classifyCandidate(audio, sampleRate, 0, o, 0).isClap,
      });
    }
  }
  const vf = voiceFrames(audio, sampleRate, 0);
  const runs = voiceRuns(vf);
  const take: Take = {
    name: zip.name.replace(/\.zip$/i, ""),
    diag,
    manifest,
    info,
    claps: activityInfo(activityOfSettings(diag.settings)).claps,
    audio,
    sampleRate,
    videoUrl: videoBytes ? URL.createObjectURL(new Blob([videoBytes as BlobPart], { type: "video/webm" })) : null,
    audioUrl: URL.createObjectURL(new Blob([files.get("audio.wav")! as BlobPart], { type: "audio/wav" })),
    lag: videoBytes ? (lag ?? 0) : 0,
    spectrogram: spectrogram(audio, sampleRate),
    hands: diag.hands ?? [],
    onsets: sounds.map((s) => s.t),
    voiceAt: (t) => voiceOnsetNear(vf, t, runs),
  };
  // Saved labels live inside the zip (labels.json); a separate .labels.json (older saves) also works.
  const saved = labels ? JSON.parse(await labels.text()) : json(files.get(LABELS_ENTRY));
  const events: LabelEvent[] = saved?.events ?? (await suggest(take, sounds));
  return { take, events, reviewed: saved?.reviewed ?? [], files };
};

const PALM = [0, 5, 9, 13, 17];
const LABELS_ENTRY = "labels.json";

/** A file the person picked, with a handle to write it back when the browser allows it (Chrome). */
interface Picked {
  file: File;
  handle?: any;
}

/** The browser's file picker, which (unlike <input type=file>) lets us save back into the zip. */
const canPickWithHandle = typeof window !== "undefined" && "showOpenFilePicker" in window;
const pickFiles = async (): Promise<Picked[]> => {
  try {
    const handles = await (window as any).showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: "Capture zip",
          accept: {
            "application/zip": [".zip"],
            "application/json": [".json"],
          },
        },
      ],
    });
    return Promise.all(handles.map(async (h: any) => ({ file: await h.getFile(), handle: h })));
  } catch {
    return []; // cancelled
  }
};

/**
 * Starting labels: claps from the current clap detector, counts the app
 * heard, and for counts it couldn't hear (a clap hid them) the count model's
 * guess where a voice starts there.
 */
const suggest = async (take: Take, sounds: { t: number; isClap: boolean }[]): Promise<LabelEvent[]> => {
  const { diag, info, audio, sampleRate } = take;
  const events = prefill(diag, info).filter((e) => e.type !== "clap" && e.type !== "pulse");
  let id = events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  for (const s of sounds) if (s.isClap) events.push({ id: id++, type: "clap", t: s.t, source: "app" });
  // Rest pulses from the recorded hand points (palm height; 4:3 camera frames).
  const frames = (diag.hands ?? [])
    .filter((f: any) => f.landmarks?.length)
    .map((f: any) => {
      const L = f.landmarks as { points: number[][] }[];
      const palmY = L.reduce((a, h) => a + PALM.reduce((b, i) => b + h.points[i][1], 0) / PALM.length, 0) / L.length;
      const scale =
        L.reduce((a, h) => a + Math.hypot((h.points[0][0] - h.points[9][0]) * (4 / 3), h.points[0][1] - h.points[9][1]), 0) / L.length;
      return {
        time: f.wav as number,
        together: f.together as boolean | null,
        palmY,
        scale,
      };
    });
  // One dip gives several candidates (the palm jitters at the bottom, the hand
  // leaves the frame), so keep one per rest: the candidate nearest it.
  const best = new Map<number, number>();
  for (const t of findPulses(frames)) {
    let k = -1;
    info.rests.forEach((r, i) => {
      if (t > r.t - 0.4 && t < r.t + 0.5 && (k < 0 || Math.abs(t - r.t) < Math.abs(t - info.rests[k].t))) k = i;
    });
    const r = info.rests[k];
    if (r && (!best.has(k) || Math.abs(t - r.t) < Math.abs(best.get(k)! - r.t))) best.set(k, t);
  }
  best.forEach((t) => events.push({ id: id++, type: "pulse", t, source: "app" }));

  if (info.counts.length) {
    const model = await loadCountModel();
    const x16 = model ? toFeatureRate(audio, sampleRate) : null;
    const have = countsFromEvents(events, info);
    info.counts.forEach((c, i) => {
      if (have[i].label !== null) return;
      const onset = take.voiceAt(c.t);
      if (onset === null) return;
      const pred = model && x16 ? model.predict(x16, c.t) : null;
      const label = pred && pred.label !== "none" && pred.conf >= 0.4 ? pred.label : "?";
      events.push({
        id: id++,
        type: "count",
        t: onset,
        label,
        source: pred ? "model" : "app",
      });
    });
  }
  return events.sort((a, b) => a.t - b.t);
};

const TYPE_NAME: Record<EventType, string> = {
  clap: "👏 clap",
  count: "🗣️ count",
  pulse: "👐 rest pulse",
};

/** A choice that's clearly on or off without relying on color: inverted, bold, with a check mark. */
const Choice: React.FC<
  React.PropsWithChildren<{
    on: boolean;
    onClick: () => void;
    title?: string;
    wide?: boolean;
  }>
> = ({ on, onClick, title, wide, children }) => (
  <button
    type="button"
    title={title}
    aria-pressed={on}
    onClick={onClick}
    className={`rounded-xl border-2 px-3 py-2 text-base font-bold transition ${wide ? "min-w-[8rem]" : "min-w-[3rem]"} ${
      on ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-500"
    }`}
  >
    {on && "✓ "}
    {children}
  </button>
);

const sourceText = (e: LabelEvent) =>
  e.source === "human"
    ? "You marked"
    : e.source === "model"
      ? "The AI guessed"
      : e.source === "synthetic"
        ? "The generator placed"
        : "The app found";

const Labeler: React.FC = () => {
  const [take, setTake] = useState<Take | null>(null);
  const [events, setEvents] = useState<LabelEvent[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [reviewed, setReviewed] = useState<Set<number>>(new Set());
  const [time, setTime] = useState(0);
  const [view, setView] = useState<View>({ start: 0, dur: 10 });
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(0.5);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    t: number;
    lane: EventType | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [savedAs, setSavedAs] = useState<{
    name: string;
    inPlace: boolean;
  } | null>(null);
  const [undoCount, setUndoCount] = useState(0);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<SVGLineElement>(null);
  const layoutRef = useRef<StaffLayout | null>(null);
  const undo = useRef<LabelEvent[][]>([]);
  const nextId = useRef(1);
  const stopAt = useRef<number | null>(null);
  const zipFiles = useRef<Map<string, Uint8Array>>(new Map());
  const zipHandle = useRef<any>(null);

  const open = async (list: Picked[]) => {
    if (!list.length) return;
    const zip = list.find((f) => f.file.name.toLowerCase().endsWith(".zip"));
    if (!zip) return setError("Choose a capture .zip.");
    const labels = list.find((f) => f.file.name.toLowerCase().endsWith(".labels.json"))?.file ?? null;
    setError(null);
    setLoading(true);
    try {
      const { take: t, events: ev, reviewed: rv, files } = await loadTake(zip.file, labels);
      zipFiles.current = files;
      zipHandle.current = zip.handle ?? null;
      setTake(t);
      setEvents(ev);
      nextId.current = ev.reduce((m, e) => Math.max(m, e.id), 0) + 1;
      undo.current = [];
      setSelected(null);
      setReviewed(new Set(rv));
      setTime(0);
      setDirty(false);
      setSavedAs(null);
      setMenu(null);
      const dur = t.audio.length / t.sampleRate;
      setView({
        start: Math.max(0, t.info.lineStart - 1),
        dur: Math.min(dur, 6),
      });
    } catch (err) {
      console.error(err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  // The metronome, played along with the video.
  const [clickOn, setClickOn] = useState(true);
  const clicks = useMemo(
    () =>
      take
        ? take.info.beats.map((b, i) => ({
            t: b + take.lag,
            accent: i % take.info.beatsPerMeasure === 0,
          }))
        : [],
    [take],
  );
  useClickTrack(mediaRef, clicks, clickOn);

  const duration = take ? take.audio.length / take.sampleRate : 0;
  const line = useMemo(() => (take ? parseLine(take.diag.exercise.source, take.diag.exercise.timeSig) : null), [take]);
  const beats = useMemo(() => (take ? buildBeats(take.info, take.claps) : []), [take]);

  const change = useCallback((fn: (ev: LabelEvent[]) => LabelEvent[]) => {
    setEvents((ev) => {
      // (StrictMode runs updaters twice; don't record the same state twice.)
      if (undo.current[undo.current.length - 1] !== ev) undo.current.push(ev);
      if (undo.current.length > 200) undo.current.shift();
      return fn(ev).sort((a, b) => a.t - b.t);
    });
    setDirty(true);
    setSavedAs(null);
  }, []);

  const undoLast = useCallback(() => {
    const prev = undo.current.pop();
    if (prev) {
      setEvents(prev);
      setDirty(true);
    }
  }, []);
  useEffect(() => setUndoCount(undo.current.length), [events]);

  const seek = useCallback(
    (t: number) => {
      if (!take) return;
      const m = mediaRef.current;
      const clamped = Math.max(0, Math.min(duration, t));
      if (m) m.currentTime = Math.max(0, clamped + take.lag);
      setTime(clamped);
    },
    [take, duration],
  );

  const togglePlay = useCallback(() => {
    const m = mediaRef.current;
    if (!m) return;
    stopAt.current = null;
    if (m.paused) m.play();
    else m.pause();
  }, []);

  /** Moves the playhead to a time, scrolling the timeline there if it's off screen. */
  const goTime = useCallback(
    (t: number) => {
      mediaRef.current?.pause();
      seek(t);
      setView((v) => (t < v.start + v.dur * 0.15 || t > v.start + v.dur * 0.85 ? { ...v, start: Math.max(-1, t - v.dur / 2) } : v));
    },
    [seek],
  );

  // Skimming: while the playhead is dragged, play a short snippet of the take at each new spot.
  const skim = useRef<{
    ctx: AudioContext;
    buf: AudioBuffer;
    last: number;
  } | null>(null);
  const scrub = useCallback(
    (t: number) => {
      if (!take || !mediaRef.current?.paused) return;
      if (!skim.current) {
        const ctx = new AudioContext();
        const buf = ctx.createBuffer(1, take.audio.length, take.sampleRate);
        buf.copyToChannel(take.audio, 0);
        skim.current = { ctx, buf, last: 0 };
      }
      const k = skim.current;
      const now = performance.now();
      if (now - k.last < 45 || t < 0 || t > duration) return;
      k.last = now;
      const src = k.ctx.createBufferSource();
      src.buffer = k.buf;
      const gain = k.ctx.createGain();
      const at = k.ctx.currentTime;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(1, at + 0.008);
      gain.gain.setValueAtTime(1, at + 0.06);
      gain.gain.linearRampToValueAtTime(0, at + 0.075);
      src.connect(gain).connect(k.ctx.destination);
      src.start(at, t, 0.08);
    },
    [take, duration],
  );
  useEffect(
    () => () => {
      skim.current?.ctx.close();
      skim.current = null;
    },
    [take],
  );

  // ---- Beat actions ------------------------------------------------------
  const addEvent = useCallback(
    (type: EventType, t: number, label?: string) => {
      const e: LabelEvent = {
        id: nextId.current++,
        type,
        t,
        source: "human",
        label,
      };
      change((ev) => [...ev, e]);
      return e;
    },
    [change],
  );
  const removeEvent = useCallback((id: number) => change((ev) => ev.filter((x) => x.id !== id)), [change]);

  const words = useMemo(() => {
    const n = take?.info.beatsPerMeasure ?? 4;
    const nums = Array.from({ length: Math.min(9, n) }, (_, i) => COUNT_KEYS[String(i + 1)]);
    const triplets = take?.info.counts.some((c) => c.label === "la" || c.label === "li") ? ["la", "li"] : [];
    return [...nums, "e", "and", "a", ...triplets];
  }, [take]);

  // ---- Playback ------------------------------------------------------------
  // The media element is the master clock.
  useEffect(() => {
    if (!take) return;
    let raf = 0;
    const tick = () => {
      const m = mediaRef.current;
      if (m && !m.paused) {
        const t = m.currentTime - take.lag;
        if (stopAt.current !== null && t >= stopAt.current) {
          m.pause();
          stopAt.current = null;
        }
        setTime(t);
        setView((v) => (t > v.start + v.dur * 0.9 || t < v.start ? { ...v, start: Math.max(-1, t - v.dur * 0.1) } : v));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [take]);

  // MediaRecorder webm files have no duration until scanned; scan once so seeking works.
  const onMeta = () => {
    const m = mediaRef.current;
    if (!m || Number.isFinite(m.duration)) return;
    const back = () => {
      m.removeEventListener("durationchange", back);
      m.currentTime = Math.max(0, time + (take?.lag ?? 0));
    };
    m.addEventListener("durationchange", back);
    m.currentTime = 1e6;
  };

  useEffect(() => {
    if (mediaRef.current) mediaRef.current.playbackRate = rate;
  }, [rate, take]);

  // Staff cursor and hand-landmark overlay follow the playhead.
  useEffect(() => {
    if (!take) return;
    const layout = layoutRef.current;
    const cursor = cursorRef.current;
    if (layout && cursor && line) {
      const secPerQ = take.info.secPerBeat / beatLength(line.timeSig);
      const pos = (time - take.info.lineStart) / secPerQ;
      const last = layout.rows[layout.rows.length - 1].lastPos;
      if (pos >= 0 && pos <= last) {
        const row = layout.rows[layout.rowOf(pos)];
        const x = layout.xOf(pos);
        cursor.setAttribute("x1", String(x));
        cursor.setAttribute("x2", String(x));
        cursor.setAttribute("y1", String(row.top + 12));
        cursor.setAttribute("y2", String(row.staffBottom));
        cursor.style.opacity = "1";
      } else cursor.style.opacity = "0";
    }
    const c = overlayRef.current;
    const v = mediaRef.current;
    if (c && v && take.videoUrl) {
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== w) c.width = w;
      if (c.height !== h) c.height = h;
      const g = c.getContext("2d")!;
      g.clearRect(0, 0, w, h);
      let best: Take["hands"][number] | null = null;
      for (const f of take.hands) if (!best || Math.abs(f.wav - time) < Math.abs(best.wav - time)) best = f;
      if (best && Math.abs(best.wav - time) < 0.08) {
        // The video element letterboxes; landmarks are fractions of the frame.
        const vw = v.videoWidth || 640;
        const vh = v.videoHeight || 480;
        const s = Math.min(w / vw, h / vh);
        const ox = (w - vw * s) / 2;
        const oy = (h - vh * s) / 2;
        for (const hand of best.landmarks ?? []) {
          g.fillStyle = "rgba(255,255,255,0.9)";
          for (const [px, py] of hand.points) {
            g.beginPath();
            g.arc(ox + px * vw * s, oy + py * vh * s, 2.5, 0, Math.PI * 2);
            g.fill();
          }
        }
        if (best.together !== null) {
          const text = best.together ? "🙌 hands together" : "🤲 hands apart";
          g.font = "bold 14px system-ui";
          const tw = g.measureText(text).width;
          g.fillStyle = "rgba(15,23,42,0.75)";
          g.fillRect(8, 8, tw + 16, 26);
          g.fillStyle = "#fff";
          g.fillText(text, 16, 26);
        }
      }
    }
  }, [time, take, line]);

  // Optional keyboard shortcuts (every one has a button too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!take || (e.target as HTMLElement).closest("input, textarea")) return;
      const sel = events.find((x) => x.id === selected);
      if (e.key === "Escape") {
        setMenu(null);
      } else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        // Playhead to the previous / next beat.
        e.preventDefault();
        const b = take.info.beats;
        const t = e.key === "ArrowLeft" ? [...b].reverse().find((x) => x < time - 0.02) : b.find((x) => x > time + 0.02);
        if (t !== undefined) goTime(t);
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        removeEvent(sel.id);
        setSelected(null);
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        undoLast();
      } else if (/^[1-9enuali]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        if (sel?.type === "count")
          change((ev) => ev.map((x) => (x.id === sel.id ? { ...x, label: COUNT_KEYS[e.key], source: "human" } : x)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Puts labels.json into the take's zip: written back to the opened file when the browser allows, else downloaded. */
  const save = async () => {
    if (!take) return;
    // Saving means a person looked over the whole take: every mark and every beat counts as checked.
    const checked = events.map((e) => (e.source === "app" || e.source === "model" ? { ...e, source: "human" as const } : e));
    setEvents(checked);
    const all = new Set([...Array.from(reviewed), ...beats.map((b) => b.pos)]);
    setReviewed(all);
    const labels = labelsFile(take.name, checked, take.info, Array.from(all));
    zipFiles.current.set(LABELS_ENTRY, new TextEncoder().encode(JSON.stringify(labels, null, 1)));
    const blob = makeZip(
      Array.from(zipFiles.current.entries()).map(([name, data]) => ({
        name,
        data,
      })),
    );
    const name = `${take.name}.zip`;
    const h = zipHandle.current;
    if (h?.createWritable) {
      try {
        if ((await h.queryPermission?.({ mode: "readwrite" })) !== "granted") await h.requestPermission({ mode: "readwrite" });
        const w = await h.createWritable();
        await w.write(blob);
        await w.close();
        setDirty(false);
        setSavedAs({ name, inPlace: true });
        return;
      } catch (err) {
        console.warn("Couldn't write the zip in place; downloading instead.", err);
      }
    }
    downloadBlob(blob, name);
    setDirty(false);
    setSavedAs({ name, inPlace: false });
  };

  const sel = events.find((e) => e.id === selected);
  const ts = line?.timeSig;

  /** The count the music expects nearest a time (for the add menu). */
  const expectedNear = (t: number) => {
    let best: { label: string; t: number } | null = null;
    for (const c of take?.info.counts ?? []) if (!best || Math.abs(c.t - t) < Math.abs(best.t - t)) best = c;
    return best && Math.abs(best.t - t) < 0.6 * (take?.info.secPerBeat ?? 0.5) ? best.label : null;
  };
  const addAt = (type: EventType, t: number, label?: string) => {
    if (!take) return;
    const at =
      type === "clap"
        ? snap(t, take.onsets, 0.05)
        : type === "count"
          ? (() => {
              const v = take.voiceAt(t);
              return v !== null && Math.abs(v - t) < 0.08 ? v : t;
            })()
          : t;
    const e = addEvent(type, at, label);
    setSelected(e.id);
    setMenu(null);
  };

  // ---- Page --------------------------------------------------------------
  return (
    <div
      className="min-h-screen w-full max-w-[1400px] mx-auto px-4 py-4 flex flex-col gap-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        // Ask for file handles while the drop event is live (Chrome), so saving can write back into the zip.
        const files = Array.from(e.dataTransfer.files);
        const handles = Array.from(e.dataTransfer.items).map((i) => (i as any).getAsFileSystemHandle?.() ?? null);
        Promise.all(handles)
          .catch(() => [])
          .then((hs: any[]) =>
            open(
              files.map((file) => ({
                file,
                handle: hs.find((h) => h?.kind === "file" && h.name === file.name),
              })),
            ),
          );
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black tracking-tight text-walsh-green">Labeler</h1>
        {canPickWithHandle ? (
          <button
            type="button"
            className="rounded-full bg-slate-200 px-4 py-2 text-sm font-bold hover:bg-slate-300"
            onClick={async () => open(await pickFiles())}
          >
            📂 Open a take…
          </button>
        ) : (
          <label className="cursor-pointer rounded-full bg-slate-200 px-4 py-2 text-sm font-bold hover:bg-slate-300">
            📂 Open a take…
            <input
              type="file"
              accept=".zip,.json"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && open(Array.from(e.target.files).map((file) => ({ file })))}
            />
          </label>
        )}
        {take && (
          <>
            <div className="flex flex-col leading-tight">
              <span className="font-mono text-sm text-slate-700">{take.name}</span>
              <span className="text-xs text-slate-500">
                Line {take.diag.exercise.id} · {take.diag.exercise.tempo} BPM · {activityInfo(activityOfSettings(take.diag.settings)).label}
                {take.manifest ? ` · recorded as “${take.manifest.performance}”` : ""}
              </span>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-sm text-slate-600">{savedAs ? `Saved ✓` : dirty ? "Not saved yet" : ""}</span>
              <Button onClick={save}>💾 Save labels</Button>
            </div>
          </>
        )}
      </div>
      {savedAs && (
        <p className="text-sm text-slate-600">
          {savedAs.inPlace ? (
            <>
              Saved the labels into <b className="font-mono">{savedAs.name}</b>. Open it again any time to keep working.
            </>
          ) : (
            <>
              This browser can't change the file you opened, so it downloaded <b className="font-mono">{savedAs.name}</b> with the labels
              inside. Replace the original zip in <span className="font-mono">ml/captures/</span> with it.
            </>
          )}
        </p>
      )}
      {error && <p className="text-sm font-semibold text-rose-700">⚠️ {error}</p>}

      {!take && (
        <Card className="py-10 px-8 max-w-2xl mx-auto w-full">
          <h2 className="text-xl font-black mb-4">Check what really happened in a take</h2>
          <ol className="flex flex-col gap-3 text-slate-700">
            <li>
              <b>1. Open a take.</b> Drop a capture zip here, or press “📂 Open a take…”. If you've labeled it before, your labels open with
              it.
            </li>
            <li>
              <b>2. Fix the timeline.</b> It starts with what the app heard and saw. Right-click empty space to add a clap, count or rest
              pulse; right-click a mark to remove it; drag a mark to move it. Drag empty space to skim the sound.
            </li>
            <li>
              <b>3. Save.</b> Press “💾 Save labels”. The labels are saved inside the take's zip, ready for training, and the whole take
              counts as checked.
            </li>
          </ol>
          <p className="mt-4 text-sm text-slate-500">
            Only takes with mistakes need this. Takes recorded as “as written” are labeled by the music itself.
          </p>
          {loading && <p className="mt-4 font-semibold">Opening…</p>}
        </Card>
      )}

      {take && line && ts && (
        <>
          <div className="grid gap-3 lg:grid-cols-[minmax(320px,480px)_1fr]">
            {/* Video and playback */}
            <div className="flex flex-col gap-2">
              <div className="relative bg-black rounded-2xl overflow-hidden aspect-[4/3]">
                {take.videoUrl ? (
                  <video
                    ref={mediaRef}
                    src={take.videoUrl}
                    className="absolute inset-0 w-full h-full object-contain"
                    onLoadedMetadata={onMeta}
                    onPause={() => setPlaying(false)}
                    onPlay={() => setPlaying(true)}
                    playsInline
                  />
                ) : (
                  <audio ref={mediaRef} src={take.audioUrl} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
                )}
                <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
                {!take.videoUrl && (
                  <div className="absolute inset-0 flex items-center justify-center text-slate-400">No video in this take</div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="secondary" onClick={togglePlay} className="!px-5 !py-2.5">
                  {playing ? "⏸ Pause" : "▶ Play from here"}
                </Button>
                <span className="text-sm text-slate-600 ml-1">Speed</span>
                {[
                  [0.25, "¼"],
                  [0.5, "½"],
                  [1, "Normal"],
                ].map(([r, name]) => (
                  <Choice key={r} on={rate === r} onClick={() => setRate(r as number)}>
                    {name}
                  </Choice>
                ))}
                <Choice on={clickOn} onClick={() => setClickOn((c) => !c)} title="Play the metronome with the video">
                  🔔 Click
                </Choice>
              </div>
            </div>

            {/* Staff and the beat being checked */}
            <div className="flex flex-col gap-3 min-w-0">
              <div className="rounded-2xl bg-white border border-slate-200 px-3 pt-2 overflow-x-auto">
                <Staff
                  line={line}
                  laneHeight={22}
                  onLayout={(l) => (layoutRef.current = l)}
                  overlay={(layout) => (
                    <>
                      <line ref={cursorRef} stroke="#e11d48" strokeWidth={3} strokeLinecap="round" opacity={0} />
                      {beats.map((b) => {
                        const r = layout.rowOf(b.pos);
                        const row = layout.rows[r];
                        const x = layout.xOf(b.pos, r);
                        return (
                          <rect
                            key={b.pos}
                            x={x - 15}
                            y={row.top + 4}
                            width={30}
                            height={row.staffBottom + 22 - row.top - 4}
                            fill="transparent"
                            style={{ cursor: "pointer" }}
                            onClick={() => goTime(b.t - 0.05)}
                          />
                        );
                      })}
                    </>
                  )}
                />
              </div>
            </div>
          </div>

          {/* Timeline, for fine-tuning timing */}
          <Card className="!p-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-slate-800 mr-1">Timeline</span>
              <Choice
                on={false}
                onClick={() =>
                  setView((v) => ({
                    start: v.start + v.dur * 0.25,
                    dur: Math.max(0.4, v.dur / 2),
                  }))
                }
              >
                🔍+ Zoom in
              </Choice>
              <Choice
                on={false}
                onClick={() =>
                  setView((v) => ({
                    start: Math.max(-1, v.start - v.dur / 2),
                    dur: Math.min(duration + 2, v.dur * 2),
                  }))
                }
              >
                🔍− Zoom out
              </Choice>
              <Choice on={false} onClick={() => setView({ start: -0.5, dur: duration + 1 })}>
                Whole take
              </Choice>
              <span className="mx-1 h-6 w-px bg-slate-300" />
              <Choice on={false} onClick={undoLast} title="Undo the last change">
                ↶ Undo{undoCount ? "" : " (nothing yet)"}
              </Choice>
            </div>
            <Timeline
              info={take.info}
              audio={take.audio}
              sampleRate={take.sampleRate}
              spectrogram={take.spectrogram}
              hands={take.hands}
              events={events}
              selected={selected}
              time={time}
              view={view}
              duration={duration}
              showClaps={take.claps}
              onView={setView}
              onSeek={seek}
              onScrub={scrub}
              onSelect={setSelected}
              onMove={(id, t) => change((ev) => ev.map((x) => (x.id === id ? { ...x, t, source: "human" } : x)))}
              onRemove={(id) => {
                removeEvent(id);
                if (selected === id) setSelected(null);
              }}
              onMenu={(m) => {
                setSelected(null);
                setMenu(m);
              }}
            />
            {menu && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onMouseDown={() => setMenu(null)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu(null);
                  }}
                />
                <div
                  className="fixed z-50 w-72 rounded-xl border border-slate-300 bg-white p-2 shadow-xl flex flex-col gap-1 text-sm"
                  style={{
                    left: Math.min(menu.x, window.innerWidth - 300),
                    top: Math.min(menu.y, window.innerHeight - 260),
                  }}
                >
                  {take.claps && (
                    <button
                      type="button"
                      className="rounded-lg px-3 py-2 text-left font-semibold hover:bg-slate-100"
                      onClick={() => addAt("clap", menu.t)}
                    >
                      👏 Add a clap here
                    </button>
                  )}
                  {take.claps && (
                    <button
                      type="button"
                      className="rounded-lg px-3 py-2 text-left font-semibold hover:bg-slate-100"
                      onClick={() => addAt("pulse", menu.t)}
                    >
                      👐 Add a rest pulse here
                    </button>
                  )}
                  {take.info.counts.length > 0 && (
                    <div className="px-3 py-2">
                      <div className="font-semibold mb-1.5">🗣️ Add a count here:</div>
                      <div className="flex flex-wrap gap-1">
                        {[...words, "?"].map((w) => {
                          const expected = w === expectedNear(menu.t);
                          return (
                            <button
                              key={w}
                              type="button"
                              title={expected ? "what the music says here" : undefined}
                              className={`rounded-lg border-2 px-2.5 py-1 font-bold ${expected ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 hover:border-slate-500"}`}
                              onClick={() => addAt("count", menu.t, w)}
                            >
                              {wordDisplay(w)}
                              {expected ? " ★" : ""}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            {sel ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  Selected: <b>{TYPE_NAME[sel.type]}</b>
                  {sel.label ? ` “${wordDisplay(sel.label)}”` : ""} ({sourceText(sel).toLowerCase()} it)
                </span>
                <Choice
                  on={false}
                  onClick={() => change((ev) => ev.map((x) => (x.id === sel.id ? { ...x, t: x.t - 0.01, source: "human" } : x)))}
                >
                  ◀ 10 ms earlier
                </Choice>
                <Choice
                  on={false}
                  onClick={() => change((ev) => ev.map((x) => (x.id === sel.id ? { ...x, t: x.t + 0.01, source: "human" } : x)))}
                >
                  10 ms later ▶
                </Choice>
                {sel.type === "count" &&
                  [...words, "?"].map((w) => (
                    <Choice
                      key={w}
                      on={sel.label === w}
                      onClick={() => change((ev) => ev.map((x) => (x.id === sel.id ? { ...x, label: w, source: "human" } : x)))}
                    >
                      {wordDisplay(w)}
                    </Choice>
                  ))}
                <Choice
                  on={false}
                  onClick={() => {
                    removeEvent(sel.id);
                    setSelected(null);
                  }}
                >
                  🗑 Remove
                </Choice>
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                ○ hollow mark = found by the app · ● filled mark = checked by you · dashed line = where the music says it goes. Right-click
                empty space to add a mark, right-click a mark to remove it, drag a mark to move it. Drag empty space to skim the sound.
                Scroll to zoom; shift+drag (or drag the top strip) to slide along.
              </p>
            )}
            <details className="text-sm text-slate-600">
              <summary className="cursor-pointer font-semibold">Keyboard shortcuts (optional)</summary>
              <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                <li>
                  <b>Space</b>: play from the playhead / pause
                </li>
                <li>
                  <b>← →</b>: playhead to the previous / next beat
                </li>
                <li>
                  <b>1–9</b>, <b>e</b>, <b>n</b> (&amp;), <b>u</b> (uh), <b>l</b> (la), <b>i</b> (li): change the selected count's word
                </li>
                <li>
                  <b>Delete</b>: remove the selected mark
                </li>
                <li>
                  <b>Ctrl+Z</b>: undo
                </li>
              </ul>
            </details>
          </Card>
        </>
      )}
    </div>
  );
};

export default Labeler;
