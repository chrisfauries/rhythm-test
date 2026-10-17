import { Hands, HAND_CONNECTIONS, NormalizedLandmarkList, Results } from "@mediapipe/hands";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { audioEngine } from "../audio/AudioEngine";
import { TogetherState, TogetherTuning } from "./together";

// Camera-based hand tracking (MediaPipe Hands, runs locally from /public).
//
// "Together" is decided from the distance between the two palm centers
// measured in *hand lengths* (wrist to middle knuckle), so it works whether
// a student sits close to the camera or far away, and from hands that were
// approaching and then merged into one detection (see together.ts).

export interface HandFrame {
  /** Audible-clock time (same domain as the metronome grid), uncorrected. */
  time: number;
  hands: number;
  /** null when we can't tell (no hands visible). */
  together: boolean | null;
  /** Palm distance in hand lengths, when both hands are visible. */
  distance: number | null;
  /** Mean palm height (fraction of frame height, larger = lower), when any hand is visible. */
  palmY?: number | null;
  /** Mean hand length as a fraction of frame height. */
  scale?: number | null;
  /** Diagnostics: raw performance.now() stamp (ms) and where it came from. */
  perf?: number;
  clock?: "capture" | "presentation" | "raf";
  /** How long MediaPipe took on this frame (ms). */
  processMs?: number;
  /** Per hand: label ("Left"/"Right" as MediaPipe sees it), score, 21 [x, y] points (0..1, unmirrored). */
  landmarks?: { label: string; score: number; points: number[][] }[];
}

export interface HandSnapshot {
  time: number;
  bitmap: ImageBitmap;
}

export type HandTuning = TogetherTuning;

export const DEFAULT_HAND_TUNING: HandTuning = { togetherBelow: 0.9, apartAbove: 1.3 };

const PALM = [0, 5, 9, 13, 17];
const MAX_SNAPSHOTS = 1500;

type Pt = { x: number; y: number };

const palmCenter = (lm: NormalizedLandmarkList, w: number, h: number): Pt => {
  let x = 0;
  let y = 0;
  for (const i of PALM) {
    x += lm[i].x * w;
    y += lm[i].y * h;
  }
  return { x: x / PALM.length, y: y / PALM.length };
};

const handLength = (lm: NormalizedLandmarkList, w: number, h: number) =>
  Math.hypot((lm[0].x - lm[9].x) * w, (lm[0].y - lm[9].y) * h);

class HandTracker {
  private hands: Hands | null = null;
  private readonly video = document.createElement("video");
  /** Offscreen canvas with the mirrored preview + skeleton; previews copy from it. */
  readonly canvas = document.createElement("canvas");
  private stream: MediaStream | null = null;
  private busy = false;
  private stopped = true;
  private frameTime = 0;
  private framePerf = 0;
  private frameClock: HandFrame["clock"] = "raf";
  private sentAt = 0;
  private state = new TogetherState(DEFAULT_HAND_TUNING);
  private recording = false;
  private frames: HandFrame[] = [];
  private snapshots: HandSnapshot[] = [];
  private listeners = new Set<(f: HandFrame) => void>();

  get tuning(): HandTuning {
    return this.state.tuning;
  }

  set tuning(t: HandTuning) {
    this.state.tuning = t;
  }
  latest: HandFrame | null = null;

  get running() {
    return !this.stopped;
  }

  /** The live camera stream (for recording a debug video). */
  get cameraStream() {
    return this.stream;
  }

