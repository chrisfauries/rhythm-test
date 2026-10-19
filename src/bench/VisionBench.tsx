import { FilesetResolver, HandLandmarker, HolisticLandmarker, NormalizedLandmark, PoseLandmarker } from "@mediapipe/tasks-vision";
import { Hands, Results } from "@mediapipe/hands";
import React, { useEffect, useState } from "react";

// ?vision-bench: runs hand and pose models over the camera videos of real
// takes, frame by frame, for ml/vision-bench.js to score. Developer tool: the
// videos and model files are prepared by ml/vision-bench-prep.js into
// public/bench/ (not in git), and the run is driven from Node over CDP:
//   await window.benchVideo(name, model, stepSeconds) -> per-frame results

type Pt = [number, number, number?, number?];

export interface BenchFrame {
  /** Video time (s). */
  t: number;
  /** Hands found: palm points (wrist, index, middle, ring and pinky knuckles), x/y in 0..1. */
  hands?: { score: number; side: string; palm: Pt[] }[];
  /** Pose: shoulders, elbows, wrists, pinky, index and thumb tips (11-22), x/y/z/visibility. */
  pose?: Pt[] | null;
}

export interface BenchRun {
  model: string;
  delegate: string;
  frames: BenchFrame[];
  /** Milliseconds per frame, for each frame. */
  ms: number[];
}

const PALM = [0, 5, 9, 13, 17];
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const palmOf = (lm: { x: number; y: number }[]): Pt[] => PALM.map((i) => [r3(lm[i].x), r3(lm[i].y)]);
const poseOf = (lm: NormalizedLandmark[] | undefined): Pt[] | null =>
  lm ? lm.slice(11, 23).map((p) => [r3(p.x), r3(p.y), r3(p.z), r3(p.visibility ?? 0)]) : null;

let files: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
/** Video-mode timestamps must keep increasing for each model instance. */
let clock = 0;

type Detector = { delegate: string; run: (video: HTMLVideoElement, ms: number) => Promise<BenchFrame> | BenchFrame; close: () => void };

const makeDetector = async (model: string): Promise<Detector> => {
  if (model.startsWith("legacy-hands")) {
    const hands = new Hands({ locateFile: (f) => `${process.env.PUBLIC_URL}/mediapipe/hands/${f}` });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: model.endsWith("full") ? 1 : 0,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    let last: Results | null = null;
    hands.onResults((r) => {
      last = r;
    });
    return {
      delegate: "legacy",
      run: async (video) => {
        await hands.send({ image: video });
        const r = last as Results | null;
        return {
          t: video.currentTime,
          hands: (r?.multiHandLandmarks ?? []).map((lm, i) => ({
            score: r3(r?.multiHandedness?.[i]?.score ?? 0),
            side: r?.multiHandedness?.[i]?.label ?? "?",
            palm: palmOf(lm),
          })),
        };
      },
      close: () => hands.close(),
    };
  }
  files ??= await FilesetResolver.forVisionTasks(`${process.env.PUBLIC_URL}/bench/wasm`);
  const tryGpu = async <T,>(make: (delegate: "GPU" | "CPU") => Promise<T>): Promise<[T, string]> => {
    try {
      return [await make("GPU"), "GPU"];
    } catch (err) {
      console.warn("GPU delegate failed, using CPU:", err);
      return [await make("CPU"), "CPU"];
    }
  };
  if (model === "hand-landmarker") {
    const [lm, delegate] = await tryGpu((d) =>
      HandLandmarker.createFromOptions(files!, {
        baseOptions: { modelAssetPath: `${process.env.PUBLIC_URL}/bench/models/hand_landmarker.task`, delegate: d },
        runningMode: "VIDEO",
        numHands: 2,
      }),
    );
    return {
      delegate,
      run: (video, ms) => {
        const r = lm.detectForVideo(video, ms);
        return {
          t: video.currentTime,
          hands: r.landmarks.map((l, i) => ({
            score: r3(r.handedness[i]?.[0]?.score ?? 0),
            side: r.handedness[i]?.[0]?.categoryName ?? "?",
            palm: palmOf(l),
          })),
        };
      },
      close: () => lm.close(),
    };
  }
  if (model.startsWith("pose-")) {
    const size = model.slice(5);
    const [lm, delegate] = await tryGpu((d) =>
      PoseLandmarker.createFromOptions(files!, {
        baseOptions: { modelAssetPath: `${process.env.PUBLIC_URL}/bench/models/pose_landmarker_${size}.task`, delegate: d },
        runningMode: "VIDEO",
        numPoses: 1,
      }),
    );
    return {
      delegate,
      run: (video, ms) => ({ t: video.currentTime, pose: poseOf(lm.detectForVideo(video, ms).landmarks[0]) }),
      close: () => lm.close(),
    };
  }
  if (model === "holistic") {
    const [lm, delegate] = await tryGpu((d) =>
      HolisticLandmarker.createFromOptions(files!, {
        baseOptions: { modelAssetPath: `${process.env.PUBLIC_URL}/bench/models/holistic_landmarker.task`, delegate: d },
        runningMode: "VIDEO",
      }),
    );
    return {
      delegate,
      run: (video, ms) => {
        const r = lm.detectForVideo(video, ms);
        const hands = [
          ...(r.leftHandLandmarks[0] ? [{ score: 1, side: "Left", palm: palmOf(r.leftHandLandmarks[0]) }] : []),
          ...(r.rightHandLandmarks[0] ? [{ score: 1, side: "Right", palm: palmOf(r.rightHandLandmarks[0]) }] : []),
        ];
        return { t: video.currentTime, pose: poseOf(r.poseLandmarks[0]), hands };
      },
      close: () => lm.close(),
    };
  }
  throw new Error(`Unknown model ${model}`);
};

const seek = (video: HTMLVideoElement, t: number) =>
  new Promise<void>((resolve) => {
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = t;
  });

/** Runs one model over one video, a frame every `step` seconds. */
const benchVideo = async (name: string, model: string, step = 1 / 30): Promise<BenchRun> => {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.src = `${process.env.PUBLIC_URL}/bench/videos/${encodeURIComponent(name)}.webm`;
  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error(`Can't load ${name}`));
  });
  const det = await makeDetector(model);
  const frames: BenchFrame[] = [];
  const ms: number[] = [];
  try {
    for (let t = 0; t < video.duration - 0.05; t += step) {
      await seek(video, t);
      clock += Math.round(step * 1000);
      const a = performance.now();
      frames.push(await det.run(video, clock));
      ms.push(Math.round((performance.now() - a) * 10) / 10);
    }
  } finally {
    det.close();
  }
  return { model, delegate: det.delegate, frames, ms };
};

declare global {
  interface Window {
    benchVideo?: typeof benchVideo;
  }
}

const VisionBench: React.FC = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    window.benchVideo = benchVideo;
    setReady(true);
  }, []);
  return (
    <div className="p-8">
      <h1 className="text-2xl font-black">Vision model benchmark</h1>
      <p className="mt-2 text-slate-500">{ready ? "Ready: driven by ml/vision-bench.js." : "Loading…"}</p>
    </div>
  );
};

export default VisionBench;
