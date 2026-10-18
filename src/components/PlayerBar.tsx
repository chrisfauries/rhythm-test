import React, { RefObject, useEffect, useRef } from "react";

// Video player controls under a take: play/pause, back to the start, a seek
// bar to watch from any point, the metronome on/off, speed, and a download.
// The seek bar and time follow the video directly (no re-render per frame).

interface Props {
  videoRef: RefObject<HTMLVideoElement | null>;
  playing: boolean;
  disabled?: boolean;
  onPlayPause: () => void;
  onRestart: () => void;
  /** The student dragged the seek bar to this video time. */
  onScrub: (t: number) => void;
  clickOn: boolean;
  onToggleClick: () => void;
  speed: number;
  onSpeed: (s: number) => void;
  onDownload: () => void;
  /** Download progress 0..1 while making the file, else null. */
  downloading: number | null;
}

const SPEEDS: [number, string][] = [
  [1, "1×"],
  [0.75, "¾×"],
  [0.5, "½×"],
];

const clock = (t: number) => {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const IconButton: React.FC<{ title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; wide?: boolean }> = ({
  title,
  onClick,
  disabled,
  children,
  wide,
}) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    disabled={disabled}
    onClick={onClick}
    className={`h-10 ${wide ? "px-3" : "w-10"} shrink-0 rounded-full flex items-center justify-center gap-1.5 text-white font-bold text-sm hover:bg-white/15 active:bg-white/25 disabled:opacity-40 disabled:hover:bg-transparent`}
  >
    {children}
  </button>
);

const PlayerBar: React.FC<Props> = ({
  videoRef,
  playing,
  disabled,
  onPlayPause,
  onRestart,
  onScrub,
  clickOn,
  onToggleClick,
  speed,
  onSpeed,
  onDownload,
  downloading,
}) => {
  const seekRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const seek = seekRef.current;
      if (v && seek) {
        const d = Number.isFinite(v.duration) ? v.duration : 0;
        if (seek.max !== String(d)) seek.max = String(d);
        if (!dragging.current) seek.value = String(v.currentTime);
        const pct = d ? (Number(seek.value) / d) * 100 : 0;
        seek.style.background = `linear-gradient(to right, #FFB81C ${pct}%, rgba(255,255,255,0.25) ${pct}%)`;
        if (timeRef.current) timeRef.current.textContent = `${clock(Number(seek.value))} / ${clock(d)}`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef]);

  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-slate-900 px-3 pt-3 pb-1.5 text-white">
      <input
        ref={seekRef}
        type="range"
        min={0}
        step={0.01}
        defaultValue={0}
        disabled={disabled}
        aria-label="Seek"
        className="player-seek w-full h-1.5 rounded-full appearance-none cursor-pointer accent-walsh-gold disabled:cursor-default"
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onInput={(e) => onScrub(Number((e.target as HTMLInputElement).value))}
      />
      <div className="flex items-center gap-1">
        <IconButton title={playing ? "Pause" : "Play"} onClick={onPlayPause} disabled={disabled}>
          <span className="text-lg leading-none">{playing ? "⏸" : "▶"}</span>
        </IconButton>
        <IconButton title="Back to the start" onClick={onRestart} disabled={disabled}>
          <span className="text-lg leading-none">⏮</span>
        </IconButton>
        <span ref={timeRef} className="ml-1 text-xs font-mono tabular-nums text-slate-300 whitespace-nowrap">
          0:00 / 0:00
        </span>
        <div className="flex-1" />
        <IconButton title={clickOn ? "Turn the click off" : "Turn the click on"} onClick={onToggleClick}>
          <span className="text-lg leading-none">{clickOn ? "🔔" : "🔕"}</span>
        </IconButton>
        <select
          value={speed}
          onChange={(e) => onSpeed(Number(e.target.value))}
          title="Playback speed"
          aria-label="Playback speed"
          className="h-8 rounded-full bg-white/10 px-2 text-sm font-bold text-white hover:bg-white/20 cursor-pointer"
        >
          {SPEEDS.map(([s, label]) => (
            <option key={s} value={s} className="text-slate-900">
              {label}
            </option>
          ))}
        </select>
        <IconButton title="Download the video with the click" onClick={onDownload} disabled={disabled || downloading !== null} wide>
          {downloading === null ? (
            <>
              <span className="text-lg leading-none">⬇</span>
              <span className="hidden sm:inline">Download</span>
            </>
          ) : (
            <span className="tabular-nums">{Math.round(downloading * 100)}%</span>
          )}
        </IconButton>
      </div>
    </div>
  );
};

export default PlayerBar;
