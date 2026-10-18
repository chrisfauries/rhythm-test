import { energyToDb } from "../audio/ClapDetector";
import { rawClapScore } from "../audio/clapClassifier";
import { encodeWav } from "../audio/Recording";
import { TakeOutcome } from "../session/TakeRunner";
import { makeZip, ZipEntry } from "./zip";

// One download per take with everything needed to reproduce it offline:
//   audio.wav         raw microphone (no browser processing), whole take
//   camera.webm       camera video with the mic audio muxed in (if camera on)
//   diagnostics.json  every sensor event, clock, latency and grading decision
//   README.txt        short summary and how the times line up

export interface BundleMeta {
  id: string;
  title: string;
  source: string;
  timeSig: string;
  tempo: number;
}

const README = `Rhythm tester debug bundle

Times in diagnostics.json:
  "ctx"  AudioContext clock, seconds. Clicks are scheduled on it; mic samples
         are stamped with it when the AudioWorklet saw them.
  "wav"  seconds into audio.wav. For mic events wav = ctx - wavStartCtx.
         For beat-grid / "audible" events (clicks as heard, grader times,
         camera frames) wav = ctx + micOffset - wavStartCtx, i.e. where that
         moment shows up in the recording if micOffset is right.
camera.webm starts at roughly video.startedAtWav seconds into audio.wav; it
contains the same mic audio, so the two can be aligned exactly by
cross-correlation.
`;

export const roundAll = (_k: string, v: unknown) => {
  if (typeof v !== "number" || Number.isInteger(v) || !Number.isFinite(v)) return v;
  return Math.abs(v) >= 1 ? Math.round(v * 1e4) / 1e4 : Number(v.toPrecision(4));
};

const db = (e: number) => Math.round(energyToDb(e) * 10) / 10;

export const buildDiagnostics = (meta: BundleMeta, outcome: TakeOutcome) => {
  const { raw, timing, result } = outcome;
  const d = raw.debug;
  const rec = raw.recording;
  const t0 = rec.startTime ?? 0;
  const micOff = outcome.micOffset;
  const wav = (t: number) => t - t0;
  const heard = (t: number) => t + micOff - t0;
  const expected = result.notes.map((n) => n.expectedTime);
  const nearest = (t: number) => {
    let best = -1;
    expected.forEach((e, i) => {
      if (best < 0 || Math.abs(e - t) < Math.abs(expected[best] - t)) best = i;
    });
    return best < 0 ? null : { note: best, offsetMs: Math.round((t - expected[best]) * 1000) };
  };

  return {
    version: 1,
    exercise: meta,
    app: {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      screen: { w: window.screen.width, h: window.screen.height, dpr: window.devicePixelRatio },
    },
    startedAt: d.startedAt,
    settings: d.settings,
    clocks: { atStart: d.clockAtStart, atEnd: d.clockAtEnd, finishTimer: d.finish },
    wavStartCtx: t0,
    offsets: d.offsets,
    timing: {
      ...timing,
      countInStartWav: heard(timing.countInStart),
      lineStartWav: heard(timing.lineStart),
      lineEndWav: heard(timing.lineEnd),
    },
    clicks: d.clickTimes.map((t, i) => ({ i, ctx: t, wav: heard(t) })),
    audio: {
      sampleRate: rec.sampleRate,
      seconds: rec.length / rec.sampleRate,
      chunks: rec.chunks,
      glitches: rec.glitches.map((g) => ({ wav: wav(g.time), seconds: g.seconds })),
    },
    bleed: { hits: d.bleedHits.map((h) => ({ ...h, peakDb: db(h.peak) })), detected: d.bleed },
    clapBias: d.bias,
    candidates: raw.candidates.map((c) => ({
      ctx: c.time,
      wav: wav(c.time),
      isClap: c.isClap,
      gated: c.gated,
      score: c.score,
      rawScore: rawClapScore(c.features),
      ...c.features,
      hiRatio: c.hiRatio,
      peakDb: db(c.peak),
      preDb: db(c.pre),
      backgroundDb: db(c.background),
      nearest: nearest(c.time - micOff),
    })),
    words: raw.words.map((w) => ({
      word: w.word,
      label: w.label,
      conf: w.conf,
      refinedWav: wav(w.time),
      voskStartWav: wav(w.voskTime),
      voskEndWav: wav(w.end),
      refineShiftMs: Math.round((w.time - w.voskTime) * 1000),
    })),
    voiceRuns: d.voiceRuns.map((r) => ({ startWav: wav(r.start), endWav: wav(r.end) })),
    voicedSegments: d.voicedSegments.map((s) => ({
      onsetWav: wav(s.onset),
      startWav: wav(s.start),
      endWav: wav(s.end),
      peakWav: wav(s.peakTime),
      peakDb: db(s.peak),
    })),
    vosk: d.vosk.map((e) => ({
      ...e,
      fedUntilWav: wav(e.fedUntil),
      words: e.words?.map((w) => ({ ...w, startWav: wav(w.start), endWav: wav(w.end) })),
    })),
    video: d.video && {
      ...d.video,
      startedAtWav: d.video.startedAt === null ? null : wav(d.video.startedAt),
      bytes: raw.video?.size ?? 0,
    },
    hands: raw.frames.map((f) => ({ ...f, wav: heard(f.time) })),
    grader: {
      input: d.graderInput,
      notes: result.notes,
      counts: result.counts,
      rests: result.rests,
      countModel: d.countModel,
      by: d.grader,
      audioModel: d.audioModel,
      extraClaps: result.extraClaps,
      extraWords: result.extraWords,
      summary: result.summary,
      secPerQ: result.secPerQ,
      startTime: result.startTime,
    },
  };
};

