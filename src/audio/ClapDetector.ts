import { Biquad } from "./biquad";

// Clap onset detector.
//
// Why the old detector was unreliable: browsers apply automatic gain control
// and noise suppression to microphone input by default. After a loud clap the
// gain drops (so the next clap is "quiet"), then creeps back up (so room noise
// becomes "loud"), and the noise suppressor treats short transients like claps
// as noise to remove. The audio engine now requests the raw signal, and this
// detector only uses *relative* measurements so it tolerates whatever level
// changes remain (e.g. OS-level "audio enhancements").
//
// Algorithm, on 1 ms hops of high-passed audio (claps are broadband; voices
// and metronome clicks have most of their energy below ~2 kHz):
//   1. Energy must exceed an adaptive background level (log-domain tracker).
//   2. Energy must jump sharply relative to 8–25 ms earlier. Claps rise in
//      ~1 ms; spoken consonants rise over tens of ms.
//   3. A refractory period plus a decaying "echo floor" (from the last clap's
//      peak) prevents one clap and its room reverb from counting twice.
//   4. The burst must peak within a few ms (fricatives keep building) and be
//      broadband: a real clap has plenty of energy above 4 kHz, while a sine
//      metronome click leaking from the speakers has almost none.
//   5. Optional gates: onsets near a known metronome click must be louder than
//      the click bleed measured during the count-off.

export interface Onset {
  /** Time of the onset, in the clock of the timestamps passed to process(). */
  time: number;
  /** Peak energy (mean square of the high-passed signal) within 20 ms. */
  peak: number;
  /** True if the onset fell inside a gate window and was too quiet to count. */
  gated: boolean;
  /** (energy above highBandHz) / (energy above highpassHz) at the peak. */
  hiRatio: number;
  /** Mean energy in the pre-window just before the onset. */
  pre: number;
  /** Background energy level when the onset happened. */
  background: number;
}

export interface ClapDetectorOptions {
  highpassHz: number;
  hopMs: number;
  /** Required energy jump vs. the pre-window (power ratio). */
  riseRatio: number;
  preWindowStartMs: number;
  preWindowEndMs: number;
  /** Required energy above the background level (power ratio). */
  backgroundRatio: number;
  /** Absolute minimum energy (mean square). 1e-6 ≈ -60 dBFS. */
  minEnergy: number;
  refractoryMs: number;
  echoDecayMs: number;
  peakWindowMs: number;
  backgroundUpMs: number;
  backgroundDownMs: number;
  /** The energy must get within 6 dB of its peak this soon after the onset. */
  maxRiseMs: number;
  /** Second, higher band used to check that the burst is broadband. */
  highBandHz: number;
  /** Minimum (energy above highBandHz) / (energy above highpassHz) at the peak. */
  minHighBandRatio: number;
  /**
   * A burst this many times louder than the previous peak skips the
   * refractory period, and inside a pending onset extends its window.
   */
  restartRatio: number;
}

export const DEFAULT_CLAP_OPTIONS: ClapDetectorOptions = {
  highpassHz: 1800,
  hopMs: 1,
  riseRatio: 8,
  preWindowStartMs: 25,
  preWindowEndMs: 8,
  backgroundRatio: 8,
  minEnergy: 2e-6,
  refractoryMs: 60,
  echoDecayMs: 40,
  peakWindowMs: 20,
  backgroundUpMs: 700,
  backgroundDownMs: 150,
  maxRiseMs: 7,
  highBandHz: 4000,
  minHighBandRatio: 0.08,
  restartRatio: 3,
};

export interface GateWindow {
  start: number;
  end: number;
}

export const energyToDb = (e: number) => 10 * Math.log10(Math.max(e, 1e-12));

const HISTORY = 64;

export class ClapDetector {
  readonly opts: ClapDetectorOptions;
  private readonly hp1: Biquad;
  private readonly hp2: Biquad;
  private readonly hi1: Biquad | null;
  private readonly hi2: Biquad | null;
  private readonly hopLen: number;
  private readonly sampleRate: number;

