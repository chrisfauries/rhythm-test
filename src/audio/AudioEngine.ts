// One AudioContext for everything: metronome clicks are scheduled on it, and
// microphone samples are timestamped on it (in an AudioWorklet), so clap and
// speech timings are directly comparable with the beat grid.
//
// Clock domains:
//   - "context time": AudioContext.currentTime. Clicks are scheduled here.
//   - Mic samples are stamped with the context time at which the worklet
//     processed them. That is later than when the sound happened by the
//     output latency (the student hears the click late) plus input latency.
//     Calibration measures that total and the analysis subtracts it.

export type AudioListener = (samples: Float32Array, time: number) => void;

const TAP_WORKLET = `
class TapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 512;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.t0 = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        if (this.n === 0) this.t0 = currentTime + i / sampleRate;
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage({ samples: this.buf, time: this.t0 }, [this.buf.buffer]);
          this.buf = new Float32Array(this.size);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('tap-processor', TapProcessor);
`;

export interface ClickEvent {
  time: number;
  accent: boolean;
}

export interface ClickHandle {
  stop(): void;
}

export const CLICK_HZ = { normal: 1000, accent: 1500 };

/** The metronome click (before the volume gain). */
export const clickSamples = (sampleRate: number, freq: number) => {
  const len = Math.round(sampleRate * 0.06);
  const data = new Float32Array(len);
  const attack = sampleRate * 0.003;
  for (let i = 0; i < len; i++) {
    const env = Math.min(1, i / attack) * Math.exp(-i / (sampleRate * 0.012));
    data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * env * 0.8;
  }
  return data;
};

const makeClick = (ctx: AudioContext, freq: number) => {
  const data = clickSamples(ctx.sampleRate, freq);
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.getChannelData(0).set(data);
  return buf;
};

class AudioEngine {
  ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<AudioListener>();
  private clickBuffers: { normal: AudioBuffer; accent: AudioBuffer } | null = null;
  private clickGain: GainNode | null = null;
  /** Peak absolute sample value over the most recent chunk (for a level meter). */
  level = 0;

  get running() {
    return !!this.ctx && !!this.stream;
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** Must be called from a user gesture (browsers block audio otherwise). */
  async start(deviceId?: string) {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: "interactive" });
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const ctx = this.ctx;

    if (this.stream) this.stopMic();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: {
        // The browser's "voice call" processing is what made the old clap
        // detector unreliable: AGC changes the level after every loud clap
        // and noise suppression removes short transients. Turn it all off.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });

    if (!this.node) {
      const url = URL.createObjectURL(
        new Blob([TAP_WORKLET], { type: "application/javascript" })
      );
      await ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(ctx, "tap-processor");
      this.node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; time: number }>) => {
        const { samples, time } = e.data;
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const a = Math.abs(samples[i]);
          if (a > peak) peak = a;
        }
        this.level = peak;
        this.listeners.forEach((fn) => fn(samples, time));
      };
      // Keep the node pulled by the graph without making any sound.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(ctx.destination);
    }
    ctx.createMediaStreamSource(this.stream).connect(this.node);

    if (!this.clickBuffers) {
      this.clickBuffers = { normal: makeClick(ctx, CLICK_HZ.normal), accent: makeClick(ctx, CLICK_HZ.accent) };
      this.clickGain = ctx.createGain();
      this.clickGain.connect(ctx.destination);
    }
  }

  private stopMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  /** The live microphone stream (for recording a debug video with sound). */
  get micStream() {
    return this.stream;
  }

  /** Snapshot of everything we know about the audio clocks and devices. */
  clockInfo() {
    const ctx = this.ctx;
    const ts = ctx?.getOutputTimestamp?.();
    const track = this.stream?.getAudioTracks()[0];
    return {
      perfNow: performance.now(),
      contextTime: ctx?.currentTime ?? null,
      outputTimestamp: ts ? { contextTime: ts.contextTime ?? null, performanceTime: ts.performanceTime ?? null } : null,
      sampleRate: ctx?.sampleRate ?? null,
      baseLatency: ctx?.baseLatency ?? null,
      outputLatency: ctx?.outputLatency ?? null,
      state: ctx?.state ?? null,
      micLabel: track?.label ?? null,
      micSettings: track?.getSettings?.() ?? null,
    };
  }

  get deviceLabel() {
    return this.stream?.getAudioTracks()[0]?.label ?? "";
  }

  subscribe(fn: AudioListener) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  now() {
    return this.ctx?.currentTime ?? 0;
  }

  /** Output latency estimate: how long after scheduling a click it is heard. */
  get outputLatency() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    return (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
  }

  /** Reasonable starting point for mic offset before calibration. */
  get defaultMicOffset() {
    return this.outputLatency + 0.02;
  }

  /** Context time of the click the student is hearing right now. */
  audibleTime() {
    return this.now() - this.outputLatency;
  }

  /**
   * Convert a performance.now() timestamp (ms) into the click time the student
   * was hearing at that moment. Used to place camera frames on the beat grid.
   */
  perfToAudible(perfMs: number) {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0) {
      return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    }
    return ctx.currentTime - this.outputLatency + (perfMs - performance.now()) / 1000;
  }

  scheduleClicks(events: ClickEvent[], volume: number): ClickHandle {
    const ctx = this.ctx;
    if (!ctx || !this.clickBuffers || !this.clickGain) return { stop() {} };
    this.clickGain.gain.value = volume;
    const sources = events.map((ev) => {
      const src = ctx.createBufferSource();
      src.buffer = ev.accent ? this.clickBuffers!.accent : this.clickBuffers!.normal;
      src.connect(this.clickGain!);
      src.start(ev.time);
      return src;
    });
    return {
      stop() {
        sources.forEach((s) => {
          try {
            s.stop();
          } catch {
            // already finished
          }
        });
      },
    };
  }
}

export const audioEngine = new AudioEngine();

export const listMicrophones = async () =>
  (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
