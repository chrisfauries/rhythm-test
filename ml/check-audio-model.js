// Checks that the browser's audio model (src/ml/audioModel.ts) gives the same
// outputs as PyTorch did for the take train_audio.py saved in
// ml/data/audio-check.json. Run after training: node ml/check-audio-model.js
const fs = require("fs");
const path = require("path");
const { AudioModel } = require("./.build/ml/audioModel.js");

const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "audio.json"), "utf8"));
const check = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "audio-check.json"), "utf8"));
const file = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "models", "audio.json"), "utf8"));
global.atob ??= (b) => Buffer.from(b, "base64").toString("binary");

const take = meta.takes.find((t) => t.name === check.take);
const mel = new Float32Array(take.frames * meta.mels);
const fd = fs.openSync(path.join(__dirname, "data", "audio.bin"), "r");
fs.readSync(fd, Buffer.from(mel.buffer), 0, mel.byteLength, take.offset * meta.mels * 4);
fs.closeSync(fd);

const model = new AudioModel(file);
const started = Date.now();
const out = model.run({ frames: take.frames, data: mel });
const ms = Date.now() - started;
let worst = 0;
for (const key of ["clap", "onset", "voiced"]) check[key].forEach((p, i) => (worst = Math.max(worst, Math.abs(p - out[key][i]))));
const ev = model.eventsFrom(out);
console.log(`${check.take}: ${(take.frames * file.frameSec).toFixed(1)} s of audio in ${ms} ms; largest difference from PyTorch ${worst.toExponential(1)}`);
console.log(`  ${ev.claps.length} claps, ${ev.onsets.length} onsets (${ev.onsets.slice(0, 6).map((o) => o.word).join(" ")} ...), ${ev.voicedSpans.length} voiced spans`);
if (worst > 1e-3) {
  console.error("MISMATCH: audioModel.ts doesn't match the trained network");
  process.exit(1);
}
