import React, { useRef, useEffect } from "react";
import {
  Renderer,
  Stave,
  StaveNote,
  Voice,
  Formatter,
  Beam,
} from "vexflow";

interface Props {
  beat: number;
notesToRender: StaveNote[][];
}

const MusicNotation: React.FC<Props> = ({ beat, notesToRender }) => {
  // Create a ref to attach to the div that will contain the score
  const containerRef = useRef<HTMLCanvasElement>(null);

  // This useEffect hook runs once after the component mounts
  useEffect(() => {
    // Ensure the container is available
    if (containerRef.current) {
      // Clear the container in case of re-renders
      containerRef.current.innerHTML = "";

      // Create an SVG renderer and attach it to the container.
      const renderer = new Renderer(
        containerRef.current,
        Renderer.Backends.CANVAS
      );

      // Configure the rendering context and size.
      renderer.resize(1600, 150);
      const context = renderer.getContext();

      context.clearRect(
        0,
        0,
        containerRef.current.width,
        containerRef.current.height
      );

   

      const measureToHighlight = Math.floor(beat / 4);
      const beatToHighlight = beat % 4;

      const staveWidth = 360;
      let currentX = 0;

      // Draw each measure
      notesToRender.forEach((notes, index) => {
        const stave = new Stave(
          currentX,
          0,
          staveWidth + (index === 0 ? 50 : 0)
        );

        // The first stave gets the clef and time signature.
        if (index === 0) {
          stave.addClef("percussion").addTimeSignature("4/4");
        }

        // Set the staff to have one line for percussion
        // stave.setNumLines(5);
        stave.setConfigForLines([
          { visible: false },
          { visible: false },
          { visible: true },
          { visible: false },
          { visible: false },
        ]);
        stave.setContext(context).draw();

        // ✅ FIX 3: Use the full Formatter workflow to justify notes.
        const voice = new Voice({ numBeats: 4, beatValue: 4 });
        voice.addTickables(notes);

        const formatter = new Formatter();
        // Calculate the available width for notes. For the first measure, this
        // subtracts the space used by the clef and time signature.

        // const notesWidth = staveWidth - (stave.getNoteStartX() - stave.getX());

        // Format and justify the notes to fill the calculated space.
        formatter.joinVoices([voice]).format([voice], 360);

        const beams = Beam.generateBeams(notes, { stemDirection: 1 });

        voice.draw(context, stave);
        beams.forEach((beam) => beam.setContext(context).draw());

        // Move the x-position for the next stave

        const findFirstNoteOfBeat = (notes: StaveNote[], beat: number) => {
          let noteDurationAcc = 0;
          for (let note of notes) {
            if (noteDurationAcc >= beat) {
              return note;
            }
            switch (note.getDuration()) {
              case "q":
                noteDurationAcc += 1;
                break;
              case "8":
                noteDurationAcc += 0.5;
                break;
              case "16":
                noteDurationAcc += 0.25;
                break;
            }
          }
          throw new Error("Beat not found");
        };
        const findLastNoteOfBeat = (notes: StaveNote[], beat: number) => {
          let noteDurationAcc = 0;
          for (let i = 0; i < notes.length; i++) {
            const note = notes[i];

            if (noteDurationAcc >= beat) {
              return notes[i - 1];
            }
            switch (note.getDuration()) {
              case "q":
                noteDurationAcc += 1;
                break;
              case "8":
                noteDurationAcc += 0.5;
                break;
            }
          }
          return notes.at(-1)!!;
        };

        // --- Beat Highlight Logic ---
        if (index === measureToHighlight) {
          const beatStartNote = findFirstNoteOfBeat(notes, beatToHighlight);
          const beatEndNote = findLastNoteOfBeat(notes, beatToHighlight + 1);

          const highlightX = beatStartNote.getAbsoluteX();

          const highlightWidth =
            beatEndNote.getAbsoluteX() -
            beatStartNote.getAbsoluteX() +
            beatEndNote.getWidth();

          context.save();
          // ✅ 3. Use the native Canvas 'fillStyle' property
          context.fillStyle = "rgba(173, 216, 230, 0.7)";
          context.fillRect(highlightX - 4, 20, highlightWidth + 8, 60);
          context.restore();
        }
        currentX += staveWidth + (index === 0 ? 50 : 0);
        // --- End Highlight Logic ---

        // Auto-generate beams for the eighth notes
        // Formatter.FormatAndDraw(context, stave, notes, false);
        // new Formatter().joinVoices([voice]).format([voice], staveWidth - 20);
      });
    }
  }, [beat]); // The empty dependency array ensures this runs only once

  return <canvas ref={containerRef} />;
};

export default MusicNotation;
