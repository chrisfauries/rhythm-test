import React, { useMemo, useState } from "react";
import logo from "../static/walshBandLogo.png";
import Staff from "../components/Staff";
import { Button, Card, Icon, Pill, SectionLabel, StatusPill, StatusTone } from "../components/ui";
import { LevelMeter } from "../components/LiveWidgets";
import { ACTIVITIES, activityInfo } from "../music/activity";
import { customExercise, Exercise, PAGES } from "../music/book";
import { RhythmParseError } from "../music/rhythm";
import { ModelStatus } from "../speech/voskModel";
import { Devices } from "../state/devices";
import { Settings } from "../state/settings";

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  devices: Devices;
  exercise: Exercise | null;
  onSelectExercise: (e: Exercise) => void;
  onStart: () => void;
  onCalibrate: () => void;
  onOpenSettings: () => void;
  onOpenHistory: () => void;
}

const shortPageLabel = (id: string) => (id === "CA" ? "✓A" : id === "CB" ? "✓B" : id === "CC" ? "✓C" : id === "final" ? "🏁" : id);

const SetupScreen: React.FC<Props> = ({
  settings,
  update,
  devices,
  exercise,
  onSelectExercise,
  onStart,
  onCalibrate,
  onOpenSettings,
  onOpenHistory,
}) => {
  const [customMode, setCustomMode] = useState(exercise?.id === "custom");
  const [customSource, setCustomSource] = useState(exercise?.id === "custom" ? exercise.source : "q q 8 8 q | h q q");
  const [customTs, setCustomTs] = useState(exercise?.id === "custom" ? exercise.timeSig : "4/4");
  const [customError, setCustomError] = useState<string | null>(null);

  const page = useMemo(
    () => (exercise && !customMode ? PAGES.find((p) => p.id === exercise.pageId) ?? null : null),
    [exercise, customMode]
  );

  const applyCustom = (source: string, ts: string) => {
    setCustomSource(source);
    setCustomTs(ts);
    try {
      onSelectExercise(customExercise(source, ts));
      setCustomError(null);
    } catch (err) {
      setCustomError(err instanceof RhythmParseError || err instanceof Error ? err.message : String(err));
    }
  };

  const micTone: StatusTone =
    devices.mic === "on" ? "ok" : devices.mic === "error" ? "error" : devices.mic === "starting" ? "busy" : "idle";
  const camTone: StatusTone = !settings.useCamera
    ? "idle"
    : devices.camera === "on"
    ? "ok"
    : devices.camera === "error"
    ? "error"
    : devices.camera === "starting"
    ? "busy"
    : "idle";
  const ms = devices.model.status;
  const counting = activityInfo(settings.activity).countMode !== null;
  const modelTone: StatusTone =
    ms === ModelStatus.READY
    ? "ok"
    : ms === ModelStatus.ERROR
    ? "error"
    : "busy";

  const speechReady = !counting || ms === ModelStatus.READY || ms === ModelStatus.ERROR;
  const ready = devices.mic === "on" && speechReady && !!exercise;
  const calibrated = settings.micOffset !== null;

  return (
    <div className="relative flex flex-col items-center w-full max-w-5xl mx-auto px-4 py-8 md:py-10 min-h-screen gap-4">
      {/* Ambient color orbs, as in the flash-cards app */}
      <div className="absolute inset-0 overflow-hidden -z-10 pointer-events-none">
        <div className="absolute top-10 left-10 md:left-1/4 w-[300px] h-[300px] bg-walsh-green/10 dark:bg-walsh-green/20 rounded-full filter blur-[80px]" />
        <div className="absolute top-10 right-10 md:right-1/4 w-[300px] h-[300px] bg-walsh-gold/10 rounded-full filter blur-[80px]" />
      </div>

      <header className="relative flex flex-col items-center text-center w-full mb-2">
        <div className="absolute right-0 top-0 flex gap-2">
          <button
            type="button"
            onClick={onOpenHistory}
            title="Results history"
            className="w-10 h-10 flex items-center justify-center rounded-full bg-white/80 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-walsh-green"
          >
            {Icon.chart}
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            title="Settings"
            className="w-10 h-10 flex items-center justify-center rounded-full bg-white/80 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-walsh-green"
          >
            {Icon.gear}
          </button>
        </div>
        <div className="flex items-center justify-center w-20 h-20 rounded-full bg-gradient-to-br from-walsh-green to-emerald-900 shadow-[0_15px_40px_rgba(0,99,65,0.4)] border-2 border-white/20">
          <img src={logo} alt="Walsh Band" className="w-12 h-12 object-contain drop-shadow-md" />
        </div>
        <h1 className="mt-4 text-4xl md:text-5xl font-black tracking-tight bg-gradient-to-r from-walsh-green to-walsh-gold bg-clip-text text-transparent">
          Rhythm Check
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Clap the rhythm. Count out loud. See how you did.</p>
      </header>

      <Card>
        <SectionLabel>Student</SectionLabel>
        <input
          value={settings.studentName}
          onChange={(e) => update({ studentName: e.target.value })}
          placeholder="Your name"
          className="block mx-auto w-full max-w-sm text-center text-lg font-semibold rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-5 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </Card>

      <Card>
        <SectionLabel>Rhythm Reading</SectionLabel>
        <div className="flex flex-wrap justify-center gap-2 max-w-4xl mx-auto">
          {PAGES.map((p) => (
            <Pill
              key={p.id}
              round
              selected={!customMode && page?.id === p.id}
              title={p.title + (p.subtitle ? ` (${p.subtitle})` : "")}
              onClick={() => {
                setCustomMode(false);
                const sameLabel = p.exercises.find((e) => e.label === exercise?.label);
                onSelectExercise(sameLabel ?? p.exercises[0]);
              }}
            >
              {shortPageLabel(p.id)}
            </Pill>
          ))}
          <Pill
            selected={customMode}
            onClick={() => {
              setCustomMode(true);
              applyCustom(customSource, customTs);
            }}
            title="Type your own rhythm"
          >
            Custom
          </Pill>
        </div>

        {page && (
          <>
            <SectionLabel className="mt-6">
              {page.title}
              {page.subtitle ? ` · ${page.subtitle}` : ""}
            </SectionLabel>
            <div className="flex flex-wrap justify-center gap-2.5">
              {page.exercises.map((e) => (
                <Pill key={e.id} round selected={exercise?.id === e.id} onClick={() => onSelectExercise(e)}>
                  {e.label}
                </Pill>
              ))}
            </div>
          </>
        )}

        {customMode && (
          <div className="mt-6 flex flex-col gap-2 max-w-3xl mx-auto">
            <div className="flex gap-2">
              <select
                value={customTs}
                onChange={(e) => applyCustom(customSource, e.target.value)}
                className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 font-semibold"
              >
                {["2/4", "3/4", "4/4", "5/4", "6/4", "7/4", "3/8", "5/8", "6/8", "7/8", "9/8", "12/8"].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <input
                value={customSource}
                onChange={(e) => applyCustom(e.target.value, customTs)}
                spellCheck={false}
                className="flex-1 font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2.5 outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <p className={`text-xs ${customError ? "text-rose-600" : "text-slate-500"}`}>
              {customError ??
                "w h q 8 16 = notes · add r for rests (qr), . for dots (q.), ~ to tie (h~) · mr = full-measure rest · 3( 8 8 8 ) = triplet · | between measures"}
            </p>
          </div>
        )}

        {exercise && (
          <div className="mt-6 rounded-2xl bg-white border border-slate-200 px-3 pt-2 shadow-inner">
            <Staff line={exercise.line} />
          </div>
        )}

        <div className="mt-6 flex flex-col items-center gap-2">
          <SectionLabel className="mb-0">Tempo</SectionLabel>
          <div className="flex items-center gap-3 w-full max-w-md">
            <button
              type="button"
              className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 font-bold"
              onClick={() => update({ tempo: Math.max(40, settings.tempo - 4) })}
            >
              −
            </button>
            <input
              type="range"
              min={40}
              max={160}
              value={settings.tempo}
              onChange={(e) => update({ tempo: parseInt(e.target.value, 10) })}
              className="flex-1 accent-walsh-green"
            />
            <button
              type="button"
              className="w-9 h-9 rounded-full bg-slate-100 dark:bg-slate-800 font-bold"
              onClick={() => update({ tempo: Math.min(160, settings.tempo + 4) })}
            >
              +
            </button>
            <span className="w-24 text-right font-mono font-bold text-2xl text-walsh-green dark:text-emerald-400">
              {settings.tempo}
              <span className="text-xs text-slate-400 ml-1">BPM</span>
            </span>
          </div>
          <div className="flex flex-wrap justify-center gap-2 mt-2">
            {ACTIVITIES.map((a) => (
              <Pill key={a.id} selected={settings.activity === a.id} onClick={() => update({ activity: a.id })} title={a.hint}>
                {a.label}
              </Pill>
            ))}
          </div>
          <p className="text-xs text-slate-500 text-center max-w-xl mx-auto mt-1">{activityInfo(settings.activity).hint}</p>
        </div>
      </Card>

      <Card>
        <div className="flex flex-col md:flex-row gap-3">
          <StatusPill label="Microphone" tone={micTone} icon={Icon.mic}>
            {devices.mic === "on" ? (
              <span className="flex items-center gap-2 w-40">
                <LevelMeter />
              </span>
            ) : devices.micError ? (
              devices.micError
            ) : devices.mic === "starting" ? (
              "Starting..."
            ) : (
              "Not enabled"
            )}
          </StatusPill>
          <StatusPill label="Voice Engine" tone={modelTone} icon={Icon.voice}>
            {ms === ModelStatus.DOWNLOADING
              ? `Downloading ${devices.model.progress}%`
              : ms === ModelStatus.ERROR
              ? devices.model.error ?? "Error"
              : ms}
          </StatusPill>
          <StatusPill label="Camera" tone={camTone} icon={Icon.camera}>
            {!settings.useCamera ? "Off" : devices.cameraError ?? (devices.camera === "on" ? "Tracking hands" : devices.camera === "starting" ? "Starting..." : "Not enabled")}
          </StatusPill>
        </div>
        {ms === ModelStatus.DOWNLOADING && (
          <div className="w-full mt-3 bg-slate-100 rounded-full h-2 overflow-hidden dark:bg-slate-700">
            <div className="bg-walsh-green h-full rounded-full transition-all" style={{ width: `${devices.model.progress}%` }} />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3 mt-4">
          {devices.mic !== "on" && (
            <Button onClick={devices.enable} disabled={devices.mic === "starting"}>
              Enable microphone{settings.useCamera ? " & camera" : ""}
            </Button>
          )}
          {devices.mic === "on" && (
            <Button variant={calibrated ? "secondary" : "gold"} onClick={onCalibrate}>
              {Icon.target}
              {calibrated ? "Re-calibrate" : "Calibrate this computer"}
            </Button>
          )}
        </div>
        {devices.mic === "on" && !calibrated && (
          <p className="text-center text-xs text-slate-500 mt-2">
            Calibrate once per computer so timing is measured accurately (takes 20 seconds).
          </p>
        )}
      </Card>

      <div className="flex items-center justify-center py-6">
        <button
          onClick={onStart}
          disabled={!ready}
          title={ready ? "Start" : "Enable the microphone and choose a line first"}
          className={`group relative flex flex-col items-center justify-center w-44 h-44 md:w-52 md:h-52 rounded-full border-none transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] outline-none ${
            ready
              ? "bg-gradient-to-br from-walsh-green to-emerald-600 text-white shadow-[0_0_60px_rgba(0,99,65,0.4)] hover:from-walsh-gold hover:to-amber-500 hover:shadow-[0_0_80px_rgba(255,184,28,0.5)] hover:scale-105 active:scale-95"
              : "bg-white/40 backdrop-blur-md border-4 border-dashed border-slate-300 text-slate-400 dark:bg-slate-800/40 dark:border-slate-700 cursor-not-allowed"
          }`}
        >
          <svg className="w-20 h-20 ml-3" fill="currentColor" viewBox="0 0 24 24">
            <path d="M8 5v14l11-7z" />
          </svg>
          {exercise && <span className="text-xs font-bold uppercase tracking-widest mt-1 opacity-80">{exercise.id === "custom" ? "Custom" : `#${shortPageLabel(exercise.pageId)} · ${exercise.label}`}</span>}
        </button>
      </div>
    </div>
  );
};

export default SetupScreen;
