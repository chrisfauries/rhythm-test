import { useCallback, useEffect, useState } from "react";
import { Strictness } from "../analysis/analyze";
import { Activity } from "../music/activity";
import { DEFAULT_HAND_TUNING, HandTuning } from "../video/HandTracker";

export interface Settings {
  studentName: string;
  tempo: number;
  /** What the student does: clap and/or count, count only, or sing. */
  activity: Activity;
  strictness: Strictness;
  countInMeasures: 1 | 2;
  metronomeDuringLine: boolean;
  clickVolume: number;
  useCamera: boolean;
  liteHandModel: boolean;
  micDeviceId: string;
  /** 1 (only loud claps) .. 5 (very sensitive). */
  clapSensitivity: number;
  /** Clap/voice threshold learned by calibration (null = default). */
  clapBias: number | null;
  handTuning: HandTuning;
  /** Measured sensor delays in seconds (null = use defaults). Set by calibration. */
  micOffset: number | null;
  speechOffset: number | null;
  videoOffset: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  studentName: "",
  tempo: 72,
  activity: "clap-count-all",
  strictness: "normal",
  countInMeasures: 1,
  metronomeDuringLine: true,
  clickVolume: 0.6,
  useCamera: true,
  liteHandModel: true,
  micDeviceId: "",
  clapSensitivity: 3,
  clapBias: null,
  handTuning: DEFAULT_HAND_TUNING,
  micOffset: null,
  speechOffset: null,
  videoOffset: null,
};

const KEY = "rhythm-tester-settings-v1";

const load = (): Settings => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      // Older versions had a counting style and a speech on/off switch.
      if (!saved.activity && saved.countMode) {
        saved.activity = saved.useSpeech === false ? "clap" : saved.countMode === "all" ? "clap-count-all" : "clap-count-notes";
      }
      delete saved.countMode;
      delete saved.useSpeech;
      return { ...DEFAULT_SETTINGS, ...saved };
    }
  } catch {
    // ignore unavailable/corrupt storage
  }
  return DEFAULT_SETTINGS;
};

export const useSettings = () => {
  const [settings, setSettings] = useState<Settings>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // ignore
    }
  }, [settings]);
  const update = useCallback(
    (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch })),
    []
  );
  return [settings, update] as const;
};
