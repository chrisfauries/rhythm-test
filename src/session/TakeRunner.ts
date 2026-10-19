import { Model } from "vosk-browser";
import { analyzeTake, TakeFrame, TakeResult, TakeWord } from "../analysis/analyze";
import { audioEngine, ClickHandle } from "../audio/AudioEngine";
import { CANDIDATE_OPTIONS, CLASSIFY_DELAY, ClapCandidate, clapBias, classifyCandidate } from "../audio/clapClassifier";
import { ClapDetector, Onset } from "../audio/ClapDetector";
import { Recording } from "../audio/Recording";
import { sungOnsets, VoicedSegment, voiceFrames, voicedSegments, voiceOnsetNear, VoiceRun, voiceRuns } from "../audio/voice";
import { activityInfo } from "../music/activity";
import { AudioEvents, loadAudioModel, modelGraderInput } from "../ml/audioModel";
import { CountPrediction, loadCountModel } from "../ml/countModel";
import { toFeatureRate } from "../ml/features";
import { COUNT_MODEL_RULE, USE_AUDIO_MODEL, USE_COUNT_MODEL } from "../ml/flags";
import { beatsPerPulse, Line, lineBeats } from "../music/rhythm";
import { CountSession, HeardWord, VoskEvent } from "../speech/CountRecognizer";
import { refineWordTimes } from "../speech/wordTiming";
import { learnedMicOffset, recordTakeDelay, takeDelay } from "../state/latency";
import { Settings } from "../state/settings";
import { TRAINING } from "../training/mode";
import { cameraLag } from "../video/cameraLag";
import { HandFrame, HandSnapshot, handTracker, keepSnapshotsNear } from "../video/HandTracker";

/** The count-in is always four clicks, whatever the meter: "1, 2, Ready, Go!". */
export const COUNT_IN_CLICKS = 4;

type ClickTiming = Pick<TakeTiming, "countInStart" | "secPerBeat" | "countInBeats" | "beatsPerMeasure" | "beatsPerClick">;

/**
 * The metronome of a take: four count-in clicks, then (with the line) one per
 * pulse, a dotted quarter in 6/8. Accented: the first count-in click, then
 * each downbeat of the line.
 */
export const takeClicks = (timing: ClickTiming, lineBeats: number) => {
  const per = timing.beatsPerClick ?? 1;
  const countIn = Math.round(timing.countInBeats / per);
  return Array.from({ length: countIn + Math.ceil(lineBeats / per - 1e-6) }, (_, i) => ({
    time: timing.countInStart + i * per * timing.secPerBeat,
    accent: i < countIn ? i === 0 : ((i - countIn) * per) % timing.beatsPerMeasure === 0,
  }));
};

export interface TakeTiming {
  /** Audible time of the first count-in click. */
  countInStart: number;
  /** Audible time of beat 1 of the line. */
  lineStart: number;
  lineEnd: number;
  secPerBeat: number;
  /** In counted beats (eighths in 6/8), like secPerBeat. */
  countInBeats: number;
  beatsPerMeasure: number;
  /** Counted beats per metronome click: 3 in 6/8 (a click per dotted quarter); missing in older takes (1). */
  beatsPerClick?: number;
}

export interface RawWord extends HeardWord {
  /** The time Vosk reported (HeardWord.time is the refined vowel onset). */
  voskTime: number;
}

/** Everything needed to reconstruct and debug a take offline. */
export interface TakeDebug {
  startedAt: string;
  /** Settings the take ran with (student name left out). */
  settings: Omit<Settings, "studentName">;
  clockAtStart: ReturnType<typeof audioEngine.clockInfo>;
  clockAtEnd: ReturnType<typeof audioEngine.clockInfo> | null;
  /** Scheduled click times (context clock). */
  clickTimes: number[];
  /** Count-in onsets used to decide whether the metronome leaks into the mic. */
  bleedHits: { click: number; delay: number; peak: number }[];
  bleed: { delay: number; level: number } | null;
  bias: number;
  offsets: {
    mic: number;
    speech: number;
    video: number;
    /** Which offsets came from calibration (vs. defaults). */
    calibrated: { mic: boolean; speech: boolean; video: boolean };
    /** Where the mic delay came from: calibration, learned from earlier takes, or the browser's estimate. */
    micSource?: "calibrated" | "learned" | "browser";
    /** The camera delay measured on this take (hands meeting vs claps heard), if it could be. */
    videoMeasured?: { lag: number; pairs: number } | null;
  };
  voicedSegments: VoicedSegment[];
  /** Looser voicing runs (counts under claps, sustained singing). */
  voiceRuns: VoiceRun[];
  /** The count-word model's prediction at every expected count, when it was on. */
  countModel: { expectedTime: number; label: string; prediction: CountPrediction }[] | null;
  vosk: VoskEvent[];
  /** What graded the take: the audio model, or the clap detector, voicing rules and Vosk. */
  grader: "audio-model" | "rules";
  /** The audio model's events (seconds into the recording), when it graded. */
  audioModel: { trainedOn: string | null; events: AudioEvents } | null;
  /** Exactly what the grader was given (offsets applied). */
  graderInput: {
    claps: number[];
    words: TakeWord[] | null;
    frames: TakeFrame[] | null;
  };
  /** When the end timer fired vs. when it was due (context clock). */
  finish: { due: number; fired: number | null };
  video: {
    mimeType: string;
    startedAt: number | null;
    startedPerf: number | null;
    error?: string;
  } | null;
}

