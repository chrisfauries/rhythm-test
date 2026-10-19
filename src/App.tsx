import React, { useCallback, useEffect, useState } from "react";
import "./App.css";
import { Exercise, findExercise, nextExercise, PAGES } from "./music/book";
import CalibrateScreen from "./screens/CalibrateScreen";
import HistoryPanel from "./screens/HistoryPanel";
import PerformScreen from "./screens/PerformScreen";
import ResultsScreen from "./screens/ResultsScreen";
import SettingsPanel from "./screens/SettingsPanel";
import SetupScreen from "./screens/SetupScreen";
import { TakeOutcome } from "./session/TakeRunner";
import { useDevices } from "./state/devices";
import { useHistory } from "./state/history";
import { useSettings } from "./state/settings";
import { handTracker } from "./video/HandTracker";

enum PHASE {
  SETUP,
  PERFORM,
  RESULTS,
  CALIBRATE,
}

// The chosen line and tempo live in the URL (?line=7.5-C&tempo=80) so a
// teacher can bookmark or share a specific assignment.
// Read once at load, before the app rewrites the URL.
const URL_PARAMS = new URLSearchParams(window.location.search);

const initialExercise = (): Exercise => {
  const id = URL_PARAMS.get("line");
  return (id && findExercise(id)?.exercise) || PAGES[0].exercises[0];
};

function App() {
  const [settings, update] = useSettings();
  const devices = useDevices(settings);
  const history = useHistory();
  const [phase, setPhase] = useState(PHASE.SETUP);
  const [exercise, setExercise] = useState<Exercise>(initialExercise);
  const [outcome, setOutcome] = useState<TakeOutcome | null>(null);
  const [takeKey, setTakeKey] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const tempo = URL_PARAMS.get("tempo");
    if (tempo && +tempo >= 40 && +tempo <= 200) update({ tempo: +tempo });
  }, [update]);

  useEffect(() => {
    if (exercise.id === "custom") return;
    const params = new URLSearchParams(window.location.search);
    params.set("line", exercise.id);
    params.set("tempo", String(settings.tempo));
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }, [exercise, settings.tempo]);

  useEffect(() => {
    handTracker.tuning = settings.cameraModel === "pose" ? settings.poseTuning : settings.handTuning;
  }, [settings.cameraModel, settings.poseTuning, settings.handTuning]);

  const replaceOutcome = useCallback((next: TakeOutcome | null) => {
    setOutcome((prev) => {
      prev?.snapshots.forEach((s) => s.bitmap.close());
      return next;
    });
  }, []);

  const start = () => {
    replaceOutcome(null);
    setTakeKey((k) => k + 1);
    setPhase(PHASE.PERFORM);
  };

  const finished = (o: TakeOutcome) => {
    replaceOutcome(o);
    const s = o.result.summary;
    history.add({
      id: `${Date.now()}`,
      date: new Date().toISOString(),
      student: settings.studentName.trim(),
      exerciseId: exercise.id,
      title: exercise.id === "custom" ? `Custom: ${exercise.source}` : exercise.title,
      bpm: settings.tempo,
      overall: s.overall,
      clap: s.clapScore,
      count: s.countScore,
      hold: s.holdScore,
      meanOffsetMs: s.meanOffsetMs,
      tendency: s.tendency,
    });
    setPhase(PHASE.RESULTS);
  };

  const next = exercise.id === "custom" ? null : nextExercise(exercise.id);

  let screen: React.ReactNode = null;
  switch (phase) {
    case PHASE.SETUP:
      screen = (
        <SetupScreen
          settings={settings}
          update={update}
          devices={devices}
          exercise={exercise}
          onSelectExercise={setExercise}
          onStart={start}
          onCalibrate={() => setPhase(PHASE.CALIBRATE)}
          onOpenSettings={() => setShowSettings(true)}
          onOpenHistory={() => setShowHistory(true)}
        />
      );
      break;
    case PHASE.PERFORM:
      screen = (
        <PerformScreen key={takeKey} exercise={exercise} settings={settings} onFinished={finished} onCancel={() => setPhase(PHASE.SETUP)} />
      );
      break;
    case PHASE.RESULTS:
      screen = outcome && (
        <ResultsScreen
          exercise={exercise}
          outcome={outcome}
          tempo={settings.tempo}
          onRetry={start}
          onNext={
            next
              ? () => {
                  setExercise(next);
                  start();
                }
              : null
          }
          onChooseLine={() => setPhase(PHASE.SETUP)}
        />
      );
      break;
    case PHASE.CALIBRATE:
      screen = <CalibrateScreen settings={settings} onSave={update} onClose={() => setPhase(PHASE.SETUP)} />;
      break;
  }

  return (
    <div className="App flex flex-col w-full min-h-screen">
      {screen}
      {showSettings && <SettingsPanel settings={settings} update={update} onClose={() => setShowSettings(false)} />}
      {showHistory && <HistoryPanel records={history.records} onClear={history.clear} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

export default App;
