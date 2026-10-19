import { FilesetResolver, NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import { Hands, HAND_CONNECTIONS, NormalizedLandmarkList, Results } from "@mediapipe/hands";
import { drawConnectors, drawLandmarks } from "@mediapipe/drawing_utils";
import { audioEngine } from "../audio/AudioEngine";
import { TogetherState, TogetherTuning } from "./together";

// Camera tracking of the hands, locally (models in /public/mediapipe).
//
// Two backends, chosen in Settings:
//   pose  (default) MediaPipe Pose Landmarker lite: the arms and hands from
//         the whole body, so both hands stay located while they're pressed
//         together. In the benchmark on 24 real takes (ml/vision-bench.js,
//         ml/vision-tune.js) it caught 98% of clap contacts and 97% of held
//         long notes, with "together" on 1% of rest beats; the hand model
//         below managed 67%, 91% and 34%.
//   hands MediaPipe Hands (legacy, lite or full): 21 points per hand, but it
//         usually loses one hand at the moment of contact.
//
// "Together" is decided from the distance between the two hands measured in
// *hand lengths* (for pose: 0.45 of a forearm), so it works whether a student
// sits close to the camera or far away, and from hands that were approaching
// and then merged into one detection (see together.ts).

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
  /** Pose backend: shoulders, elbows, wrists, pinky, index and thumb (landmarks 11-22), [x, y, z, visibility]. */
  pose?: number[][];
}

/** Which model tracks the hands. */
export type CameraModel = "pose" | "hands-lite" | "hands-full";

export interface HandSnapshot {
  time: number;
  bitmap: ImageBitmap;
}

export type HandTuning = TogetherTuning;

export const DEFAULT_HAND_TUNING: HandTuning = { togetherBelow: 0.9, apartAbove: 1.3 };
/** Tuned on the benchmark takes (ml/vision-tune.js --curve 0.45). */
export const DEFAULT_POSE_TUNING: HandTuning = { togetherBelow: 1.3, apartAbove: 1.5 };

/** A hand length as a share of the forearm (elbow to wrist), for the pose backend. */
const HAND_PER_FOREARM = 0.45;
/** Pose landmarks used: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 17-22 pinky, index, thumb. */
const POSE_FIRST = 11;
const POSE_ARMS: [number, number][] = [
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 12],
  [15, 17],
  [15, 19],
  [15, 21],
  [16, 18],
  [16, 20],
  [16, 22],
];

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

const handLength = (lm: NormalizedLandmarkList, w: number, h: number) => Math.hypot((lm[0].x - lm[9].x) * w, (lm[0].y - lm[9].y) * h);

class HandTracker {
  private hands: Hands | null = null;
  private pose: PoseLandmarker | null = null;
  private model: CameraModel = "pose";
  /** Pose timestamps must keep increasing. */
  private poseClock = 0;
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

  get cameraModel() {
    return this.model;
  }

