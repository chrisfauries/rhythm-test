import React, { useEffect, useRef, useState } from "react";
import { audioEngine } from "../audio/AudioEngine";
import { HandFrame, handTracker } from "../video/HandTracker";

/** Mirrored camera preview with hand skeleton and a together/apart readout. */
export const CameraPreview: React.FC<{ className?: string; showDistance?: boolean }> = ({
  className,
  showDistance,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<HandFrame | null>(handTracker.latest);

  useEffect(
    () =>
      handTracker.subscribe((f) => {
        const dst = canvasRef.current;
        const src = handTracker.canvas;
        if (dst && src.width) {
          if (dst.width !== src.width) dst.width = src.width;
          if (dst.height !== src.height) dst.height = src.height;
          dst.getContext("2d")!.drawImage(src, 0, 0);
        }
        setFrame(f);
      }),
    []
  );

  const t = handTracker.tuning;
  const label =
    !frame || frame.hands === 0
      ? "No hands visible"
      : frame.together === true
      ? "Hands together"
      : frame.together === false
      ? "Hands apart"
      : "One hand visible";

  return (
    <div className={`relative overflow-hidden rounded-2xl bg-slate-900 aspect-[4/3] ${className ?? ""}`}>
      <canvas ref={canvasRef} className="w-full h-full object-cover" />
      <div className="absolute left-2 bottom-2 right-2 flex items-center justify-between gap-2 text-xs font-bold">
        <span
          className={`px-2.5 py-1 rounded-full ${
            frame?.together ? "bg-walsh-gold text-amber-950" : "bg-slate-900/70 text-white"
          }`}
        >
          {label}
        </span>
        {showDistance && frame?.distance != null && (
          <span className="px-2.5 py-1 rounded-full bg-slate-900/70 text-white tabular-nums">
            gap {frame.distance.toFixed(2)} (together &lt; {t.togetherBelow}, apart &gt; {t.apartAbove})
          </span>
        )}
      </div>
    </div>
  );
};

/** Microphone input level, with peak hold. */
export const LevelMeter: React.FC<{ className?: string }> = ({ className }) => {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const level = audioEngine.level;
      shown = Math.max(level, shown * 0.92);
      const db = 20 * Math.log10(Math.max(shown, 1e-4));
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      if (barRef.current) {
        barRef.current.style.width = `${pct}%`;
        barRef.current.style.backgroundColor = db > -3 ? "#e11d48" : db > -20 ? "#FFB81C" : "#10b981";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className={`h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden ${className ?? ""}`}>
      <div ref={barRef} className="h-full rounded-full transition-[width] duration-75" style={{ width: 0 }} />
    </div>
  );
};
