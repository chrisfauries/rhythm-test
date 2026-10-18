import { RefObject, useEffect, useRef } from "react";
import { CLICK_HZ, clickSamples } from "./click";

// A metronome click track over a playing video (or audio) element: the same
// click sound the student heard, scheduled on the Web Audio clock from the
// element's playback position. It follows pause, seeking and playback speed,
// so at half speed the clicks come at half speed, still on the beat.

export interface Click {
  /** Media time (seconds into the video/audio element). */
  t: number;
  accent: boolean;
}

const LOOKAHEAD = 0.15; // seconds of media time scheduled ahead
const VOLUME = 0.5;

let shared: AudioContext | null = null;
const audioContext = () => (shared ??= new AudioContext());

export const useClickTrack = (media: RefObject<HTMLMediaElement | null>, clicks: Click[], enabled: boolean) => {
  const clicksRef = useRef(clicks);
  clicksRef.current = clicks;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    // The element appears (and can be replaced) after this hook first runs, so watch for it.
    let el: HTMLMediaElement | null = null;
    let detach = () => {};
    const watch = window.setInterval(() => {
      if (media.current === el) return;
      detach();
      el = media.current;
      detach = el ? attach(el, clicksRef, enabledRef) : () => {};
    }, 200);
    return () => {
      window.clearInterval(watch);
      detach();
    };
  }, [media]);

  // Turning the click off mid-playback silences what's already queued.
  useEffect(() => {
    if (enabled) return;
    const el = media.current;
    if (el && !el.paused) el.dispatchEvent(new Event("seeking"));
  }, [enabled, media]);
};

/**
 * Schedules clicks while `el` plays; returns a function that stops listening.
 * The clicks go to the speakers, or to `out` (e.g. into a recording).
 */
export const attach = (
  el: HTMLMediaElement,
  clicks: { current: Click[] },
  enabled: { current: boolean },
  out?: { ctx: AudioContext; node: AudioNode; volume?: number },
) => {
  let buffers: { normal: AudioBuffer; accent: AudioBuffer } | null = null;
  let gain: GainNode | null = null;
  const scheduled = new Set<AudioBufferSourceNode>();
  /** Media time up to which clicks are scheduled. */
  let until = -Infinity;
  let timer = 0;
  /** Where playback (re)started: the clock only counts once it moves on from here. */
  let anchor: number | null = null;

  const setup = () => {
    const ctx = out?.ctx ?? audioContext();
    if (ctx.state === "suspended") ctx.resume();
    if (!buffers) {
      const make = (freq: number) => {
        const data = clickSamples(ctx.sampleRate, freq);
        const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
        b.copyToChannel(data, 0);
        return b;
      };
      buffers = { normal: make(CLICK_HZ.normal), accent: make(CLICK_HZ.accent) };
      gain = ctx.createGain();
      gain.gain.value = out?.volume ?? VOLUME;
      gain.connect(out?.node ?? ctx.destination);
    }
    return ctx;
  };

  const cancel = () => {
    scheduled.forEach((s) => {
      try {
        s.stop();
      } catch {
        // already finished
      }
    });
    scheduled.clear();
    until = -Infinity;
  };

  const pump = () => {
    if (el.paused || !enabled.current) return;
    // While the element seeks or waits for data its clock stands still: clicks
    // scheduled now would bunch up against the ones after (a long first beat).
    if (el.seeking || el.readyState < el.HAVE_FUTURE_DATA) return;
    // Playback really starts a little after play(): wait for the clock to move,
    // or the first click comes early (a long first beat).
    if (anchor !== null) {
      if (el.currentTime === anchor) return;
      anchor = null;
    }
    const ctx = setup();
    const now = el.currentTime;
    const rate = el.playbackRate || 1;
    const from = Math.max(until, now - 0.005);
    const to = now + LOOKAHEAD * rate;
    for (const c of clicks.current) {
      if (c.t <= from || c.t > to) continue;
      const src = ctx.createBufferSource();
      src.buffer = c.accent ? buffers!.accent : buffers!.normal;
      src.connect(gain!);
      src.start(ctx.currentTime + Math.max(0, (c.t - now) / rate));
      src.onended = () => scheduled.delete(src);
      scheduled.add(src);
    }
    until = to;
  };

  const start = () => {
    cancel();
    anchor = el.currentTime;
    window.clearInterval(timer);
    timer = window.setInterval(pump, 25);
    pump();
  };
  const stop = () => {
    window.clearInterval(timer);
    cancel();
  };
  const restart = () => {
    cancel();
    anchor = el.paused ? null : el.currentTime;
    pump();
  };

  el.addEventListener("play", start);
  el.addEventListener("playing", restart);
  el.addEventListener("waiting", cancel);
  el.addEventListener("pause", stop);
  el.addEventListener("seeking", restart);
  el.addEventListener("ratechange", restart);
  if (!el.paused) start();
  return () => {
    el.removeEventListener("play", start);
    el.removeEventListener("playing", restart);
    el.removeEventListener("waiting", cancel);
    el.removeEventListener("pause", stop);
    el.removeEventListener("seeking", restart);
    el.removeEventListener("ratechange", restart);
    stop();
  };
};
