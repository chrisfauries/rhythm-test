import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Beam,
  Dot,
  Formatter,
  Fraction,
  Renderer,
  Stave,
  StaveNote,
  StaveTie,
  Tuplet,
  Voice,
} from "vexflow";
import { Line, measureLength, noteLength, RhythmNote, TimeSignature } from "../music/rhythm";

// Renders a rhythm line with VexFlow (SVG) on a one-line percussion staff,
// wrapping onto extra rows when the line is too dense for the width. Reports
// a layout so overlays (cursor, clap markers, counts) can be drawn on top.

export interface StaffRow {
  /** Top of this row in the overlay's coordinates. */
  top: number;
  /** y of the single staff line. */
  lineY: number;
  /** Bottom of the staff area (where overlay lanes may start). */
  staffBottom: number;
  firstPos: number;
  lastPos: number;
  /** Sorted [pos, x] anchors used for interpolation. */
  anchors: [number, number][];
}

export interface StaffNoteBox {
  measure: number;
  index: number;
  pos: number;
  x: number;
  row: number;
}

export interface StaffLayout {
  width: number;
  height: number;
  rows: StaffRow[];
  notes: StaffNoteBox[];
  /** Row containing a position (q-units from the start of the line). */
  rowOf(pos: number): number;
  /** x coordinate for a position within a row. */
  xOf(pos: number, row?: number): number;
}

interface Props {
  line: Line;
  /** Colors for individual notes, keyed "measure-index". */
  noteColors?: Record<string, string>;
  /** Extra vertical space reserved under each row for overlay lanes. */
  laneHeight?: number;
  /** Draws the overlay; called with the current layout. */
  overlay?: (layout: StaffLayout) => React.ReactNode;
  onLayout?: (layout: StaffLayout) => void;
  className?: string;
}

const STAFF_BLOCK = 120;
const LINE_OFFSET = 40; // stave y -> its middle line is 2 spaces lower
/** Space from a barline to the next beat 1's notehead. */
const BAR_GAP = 9;
/** Space from the clef/time signature to the first notehead of a row. */
const CLEF_GAP = 12;
/** Room a notehead needs before the next note (plus extras below). */
const NOTE_PX = 20;
const DOT_PX = 6;
const FLAG_PX = 3;
/** Never squeeze below this many px per quarter note. */
const MIN_QUARTER_PX = 44;

const beamGroups = (ts: TimeSignature) => {
  if (ts.den === 8 && ts.num % 3 === 0) return [new Fraction(3, 8)];
  if (ts.den === 8 && ts.num === 5) return [new Fraction(2, 8), new Fraction(3, 8)];
  if (ts.den === 8 && ts.num === 7) return [new Fraction(2, 8), new Fraction(2, 8), new Fraction(3, 8)];
  return [new Fraction(1, 4)];
};

/**
 * Pixels per quarter note that this measure needs so that, with notes spaced
 * in proportion to their length, nothing collides.
 */
const requiredQuarterPx = (notes: RhythmNote[], ts: TimeSignature, barPad: number) => {
  let req = 0;
  notes.forEach((n, i) => {
    const len = noteLength(n, ts);
    if (n.measureRest) {
      req = Math.max(req, 50 / len);
      return;
    }
    // The last note only needs its notehead (and dots) plus the barline gap.
    const last = i === notes.length - 1;
    const need =
      n.dots * DOT_PX + (last ? (len < 0.5 ? 12 : 18) + barPad : NOTE_PX + (["8", "16", "32"].includes(n.base) ? FLAG_PX : 0));
    req = Math.max(req, need / len);
  });
  return req;
};

const makeNote = (n: RhythmNote, color?: string) => {
  const note = new StaveNote({
    keys: [n.measureRest ? "d/5" : "b/4"],
    duration: (n.measureRest ? "w" : n.base) + (n.rest ? "r" : ""),
    stemDirection: 1,
    alignCenter: n.measureRest,
  });
  for (let i = 0; i < n.dots; i++) Dot.buildAndAttach([note], { all: true });
  if (color) note.setStyle({ fillStyle: color, strokeStyle: color });
  return note;
};

const useFontsReady = () => {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    const fonts = (document as any).fonts;
    if (!fonts?.load) {
      setReady(true);
      return;
    }
    fonts
      .load("30px Bravura")
      .catch(() => {})
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  return ready;
};

