import React, { useEffect, useMemo, useRef } from "react";
import { countDisplay } from "../music/rhythm";
import { EventType, LabelEvent, TakeInfo } from "./labels";

// The labeler's timeline: ruler (measures/beats), waveform, spectrogram, and
// one lane per event type, all on audio.wav's clock. Click to seek, drag
// events to move them, double-click an empty lane spot to add one, wheel to
// zoom, shift+wheel (or drag the ruler) to pan.

export interface View {
  start: number;
  dur: number;
}

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
  onView: (v: View) => void;
  onSeek: (t: number) => void;
  onSelect: (id: number | null) => void;
  onMove: (id: number, t: number) => void;
  onAdd: (type: EventType, t: number) => void;
}

const LANES: { key: string; h: number; label: string; type?: EventType }[] = [
  { key: "ruler", h: 22, label: "" },
  { key: "wave", h: 64, label: "AUDIO" },
  { key: "spec", h: 96, label: "0–4 kHz" },
  { key: "clap", h: 30, label: "CLAPS", type: "clap" },
  { key: "count", h: 36, label: "COUNTS", type: "count" },
  { key: "pulse", h: 30, label: "PULSES", type: "pulse" },
  { key: "hands", h: 18, label: "HANDS" },
];
const HEIGHT = LANES.reduce((a, l) => a + l.h, 0);
const laneTop = (key: string) => {
  let y = 0;
  for (const l of LANES) {
    if (l.key === key) return y;
    y += l.h;
  }
  return 0;
};
const COLORS: Record<EventType, string> = { clap: "#059669", count: "#2563eb", pulse: "#d97706" };
const SRC_COLOR = { app: 0.55, model: 0.75, human: 1 };