export interface RawTake {
  /** Every clap candidate, classified (sensor clock, no offsets applied). */
  candidates: ClapCandidate[];
  words: RawWord[];
  frames: HandFrame[];
  recording: Recording;
  /** Camera video with the mic audio, when the camera was on. */
  video: Blob | null;
  debug: TakeDebug;
}

export interface TakeOutcome {
  timing: TakeTiming;
  result: TakeResult;
  /** Snapshots with times corrected to the beat grid. */
  snapshots: HandSnapshot[];
  raw: RawTake;
  /** Camera frames with times corrected to the beat grid (null without camera). */
  frames: TakeFrame[] | null;
  usedSpeech: boolean;
  usedCamera: boolean;
  micOffset: number;
}

export interface TakeCallbacks {
  onClap?: (time: number) => void;
  onPartialWords?: (text: string) => void;
}

const LEAD_IN = 0.35;
const TAIL = 0.8;

interface Bleed {
  /** Delay from a scheduled click to its bleed onset at the mic. */
  delay: number;
  level: number;
}

/**
 * Runs one performance of a line: count-in, metronome, recording from every
 * sensor, then analysis. Times from each sensor are corrected by that
 * sensor's calibrated delay so everything lines up with the clicks.
 */
export class TakeRunner {
  readonly timing: TakeTiming;
  private clicks: ClickHandle | null = null;
  private clickTimes: number[] = [];
  private unsubscribe: (() => void) | null = null;
  private detector: ClapDetector;
  private readonly bias: number;
  private recording: Recording;
  private speech: CountSession | null = null;
  private waiting: Onset[] = [];
  private candidates: ClapCandidate[] = [];
  private onsets: Onset[] = [];
  private bleed: Bleed | null = null;
  private bleedChecked = false;
  private endTimer: number | null = null;
  private resolveDone: ((o: TakeOutcome | null) => void) | null = null;
  readonly done: Promise<TakeOutcome | null>;
  private cancelled = false;
  private recorder: MediaRecorder | null = null;
  private videoChunks: Blob[] = [];
  private videoInfo: TakeDebug["video"] = null;
  private bleedHits: TakeDebug["bleedHits"] = [];
  private startedAt = "";
  private clockAtStart: TakeDebug["clockAtStart"] | null = null;
  private finishDue = 0;

