import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { feedback } from "../analysis/feedback";
import { audioEngine } from "../audio/AudioEngine";
import Staff, { StaffLayout } from "../components/Staff";
import { Button, Card, Pill, SectionLabel } from "../components/ui";
import { downloadBlob } from "../debug/debugBundle";
import { activityInfo } from "../music/activity";
import { findExercise } from "../music/book";
import { parseLine } from "../music/rhythm";
import PerformScreen from "../screens/PerformScreen";
import { TakeOutcome } from "../session/TakeRunner";
import { useDevices } from "../state/devices";
import { Settings, useSettings } from "../state/settings";
import { buildCapture, defaultCaptureName, MetronomeOut, MicKind, Setting } from "../training/capture";
import { buildClipZip, COUNT_IN, PromptRun, PromptTake, runPrompt } from "./clips";
import { ClipPrompt, PROMPTS, promptMusic, showLabel, TAKES } from "./plan";

// ?collect: a guided session for collecting one person's training data.
//   Guided takes: the planned lines one at a time (plan.ts). Practice as often
//   as you like, then record; if it was played exactly as written it's saved
//   as a training capture zip, otherwise try again.
//   Sound clips: single words, phrases, claps and singing on the click, each
//   shown as music first and started by the person, saved as one zip of
//   separate WAV files (clips.ts).

type Group = "adult" | "student";

interface Person {
  id: string;
  group: Group;
  /** BPM added to every planned tempo (slower for younger students). */
  tempoShift: number;
  setting: Setting;
  mic: MicKind;
  metronome: MetronomeOut;
}

const PERSON_KEY = "rhythm-tester-collect-person";
const PROGRESS_KEY = "rhythm-tester-collect-progress";

const load = <T,>(key: string, fallback: T): T => {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
  } catch {
    return fallback;
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private window: progress just isn't remembered.
  }
};

type Progress = Record<string, { done: string[]; skipped: string[] }>;

const input =
  "w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-walsh-green";

