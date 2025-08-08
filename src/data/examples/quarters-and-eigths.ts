import { StaveNote } from "vexflow";

export const quartersAndEighths = [
  // Measure 1: Three quarter notes and Two 8ths
  [
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "q" }),
    new StaveNote({ keys: ["b/4"], duration: "q" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
  ],
  // Measure 2: Quarter, Quarter, 4 Eighths
  [
    new StaveNote({ keys: ["b/4"], duration: "q" }),
    new StaveNote({ keys: ["b/4"], duration: "q" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
  ],
  // Measure 3: 2 Eighths, Quarter, 2 Eighths, Quarter
  [
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "q" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "q" }),
  ],
  // Measure 4: All eighth notes
  [
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
    new StaveNote({ keys: ["b/4"], duration: "8" }),
  ],
];