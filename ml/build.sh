#!/bin/sh
# Compiles the app code the ML scripts share (feature extraction) for Node.
cd "$(dirname "$0")/.." && npx tsc --outDir ml/.build --rootDir src --module commonjs --target es2019 --skipLibCheck --esModuleInterop --downlevelIteration src/ml/features.ts src/ml/countModel.ts src/music/book.ts src/music/activity.ts src/audio/click.ts src/debug/zip.ts src/ml/audioModel.ts src/analysis/analyze.ts src/analysis/feedback.ts src/audio/voice.ts src/audio/ClapDetector.ts src/audio/clapClassifier.ts
