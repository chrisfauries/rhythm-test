# To do

## Grading rules

- **Rest pulses: every rest gets at least one pulse, whatever its length.**
  - Rests longer than one beat can get more than one pulse.
  - Today `analyzeTake` in [src/analysis/analyze.ts](src/analysis/analyze.ts) only expects pulses on rests of a beat or longer, one on each beat. Rests shorter than a beat get no pulse.
  - To fix: expect one pulse at the start of every rest, and more on each later beat of a long rest.
  - Decide what counts for a multi-beat rest: is one pulse enough, or should there be one per beat?
  - Check the 0.15 s / 0.3 s search window for short rests. Fast eighth or sixteenth rests are closer together than that.
- **Fast subdivisions blend: don't grade each syllable's onset** (user, 2026-10-17). At faster tempos, musicians count 16ths as one connected word ("oneanna"), so "e", "&" and "uh" have no clean start. Built: the grader credits blended runs (BLEND_GAP in analyze.ts). Chris's 68 captures are the "perfect take" test: anything flagged there is a grading or model error.
- **Long notes: grade the forward motion.** Hands should stay together *and* move forward. Each held note now records how far the hands moved (`hold.motion`, not scored), and feedback asks for a push when they stay still. The threshold (under 0.15 hand lengths and 5% size change) is set below anything in Chris's takes and is uncalibrated: record a take with the hands deliberately still on long notes, and some students' takes, to set it.
- **Feedback engine** ([src/analysis/feedback.ts](src/analysis/feedback.ts) and [src/analysis/feedback/](src/analysis/feedback/), 2026-10-18). The results page leads with the one tip that would help most next time, then up to three more, and a reason under each score.
  - Structure: detectors each read part of the take and report evidence (a candidate tip, how much of the score fixing it wins back, and which notes, counts and sounds it explains). Tier 1 (timing.ts) pairs sounds with notes and explains the timing as a whole; tier 2 finds patterns; tier 3 reports what's left. The general algorithm (ga.ts) drops evidence something stronger explains, ranks, and writes the tips.
  - Diagnoses: setup; skipped or added beat; coming in a beat early or late; rushing or dragging; rushing through runs of notes; a steady offset; stopping, giving up, starting over; a late first note; a figure played as another (sixteenths as a triplet, swung eighths, dotted as even...); clapping during a long note, cutting one short, clapping a tied note; figures that keep coming early or late; wrong counts and wrong subdivision words; counts on held notes and rests; holds, pushing forward, rest pulses; single misses and extras.
  - Checks: `npm test` (a unit test per diagnosis); `npm run ml:inject-mistakes` (each mistake put into 562 clean takes, Chris's real ones and synthetic ones: named first 82–99% depending on the kind, no false alarms on the clean takes); `npm run ml:check-feedback` (synthetic mistakes graded from their labels); `npm run ml:grade-takes` (the tip for each real take). `--json <file>` on the last two saves every take's feedback, to compare engine versions.
  - The "uh" heard as "&" swap isn't reported (counts.ts `MISHEARD`): the audio model makes it on clean takes. Remove after retraining.
  - Still to do:
    - Synthetic audio takes with these mistakes (ml/synth.js), to measure the detectors on audio rather than on clean takes with events moved.
    - Counting tips are only as good as the model's hearing; check them on other students' takes.
    - Re-grade notes after a slip on the shifted grid, so the staff marks match the diagnosis.
    - Tips across takes, e.g. "your eighths have been early in your last 3 tries".
    - The ranking weights (ga.ts `WEIGHT`) are hand-set; have a teacher pick the best tip for a set of takes and tune them.

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

- **Retrained under the corrected counting conventions** (v4, 2026-10-18; ml/README.md): the "&" of rests is heard now. Still weak on "uh" (heard as "&") and "e": record more 16th-note lines counted "1 e & uh", then retrain and drop `MISHEARD` in src/analysis/feedback/counts.ts.

- Collect varied captures (`?training`): different students, rooms, mics, speaker metronome, 8th/16th lines with "e" and "a", deliberate mistakes.
- Retrain the count model as captures arrive; watch the held-out numbers, not the training ones.
- Upload captures straight to Google Drive (student sign-in, resumable upload for video) instead of downloading zips.
- Store pose (arm) and face/lip points alongside hand points; lip movement could confirm words under claps and tell whose voice it is in a band room.
- Labeler: label sung "Da"s (sung takes have nothing to check yet), holds and forward motion.
- A/B: a test suite that runs the rule-based and model approaches over labeled captures and reports accuracy by rhythm type, setting and mic. Then split the app so both can run side by side.
- **Synthetic takes from other people's real takes** (user idea, 2026-10-17), once there are takes from 5–6 people besides Chris. Cut their labeled words, "Da"s and claps into sound banks, the way `ml/sound-bank.js` does with the TTS voices, and let `ml/synth.js` build new lines from them. Real voices, real rooms and real mics would replace or add to the speech-engine voices.
  - Keep one or two of those people out of the synthetic sounds as well as training, so the test stays honest.
  - Measure their counting and singing with `ml/measure-voice.js` too; Chris's style may not be typical.
- **Synthetic video from real captures** (user idea, 2026-10-17), for when there is a video model. Swap the person (body or face swap) and the background in real takes, and keep the original labels, since the motion and timing are unchanged.
  - Use invented, AI-generated people, not celebrities. Real people's likenesses raise rights and consent issues.
  - Students are minors: get consent before using their video this way, and run the swap locally.
  - Check every swapped clip: run the hand tracker on the original and the swap, and drop clips where hand positions or contact times differ. Generative video often smears hands and fingers, which is exactly the signal the model needs.
  - Cheaper steps first: background replacement through segmentation, lighting and colour changes, blur, lower frame rates (the C920 gives about 20 fps), and changes to crop, scale and camera angle.
  - If the model reads hand landmarks rather than pixels, appearance matters less. Augmenting the landmarks (body size, distance, angle, jitter) may get most of the benefit.
- Next models, if the test set shows the rules failing: clap detector (fast rhythms, speaker metronome; subtract the known click sound first), gesture model (contact, pulses, holds, forward motion).
