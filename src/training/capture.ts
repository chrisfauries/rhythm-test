import { clickSamples, CLICK_HZ } from "../audio/AudioEngine";
import { Biquad } from "../audio/biquad";
import { encodeWav } from "../audio/Recording";
import { BundleMeta, bundleEntries, roundAll } from "../debug/debugBundle";
import { makeZip } from "../debug/zip";
import { TakeOutcome } from "../session/TakeRunner";
import { CAPTURE_FORMAT_VERSION } from "./mode";

// A training capture: everything about one take in one zip.
//
//   manifest.json     what this is: who/where/how (from the Capture dialog),
//                     the line, activity and tempo, and how the files line up
//   audio.wav         raw microphone, whole take (the time base for everything)
//   metronome.wav     the clicks as scheduled, sample-aligned to audio.wav
//   camera.webm       camera video with the mic audio muxed in
//   diagnostics.json  every detection, hand frame (with landmarks), word, and
//                     the app's grading (see README.txt for its clocks)
//   README.txt

export type Setting = "home" | "practice-room" | "band-room";
export type MicKind = "built-in" | "headset" | "external";
export type MetronomeOut = "headphones" | "speaker";
export type Performance = "as-written" | "with-mistakes" | "unsure";

export interface CaptureMeta {
  name: string;
  studentId: string;
  setting: Setting;
  mic: MicKind;
  metronome: MetronomeOut;
  performance: Performance;
  note: string;
}

const bandLog = (x: Float32Array, sr: number) => {
  const a = Biquad.highpass(sr, 1200);
  const b = Biquad.highpass(sr, 1200);
  const hop = Math.round(sr / 1000);
  const out = new Float32Array(Math.floor(x.length / hop));
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) {
      const y = b.process(a.process(x[i]));
      s += y * y;
    }
    out[f] = Math.log10(s / hop + 1e-9);
  }
  return out;
};

/**
 * How far into a second recording of the same sound the first one's moments
 * appear: b's time = a's time + lag (seconds), found by cross-correlating
 * 1 ms high-band log envelopes (claps line up sharply).
 */
export const estimateLag = (a: Float32Array, srA: number, b: Float32Array, srB: number, maxLag = 2) => {
  const ea = bandLog(a, srA);
  const eb = bandLog(b, srB);
  const meanA = ea.reduce((s, v) => s + v, 0) / ea.length;
  const meanB = eb.reduce((s, v) => s + v, 0) / eb.length;
  let best = -Infinity;
  let lag = 0;
  const L = Math.round(maxLag * 1000);
  for (let d = -L; d <= L; d++) {
    let s = 0;
    for (let i = Math.max(0, -d); i < ea.length && i + d < eb.length; i++) s += (ea[i] - meanA) * (eb[i + d] - meanB);
    if (s > best) {
      best = s;
      lag = d;
    }
  }
  return lag / 1000;
};

/** The clicks the app scheduled, rendered on audio.wav's timeline (ctx clock, before output latency). */
const renderMetronome = (outcome: TakeOutcome, length: number, sampleRate: number, t0: number) => {
  const out = new Float32Array(length);
  const normal = clickSamples(sampleRate, CLICK_HZ.normal);
  const accent = clickSamples(sampleRate, CLICK_HZ.accent);
  const volume = outcome.raw.debug.settings.clickVolume;
  outcome.raw.debug.clickTimes.forEach((t, i) => {
    const click = i % outcome.timing.beatsPerMeasure === 0 ? accent : normal;
    const at = Math.round((t - t0) * sampleRate);
    for (let k = 0; k < click.length; k++) {
      if (at + k >= 0 && at + k < length) out[at + k] += click[k] * volume;
    }
  });
  return out;
};

const decodeVideoAudio = async (video: Blob, sampleRate: number) => {
  try {
    const ctx = new OfflineAudioContext(1, 1, sampleRate);
    const buf = await ctx.decodeAudioData(await video.arrayBuffer());
    return buf.getChannelData(0);
  } catch (err) {
    console.warn("Couldn't decode the video's audio for syncing:", err);
    return null;
  }
};

export const defaultCaptureName = (exerciseId: string, activity: string, tempo: number, when = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}_${p(when.getHours())}-${p(
    when.getMinutes()
  )}-${p(when.getSeconds())}`;
  return `${exerciseId}_${activity}_${tempo}bpm_${stamp}`.replace(/[^\w.-]+/g, "-");
};

export const buildCapture = async (exercise: BundleMeta, outcome: TakeOutcome, meta: CaptureMeta) => {
  const { diag, entries } = await bundleEntries(exercise, outcome);
  const rec = outcome.raw.recording;
  const t0 = rec.startTime ?? 0;
  const enc = new TextEncoder();

  const metronome = renderMetronome(outcome, rec.length, rec.sampleRate, t0);
  entries.push({ name: "metronome.wav", data: new Uint8Array(await encodeWav(metronome, rec.sampleRate).arrayBuffer()) });

  let videoLag: number | null = null;
  if (outcome.raw.video?.size) {
    const va = await decodeVideoAudio(outcome.raw.video, rec.sampleRate);
    if (va) videoLag = estimateLag(rec.data, rec.sampleRate, va, rec.sampleRate);
  }

  const manifest = {
    format: "rhythm-tester-capture",
    formatVersion: CAPTURE_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    ...meta,
    exercise: { ...exercise, activity: outcome.result.activity },
    files: {
      audio: "audio.wav",
      metronome: "metronome.wav",
      video: entries.some((e) => e.name.startsWith("camera.")) ? entries.find((e) => e.name.startsWith("camera."))!.name : null,
      diagnostics: "diagnostics.json",
    },
    sync: {
      timeBase: "audio.wav",
      sampleRate: rec.sampleRate,
      // audio.wav sample 0 is at this AudioContext time.
      wavStartCtx: t0,
      // metronome.wav holds each click at its *scheduled* time; it reaches the
      // student's ears outputLatency later and the mic about micOffset later.
      metronome: "scheduled",
      outputLatency: diag.clocks.atStart.outputLatency,
      micOffset: outcome.micOffset,
      // camera.webm time = audio.wav time + videoLag (from its own audio track).
      videoLag,
      lineStartWav: diag.timing.lineStartWav,
      secPerBeat: outcome.timing.secPerBeat,
    },
    summary: outcome.result.summary,
  };
  entries.unshift({ name: "manifest.json", data: enc.encode(JSON.stringify(manifest, roundAll, 1)) });
  return makeZip(entries);
};
