import React, { useState } from "react";
import { analyzeTake } from "../analysis/analyze";
import { Recording } from "../audio/Recording";
import { sungOnsets, voiceFrames, voicedSegments, voiceOnsetNear, voiceRuns } from "../audio/voice";
import { Card } from "../components/ui";
import { json, parseWav, readZip } from "../labeler/files";
import { loadAudioModel, modelGraderInput } from "../ml/audioModel";
import { USE_AUDIO_MODEL } from "../ml/flags";
import { activityInfo, activityOfSettings } from "../music/activity";
import { customExercise, Exercise, findExercise } from "../music/book";
import ResultsScreen from "../screens/ResultsScreen";
import { TakeOutcome } from "../session/TakeRunner";

// Replay (?results): open a capture or debug zip and see its results screen,
// re-graded with the current code from what the sensors recorded. Useful for
// reviewing old takes and for checking grading changes against real takes.
// The audio model listens again unless ?model=rules, which re-grades what the
// take's own detectors recorded.

const load = async (file: File): Promise<{ exercise: Exercise; outcome: TakeOutcome }> => {
  const files = await readZip(file);
  const diag = json(files.get("diagnostics.json"));
  if (!diag || !files.get("audio.wav")) throw new Error("This zip has no diagnostics.json / audio.wav");
  const { data, sampleRate } = parseWav(files.get("audio.wav")!);
  const t0: number = diag.wavStartCtx;
  const recording = new Recording(sampleRate, data.length / sampleRate + 1);
  recording.append(data, t0);
  const exercise = findExercise(diag.exercise.id)?.exercise ?? customExercise(diag.exercise.source, diag.exercise.timeSig);
  const activity = activityOfSettings(diag.settings);
  const info = activityInfo(activity);
  const speech: number = diag.offsets.speech;
  const vf = voiceFrames(data, sampleRate, t0);
  const runs = voiceRuns(vf);
  const recorded = diag.grader.input;
  const model = USE_AUDIO_MODEL ? await loadAudioModel() : null;
  const heard = model
    ? modelGraderInput(model, data, sampleRate, t0, {
        mic: diag.offsets.mic,
        speech,
      }).input
    : null;
  const input = heard ? { ...recorded, claps: heard.claps, words: heard.words } : recorded;
  const result = analyzeTake({
    line: exercise.line,
    bpm: diag.exercise.tempo,
    startTime: diag.timing.lineStart,
    activity,
    strictness: diag.settings.strictness ?? "normal",
    claps: input.claps,
    words: info.countMode ? input.words : null,
    frames: input.frames,
    // Counts hidden under claps: only without the audio model (see TakeRunner).
    voiceOnsetNear:
      info.claps && !heard
        ? (t) => {
            const o = voiceOnsetNear(vf, t + speech, runs);
            return o === null ? null : o - speech;
          }
        : undefined,
    sungOnsets: !info.sing ? undefined : heard ? heard.sungOnsets : sungOnsets(vf, voicedSegments(vf)).map((t) => t - speech),
    voicedSpans:
      !info.sing && !info.countMode
        ? undefined
        : heard
          ? heard.voicedSpans
          : runs.map((r): [number, number] => [r.start - speech, r.end - speech]),
  });
  const videoName = Array.from(files.keys()).find((n) => n.startsWith("camera."));
  const video = videoName ? new Blob([files.get(videoName)! as BlobPart], { type: "video/webm" }) : null;
  const outcome = {
    timing: diag.timing,
    result,
    snapshots: [],
    raw: {
      candidates: [],
      words: [],
      frames: [],
      recording,
      video,
      debug: { video: diag.video, settings: diag.settings },
    },
    frames: input.frames,
    usedSpeech: !!input.words,
    usedCamera: !!input.frames,
    micOffset: diag.offsets.mic,
  } as unknown as TakeOutcome;
  return { exercise, outcome };
};

const Replay: React.FC = () => {
  const [take, setTake] = useState<{
    exercise: Exercise;
    outcome: TakeOutcome;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      setTake(await load(f));
    } catch (err) {
      console.error(err);
      setError(String(err));
    }
  };
  if (take) {
    return (
      <ResultsScreen
        exercise={take.exercise}
        outcome={take.outcome}
        tempo={take.outcome.raw.debug.settings?.tempo ?? 0}
        onRetry={() => setTake(null)}
        onNext={null}
        onChooseLine={() => setTake(null)}
      />
    );
  }
  return (
    <div
      className="max-w-xl mx-auto p-8"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        open(e.dataTransfer.files[0]);
      }}
    >
      <Card className="flex flex-col items-center gap-4 py-12 text-center">
        <h1 className="text-2xl font-black text-walsh-green">Replay a take</h1>
        <p className="text-slate-500">Drop a capture or debug zip here to see its results, graded with the current version of the app.</p>
        <label className="cursor-pointer rounded-full bg-slate-100 px-5 py-2 font-bold hover:bg-slate-200">
          Open zip…
          <input type="file" accept=".zip" className="hidden" onChange={(e) => open(e.target.files?.[0])} />
        </label>
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </Card>
    </div>
  );
};

export default Replay;
