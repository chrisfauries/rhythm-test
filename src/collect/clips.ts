import { audioEngine } from "../audio/AudioEngine";
import { encodeWav, Recording } from "../audio/Recording";
import { ZipEntry, makeZip } from "../debug/zip";
import { ClipPrompt } from "./plan";

// Recording one clip prompt: a count-in on the click, then the prompt said
// (or clapped, or sung) on the click a few times. The microphone runs the
// whole time; afterwards each repeat is cut out where its sound actually is.

/** Clicks before the first repeat ("1, 2, ready, go"). */
export const COUNT_IN = 4;

export interface Clip {
  prompt: ClipPrompt;
  rep: number;
  data: Float32Array;
  /** Where the clip starts in the prompt's raw recording (s). */
  start: number;
  /** Where the sound starts in the clip (s). */
  onset: number;
  /** Where each syllable should start in the clip (s), from the click. */
  expected: number[];
  peakDb: number;
}

export interface PromptTake {
  prompt: ClipPrompt;
  raw: Float32Array;
  sampleRate: number;
  clips: Clip[];
  /** Repeats with no clear sound. */
  missing: number[];
}

export interface PromptRun {
  /** Context time of the first count-in click. */
  start: number;
  secPerBeat: number;
  /** Context time the run is over. */
  end: number;
  done: Promise<PromptTake>;
  cancel: () => void;
}

const dB = (x: number) => 20 * Math.log10(Math.max(x, 1e-9));

/** Plays the prompt's clicks and records; resolves with the clips once the last repeat is over. */
export const runPrompt = (prompt: ClipPrompt, volume: number, micOffset: number): PromptRun => {
  const secPerBeat = 60 / prompt.bpm;
  const start = audioEngine.now() + 0.4;
  const beats = COUNT_IN + prompt.reps * prompt.beats;
  const clicks = Array.from({ length: beats }, (_, i) => ({
    time: start + i * secPerBeat,
    accent: i >= COUNT_IN && (i - COUNT_IN) % prompt.beats === 0,
  }));
  const handle = audioEngine.scheduleClicks(clicks, volume);
  const rec = new Recording(audioEngine.sampleRate, beats * secPerBeat + 3);
  const unsubscribe = audioEngine.subscribe((samples, time) => {
    if (time >= start - 0.3) rec.append(samples, time);
  });
  const end = start + beats * secPerBeat + 0.6;
  let timer = 0;
  let cancelled = false;
  const done = new Promise<PromptTake>((resolve) => {
    timer = window.setTimeout(
      () => {
        unsubscribe();
        if (!cancelled) resolve(cutClips(prompt, rec, start, secPerBeat, micOffset));
      },
      (end - audioEngine.now()) * 1000,
    );
  });
  return {
    start,
    secPerBeat,
    end,
    done,
    cancel: () => {
      cancelled = true;
      window.clearTimeout(timer);
      handle.stop();
      unsubscribe();
    },
  };
};

/** Each repeat's clip: from just before its first sound to just after its last. */
const cutClips = (prompt: ClipPrompt, rec: Recording, start: number, secPerBeat: number, micOffset: number): PromptTake => {
  const sr = rec.sampleRate;
  const data = Float32Array.from(rec.data);
  const t0 = rec.startTime ?? start;
  const hop = Math.round(sr * 0.01);
  const rms = (a: number, b: number) => {
    let s = 0;
    for (let i = a; i < b; i++) s += data[i] * data[i];
    return Math.sqrt(s / Math.max(1, b - a));
  };
  const frames = Array.from({ length: Math.floor(data.length / hop) }, (_, k) => rms(k * hop, (k + 1) * hop));
  // The room's level: the quiet tenth of the recording.
  const floor = [...frames].sort((a, b) => a - b)[Math.floor(frames.length * 0.1)] ?? 0;

  const clips: Clip[] = [];
  const missing: number[] = [];
  for (let r = 0; r < prompt.reps; r++) {
    const cue = start + (COUNT_IN + r * prompt.beats) * secPerBeat;
    // The repeat's window on the recording: from a little before its click to
    // a little before the next repeat's (the sound reaches the mic micOffset late).
    const from = cue + micOffset - 0.15 - t0;
    const to = cue + micOffset + prompt.beats * secPerBeat - 0.15 - t0;
    const a = Math.max(0, Math.floor(from / 0.01));
    const b = Math.min(frames.length, Math.floor(to / 0.01));
    const win = frames.slice(a, b);
    const peak = Math.max(0, ...win);
    if (!win.length || peak < Math.max(floor * 8, 0.003)) {
      missing.push(r);
      continue;
    }
    const thr = Math.max(floor * 4, peak * 0.06);
    const first = win.findIndex((v) => v >= thr);
    let last = win.length - 1;
    while (last > first && win[last] < thr * 0.6) last--;
    const s0 = Math.max(a, a + first - 4) * hop;
    const s1 = Math.min(b * hop, (a + last + 12) * hop, data.length);
    const clipStart = s0 / sr;
    const cueInClip = cue + micOffset - t0 - clipStart;
    clips.push({
      prompt,
      rep: r + 1,
      data: data.slice(s0, s1),
      start: clipStart,
      onset: ((a + first) * hop) / sr - clipStart,
      expected: prompt.offsets.map((o) => +(cueInClip + o * secPerBeat).toFixed(3)),
      peakDb: +dB(peak).toFixed(1),
    });
  }
  return { prompt, raw: data, sampleRate: sr, clips, missing };
};