const Timeline: React.FC<Props> = (p) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ id: number | null; pan: number | null; startX: number; viewStart: number } | null>(null);

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
        img.data[o + 2] = Math.min(255, v * 1.2);
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
    if (c.width !== Math.round(W * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(HEIGHT * dpr);
    }
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, HEIGHT);
    const { start, dur } = p.view;
    const x = (t: number) => ((t - start) / dur) * W;
    const { info } = p;

    // Lane backgrounds and names.
    let y = 0;
    LANES.forEach((l, i) => {
      g.fillStyle = l.key === "spec" ? "#0f172a" : i % 2 ? "#f8fafc" : "#ffffff";
      g.fillRect(0, y, W, l.h);
      y += l.h;
    });

    // Beats (gray), measure starts (dark) with numbers, across all lanes.
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
      g.lineTo(xb, HEIGHT);
      g.stroke();
      g.fillStyle = "#64748b";
      g.font = "bold 10px system-ui";
      if (measureStart) g.fillText(`m.${beatInLine / info.beatsPerMeasure + 1}`, xb + 3, 14);
      else if (!inLine) g.fillText(`in ${i + 1}`, xb + 3, 14);
    });

    // Waveform.
    const wy = laneTop("wave");
    const wh = LANES[1].h;
    g.fillStyle = "#334155";
    for (let px = 0; px < W; px++) {
      const a = Math.max(0, Math.floor((start + (px / W) * dur) * 1000));
      const b = Math.min(peaks.length, Math.ceil((start + ((px + 1) / W) * dur) * 1000));
      let m = 0;
      for (let k = a; k < b; k++) m = Math.max(m, peaks[k]);
      const h = Math.max(1, m * (wh - 6));
      g.fillRect(px, wy + wh / 2 - h / 2, 1, h);
    }

    // Spectrogram.
    if (specCanvas && p.spectrogram) {
      const sy = laneTop("spec");
      const s = p.spectrogram;
      const c0 = start / s.hop;
      const c1 = (start + dur) / s.hop;
      g.imageSmoothingEnabled = false;
      g.drawImage(specCanvas, c0, 0, c1 - c0, s.bins, 0, sy, W, LANES[2].h);
    }

    // Expected notes (claps), counts and rest pulses as faint guides.
    const guide = (key: string, t: number, text?: string) => {
      const xg = x(t);
      if (xg < -20 || xg > W + 20) return;
      const top = laneTop(key);
      const h = LANES.find((l) => l.key === key)!.h;
      g.strokeStyle = "rgba(100,116,139,0.6)";
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(xg, top + 2);
      g.lineTo(xg, top + h - 2);
      g.stroke();
      g.setLineDash([]);
      if (text) {
        g.fillStyle = "rgba(100,116,139,0.8)";
        g.font = "10px system-ui";
        g.fillText(text, xg + 2, top + 10);
      }
    };
    info.notes.forEach((n) => guide("clap", n.t));
    info.counts.forEach((c) => guide("count", c.t, countDisplay(c.label)));
    info.rests.forEach((r) => guide("pulse", r.t));

    // Hands together (from the camera).
    const hy = laneTop("hands");
    for (let i = 0; i < p.hands.length - 1; i++) {
      const f = p.hands[i];
      if (!f.together) continue;
      const xa = x(f.wav);
      const xb = x(p.hands[i + 1].wav);
      if (xb < 0 || xa > W) continue;
      g.fillStyle = "#FFB81C";
      g.fillRect(xa, hy + 4, Math.max(1, xb - xa), LANES[6].h - 8);
    }

    // Events.
    for (const e of p.events) {
      const xe = x(e.t);
      if (xe < -30 || xe > W + 30) continue;
      const top = laneTop(e.type);
      const h = LANES.find((l) => l.key === e.type)!.h;
      const sel = e.id === p.selected;
      g.globalAlpha = SRC_COLOR[e.source];
      g.fillStyle = sel ? "#e11d48" : COLORS[e.type];
      g.fillRect(xe - 1, top + 3, sel ? 3 : 2, h - 6);
      if (e.type === "count") {
        g.font = `bold ${sel ? 15 : 13}px system-ui`;
        const text = e.label ? countDisplay(e.label) : "·";
        g.fillText(text, xe + 3, top + h - 9);
      } else {
        g.beginPath();
        if (e.type === "pulse") {
          g.moveTo(xe - 5, top + 8);
          g.lineTo(xe + 5, top + 8);
          g.lineTo(xe, top + 16);
        } else {
          g.arc(xe, top + h / 2, sel ? 6 : 5, 0, Math.PI * 2);
        }
        g.fill();
      }
      g.globalAlpha = 1;
    }

    // Lane names.
    y = 0;
    g.font = "bold 9px system-ui";
    for (const l of LANES) {
      if (l.label) {
        g.fillStyle = l.key === "spec" ? "rgba(255,255,255,0.7)" : "#94a3b8";
        g.fillText(l.label, 4, y + 11);
      }
      y += l.h;
    }

    // Playhead.
    const xp = x(p.time);
    g.strokeStyle = "#e11d48";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(xp, 0);
    g.lineTo(xp, HEIGHT);
    g.stroke();
  });

  const timeAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    return p.view.start + ((clientX - r.left) / r.width) * p.view.dur;
  };
  const laneAt = (clientY: number) => {
    const r = ref.current!.getBoundingClientRect();
    let y = clientY - r.top;
    for (const l of LANES) {
      if (y < l.h) return l;
      y -= l.h;
    }
    return LANES[LANES.length - 1];
  };
  const hit = (clientX: number, type: EventType) => {
    const r = ref.current!.getBoundingClientRect();
    const px = (t: number) => r.left + ((t - p.view.start) / p.view.dur) * r.width;
    let best: LabelEvent | null = null;
    for (const e of p.events) {
      if (e.type !== type) continue;
      const d = Math.abs(px(e.t) - clientX);
      if (d <= 7 && (!best || d < Math.abs(px(best.t) - clientX))) best = e;
    }
    return best;
  };

  return (
    <canvas
      ref={ref}
      style={{ width: "100%", height: HEIGHT, cursor: "crosshair", display: "block" }}
      onMouseDown={(e) => {
        const lane = laneAt(e.clientY);
        if (lane.key === "ruler") {
          drag.current = { id: null, pan: e.clientX, startX: e.clientX, viewStart: p.view.start };
          return;
        }
        if (lane.type) {
          const ev = hit(e.clientX, lane.type);
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
      onDoubleClick={(e) => {
        const lane = laneAt(e.clientY);
        if (lane.type && !hit(e.clientX, lane.type)) p.onAdd(lane.type, timeAt(e.clientX));
      }}
      onWheel={(e) => {
        const t = timeAt(e.clientX);
        if (e.shiftKey) {
          const start = p.view.start + (e.deltaY / 500) * p.view.dur;
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
