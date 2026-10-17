import { Biquad } from "./biquad";

/**
 * Streaming downsampler (e.g. 48 kHz -> 16 kHz for Vosk). Low-pass filters
 * below the target Nyquist, then linearly interpolates. Plenty for speech.
 */
export class Resampler {
  private readonly ratio: number;
  private readonly lp1: Biquad;
  private readonly lp2: Biquad;
  private pos = 0;
  private prev = 0;

  constructor(readonly inputRate: number, readonly toRate: number) {
    this.ratio = inputRate / toRate;
    const cutoff = Math.min(toRate * 0.45, inputRate * 0.45);
    this.lp1 = Biquad.lowpass(inputRate, cutoff);
    this.lp2 = Biquad.lowpass(inputRate, cutoff);
  }

  process(input: Float32Array): Float32Array {
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      const cur = this.lp2.process(this.lp1.process(input[i]));
      // `pos` is measured from the previous sample (index i - 1).
      while (this.pos < 1) {
        out[n++] = this.prev + (cur - this.prev) * this.pos;
        this.pos += this.ratio;
      }
      this.pos -= 1;
      this.prev = cur;
    }
    return out.subarray(0, n);
  }
}