const Staff: React.FC<Props> = ({ line, noteColors, laneHeight = 0, overlay, onLayout, className }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const vexRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [layout, setLayout] = useState<StaffLayout | null>(null);
  const fontsReady = useFontsReady();
  const onLayoutRef = useRef(onLayout);
  onLayoutRef.current = onLayout;

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const host = vexRef.current;
    if (!host || width < 200 || !fontsReady) return;
    host.innerHTML = "";

    const ts = line.timeSig;
    const mLen = measureLength(ts);
    const usable = width - 12;

    // Notes are spaced in proportion to time (every measure the same width,
    // each note at its beat), so the play cursor moves at a steady speed and a
    // half note visibly lasts twice as long as a quarter.
    // Width taken by the clef (and time signature on row 0) before beat 1.
    const clefWidth = (row: number) => {
      const st = new Stave(0, 0, 400).addClef("percussion");
      if (row === 0) st.addTimeSignature(`${ts.num}/${ts.den}`);
      return st.getNoteStartX() + CLEF_GAP;
    };
    const lead = [clefWidth(0), clefWidth(1)];
    const leadOf = (row: number) => lead[row === 0 ? 0 : 1];
    const quarterPx = Math.max(
      MIN_QUARTER_PX,
      ...line.measures.map((notes) => requiredQuarterPx(notes, ts, BAR_GAP))
    );
    // The last measure of a row also needs room after its last note.
    const roomOf = (row: number) => usable - leadOf(row) + BAR_GAP;
    const fit = Math.max(1, Math.floor(roomOf(0) / (mLen * quarterPx)));
    const rowsCount = Math.ceil(line.measures.length / fit);
    const perRow = Math.ceil(line.measures.length / rowsCount);
    const rowHeight = STAFF_BLOCK + laneHeight;
    const height = rowsCount * rowHeight;

    const renderer = new Renderer(host, Renderer.Backends.SVG);
    renderer.resize(width, height);
    const ctx = renderer.getContext();

    const rows: StaffRow[] = [];
    const noteBoxes: StaffNoteBox[] = [];
    const vexByMeasure: StaveNote[][] = [];
    let headWidth = 11;

    for (let r = 0; r < rowsCount; r++) {
      const mStart = r * perRow;
      const mEnd = Math.min(line.measures.length, mStart + perRow);
      if (mStart >= mEnd) break;
      const top = r * rowHeight;
      const x0 = 4;
      // Every row uses the full width, so rows differ a little in scale.
      const W = roomOf(r) / perRow;
      // Left edge of beat 1's notehead in this row's first measure.
      const noteStart = x0 + leadOf(r);
      const noteLeft = (m: number, posInMeasure: number) => noteStart + (m - mStart + posInMeasure / mLen) * W;
      // Barlines sit BAR_GAP before each beat 1.
      const barX = (m: number) => (m === mStart ? x0 : noteLeft(m, 0) - BAR_GAP);

      for (let m = mStart; m < mEnd; m++) {
        const first = m === mStart;
        const stave = new Stave(barX(m), top + 10, noteLeft(m + 1, 0) - BAR_GAP - barX(m));
        if (first) {
          stave.addClef("percussion");
          if (r === 0) stave.addTimeSignature(`${ts.num}/${ts.den}`);
        }
        if (m === line.measures.length - 1) stave.setEndBarType(3); // final double bar
        stave.setConfigForLines([
          { visible: false },
          { visible: false },
          { visible: true },
          { visible: false },
          { visible: false },
        ]);
        stave.setContext(ctx).draw();

        const rhythm = line.measures[m];
        const notes = rhythm.map((n, i) => makeNote(n, noteColors?.[`${m}-${i}`]));
        vexByMeasure[m] = notes;

        const tuplets: Tuplet[] = [];
        let i = 0;
        while (i < rhythm.length) {
          const t = rhythm[i].tuplet;
          if (!t) {
            i++;
            continue;
          }
          let j = i;
          while (j < rhythm.length && rhythm[j].tuplet?.id === t.id) j++;
          const group = notes.slice(i, j);
          const beamable = rhythm.slice(i, j).every((n) => !n.rest && ["8", "16", "32"].includes(n.base));
          tuplets.push(
            new Tuplet(group, { numNotes: t.notes, notesOccupied: t.occupied, bracketed: !beamable })
          );
          i = j;
        }

        const voice = new Voice({ numBeats: ts.num, beatValue: ts.den });
        voice.setMode(Voice.Mode.SOFT);
        voice.addTickables(notes);
        const beams = Beam.generateBeams(notes, { groups: beamGroups(ts), stemDirection: 1 });
        new Formatter().joinVoices([voice]).format([voice], Math.max(40, W - 12));
        notes.forEach((note) => note.setStave(stave));

        // Move every note to its place in time. VexFlow positions noteheads,
        // stems and beams from the tick context when drawing.
        let pos = 0;
        rhythm.forEach((n, ni) => {
          const note = notes[ni];
          if (!n.measureRest) {
            const tc = note.getTickContext();
            tc.setX(tc.getX() + noteLeft(m, pos) - note.getNoteHeadBeginX());
          }
          pos += noteLength(n, ts);
        });

        voice.draw(ctx, stave);
        beams.forEach((b) => b.setContext(ctx).draw());
        tuplets.forEach((t) => t.setContext(ctx).draw());

        pos = m * mLen;
        for (let ni = 0; ni < notes.length; ni++) {
          const begin = notes[ni].getNoteHeadBeginX();
          const end = notes[ni].getNoteHeadEndX();
          if (!rhythm[ni].rest && end > begin) headWidth = end - begin;
          noteBoxes.push({ measure: m, index: ni, pos, x: (begin + end) / 2, row: rows.length });
          pos += noteLength(rhythm[ni], ts);
        }
      }

      const firstPos = mStart * mLen;
      const lastPos = mEnd * mLen;
      rows.push({
        top,
        lineY: top + 10 + LINE_OFFSET,
        staffBottom: top + STAFF_BLOCK - 14,
        firstPos,
        lastPos,
        // Left edges of the noteheads; shifted to centers below.
        anchors: [
          [firstPos, noteStart],
          [lastPos, noteStart + ((lastPos - firstPos) / mLen) * W],
        ],
      });
    }
    rows.forEach((row) => row.anchors.forEach((a) => (a[1] += headWidth / 2)));

    // Ties (partial ties where a tie crosses a row break).
    const rowOfMeasure = (m: number) => Math.floor(m / perRow);
    line.measures.forEach((rhythm, m) =>
      rhythm.forEach((n, i) => {
        if (!n.tie) return;
        const nextM = i + 1 < rhythm.length ? m : m + 1;
        const nextI = i + 1 < rhythm.length ? i + 1 : 0;
        const a = vexByMeasure[m]?.[i];
        const b = vexByMeasure[nextM]?.[nextI];
        if (!a || !b) return;
        const sameRow = rowOfMeasure(m) === rowOfMeasure(nextM);
        const ties = sameRow
          ? [new StaveTie({ firstNote: a, lastNote: b, firstIndexes: [0], lastIndexes: [0] })]
          : [
              new StaveTie({ firstNote: a, lastNote: null, firstIndexes: [0], lastIndexes: [0] }),
              new StaveTie({ firstNote: null, lastNote: b, firstIndexes: [0], lastIndexes: [0] }),
            ];
        ties.forEach((t) => t.setContext(ctx).draw());
      })
    );

    const rowOf = (pos: number) => {
      const idx = rows.findIndex((r) => pos < r.lastPos);
      return idx < 0 ? rows.length - 1 : idx;
    };
    const xOf = (pos: number, row = rowOf(pos)) => {
      const a = rows[row].anchors;
      if (pos <= a[0][0]) {
        const slope = a.length > 1 ? (a[1][1] - a[0][1]) / (a[1][0] - a[0][0] || 1) : 30;
        return a[0][1] + (pos - a[0][0]) * slope;
      }
      for (let k = 1; k < a.length; k++) {
        if (pos <= a[k][0]) {
          const [p0, x0] = a[k - 1];
          const [p1, x1] = a[k];
          return x0 + ((pos - p0) / (p1 - p0 || 1)) * (x1 - x0);
        }
      }
      const [pl, xl] = a[a.length - 1];
      const [pp, xp] = a[a.length - 2] ?? [pl - 1, xl - 30];
      return xl + ((pos - pl) * (xl - xp)) / (pl - pp || 1);
    };

    const next: StaffLayout = { width, height, rows, notes: noteBoxes, rowOf, xOf };
    setLayout(next);
    onLayoutRef.current?.(next);
  }, [line, noteColors, width, laneHeight, fontsReady]);

  return (
    <div ref={wrapRef} className={`relative w-full ${className ?? ""}`}>
      <div ref={vexRef} className="[&_svg]:overflow-visible" />
      {layout && overlay && (
        <svg
          className="absolute inset-0 pointer-events-none overflow-visible"
          width={layout.width}
          height={layout.height}
        >
          {overlay(layout)}
        </svg>
      )}
    </div>
  );
};

export default Staff;
