import { Model } from "vosk-browser";
import { ServerMessagePartialResult, ServerMessageResult } from "vosk-browser/dist/interfaces";
import { Resampler } from "../audio/Resampler";

// Recognizes spoken counts ("one and two e and a ...") with Vosk running
// locally in a web worker. A small grammar keeps it fast and accurate, and
// word-level timestamps let us grade *when* each count was spoken.

/** Spoken word -> count label used by the rhythm model. */
const WORD_TO_LABEL: Record<string, string> = {
  one: "one",
  two: "two",
  three: "three",
  four: "four",
  five: "five",
  six: "six",
  seven: "seven",
  eight: "eight",
  nine: "nine",
  ten: "ten",
  eleven: "eleven",
  twelve: "twelve",
  and: "and",
  an: "and",
  e: "e",
  ee: "e",
  a: "a",
  uh: "a",
  trip: "trip",
  let: "let",
};

const GRAMMAR = JSON.stringify([...Object.keys(WORD_TO_LABEL), "[unk]"]);
const VOSK_RATE = 16000;

export interface HeardWord {
  word: string;
  /** Count label (see rhythm.ts countLabel), or null if not a count word. */
  label: string | null;
  /** Context time (seconds) when the word started, before latency correction. */
  time: number;
  end: number;
  conf: number;
}

/** Everything Vosk said during a take, for diagnostics. */
export interface VoskEvent {
  /** Context time of the newest audio fed when the message arrived. */
  fedUntil: number;
  /** performance.now() when the message arrived. */
  perf: number;
  kind: "partial" | "result";
  text?: string;
  words?: { word: string; start: number; end: number; conf: number }[];
}

export class CountSession {
  readonly log: VoskEvent[] = [];
  private fedUntil = 0;
  private readonly recognizer: InstanceType<Model["KaldiRecognizer"]>;
  private readonly resampler: Resampler;
  private streamStart: number | null = null;
  private pendingChunks: Float32Array[] = [];
  private pendingLength = 0;
  private words: HeardWord[] = [];
  private lastResultAt = 0;
  private finished = false;

  constructor(
    model: Model,
    sampleRate: number,
    private readonly onPartial?: (text: string) => void
  ) {
    this.resampler = new Resampler(sampleRate, VOSK_RATE);
    this.recognizer = new model.KaldiRecognizer(VOSK_RATE, GRAMMAR);
    this.recognizer.setWords(true);
    this.recognizer.on("result", (msg) => {
      this.lastResultAt = performance.now();
      const result = (msg as ServerMessageResult).result;
      const base = this.streamStart ?? 0;
      this.log.push({
        fedUntil: this.fedUntil,
        perf: performance.now(),
        kind: "result",
        text: result.text,
        words: (result.result ?? []).map((w) => ({ word: w.word, start: base + w.start, end: base + w.end, conf: w.conf })),
      });
      for (const w of result.result ?? []) {
        if (w.word === "[unk]") continue;
        this.words.push({
          word: w.word,
          label: WORD_TO_LABEL[w.word] ?? null,
          time: (this.streamStart ?? 0) + w.start,
          end: (this.streamStart ?? 0) + w.end,
          conf: w.conf,
        });
      }
    });
    this.recognizer.on("partialresult", (msg) => {
      const text = (msg as ServerMessagePartialResult).result.partial;
      const last = this.log[this.log.length - 1];
      if (text && !(last?.kind === "partial" && last.text === text)) {
        this.log.push({ fedUntil: this.fedUntil, perf: performance.now(), kind: "partial", text });
      }
      if (text) this.onPartial?.(text.replace(/\[unk\]/g, "").trim());
    });
  }

  feed(samples: Float32Array, time: number) {
    if (this.finished) return;
    if (this.streamStart === null) this.streamStart = time;
    this.fedUntil = time + samples.length / this.resampler.inputRate;
    const resampled = this.resampler.process(samples);
    this.pendingChunks.push(resampled);
    this.pendingLength += resampled.length;
    // Send ~100 ms at a time to keep worker messaging cheap.
    if (this.pendingLength >= VOSK_RATE / 10) this.flush();
  }

  private flush() {
    if (this.pendingLength === 0) return;
    const buf = new Float32Array(this.pendingLength);
    let off = 0;
    for (const c of this.pendingChunks) {
      buf.set(c, off);
      off += c.length;
    }
    this.pendingChunks = [];
    this.pendingLength = 0;
    this.recognizer.acceptWaveformFloat(buf, VOSK_RATE);
  }

  /** Flush remaining audio and wait for the recognizer's final words. */
  async finish(): Promise<HeardWord[]> {
    if (this.finished) return this.words;
    this.flush();
    this.finished = true;
    const asked = performance.now();
    this.lastResultAt = 0;
    this.recognizer.retrieveFinalResult();
    // The worker answers in order; wait until results stop arriving.
    await new Promise<void>((resolve) => {
      const check = () => {
        const now = performance.now();
        const quiet = this.lastResultAt > 0 && now - this.lastResultAt > 250;
        if (quiet || now - asked > 4000) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
    this.recognizer.remove();
    return this.words.sort((a, b) => a.time - b.time);
  }

  cancel() {
    if (this.finished) return;
    this.finished = true;
    this.recognizer.remove();
  }
}