  constructor(
    private readonly line: Line,
    private readonly bpm: number,
    private readonly settings: Settings,
    model: Model | null,
    private readonly callbacks: TakeCallbacks = {},
  ) {
    // The tempo is in pulses (dotted quarters in 6/8); timing runs in counted beats.
    const beatsPerClick = beatsPerPulse(line.timeSig);
    const secPerBeat = 60 / bpm / beatsPerClick;
    const beatsPerMeasure = line.timeSig.num;
    const countInBeats = COUNT_IN_CLICKS * beatsPerClick;
    const countInStart = audioEngine.now() + LEAD_IN;
    const lineStart = countInStart + countInBeats * secPerBeat;
    this.timing = {
      countInStart,
      lineStart,
      lineEnd: lineStart + lineBeats(line) * secPerBeat,
      secPerBeat,
      countInBeats,
      beatsPerMeasure,
      beatsPerClick,
    };
    this.detector = new ClapDetector(audioEngine.sampleRate, CANDIDATE_OPTIONS);
    this.bias = clapBias(settings.clapBias, settings.clapSensitivity);
    this.recording = new Recording(audioEngine.sampleRate, lineBeats(line) * secPerBeat + 10);
    if (activityInfo(settings.activity).countMode && model) {
      this.speech = new CountSession(model, audioEngine.sampleRate, callbacks.onPartialWords);
    }
    if (USE_AUDIO_MODEL) loadAudioModel();
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  /**
   * The microphone delay for this take: calibration if it was done, else the
   * one learned from earlier takes on this device (state/latency.ts), else the
   * browser's own estimate. Fixed when the take starts.
   */
  private delay: { value: number; source: "calibrated" | "learned" | "browser" } | null = null;
  get micOffset() {
    if (!this.delay) {
      const learned = learnedMicOffset(audioEngine.deviceLabel).offset;
      this.delay =
        this.settings.micOffset !== null
          ? { value: this.settings.micOffset, source: "calibrated" }
          : learned !== null
            ? { value: learned, source: "learned" }
            : { value: audioEngine.defaultMicOffset, source: "browser" };
    }
    return this.delay.value;
  }

  start() {
    const { lineEnd, secPerBeat } = this.timing;
    const events = takeClicks(this.timing, this.settings.metronomeDuringLine ? lineBeats(this.line) : 0);
    this.clickTimes = events.map((e) => e.time);
    this.startedAt = new Date().toISOString();
    this.clockAtStart = audioEngine.clockInfo();
    this.clicks = audioEngine.scheduleClicks(events, this.settings.clickVolume);

    this.unsubscribe = audioEngine.subscribe((samples, time) => {
      this.recording.append(samples, time);
      for (const onset of this.detector.process(samples, time)) {
        this.onsets.push(onset);
        this.waiting.push(onset);
      }
      if (!this.bleedChecked && time > this.timing.lineStart - secPerBeat * 0.4) this.checkBleed();
      this.classifyReady(this.recording.endTime - CLASSIFY_DELAY);
      this.speech?.feed(samples, time);
    });

    if (this.settings.useCamera && handTracker.running) {
      handTracker.startRecording();
      this.startVideo();
    }

    this.finishDue = lineEnd + TAIL + this.micOffset;
    const ms = (this.finishDue - audioEngine.now()) * 1000;
    this.endTimer = window.setTimeout(() => this.finish(), ms);
  }

  /** Records the camera with the mic audio muxed in (the browser keeps them in sync). */
  private startVideo() {
    const cam = handTracker.cameraStream;
    if (!cam || typeof MediaRecorder === "undefined") return;
    const tracks = [...cam.getVideoTracks(), ...(audioEngine.micStream?.getAudioTracks() ?? [])];
    const mimeType = ["video/webm;codecs=vp8,opus", "video/webm", "video/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    this.videoInfo = { mimeType, startedAt: null, startedPerf: null };
    try {
      const rec = new MediaRecorder(new MediaStream(tracks), {
        mimeType,
        videoBitsPerSecond: TRAINING ? 5_000_000 : 2_500_000,
      });
      rec.ondataavailable = (e) => e.data.size && this.videoChunks.push(e.data);
      rec.onstart = () => {
        if (!this.videoInfo) return;
        this.videoInfo.startedAt = audioEngine.now();
        this.videoInfo.startedPerf = performance.now();
      };
      rec.start(1000);
      this.recorder = rec;
    } catch (err) {
      this.videoInfo.error = String(err);
    }
  }

  private stopVideo(): Promise<Blob | null> {
    const rec = this.recorder;
    this.recorder = null;
    if (!rec || rec.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(this.videoChunks, { type: rec.mimeType || "video/webm" }));
      rec.stop();
    });
  }

  private classifyReady(upTo: number) {
    const rec = this.recording;
    while (this.waiting.length && this.waiting[0].time <= upTo) {
      const onset = this.waiting.shift()!;
      const c = classifyCandidate(rec.data, rec.sampleRate, rec.startTime ?? 0, onset, this.bias);
      c.gated = this.isBleed(c);
      this.candidates.push(c);
      const t = c.time - this.micOffset;
      if (c.isClap && !c.gated && t > this.timing.lineStart - this.timing.secPerBeat * 0.6) {
        this.callbacks.onClap?.(t);
      }
    }
  }

