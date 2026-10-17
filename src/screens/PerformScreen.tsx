import React, { useEffect, useRef, useState } from "react";
import { audioEngine } from "../audio/AudioEngine";
import Staff, { StaffLayout } from "../components/Staff";
import { CameraPreview, LevelMeter } from "../components/LiveWidgets";
import { Button, Card } from "../components/ui";
import { Exercise } from "../music/book";
import { beatLength } from "../music/rhythm";
import { activityInfo } from "../music/activity";
import { TakeOutcome, TakeRunner } from "../session/TakeRunner";
import { getModelState } from "../speech/voskModel";
import { Settings } from "../state/settings";
import { handTracker } from "../video/HandTracker";

interface Props {
  exercise: Exercise;
  settings: Settings;
  onFinished: (outcome: TakeOutcome) => void;
  onCancel: () => void;
}

type Stage = "count-in" | "playing" | "analyzing";

const countInWord = (beat: number, total: number) => {
  if (total >= 4 && beat === total - 2) return "Ready";
  if (total >= 4 && beat === total - 1) return "Go!";
  return String((beat % 12) + 1);
};

const PerformScreen: React.FC<Props> = ({ exercise, settings, onFinished, onCancel }) => {
  const [stage, setStage] = useState<Stage>("count-in");
  const [countIn, setCountIn] = useState<string>("");
  const [claps, setClaps] = useState<{ id: number; pos: number }[]>([]);
  const [heard, setHeard] = useState("");
  const runnerRef = useRef<TakeRunner | null>(null);
  const layoutRef = useRef<StaffLayout | null>(null);
  const cursorRef = useRef<SVGLineElement | null>(null);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancelRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let alive = true;
    let clapId = 0;
    const model = getModelState().model;
    const runner = new TakeRunner(exercise.line, settings.tempo, settings, model, {
      onClap: (time) => {
        const r = runnerRef.current;
        if (!r) return;
        const secPerQ = r.timing.secPerBeat / beatLength(exercise.line.timeSig);
        const pos = (time - r.timing.lineStart) / secPerQ;
        const id = clapId++;
        setClaps((c) => [...c.slice(-40), { id, pos }]);
      },
      onPartialWords: (text) => setHeard(text),
    });
    runnerRef.current = runner;
    runner.start();
    runner.done.then((outcome) => {
      if (alive && outcome) onFinishedRef.current(outcome);
    });

    let raf = 0;
    const tick = () => {
      const t = runner.timing;
      const now = audioEngine.audibleTime();
      if (now < t.lineStart) {
        const beat = Math.floor((now - t.countInStart) / t.secPerBeat);
        setCountIn(beat >= 0 ? countInWord(beat, t.countInBeats) : "");
      } else if (now < t.lineEnd + 0.3) {
        setStage("playing");
        setCountIn("");
      } else {
        setStage("analyzing");
      }
      const layout = layoutRef.current;
      const cursor = cursorRef.current;
      if (layout && cursor) {
        const secPerQ = t.secPerBeat / beatLength(exercise.line.timeSig);
        const pos = (now - t.lineStart) / secPerQ;
        if (pos >= 0 && pos <= layout.rows[layout.rows.length - 1].lastPos) {
          const row = layout.rows[layout.rowOf(pos)];
          const x = layout.xOf(pos);
          cursor.setAttribute("x1", String(x));
          cursor.setAttribute("x2", String(x));
          cursor.setAttribute("y1", String(row.top + 12));
          cursor.setAttribute("y2", String(row.staffBottom));
          cursor.style.opacity = "1";
        } else {
          cursor.style.opacity = "0";
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      runner.cancel();
    };
    // Run once per mount; settings are captured for this take.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showCamera = settings.useCamera && handTracker.running;
  const activity = activityInfo(settings.activity);

  return (
    <div className="flex flex-col items-center w-full max-w-6xl mx-auto px-4 py-6 min-h-screen gap-4">
      <div className="flex items-center gap-4 w-full">
        <Button variant="secondary" onClick={onCancel} title="Stop and go back (Esc)">
          ← Back
        </Button>
        <div>
          <h2 className="text-xl md:text-2xl font-extrabold tracking-tight">{exercise.title}</h2>
          <p className="text-sm text-slate-500">
            {settings.tempo} BPM · {exercise.timeSig} · {activity.label}
          </p>
        </div>
      </div>

      <Card className="relative">
        <div className="rounded-2xl bg-white border border-slate-200 px-3 pt-2">
          <Staff
            line={exercise.line}
            onLayout={(l) => (layoutRef.current = l)}
            overlay={(layout) => (
              <>
                <line ref={cursorRef} stroke="#FFB81C" strokeWidth={4} strokeLinecap="round" opacity={0} />
                {claps.map((c) => {
                  if (c.pos < -1) return null;
                  const row = layout.rows[layout.rowOf(c.pos)];
                  return (
                    <circle
                      key={c.id}
                      className="clap-pop"
                      cx={layout.xOf(c.pos)}
                      cy={row.lineY + 34}
                      r={9}
                      fill="#006341"
                    />
                  );
                })}
              </>
            )}
          />
        </div>
        {countIn && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span
              key={countIn}
              className="text-7xl md:text-8xl font-black text-walsh-green drop-shadow-[0_4px_20px_rgba(255,255,255,0.9)] animate-[clapPop_600ms_ease-out_reverse]"
            >
              {countIn}
            </span>
          </div>
        )}
        {stage === "analyzing" && (
          <div className="absolute inset-0 flex items-center justify-center rounded-3xl bg-white/70 dark:bg-slate-900/70 backdrop-blur-sm">
            <span className="text-2xl font-bold animate-pulse">Checking your rhythm…</span>
          </div>
        )}
      </Card>

      <div className={`grid w-full gap-4 ${showCamera ? "md:grid-cols-[1fr_360px]" : ""}`}>
        <Card className="flex flex-col gap-4 justify-center">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Microphone</div>
            <LevelMeter />
          </div>
          {activity.countMode && (
            <div>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">Hearing</div>
              <div className="min-h-[2.5rem] text-2xl font-semibold text-slate-700 dark:text-slate-200">
                {heard || <span className="text-slate-300 dark:text-slate-600">Count out loud…</span>}
              </div>
            </div>
          )}
          <p className="text-sm text-slate-500">
            {stage === "count-in" ? "Listen to the count-in. Start on beat 1." : stage === "playing" ? activity.hint : "Done!"}
          </p>
        </Card>
        {showCamera && <CameraPreview />}
      </div>
    </div>
  );
};

export default PerformScreen;
