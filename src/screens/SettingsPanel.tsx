import React, { useEffect, useState } from "react";
import { audioEngine, listMicrophones } from "../audio/AudioEngine";
import { CameraPreview } from "../components/LiveWidgets";
import { Modal, Pill } from "../components/ui";
import { forgetDelays, learnedMicOffset, MIN_TAKES } from "../state/latency";
import { DEFAULT_SETTINGS, Settings } from "../state/settings";
import { openPage, SAVED_TOOLS, saveTools, TOOLS, URL_OVERRIDES } from "../state/tools";
import { DEFAULT_HAND_TUNING, handTracker } from "../video/HandTracker";

interface Props {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

const Row: React.FC<React.PropsWithChildren<{ label: string; hint?: string }>> = ({ label, hint, children }) => (
  <div className="flex flex-col gap-1.5 py-3 border-b border-slate-100 dark:border-slate-800 last:border-0">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-semibold">{label}</span>
      <div className="flex flex-wrap gap-2 items-center">{children}</div>
    </div>
    {hint && <p className="text-xs text-slate-500">{hint}</p>}
  </div>
);

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void }> = ({ on, onChange }) => (
  <>
    <Pill selected={on} onClick={() => onChange(true)}>
      On
    </Pill>
    <Pill selected={!on} onClick={() => onChange(false)}>
      Off
    </Pill>
  </>
);

const fmtMs = (s: number | null) => (s === null ? "default" : `${Math.round(s * 1000)} ms`);