const summaryText = (diag: ReturnType<typeof buildDiagnostics>) => {
  const s = diag.grader.summary;
  const p = (x: number | null) => (x === null ? "-" : `${Math.round(x * 100)}%`);
  const ms = (x: number) => `${Math.round(x * 1000)} ms`;
  return [
    `Exercise ${diag.exercise.id} (${diag.exercise.title}) at ${diag.exercise.tempo} BPM, ${diag.startedAt}`,
    `Line: ${diag.exercise.source}`,
    `Scores: overall ${p(s.overall)}, claps ${p(s.clapScore)}, counts ${p(s.countScore)}, holds ${p(s.holdScore)}`,
    `Offsets: mic ${ms(diag.offsets.mic)}, speech ${ms(diag.offsets.speech)}, video ${ms(diag.offsets.video)}` +
      ` (calibrated: ${Object.entries(diag.offsets.calibrated)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ") || "none"})`,
    `Clap candidates: ${diag.candidates.length}, classed as claps: ${diag.candidates.filter((c) => c.isClap && !c.gated).length}`,
    `Words: ${diag.words.length}, voiced segments: ${diag.voicedSegments.length}, camera frames: ${diag.hands.length}`,
    `Mic: ${diag.clocks.atStart.micLabel ?? "?"}`,
    "",
  ].join("\n");
};

/** The bundle's files: README, diagnostics.json, audio.wav and the camera video. */
export const bundleEntries = async (meta: BundleMeta, outcome: TakeOutcome) => {
  const diag = buildDiagnostics(meta, outcome);
  const rec = outcome.raw.recording;
  const enc = new TextEncoder();
  const wavBlob = encodeWav(rec.data, rec.sampleRate, `rhythm-tester take ${meta.id}; see diagnostics.json`);
  const entries: ZipEntry[] = [
    { name: "README.txt", data: enc.encode(summaryText(diag) + "\n" + README) },
    { name: "diagnostics.json", data: enc.encode(JSON.stringify(diag, roundAll, 1)) },
    { name: "audio.wav", data: new Uint8Array(await wavBlob.arrayBuffer()) },
  ];
  const video = outcome.raw.video;
  if (video && video.size) {
    const ext = video.type.includes("mp4") ? "mp4" : "webm";
    entries.push({ name: `camera.${ext}`, data: new Uint8Array(await video.arrayBuffer()) });
  }
  return { diag, entries };
};

export const downloadBlob = (blob: Blob, name: string) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

export const downloadDebugBundle = async (meta: BundleMeta, outcome: TakeOutcome) => {
  const { entries } = await bundleEntries(meta, outcome);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadBlob(makeZip(entries), `debug-${meta.id}-${meta.tempo}bpm-${stamp}.zip`);
};