  async start(model: CameraModel = "pose") {
    this.model = model;
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

    if (model === "pose") {
      if (!this.pose) this.pose = await createPose();
    } else {
      if (!this.hands) {
        this.hands = new Hands({
          locateFile: (file) => `${process.env.PUBLIC_URL}/mediapipe/hands/${file}`,
        });
        this.hands.onResults((r) => this.onResults(r));
      }
      this.hands.setOptions({
        maxNumHands: 2,
        modelComplexity: model === "hands-lite" ? 0 : 1,
        minDetectionConfidence: 0.6,
        minTrackingConfidence: 0.5,
      });
    }
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
      if (!this.busy && video.readyState >= 2 && (this.model === "pose" ? this.pose : this.hands)) {
        this.busy = true;
        // Prefer the camera's capture timestamp; otherwise assume ~50 ms of
        // camera latency before the frame was presented.
        const perf = meta?.captureTime ?? (meta?.presentationTime ?? now) - 50;
        this.frameTime = audioEngine.perfToAudible(perf);
        this.framePerf = perf;
        this.frameClock = meta?.captureTime ? "capture" : meta?.presentationTime ? "presentation" : "raf";
        this.sentAt = performance.now();
        try {
          if (this.model === "pose") {
            this.poseClock = Math.max(this.poseClock + 1, Math.round(performance.now()));
            const r = this.pose!.detectForVideo(video, this.poseClock);
            this.onPose(r.landmarks[0] ?? null);
          } else await this.hands!.send({ image: video });
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

  /** Pose backend: hands from the arms (see the top of this file). */
  private onPose(lm: NormalizedLandmark[] | null) {
    const canvas = this.canvas;
    const video = this.video;
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const nowMs = performance.now();
    const px = (i: number) => ({ x: lm![i].x * w, y: lm![i].y * h });
    const seen = lm ? [15, 16].map((i) => (lm[i].visibility ?? 0) >= 0.5) : [false, false];
    const hands = seen.filter(Boolean).length;
    // A hand: the middle of its wrist, pinky, index and thumb points.
    const handAt = (wrist: number) => {
      const pts = [wrist, wrist + 2, wrist + 4, wrist + 6].map(px);
      return { x: pts.reduce((a, p) => a + p.x, 0) / 4, y: pts.reduce((a, p) => a + p.y, 0) / 4 };
    };
    const forearm = (wrist: number) => Math.hypot(px(wrist).x - px(wrist - 2).x, px(wrist).y - px(wrist - 2).y);
    const sides = [15, 16].filter((_, k) => seen[k]);
    const unit = sides.length ? (HAND_PER_FOREARM * sides.reduce((a, s) => a + forearm(s), 0)) / sides.length || 1 : 1;
    const centers = sides.map(handAt);
    const distance = hands === 2 ? Math.hypot(centers[0].x - centers[1].x, centers[0].y - centers[1].y) / unit : null;
    const together = this.state.update(hands, distance, this.framePerf || nowMs);

    const frame: HandFrame = {
      time: this.frameTime,
      hands,
      together,
      distance,
      palmY: centers.length ? centers.reduce((a, c) => a + c.y, 0) / centers.length / h : null,
      scale: centers.length ? unit / h : null,
      perf: Math.round(this.framePerf * 10) / 10,
      clock: this.frameClock,
      processMs: Math.round((nowMs - this.sentAt) * 10) / 10,
    };
    if (this.recording && lm) {
      const r3 = (x: number) => Math.round(x * 1000) / 1000;
      frame.pose = lm.slice(POSE_FIRST, POSE_FIRST + 12).map((p) => [r3(p.x), r3(p.y), r3(p.z), r3(p.visibility ?? 0)]);
    }
    this.latest = frame;

    // Mirrored preview with the arms and hands.
    const ctx = canvas.getContext("2d")!;
    ctx.save();
    ctx.clearRect(0, 0, w, h);
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, w, h);
    const color = together ? "#FFB81C" : "#34d399";
    if (lm) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      for (const [a, b] of POSE_ARMS) {
        if ((lm[a].visibility ?? 0) < 0.5 || (lm[b].visibility ?? 0) < 0.5) continue;
        ctx.beginPath();
        ctx.moveTo(px(a).x, px(a).y);
        ctx.lineTo(px(b).x, px(b).y);
        ctx.stroke();
      }
      ctx.fillStyle = "#ffffff";
      for (const c of centers) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, 9, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
    if (together) {
      ctx.strokeStyle = "#FFB81C";
      ctx.lineWidth = 12;
      ctx.strokeRect(0, 0, w, h);
    }
    this.record(frame);
    this.listeners.forEach((fn) => fn(frame));
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

    this.record(frame);
    this.listeners.forEach((fn) => fn(frame));
  }

  /** While a take records: keep the frame and a small snapshot of the preview. */
  private record(frame: HandFrame) {
    if (!this.recording) return;
    this.frames.push(frame);
    const canvas = this.canvas;
    if (this.snapshots.length < MAX_SNAPSHOTS && "createImageBitmap" in window) {
      const time = frame.time;
      createImageBitmap(canvas, { resizeWidth: 240, resizeHeight: Math.round((240 * canvas.height) / canvas.width) })
        .then((bitmap) => {
          if (this.recording) this.snapshots.push({ time, bitmap });
          else bitmap.close();
        })
        .catch(() => {});
    }
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

/** The pose model, on the GPU when the browser allows it. */
const createPose = async () => {
  const files = await FilesetResolver.forVisionTasks(`${process.env.PUBLIC_URL}/mediapipe/tasks-vision`);
  const make = (delegate: "GPU" | "CPU") =>
    PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${process.env.PUBLIC_URL}/mediapipe/pose/pose_landmarker_lite.task`, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  try {
    return await make("GPU");
  } catch (err) {
    console.warn("Pose model: no GPU, using the CPU:", err);
    return await make("CPU");
  }
};

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
