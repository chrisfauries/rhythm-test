import React, { useEffect, useMemo, useRef } from "react";
import { wordDisplay } from "./review";
import { EventType, LabelEvent, TakeInfo } from "./labels";

// The labeler's timeline: ruler (measures/beats), waveform, spectrogram, and
// one lane per event type, all on audio.wav's clock. Meaning never depends on
// color: an event's shape says what it is, hollow means the app found it,
// filled means a person checked it. Click to seek or select, drag to move; in
// an "add" tool, a click adds an event there.

export interface View {
  start: number;
  dur: number;
}

export type Tool = "select" | EventType;

interface Props {
  info: TakeInfo;
  audio: Float32Array;
  sampleRate: number;
  spectrogram: { cols: number; bins: number; hop: number; data: Uint8ClampedArray } | null;
  hands: { wav: number; together: boolean | null }[];
  events: LabelEvent[];
  selected: number | null;
  time: number;
  view: View;
  duration: number;
  tool: Tool;
  /** The beat being reviewed, shaded across all lanes. */
  band: [number, number] | null;
  showClaps: boolean;
  onView: (v: View) => void;
  onSeek: (t: number) => void;
  onSelect: (id: number | null) => void;
  onMove: (id: number, t: number) => void;
  onAdd: (type: EventType, t: number) => void;
}

interface Lane {
  key: string;
  h: number;
  label: string;
  type?: EventType;
}

const lanesFor = (showClaps: boolean): Lane[] => [
  { key: "ruler", h: 22, label: "" },
  { key: "wave", h: 56, label: "🔊 Sound" },
  { key: "spec", h: 80, label: "Sound picture (spectrogram)" },
  ...(showClaps ? [{ key: "clap", h: 34, label: "👏 Claps", type: "clap" as const }] : []),
  { key: "count", h: 38, label: "🗣️ Counts", type: "count" },
  ...(showClaps
    ? [
        { key: "pulse", h: 34, label: "👇 Rest pulses", type: "pulse" as const },
        { key: "hands", h: 22, label: "🙌 Hands together" },
      ]
    : []),
];

const INK = "#1e293b";
const GUIDE = "rgba(71,85,105,0.7)";

