"""Trains the audio model (claps, voice onsets and words, voicing) and exports it for the app.

    python ml/train_audio.py               # evaluate (5 folds by take), then train on all and export
    python ml/train_audio.py --no-export   # evaluate only

Reads ml/data/audio.{bin,json} and audio-targets.bin (from ml/audio-dataset.js)
and writes public/models/audio.json, which src/ml/audioModel.ts runs in the
browser. The network must stay in the layer types audioModel.ts implements:
3x3 conv2d + ReLU, max pool over mels, flatten, conv1d over time (dilated,
optional ReLU and residual).
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
import torch.nn.functional as Fn

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "..", "public", "models", "audio.json")
LOG = os.path.join(HERE, "training-log-audio.csv")
BUDGET_MIN = 30
STARTED = time.time()
SEED = int(os.environ.get("SEED", "0"))
STEPS = int(os.environ.get("STEPS", "3000"))
FOLDS = int(os.environ.get("FOLDS", "5"))
CROP = 500  # frames (5 s) per training example
# Generated takes (ml/synth.js) can outnumber real ones many times over: half of every
# batch comes from real takes, so the real audio keeps its weight.
REAL_SHARE = float(os.environ.get("REAL_SHARE", "0.5"))
BATCH = 32
FRONT = (12, 12)  # conv2d channels
WIDTH = int(os.environ.get("WIDTH", "64"))  # conv1d channels
DILATIONS = (1, 2, 4, 8, 16)
DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")

meta = json.load(open(os.path.join(DATA, "audio.json")))
M = meta["mels"]
SEC = meta["frameSec"]
WORDS = meta["words"]
MEL = np.fromfile(os.path.join(DATA, "audio.bin"), dtype=np.float32).reshape(-1, M)
TGT = np.fromfile(os.path.join(DATA, "audio-targets.bin"), dtype=np.float32).reshape(-1, 4)
takes = meta["takes"]


class Net(nn.Module):
    def __init__(self):
        super().__init__()
        front, c, f = [], 1, M
        for out in FRONT:
            front += [nn.Conv2d(c, out, 3, padding=1), nn.ReLU(), nn.MaxPool2d((1, 2))]
            c, f = out, f // 2
        self.front = nn.Sequential(*front)
        self.proj = nn.Conv1d(c * f, WIDTH, 3, padding=1)
        self.blocks = nn.ModuleList(nn.Conv1d(WIDTH, WIDTH, 3, padding=d, dilation=d) for d in DILATIONS)
        self.drop = nn.Dropout(0.1)
        self.head = nn.Conv1d(WIDTH, 3 + len(WORDS), 1)

    def forward(self, x):  # x: [B, T, M] -> logits [B, 3 + words, T]
        b, t, _ = x.shape
        x = self.front(x[:, None])  # [B, C, T, F]
        x = x.permute(0, 1, 3, 2).reshape(b, -1, t)  # channel c*F + f, as audioModel.ts flattens
        x = Fn.relu(self.proj(x))
        for blk in self.blocks:
            x = x + Fn.relu(blk(self.drop(x)))
        return self.head(x)


def crops(idx, rng):
    """A batch of random CROP-frame windows from the given takes (longer takes picked more often)."""
    real = [i for i in idx if not takes[i].get("generated")]
    gen = [i for i in idx if takes[i].get("generated")]

    def draw(pool, n):
        lengths = np.array([takes[i]["frames"] for i in pool], float)
        return rng.choice(pool, n, p=lengths / lengths.sum()) if n else np.array([], int)

    n_real = BATCH if not gen else BATCH - rng.binomial(BATCH, 1 - REAL_SHARE) if real else 0
    pick = np.concatenate([draw(real, n_real), draw(gen, BATCH - n_real)]).astype(int)
    xb = np.zeros((BATCH, CROP, M), np.float32)
    yb = np.full((BATCH, CROP, 4), -1, np.float32)
    for j, i in enumerate(pick):
        t = takes[i]
        start = rng.integers(0, max(1, t["frames"] - CROP + 1))
        n = min(CROP, t["frames"] - start)
        xb[j, :n] = MEL[t["offset"] + start : t["offset"] + start + n]
        yb[j, :n] = TGT[t["offset"] + start : t["offset"] + start + n]
    # Blank a few mel bands at random (SpecAugment), so no single band is relied on.
    for j in range(BATCH):
        w = rng.integers(0, 6)
        f0 = rng.integers(0, M - w + 1)
        xb[j, :, f0 : f0 + w] = 0
    return torch.tensor(xb, device=DEVICE), torch.tensor(yb, device=DEVICE)


def loss_fn(logits, y, word_weight):
    loss = 0
    for ch, w in ((0, 1.0), (1, 1.0), (2, 0.5)):
        tgt = y[..., ch]
        keep = tgt >= 0
        if keep.any():
            z = logits[:, ch][keep]
            t = tgt[keep]
            # Events are rare frames: weigh them up so the model doesn't learn "never".
            loss = loss + w * (Fn.binary_cross_entropy_with_logits(z, t, reduction="none") * (1 + 9 * t if ch < 2 else 1)).mean()
    word = y[..., 3]
    keep = word >= 0
    if keep.any():
        z = logits[:, 3:].permute(0, 2, 1)[keep]
        loss = loss + Fn.cross_entropy(z, word[keep].long(), weight=word_weight)
    return loss


def train(idx):
    torch.manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    net = Net().to(DEVICE)
    opt = torch.optim.AdamW(net.parameters(), lr=2e-3, weight_decay=1e-3)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=3e-3, total_steps=STEPS, pct_start=0.1)
    words = np.concatenate([TGT[takes[i]["offset"] : takes[i]["offset"] + takes[i]["frames"], 3] for i in idx])
    counts = np.bincount(words[words >= 0].astype(int), minlength=len(WORDS)).astype(np.float32)
    # Rare words count more, but only by the square root (la/li have ~20 examples).
    ww = np.where(counts > 0, np.sqrt(counts.sum() / np.maximum(counts, 1)), 0)
    word_weight = torch.tensor(ww / ww[counts > 0].mean(), dtype=torch.float32, device=DEVICE)
    net.train()
    for step in range(STEPS):
        xb, yb = crops(idx, rng)
        opt.zero_grad()
        loss = loss_fn(net(xb), yb, word_weight)
        loss.backward()
        opt.step()
        sched.step()
    net.eval()
    return net


def outputs(net, i):
    """Per-frame probabilities for a whole take: clap, onset, voiced [T], words [T, W]."""
    t = takes[i]
    x = torch.tensor(MEL[t["offset"] : t["offset"] + t["frames"]][None], device=DEVICE)
    with torch.no_grad():
        z = net(x)[0].cpu().numpy()
    sig = 1 / (1 + np.exp(-z[:3]))
    w = np.exp(z[3:] - z[3:].max(0))
    return sig[0], sig[1], sig[2], (w / w.sum(0)).T


# --- events: the same rules as audioModel.ts ---------------------------------
CLAP_GAP, ONSET_GAP = 5, 6


def peaks(p, thr, gap):
    cand = [i for i in range(len(p)) if p[i] >= thr and (i == 0 or p[i - 1] <= p[i]) and (i + 1 == len(p) or p[i + 1] < p[i])]
    cand.sort(key=lambda i: -p[i])
    kept = []
    for i in cand:
        if all(abs(i - j) >= gap for j in kept):
            kept.append(i)
    return sorted(kept)


def refine(p, i):
    if i <= 0 or i + 1 >= len(p):
        return float(i)
    a, b, c = p[i - 1], p[i], p[i + 1]
    d = a - 2 * b + c
    return i + max(-0.5, min(0.5, 0.5 * (a - c) / d)) if d < 0 else float(i)


def match(pred, truth, within):
    """Greedy nearest matching: pairs (pred index, truth index)."""
    pairs = sorted((abs(p - t), a, b) for a, p in enumerate(pred) for b, t in enumerate(truth) if abs(p - t) <= within)
    used_p, used_t, out = set(), set(), []
    for _, a, b in pairs:
        if a not in used_p and b not in used_t:
            used_p.add(a)
            used_t.add(b)
            out.append((a, b))
    return out


def score(i, out, thr):
    """Held-out results for take i at thresholds thr = (clap, onset)."""
    t = takes[i]
    clap, onset, voiced, words = out
    tgt = TGT[t["offset"] : t["offset"] + t["frames"]]
    r = {}
    for name, p, th, gap, truth, within, ch in (
        ("clap", clap, thr[0], CLAP_GAP, t["claps"], 0.05, 0),
        ("onset", onset, thr[1], ONSET_GAP, [o["t"] for o in t["onsets"]], 0.06, 1),
    ):
        pk = peaks(p, th, gap)
        times = [refine(p, k) * SEC for k in pk]
        m = match(times, truth, within)
        hit = {a for a, _ in m}
        # A prediction on a masked (unknown) frame is neither right nor wrong.
        false = sum(1 for a, k in enumerate(pk) if a not in hit and tgt[k, ch] >= 0)
        r[name] = {"truth": len(truth), "hit": len(m), "false": false, "dt": [times[a] - truth[b] for a, b in m]}
        if name == "onset":
            r["words"] = []
            matched = dict((b, pk[a]) for a, b in m)
            for b, o in enumerate(t["onsets"]):
                k = matched.get(b)
                got, conf = None, 0.0
                if k is not None:
                    p = words[max(0, k - 1) : k + 2].mean(0)
                    got, conf = WORDS[int(p.argmax())], float(p.max())
                r["words"].append({"take": t["name"], "word": o["word"], "got": got, "conf": conf, "probs": dict(zip(WORDS, map(float, p))) if k is not None else None, "underClap": o["underClap"], "vosk": o.get("vosk")})
    return r


def summarize(results, label):
    print(f"{label}:")
    for name in ("clap", "onset"):
        rs = [r[name] for r in results]
        truth, hit, false = sum(x["truth"] for x in rs), sum(x["hit"] for x in rs), sum(x["false"] for x in rs)
        if truth == 0 and false == 0:
            continue
        dt = np.abs([d for x in rs for d in x["dt"]]) * 1000
        prec = hit / max(1, hit + false)
        timing = f", timing vs label median {np.median(dt):.0f} ms, 90% within {np.percentile(dt, 90):.0f} ms" if len(dt) else ""
        print(f"  {name:6s} found {hit}/{truth} ({hit / max(1, truth) * 100:.1f}%), {false} extra (precision {prec * 100:.1f}%){timing}")
    ws = [w for r in results for w in r["words"]]
    for word_set, name in ((lambda w: w["word"] != "sing" and w["underClap"], "counts under a clap"), (lambda w: w["word"] != "sing" and not w["underClap"], "counts, no clap"), (lambda w: w["word"] == "sing", "sung notes")):
        sel = [w for w in ws if word_set(w)]
        if not sel:
            continue
        right = sum(w["got"] == w["word"] for w in sel)
        line = f"  {name:20s} model right {right}/{len(sel)} ({right / len(sel) * 100:.1f}%)"
        if name != "sung notes" and any(w["vosk"] is not None for w in sel):
            v = sum(bool(w["vosk"]) for w in sel)
            line += f"; speech recognition (Vosk) right {v}/{len(sel)} ({v / len(sel) * 100:.1f}%)"
        print(line)
    return ws


def per_word(ws):
    out = {}
    for w in ws:
        if w["word"] == "sing":
            continue
        o = out.setdefault(w["word"], [0, 0, {}])
        o[1] += 1
        if w["got"] == w["word"]:
            o[0] += 1
        elif w["got"]:
            o[2][w["got"]] = o[2].get(w["got"], 0) + 1
    return " ".join(f"{k} {a}/{n}" + (f" ({','.join(f'{g}:{c}' for g, c in sorted(m.items(), key=lambda x: -x[1])[:2])})" if m else "") for k, (a, n, m) in sorted(out.items()))


def export(net, path, thresholds):
    def b64(t):
        return base64.b64encode(t.detach().cpu().numpy().astype("<f4").tobytes()).decode()

    layers = []
    for m in net.front:
        if isinstance(m, nn.Conv2d):
            layers.append({"type": "conv2d", "inC": m.in_channels, "outC": m.out_channels, "w": b64(m.weight), "b": b64(m.bias)})
        elif isinstance(m, nn.MaxPool2d):
            layers.append({"type": "poolf"})
    layers.append({"type": "flatten"})

    def c1(m, relu, residual):
        return {"type": "conv1d", "inC": m.in_channels, "outC": m.out_channels, "k": m.kernel_size[0], "dil": m.dilation[0], "relu": relu, "residual": residual, "w": b64(m.weight), "b": b64(m.bias)}

    layers.append(c1(net.proj, True, False))
    layers += [c1(b, True, True) for b in net.blocks]
    layers.append(c1(net.head, False, False))
    real = [t for t in takes if not t["synthetic"] and not t.get("generated")]
    generated = sum(1 for t in takes if t.get("generated"))
    json.dump(
        {
            "format": "rhythm-tester-audio-model",
            "version": 1,
            "mels": M,
            "frameSec": SEC,
            "words": WORDS,
            "thresholds": {"clap": thresholds[0], "onset": thresholds[1], "voiced": 0.5},
            "trainedOn": f"{len(real)} real takes (+{len(takes) - len(real) - generated} with claps mixed in, +{generated} generated), {sum(t['frames'] for t in takes) * SEC / 60:.0f} min",
            "layers": layers,
        },
        open(path, "w"),
    )


n_params = sum(p.numel() for p in Net().parameters())
print(f"{len(takes)} takes, {len(MEL) * SEC / 60:.1f} min, words {WORDS}, {n_params} parameters, {STEPS} steps, training on {DEVICE}")

# HOLD_VOICES=a,b,c: how well the model copes with voices it never heard. Trains on the
# real takes plus the other generated voices and scores on every generated take of the
# held-out voices (counts, sung notes, claps, mistakes). VOICE_COUNTS=0,5,10,20 also
# trains with only that many of the other voices (a fixed random order; 0 = real
# takes only), to see whether more voices still help.
HOLD = [v for v in os.environ.get("HOLD_VOICES", os.environ.get("HOLD_VOICE", "")).split(",") if v]
if HOLD:
    spk = lambda t: t.get("speaker") or next((v for v in HOLD if f"_{v}_" in t["name"]), None)
    test = [i for i, t in enumerate(takes) if t.get("generated") and spk(t) in HOLD]
    real_idx = [i for i, t in enumerate(takes) if not t.get("generated")]
    claps_idx = [i for i, t in enumerate(takes) if t.get("generated") and t.get("speaker") == "claps"]
    voices = sorted({t["speaker"] for t in takes if t.get("generated") and t.get("speaker") not in (None, "claps", *HOLD)})
    voices = list(np.array(voices)[np.random.RandomState(SEED + 2).permutation(len(voices))])
    counts = [int(n) for n in os.environ.get("VOICE_COUNTS", str(len(voices))).split(",")]
    print(f"held-out voices: {', '.join(HOLD)} ({len(test)} takes); {len(voices)} other voices")
    for n in counts:
        use = set(voices[:n])
        idx = real_idx + (claps_idx if n else []) + [i for i, t in enumerate(takes) if t.get("speaker") in use]
        net = train(idx)
        results = [score(i, outputs(net, i), (0.5, 0.5)) for i in test]
        summarize(results, f"UNHEARD VOICES, trained on real takes + {n} generated voices ({len(idx)} takes)")
        print("  per word:", per_word([w for r in results for w in r["words"]]))
        print(f"  ({(time.time() - STARTED) / 60:.1f} min)", flush=True)
    sys.exit(0)

# Held out: folds of real source takes (a take's clapped copies stay with it).
# Generated takes are always trained on, never scored: only real takes decide.
groups = sorted({t["group"] for t in takes if not t.get("generated")})
order = np.random.RandomState(SEED).permutation(len(groups))
folds = [{groups[j] for j in order[f::FOLDS]} for f in range(FOLDS)]
held = {}
# Learning curve: LIMIT_TAKES=n trains each fold on only n of its training takes
# (a fixed random subset, so bigger n always includes the smaller n's takes).
LIMIT = int(os.environ.get("LIMIT_TAKES", "0"))
subset_order = {g: k for k, g in enumerate(np.array(groups)[np.random.RandomState(SEED + 1).permutation(len(groups))])}
for f, fold in enumerate(folds):
    train_groups = sorted((g for g in groups if g not in fold), key=subset_order.get)
    if LIMIT:
        train_groups = train_groups[:LIMIT]
    net = train([i for i, t in enumerate(takes) if t["group"] in set(train_groups) or (t.get("generated") and "--no-generated" not in sys.argv)])
    for i, t in enumerate(takes):
        if t["group"] in fold:
            held[i] = outputs(net, i)
    print(f"  fold {f + 1}/{FOLDS} done ({(time.time() - STARTED) / 60:.1f} min)")
eval_min = (time.time() - STARTED) / 60

# Thresholds: the best F1 on held-out real takes.
real = [i for i in held if not takes[i]["synthetic"]]


def f1(rs, name):
    truth = sum(r[name]["truth"] for r in rs)
    hit = sum(r[name]["hit"] for r in rs)
    false = sum(r[name]["false"] for r in rs)
    return 2 * hit / max(1, truth + hit + false)


grid = [0.3, 0.4, 0.5, 0.6, 0.7]
best_clap = max(grid, key=lambda th: f1([score(i, held[i], (th, 0.5)) for i in real], "clap"))
best_onset = max(grid, key=lambda th: f1([score(i, held[i], (0.5, th)) for i in real], "onset"))
THR = (best_clap, best_onset)
print(f"thresholds (best held-out F1): clap {best_clap}, onset {best_onset}")

by_activity = {}
for i in real:
    by_activity.setdefault(takes[i]["activity"], []).append(score(i, held[i], THR))
for act, rs in sorted(by_activity.items()):
    summarize(rs, f"HELD OUT {act} ({len(rs)} takes)")
ws = summarize([score(i, held[i], THR) for i in real], f"HELD OUT all real takes ({len(real)})")
print("  per word:", per_word(ws))
synth = [i for i in held if takes[i]["synthetic"]]
if synth:
    summarize([score(i, held[i], THR) for i in synth], f"held out, count-only takes with claps mixed in ({len(synth)})")

# Held-out words with the model's confidence, for choosing how grading trusts them (src/ml/flags.ts).
json.dump(ws, open(os.path.join(DATA, "audio-held-out.json"), "w"))
counts_under = [w for w in ws if w["word"] != "sing" and w["underClap"]]
counts_clean = [w for w in ws if w["word"] != "sing" and not w["underClap"]]
pct = lambda s: sum(w["got"] == w["word"] for w in s) / max(1, len(s)) * 100

if LIMIT:
    print(f"LEARNING CURVE: trained on {LIMIT} takes per fold")
exported = "--no-export" not in sys.argv and not LIMIT
if exported:
    net = train([i for i, t in enumerate(takes) if not t.get("generated") or "--no-generated" not in sys.argv])
    export(net, OUT, THR)
    print(f"exported {OUT} ({os.path.getsize(OUT) // 1024} KB)")
    # For checking audioModel.ts against PyTorch (ml/check-audio-model.js).
    i0 = next(i for i, t in enumerate(takes) if not t["synthetic"])
    clap, onset, voiced, words = outputs(net, i0)
    json.dump({"take": takes[i0]["name"], "clap": clap[:800].tolist(), "onset": onset[:800].tolist(), "voiced": voiced[:800].tolist()}, open(os.path.join(DATA, "audio-check.json"), "w"))

total_min = (time.time() - STARTED) / 60
print(f"training took {total_min:.1f} min on {DEVICE} (evaluation {eval_min:.1f} min)")
if total_min > BUDGET_MIN:
    print(f"WARNING: over the {BUDGET_MIN}-minute budget. Time to rethink the training setup (see ml/README.md).")
claps_all = [score(i, held[i], THR)["clap"] for i in real]
new_log = not os.path.exists(LOG)
with open(LOG, "a", newline="") as fh:
    w = csv.writer(fh)
    if new_log:
        w.writerow(["date", "device", "minutes", "eval_minutes", "takes", "audio_min", "params", "steps", "seed", "clap_recall_pct", "counts_under_clap_pct", "counts_clean_pct", "exported"])
    w.writerow([
        datetime.datetime.now().isoformat(timespec="seconds"),
        torch.cuda.get_device_name(0) if DEVICE.type == "cuda" else "cpu",
        f"{total_min:.2f}", f"{eval_min:.2f}", LIMIT or len(real), f"{len(MEL) * SEC / 60:.1f}", n_params, STEPS, SEED,
        f"{sum(c['hit'] for c in claps_all) / max(1, sum(c['truth'] for c in claps_all)) * 100:.1f}",
        f"{pct(counts_under):.1f}", f"{pct(counts_clean):.1f}", exported,
    ])
