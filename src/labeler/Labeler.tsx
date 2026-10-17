import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Staff, { StaffLayout } from "../components/Staff";
import { Button, Card, Pill } from "../components/ui";
import { downloadBlob } from "../debug/debugBundle";
import { findPulses } from "../analysis/analyze";
import { CANDIDATE_OPTIONS, classifyCandidate } from "../audio/clapClassifier";
import { ClapDetector } from "../audio/ClapDetector";
import { voiceFrames, voiceOnsetNear, voiceRuns } from "../audio/voice";
import { loadCountModel } from "../ml/countModel";
import { fft, toFeatureRate } from "../ml/features";
import { beatLength, countDisplay, parseLine } from "../music/rhythm";
import { estimateLag } from "../training/capture";
import { json, parseWav, readZip } from "./files";
import {
  COUNT_KEYS,
  countsFromEvents,
  EventType,
  LabelEvent,
  labelsFile,
  prefill,
  TakeInfo,
  takeInfo,
} from "./labels";
import Timeline, { View } from "./Timeline";

// Labeler (?label): open a capture zip, watch the take with everything synced,
// and correct what happened. The tracks start with what the app (and the
// count model) detected; you fix them and save <capture>.labels.json, which
// ml/dataset.js uses for training.

interface Take {
  name: string;
  diag: any;
  manifest: any;
  info: TakeInfo;
  audio: Float32Array;
  sampleRate: number;
  videoUrl: string | null;
  audioUrl: string;
  /** media time = wav time + lag */
  lag: number;
  spectrogram: { cols: number; bins: number; hop: number; data: Uint8ClampedArray };
  hands: { wav: number; together: boolean | null; landmarks?: { points: number[][] }[] }[];
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

const loadTake = async (zip: File, labels: File | null): Promise<{ take: Take; events: LabelEvent[] }> => {
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
  const take: Take = {
    name: zip.name.replace(/\.zip$/i, ""),
    diag,
    manifest,
    info,
    audio,
    sampleRate,
    videoUrl: videoBytes ? URL.createObjectURL(new Blob([videoBytes as BlobPart], { type: "video/webm" })) : null,
    audioUrl: URL.createObjectURL(new Blob([files.get("audio.wav")! as BlobPart], { type: "audio/wav" })),
    lag: videoBytes ? lag ?? 0 : 0,
    spectrogram: spectrogram(audio, sampleRate),
    hands: diag.hands ?? [],
  };
  const saved = labels ? JSON.parse(await labels.text()) : null;
  const events: LabelEvent[] = saved?.events ?? (await suggest(diag, info, audio, sampleRate));
  return { take, events };
};

const PALM = [0, 5, 9, 13, 17];

/**
 * Starting labels: claps from the current detector (whatever version made
 * the file), counts the app heard, and for counts it couldn't hear (a clap
 * hid them) the count model's guess where a voice starts there.
 */
const suggest = async (diag: any, info: TakeInfo, audio: Float32Array, sampleRate: number): Promise<LabelEvent[]> => {
  const events = prefill(diag, info).filter((e) => e.type !== "clap" && e.type !== "pulse");
  let id = events.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  const det = new ClapDetector(sampleRate, CANDIDATE_OPTIONS);
  for (let i = 0; i < audio.length; i += 512) {
    for (const o of det.process(audio.subarray(i, i + 512), i / sampleRate)) {
      if (classifyCandidate(audio, sampleRate, 0, o, 0).isClap) events.push({ id: id++, type: "clap", t: o.time, source: "app" });
    }
  }
  // Rest pulses from the recorded hand points (palm height; 4:3 camera frames).
  const frames = (diag.hands ?? [])
    .filter((f: any) => f.landmarks?.length)
    .map((f: any) => {
      const L = f.landmarks as { points: number[][] }[];
      const palmY = L.reduce((a, h) => a + PALM.reduce((b, i) => b + h.points[i][1], 0) / PALM.length, 0) / L.length;
      const scale =
        L.reduce((a, h) => a + Math.hypot((h.points[0][0] - h.points[9][0]) * (4 / 3), h.points[0][1] - h.points[9][1]), 0) / L.length;
      return { time: f.wav as number, together: f.together as boolean | null, palmY, scale };
    });
  for (const t of findPulses(frames)) {
    if (info.rests.some((r) => t > r.t - 0.4 && t < r.t + 0.5)) events.push({ id: id++, type: "pulse", t, source: "app" });
  }

  if (info.counts.length) {
    const frames = voiceFrames(audio, sampleRate, 0);
    const runs = voiceRuns(frames);
    const model = await loadCountModel();
    const x16 = model ? toFeatureRate(audio, sampleRate) : null;
    const have = countsFromEvents(events, info);
    info.counts.forEach((c, i) => {
      if (have[i].label !== null) return;
      const onset = voiceOnsetNear(frames, c.t, runs);
      if (onset === null) return;
      const pred = model && x16 ? model.predict(x16, c.t) : null;
      const label = pred && pred.label !== "none" && pred.conf >= 0.4 ? pred.label : "?";
      events.push({ id: id++, type: "count", t: onset, label, source: pred ? "model" : "app" });
    });
  }
  return events.sort((a, b) => a.t - b.t);
};

const Labeler: React.FC = () => {
  const [take, setTake] = useState<Take | null>(null);
  const [events, setEvents] = useState<LabelEvent[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [time, setTime] = useState(0);
  const [view, setView] = useState<View>({ start: 0, dur: 10 });
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const cursorRef = useRef<SVGLineElement>(null);
  const layoutRef = useRef<StaffLayout | null>(null);
  const undo = useRef<LabelEvent[][]>([]);
  const nextId = useRef(1);

  const open = async (files: FileList | File[]) => {
    const list = Array.from(files);
    const zip = list.find((f) => f.name.toLowerCase().endsWith(".zip"));
    if (!zip) return setError("Choose a capture .zip (and optionally its .labels.json).");
    const labels = list.find((f) => f.name.toLowerCase().endsWith(".labels.json")) ?? null;
    setError(null);
    try {
      const { take: t, events: ev } = await loadTake(zip, labels);
      setTake(t);
      setEvents(ev);
      nextId.current = ev.reduce((m, e) => Math.max(m, e.id), 0) + 1;
      undo.current = [];
      setSelected(null);
      setTime(0);
      setDirty(false);
      const dur = t.audio.length / t.sampleRate;
      setView({ start: Math.max(0, t.info.lineStart - 1.5), dur: Math.min(dur, 8) });
    } catch (err) {
      console.error(err);
      setError(String(err));
    }
  };

  const duration = take ? take.audio.length / take.sampleRate : 0;
  const line = useMemo(() => (take ? parseLine(take.diag.exercise.source, take.diag.exercise.timeSig) : null), [take]);
  const counts = useMemo(() => (take ? countsFromEvents(events, take.info) : []), [events, take]);

  const change = useCallback((fn: (ev: LabelEvent[]) => LabelEvent[]) => {
    setEvents((ev) => {
      undo.current.push(ev);
      if (undo.current.length > 200) undo.current.shift();
      return fn(ev).sort((a, b) => a.t - b.t);
    });
    setDirty(true);
  }, []);

  const seek = useCallback(
    (t: number) => {
      if (!take) return;
      const m = mediaRef.current;
      const clamped = Math.max(0, Math.min(duration, t));
      if (m) m.currentTime = Math.max(0, clamped + take.lag);
      setTime(clamped);
    },
    [take, duration]
  );

  const nearestCountLabel = useCallback(
    (t: number) => {
      if (!take?.info.counts.length) return "?";
      return take.info.counts.reduce((b, c) => (Math.abs(c.t - t) < Math.abs(b.t - t) ? c : b)).label;
    },
    [take]
  );

  const add = useCallback(
    (type: EventType, t: number) => {
      const e: LabelEvent = { id: nextId.current++, type, t, source: "human", label: type === "count" ? nearestCountLabel(t) : undefined };
      change((ev) => [...ev, e]);
      setSelected(e.id);
    },
    [change, nearestCountLabel]
  );

  // Playback clock: the media element is the master.
  useEffect(() => {
    if (!take) return;
    let raf = 0;
    const tick = () => {
      const m = mediaRef.current;
      if (m && !m.paused) {
        const t = m.currentTime - take.lag;
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
          g.fillStyle = best.together ? "#FFB81C" : "#34d399";
          for (const [px, py] of hand.points) {
            g.beginPath();
            g.arc(ox + px * vw * s, oy + py * vh * s, 2.5, 0, Math.PI * 2);
            g.fill();
          }
          const cx = PALM.reduce((a, i) => a + hand.points[i][0], 0) / 5;
          const cy = PALM.reduce((a, i) => a + hand.points[i][1], 0) / 5;
          g.strokeStyle = "#e11d48";
          g.lineWidth = 2;
          g.beginPath();
          g.arc(ox + cx * vw * s, oy + cy * vh * s, 7, 0, Math.PI * 2);
          g.stroke();
        }
      }
    }
  }, [time, take, line]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!take || (e.target as HTMLElement).closest("input, textarea")) return;
      const m = mediaRef.current;
      const sel = events.find((x) => x.id === selected);
      if (e.key === " ") {
        e.preventDefault();
        if (m) {
          if (m.paused) {
            m.play();
            setPlaying(true);
          } else {
            m.pause();
            setPlaying(false);
          }
        }
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = (e.shiftKey ? 0.01 : 0.05) * (e.key === "ArrowLeft" ? -1 : 1);
        if (sel && e.altKey) change((ev) => ev.map((x) => (x.id === sel.id ? { ...x, t: x.t + step, source: "human" } : x)));
        else seek(time + step);
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        change((ev) => ev.filter((x) => x.id !== sel.id));
        setSelected(null);
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
        const prev = undo.current.pop();
        if (prev) setEvents(prev);
      } else if (e.key === "c") add("clap", time);
      else if (e.key === "p") add("pulse", time);
      else if (e.key === "w") add("count", time);
      else if (sel?.type === "count" && COUNT_KEYS[e.key]) {
        change((ev) => ev.map((x) => (x.id === sel.id ? { ...x, label: COUNT_KEYS[e.key], source: "human" } : x)));
      } else if (e.key === "[" || e.key === "]") {
        setView((v) => {
          const dur = Math.max(0.4, Math.min(duration + 2, v.dur * (e.key === "[" ? 1.5 : 1 / 1.5)));
          return { start: Math.max(-1, time - dur / 2), dur };
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [take, events, selected, time, seek, change, add, duration]);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = () => {
    if (!take) return;
    const file = labelsFile(take.name, events, take.info);
    downloadBlob(new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }), `${take.name}.labels.json`);
    setDirty(false);
  };

  const sel = events.find((e) => e.id === selected);
  const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;
  const countSummary = counts.reduce(
    (a, c, i) => {
      const exp = take!.info.counts[i].label;
      if (c.label === null) a.none++;
      else if (c.label === exp) a.match++;
      else if (c.label === "?") a.unsure++;
      else a.differ++;
      return a;
    },
    { match: 0, differ: 0, unsure: 0, none: 0 }
  );

  return (
    <div
      className="min-h-screen w-full max-w-[1400px] mx-auto px-4 py-4 flex flex-col gap-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        open(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black tracking-tight text-walsh-green">Labeler</h1>
        <label className="cursor-pointer rounded-full bg-slate-100 dark:bg-slate-800 px-4 py-2 text-sm font-bold hover:bg-slate-200">
          Open capture…
          <input
            type="file"
            accept=".zip,.json"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && open(e.target.files)}
          />
        </label>
        {take && (
          <>
            <span className="font-mono text-sm text-slate-600">{take.name}</span>
            <span className="text-xs text-slate-500">
              {take.diag.exercise.id} · {take.diag.exercise.tempo} BPM · {take.diag.settings.activity ?? take.diag.settings.countMode}
              {take.manifest ? ` · ${take.manifest.performance} · ${take.manifest.setting} · ${take.manifest.mic}` : ""}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {dirty && <span className="text-xs text-amber-600 font-semibold">unsaved</span>}
              <Button onClick={save}>Save labels</Button>
            </div>
          </>
        )}
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!take && (
        <Card className="text-center text-slate-500 py-16">
          Drop a capture zip here (and its .labels.json, to keep editing), or use “Open capture…”.
        </Card>
      )}

