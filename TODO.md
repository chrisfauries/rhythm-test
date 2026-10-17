# To do

## Grading rules

- **Rest pulses: every rest gets at least one pulse, whatever its length.**
  - Rests longer than one beat can get more than one pulse.
  - Today `analyzeTake` in [src/analysis/analyze.ts](src/analysis/analyze.ts) only expects pulses on rests of a beat or longer, one on each beat. Rests shorter than a beat get no pulse.
  - To fix: expect one pulse at the start of every rest, and more on each later beat of a long rest.
  - Decide what counts for a multi-beat rest: is one pulse enough, or should there be one per beat?
  - Check the 0.15 s / 0.3 s search window for short rests. Fast eighth or sixteenth rests are closer together than that.
- **Long notes: grade the forward motion.** Hands should stay together *and* move forward. Only "together" is checked now.
- **Feedback engine: diagnose the mistake, not its symptoms** (user, 2026-10-17). It sits between the model's output (claps, words, times) and what the student is told. A fixed grid of metronome beats makes some mistakes look far worse than they are.
  - Rushing or dragging: the student gradually speeds up or slows down but performs the right sequence. Follow their tempo (fit a tempo curve) and report "you sped up from measure 3" instead of marking every later note wrong.
  - A skipped beat or an added beat of rest: everything after it is shifted by one beat. Re-align by sliding the grid forward or backward, then report the one skip or extra beat.
  - Local stretching or squeezing within a beat or two, then back on the metronome: for example, 16ths taking too long or triplets compressed. Report it as a pattern tied to that rhythm figure ("your triplets are rushed"), especially when it repeats.
  - Possible approach: align the performed events to the written ones with dynamic time warping (sequence first, timing second). Then explain the residual timing at three scales: a global tempo drift, single shifts, and per-figure distortions.
  - The synthetic tracks already include gradual rushing and dragging. Skipped or added beats and per-figure squeezing could be added to `ml/synth.js` as labeled test cases for this engine.

## Notation

- **Counting in compound and odd meters: confirm the convention.** The whole book is in the app now, including 6/8, 9/8, 12/8, 3/8, 5/8, 7/8 and triplets. Today every 8th note in an /8 meter is its own counted beat (6/8 is counted 1 2 3 4 5 6), and triplets are counted "1 trip let". If the class counts 6/8 in two ("1 & a 2 & a") or says triplets differently, the count labels in [src/music/rhythm.ts](src/music/rhythm.ts) (`countLabel`, `beatLength`) need to change.

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
- Labeler: label sung "Da"s (sung takes have nothing to check yet), holds and forward motion.
- A/B: a test suite that runs the rule-based and model approaches over labeled captures and reports accuracy by rhythm type, setting and mic. Then split the app so both can run side by side.
- **Synthetic video from real captures** (user idea, 2026-10-17), for when there is a video model. Swap the person (body or face swap) and the background in real takes, and keep the original labels, since the motion and timing are unchanged.
  - Use invented, AI-generated people, not celebrities. Real people's likenesses raise rights and consent issues.
  - Students are minors: get consent before using their video this way, and run the swap locally.
  - Check every swapped clip: run the hand tracker on the original and the swap, and drop clips where hand positions or contact times differ. Generative video often smears hands and fingers, which is exactly the signal the model needs.
  - Cheaper steps first: background replacement through segmentation, lighting and colour changes, blur, lower frame rates (the C920 gives about 20 fps), and changes to crop, scale and camera angle.
  - If the model reads hand landmarks rather than pixels, appearance matters less. Augmenting the landmarks (body size, distance, angle, jitter) may get most of the benefit.
- Next models, if the test set shows the rules failing: clap detector (fast rhythms, speaker metronome; subtract the known click sound first), gesture model (contact, pulses, holds, forward motion).
