import React, { useMemo, useState } from "react";
import { Button, Modal } from "../components/ui";
import { downloadCsv, TakeRecord } from "../state/history";

interface Props {
  records: TakeRecord[];
  onClear: () => void;
  onClose: () => void;
}

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const HistoryPanel: React.FC<Props> = ({ records, onClear, onClose }) => {
  const [student, setStudent] = useState("");
  const students = useMemo(() => Array.from(new Set(records.map((r) => r.student || "(no name)"))).sort(), [records]);
  const shown = useMemo(
    () =>
      records
        .filter((r) => !student || (r.student || "(no name)") === student)
        .slice()
        .reverse(),
    [records, student]
  );

  return (
    <Modal title="Results" onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={student}
          onChange={(e) => setStudent(e.target.value)}
          className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 px-3 py-2 text-sm"
        >
          <option value="">All students</option>
          {students.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <span className="text-sm text-slate-500">{shown.length} takes</span>
        <div className="flex-1" />
        <Button onClick={() => downloadCsv(shown)} disabled={!shown.length}>
          Export CSV
        </Button>
        <Button
          variant="secondary"
          onClick={() => window.confirm("Delete all saved results on this computer?") && onClear()}
          disabled={!records.length}
        >
          Clear
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-slate-500 text-center py-10">No results yet. Results are saved on this computer after every take.</p>
      ) : (
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wider text-slate-400 sticky top-0 bg-white dark:bg-slate-900">
              <tr>
                <th className="py-2 pr-3">Date</th>
                <th className="pr-3">Student</th>
                <th className="pr-3">Line</th>
                <th className="pr-3 text-right">BPM</th>
                <th className="pr-3 text-right">Overall</th>
                <th className="pr-3 text-right">Claps</th>
                <th className="pr-3 text-right">Counts</th>
                <th className="pr-3 text-right">Holds</th>
                <th>Timing</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-slate-500">{new Date(r.date).toLocaleString()}</td>
                  <td className="pr-3 font-semibold">{r.student || "–"}</td>
                  <td className="pr-3">{r.title}</td>
                  <td className="pr-3 text-right tabular-nums">{r.bpm}</td>
                  <td className="pr-3 text-right tabular-nums font-bold">{pct(r.overall)}</td>
                  <td className="pr-3 text-right tabular-nums">{pct(r.clap)}</td>
                  <td className="pr-3 text-right tabular-nums">{pct(r.count)}</td>
                  <td className="pr-3 text-right tabular-nums">{pct(r.hold)}</td>
                  <td className="text-slate-500">
                    {r.tendency ?? ""}
                    {r.meanOffsetMs !== null ? ` (${r.meanOffsetMs > 0 ? "+" : ""}${r.meanOffsetMs} ms)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
};

export default HistoryPanel;