  /**
   * Speakers playing the metronome leak clicks into the mic. Bleed is
   * mechanical: it shows up at nearly the same delay after every count-in
   * click, which a person clapping or counting along never manages. Only then
   * do we ignore onsets at that delay that aren't clearly louder than it.
   */
  private checkBleed() {
    this.bleedChecked = true;
    const countIn = this.clickTimes.slice(0, COUNT_IN_CLICKS);
    if (countIn.length < 3) return;
    const hits = countIn
      .map((c) => this.onsets.find((o) => o.time >= c && o.time <= c + 0.3))
      .map((o, i) => (o ? { click: countIn[i], delay: o.time - countIn[i], peak: o.peak } : null))
      .filter((h): h is { click: number; delay: number; peak: number } => h !== null);
    this.bleedHits = hits;
    if (hits.length < Math.ceil(countIn.length * 0.75)) return;
    const delays = hits.map((h) => h.delay).sort((a, b) => a - b);
    if (delays[delays.length - 1] - delays[0] > 0.003) return;
    this.bleed = {
      delay: delays[Math.floor(delays.length / 2)],
      level: Math.max(...hits.map((h) => h.peak)),
    };
  }

  private isBleed(o: Onset) {
    const b = this.bleed;
    if (!b || o.peak >= b.level * 4) return false;
    return this.clickTimes.some((c) => Math.abs(o.time - (c + b.delay)) < 0.012);
  }

  cancel() {
    this.cancelled = true;
    this.cleanup();
    this.speech?.cancel();
    this.stopVideo();
    if (this.settings.useCamera) {
      handTracker.stopRecording().snapshots.forEach((s) => s.bitmap.close());
    }
    this.resolveDone?.(null);
  }