export interface ClipSession {
  person: string;
  group: "adult" | "student";
  note: string;
  takes: PromptTake[];
  micLabel: string;
  micOffset: number;
}

const safe = (s: string) => s.replace(/[^\w.-]+/g, "-");

/**
 * One zip for the whole session:
 *   manifest.json          who, the device, every prompt and clip
 *   clips/<kind>/<prompt>_<n>.wav   one sound (or phrase) per file
 *   raw/<prompt>.wav       each prompt's full recording, to re-cut later
 *   README.txt
 */
export const buildClipZip = async (session: ClipSession) => {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];
  const clips: object[] = [];
  const prompts: object[] = [];
  for (const t of session.takes) {
    const p = t.prompt;
    const raw = `raw/${safe(p.id)}.wav`;
    entries.push({ name: raw, data: new Uint8Array(await encodeWav(t.raw, t.sampleRate).arrayBuffer()) });
    prompts.push({
      id: p.id,
      kind: p.kind,
      say: p.say,
      labels: p.labels,
      offsets: p.offsets,
      style: p.style,
      bpm: p.bpm,
      reps: p.reps,
      raw,
      missing: t.missing.map((r) => r + 1),
    });
    for (const c of t.clips) {
      const file = `clips/${p.kind}/${safe(p.id)}_${c.rep}.wav`;
      entries.push({ name: file, data: new Uint8Array(await encodeWav(c.data, t.sampleRate).arrayBuffer()) });
      clips.push({
        file,
        prompt: p.id,
        kind: p.kind,
        labels: p.labels,
        style: p.style,
        bpm: p.bpm,
        rep: c.rep,
        seconds: +(c.data.length / t.sampleRate).toFixed(3),
        startInRaw: +c.start.toFixed(3),
        onset: +c.onset.toFixed(3),
        expected: c.expected,
        peakDb: c.peakDb,
      });
    }
  }
  const manifest = {
    format: "rhythm-tester-clips",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    person: { id: session.person, group: session.group, note: session.note },
    device: { mic: session.micLabel, sampleRate: session.takes[0]?.sampleRate ?? audioEngine.sampleRate, micOffset: session.micOffset },
    prompts,
    clips,
  };
  const readme = [
    "Rhythm tester sound clips: one person's counts, claps and singing, recorded on the click.",
    "",
    "manifest.json lists every prompt and clip. Labels are the app's count names (one ... twelve,",
    "e, and, a (= 'uh'), la, li), 'clap', or 'sing' (a sung Da).",
    "Per clip: onset = where the sound starts in the clip (s); expected = where each syllable",
    "should start (s), from the click; startInRaw = where the clip starts in raw/<prompt>.wav.",
    "Clips are mono 16-bit WAV at the device's sample rate.",
  ].join("\n");
  entries.unshift({ name: "README.txt", data: enc.encode(readme) });
  entries.unshift({ name: "manifest.json", data: enc.encode(JSON.stringify(manifest, null, 1)) });
  return makeZip(entries);
};