const SettingsPanel: React.FC<Props> = ({ settings, update, onClose }) => {
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [learned, setLearned] = useState(() => learnedMicOffset(audioEngine.deviceLabel));
  useEffect(() => {
    listMicrophones()
      .then(setMics)
      .catch(() => setMics([]));
  }, []);

  const t = settings.handTuning;

  return (
    <Modal title="Settings" onClose={onClose} wide>
      <div className="grid md:grid-cols-2 gap-x-8">
        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mt-2">Grading</h3>
          <Row label="Timing strictness" hint="How close to the beat counts as on time: lenient ±100 ms, normal ±70 ms, strict ±45 ms.">
            {(["lenient", "normal", "strict"] as const).map((s) => (
              <Pill key={s} selected={settings.strictness === s} onClick={() => update({ strictness: s })}>
                {s[0].toUpperCase() + s.slice(1)}
              </Pill>
            ))}
          </Row>

          <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mt-5">Metronome</h3>
          <Row label="Count-in">
            {([1, 2] as const).map((n) => (
              <Pill key={n} selected={settings.countInMeasures === n} onClick={() => update({ countInMeasures: n })}>
                {n} measure{n > 1 ? "s" : ""}
              </Pill>
            ))}
          </Row>
          <Row label="Click while performing" hint="Turn off to test whether students can keep a steady beat on their own.">
            <Toggle on={settings.metronomeDuringLine} onChange={(v) => update({ metronomeDuringLine: v })} />
          </Row>
          <Row label="Click volume">
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={settings.clickVolume}
              onChange={(e) => update({ clickVolume: parseFloat(e.target.value) })}
              className="w-40 accent-walsh-green"
            />
          </Row>

          <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mt-5">Microphone</h3>
          <Row label="Input device">
            <select
              value={settings.micDeviceId}
              onChange={(e) => update({ micDeviceId: e.target.value })}
              className="max-w-[16rem] rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
            >
              <option value="">System default</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || "Microphone"}
                </option>
              ))}
            </select>
          </Row>
          <Row
            label="Clap sensitivity"
            hint="Raise it if soft claps are missed; lower it if talking or noise is counted as claps. On Windows, also turn off “Audio enhancements” for the mic."
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <Pill key={n} round selected={settings.clapSensitivity === n} onClick={() => update({ clapSensitivity: n })}>
                {n}
              </Pill>
            ))}
          </Row>
          <Row
            label="Timing"
            hint="The delays on this computer. Without calibration the app learns them from your takes (and measures the camera's on every take); calibration is only needed for Bluetooth or unusual setups."
          >
            <span className="text-xs font-mono text-slate-500">
              {settings.micOffset !== null
                ? `calibrated: claps ${fmtMs(settings.micOffset)} · counts ${fmtMs(settings.speechOffset)} · camera ${fmtMs(settings.videoOffset)}`
                : learned.offset !== null
                  ? `learned from ${learned.takes} takes: ${fmtMs(learned.offset)}`
                  : `learning (${learned.takes} of ${MIN_TAKES} takes)`}
            </span>
            <Pill
              onClick={() => {
                update({ micOffset: null, speechOffset: null, videoOffset: null, clapBias: null });
                forgetDelays();
                setLearned(learnedMicOffset(audioEngine.deviceLabel));
              }}
            >
              Reset
            </Pill>
          </Row>
        </div>

        <div>
          <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mt-2">Camera</h3>
          <Row label="Use camera" hint="Checks that hands stay together on long notes, and catches claps too soft to hear.">
            <Toggle on={settings.useCamera} onChange={(v) => update({ useCamera: v })} />
          </Row>
          <Row label="Hand model" hint="Lite is faster on Chromebooks; Full is more accurate.">
            <Pill selected={settings.liteHandModel} onClick={() => update({ liteHandModel: true })}>
              Lite
            </Pill>
            <Pill selected={!settings.liteHandModel} onClick={() => update({ liteHandModel: false })}>
              Full
            </Pill>
          </Row>
          {settings.useCamera && handTracker.running && (
            <div className="py-3">
              <p className="font-semibold mb-1">Tune hand detection</p>
              <p className="text-xs text-slate-500 mb-2">
                Clap and hold your hands together, then pull them apart. The “gap” is the distance between palms in hand-lengths. Set
                “together” just above the gap you see while holding, and “apart” comfortably below the gap when your hands are open.
              </p>
              <CameraPreview showDistance />
              <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 mt-3 text-sm">
                <span>Together below</span>
                <input
                  type="range"
                  min={0.3}
                  max={2}
                  step={0.05}
                  value={t.togetherBelow}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    update({
                      handTuning: {
                        togetherBelow: v,
                        apartAbove: Math.max(t.apartAbove, v + 0.1),
                      },
                    });
                  }}
                  className="accent-walsh-gold"
                />
                <span className="font-mono w-10">{t.togetherBelow.toFixed(2)}</span>
                <span>Apart above</span>
                <input
                  type="range"
                  min={0.4}
                  max={3}
                  step={0.05}
                  value={t.apartAbove}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    update({
                      handTuning: {
                        apartAbove: v,
                        togetherBelow: Math.min(t.togetherBelow, v - 0.1),
                      },
                    });
                  }}
                  className="accent-walsh-green"
                />
                <span className="font-mono w-10">{t.apartAbove.toFixed(2)}</span>
              </div>
              <div className="mt-2">
                <Pill onClick={() => update({ handTuning: DEFAULT_HAND_TUNING })}>Reset to defaults</Pill>
              </div>
            </div>
          )}

          <h3 className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mt-5">Tools</h3>
          <Row
            label="Grading by"
            hint={`The audio model listens to the whole take. Rules is the older clap detector, voicing rules and speech recognition.${
              URL_OVERRIDES.grader ? " The page's address (?model=) is overriding this right now." : ""
            } Changing it reloads the page.`}
          >
            <Pill selected={TOOLS.grader === "model"} onClick={() => saveTools({ grader: "model" })}>
              Audio model
            </Pill>
            <Pill
              selected={TOOLS.grader === "rules" && !TOOLS.countModel}
              onClick={() => saveTools({ grader: "rules", countModel: false })}
            >
              Rules
            </Pill>
            <Pill selected={TOOLS.grader === "rules" && TOOLS.countModel} onClick={() => saveTools({ grader: "rules", countModel: true })}>
              Rules + count model
            </Pill>
          </Row>
          <Row
            label="Training mode"
            hint={`Adds a “Capture” button after each take that saves everything about it as a zip.${
              URL_OVERRIDES.training && !SAVED_TOOLS.training ? " On right now because of ?training in the address." : ""
            } Changing it reloads the page.`}
          >
            <Toggle on={TOOLS.training} onChange={(v) => saveTools({ training: v })} />
          </Row>
          <Row
            label="Other pages"
            hint="Open in a new tab. Labeler: mark what really happened in a capture. Replay: open a capture or debug zip and see its results, re-graded. Collect: a guided session recording one person's takes and sound clips for training."
          >
            <Pill onClick={() => openPage("label")}>Labeler</Pill>
            <Pill onClick={() => openPage("results")}>Replay a take</Pill>
            <Pill onClick={() => openPage("collect")}>Collect a person</Pill>
          </Row>

          <div className="mt-6">
            <Pill
              onClick={() => {
                if (window.confirm("Reset all settings (including calibration) to defaults?")) {
                  update({
                    ...DEFAULT_SETTINGS,
                    studentName: settings.studentName,
                  });
                }
              }}
            >
              Reset all settings
            </Pill>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default SettingsPanel;
