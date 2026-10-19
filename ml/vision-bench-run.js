// Runs the hand/pose model benchmark: every model over every prepared video
// (ml/vision-bench-prep.js), in Chrome, through the app's ?vision-bench page.
// Needs the dev server (npm start). Results go to ml/data/vision-bench/<model>/<video>.json;
// finished ones are skipped, so it can be stopped and resumed.
//
//   node ml/vision-bench-run.js [--models a,b] [--videos N] [--step 0.0333] [--headful]
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const MODELS = opt("--models", "legacy-hands-lite,legacy-hands-full,hand-landmarker,pose-lite,pose-full,pose-heavy,holistic").split(",");
const STEP = +opt("--step", String(1 / 30));
const LIMIT = +opt("--videos", "1000");
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const URL = process.env.BENCH_URL || "http://localhost:3000/?vision-bench";
const OUT = path.join(__dirname, "data", "vision-bench");
const index = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "bench", "index.json"), "utf8")).slice(0, LIMIT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vision-bench-"));
const chrome = spawn(
  CHROME,
  [
    "--remote-debugging-port=9339",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    ...(args.includes("--headful") ? [] : ["--headless=new"]),
    "--enable-gpu",
    "--use-angle=d3d11",
    "--ignore-gpu-blocklist",
    "--window-size=900,700",
    URL,
  ],
  { stdio: "ignore" },
);

(async () => {
  let tabs;
  for (let i = 0; i < 80; i++) {
    try {
      tabs = await (await fetch("http://127.0.0.1:9339/json")).json();
      if (tabs.find((t) => t.type === "page")) break;
    } catch {}
    await sleep(250);
  }
  const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const wait = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && wait.has(d.id)) {
      wait.get(d.id)(d);
      wait.delete(d.id);
    } else if (d.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(d.params.type))
      console.log(
        `  console.${d.params.type}:`,
        d.params.args
          .map((a) => a.value ?? a.description)
          .join(" ")
          .slice(0, 200),
      );
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      wait.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  // A fresh page per model: the legacy hands library and tasks-vision both use
  // Emscripten, and the legacy one leaves globals that break the other.
  const freshPage = async () => {
    await send("Page.reload", { ignoreCache: false });
    await sleep(1500);
    for (let i = 0; i < 60; i++) {
      const r = await send("Runtime.evaluate", { expression: "typeof window.benchVideo", returnByValue: true });
      if (r.result?.result?.value === "function") return;
      await sleep(500);
    }
  };
  const started = Date.now();
  for (const model of MODELS) {
    await freshPage();
    fs.mkdirSync(path.join(OUT, model), { recursive: true });
    for (const [k, v] of index.entries()) {
      const file = path.join(OUT, model, `${v.name}.json`);
      if (fs.existsSync(file)) continue;
      const r = await send("Runtime.evaluate", {
        expression: `window.benchVideo(${JSON.stringify(v.name)}, ${JSON.stringify(model)}, ${STEP})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.result?.exceptionDetails || !r.result?.result?.value) {
        console.log(`${model} ${v.name}: FAILED`, JSON.stringify(r.result?.exceptionDetails ?? r.error).slice(0, 300));
        continue;
      }
      const run = r.result.result.value;
      fs.writeFileSync(file, JSON.stringify(run));
      const ms = [...run.ms].sort((a, b) => a - b);
      console.log(
        `${model.padEnd(18)} ${String(k + 1).padStart(2)}/${index.length} ${v.name.slice(0, 40).padEnd(40)} ${run.frames.length} frames, ${run.delegate}, median ${ms[Math.floor(ms.length / 2)]} ms/frame (${((Date.now() - started) / 60000).toFixed(1)} min)`,
      );
    }
  }
  chrome.kill();
  process.exit(0);
})();
