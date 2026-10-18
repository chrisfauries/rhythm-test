import { attach, Click } from "../audio/useClickTrack";

// Makes one video file of a take with the metronome mixed into its sound, for
// students to hand in (e.g. on Google Classroom). The browser can't mix audio
// into a video file directly, so it plays the take once, out of sight and
// silently, and records the picture plus the take's sound and the clicks.
// That takes as long as the take itself.

/** Formats to try, best first: MP4 opens everywhere; WebM is Chrome's fallback. */
const TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

const once = (el: EventTarget, event: string) =>
  new Promise<void>((resolve) => el.addEventListener(event, () => resolve(), { once: true }));

export interface ExportedTake {
  blob: Blob;
  /** File extension for the format it came out in: "mp4" or "webm". */
  ext: string;
}

export const exportTakeWithClick = async (src: string, clicks: Click[], onProgress: (fraction: number) => void): Promise<ExportedTake> => {
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error("This browser can't record video.");

  const v = document.createElement("video");
  v.src = src;
  v.playsInline = true;
  v.preload = "auto";
  await once(v, "loadedmetadata");
  // MediaRecorder videos have no duration until scanned to the end.
  if (!Number.isFinite(v.duration)) {
    const known = once(v, "durationchange");
    v.currentTime = 1e6;
    await known;
  }
  const duration = v.duration;
  v.currentTime = 0;
  await once(v, "seeked");

  // The take's sound and the clicks, mixed; nothing goes to the speakers.
  const ctx = new AudioContext();
  const mix = ctx.createMediaStreamDestination();
  ctx.createMediaElementSource(v).connect(mix);
  const detach = attach(v, { current: clicks }, { current: true }, { ctx, node: mix, volume: 0.6 });

  const picture = (v as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
  try {
    const playing = once(v, "playing");
    await v.play();
    await playing;
    v.pause();
    v.currentTime = 0;
    await once(v, "seeked");
    const stream = new MediaStream([...picture.getVideoTracks(), ...mix.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = once(rec, "stop");
    rec.start(1000);
    const ended = once(v, "ended");
    await v.play();
    const timer = window.setInterval(() => onProgress(Math.min(1, v.currentTime / duration)), 200);
    // Belt and braces: stop a little after the end even if "ended" never fires.
    await Promise.race([ended, new Promise((r) => setTimeout(r, (duration + 3) * 1000))]);
    window.clearInterval(timer);
    rec.stop();
    await stopped;
    onProgress(1);
    return { blob: new Blob(chunks, { type: type.split(";")[0] }), ext: type.startsWith("video/mp4") ? "mp4" : "webm" };
  } finally {
    detach();
    v.pause();
    picture.getTracks().forEach((t) => t.stop());
    v.removeAttribute("src");
    v.load();
    ctx.close();
  }
};