  private cleanup() {
    if (this.endTimer !== null) window.clearTimeout(this.endTimer);
    this.endTimer = null;
    this.clicks?.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private async finish() {
    if (this.cancelled) return;
    const fired = audioEngine.now();
    this.cleanup();
    const video = this.stopVideo();
    const recording = this.settings.useCamera && handTracker.running ? handTracker.stopRecording() : null;
    this.classifyReady(Infinity);
    if (!this.bleedChecked) this.checkBleed();
    this.candidates.forEach((c) => (c.gated = this.isBleed(c)));
    const heard = this.speech ? await this.speech.finish() : [];
    if (this.cancelled) return;

    // Move each recognized word onto its vowel onset in the recording.
    const rec = this.recording;
    let words: RawWord[] = heard.map((w) => ({ ...w, voskTime: w.time }));
    const info = activityInfo(this.settings.activity);
    const vf = (info.countMode || info.sing) && rec.length ? voiceFrames(rec.data, rec.sampleRate, rec.startTime ?? 0) : null;
    const segments: VoicedSegment[] = vf ? voicedSegments(vf) : [];
    const runs: VoiceRun[] = vf ? voiceRuns(vf) : [];
    if (words.length && segments.length) {
      const refined = refineWordTimes(words, segments);
      words = words.map((w, i) => ({ ...w, time: refined[i] }));
    }

    const micOff = this.micOffset;
    // Word times are now acoustic (same path as claps), plus a small allowance
    // for where a syllable's beat sits relative to its vowel onset.
    const speechOff = this.settings.speechOffset ?? micOff + 0.02;

    // The audio model grades what the mic heard; without it (?model=rules, or
    // it failed to load) the clap detector, voicing rules and Vosk do.
    const audioModel = USE_AUDIO_MODEL && rec.length ? await loadAudioModel() : null;
    if (this.cancelled) return;
    const fromModel = audioModel
      ? modelGraderInput(audioModel, rec.data, rec.sampleRate, rec.startTime ?? 0, { mic: micOff, speech: speechOff })
      : null;

    const claps = fromModel ? fromModel.input.claps : this.candidates.filter((c) => c.isClap && !c.gated).map((c) => c.time - micOff);
    // The camera's delay, measured on this take when there are enough claps it also saw.
    const videoMeasured = recording && info.claps ? cameraLag(recording.frames, claps) : null;
    const videoOff = videoMeasured?.lag ?? this.settings.videoOffset ?? 0;
    const takeWords: TakeWord[] | null =
      fromModel && info.countMode
        ? fromModel.input.words
        : this.speech
          ? words.map((w) => ({
              word: w.word,
              label: w.label,
              time: w.time - speechOff,
            }))
          : null;
    const frames: TakeFrame[] | null = recording
      ? recording.frames.map((f) => ({
          time: f.time - videoOff,
          together: f.together,
          palmY: f.palmY ?? null,
          scale: f.scale ?? null,
        }))
      : null;

    // Count-word model (A/B: ?model=counts), for counts hidden under claps.
    const model = USE_COUNT_MODEL && !fromModel && info.countMode && info.claps ? await loadCountModel() : null;
    if (this.cancelled) return;
    const x16 = model && rec.length ? toFeatureRate(rec.data, rec.sampleRate) : null;
    const t0 = rec.startTime ?? 0;
    const modelCache = new Map<number, CountPrediction>();
    const countModelAt =
      model && x16
        ? (t: number) => {
            if (!modelCache.has(t)) modelCache.set(t, model.predict(x16, t + speechOff - t0));
            return modelCache.get(t)!;
          }
        : undefined;

    const result = analyzeTake({
      line: this.line,
      bpm: 60 / this.timing.secPerBeat,
      startTime: this.timing.lineStart,
      activity: info.id,
      strictness: this.settings.strictness,
      claps: info.claps ? claps : [],
      words: takeWords,
      frames,
      // Counts hidden under claps: the audio model hears them itself. The rules'
      // voice detector (without it) takes a clap's ring for a voice onset, so
      // it would credit counts on clap beats even when nothing was said.
      voiceOnsetNear:
        vf && info.claps && !fromModel
          ? (t) => {
              const o = voiceOnsetNear(vf, t + speechOff, runs);
              return o === null ? null : o - speechOff;
            }
          : undefined,
      countModelAt,
      countModelRule: COUNT_MODEL_RULE,
      sungOnsets: !info.sing
        ? undefined
        : fromModel
          ? fromModel.input.sungOnsets
          : vf
            ? sungOnsets(vf, segments).map((t) => t - speechOff)
            : undefined,
      voicedSpans:
        !info.sing && !info.countMode
          ? undefined
          : fromModel
            ? fromModel.input.voicedSpans
            : runs.map((r): [number, number] => [r.start - speechOff, r.end - speechOff]),
    });

    // Learn this device's delay from a clean clapping take (unless it was calibrated).
    if (this.delay?.source !== "calibrated" && info.claps) {
      const offsets = result.notes
        .filter((n) => ["on-time", "early", "late"].includes(n.status) && n.offsetMs !== undefined)
        .map((n) => n.offsetMs!);
      const d = takeDelay(micOff, offsets, result.notes.length);
      if (d !== null) recordTakeDelay(audioEngine.deviceLabel, d);
    }

    let snapshots: HandSnapshot[] = [];
    if (recording) {
      const corrected = recording.snapshots.map((s) => ({
        ...s,
        time: s.time - videoOff,
      }));
      const wanted = result.notes.flatMap((n) => (n.time !== undefined ? [n.expectedTime, n.time] : [n.expectedTime]));
      result.notes.forEach((n) => {
        if (n.hold?.until) wanted.push(n.hold.until);
      });
      result.rests?.forEach((r) => wanted.push(r.time ?? r.expectedTime));
      snapshots = keepSnapshotsNear(corrected, wanted);
    }

    const videoBlob = await video;
    if (this.cancelled) return;
    const { studentName, ...settingsNoName } = this.settings;
    const debug: TakeDebug = {
      startedAt: this.startedAt,
      settings: settingsNoName,
      clockAtStart: this.clockAtStart!,
      clockAtEnd: audioEngine.clockInfo(),
      clickTimes: this.clickTimes,
      bleedHits: this.bleedHits,
      bleed: this.bleed,
      bias: this.bias,
      offsets: {
        mic: micOff,
        speech: speechOff,
        video: videoOff,
        calibrated: {
          mic: this.settings.micOffset !== null,
          speech: this.settings.speechOffset !== null,
          video: this.settings.videoOffset !== null,
        },
        micSource: this.delay?.source,
        videoMeasured,
      },
      voicedSegments: segments,
      voiceRuns: runs,
      countModel:
        countModelAt && result.counts
          ? result.counts.map((c) => ({
              expectedTime: c.expectedTime,
              label: c.label,
              prediction: countModelAt(c.expectedTime),
            }))
          : null,
      vosk: this.speech?.log ?? [],
      grader: fromModel ? "audio-model" : "rules",
      audioModel:
        fromModel && audioModel
          ? {
              trainedOn: audioModel.file.trainedOn ?? null,
              events: fromModel.events,
            }
          : null,
      graderInput: { claps, words: takeWords, frames },
      finish: { due: this.finishDue, fired },
      video: this.videoInfo,
    };

    this.resolveDone?.({
      timing: this.timing,
      result,
      snapshots,
      raw: {
        candidates: this.candidates,
        words,
        frames: recording?.frames ?? [],
        recording: rec,
        video: videoBlob,
        debug,
      },
      frames,
      usedSpeech: !!takeWords,
      usedCamera: !!recording,
      micOffset: micOff,
    });
  }
}
