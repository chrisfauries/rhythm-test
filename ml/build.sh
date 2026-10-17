#!/bin/sh
# Compiles the app code the ML scripts share (feature extraction) for Node.
cd "$(dirname "$0")/.." && npx tsc --outDir ml/.build --rootDir src --module commonjs --target es2019 --skipLibCheck --esModuleInterop --downlevelIteration src/ml/features.ts src/ml/countModel.ts src/audio/ClapDetector.ts src/audio/clapClassifier.ts
