import { useCallback, useEffect, useRef, useState } from "react";
import { audioEngine } from "../audio/AudioEngine";
import { getModelState, loadModel, ModelState, subscribeModel } from "../speech/voskModel";
import { handTracker } from "../video/HandTracker";
import { Settings } from "./settings";

export type DeviceStatus = "off" | "starting" | "on" | "error";

export interface Devices {
  mic: DeviceStatus;
  micError: string | null;
  camera: DeviceStatus;
  cameraError: string | null;
  model: ModelState;
  /** Start the mic (and camera). Must run from a click/tap. */
  enable: () => Promise<void>;
}

const describe = (err: any) => {
  const name = err?.name ?? "";
  if (name === "NotAllowedError") return "Permission denied – allow access in the browser's address bar.";
  if (name === "NotFoundError") return "No device found.";
  if (name === "NotReadableError") return "The device is in use by another app.";
  return err?.message ?? "Unknown error";
};

export const useDevices = (settings: Settings): Devices => {
  const [model, setModel] = useState<ModelState>(getModelState());
  const [mic, setMic] = useState<DeviceStatus>(audioEngine.running ? "on" : "off");
  const [micError, setMicError] = useState<string | null>(null);
  const [camera, setCamera] = useState<DeviceStatus>(handTracker.running ? "on" : "off");
  const [cameraError, setCameraError] = useState<string | null>(null);

  useEffect(() => subscribeModel(setModel), []);
  // Always load the voice engine: calibration and the counting activities need it.
  useEffect(() => {
    loadModel();
  }, []);

  const startCamera = useCallback(async () => {
    setCamera("starting");
    setCameraError(null);
    try {
      await handTracker.start(settings.cameraModel === "pose" ? "pose" : settings.liteHandModel ? "hands-lite" : "hands-full");
      setCamera("on");
    } catch (err) {
      console.error("Camera failed:", err);
      setCameraError(describe(err));
      setCamera("error");
    }
  }, [settings.cameraModel, settings.liteHandModel]);

  const enable = useCallback(async () => {
    setMic("starting");
    setMicError(null);
    try {
      await audioEngine.start(settings.micDeviceId || undefined);
      setMic("on");
    } catch (err) {
      console.error("Microphone failed:", err);
      setMicError(describe(err));
      setMic("error");
    }
    if (settings.useCamera && !handTracker.running) await startCamera();
  }, [settings.micDeviceId, settings.useCamera, startCamera]);

  // Switch microphones when a different input is chosen in Settings.
  const firstDeviceId = useRef(settings.micDeviceId);
  useEffect(() => {
    if (settings.micDeviceId === firstDeviceId.current) return;
    firstDeviceId.current = settings.micDeviceId;
    if (audioEngine.running) enable();
  }, [settings.micDeviceId, enable]);

  // A different camera model: restart the tracker with it.
  const modelKey = `${settings.cameraModel}/${settings.liteHandModel}`;
  const firstModel = useRef(modelKey);
  useEffect(() => {
    if (modelKey === firstModel.current) return;
    firstModel.current = modelKey;
    if (handTracker.running) {
      handTracker.stop();
      startCamera();
    }
  }, [modelKey, startCamera]);

  // Turning the camera setting off stops it; turning it on again starts it.
  useEffect(() => {
    if (!settings.useCamera && handTracker.running) {
      handTracker.stop();
      setCamera("off");
    } else if (settings.useCamera && mic === "on" && !handTracker.running && camera === "off") {
      startCamera();
    }
  }, [settings.useCamera, mic, camera, startCamera]);

  return { mic, micError, camera, cameraError, model, enable };
};
