import React, { useEffect, useRef, useState } from "react";
import { calibrate } from "../analysis/analyze";
import { audioEngine } from "../audio/AudioEngine";
import { clapBias, learnClapBias, rawClapScore } from "../audio/clapClassifier";
import { CameraPreview, LevelMeter } from "../components/LiveWidgets";
import { Button, Card, SectionLabel } from "../components/ui";
import { downloadDebugBundle } from "../debug/debugBundle";
import { parseLine } from "../music/rhythm";
import { TakeOutcome, TakeRunner } from "../session/TakeRunner";
import { getModelState } from "../speech/voskModel";
import { Settings } from "../state/settings";
import { handTracker } from "../video/HandTracker";

// Two short steps, so claps and voice never mask each other:
//   1. Clap only  -> microphone (and camera) delay; how this room's claps look.
//   2. Count only -> speech delay; how this student's counting looks to the
//      clap detector, so talking isn't mistaken for claps.

interface Props {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

type StepId = "claps" | "counts";

const STEPS: Record<StepId, { title: string; line: string; say: string[]; how: React.ReactNode }> = {
  claps: {
    title: "Step 1 · Clap",
    line: "q q q q | q q q q",
    say: ["1", "2", "3", "4"],
    how: (
      <>
        <b>Clap on every click</b> for two measures, without counting out loud. Mix in some soft claps with the loud
        ones.
      </>
    ),
  },
  counts: {
    title: "Step 2 · Count",
    line: "8 8 8 8 8 8 8 8 | 8 8 8 8 8 8 8 8",
    say: ["1", "&", "2", "&", "3", "&", "4", "&"],
    how: (
      <>
        <b>Say “1 & 2 & 3 & 4 &”</b> with the clicks for two measures, in your normal counting voice. Don't clap.
      </>
    ),
  },
};

const CAL_BPM = 80;
const NUMBER_WORDS = new Set(["one", "two", "three", "four"]);

interface ClapStep {
  micOffset: number | null;
  videoOffset: number | null;
  claps: number;
  contacts: number;
  /** Raw classifier scores of the claps that landed on beats. */
  clapScores: number[];
}

interface CountStep {
  speechOffset: number | null;
  words: number;
  learnedBias: number;
  /** Candidates the clap detector found while the student only talked. */
  voiceCandidates: number;
}

const ms = (s: number | null) => (s === null ? "–" : `${Math.round(s * 1000)} ms`);

const CalibrateScreen: React.FC<Props> = ({ settings, onSave, onClose }) => {
  const [running, setRunning] = useState<StepId | null>(null);
  const [beat, setBeat] = useState("");
  const [clapStep, setClapStep] = useState<ClapStep | null>(null);
  const [countStep, setCountStep] = useState<CountStep | null>(null);
  const [outcomes, setOutcomes] = useState<Partial<Record<StepId, TakeOutcome>>>({});
  const runnerRef = useRef<TakeRunner | null>(null);
  const rafRef = useRef(0);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      runnerRef.current?.cancel();
    },
    []
  );

  const camera = settings.useCamera && handTracker.running;
  const speechReady = !!getModelState().model;

  const run = (step: StepId) => {
    const def = STEPS[step];
    setRunning(step);
    const runner = new TakeRunner(
      parseLine(def.line, "4/4"),
      CAL_BPM,
      {
        ...settings,
        countInMeasures: 1,
        metronomeDuringLine: true,
        micOffset: 0,
        speechOffset: 0,
        videoOffset: 0,
        activity: step === "counts" ? "count-notes" : "clap",
        useCamera: step === "claps" && settings.useCamera,
      },
      getModelState().model
    );
    runnerRef.current = runner;
    runner.start();
    const t = runner.timing;
    const tick = () => {
      const now = audioEngine.audibleTime();
      if (now < t.lineStart) {
        const b = Math.floor((now - t.countInStart) / t.secPerBeat);
        setBeat(b < 0 ? "" : ["1", "2", "Ready", "Go!"][b] ?? "");
      } else if (now < t.lineEnd) {
        const sub = def.say.length / 4;
        const i = Math.floor(((now - t.lineStart) / t.secPerBeat) * sub);
        setBeat(def.say[i % def.say.length]);
      } else {
        setBeat("");
      }
      if (now < t.lineEnd + 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    runner.done.then((outcome) => {
      cancelAnimationFrame(rafRef.current);
      setRunning(null);
      setBeat("");
      if (!outcome) return;
      outcome.snapshots.forEach((s) => s.bitmap.close());
      setOutcomes((o) => ({ ...o, [step]: outcome }));
      if (step === "claps") setClapStep(measureClaps(outcome));
      else setCountStep(measureCounts(outcome));
    });
  };

  const beats = (o: TakeOutcome) => Array.from({ length: 8 }, (_, i) => o.timing.lineStart + i * o.timing.secPerBeat);
  const inLine = (o: TakeOutcome) => (x: number) =>
    x > o.timing.lineStart - o.timing.secPerBeat / 2 && x < o.timing.lineEnd + o.timing.secPerBeat / 2;

  const measureClaps = (o: TakeOutcome): ClapStep => {
    const b = beats(o);
    // Every candidate counts here: the student is only clapping.
    const cands = o.raw.candidates.filter((c) => !c.gated && inLine(o)(c.time));
    const r = calibrate(b, cands.map((c) => c.time), [], o.raw.frames.length ? o.raw.frames : null);
    const off = r.micOffset ?? 0;
    const onBeat = cands.filter((c) => b.some((t) => Math.abs(c.time - off - t) < 0.12));
    return {
      micOffset: r.micOffset,
      videoOffset: r.videoOffset,
      claps: r.claps,
      contacts: r.contacts,
      clapScores: onBeat.map((c) => rawClapScore(c.features)),
    };
  };

  const measureCounts = (o: TakeOutcome): CountStep => {
    const words = o.raw.words
      .filter((w) => w.label && NUMBER_WORDS.has(w.label))
      .map((w) => ({ word: w.word, label: w.label, time: w.time }));
    const r = calibrate(beats(o), [], words, null);
    // Nobody clapped, so every candidate here was the voice.
    const voice = o.raw.candidates.filter((c) => !c.gated && inLine(o)(c.time));
    return {
      speechOffset: r.speechOffset,
      words: r.words,
      learnedBias: learnClapBias(voice.map((c) => c.features)),
      voiceCandidates: voice.length,
    };
  };

  const bias = countStep ? countStep.learnedBias : settings.clapBias;
  const clapsKept = clapStep
    ? clapStep.clapScores.filter((s) => s + clapBias(bias, settings.clapSensitivity) > 0).length
    : 0;

  const save = () => {
    const patch: Partial<Settings> = {};
    if (clapStep?.micOffset != null) patch.micOffset = clapStep.micOffset;
    if (clapStep?.videoOffset != null) patch.videoOffset = clapStep.videoOffset;
    if (countStep) {
      patch.clapBias = countStep.learnedBias;
      if (countStep.speechOffset !== null) patch.speechOffset = countStep.speechOffset;
    }
    onSave(patch);
    onClose();
  };

  const stepCard = (id: StepId, done: boolean, enabled: boolean, note?: string) => (
    <Card className={`flex flex-col gap-3 ${enabled ? "" : "opacity-50"}`}>
      <div className="flex items-center justify-between">
        <SectionLabel>{STEPS[id].title}</SectionLabel>
        {done && <span className="text-xs font-bold text-emerald-600">✓ Done</span>}
      </div>
      <p className="text-slate-600 dark:text-slate-300">{STEPS[id].how}</p>
      {note && <p className="text-xs text-amber-600">{note}</p>}
      <div className="flex items-center gap-4">
        <Button onClick={() => run(id)} disabled={!enabled || running !== null} variant={done ? "secondary" : "primary"}>
          {done ? "Do it again" : "Start"}
        </Button>
        {outcomes[id] && (
          <button
            type="button"
            className="text-xs text-slate-400 underline hover:text-slate-600"
            onClick={() =>
              downloadDebugBundle(
                { id: `calibrate-${id}`, title: STEPS[id].title, source: STEPS[id].line, timeSig: "4/4", tempo: CAL_BPM },
                outcomes[id]!
              )
            }
          >
            Download debug bundle
          </button>
        )}
      </div>
    </Card>
  );

  return (
    <div className="flex flex-col items-center w-full max-w-4xl mx-auto px-4 py-8 min-h-screen gap-4">
      <div className="flex items-center w-full">
        <Button variant="secondary" onClick={onClose}>
          ← Back
        </Button>
        <h1 className="flex-1 text-center text-3xl md:text-4xl font-black tracking-tight text-walsh-green dark:text-emerald-400 pr-24">
          Calibrate
        </h1>
      </div>
      <p className="text-sm text-slate-500 text-center max-w-2xl">
        Sit where students will sit, with the speakers (or headphones) at normal volume. This measures the delays of
        this computer's speakers, microphone, speech engine and camera, and learns what claps and counting sound like
        in this room. It's saved on this computer.
      </p>

      <div className="grid w-full gap-4 md:grid-cols-2">
        {stepCard("claps", !!clapStep, true)}
        {stepCard(
          "counts",
          !!countStep,
          speechReady,
          speechReady ? undefined : "Wait for the voice engine to finish loading."
        )}
      </div>

      <div className={`grid w-full gap-4 ${camera && running === "claps" ? "md:grid-cols-2" : ""}`}>
        <Card className="flex flex-col items-center justify-center gap-4 min-h-[200px]">
          <div className="text-8xl font-black text-walsh-green h-28 flex items-center">
            {beat || (running ? "" : <span className="text-2xl text-slate-300">Press Start</span>)}
          </div>
          <div className="w-full max-w-xs">
            <LevelMeter />
          </div>
        </Card>
        {camera && running === "claps" && <CameraPreview />}
      </div>

      {(clapStep || countStep) && (
        <Card>
          <SectionLabel>Results</SectionLabel>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-center">
            <Stat label="Claps" value={ms(clapStep?.micOffset ?? null)} sub={clapStep ? `${clapStep.claps}/8 heard · was ${ms(settings.micOffset)}` : "step 1"} />
            <Stat
              label="Counting"
              value={ms(countStep?.speechOffset ?? null)}
              sub={countStep ? `${countStep.words}/8 heard · was ${ms(settings.speechOffset)}` : "step 2"}
            />
            <Stat
              label="Camera"
              value={ms(clapStep?.videoOffset ?? null)}
              sub={!camera ? "camera off" : clapStep ? `${clapStep.contacts}/8 seen` : "step 1"}
            />
            <Stat
              label="Clap vs voice"
              value={clapStep && countStep ? `${clapsKept}/${clapStep.clapScores.length}` : "–"}
              sub={
                countStep
                  ? `claps recognized · ${countStep.voiceCandidates} voice sound${countStep.voiceCandidates === 1 ? "" : "s"} rejected`
                  : "after both steps"
              }
            />
          </div>
          {clapStep && clapStep.micOffset === null && (
            <p className="mt-3 text-sm text-rose-600">
              Not enough claps were heard on the beat. Check the level meter moves when you clap, and that the right
              microphone is chosen in Settings.
            </p>
          )}
          {countStep && countStep.speechOffset === null && (
            <p className="mt-3 text-sm text-rose-600">
              Not enough counts were recognized. Count a little louder and clearer, and keep to the clicks.
            </p>
          )}
          {clapStep && countStep && clapsKept < clapStep.clapScores.length - 1 && (
            <p className="mt-3 text-sm text-amber-600">
              Some soft claps sound a lot like this voice. Students should clap a bit louder than they count, or move
              the microphone closer to their hands.
            </p>
          )}
          <div className="flex justify-center gap-3 mt-4">
            <Button
              onClick={save}
              disabled={clapStep?.micOffset == null && countStep?.speechOffset == null && !countStep}
            >
              Save
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; sub: string }> = ({ label, value, sub }) => (
  <div className="rounded-2xl bg-slate-50 dark:bg-slate-800 p-3">
    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">{label}</div>
    <div className="text-2xl font-mono font-bold">{value}</div>
    <div className="text-xs text-slate-500">{sub}</div>
  </div>
);

export default CalibrateScreen;
