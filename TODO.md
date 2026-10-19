# To do

## Grading rules

- **Rest pulses and sustain** (done 2026-10-18, user's rule): every rest symbol gets a pulse at its start, eighth rests too, and a rest longer than a beat one on each beat; any note longer than a beat (dotted quarters too) gets its hold checked. With the pose tracker on 24 takes: rest pulses 98%, holds 98%. Still open: whether a multi-beat rest needs one pulse per beat or one is enough.
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

- **Body pose is the default tracker** (2026-10-18; src/video/HandTracker.ts, Settings → Camera model). MediaPipe Pose Landmarker lite follows the arms, so both hands stay located while pressed together. On 24 of Chris's takes run through the app's own pipeline (`npm run ml:vision-tune`): clap contacts 98% (old hand model 67%), long notes held 97% (91%), "together" on rest beats 1% (34%), rest pulses 98% (93%); about 12-19 ms a frame on the desktop GPU. Thresholds: a hand = 0.45 of a forearm, together below 1.3 hands, apart above 1.5.
  - Measure it on a Chromebook, and on other people (rerun `ml:vision-prep`, `ml:vision-run`, `ml:vision-score`, `ml:vision-tune` with their captures). Every benchmark take so far is Chris, one room, one camera.
  - Early releases of long notes never happen in the benchmark takes, so "came apart early" isn't measured: record a few on purpose.
  - Runs on the page's main thread like the old tracker; a Web Worker would keep the page smoother on slow machines.
  - Next: a small gesture model on the pose points, trained with clap times from the audio as free labels.

- The C920 delivers about 20 fps, and hands blur at contact.
  - Try asking the camera for 30 fps.
  - Try MediaPipe's full model instead of the lite one.
- Rest-pulse threshold (0.8 hand lengths) was set from one person's takes. Check it against students sitting farther away or making smaller motions.

## Models (see [ml/README.md](ml/README.md))

- **Retrained under the corrected counting conventions** (v4, 2026-10-18; ml/README.md): the "&" of rests is heard now. Still weak on "uh" (heard as "&") and "e": record more 16th-note lines counted "1 e & uh", then retrain and drop `MISHEARD` in src/analysis/feedback/counts.ts.

- Collect varied captures (`?training`): different students, rooms, mics, speaker metronome, 8th/16th lines with "e" and "a", deliberate mistakes.
- Retrain the count model as captures arrive; watch the held-out numbers, not the training ones.
- Upload captures straight to Google Drive (student sign-in, resumable upload for video) instead of downloading zips.
- **Use context when the model is unsure of a word** (user, 2026-10-19). Done in the grader, not the model: the model already gives every word's probability at each onset (`probs` in src/ml/audioModel.ts), but `modelGraderInput` keeps only the top word. Two ideas to try:
  1. *Neighbors:* when there's no clear winner (60% "e", 40% "&"), let the words heard just before and after decide ("1 _ & a" makes the gap an "e").
  2. *The music:* weigh each word by what's written at that moment, so a near-tie goes to the written word. A clearly said wrong word still wins, so "1 e e a" is still caught.
  - Keep the model a pure "what did I hear" detector: context learned inside it would learn to overrule real mistakes, with no setting to control how much.
  - The feedback detectors that look for what was actually said, not written (morph: "1 la li" said for "1 e & a"), keep the raw words, or the boost hides the very mistake.
  - Tune on both measures at once: false flags on the clean takes (`ml:grade-takes dataset/chris_fauries --all`) must drop, and wrong words caught in the synthetic mistake takes must stay. Without the second, ignoring mistakes would look like an improvement.

- **Lip movement to confirm counts under claps** (user idea, 2026-10-18). Counting while clapping is the hardest case: the clap masks the word. The camera already sees the face.
  - Don't aim for full lip reading. Visual speech recognition models (AV-HuBERT, Auto-AVSR) are large, made for sentences, and poor at single words with no context. We only need two smaller things: *when* a syllable started, and *which of a few words* it could be.
  - Timing: MediaPipe Face Landmarker (in @mediapipe/tasks-vision, already loaded) gives lip points and blendshapes (jawOpen, mouthClose, mouthFunnel, mouthPucker) every frame. Mouth-opening onsets give syllable times no clap can hide; that alone confirms "said something here, in time" when the audio model is unsure.
  - Which word: the count words look different. "one"/"two" round the lips, "three" shows the tongue, "four" puts teeth on the lip, "e" spreads, "&"/"uh" open the jaw. A small classifier on a few frames of blendshapes around each onset could tell them apart well enough to back up or overrule the audio model, not replace it.
  - Test it offline first on captures we already have: run the face model over their videos with the vision bench (`ml/vision-bench-run.js`) and compare mouth onsets with the labeled count times. No new recordings needed to find out whether it works.
  - Costs and risks: running face and pose together (Holistic, or face every other frame) on a Chromebook; the C920's ~20 fps is 50 ms a frame, coarse next to a 70 ms tolerance; faces small in frame at a distance; students looking down at the music or tilting their heads; hands crossing the face. A mouth moving also says nothing about who made a sound, though it could tell which voice is the student's in a noisy band room.
  - Store face points in the debug bundle next to pose points, so later labeled takes can train the classifier.
- Labeler: label sung "Da"s (sung takes have nothing to check yet), holds and forward motion.
- A/B: a test suite that runs the rule-based and model approaches over labeled captures and reports accuracy by rhythm type, setting and mic. Then split the app so both can run side by side.
- **Synthetic takes from other people's real takes** (user idea, 2026-10-17), once there are takes from 5–6 people besides Chris. Cut their labeled words, "Da"s and claps into sound banks, the way `ml/sound-bank.js` does with the TTS voices, and let `ml/synth.js` build new lines from them. Real voices, real rooms and real mics would replace or add to the speech-engine voices.
  - Plan (user, 2026-10-18): 20-30 takes from each of 3-4 adults and an 8th grader (the 25-take set in the chat of 2026-10-18), then 3-4x as many synthetic takes per person from their own clips, on lines and tempos they didn't record.
  - Built (2026-10-18): the `?collect` page (Settings → Tools → Collect a person) records the 25 guided takes and a clips zip per person. Still to do: teach `ml/sound-bank.js` to read the clips zips (format in ml/README.md), and `ml/synth.js` to build takes from one person's bank.
  - Cutting clips: claps are clean; blended counts ("oneanna") and legato singing aren't, so take words from takes where the counts are clearly apart, with exact cut points from a labeled take or two per person and the model for the rest.
  - Keep one or two of those people out of the synthetic sounds as well as training, so the test stays honest. (Suggested: the 8th grader and one adult.)
  - Measure their counting and singing with `ml/measure-voice.js` too; Chris's style may not be typical.
- **Synthetic video from real captures** (user idea, 2026-10-17), for when there is a video model. Swap the person (body or face swap) and the background in real takes, and keep the original labels, since the motion and timing are unchanged.
  - Use invented, AI-generated people, not celebrities. Real people's likenesses raise rights and consent issues.
  - Students are minors: get consent before using their video this way, and run the swap locally.
  - Check every swapped clip: run the hand tracker on the original and the swap, and drop clips where hand positions or contact times differ. Generative video often smears hands and fingers, which is exactly the signal the model needs.
  - Cheaper steps first: background replacement through segmentation, lighting and colour changes, blur, lower frame rates (the C920 gives about 20 fps), and changes to crop, scale and camera angle.
  - If the model reads hand landmarks rather than pixels, appearance matters less. Augmenting the landmarks (body size, distance, angle, jitter) may get most of the benefit.
- Next models, if the test set shows the rules failing: clap detector (fast rhythms, speaker metronome; subtract the known click sound first), gesture model (contact, pulses, holds, forward motion).