  private hopSum = 0;
  private hopHiSum = 0;
  private hopCount = 0;
  private hopStartTime = 0;
  private hopFirstLoud = -1;
  private hopThreshold = 0;
  private hopIndex = 0;
  private readonly history = new Float64Array(HISTORY);

  private logBg: number;
  private lastOnsetTime = -Infinity;
  private lastPeak = 0;
  private lastPeakTime = -Infinity;
  private pending: {
    /** Start time of the hop that triggered it, and the first loud sample in it. */
    hopTime: number;
    firstLoud: number;
    peak: number;
    peakHi: number;
    peakTime: number;
    end: number;
    background: number;
    /** Hop energies: the HISTORY hops before the trigger, then every hop since. */
    hops: number[];
    first: number;
  } | null = null;

  private gates: GateWindow[] = [];
  private gateMinPeak = 0;

  constructor(sampleRate: number, opts: Partial<ClapDetectorOptions> = {}) {
    this.opts = { ...DEFAULT_CLAP_OPTIONS, ...opts };
    this.sampleRate = sampleRate;
    this.hp1 = Biquad.highpass(sampleRate, this.opts.highpassHz);
    this.hp2 = Biquad.highpass(sampleRate, this.opts.highpassHz);
    // The broadband check needs headroom above the high band (skip at low rates).
    const useHi = sampleRate > this.opts.highBandHz * 2.5;
    this.hi1 = useHi ? Biquad.highpass(sampleRate, this.opts.highBandHz) : null;
    this.hi2 = useHi ? Biquad.highpass(sampleRate, this.opts.highBandHz) : null;
    this.hopLen = Math.max(8, Math.round((sampleRate * this.opts.hopMs) / 1000));
    this.logBg = Math.log(this.opts.minEnergy);
  }

  /** Onsets inside any window must have a peak of at least minPeak to count. */
  setGates(windows: GateWindow[], minPeak: number) {
    this.gates = windows;
    this.gateMinPeak = minPeak;
  }

  get backgroundEnergy() {
    return Math.exp(this.logBg);
  }

  /**
   * Feed a chunk of mono samples. startTime is the timestamp (seconds) of
   * samples[0]. Returns onsets finalized during this chunk.
   */
  process(samples: Float32Array, startTime: number): Onset[] {
    const out: Onset[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (this.hopCount === 0) {
        this.hopStartTime = startTime + i / this.sampleRate;
        this.hopFirstLoud = -1;
        this.hopThreshold = this.threshold();
      }
      const y = this.hp2.process(this.hp1.process(samples[i]));
      const sq = y * y;
      if (this.hopFirstLoud < 0 && sq > this.hopThreshold) {
        this.hopFirstLoud = this.hopCount;
      }
      this.hopSum += sq;
      if (this.hi1 && this.hi2) {
        const h = this.hi2.process(this.hi1.process(samples[i]));
        this.hopHiSum += h * h;
      }
      this.hopCount++;
      if (this.hopCount === this.hopLen) {
        const onset = this.endHop(this.hopSum / this.hopLen, this.hopHiSum / this.hopLen);
        if (onset) out.push(onset);
        this.hopSum = 0;
        this.hopHiSum = 0;
        this.hopCount = 0;
      }
    }
    return out;
  }

  private threshold() {
    return Math.max(
      this.opts.minEnergy,
      Math.exp(this.logBg) * this.opts.backgroundRatio
    );
  }

  private preEnergy() {
    const hopMs = (this.hopLen / this.sampleRate) * 1000;
    const from = Math.round(this.opts.preWindowStartMs / hopMs);
    const to = Math.max(1, Math.round(this.opts.preWindowEndMs / hopMs));
    let sum = 0;
    let n = 0;
    for (let k = to; k <= from && k <= this.hopIndex; k++) {
      sum += this.history[(this.hopIndex - k + HISTORY * 4) % HISTORY];
      n++;
    }
    return n > 0 ? sum / n : this.opts.minEnergy;
  }

