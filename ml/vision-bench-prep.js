// Prepares the hand/pose model benchmark (ml/vision-bench.js): copies the
// camera video of every clapping capture into public/bench/videos/, remuxed so
// the browser can seek it frame by frame (MediaRecorder's webm has no index),
// and lists them in public/bench/index.json.
//
//   node ml/vision-bench-prep.js [folders with capture zips...] (default dataset/)
//   FFMPEG=<path to ffmpeg> if it isn't on the PATH
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { readZip } = require("./zipread");
const { findZips } = require("./zips");

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const OUT = path.join(__dirname, "..", "public", "bench", "videos");
fs.mkdirSync(OUT, { recursive: true });

const index = [];
for (const zip of findZips(process.argv.slice(2).length ? process.argv.slice(2) : ["dataset"])) {
  if (/calibrate|synthetic/.test(zip)) continue;
  const files = readZip(zip);
  const manifest = files["manifest.json"] ? JSON.parse(files["manifest.json"].toString("utf8")) : null;
  const d = JSON.parse(files["diagnostics.json"].toString("utf8"));
  const video = Object.keys(files).find((k) => k.startsWith("camera."));
  if (!(d.settings.activity ?? "").includes("clap") || !video || manifest?.sync?.videoLag == null) continue;
  const name = path.basename(zip, ".zip");
  const raw = path.join(OUT, `${name}.raw.webm`);
  const out = path.join(OUT, `${name}.webm`);
  fs.writeFileSync(raw, files[video]);
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", raw, "-an", "-c:v", "copy", out]);
  fs.unlinkSync(raw);
  index.push({ name, zip: path.relative(path.join(__dirname, ".."), zip).replace(/\\/g, "/") });
  process.stdout.write(".");
}
fs.writeFileSync(path.join(OUT, "..", "index.json"), JSON.stringify(index, null, 1));
console.log(`\n${index.length} videos -> ${OUT}`);
