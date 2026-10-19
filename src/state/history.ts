import { useCallback, useState } from "react";

export interface TakeRecord {
  id: string;
  date: string;
  student: string;
  exerciseId: string;
  title: string;
  bpm: number;
  overall: number;
  clap: number | null;
  count: number | null;
  hold: number | null;
  meanOffsetMs: number | null;
  tendency: string | null;
}

const KEY = "rhythm-tester-history-v1";
const MAX = 2000;

const load = (): TakeRecord[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
};

const save = (records: TakeRecord[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(records.slice(-MAX)));
  } catch {
    // ignore
  }
};

export const useHistory = () => {
  const [records, setRecords] = useState<TakeRecord[]>(load);
  const add = useCallback((r: TakeRecord) => {
    setRecords((prev) => {
      const next = [...prev, r];
      save(next);
      return next;
    });
  }, []);
  const clear = useCallback(() => {
    save([]);
    setRecords([]);
  }, []);
  return { records, add, clear };
};

const pct = (x: number | null) => (x === null ? "" : Math.round(x * 100).toString());

export const toCsv = (records: TakeRecord[]) => {
  const header = ["Date", "Student", "Line", "Tempo", "Overall %", "Claps %", "Counts %", "Holds %", "Avg offset (ms)", "Tendency"];
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = records.map((r) =>
    [
      new Date(r.date).toLocaleString(),
      r.student,
      r.title,
      String(r.bpm),
      pct(r.overall),
      pct(r.clap),
      pct(r.count),
      pct(r.hold),
      r.meanOffsetMs === null ? "" : String(r.meanOffsetMs),
      r.tendency ?? "",
    ].map(esc),
  );
  return [header, ...rows].map((r) => r.join(",")).join("\n");
};

export const downloadCsv = (records: TakeRecord[]) => {
  const blob = new Blob([toCsv(records)], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rhythm-results-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
};
