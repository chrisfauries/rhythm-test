import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import VisionBench from "./bench/VisionBench";
import Collect from "./collect/Collect";
import Labeler from "./labeler/Labeler";
import Replay from "./replay/Replay";
import reportWebVitals from "./reportWebVitals";

// ?label opens the labeler, ?results replays a saved take, ?collect records a
// person's training data, ?vision-bench runs the hand/pose model benchmark
// (developer tool); otherwise the app.
const params = new URLSearchParams(window.location.search);
const PAGE = params.has("label")
  ? "label"
  : params.has("results")
    ? "results"
    : params.has("collect")
      ? "collect"
      : params.has("vision-bench")
        ? "bench"
        : "app";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    {PAGE === "label" ? (
      <Labeler />
    ) : PAGE === "results" ? (
      <Replay />
    ) : PAGE === "collect" ? (
      <Collect />
    ) : PAGE === "bench" ? (
      <VisionBench />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