  /**
   * Settle a burst once its whole window is known. The onset is where the
   * energy first came within 20 dB of the peak (so a faint sound or consonant
   * just before a clap doesn't move it), and the rise is measured against the
   * 25..8 ms before that point.
   */
  private finishOnset(p: NonNullable<ClapDetector["pending"]>): Onset | null {
    const o = this.opts;
    const hopSec = this.hopLen / this.sampleRate;
    this.lastPeak = p.peak;
    this.lastPeakTime = p.peakTime;
    let k = p.first;
    while (k < p.hops.length - 1 && p.hops[k] < p.peak / 100) k++;
    const nearPeak = p.hops.findIndex((h, i) => i >= k && h >= p.peak / 4);
    // Claps often ring with a second, similar peak ~10 ms later, so time the
    // rise to "within 6 dB of the peak", not to the peak itself.
    const fastRise = (nearPeak - k) * hopSec <= o.maxRiseMs / 1000 + 1e-9;
    const broadband = !this.hi1 || p.peakHi >= p.peak * o.minHighBandRatio;
    if (!fastRise || !broadband) return null;
    const from = Math.round(o.preWindowStartMs / 1000 / hopSec);
    const to = Math.max(1, Math.round(o.preWindowEndMs / 1000 / hopSec));
    let sum = 0;
    let n = 0;
    for (let i = k - from; i <= k - to; i++) {
      if (i >= 0) {
        sum += p.hops[i];
        n++;
      }
    }
    const time = p.hopTime + (k - p.first) * hopSec + (k === p.first ? p.firstLoud / this.sampleRate : 0);
    this.lastOnsetTime = time;
    const inGate = this.gates.some((g) => time >= g.start && time <= g.end);
    return {
      time,
      peak: p.peak,
      gated: inGate && p.peak < this.gateMinPeak,
      hiRatio: this.hi1 ? p.peakHi / Math.max(p.peak, 1e-12) : 1,
      pre: n ? sum / n : o.minEnergy,
      background: p.background,
    };
  }

  private endHop(e: number, eHi: number): Onset | null {
    const o = this.opts;
    const t = this.hopStartTime;
    let result: Onset | null = null;

    if (this.pending) {
      const p = this.pending;
      p.hops.push(e);
      // A much bigger burst inside the window (a clap right after a
      // consonant): give it a full window of its own.
      if (e > o.restartRatio * p.peak) p.end = Math.max(p.end, t + o.peakWindowMs / 1000);
      if (e > p.peak) {
        p.peak = e;
        p.peakHi = eHi;
        p.peakTime = t;
      }
      if (t >= p.end) {
        this.pending = null;
        result = this.finishOnset(p);
      }
    } else {
      const echoFloor =
        this.lastPeak * Math.exp(-(t - this.lastPeakTime) / (o.echoDecayMs / 1000));
      const pre = this.preEnergy();
      if (
        e > this.threshold() &&
        e > o.riseRatio * pre &&
        (t - this.lastOnsetTime > o.refractoryMs / 1000 || e > o.restartRatio * this.lastPeak) &&
        e > echoFloor
      ) {
        this.lastOnsetTime = t;
        const hops: number[] = [];
        for (let k = HISTORY - 1; k >= 0; k--) {
          hops.push(k <= this.hopIndex ? this.history[(this.hopIndex - k + HISTORY * 4) % HISTORY] : o.minEnergy);
        }
        hops.push(e);
        this.pending = {
          hopTime: t,
          firstLoud: this.hopFirstLoud >= 0 ? this.hopFirstLoud : 0,
          peak: e,
          peakHi: eHi,
          peakTime: t,
          end: t + o.peakWindowMs / 1000,
          background: Math.exp(this.logBg),
          hops,
          first: HISTORY,
        };
      }
    }

    // Background tracker in the log domain so a short loud clap barely moves it.
    const hopSec = this.hopLen / this.sampleRate;
    const le = Math.log(Math.max(e, 1e-12));
    const tau = le > this.logBg ? o.backgroundUpMs : o.backgroundDownMs;
    this.logBg += (le - this.logBg) * Math.min(1, hopSec / (tau / 1000));
    this.logBg = Math.max(this.logBg, Math.log(o.minEnergy / o.backgroundRatio));

    this.hopIndex++;
    this.history[this.hopIndex % HISTORY] = e;
    return result;
  }
}