  subscribe(fn: (f: HandFrame) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  async start(lite = true) {
    const video = this.video;
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      });
    }
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    if (!this.hands) {
      this.hands = new Hands({
        locateFile: (file) => `${process.env.PUBLIC_URL}/mediapipe/hands/${file}`,
      });
      this.hands.onResults((r) => this.onResults(r));
    }
    this.hands.setOptions({
      maxNumHands: 2,
      modelComplexity: lite ? 0 : 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private loop() {
    const video = this.video;
    if (this.stopped) return;
    const onFrame = async (now: number, meta?: VideoFrameCallbackMetadata) => {
      if (this.stopped) return;
      if (!this.busy && video.readyState >= 2 && this.hands) {
        this.busy = true;
        // Prefer the camera's capture timestamp; otherwise assume ~50 ms of
        // camera latency before the frame was presented.
        const perf = meta?.captureTime ?? (meta?.presentationTime ?? now) - 50;
        this.frameTime = audioEngine.perfToAudible(perf);
        this.framePerf = perf;
        this.frameClock = meta?.captureTime ? "capture" : meta?.presentationTime ? "presentation" : "raf";
        this.sentAt = performance.now();
        try {
          await this.hands.send({ image: video });
        } catch (err) {
          console.warn("Hand tracking frame failed:", err);
        }
        this.busy = false;
      }
      schedule();
    };
    const schedule = () => {
      if (this.stopped) return;
      if ("requestVideoFrameCallback" in video) {
        video.requestVideoFrameCallback(onFrame);
      } else {
        requestAnimationFrame((t) => onFrame(t));
      }
    };
    schedule();
  }

  private onResults(results: Results) {
    const canvas = this.canvas;
    const video = this.video;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;

    const hands = results.multiHandLandmarks ?? [];
    const nowMs = performance.now();
    let distance: number | null = null;
    if (hands.length >= 2) {
      const [a, b] = hands;
      const len = (handLength(a, w, h) + handLength(b, w, h)) / 2 || 1;
      const ca = palmCenter(a, w, h);
      const cb = palmCenter(b, w, h);
      distance = Math.hypot(ca.x - cb.x, ca.y - cb.y) / len;
    }
    const palmY = hands.length ? hands.reduce((a, lm) => a + palmCenter(lm, w, h).y, 0) / hands.length / h : null;
    const scale = hands.length ? hands.reduce((a, lm) => a + handLength(lm, w, h), 0) / hands.length / h : null;
    // Time by the frame (not by when MediaPipe finished it).
    const together = this.state.update(hands.length, distance, this.framePerf || nowMs);

    const frame: HandFrame = {
      time: this.frameTime,
      hands: hands.length,
      together,
      distance,
      palmY,
      scale,
      perf: Math.round(this.framePerf * 10) / 10,
      clock: this.frameClock,
      processMs: Math.round((nowMs - this.sentAt) * 10) / 10,
    };
    if (this.recording) {
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      frame.landmarks = hands.map((lm, i) => ({
        label: results.multiHandedness?.[i]?.label ?? "?",
        score: r3(results.multiHandedness?.[i]?.score ?? 0),
        points: lm.map((p) => [r3(p.x), r3(p.y)]),
      }));
    }
    this.latest = frame;

    // Draw a mirrored preview with the skeleton and a status border.
    const ctx = canvas.getContext("2d")!;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(results.image, 0, 0, w, h);
    const color = together ? "#FFB81C" : "#34d399";
    for (const lm of hands) {
      drawConnectors(ctx, lm, HAND_CONNECTIONS, { color, lineWidth: 3 });
      drawLandmarks(ctx, lm, { color: "#ffffff", fillColor: color, lineWidth: 1, radius: 3 });
    }
    ctx.restore();
    if (together) {
      ctx.strokeStyle = "#FFB81C";
      ctx.lineWidth = 12;
      ctx.strokeRect(0, 0, w, h);
    }

    if (this.recording) {
      this.frames.push(frame);
      if (this.snapshots.length < MAX_SNAPSHOTS && "createImageBitmap" in window) {
        const time = frame.time;
        createImageBitmap(canvas, { resizeWidth: 240, resizeHeight: Math.round((240 * h) / w) })
          .then((bitmap) => {
            if (this.recording) this.snapshots.push({ time, bitmap });
            else bitmap.close();
          })
          .catch(() => {});
      }
    }
    this.listeners.forEach((fn) => fn(frame));
  }

  startRecording() {
    this.discardRecording();
    this.recording = true;
  }

  stopRecording() {
    this.recording = false;
    const result = { frames: this.frames, snapshots: this.snapshots };
    this.frames = [];
    this.snapshots = [];
    return result;
  }

  private discardRecording() {
    this.snapshots.forEach((s) => s.bitmap.close());
    this.frames = [];
    this.snapshots = [];
  }
}

export const handTracker = new HandTracker();

/** Keep only the snapshots nearest to the given times; release the rest. */
export const keepSnapshotsNear = (snapshots: HandSnapshot[], times: number[]) => {
  const keep = new Set<HandSnapshot>();
  for (const t of times) {
    let best: HandSnapshot | null = null;
    for (const s of snapshots) {
      if (!best || Math.abs(s.time - t) < Math.abs(best.time - t)) best = s;
    }
    if (best && Math.abs(best.time - t) < 0.2) keep.add(best);
  }
  snapshots.forEach((s) => {
    if (!keep.has(s)) s.bitmap.close();
  });
  return Array.from(keep).sort((a, b) => a.time - b.time);
};