      {take && line && (
        <>
          <div className="grid gap-3 lg:grid-cols-[minmax(320px,520px)_1fr]">
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
              {!take.videoUrl && <div className="absolute inset-0 flex items-center justify-center text-slate-400">No video</div>}
            </div>
            <div className="flex flex-col gap-3 min-w-0">
              <div className="rounded-2xl bg-white border border-slate-200 px-3 pt-2 overflow-x-auto">
                <Staff
                  line={line}
                  onLayout={(l) => (layoutRef.current = l)}
                  overlay={() => <line ref={cursorRef} stroke="#FFB81C" strokeWidth={4} strokeLinecap="round" opacity={0} />}
                />
              </div>
              <Card className="!p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500 mb-2">
                  <span>COUNTS</span>
                  <span className="text-emerald-600">{countSummary.match} as expected</span>
                  <span className="text-rose-600">{countSummary.differ} different</span>
                  <span className="text-amber-600">{countSummary.unsure} unsure (?)</span>
                  <span>{countSummary.none} not said</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {counts.map((c, i) => {
                    const exp = take.info.counts[i];
                    const tone =
                      c.label === null
                        ? "bg-slate-100 text-slate-400"
                        : c.label === exp.label
                        ? "bg-emerald-50 text-emerald-700"
                        : c.label === "?"
                        ? "bg-amber-50 text-amber-700"
                        : "bg-rose-50 text-rose-700";
                    return (
                      <button
                        key={i}
                        type="button"
                        title={`expected “${countDisplay(exp.label)}”`}
                        className={`min-w-[2rem] rounded-lg px-1.5 py-0.5 text-sm font-bold ${tone}`}
                        onClick={() => {
                          seek(exp.t - 0.3);
                          const ev = events.find((e) => e.type === "count" && c.t !== null && Math.abs(e.t - c.t) < 1e-6);
                          setSelected(ev?.id ?? null);
                        }}
                      >
                        {c.label === null ? "—" : countDisplay(c.label)}
                      </button>
                    );
                  })}
                </div>
              </Card>
            </div>
          </div>

          <Card className="!p-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => {
                  const m = mediaRef.current;
                  if (!m) return;
                  if (m.paused) m.play();
                  else m.pause();
                }}
              >
                {playing ? "Pause" : "Play"}
              </Button>
              {[0.25, 0.5, 1].map((r) => (
                <Pill key={r} selected={rate === r} onClick={() => setRate(r)}>
                  {r}×
                </Pill>
              ))}
              <span className="font-mono text-sm w-24 text-right">{fmt(Math.max(0, time))}</span>
              {sel && (
                <span className="text-sm">
                  Selected <b>{sel.type}</b>
                  {sel.label ? ` “${countDisplay(sel.label)}”` : ""} at {fmt(sel.t)} ({sel.source})
                </span>
              )}
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
              onView={setView}
              onSeek={seek}
              onSelect={setSelected}
              onMove={(id, t) => change((ev) => ev.map((x) => (x.id === id ? { ...x, t, source: "human" } : x)))}
              onAdd={add}
            />
            <p className="text-xs text-slate-500 leading-relaxed">
              <b>Space</b> play/pause · <b>←/→</b> step 50 ms (<b>Shift</b> 10 ms; <b>Alt</b> moves the selected event) ·
              click a lane to seek / select · drag events to move · <b>double-click</b> a lane to add · <b>c</b>/<b>w</b>/<b>p</b>{" "}
              add clap / count / pulse at the playhead · with a count selected: <b>1–9</b> numbers, <b>n</b> “&”, <b>e</b>, <b>a</b>
              /<b>u</b> “a”, <b>?</b> unsure · <b>Delete</b> remove · <b>Ctrl+Z</b> undo · wheel zoom, <b>Shift</b>+wheel or drag
              the ruler to pan, <b>[ ]</b> zoom
            </p>
          </Card>
        </>
      )}
    </div>
  );
};

export default Labeler;
