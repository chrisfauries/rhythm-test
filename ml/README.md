# Models

Small models that help the app hear and see what rule-based detection can't.
The grading itself stays rule-based ([src/analysis/analyze.ts](../src/analysis/analyze.ts)). The models only
report events: which count word was said, and later claps and hand motions.

## The workflow

**Collecting from a new person:** Settings → Tools → **Collect a person** (`?collect`). A guided session:
the 25 planned lines one at a time (`src/collect/plan.ts`: every activity, rhythms from quarters to
sixteenths, triplets, ties, 3/4 to 6/8, a spread of tempos), each practiced and then recorded, and
saved as an ordinary capture zip only when the person says it was played as written; then about 50
**sound clips** (single counts, phrases like "1 e & uh", held counts, claps, sung "Da"s), said on the
click and saved as one zip: `manifest.json` (person, device, every prompt and clip with its labels,
where the sound starts and where each syllable should be), `clips/<kind>/<prompt>_<n>.wav`, and
`raw/<prompt>.wav` (each prompt's whole recording, to re-cut). The clips are for building synthetic
takes from that person's own sounds (not wired into `sound-bank.js` yet: TODO.md).

1. **Capture.** Open the app with `?training` (e.g. `http://localhost:3000/?training`). After each take,
   press **● Capture** and fill in the dialog. You get one zip with the mic audio, the metronome, the
   camera video, every detection, and the app's grading. Put the zips in `ml/captures/`. They're kept
   out of git; the shared copy lives in Google Drive.
2. **Label** (only needed for takes that weren't performed exactly as written). Open the app with
   `?label` and open a capture zip. It walks you through the take one beat at a time, showing what
   the app heard and saw; fix anything wrong with the buttons and press **✓ Looks right, next**. The
   timeline underneath is for fine-tuning timing. **💾 Save labels** writes `labels.json` into the zip
   itself (in Chrome; other browsers download an updated zip to put in place of the old one). Takes
   captured as "As written" need no labels: the notation is the label.
3. **Build the dataset:** `npm run ml:dataset`
4. **Train and evaluate:** `npm run ml:train` (needs Python with `pip install -r ml/requirements.txt`).
   With an NVIDIA GPU, install the CUDA build of PyTorch instead and training uses it automatically:
   `pip install torch --index-url https://download.pytorch.org/whl/cu126`.
   It first trains with each take held out in turn and prints how well the model does on the held-out
   take, then trains on everything and writes `public/models/counts.json`.
5. **Try it:** open the app with `?model=counts`. Compare with the same line without it.

## The count-word model (v4, proof of concept)

- **Job:** on a beat where the student claps and counts at once, the clap's room echo hides the word
  from speech recognition (Vosk recognized 0 of 59 such counts in the first real takes). The model
  says which count word, or none, was spoken there.
- **Input:** a 0.7 s log-mel spectrogram around where an on-time count would start
  ([src/ml/features.ts](../src/ml/features.ts), shared by the app and the pipeline).
- **Network:** three 3×3 conv layers (16, 32, 48 filters) with pooling, then a linear layer:
  18,966 weights, 99 KB. It runs in the browser in plain TypeScript ([src/ml/countModel.ts](../src/ml/countModel.ts)).
  Wider networks (24-48-64, 32-64-96) were tried on the augmented data and did no better.
- **Use in grading** (`?model=counts` only): for counts under a clap that Vosk missed, the word is
  confirmed, marked wrong, or left on timing-only credit when the model isn't sure. The thresholds are
  in [src/ml/flags.ts](../src/ml/flags.ts). Counts the model judged show a small "AI" tag on the results.
- **Training data so far:** 9 takes (clap & count, count only, clap only, sing, calibration), one adult,
  one room, one webcam mic. That's enough to prove the pipeline, not to trust the model with students.

### Tempo and voice copies (off by default)

[augment.js](augment.js) can rebuild each take at 80 and 140 bpm (time-stretched, pitch kept) and with a
higher voice (+3 to +6 semitones). Model v3 was trained that way; v4 is trained on real audio only,
because real takes at other tempos and in other voices are being recorded instead. To try the copies
again: `AUGMENT=1 npm run ml:dataset`, then train as usual (`--no-augment` leaves them out of training
while still scoring them).

What v3 showed, scoring each held-out take's copies: without the copies the model fell to 31-46% when
the held-out voice was just 3-6 semitones higher, and with them it held 70-99%, at a cost of a few points
on the original audio. So until there are recordings from other people, expect v4 to be weaker on
voices unlike yours.

| Held out, counts under a clap | v2 | v3 (with copies) | v4 |
|---|---|---|---|
| Original audio | 81-86% (2 seeds) | 74-79% | 83-85% (3 seeds) |
| Higher voice (copies) | 37-42% | 70-72% | not measured |

Clap mixing (a recorded clap added onto clean counts) is separate and still on: it's most of what
teaches the model counts under a clap.

Results swing with the random seed while data is this small: across five seeds, v2's "original audio"
number was 75-87%. Compare models over a few seeds (`SEED=1 npm run ml:train -- --no-export`, etc.),
not one run. Averaging several seeds' models would steady it; that's a next step.

With the grading thresholds, on the held-out takes (v4): of 312 counts said correctly under a clap,
91% were confirmed and none were marked wrong. When a different number was simulated, 49% were
caught, 43% got timing-only credit, and 9% slipped through. The calibration take scores low when held
out because it is the only take with "&" in it.

### Training time

Every run appends a row to [training-log.csv](training-log.csv): time taken, takes, patches, settings,
and results. The budget is **30 minutes** on the RTX 3080; train.py warns past it. v4 (9 takes,
1,830 patches) took 1.8 min; v3 with the tempo/voice copies (4,910 patches) took 4.5 min. Time grows roughly with the number of takes squared (one fold per take,
each on all the other takes). Things to try when it gets long: fewer augmented copies per count, larger
batches, mixed precision, or holding out groups of takes (e.g. 5 folds) instead of every take.

## The audio model (one model for everything the mic hears)

- **Job:** for every 10 ms of a take: does a clap start here, does a syllable start here (and which:
  a count word, "la"/"li", or a sung "Da"), and is someone voicing. That gives the grader the same
  event lists the detectors and Vosk give it today. Runs in plain TypeScript
  ([src/ml/audioModel.ts](../src/ml/audioModel.ts)) on the whole take after it ends.
- **Network:** two 3x3 conv layers over the log-mel spectrogram (pooling only across frequency, so
  timing stays at 10 ms), then five dilated 1-D convolutions over time (each frame sees about
  ±0.35 s), then a 1x1 layer to the outputs. 87k parameters, 455 KB.
- **Labels** ([audio-dataset.js](audio-dataset.js)): the notation says *what* (the take was performed as
  written; the counts by today's conventions, `expectedCounts`, not the ones stored with older
  captures), the app's detectors say exactly *when* (the grader's matched clap / vowel-onset times;
  for a count the old grader didn't expect, like the "&" of a rest, the nearest voice onset).
  Anything doubtful (a note the grader couldn't match, a sound that matches no note) is masked: no
  reward or penalty there. Labels saved in the labeler, and generated takes, are exact and replace this.
- **v1 (2026-10-17, 79 real takes by one person), held out 5-fold by take:**

  | | Audio model | Vosk |
  |---|---|---|
  | counts said while clapping (712) | 86% | 0.3% |
  | counts without a clap (699) | 87% | 76% |
  | sung notes (231) | 99.6% | — |
  | claps (1084) | 99.9%, no false claps | — |

  Rare words are weak (e/uh/la/li: 12-23 examples each). Learning curve (same held-out takes):
  under-clap counts 59% (4 takes) → 68% (8) → 77% (16) → 79% (32) → 86% (~63): still rising.
  Not tested yet on any other voice.
- **v2 (2026-10-17, + 5,619 generated takes, 6000 steps), shipped:** on the same real held-out takes
  it's the same as real-only training (counts under claps 86.4% vs 85.8%, clean 86.0% vs 85.6%;
  "e" 11/23 vs 4/23). The difference is on voices it never heard (`HOLD_VOICE=girl` /
  `HOLD_VOICE=uk-male`: one generated voice left out of training, scored on all its takes):

  | unheard voice | trained on real + other voices | trained on real only |
  |---|---|---|
  | counts, no clap | 75-76% | 46-56% |
  | counts under a clap | 41-55% | 27-33% |
  | sung notes | 64-84% | 2-29% |
  | false claps | 11-123 | 1,200-1,900 |

  So a model trained on one person mostly fails on other voices, and voice variety is what fixes
  it. Under-clap counts for a new voice are still weak: more (real) voices needed. Generated voices
  are a stand-in: real children will differ.
- **v3 (2026-10-17, 5,486 generated takes by 68 voices from 3 engines, 22 of them children;
  connected counting, legato singing on one pitch, varied backgrounds; 6000 steps), shipped.**
  Real held-out takes: counts under claps 86.1%, clean 86.8%, sung 99.1%, claps 99.9%, count-only
  takes with claps mixed in 87.5% (v2: 81.6%). Unheard voices (`HOLD_VOICES=` 8 voices: 3 children,
  all 3 engines, US/UK/non-native; 500 takes), by how many other voices are trained on
  (`VOICE_COUNTS=0,5,15,30,60`):

  | other voices trained on | 0 (real only) | 5 | 15 | 30 | 60 |
  |---|---|---|---|---|---|
  | counts, no clap | 40% | 72% | 80% | 83% | 85% |
  | counts under a clap | 34% | 53% | 65% | 66% | 71% |
  | sung notes | 23% | 76% | 80% | 81% | 82% |
  | false claps | 880 | 210 | 126 | 78 | 58 |

  Still rising at 60 voices for counts under claps, flattening for clean counts and singing.
  Weakest words on new voices: the rare numbers (5-12) and "uh".
- **v4 (2026-10-18), shipped:** retrained under the corrected counting conventions: real takes
  labeled with today's `expectedCounts` ("count everything" says the "&" of a rest; 16 counts the
  old labels lacked), and all 5,486 generated takes regenerated (a third of the mistake twins now
  with structural mistakes: stops, restarts, starts a beat off, triplet/swing morphs, extra claps in
  long or tied notes). Seed 0 of three (seeds 1, 2 graded worse). Held out on real takes about the
  same as v3 (under claps 86.3%, clean 86.1%, sung 98.7%; count-only with claps mixed in 83.4% vs
  87.5%). Grading Chris's 68 clean takes against the music (`npm run ml:grade-takes`): 33 at 100%
  (v3: 29), 102 false flags (v3: 109); the "&" said on rests is now heard (10-A 91% → 99%,
  10.5-D 99% → 100%). Still weak: "uh" (heard as "&"; 2 of 18 right held out) and "e" (5 of 26):
  rare in the real takes.
- **v5 (2026-10-19), shipped:** 120 real takes (Chris's 41 new ones added, 10 of them in 6/8) and
  all 5,486 generated takes regenerated under the 6/8 conventions (tempo and clicks by the dotted
  quarter, dotted-quarter tempos 40-90; a dotted quarter counted "1" or "4" alone). Seed 0 of three
  (6000 steps, ~9 min each). Held out on real takes: counts under claps 90.9%, clean 89.4%, sung
  99.1%, claps 99.9%, count-only with claps mixed in 84.9% (not the same held-out set as v4's).
  Grading Chris's 109 clean takes: mean 98%, 46 at 100%; the 41 new ones (unseen by v4, trained on
  by v5) 90.1% → 97.0%, the 10 in 6/8 80.1% → 99.4% (v4 heard fast eighths in 6/8 as "la"/"li"/"&").
  Seeds 1 and 2: 43 and 45 at 100%. Backups: session scratchpad `audio-v5-seed{0,1,2}.json`.
- Steps: `npm run ml:audio-dataset`, then `npm run ml:train-audio`, then
  `node ml/check-audio-model.js` (checks the TypeScript runtime against PyTorch).
  `LIMIT_TAKES=n` trains on n takes per fold (learning curves); runs go in `training-log-audio.csv`.

### Synthetic takes (generated, exact labels)

Made from a sound bank, every track a capture zip with `labels.json`, so any of them opens in the
labeler (`?label`) for checking. They're trained on but never scored: only real takes decide.

1. `python ml/voices.py <piper voices folder> <kokoro folder>`: text-to-speech of every count
   word by ~60 voices from three engines, 6 versions each from quick to drawn out, plus background
   "TV" sentences with no count words in them. Engines: Piper (`pip install piper-tts`, voices from
   huggingface.co/rhasspy/piper-voices, incl. the multi-speaker vctk, l2arctic, arctic, libritts_r
   sets), Kokoro (`pip install kokoro-onnx`, model files from github.com/thewh1teagle/kokoro-onnx
   releases; also blends of two voices) and Windows' own voices. About a third are light voices
   pitched up 3-6 semitones as children. ("ryan" is left out: it cuts short words off.)
2. `npm run ml:sounds`: finishes the bank in `dataset/voices/`: the words (16 kHz, trimmed, vowel
   onset found the way the app finds it; each sung "dah" with its steadiest stretch of vowel and
   that stretch's pitch), 16 of your real claps spread over loudness and brightness plus up to 48
   claps found in free-form recordings in `dataset/clap-recordings/*.wav`, room sound from before
   the count-in of real takes, and the TV talk.
3. `npm run ml:synth` (or `-- --pages 1,18 --wav` for a few pages with plain .wav copies):
   `dataset/synthetic/claps/` has every line clapped (claps only / with the metronome);
   `dataset/synthetic/voices/` has 12 lines per page per variant (counts / with the metronome /
   clap & count the notes / clap & count every beat / sung on "Da"), the voices taking turns.
   Random tempo 60-160 per track. ~20% get a twin with mistakes, listed in
   `dataset/synthetic/index.csv`: two-thirds a few small ones (early, late, missed or extra claps;
   wrong, missed, early, late or extra words; rushing; dragging), sized to the rhythm; a third one
   "structural" mistake of the kinds the feedback engine diagnoses (gave up, stopped, started over,
   came in a beat late or early, sixteenths played as a triplet and said "1-la-li", swung eighths,
   a clap during a long or tied note, a long note cut short).
   Counts follow the conventions in `expectedCounts` (music/rhythm.ts): "count everything" says
   every rest too, held notes are counted through.

How the performances are shaped, from measurements of real takes (`node ml/measure-voice.js
dataset/<student>`; add `--generated dataset/synthetic` to measure generated ones the same way):
- Timing: "perfect" sounds land within a spread of 4.5% of the gap to the nearest note (at most
  12 ms, ~4 ms for fast sixteenths). Each take has its own clap-to-voice lag.
- Counting: a held beat sustains into the next number ("ooonnne-two"); sixteenths run together as
  one sound (100% voiced in real takes); eighths fill 55-85% of the gap (real: 65%); the "e & a"
  are lighter and a little lower than the numbers; quick counting uses the quickly-said clips.
- Singing: one pitch per take (real takes move 0.26 semitones note to note), legato with a light
  "D" and an ~11 dB dip into each note, breaking only at rests; long notes held 70-92%.
- Levels match real takes: claps ~-8 dBFS, words ~29 dB quieter, the metronome clearly audible.
- Backgrounds: real room sound always; sometimes (up to two) mains hum, a fan, a running tap, or a
  muffled TV in another room 10-24 dB under the student.

Known gap: the app's clap detector finds only ~89% of claps in 16 kHz audio (real takes too), so
detector-based checks of the 16 kHz synthetic tracks undercount; the labels themselves are exact.

## What makes it better

More variety beats more takes from the same person: different students (voices, ages), rooms, mics
(Chromebook, headset), metronome on speakers, tempos, and 8th/16th-note lines with "e" and "a".
Deliberate mistakes, labeled, are especially valuable.

## Files

| File | What it is |
|---|---|
| `dataset.js` | Capture zips → `data/dataset.bin` + `data/dataset.json` |
| `augment.js` | Tempo (time-stretch) and voice (pitch-shift) augmentation |
| `training-log.csv` | One row per training run: time taken, data size, results |
| `train.py` | Train, evaluate (leave one take out), export `public/models/counts.json` |
| `zipread.js` | Zip/WAV reading for Node |
| `build.sh` | Compiles the shared app code (features, detectors) for Node |
| `audio-dataset.js` | Capture zips (real and generated) → `data/audio.bin`, `audio-targets.bin`, `audio.json` |
| `train_audio.py` | Train, evaluate (5-fold by real take), export `public/models/audio.json` |
| `check-audio-model.js` | Checks `src/ml/audioModel.ts` gives PyTorch's outputs |
| `training-log-audio.csv` | One row per audio-model run |
| `voices.py` | Text-to-speech count words for synthetic takes |
| `sound-bank.js` | Builds `dataset/voices/` (words, claps, room sound, TV talk) |
| `measure-voice.js` | How a person counts and sings (connectedness, dips, pitch steadiness) |
| `synth.js` | Generates `dataset/synthetic/` takes with exact labels |
| `zips.js` | Finds capture zips in folders, recursively |
