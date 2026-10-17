// The whole take's microphone audio, kept so claps and words can be analyzed
// with context on both sides (and downloaded for troubleshooting).

export class Recording {
  private buf: Float32Array;
  length = 0;
  startTime: number | null = null;
  /** Chunk timing glitches: where a chunk arrived early/late vs. the samples so far. */
  glitches: { time: number; seconds: number }[] = [];
  chunks = 0;

  constructor(readonly sampleRate: number, seconds = 30) {
    this.buf = new Float32Array(Math.round(sampleRate * seconds));
  }

  append(samples: Float32Array, time: number) {
    if (this.startTime === null) this.startTime = time;
    // Fill dropouts with silence so sample index stays tied to time.
    const expected = this.startTime + this.length / this.sampleRate;
    const gap = Math.round((time - expected) * this.sampleRate);
    this.chunks++;
    if (Math.abs(gap) > 1) this.glitches.push({ time, seconds: gap / this.sampleRate });
    if (gap > 0 && gap < this.sampleRate * 5) {
      this.grow(gap);
      this.length += gap;
    }
    this.grow(samples.length);
    this.buf.set(samples, this.length);
    this.length += samples.length;
  }

  private grow(extra: number) {
    if (this.length + extra <= this.buf.length) return;
    const next = new Float32Array(Math.max(this.buf.length * 2, this.length + extra));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  get data() {
    return this.buf.subarray(0, this.length);
  }

  get endTime() {
    return (this.startTime ?? 0) + this.length / this.sampleRate;
  }

  index(time: number) {
    return Math.round((time - (this.startTime ?? 0)) * this.sampleRate);
  }
}

/** 16-bit mono WAV, with an optional comment (we put take details there). */
export const encodeWav = (data: Float32Array, sampleRate: number, comment?: string) => {
  const info = comment ? new TextEncoder().encode(comment + "\0") : null;
  const infoPad = info ? info.length % 2 : 0;
  const listSize = info ? 4 + 8 + info.length + infoPad : 0;
  const size = 44 + data.length * 2 + (info ? 8 + listSize : 0);
  const view = new DataView(new ArrayBuffer(size));
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, size - 8, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  let off = 36;
  if (info) {
    str(off, "LIST");
    view.setUint32(off + 4, listSize, true);
    str(off + 8, "INFOICMT");
    view.setUint32(off + 16, info.length, true);
    info.forEach((b, i) => view.setUint8(off + 20 + i, b));
    off += 8 + listSize;
  }
  str(off, "data");
  view.setUint32(off + 4, data.length * 2, true);
  off += 8;
  for (let i = 0; i < data.length; i++, off += 2) {
    view.setInt16(off, Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767))), true);
  }
  return new Blob([view.buffer], { type: "audio/wav" });
};
