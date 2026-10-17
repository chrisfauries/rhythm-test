"""Trains the count-word model and exports it for the app.

    python ml/train.py            # evaluate (leave one take out), then train on all and export
    python ml/train.py --no-augment   # same, without the tempo/voice-augmented copies (for comparison)

Reads ml/data/dataset.{bin,json} (from ml/dataset.js) and writes
public/models/counts.json, which src/ml/countModel.ts runs in the browser.
The network must stay in the layer types countModel.ts implements:
3x3 conv + ReLU, 2x2 max pool, global average pool, linear.
"""
import base64
import csv
import datetime
import json
import os
import sys
import time

import numpy as np
import torch
import torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "..", "public", "models", "counts.json")
# Every run is logged here (time taken, data size, results), so training cost is tracked as data grows.
LOG = os.path.join(HERE, "training-log.csv")
BUDGET_MIN = 30  # rethink the setup (fewer copies, fewer folds, bigger batches) when a run goes past this
STARTED = time.time()
EPOCHS = 80
SEED = int(os.environ.get("SEED", "0"))
# Trains on an NVIDIA GPU when PyTorch was installed with CUDA (see README), else on the CPU.
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

meta = json.load(open(os.path.join(DATA, "dataset.json")))
T, M = meta["frames"], meta["mels"]
X = np.fromfile(os.path.join(DATA, "dataset.bin"), dtype=np.float32).reshape(-1, 1, T, M)
ex = meta["examples"]
CLASSES = sorted({e["label"] for e in ex}, key=lambda c: (c != "none", c))
y = np.array([CLASSES.index(e["label"]) for e in ex])
takes = np.array([e["take"] for e in ex])
kinds = np.array([e["kind"] for e in ex])
synthetic = np.array([e["synthetic"] for e in ex])
# Tempo/voice-augmented copies (ml/augment.js): "" for the original audio.
aug = np.array([e.get("aug", "") for e in ex])
tempo = np.array([e.get("tempo", 0) for e in ex])
pitched = np.array([e.get("semitones", 0) > 0 for e in ex])
# Train on the augmented copies when the dataset has them (AUGMENT=1 npm run ml:dataset), unless --no-augment.
AUGMENT = "--no-augment" not in sys.argv and bool((aug != "").any())
usable = np.ones(len(ex), bool) if AUGMENT else aug == ""
CHANNELS = tuple(int(c) for c in os.environ.get("CHANNELS", "16,32,48").split(","))


class Net(nn.Module):
    def __init__(self, n_classes):
        super().__init__()
        layers, c = [], 1
        for out in CHANNELS:
            layers += [nn.Conv2d(c, out, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2)]
            c = out
        self.features = nn.Sequential(*layers)
        self.drop = nn.Dropout(0.3)
        self.fc = nn.Linear(c, n_classes)

    def forward(self, x):
        x = self.features(x).mean(dim=(2, 3))
        return self.fc(self.drop(x))


def spec_augment(xb):
    """Blank a random stretch of time (up to 7 frames) and of frequency (up to 5 bands) in each patch."""
    n = xb.shape[0]
    t = torch.randint(0, 8, (n, 1), device=xb.device)
    t0 = (torch.rand(n, 1, device=xb.device) * (T - t + 1)).long()
    f = torch.randint(0, 6, (n, 1), device=xb.device)
    f0 = (torch.rand(n, 1, device=xb.device) * (M - f + 1)).long()
    ti = torch.arange(T, device=xb.device)[None, :]
    fi = torch.arange(M, device=xb.device)[None, :]
    keep_t = ~((ti >= t0) & (ti < t0 + t))
    keep_f = ~((fi >= f0) & (fi < f0 + f))
    return xb * (keep_t[:, None, :, None] & keep_f[:, None, None, :])


def train(idx):
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    net = Net(len(CLASSES)).to(DEVICE)
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-3)
    # Balance classes so "none" and rare words still count.
    counts = np.bincount(y[idx], minlength=len(CLASSES)).astype(np.float32)
    weight = torch.tensor(np.where(counts > 0, counts.sum() / np.maximum(counts, 1) / len(CLASSES), 0), dtype=torch.float32, device=DEVICE)
    loss_fn = nn.CrossEntropyLoss(weight=weight)
    Xt, yt = torch.tensor(X[idx], device=DEVICE), torch.tensor(y[idx], device=DEVICE)
    for epoch in range(EPOCHS):
        net.train()
        perm = torch.randperm(len(idx), device=DEVICE)
        for b in range(0, len(idx), 32):
            sel = perm[b : b + 32]
            opt.zero_grad()
            loss = loss_fn(net(spec_augment(Xt[sel])), yt[sel])
            loss.backward()
            opt.step()
    net.eval()
    return net


def probs(net, idx):
    with torch.no_grad():
        return torch.softmax(net(torch.tensor(X[idx], device=DEVICE)), 1).cpu().numpy()


def predict(net, idx):
    return probs(net, idx).argmax(1)


