import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import Collect from "./collect/Collect";
import Labeler from "./labeler/Labeler";
import Replay from "./replay/Replay";
import reportWebVitals from "./reportWebVitals";

// ?label opens the labeler, ?results replays a saved take, ?collect records a
// person's training data; otherwise the app.
const params = new URLSearchParams(window.location.search);
const PAGE = params.has("label") ? "label" : params.has("results") ? "results" : params.has("collect") ? "collect" : "app";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
root.render(
  <React.StrictMode>
    {PAGE === "label" ? <Labeler /> : PAGE === "results" ? <Replay /> : PAGE === "collect" ? <Collect /> : <App />}
  </React.StrictMode>,
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
