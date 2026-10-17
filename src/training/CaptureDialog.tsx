import React, { useState } from "react";
import { Button, Modal, Pill } from "../components/ui";
import { BundleMeta, downloadBlob } from "../debug/debugBundle";
import { TakeOutcome } from "../session/TakeRunner";
import { buildCapture, CaptureMeta, defaultCaptureName, MetronomeOut, MicKind, Performance, Setting } from "./capture";

interface Props {
  exercise: BundleMeta;
  outcome: TakeOutcome;
  onClose: () => void;
}

const KEY = "rhythm-tester-capture-meta";

type Remembered = Omit<CaptureMeta, "name" | "note">;

const DEFAULTS: Remembered = {
  studentId: "",
  setting: "home",
  mic: "built-in",
  metronome: "headphones",
  performance: "as-written",
};

const loadRemembered = (): Remembered => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
};

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map(([v, text]) => (
          <Pill key={v} selected={value === v} onClick={() => onChange(v)}>
            {text}
          </Pill>
        ))}
      </div>
    </div>
  );
}

const input =
  "w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-walsh-green";

const CaptureDialog: React.FC<Props> = ({ exercise, outcome, onClose }) => {
  const [meta, setMeta] = useState<CaptureMeta>(() => ({
    ...loadRemembered(),
    name: defaultCaptureName(exercise.id, outcome.result.activity, exercise.tempo),
    note: "",
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<CaptureMeta>) => setMeta((m) => ({ ...m, ...patch }));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { name, note, ...remembered } = meta;
      try {
        localStorage.setItem(KEY, JSON.stringify(remembered));
      } catch {
        // not important
      }
      const fileName = (name.trim() || defaultCaptureName(exercise.id, outcome.result.activity, exercise.tempo)).replace(
        /\.zip$/i,
        ""
      );
      const blob = await buildCapture(exercise, outcome, { ...meta, name: fileName, note: note.trim() });
      downloadBlob(blob, `${fileName}.zip`);
      onClose();
    } catch (err) {
      console.error(err);
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Capture this take" onClose={onClose}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">File name</span>
          <input className={input} value={meta.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">Student ID (no names)</span>
          <input className={input} value={meta.studentId} onChange={(e) => set({ studentId: e.target.value })} />
        </label>
        <Choice<Performance>
          label="How was it performed?"
          value={meta.performance}
          onChange={(performance) => set({ performance })}
          options={[
            ["as-written", "As written (no mistakes)"],
            ["with-mistakes", "With mistakes"],
            ["unsure", "Not sure"],
          ]}
        />
        <Choice<Setting>
          label="Where"
          value={meta.setting}
          onChange={(setting) => set({ setting })}
          options={[
            ["home", "Home"],
            ["practice-room", "Practice room"],
            ["band-room", "Band room"],
          ]}
        />
        <Choice<MicKind>
          label="Microphone"
          value={meta.mic}
          onChange={(mic) => set({ mic })}
          options={[
            ["built-in", "Built-in / webcam"],
            ["headset", "Headset"],
            ["external", "Other external"],
          ]}
        />
        <Choice<MetronomeOut>
          label="Metronome heard through"
          value={meta.metronome}
          onChange={(metronome) => set({ metronome })}
          options={[
            ["headphones", "Headphones"],
            ["speaker", "Speaker"],
          ]}
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-slate-600 dark:text-slate-300">Notes</span>
          <textarea
            className={input}
            rows={2}
            placeholder="e.g. rushed m.3 on purpose; noisy room"
            value={meta.note}
            onChange={(e) => set({ note: e.target.value })}
          />
        </label>
        {error && <p className="text-sm text-rose-600">Capture failed: {error}</p>}
        <div className="flex justify-end gap-3">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save capture"}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default CaptureDialog;
