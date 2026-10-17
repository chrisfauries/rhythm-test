import React, { useEffect, useMemo, useRef, useState } from "react";
import { CountResult, NoteResult, RestResult } from "../analysis/analyze";
import Staff, { StaffLayout } from "../components/Staff";
import { Button, Card } from "../components/ui";
import { downloadDebugBundle } from "../debug/debugBundle";
import { activityInfo } from "../music/activity";
import { Exercise } from "../music/book";
import { beatLength, countDisplay, countLabel, lineBeats, measureLength, placeNotes } from "../music/rhythm";
import { useClickTrack } from "../audio/useClickTrack";
import { TakeOutcome } from "../session/TakeRunner";
import { estimateLag } from "../training/capture";
import CaptureDialog from "../training/CaptureDialog";
import { TRAINING } from "../training/mode";

// Results: the line with what happened under each note and rest, as simple
// symbols rather than colors (readable for color-blind students):
//   🙌 row  👏 clap · 👇 silent clap on a rest · ━ hands held through a long note
//           ✋ hands came apart too soon · ❌ missed · 🤫 seen but not heard
//   🗣️ row  each count; 🐇 early · 🐢 late · ❌ missed or wrong
// Tap any note or rest for that beat's details and the video at that moment.

interface Props {
  exercise: Exercise;
  outcome: TakeOutcome;
  tempo: number;
  onRetry: () => void;
  onNext: (() => void) | null;
  onChooseLine: () => void;
}

/** One note or rest on the staff, with everything graded during it. */
interface Item {
  key: string;
  measure: number;
  index: number;
  pos: number;
  len: number;
  rest: boolean;
  note?: NoteResult;
  pulses: RestResult[];
  counts: CountResult[];
}

const LANE = { hands: 26, say: 64 };
const LANE_HEIGHT = 88;
const INK = "#0f172a";
const MUTED = "#94a3b8";

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const timingMark = (status: string) => (status === "early" ? "🐇" : status === "late" ? "🐢" : "");

const isProblem = (it: Item) =>
  (it.note && it.note.status !== "on-time") ||
  it.note?.hold?.status === "released" ||
  it.pulses.some((p) => p.status === "missed") ||
  it.counts.some((c) => c.status !== "correct");

