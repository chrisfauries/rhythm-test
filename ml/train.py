"""Trains the count-word model and exports it for the app.

    python ml/train.py            # evaluate (leave one take out), then train on all and export

Reads ml/data/dataset.{bin,json} (from ml/dataset.js) and writes
public/models/counts.json, which src/ml/countModel.ts runs in the browser.
The network must stay in the layer types countModel.ts implements:
3x3 conv + ReLU, 2x2 max pool, global average pool, linear.
"""
import base64
import json
import os
import sys

import numpy as np
import torch
import torch.nn as nn

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "..", "public", "models", "counts.json")
EPOCHS = 80
SEED = 0

meta = json.load(open(os.path.join(DATA, "dataset.json")))
T, M = meta["frames"], meta["mels"]
X = np.fromfile(os.path.join(DATA, "dataset.bin"), dtype=np.float32).reshape(-1, 1, T, M)
ex = meta["examples"]
CLASSES = sorted({e["label"] for e in ex}, key=lambda c: (c != "none", c))
y = np.array([CLASSES.index(e["label"]) for e in ex])
takes = np.array([e["take"] for e in ex])
kinds = np.array([e["kind"] for e in ex])
synthetic = np.array([e["synthetic"] for e in ex])
CHANNELS = (16, 32, 48)


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
    xb = xb.clone()
    for i in range(xb.shape[0]):
        t = np.random.randint(0, 8)
        t0 = np.random.randint(0, T - t + 1)
        xb[i, :, t0 : t0 + t, :] = 0
        f = np.random.randint(0, 6)
        f0 = np.random.randint(0, M - f + 1)
        xb[i, :, :, f0 : f0 + f] = 0
    return xb


def train(idx):
    torch.manual_seed(SEED)
    np.random.seed(SEED)
    net = Net(len(CLASSES))
    opt = torch.optim.Adam(net.parameters(), lr=2e-3, weight_decay=1e-3)
    # Balance classes so "none" and rare words still count.
    counts = np.bincount(y[idx], minlength=len(CLASSES)).astype(np.float32)
    weight = torch.tensor(np.where(counts > 0, counts.sum() / np.maximum(counts, 1) / len(CLASSES), 0), dtype=torch.float32)
    loss_fn = nn.CrossEntropyLoss(weight=weight)
    Xt, yt = torch.tensor(X[idx]), torch.tensor(y[idx])
    for epoch in range(EPOCHS):
        net.train()
        perm = torch.randperm(len(idx))
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
        return torch.softmax(net(torch.tensor(X[idx])), 1).numpy()


def predict(net, idx):
    return probs(net, idx).argmax(1)


def export(net, path):
    def b64(t):
        return base64.b64encode(t.detach().numpy().astype("<f4").tobytes()).decode()

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
            "trainedOn": f"{len(meta['takes'])} takes, {len(ex)} patches",
            "layers": layers,
        },
        open(path, "w"),
    )


print(f"{len(ex)} patches, classes {CLASSES}")

# Leave one take out: train without a take, test on its real (not synthetic) patches.
results = []
held_out = []
for take in meta["takes"]:
    test = np.where((takes == take) & ~synthetic & np.isin(kinds, ["masked", "clean"]))[0]
    if len(test) == 0:
        continue
    net = train(np.where(takes != take)[0])
    pred = predict(net, test)
    held_out += [{"take": take, "kind": str(kinds[i]), "label": CLASSES[y[i]], "probs": dict(zip(CLASSES, map(float, p)))} for i, p in zip(test, probs(net, test))]
    for kind in ("masked", "clean"):
        k = test[kinds[test] == kind]
        if len(k):
            acc = (pred[kinds[test] == kind] == y[k]).mean()
            results.append((take, kind, len(k), acc))
            wrong = [f"{CLASSES[y[i]]}->{CLASSES[p]}" for i, p in zip(k, pred[kinds[test] == kind]) if p != y[i]]
            print(f"  held out {take[:40]:40s} {kind:7s} {acc*100:5.1f}% of {len(k)}  {' '.join(wrong[:8])}")
for kind in ("masked", "clean"):
    r = [(n, a) for _, k, n, a in results if k == kind]
    if r:
        total = sum(n for n, _ in r)
        print(f"LEAVE-ONE-TAKE-OUT {kind}: {sum(n * a for n, a in r) / total * 100:.1f}% of {total}")

# Held-out probabilities, for choosing how grading uses the model.
json.dump(held_out, open(os.path.join(DATA, "held_out.json"), "w"))

if "--no-export" not in sys.argv:
    net = train(np.arange(len(ex)))
    export(net, OUT)
    print(f"exported {OUT} ({os.path.getsize(OUT) // 1024} KB)")
