# To do

## Grading rules

- **Rest pulses: every rest gets at least one pulse, whatever its length.**
  - Rests longer than one beat can get more than one pulse.
  - Today `analyzeTake` in [src/analysis/analyze.ts](src/analysis/analyze.ts) only expects pulses on rests of a beat or longer, one on each beat. Rests shorter than a beat get no pulse.
  - To fix: expect one pulse at the start of every rest, and more on each later beat of a long rest.
  - Decide what counts for a multi-beat rest: is one pulse enough, or should there be one per beat?
  - Check the 0.15 s / 0.3 s search window for short rests. Fast eighth or sixteenth rests are closer together than that.
- **Long notes: grade the forward motion.** Hands should stay together *and* move forward. Only "together" is checked now.

## Notation

- **Beam notes exactly as the book does.** For example, four 8th notes beamed together in the PDF should be one beamed group in the app. It's a teaching moment: students see that the two look the same.
  - Today the staff ([src/components/Staff.tsx](src/components/Staff.tsx), `beamGroups`) beams automatically by beat. In 4/4 it groups by quarter note, so four 8ths are drawn as two beamed pairs. Compound meters are grouped by dotted quarter.
  - The book's beaming isn't recorded in the transcription ([src/music/bookData.ts](src/music/bookData.ts)), so the notation format needs a way to mark beam groups, for example brackets around beamed notes.
  - Re-check the transcribed lines (#1–#17) against the PDF pages and mark their beams.

## Needs real takes (debug bundle for each)

- Re-run Calibrate with the new clap detector.
- A line with half or whole notes, for holds and the forward motion.
- A line with eighth notes: fast claps, and a soft clap right after a loud one.
- The same line in "Count only" and in "Sing on Da". Neither mode has been tested on real audio.
- One take with speakers instead of headphones, to check the metronome isn't heard as claps.
- A Chromebook take, if possible.

## Camera

- The C920 delivers about 20 fps, and hands blur at contact.
  - Try asking the camera for 30 fps.
  - Try MediaPipe's full model instead of the lite one.
- Rest-pulse threshold (0.8 hand lengths) was set from one person's takes. Check it against students sitting farther away or making smaller motions.

## Models (see [ml/README.md](ml/README.md))

- Collect varied captures (`?training`): different students, rooms, mics, speaker metronome, 8th/16th lines with "e" and "a", deliberate mistakes.
- Retrain the count model as captures arrive; watch the held-out numbers, not the training ones.
- Upload captures straight to Google Drive (student sign-in, resumable upload for video) instead of downloading zips.
- Store pose (arm) and face/lip points alongside hand points; lip movement could confirm words under claps and tell whose voice it is in a band room.
- Labeler: speed up correcting (jump to the next unsure count, keyboard-only flow), label holds/forward motion, per-note verdicts.
- A/B: a test suite that runs the rule-based and model approaches over labeled captures and reports accuracy by rhythm type, setting and mic. Then split the app so both can run side by side.
- Next models, if the test set shows the rules failing: clap detector (fast rhythms, speaker metronome; subtract the known click sound first), gesture model (contact, pulses, holds, forward motion).

## Later
- Rhythm Reading book transcription: resume at #17.5.