def export(net, path):
    def b64(t):
        return base64.b64encode(t.detach().cpu().numpy().astype("<f4").tobytes()).decode()

    layers = []
    for m in net.features:
        if isinstance(m, nn.Conv2d):
            layers.append({"type": "conv", "inC": m.in_channels, "outC": m.out_channels, "w": b64(m.weight), "b": b64(m.bias)})
        elif isinstance(m, nn.MaxPool2d):
            layers.append({"type": "pool"})
    layers.append({"type": "gap"})
    layers.append({"type": "linear", "in": net.fc.in_features, "out": net.fc.out_features, "w": b64(net.fc.weight), "b": b64(net.fc.bias)})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    json.dump(
        {
            "format": "rhythm-tester-count-model",
            "version": 1,
            "classes": CLASSES,
            "frames": T,
            "mels": M,
            "trainedOn": f"{len(meta['takes'])} takes, {usable.sum()} patches{'' if AUGMENT else ', no augmentation'}",
            "layers": layers,
        },
        open(path, "w"),
    )


print(f"{usable.sum()} patches{'' if AUGMENT else ' (augmentation off)'}, classes {CLASSES}, training on {DEVICE}")

# Held-out evaluation: train without some takes (and all their augmented copies), test on
# their real patches: the original audio, then separately their other-tempo/higher-voice
# copies. Leave one take out while there are few takes; past FOLDS_ABOVE takes that is
# too many trainings, so the takes are split into FOLDS groups instead (each take is
# still tested by a model that never heard it).
FOLDS = int(os.environ.get("FOLDS", "5"))
FOLDS_ABOVE = 15
names = list(meta["takes"])
if len(names) > FOLDS_ABOVE:
    order = np.random.RandomState(SEED).permutation(len(names))
    folds = [[names[i] for i in order[f::FOLDS]] for f in range(FOLDS)]
else:
    folds = [[n] for n in names]
results = []
held_out = []
robust = {}


def evaluate(net, take, real, test):
    for i, p in zip(np.where(real & (aug != ""))[0], predict(net, np.where(real & (aug != ""))[0])):
        key = (f"{tempo[i]} bpm{' + higher voice' if pitched[i] else ''}", str(kinds[i]))
        robust.setdefault(key, []).append(p == y[i])
    pred = predict(net, test)
    held_out.extend([{"take": take, "kind": str(kinds[i]), "label": CLASSES[y[i]], "probs": dict(zip(CLASSES, map(float, p)))} for i, p in zip(test, probs(net, test))])
    for kind in ("masked", "clean"):
        k = test[kinds[test] == kind]
        if len(k):
            acc = (pred[kinds[test] == kind] == y[k]).mean()
            results.append((take, kind, len(k), acc))
            wrong = [f"{CLASSES[y[i]]}->{CLASSES[p]}" for i, p in zip(k, pred[kinds[test] == kind]) if p != y[i]]
            print(f"  held out {take[:40]:40s} {kind:7s} {acc*100:5.1f}% of {len(k)}  {' '.join(wrong[:8])}")


for fold in folds:
    net = None
    for take in fold:
        real = (takes == take) & ~synthetic & np.isin(kinds, ["masked", "clean"])
        test = np.where(real & (aug == ""))[0]
        if len(test) == 0:
            continue
        if net is None:
            net = train(np.where(~np.isin(takes, fold) & usable)[0])
        evaluate(net, take, real, test)
EVAL = "leave-one-take-out" if len(folds) == len(names) else f"{len(folds)}-fold by take"

overall = {}
for kind in ("masked", "clean"):
    r = [(n, a) for _, k, n, a in results if k == kind]
    if r:
        total = sum(n for n, _ in r)
        overall[kind] = sum(n * a for n, a in r) / total * 100
        print(f"{EVAL.upper()} {kind}: {overall[kind]:.1f}% of {total}")
loto_min = (time.time() - STARTED) / 60

if robust:
    print("Held-out takes, augmented (how the model copes with other tempos and voices):")
    for (name, kind), hits in sorted(robust.items()):
        print(f"  {name:28s} {kind:7s} {np.mean(hits)*100:5.1f}% of {len(hits)}")

# Held-out probabilities, for choosing how grading uses the model.
json.dump(held_out, open(os.path.join(DATA, "held_out.json"), "w"))

exported = "--no-export" not in sys.argv
if exported:
    net = train(np.where(usable)[0])
    export(net, OUT)
    print(f"exported {OUT} ({os.path.getsize(OUT) // 1024} KB)")

total_min = (time.time() - STARTED) / 60
print(f"training took {total_min:.1f} min on {DEVICE} (leave-one-take-out {loto_min:.1f} min)")
if total_min > BUDGET_MIN:
    print(f"WARNING: over the {BUDGET_MIN}-minute budget. Time to rethink the training setup (see ml/README.md).")
new_log = not os.path.exists(LOG)
with open(LOG, "a", newline="") as f:
    w = csv.writer(f)
    if new_log:
        w.writerow(["date", "device", "minutes", "loto_minutes", "takes", "patches", "channels", "augment", "seed", "masked_pct", "clean_pct", "exported"])
    w.writerow([
        datetime.datetime.now().isoformat(timespec="seconds"),
        torch.cuda.get_device_name(0) if DEVICE.type == "cuda" else "cpu",
        f"{total_min:.2f}", f"{loto_min:.2f}", len(meta["takes"]), int(usable.sum()), "-".join(map(str, CHANNELS)),
        AUGMENT, SEED, f"{overall.get('masked', 0):.1f}", f"{overall.get('clean', 0):.1f}", exported,
    ])