const ResultsScreen: React.FC<Props> = ({ exercise, outcome, tempo, onRetry, onNext, onChooseLine }) => {
  const { result } = outcome;
  const { summary, notes, counts, rests } = result;
  const activity = activityInfo(result.activity);
  const line = exercise.line;
  const ts = line.timeSig;
  const secPerQ = result.secPerQ;
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const bundleMeta = { id: exercise.id, title: exercise.title, source: exercise.source, timeSig: exercise.timeSig, tempo };

  const items = useMemo<Item[]>(
    () =>
      placeNotes(line).map((p) => ({
        key: `${p.measure}-${p.index}`,
        measure: p.measure,
        index: p.index,
        pos: p.pos,
        len: p.len,
        rest: !!p.note.rest,
        note: notes.find((n) => n.measure === p.measure && n.index === p.index),
        pulses: rests?.filter((r) => r.measure === p.measure && r.index === p.index) ?? [],
        counts: counts?.filter((c) => c.pos >= p.pos - 1e-6 && c.pos < p.pos + p.len - 1e-6) ?? [],
      })),
    [line, notes, rests, counts]
  );
  const problems = items.filter(isProblem);
  const sel = items.find((i) => i.key === selected) ?? null;

  // ---- Video, synced to the beat grid ----------------------------------
  const rec = outcome.raw.recording;
  const t0 = rec.startTime ?? 0;
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!outcome.raw.video?.size) return;
    const url = URL.createObjectURL(outcome.raw.video);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [outcome]);
  // Video time = recording time + lag, measured from the video's own sound.
  const [lag, setLag] = useState<number | null>(null);
  useEffect(() => {
    const video = outcome.raw.video;
    if (!video?.size) return;
    let alive = true;
    const startedAt = outcome.raw.debug.video?.startedAt;
    const fallback = startedAt != null ? -(startedAt - t0) : 0;
    video
      .arrayBuffer()
      .then((buf) => new OfflineAudioContext(1, 1, rec.sampleRate).decodeAudioData(buf))
      .then((a) => alive && setLag(estimateLag(rec.data, rec.sampleRate, a.getChannelData(0), rec.sampleRate)))
      .catch(() => alive && setLag(fallback));
    return () => {
      alive = false;
    };
  }, [outcome, rec, t0]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const cursorRef = useRef<SVGLineElement>(null);
  const layoutRef = useRef<StaffLayout | null>(null);
  const stopAt = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const toVideo = (audible: number) => audible + outcome.micOffset - t0 + (lag ?? 0);
  const fromVideo = (v: number) => v - (lag ?? 0) - outcome.micOffset + t0;
  const posTime = (pos: number) => result.startTime + pos * secPerQ;

  // The metronome, played along with the video (count-in and every beat of the line).
  const [clickOn, setClickOn] = useState(true);
  const clicks = useMemo(() => {
    if (lag === null) return [];
    const { countInStart, secPerBeat, countInBeats, beatsPerMeasure } = outcome.timing;
    return Array.from({ length: countInBeats + lineBeats(line) }, (_, i) => ({
      t: countInStart + i * secPerBeat + outcome.micOffset - t0 + lag,
      accent: i % beatsPerMeasure === 0,
    }));
  }, [lag, outcome, line, t0]);
  useClickTrack(videoRef, clicks, clickOn);

  const seekTo = (pos: number, play = false, until?: number) => {
    const v = videoRef.current;
    if (!v || lag === null) return;
    v.currentTime = Math.max(0, toVideo(posTime(pos)));
    stopAt.current = until !== undefined ? toVideo(posTime(until)) : null;
    if (play) v.play();
    else v.pause();
  };

  const select = (it: Item) => {
    setSelected(it.key);
    seekTo(it.pos - 0.25);
  };

  // MediaRecorder videos have no duration until scanned; scan once so seeking works.
  const onMeta = () => {
    const v = videoRef.current;
    if (!v || Number.isFinite(v.duration)) return;
    const back = () => {
      v.removeEventListener("durationchange", back);
      v.currentTime = 0;
    };
    v.addEventListener("durationchange", back);
    v.currentTime = 1e6;
  };

  // Cursor on the staff follows the video.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const layout = layoutRef.current;
      const cursor = cursorRef.current;
      if (v && stopAt.current !== null && v.currentTime >= stopAt.current) {
        v.pause();
        stopAt.current = null;
      }
      if (v && layout && cursor && lag !== null) {
        const pos = (fromVideo(v.currentTime) - result.startTime) / secPerQ;
        const last = layout.rows[layout.rows.length - 1].lastPos;
        if (pos >= 0 && pos <= last && v.currentTime > 0) {
          const r = layout.rowOf(pos);
          const row = layout.rows[r];
          const x = layout.xOf(pos, r);
          cursor.setAttribute("x1", String(x));
          cursor.setAttribute("x2", String(x));
          cursor.setAttribute("y1", String(row.top + 10));
          cursor.setAttribute("y2", String(row.staffBottom + LANE_HEIGHT - 4));
          cursor.style.opacity = "1";
        } else cursor.style.opacity = "0";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  // ---- Words for a beat ------------------------------------------------
  const mLen = measureLength(ts);
  const beatName = (pos: number) => {
    const m = Math.floor(pos / mLen + 1e-6);
    const label = countLabel((pos - m * mLen) / beatLength(ts));
    return `measure ${m + 1}, “${label === "?" ? "–" : countDisplay(label)}”`;
  };
  const verb = activity.sing ? "Sang" : "Clapped";
  const noteLine = (n: NoteResult) =>
    n.status === "on-time"
      ? `${activity.sing ? "🎵 Sang" : "👏 Clapped"} right on time!`
      : n.status === "early"
      ? `🐇 ${verb} a little early (${Math.abs(n.offsetMs!)} ms)`
      : n.status === "late"
      ? `🐢 ${verb} a little late (${n.offsetMs} ms)`
      : n.status === "seen"
      ? "🤫 I saw your clap but couldn't hear it. Clap louder!"
      : activity.sing
      ? "❌ I didn't hear this note"
      : "❌ I didn't hear a clap here";
  const holdLine = (n: NoteResult) =>
    !n.hold
      ? null
      : n.hold.status === "unknown"
      ? "❔ I couldn't see your hands"
      : activity.sing
      ? n.hold.status === "held"
        ? "🎵 You held the note all the way"
        : "✋ Your voice stopped too soon. Hold it to the end!"
      : n.hold.status === "held"
      ? "🙌 Hands stayed together the whole note"
      : "✋ Hands came apart too soon. Keep them together and push forward!";
  const pulseLine = (p: RestResult) =>
    p.status === "pulsed"
      ? "👇 Silent clap. Nice!"
      : p.status === "missed"
      ? "❌ No silent clap. Pulse your hands down on rests (and keep them in the camera picture)."
      : "❔ I couldn't see your hands";
  const countLine = (c: CountResult) => {
    const want = `“${countDisplay(c.label)}”`;
    if (c.status === "missed") return `🗣️ I didn't hear ${want}`;
    if (c.status === "wrong") return `🗣️ You said “${c.heard ? countDisplay(c.heard) : "?"}”, it should be ${want}`;
    if (c.status === "early") return `🐇 Said ${want} a little early`;
    if (c.status === "late") return `🐢 Said ${want} a little late`;
    return `🗣️ Said ${want} right on time`;
  };

  // ---- Symbols under the staff ----------------------------------------
  const symbol = (x: number, y: number, text: string, size = 18, key?: string, opacity = 1) => (
    <text key={key} x={x} y={y} textAnchor="middle" dominantBaseline="central" fontSize={size} opacity={opacity}>
      {text}
    </text>
  );

  const overlay = (layout: StaffLayout) => {
    const at = (pos: number) => {
      const r = layout.rowOf(Math.max(0, pos));
      return { r, row: layout.rows[r], x: layout.xOf(pos, r) };
    };
    const showHands = activity.claps || activity.sing;
    return (
      <>
        {layout.rows.map((row, r) => (
          <g key={`labels-${r}`}>
            {showHands && symbol(11, row.staffBottom + LANE.hands, activity.sing ? "🎵" : "🙌", 16)}
            {counts && symbol(11, row.staffBottom + LANE.say, "🗣️", 16)}
          </g>
        ))}

        {/* Selected beat */}
        {sel &&
          (() => {
            const box = layout.notes.find((b) => b.measure === sel.measure && b.index === sel.index);
            if (!box) return null;
            const row = layout.rows[box.row];
            return (
              <rect
                x={box.x - 18}
                y={row.top + 6}
                width={36}
                height={row.staffBottom + LANE_HEIGHT - row.top - 6}
                rx={12}
                fill="rgba(255,184,28,0.15)"
                stroke={INK}
                strokeWidth={2}
                strokeDasharray="5 4"
              />
            );
          })()}

        {/* 🙌 row: claps (or sung notes), holds, silent claps */}
        {showHands &&
          items.map((it) => {
            const out: React.ReactNode[] = [];
            if (it.note) {
              const { r, row, x } = at(it.pos);
              const y = row.staffBottom + LANE.hands;
              const n = it.note;
              // Holds: a solid line through the note; ✋ where the hands came apart.
              if (n.hold && n.hold.status !== "unknown") {
                const endPos = Math.min(it.pos + n.len, row.lastPos);
                const untilPos = n.hold.until !== undefined ? (n.hold.until - result.startTime) / secPerQ : endPos;
                const lineEnd = n.hold.status === "held" ? endPos : Math.max(it.pos, Math.min(untilPos, endPos));
                out.push(
                  <line
                    key="hold"
                    x1={x + 12}
                    x2={layout.xOf(lineEnd, r) - (n.hold.status === "held" ? 6 : 12)}
                    y1={y}
                    y2={y}
                    stroke={INK}
                    strokeWidth={4}
                    strokeLinecap="round"
                  />
                );
                if (n.hold.status === "released") out.push(symbol(layout.xOf(lineEnd, r), y, "✋", 19, "apart"));
              }
              const base = n.status === "missed" ? "❌" : n.status === "seen" ? "🤫" : activity.sing ? "🎵" : "👏";
              out.push(symbol(x, y, base, n.status === "missed" ? 17 : 23, "clap"));
              const mark = timingMark(n.status);
              if (mark) out.push(symbol(x + 15, y - 12, mark, 16, "timing"));
            }
            it.pulses.forEach((p, k) => {
              const { row, x } = at(p.pos);
              const y = row.staffBottom + LANE.hands;
              out.push(
                symbol(x, y, p.status === "pulsed" ? "👇" : p.status === "missed" ? "❌" : "❔", p.status === "pulsed" ? 22 : 16, `p${k}`)
              );
            });
            return <g key={`h-${it.key}`}>{out}</g>;
          })}
        {result.extraClaps.map((e, i) => {
          const { row, x } = at(e.pos);
          const y = row.staffBottom + LANE.hands;
          return (
            <g key={`xc-${i}`}>
              {symbol(x, y, activity.sing ? "🎵" : "👏", 14, undefined, 0.45)}
              {symbol(x + 10, y - 9, "❓", 11)}
            </g>
          );
        })}

        {/* 🗣️ row: each count, with a mark only when something was off */}
        {counts?.map((c) => {
          const { row, x } = at(c.pos);
          const y = row.staffBottom + LANE.say;
          const bad = c.status === "missed" || c.status === "wrong";
          return (
            <g key={`c-${c.id}`}>
              <text
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={19}
                fontWeight={800}
                fill={bad ? MUTED : INK}
                textDecoration={bad ? "line-through" : undefined}
              >
                {countDisplay(c.label)}
              </text>
              {bad && symbol(x + 13, y - 11, "❌", 12)}
              {timingMark(c.status) && symbol(x + 15, y - 12, timingMark(c.status), 16)}
            </g>
          );
        })}
        {result.extraWords.map((w, i) => {
          const { row, x } = at(w.pos);
          return (
            <g key={`xw-${i}`}>
              <text x={x} y={row.staffBottom + LANE.say} textAnchor="middle" dominantBaseline="central" fontSize={13} fontStyle="italic" fill={MUTED}>
                {w.text}
              </text>
              {symbol(x + 10, row.staffBottom + LANE.say - 9, "❓", 10)}
            </g>
          );
        })}

        <line ref={cursorRef} stroke={INK} strokeWidth={3} strokeLinecap="round" opacity={0} />

        {/* Tap targets: every note and rest (and each beat of a long rest) */}
        {layout.notes.map((box) => {
          const it = items.find((i) => i.measure === box.measure && i.index === box.index);
          if (!it) return null;
          const row = layout.rows[box.row];
          const xs = [box.x, ...it.pulses.slice(1).map((p) => layout.xOf(p.pos, box.row))];
          return xs.map((x, k) => (
            <rect
              key={`hit-${it.key}-${k}`}
              x={x - 15}
              y={row.top + 6}
              width={30}
              height={row.staffBottom + LANE_HEIGHT - row.top - 6}
              fill="transparent"
              style={{ pointerEvents: "all", cursor: "pointer" }}
              onClick={() => select(it)}
            />
          ));
        })}
      </>
    );
  };

  // ---- Page ---------------------------------------------------------------
  const overall = summary.overall;
  const hero =
    overall >= 0.95
      ? { title: "Perfect! 🌟", tone: "from-walsh-gold to-amber-500 text-amber-950" }
      : overall >= 0.8
      ? { title: "Great job! 🎉", tone: "from-walsh-green to-emerald-600 text-white" }
      : overall >= 0.6
      ? { title: "Getting there! 💪", tone: "from-sky-500 to-indigo-600 text-white" }
      : { title: "Keep going! 🚀", tone: "from-slate-600 to-slate-800 text-white" };
  const tendencyText =
    summary.tendency === "rushing"
      ? "🐇 You tend to rush a little. Feel the beat!"
      : summary.tendency === "dragging"
      ? "🐢 You tend to drag a little. Keep up with the click!"
      : summary.tendency === "steady"
      ? "🎯 Your steady beat is solid."
      : "";

  const Stat: React.FC<{ icon: string; label: string; value: string }> = ({ icon, label, value }) => (
    <div className="flex flex-col items-center justify-center bg-slate-950 border border-slate-800/80 rounded-[1.25rem] px-4 py-2.5 min-w-[96px]">
      <span className="text-xl">{icon}</span>
      <span className="text-2xl md:text-3xl font-mono font-bold text-amber-400">{value}</span>
      <span className="text-[9px] font-bold text-amber-700 uppercase tracking-[0.15em]">{label}</span>
    </div>
  );

  const step = (dir: 1 | -1) => {
    if (!problems.length) return;
    const i = sel ? problems.findIndex((p) => p.key === sel.key) : -1;
    const next =
      i < 0
        ? dir > 0
          ? problems.find((p) => !sel || p.pos > sel.pos) ?? problems[0]
          : [...problems].reverse().find((p) => !sel || p.pos < sel.pos) ?? problems[problems.length - 1]
        : problems[(i + dir + problems.length) % problems.length];
    select(next);
  };

  const detail = (it: Item) => {
    const lines: string[] = [];
    if (it.note && (activity.claps || activity.sing)) lines.push(noteLine(it.note));
    if (it.note) {
      const h = holdLine(it.note);
      if (h) lines.push(h);
    }
    it.pulses.forEach((p) => lines.push(pulseLine(p)));
    if (it.rest && !it.pulses.length && activity.claps && rests) lines.push("👇 Rest: pulse your hands down silently");
    it.counts.forEach((c) => lines.push(countLine(c)));
    if (!it.note && !it.rest) lines.push("➰ Tied: keep holding from the note before");
    return lines;
  };

  return (
    <div className="flex flex-col items-center w-full max-w-6xl mx-auto px-4 py-6 min-h-screen gap-5">
      <div className={`w-full rounded-[2.5rem] p-6 md:p-8 bg-gradient-to-br ${hero.tone} shadow-xl flex flex-col md:flex-row items-center justify-between gap-4`}>
        <div className="text-center md:text-left">
          <h1 className="text-4xl md:text-5xl font-black tracking-tight">{hero.title}</h1>
          <p className="mt-1 font-medium opacity-90">
            {exercise.title} · {tempo} BPM
          </p>
          {tendencyText && <p className="mt-1 text-sm font-semibold opacity-90">{tendencyText}</p>}
        </div>
        <div className="flex flex-wrap justify-center gap-2 bg-white/90 dark:bg-slate-900 rounded-3xl p-2.5">
          <Stat icon="⭐" label="Overall" value={pct(summary.overall)} />
          {summary.clapScore !== null && <Stat icon={activity.sing ? "🎵" : "👏"} label={activity.sing ? "Notes" : "Claps"} value={pct(summary.clapScore)} />}
          {summary.countScore !== null && <Stat icon="🗣️" label="Counts" value={pct(summary.countScore)} />}
          {summary.holdScore !== null && <Stat icon={activity.sing ? "🎵" : "🙌"} label={activity.sing ? "Holding" : "Hands"} value={pct(summary.holdScore)} />}
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <p className="text-sm font-semibold text-slate-500">
            {problems.length ? `${problems.length} spot${problems.length === 1 ? "" : "s"} to practice. Tap a note or rest to see it.` : "No mistakes! 🎉"}
          </p>
          {problems.length > 0 && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => step(-1)}>
                ◀ Previous
              </Button>
              <Button variant="secondary" onClick={() => step(1)}>
                Next ▶
              </Button>
            </div>
          )}
        </div>
        <div className="rounded-2xl bg-white border border-slate-200 px-3 pt-2 pb-2 overflow-x-auto">
          <Staff line={line} laneHeight={LANE_HEIGHT} overlay={overlay} onLayout={(l) => (layoutRef.current = l)} />
        </div>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-3 text-sm text-slate-500">
          {activity.claps && <span>👏 clap</span>}
          {activity.sing && <span>🎵 sung note</span>}
          {activity.claps && rests && <span>👇 silent clap</span>}
          {(activity.claps || activity.sing) && <span>━ held</span>}
          {activity.claps && <span>✋ came apart</span>}
          <span>🐇 early</span>
          <span>🐢 late</span>
          <span>❌ missed</span>
          <span>❓ extra</span>
        </div>
      </Card>

      <div className={`grid w-full gap-5 ${videoUrl ? "md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" : ""}`}>
        {videoUrl && (
          <Card className="flex flex-col gap-3">
            <div className="relative bg-black rounded-2xl overflow-hidden aspect-[4/3]">
              <video
                ref={videoRef}
                src={videoUrl}
                className="absolute inset-0 w-full h-full object-contain"
                onLoadedMetadata={onMeta}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                playsInline
              />
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              <Button
                variant="secondary"
                disabled={lag === null}
                onClick={() => {
                  const v = videoRef.current;
                  if (!v) return;
                  if (!v.paused) v.pause();
                  else if (v.currentTime <= 0.05) seekTo(-beatLength(ts), true);
                  else {
                    stopAt.current = null;
                    v.play();
                  }
                }}
              >
                {playing ? "⏸ Pause" : "▶ Play my take"}
              </Button>
              <Button variant="secondary" disabled={lag === null} onClick={() => seekTo(-beatLength(ts), true)}>
                ⏮ From the start
              </Button>
              <Button variant="secondary" onClick={() => setClickOn((c) => !c)} title="Play the metronome with the video">
                {clickOn ? "🔔 Click on" : "🔕 Click off"}
              </Button>
            </div>
          </Card>
        )}

        <Card>
          {sel ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-lg font-extrabold">
                {sel.rest ? "Rest" : sel.note ? "Note" : "Tied note"} at {beatName(sel.pos)}
              </h3>
              <ul className="flex flex-col gap-2 text-lg">
                {detail(sel).map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
              {videoUrl && (
                <div>
                  <Button disabled={lag === null} onClick={() => seekTo(sel.pos - beatLength(ts), true, sel.pos + Math.max(sel.len, beatLength(ts)) + 0.5)}>
                    ▶ Watch this beat
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="h-full min-h-[160px] flex items-center justify-center text-center text-slate-400 p-6 text-lg">
              👆 Tap any note or rest to see how you did there{videoUrl ? " and watch yourself" : ""}.
            </div>
          )}
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-4 w-full mb-10">
        {TRAINING && (
          <Button onClick={() => setCapturing(true)} title="Save everything about this take for training">
            ● Capture
          </Button>
        )}
        <Button variant="gold" onClick={onRetry}>
          Try again
        </Button>
        {onNext && <Button onClick={onNext}>Next line</Button>}
        <Button variant="secondary" onClick={onChooseLine}>
          Choose a line
        </Button>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await downloadDebugBundle(bundleMeta, outcome);
          } finally {
            setSaving(false);
          }
        }}
        className="-mt-6 mb-8 text-xs text-slate-400 underline hover:text-slate-600 disabled:opacity-50"
      >
        {saving ? "Preparing download…" : `Download debug bundle (audio${outcome.raw.video ? ", video" : ""} and diagnostics)`}
      </button>
      {capturing && <CaptureDialog exercise={bundleMeta} outcome={outcome} onClose={() => setCapturing(false)} />}
    </div>
  );
};

export default ResultsScreen;