const Collect: React.FC = () => {
  const [settings] = useSettings();
  const devices = useDevices(settings);
  const [person, setPerson] = useState<Person>(() =>
    load<Person>(PERSON_KEY, { id: "", group: "adult", tempoShift: 0, setting: "home", mic: "built-in", metronome: "headphones" }),
  );
  const [mode, setMode] = useState<"start" | "takes" | "clips">("start");
  const [progress, setProgress] = useState<Progress>(() => load<Progress>(PROGRESS_KEY, {}));
  const mine = progress[person.id] ?? { done: [], skipped: [] };
  const mark = (line: string, kind: "done" | "skipped") => {
    const next = {
      ...progress,
      [person.id]: { done: mine.done.filter((x) => x !== line), skipped: mine.skipped.filter((x) => x !== line) },
    };
    next[person.id][kind].push(line);
    setProgress(next);
    save(PROGRESS_KEY, next);
  };
  const setP = (patch: Partial<Person>) => {
    const next = { ...person, ...patch };
    setPerson(next);
    save(PERSON_KEY, next);
  };

  const ready = devices.mic === "on" && person.id.trim().length > 0;

  if (mode === "takes")
    return (
      <GuidedTakes
        settings={settings}
        person={person}
        done={mine.done}
        skipped={mine.skipped}
        mark={mark}
        onBack={() => setMode("start")}
      />
    );
  if (mode === "clips") return <ClipSessionView settings={settings} person={person} onBack={() => setMode("start")} />;

  return (
    <div className="flex flex-col items-center w-full max-w-3xl mx-auto px-4 py-8 gap-5 min-h-screen">
      <div className="w-full">
        <h1 className="text-3xl font-black tracking-tight">Collect a person</h1>
        <p className="mt-1 text-slate-500">
          Records one person's takes and sounds for training the app. Wear headphones, so the click isn't recorded.
        </p>
      </div>

      <Card className="w-full flex flex-col gap-4">
        <SectionLabel>Who</SectionLabel>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">Person ID (no names, e.g. adult-2 or student-1)</span>
          <input className={input} value={person.id} onChange={(e) => setP({ id: e.target.value.trim() })} />
        </label>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300 mr-2">Age</span>
          <Pill selected={person.group === "adult"} onClick={() => setP({ group: "adult" })}>
            Adult
          </Pill>
          <Pill selected={person.group === "student"} onClick={() => setP({ group: "student" })}>
            Student
          </Pill>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300 mr-2">Tempos</span>
          {[
            [-15, "Slower (−15)"],
            [0, "As planned"],
            [10, "Faster (+10)"],
          ].map(([v, label]) => (
            <Pill key={v} selected={person.tempoShift === v} onClick={() => setP({ tempoShift: v as number })}>
              {label}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300 mr-2">Room</span>
          {(
            [
              ["home", "Home"],
              ["practice-room", "Practice room"],
              ["band-room", "Band room"],
            ] as [Setting, string][]
          ).map(([v, label]) => (
            <Pill key={v} selected={person.setting === v} onClick={() => setP({ setting: v })}>
              {label}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300 mr-2">Microphone</span>
          {(
            [
              ["built-in", "Built-in / webcam"],
              ["headset", "Headset"],
              ["external", "External"],
            ] as [MicKind, string][]
          ).map(([v, label]) => (
            <Pill key={v} selected={person.mic === v} onClick={() => setP({ mic: v })}>
              {label}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300 mr-2">Click heard on</span>
          {(
            [
              ["headphones", "Headphones"],
              ["speaker", "Speaker"],
            ] as [MetronomeOut, string][]
          ).map(([v, label]) => (
            <Pill key={v} selected={person.metronome === v} onClick={() => setP({ metronome: v })}>
              {label}
            </Pill>
          ))}
        </div>
      </Card>

      <Card className="w-full flex flex-col gap-3">
        <SectionLabel>Microphone and camera</SectionLabel>
        {devices.mic === "on" ? (
          <p className="text-emerald-700 dark:text-emerald-400 font-semibold">
            ✓ Microphone on
            {devices.camera === "on" ? ", camera on" : settings.useCamera ? ` · camera ${devices.camera}` : " · camera off in Settings"}
          </p>
        ) : (
          <div>
            <Button onClick={devices.enable}>Turn on the microphone{settings.useCamera ? " and camera" : ""}</Button>
            {devices.micError && <p className="mt-2 text-rose-600">{devices.micError}</p>}
          </div>
        )}
      </Card>

      <div className="grid w-full gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-3">
          <h2 className="text-xl font-extrabold">🎼 Guided takes</h2>
          <p className="text-slate-600 dark:text-slate-300">
            {TAKES.length} lines, one at a time: practice, then record. Each take played exactly as written is saved (about 25–40 minutes).
          </p>
          <p className="text-sm text-slate-500">
            {person.id ? `${mine.done.length} of ${TAKES.length} done${mine.skipped.length ? `, ${mine.skipped.length} skipped` : ""}` : ""}
          </p>
          <Button disabled={!ready} onClick={() => setMode("takes")}>
            {mine.done.length ? "Continue" : "Start"}
          </Button>
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="text-xl font-extrabold">🗣️ Sound clips</h2>
          <p className="text-slate-600 dark:text-slate-300">
            {PROMPTS.length} short prompts: counts, phrases, claps and singing, each on the click a few times. Saved as one zip of clips
            (about 8 minutes).
          </p>
          <Button disabled={!ready} onClick={() => setMode("clips")}>
            Start
          </Button>
        </Card>
      </div>
      {!ready && <p className="text-sm text-slate-500">Enter a person ID and turn on the microphone to begin.</p>}
    </div>
  );
};

// ---- Guided takes -----------------------------------------------------------

const GuidedTakes: React.FC<{
  settings: Settings;
  person: Person;
  done: string[];
  skipped: string[];
  mark: (line: string, kind: "done" | "skipped") => void;
  onBack: () => void;
}> = ({ settings, person, done, skipped, mark, onBack }) => {
  const firstOpen = () =>
    Math.max(
      0,
      TAKES.findIndex((t) => !done.includes(t.line) && !skipped.includes(t.line)),
    );
  const [index, setIndex] = useState(firstOpen);
  const [stage, setStage] = useState<"ready" | "practice" | "record" | "review" | "saving">("ready");
  const [outcome, setOutcome] = useState<TakeOutcome | null>(null);
  const [practiced, setPracticed] = useState(false);
  const [takeKey, setTakeKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const plan = TAKES[index];
  const exercise = findExercise(plan.line)!.exercise;
  const bpm = Math.max(40, Math.min(200, plan.bpm + person.tempoShift));
  const takeSettings: Settings = useMemo(
    () => ({ ...settings, tempo: bpm, activity: plan.activity, metronomeDuringLine: plan.click, countInMeasures: 1 }),
    [settings, bpm, plan],
  );
  const info = activityInfo(plan.activity);
  const allDone = TAKES.every((t) => done.includes(t.line) || skipped.includes(t.line));

  const replaceOutcome = (next: TakeOutcome | null) => {
    setOutcome((prev) => {
      prev?.snapshots.forEach((s) => s.bitmap.close());
      return next;
    });
  };
  const go = (i: number) => {
    replaceOutcome(null);
    setIndex(i);
    setPracticed(false);
    setStage("ready");
  };
  const nextOpen = () => {
    const i = TAKES.findIndex((t, k) => k > index && !done.includes(t.line));
    return i >= 0 ? i : TAKES.findIndex((t) => !done.includes(t.line));
  };
  const begin = (kind: "practice" | "record") => {
    replaceOutcome(null);
    setError(null);
    setTakeKey((k) => k + 1);
    setStage(kind);
  };

  const keep = async () => {
    if (!outcome) return;
    setStage("saving");
    try {
      const meta = { id: exercise.id, title: exercise.title, source: exercise.source, timeSig: exercise.timeSig, tempo: bpm };
      const name = `${person.id}_${defaultCaptureName(exercise.id, plan.activity, bpm)}`.replace(/[^\w.-]+/g, "-");
      const blob = await buildCapture(meta, outcome, {
        name,
        studentId: person.id,
        setting: person.setting,
        mic: person.mic,
        metronome: person.metronome,
        performance: "as-written",
        note: `Guided collection, take ${index + 1} of ${TAKES.length} (${person.group}): ${plan.why}`,
      });
      downloadBlob(blob, `${name}.zip`);
      mark(plan.line, "done");
      const n = nextOpen();
      go(n >= 0 && n !== index ? n : index);
    } catch (err) {
      console.error(err);
      setError(`Couldn't save the take: ${String(err)}`);
      setStage("review");
    }
  };

  if (stage === "practice" || stage === "record") {
    return (
      <PerformScreen
        key={takeKey}
        exercise={exercise}
        settings={takeSettings}
        onFinished={(o) => {
          replaceOutcome(o);
          if (stage === "practice") setPracticed(true);
          setStage(stage === "practice" ? "ready" : "review");
        }}
        onCancel={() => setStage("ready")}
      />
    );
  }

  const fb = outcome
    ? feedback({
        result: outcome.result,
        line: exercise.line,
        activity: info,
        bpm,
        metronome: plan.click,
        latencyKnown: outcome.raw.debug?.offsets?.micSource !== "browser",
      })
    : null;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <div className="flex flex-col items-center w-full max-w-5xl mx-auto px-4 py-6 gap-5 min-h-screen">
      <div className="flex flex-wrap items-center gap-3 w-full">
        <Button variant="secondary" onClick={onBack}>
          ◀ Menu
        </Button>
        <div className="flex-1">
          <p className="text-sm font-bold text-slate-500">
            {person.id} · take {index + 1} of {TAKES.length} · {done.length} saved
          </p>
          <div className="mt-1 flex gap-1 flex-wrap">
            {TAKES.map((t, i) => (
              <button
                key={t.line}
                type="button"
                title={`${t.line}: ${t.why}`}
                onClick={() => go(i)}
                className={`w-6 h-2.5 rounded-full ${
                  done.includes(t.line) ? "bg-walsh-green" : skipped.includes(t.line) ? "bg-slate-400" : "bg-slate-200 dark:bg-slate-700"
                } ${i === index ? "ring-2 ring-walsh-gold" : ""}`}
              />
            ))}
          </div>
        </div>
      </div>

      {allDone && (
        <Card className="w-full border-4 border-walsh-green">
          <p className="text-xl font-extrabold">
            🎉 All {TAKES.length} lines are done{skipped.length ? ` (${skipped.length} skipped)` : ""}. Thank you!
          </p>
          <p className="mt-1 text-slate-500">The takes were saved to your Downloads folder. Next: the sound clips, from the menu.</p>
        </Card>
      )}

      <Card className="w-full flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 className="text-2xl font-black">{exercise.title}</h2>
          <span className="font-bold text-slate-500">
            {bpm} BPM · {plan.click ? "click on" : "click only for the count-in"}
            {done.includes(plan.line) ? " · ✓ saved" : ""}
          </span>
        </div>
        <div className="rounded-2xl bg-amber-50 dark:bg-slate-800 border border-amber-200 dark:border-slate-700 p-4">
          <p className="text-lg font-extrabold">{info.label}</p>
          <p className="mt-1 text-slate-700 dark:text-slate-300">{info.hint}</p>
          <p className="mt-2 text-sm text-slate-500">This one is for: {plan.why}.</p>
        </div>
        <div className="rounded-2xl bg-white border border-slate-200 px-3 py-2 overflow-x-auto">
          <Staff line={exercise.line} />
        </div>
      </Card>

      {stage === "review" && outcome && fb && (
        <Card className="w-full border-4 border-walsh-gold flex flex-col gap-3">
          <p className="text-sm font-bold text-slate-500">
            The app heard: {pct(outcome.result.summary.overall)} · {fb.top.text}
          </p>
          <p className="text-2xl font-extrabold">Did you play it exactly as written, with no mistakes?</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={keep}>✓ Yes, save it</Button>
            <Button variant="secondary" onClick={() => begin("record")}>
              ✗ No, try again
            </Button>
          </div>
          <p className="text-sm text-slate-500">
            Be honest: a take with a mistake in it, saved as perfect, teaches the app the wrong thing.
          </p>
          {error && <p className="text-rose-600">{error}</p>}
        </Card>
      )}
      {stage === "saving" && (
        <Card className="w-full">
          <p className="text-lg font-bold">Saving the take…</p>
        </Card>
      )}

      {stage === "ready" && (
        <Card className="w-full flex flex-col gap-3">
          {practiced && outcome && fb && (
            <p className="text-slate-600 dark:text-slate-300">
              Practice: {pct(outcome.result.summary.overall)} · {fb.top.text}
            </p>
          )}
          <p className="text-slate-600 dark:text-slate-300">
            Practice as many times as you like (nothing is saved). When you're ready, record it: it counts you in with one measure of
            clicks.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => begin("practice")}>
              ▶ Practice
            </Button>
            <Button variant="gold" onClick={() => begin("record")}>
              ● Record
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                mark(plan.line, "skipped");
                const n = nextOpen();
                go(n >= 0 ? n : index);
              }}
              title="Too hard right now: come back to it later"
            >
              Skip this line
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
};

// ---- Sound clips ------------------------------------------------------------

const COUNT_WORDS = ["1", "2", "ready", "go"];
const COUNT_IN_LINE = parseLine("qr qr qr qr", "4/4");

/**
 * What's about to happen, as music: a measure of rests for the count-in
 * ("1 2 ready go", nothing to say), then the notes to perform with what to say
 * under each. The beat being played now is lit up.
 */
const PromptMusic: React.FC<{ prompt: ClipPrompt; beat: number }> = ({ prompt, beat }) => {
  const music = useMemo(() => {
    const m = promptMusic(prompt);
    return parseLine(m.source, m.timeSig);
  }, [prompt]);
  const rep = beat >= COUNT_IN ? Math.floor((beat - COUNT_IN) / prompt.beats) : -1;
  const at = (layout: StaffLayout, pos: number) => {
    const r = layout.rowOf(pos);
    return { x: layout.xOf(pos, r), y: layout.rows[r].staffBottom + 24 };
  };
  return (
    <div className="w-full rounded-2xl bg-white border border-slate-200 px-3 pt-1 pb-2 flex flex-col sm:flex-row gap-2">
      <div className="sm:w-56 shrink-0">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-400 text-center">Count-in: just listen</p>
        <Staff
          line={COUNT_IN_LINE}
          laneHeight={34}
          overlay={(layout) =>
            COUNT_WORDS.map((w, k) => {
              const { x, y } = at(layout, k);
              return (
                <text
                  key={k}
                  x={x}
                  y={y}
                  textAnchor="middle"
                  fontSize={15}
                  fontStyle="italic"
                  fill={beat === k ? "#d97706" : "#94a3b8"}
                  fontWeight={beat === k ? 800 : 400}
                >
                  {w}
                </text>
              );
            })
          }
        />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-bold uppercase tracking-widest text-slate-500 text-center">
          Then {prompt.kind === "clap" ? "clap" : prompt.kind === "sing" ? "sing" : "say"} on the notes
        </p>
        <Staff
          line={music}
          laneHeight={34}
          overlay={(layout) =>
            Array.from({ length: prompt.reps }, (_, r) =>
              prompt.labels.map((label, k) => {
                const { x, y } = at(layout, r * prompt.beats + prompt.offsets[k]);
                return (
                  <text
                    key={`${r}-${k}`}
                    x={x}
                    y={y}
                    textAnchor="middle"
                    fontSize={18}
                    fontWeight={800}
                    fill={r === rep ? "#d97706" : "#0f172a"}
                  >
                    {showLabel(label)}
                  </text>
                );
              }),
            )
          }
        />
      </div>
    </div>
  );
};

const ClipSessionView: React.FC<{ settings: Settings; person: Person; onBack: () => void }> = ({ settings, person, onBack }) => {
  const [index, setIndex] = useState(0);
  // preview: the prompt and its music, waiting for Start; running; result: Redo or Next.
  const [stage, setStage] = useState<"intro" | "preview" | "running" | "result" | "finished">("intro");
  const [takes, setTakes] = useState<Record<string, PromptTake>>({});
  const [beat, setBeat] = useState(-1);
  const [busy, setBusy] = useState(false);
  const runRef = useRef<PromptRun | null>(null);
  const prompt = PROMPTS[index];
  const micOffset = settings.micOffset ?? audioEngine.defaultMicOffset;
  const last = prompt ? takes[prompt.id] : undefined;

  const start = useCallback(() => {
    runRef.current?.cancel();
    const p = PROMPTS[index];
    const run = runPrompt(p, settings.clickVolume, micOffset);
    runRef.current = run;
    setStage("running");
    run.done.then((take) => {
      if (runRef.current !== run) return;
      setTakes((t) => ({ ...t, [p.id]: take }));
      setBeat(-1);
      setStage("result");
    });
  }, [index, settings.clickVolume, micOffset]);
  const show = (i: number) => {
    runRef.current?.cancel();
    runRef.current = null;
    setBeat(-1);
    if (i >= PROMPTS.length) {
      setStage("finished");
      return;
    }
    setIndex(i);
    setStage("preview");
  };

  // Which beat is playing now (count-in beats first).
  useEffect(() => {
    if (stage !== "running") return;
    let raf = 0;
    const tick = () => {
      const run = runRef.current;
      if (run) {
        const b = Math.floor((audioEngine.audibleTime() - run.start) / run.secPerBeat);
        setBeat((x) => (x === b ? x : b));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [stage]);

  useEffect(() => () => runRef.current?.cancel(), []);

  const enough = last && prompt ? last.clips.length >= Math.ceil(prompt.reps / 2) : false;
  const download = async () => {
    setBusy(true);
    try {
      const list = PROMPTS.map((p) => takes[p.id]).filter((t): t is PromptTake => !!t);
      const blob = await buildClipZip({
        person: person.id,
        group: person.group,
        note: "",
        takes: list,
        micLabel: audioEngine.deviceLabel,
        micOffset,
      });
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      downloadBlob(blob, `${person.id}_clips_${stamp}.zip`.replace(/[^\w.-]+/g, "-"));
    } finally {
      setBusy(false);
    }
  };
  const saved = Object.keys(takes).length;
  const cue =
    beat >= 0 && beat < COUNT_IN
      ? COUNT_WORDS[beat]
      : beat >= COUNT_IN && prompt
        ? `${Math.min(prompt.reps, Math.floor((beat - COUNT_IN) / prompt.beats) + 1)} of ${prompt.reps}`
        : "";

  return (
    <div className="flex flex-col items-center w-full max-w-4xl mx-auto px-4 py-6 gap-5 min-h-screen">
      <div className="flex items-center gap-3 w-full">
        <Button
          variant="secondary"
          onClick={() => {
            runRef.current?.cancel();
            onBack();
          }}
        >
          ◀ Menu
        </Button>
        <div className="flex-1">
          <p className="text-sm font-bold text-slate-500">
            {person.id} · sound clips · prompt {Math.min(index + 1, PROMPTS.length)} of {PROMPTS.length} · {saved} recorded
          </p>
          <div className="mt-1 h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
            <div className="h-full bg-walsh-green transition-all" style={{ width: `${(100 * saved) / PROMPTS.length}%` }} />
          </div>
        </div>
        <Button variant="secondary" disabled={!saved || busy} onClick={download} title="Download the clips recorded so far">
          ⬇ Save clips
        </Button>
      </div>

      {stage === "intro" && (
        <Card className="w-full flex flex-col gap-3">
          <h2 className="text-2xl font-black">Sound clips</h2>
          <p className="text-lg">
            Each prompt shows what to do as music. Press Start: you'll hear a measure of clicks (“1, 2, ready, go”: don't say anything yet),
            then say, clap or sing on the notes, with the click, a few times.
          </p>
          <p className="text-slate-500">
            Count the way you normally would. Keep the room quiet and your headphones on. Don't close this tab until you've saved the clips.
          </p>
          <div>
            <Button variant="gold" onClick={() => show(0)}>
              Let's go
            </Button>
          </div>
        </Card>
      )}

      {(stage === "preview" || stage === "running" || stage === "result") && prompt && (
        <Card className="w-full flex flex-col items-center gap-4 py-6">
          <p className="text-sm font-bold uppercase tracking-widest text-slate-400">
            {prompt.kind} · {prompt.bpm} BPM
          </p>
          <p className="text-5xl md:text-6xl font-black text-center">{prompt.say}</p>
          <p className="text-lg text-center text-slate-600 dark:text-slate-300">{prompt.how}</p>
          <PromptMusic prompt={prompt} beat={stage === "running" ? beat : -1} />
          {stage === "preview" && (
            <div className="flex flex-wrap gap-3 justify-center">
              {index > 0 && (
                <Button variant="secondary" onClick={() => show(index - 1)}>
                  ◀ Back
                </Button>
              )}
              <Button variant="gold" onClick={start}>
                ▶ Start
              </Button>
              <Button variant="secondary" onClick={() => show(index + 1)} title="Leave this one out">
                Skip ▶
              </Button>
            </div>
          )}
          {stage === "running" && <p className="text-3xl font-extrabold text-amber-600 h-10">{cue}</p>}
          {stage === "result" && last && (
            <div className="flex flex-col items-center gap-3">
              <p className={`text-xl font-bold ${enough ? "text-emerald-600" : "text-rose-600"}`}>
                {enough
                  ? `✓ Got ${last.clips.length} of ${prompt.reps}`
                  : `I only heard ${last.clips.length} of ${prompt.reps}. Try that one again${prompt.kind === "clap" ? "" : ", a little louder"}.`}
              </p>
              <div className="flex flex-wrap gap-3 justify-center">
                <Button variant="secondary" onClick={start}>
                  ↺ Redo
                </Button>
                <Button variant={enough ? "primary" : "secondary"} onClick={() => show(index + 1)}>
                  {enough ? "Next ▶" : "Skip ▶"}
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {stage === "finished" && (
        <Card className="w-full flex flex-col gap-3 border-4 border-walsh-green">
          <h2 className="text-2xl font-black">🎉 All done. Thank you!</h2>
          <p>
            {saved} of {PROMPTS.length} prompts recorded, {Object.values(takes).reduce((a, t) => a + t.clips.length, 0)} clips. Save them as
            one zip:
          </p>
          <div className="flex gap-3">
            <Button variant="gold" disabled={busy} onClick={download}>
              {busy ? "Saving…" : "⬇ Save the clips"}
            </Button>
            <Button variant="secondary" onClick={() => show(0)}>
              Back to the first prompt
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
};

export default Collect;
