// The metronome click, shared by the app (AudioEngine, click tracks over
// replays) and the synthetic-take generator (ml/synth.js).

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