const Timeline: React.FC<Props> = (p) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: number | null; pan: number | null; startX: number; viewStart: number } | null>(null);
  const lanes = useMemo(() => lanesFor(p.showClaps), [p.showClaps]);
  const height = lanes.reduce((a, l) => a + l.h, 0);
  const laneTop = (key: string) => {
    let y = 0;
    for (const l of lanes) {
      if (l.key === key) return y;
      y += l.h;
    }
    return -1;
  };
  const lane = (key: string) => lanes.find((l) => l.key === key);

  // Wheel zooms the timeline, not the page.
  useEffect(() => {
    const c = ref.current;
    const stop = (e: WheelEvent) => e.preventDefault();
    c?.addEventListener("wheel", stop, { passive: false });
    return () => c?.removeEventListener("wheel", stop);
  }, []);

  // Peak envelope at 1 ms, for drawing the waveform at any zoom.
  const peaks = useMemo(() => {
    const step = Math.round(p.sampleRate / 1000);
    const out = new Float32Array(Math.ceil(p.audio.length / step));
    for (let i = 0; i < out.length; i++) {
      let m = 0;
      for (let k = i * step; k < Math.min(p.audio.length, (i + 1) * step); k++) m = Math.max(m, Math.abs(p.audio[k]));
      out[i] = m;
    }
    const top = out.reduce((a, b) => Math.max(a, b), 1e-6);
    return out.map((v) => v / top);
  }, [p.audio, p.sampleRate]);

  const specCanvas = useMemo(() => {
    const s = p.spectrogram;
    if (!s) return null;
    const c = document.createElement("canvas");
    c.width = s.cols;
    c.height = s.bins;
    const img = new ImageData(s.cols, s.bins);
    for (let x = 0; x < s.cols; x++) {
      for (let b = 0; b < s.bins; b++) {
        const v = s.data[x * s.bins + b];
        const o = ((s.bins - 1 - b) * s.cols + x) * 4;
        img.data[o] = v;
        img.data[o + 1] = v;
        img.data[o + 2] = v;
        img.data[o + 3] = 255;
      }
    }
    c.getContext("2d")!.putImageData(img, 0, 0);
    return c;
  }, [p.spectrogram]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(height * dpr);
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, height);
    const { start, dur } = p.view;
    const x = (t: number) => ((t - start) / dur) * W;
    const { info } = p;

    // Lane backgrounds.
    let y = 0;
    lanes.forEach((l, i) => {
      g.fillStyle = l.key === "spec" ? "#0f172a" : i % 2 ? "#f8fafc" : "#ffffff";
      g.fillRect(0, y, W, l.h);
      g.fillStyle = "#e2e8f0";
      g.fillRect(0, y + l.h - 1, W, 1);
      y += l.h;
    });

    // The beat under review: a shaded band with dashed edges.
    if (p.band) {
      const a = x(p.band[0]);
      const b = x(p.band[1]);
      g.fillStyle = "rgba(148,163,184,0.18)";
      g.fillRect(a, 0, b - a, height);
      g.strokeStyle = "rgba(71,85,105,0.5)";
      g.setLineDash([4, 4]);
      g.strokeRect(a, 0.5, b - a, height - 1);
      g.setLineDash([]);
    }

    // Beats (light), measure starts (dark) with numbers, across all lanes.
    info.beats.forEach((b, i) => {
      const xb = x(b);
      if (xb < -2 || xb > W + 2) return;
      const inLine = i >= info.countInBeats;
      const beatInLine = i - info.countInBeats;
      const measureStart = inLine && beatInLine % info.beatsPerMeasure === 0;
      g.strokeStyle = measureStart ? "rgba(15,23,42,0.45)" : "rgba(100,116,139,0.18)";
      g.lineWidth = measureStart ? 1.5 : 1;
      g.beginPath();
      g.moveTo(xb, 0);
      g.lineTo(xb, height);
      g.stroke();
      g.fillStyle = "#475569";
      g.font = "bold 11px system-ui";
      if (measureStart) g.fillText(`Measure ${beatInLine / info.beatsPerMeasure + 1}`, xb + 3, 15);
      else if (!inLine) g.fillText(`count-in ${i + 1}`, xb + 3, 15);
    });

    // Waveform.
    const wy = laneTop("wave");
    const wh = lane("wave")!.h;
    g.fillStyle = "#334155";
    for (let px = 0; px < W; px++) {
      const a = Math.max(0, Math.floor((start + (px / W) * dur) * 1000));
      const b = Math.min(peaks.length, Math.ceil((start + ((px + 1) / W) * dur) * 1000));
      let m = 0;
      for (let k = a; k < b; k++) m = Math.max(m, peaks[k]);
      const h = Math.max(1, m * (wh - 8));
      g.fillRect(px, wy + wh / 2 - h / 2, 1, h);
    }

    // Spectrogram.
    if (specCanvas && p.spectrogram) {
      const sy = laneTop("spec");
      const s = p.spectrogram;
      const c0 = start / s.hop;
      const c1 = (start + dur) / s.hop;
      g.imageSmoothingEnabled = false;
      g.drawImage(specCanvas, c0, 0, c1 - c0, s.bins, 0, sy, W, lane("spec")!.h);
    }

    // Where the music says each event should be: dashed guide lines (with the expected count word).
    const guide = (key: string, t: number, text?: string) => {
      const top = laneTop(key);
      const xg = x(t);
      if (top < 0 || xg < -20 || xg > W + 20) return;
      const h = lane(key)!.h;
      g.strokeStyle = GUIDE;
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(xg, top + 2);
      g.lineTo(xg, top + h - 2);
      g.stroke();
      g.setLineDash([]);
      if (text) {
        g.fillStyle = GUIDE;
        g.font = "11px system-ui";
        g.fillText(text, xg - 3, top + 11);
      }
    };
    info.notes.forEach((n) => guide("clap", n.t));
    info.counts.forEach((c) => guide("count", c.t, wordDisplay(c.label)));
    info.rests.forEach((r) => guide("pulse", r.t));

    // Hands together (from the camera): a striped bar.
    const hy = laneTop("hands");
    if (hy >= 0) {
      for (let i = 0; i < p.hands.length - 1; i++) {
        const f = p.hands[i];
        if (!f.together) continue;
        const xa = x(f.wav);
        const xb = x(p.hands[i + 1].wav);
        if (xb < 0 || xa > W) continue;
        g.fillStyle = "#64748b";
        g.fillRect(xa, hy + 6, Math.max(1, xb - xa), lane("hands")!.h - 12);
      }
    }

    // Events: shape = type, hollow = found by the app, filled = checked by a person.
    for (const e of p.events) {
      const top = laneTop(e.type);
      const xe = x(e.t);
      if (top < 0 || xe < -30 || xe > W + 30) continue;
      const h = lane(e.type)!.h;
      const sel = e.id === p.selected;
      const filled = e.source === "human" || e.source === "synthetic";
      const mid = top + h / 2 + 2;
      g.strokeStyle = INK;
      g.fillStyle = INK;
      g.lineWidth = sel ? 3 : 1.5;
      g.beginPath();
      g.moveTo(xe, top + 3);
      g.lineTo(xe, top + h - 3);
      g.stroke();
      if (sel) {
        g.lineWidth = 2;
        g.setLineDash([3, 2]);
        g.strokeRect(xe - 12, top + 2, 24 + (e.type === "count" ? 18 : 0), h - 4);
        g.setLineDash([]);
      }
      g.lineWidth = 2;
      if (e.type === "count") {
        const text = e.label ? wordDisplay(e.label) : "?";
        g.font = `bold ${sel ? 16 : 14}px system-ui`;
        if (filled) g.fillText(text, xe + 4, mid + 4);
        else {
          g.strokeStyle = INK;
          g.lineWidth = 1;
          g.strokeText(text, xe + 4, mid + 4);
        }
      } else {
        g.beginPath();
        if (e.type === "pulse") {
          g.moveTo(xe - 6, mid - 5);
          g.lineTo(xe + 6, mid - 5);
          g.lineTo(xe, mid + 5);
          g.closePath();
        } else {
          g.arc(xe, mid, 6, 0, Math.PI * 2);
        }
        if (filled) g.fill();
        else {
          g.fillStyle = "#ffffff";
          g.fill();
          g.stroke();
        }
      }
    }

    // Lane names.
    y = 0;
    g.font = "bold 11px system-ui";
    for (const l of lanes) {
      if (l.label) {
        const w = g.measureText(l.label).width;
        g.fillStyle = l.key === "spec" ? "rgba(15,23,42,0.7)" : "rgba(255,255,255,0.85)";
        g.fillRect(2, y + 2, w + 8, 15);
        g.fillStyle = l.key === "spec" ? "rgba(255,255,255,0.85)" : "#475569";
        g.fillText(l.label, 6, y + 13);
      }
      y += l.h;
    }

    // Playhead.
    const xp = x(p.time);
    g.strokeStyle = "#e11d48";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(xp, 0);
    g.lineTo(xp, height);
    g.stroke();
  });

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return p.view.start + ((clientX - r.left) / r.width) * p.view.dur;
  };
  const laneAt = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    let y = clientY - r.top;
    for (const l of lanes) {
      if (y < l.h) return l;
      y -= l.h;
    }
    return lanes[lanes.length - 1];
  };
  const hit = (clientX: number, type: EventType) => {
    const r = ref.current!.getBoundingClientRect();
    const px = (t: number) => r.left + ((t - p.view.start) / p.view.dur) * r.width;
    let best: LabelEvent | null = null;
    for (const e of p.events) {
      if (e.type !== type) continue;
      const d = Math.abs(px(e.t) - clientX);
      if (d <= 9 && (!best || d < Math.abs(px(best.t) - clientX))) best = e;
    }
    return best;
  };

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height, cursor: p.tool === "select" ? "default" : "copy", display: "block", borderRadius: 12 }}
      onMouseDown={(e) => {
        if (p.tool !== "select") {
          p.onAdd(p.tool, timeAt(e.clientX));
          return;
        }
        const l = laneAt(e.clientY);
        if (l.key === "ruler") {
          drag.current = { id: null, pan: e.clientX, startX: e.clientX, viewStart: p.view.start };
          return;
        }
        if (l.type) {
          const ev = hit(e.clientX, l.type);
          if (ev) {
            p.onSelect(ev.id);
            drag.current = { id: ev.id, pan: null, startX: e.clientX, viewStart: p.view.start };
            return;
          }
        }
        p.onSelect(null);
        p.onSeek(timeAt(e.clientX));
        drag.current = { id: null, pan: null, startX: e.clientX, viewStart: p.view.start };
      }}
      onMouseMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (d.pan !== null) {
          const r = ref.current!.getBoundingClientRect();
          const start = d.viewStart - ((e.clientX - d.pan) / r.width) * p.view.dur;
          p.onView({ ...p.view, start: Math.max(-1, Math.min(p.duration - p.view.dur + 1, start)) });
        } else if (d.id !== null) {
          if (Math.abs(e.clientX - d.startX) > 2) p.onMove(d.id, timeAt(e.clientX));
        } else {
          p.onSeek(timeAt(e.clientX));
        }
      }}
      onMouseUp={() => (drag.current = null)}
      onMouseLeave={() => (drag.current = null)}
      onWheel={(e) => {
        const t = timeAt(e.clientX);
        if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          const d = e.shiftKey ? e.deltaY : e.deltaX;
          const start = p.view.start + (d / 500) * p.view.dur;
          p.onView({ ...p.view, start: Math.max(-1, Math.min(p.duration - p.view.dur + 1, start)) });
        } else {
          const dur = Math.max(0.4, Math.min(p.duration + 2, p.view.dur * Math.exp(e.deltaY / 400)));
          const frac = (t - p.view.start) / p.view.dur;
          p.onView({ start: Math.max(-1, t - frac * dur), dur });
        }
      }}
    />
  );
};

export default Timeline;
