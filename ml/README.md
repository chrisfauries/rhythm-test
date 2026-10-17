# Models

Small models that help the app hear and see what rule-based detection can't.
The grading itself stays rule-based ([src/analysis/analyze.ts](../src/analysis/analyze.ts)). The models only
report events: which count word was said, and later claps and hand motions.

## The workflow

1. **Capture.** Open the app with `?training` (e.g. `http://localhost:3000/?training`). After each take,
   press **● Capture** and fill in the dialog. You get one zip with the mic audio, the metronome, the
   camera video, every detection, and the app's grading. Put the zips in `ml/captures/`. They're kept
   out of git; the shared copy lives in Google Drive.
2. **Label** (only needed for takes that weren't performed exactly as written). Open the app with
   `?label` and drop in a capture zip. The tracks start filled in with what the app and the count model
   detected; correct them and press **Save labels**. Put the `.labels.json` file next to its zip.
   Takes captured as "As written" need no labels: the notation is the label.
3. **Build the dataset:** `npm run ml:dataset`
4. **Train and evaluate:** `npm run ml:train` (needs Python with `pip install -r ml/requirements.txt`).
   It first trains with each take held out in turn and prints how well the model does on the held-out
   take, then trains on everything and writes `public/models/counts.json`.
5. **Try it:** open the app with `?model=counts`. Compare with the same line without it.

## The count-word model (v1, proof of concept)

- **Job:** on a beat where the student claps and counts at once, the clap's room echo hides the word
  from speech recognition (Vosk recognized 0 of 59 such counts in the first real takes). The model
  says which count word, or none, was spoken there.
- **Input:** a 0.7 s log-mel spectrogram around where an on-time count would start
  ([src/ml/features.ts](../src/ml/features.ts), shared by the app and the pipeline).
- **Network:** three 3×3 conv layers with pooling, then a linear layer: about 25k weights, 99 KB.
  It runs in the browser in plain TypeScript ([src/ml/countModel.ts](../src/ml/countModel.ts)).
- **Use in grading** (`?model=counts` only): for counts under a clap that Vosk missed, the word is
  confirmed, marked wrong, or left on timing-only credit when the model isn't sure. The thresholds are
  in [src/ml/flags.ts](../src/ml/flags.ts). Counts the model judged show a small "AI" tag on the results.
- **Training data so far:** 5 takes, one adult, one room, one webcam mic. That's enough to prove the
  pipeline, not to trust the model with students.

| Held out (v1) | Counts under a clap | Clean counts |
|---|---|---|
| 1-A | 81% | 92% |
| 1-B | 82% | 100% |
| 1-C | 66% | 95% |

On the held-out takes, with the grading thresholds: no correctly said count was marked wrong, 91% were
confirmed, and the rest kept timing-only credit. When a different number was simulated, 79% were
caught as wrong.

## What makes it better

More variety beats more takes from the same person: different students (voices, ages), rooms, mics
(Chromebook, headset), metronome on speakers, tempos, and 8th/16th-note lines with "e" and "a".
Deliberate mistakes, labeled, are especially valuable.

## Files

| File | What it is |
|---|---|
| `dataset.js` | Capture zips → `data/dataset.bin` + `data/dataset.json` |
| `train.py` | Train, evaluate (leave one take out), export `public/models/counts.json` |
| `zipread.js` | Zip/WAV reading for Node |
| `build.sh` | Compiles the shared app code (features, detectors) for Node |
