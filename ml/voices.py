"""Speaks every count word with many text-to-speech voices, for synthetic takes.

    python ml/voices.py <Piper voices folder> <Kokoro model folder>

Three engines, so the model doesn't learn one engine's sound:
  - Piper (pip install piper-tts; voices from huggingface.co/rhasspy/piper-voices)
  - Kokoro (pip install kokoro-onnx; kokoro-v1.0.onnx and voices-v1.0.bin from
    github.com/thewh1teagle/kokoro-onnx/releases)
  - Windows' built-in voices (System.Speech), when on Windows

Writes raw clips to ml/data/tts-raw/<speaker>/<word>-<n>.wav, background "TV"
sentences (no count words in them) to ml/data/tts-raw/chatter/, and
ml/data/tts-raw/speakers.json. ml/sound-bank.js then trims them, makes the
child voices, and writes the finished bank to dataset/voices/.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "tts-raw")
PIPER = sys.argv[1] if len(sys.argv) > 1 else "."
KOKORO = sys.argv[2] if len(sys.argv) > 2 else "."

# What to type to get each count syllable said the way students say it.
WORDS = {
    "one": "one", "two": "two", "three": "three", "four": "four", "five": "five", "six": "six",
    "seven": "seven", "eight": "eight", "nine": "nine", "ten": "ten", "eleven": "eleven", "twelve": "twelve",
    "and": "and", "e": "ee", "a": "uh", "la": "lah", "li": "lee",
    # The sung syllable (synth.js holds it for the note's length).
    "da": "dah",
}
# Each word 6 times, from quick (for fast subdivisions) to drawn out. Speed is
# relative: 1.6 = 60% faster than the voice's normal pace.
SPEEDS = [1.6, 1.35, 1.2, 1.05, 0.95, 0.85]
TRIES = 12

# Who speaks. "semitones" makes a child voice out of a light adult one (in sound-bank.js).
KOKORO_VOICES = [
    ("af_heart", 0), ("af_bella", 0), ("af_nicole", 0), ("af_sarah", 0), ("af_river", 0), ("af_jessica", 0),
    ("am_adam", 0), ("am_michael", 0), ("am_eric", 0), ("am_liam", 0), ("am_onyx", 0), ("bf_emma", 0),
    ("bm_george", 0), ("bm_lewis", 0), ("bm_daniel", 0),
    # Children (light voices, pitched up).
    ("af_sky", 4), ("af_kore", 4), ("bf_lily", 3), ("bf_alice", 4), ("af_nova", 5), ("am_puck", 5), ("am_echo", 6),
]
# Blends of two voices: new speakers that no single voice is.
KOKORO_BLENDS = [("af_aoede", "am_fenrir", 0.5, 0), ("bf_isabella", "af_alloy", 0.5, 3), ("am_santa", "bm_fable", 0.4, 0), ("af_heart", "bf_emma", 0.5, 5)]
PIPER_VOICES = [
    # (model, speaker id or None, semitones)
    ("en_US-amy-medium", None, 0), ("en_US-joe-medium", None, 0), ("en_GB-northern_english_male-medium", None, 0),
    ("en_US-lessac-medium", None, 0), ("en_US-hfc_male-medium", None, 0), ("en_US-john-medium", None, 0),
    ("en_US-norman-medium", None, 0), ("en_US-kusal-medium", None, 0), ("en_US-ljspeech-medium", None, 0),
    ("en_US-reza_ibrahim-medium", None, 0), ("en_GB-southern_english_female-low", None, 0), ("en_GB-alba-medium", None, 0),
    ("en_US-bryce-medium", None, 0), ("en_US-mike-medium", None, 0),
    ("en_GB-vctk-medium", 3, 0), ("en_GB-vctk-medium", 40, 0), ("en_GB-vctk-medium", 75, 0),
    ("en_US-l2arctic-medium", 2, 0), ("en_US-l2arctic-medium", 11, 0), ("en_US-l2arctic-medium", 20, 0),
    ("en_US-arctic-medium", 4, 0), ("en_GB-aru-medium", 5, 0), ("en_GB-semaine-medium", 1, 0),
    ("en_US-libritts_r-medium", 120, 0), ("en_US-libritts_r-medium", 350, 0),
    # Children.
    ("en_US-libritts_r-medium", 52, 4), ("en_US-libritts_r-medium", 9, 5), ("en_US-kristin-medium", None, 4),
    ("en_US-hfc_female-medium", None, 4), ("en_GB-jenny_dioco-medium", None, 3), ("en_GB-cori-medium", None, 4),
    ("en_GB-vctk-medium", 60, 5), ("en_US-arctic-medium", 9, 4), ("en_US-libritts_r-medium", 600, 5),
]
WINDOWS_VOICES = [("Microsoft David Desktop", 0), ("Microsoft Zira Desktop", 0), ("Microsoft Zira Desktop", 4)]

# Background TV / radio talk. No count words in it ("one", "two", "and", ...).
CHATTER = [
    "Good evening, here is the weather for tonight.",
    "Clouds will move in from the west by morning.",
    "Traffic is slow near the bridge this afternoon.",
    "The city council met late on Tuesday.",
    "Our reporter is live at the scene.",
    "Fans waited outside the stadium for hours.",
    "Scientists say the results were surprising.",
    "Coming up after the break, a look at local schools.",
    "Prices at the grocery store rose again this month.",
    "The storm brought heavy rain to the coast.",
    "Police are asking drivers to avoid the area.",
    "The museum opens its new exhibit this weekend.",
    "Officials expect the road work to last until spring.",
    "Thanks for joining us, we will be right back.",
    "A new restaurant opened downtown last week.",
    "Temperatures will drop below freezing overnight.",
    "The team won its game in overtime.",
    "Residents gathered at the park for the festival.",
    "Experts recommend checking smoke alarms twice a year.",
    "Stay tuned for the latest sports highlights.",
]


def ending_db(x, sr):
    """How loud the last 20 ms are, relative to the peak (dB)."""
    n = int(0.02 * sr)
    e = [(x[i : i + n] ** 2).mean() + 1e-12 for i in range(0, len(x) - n, n)]
    return 10 * np.log10(e[-1] / max(e))


def cut_off(x, sr):
    """Whether the voice stops while still loud (the engine cut the word short)."""
    return ending_db(x, sr) > -25


def save(path, x, sr):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def read(path):
    with wave.open(path, "rb") as w:
        x = np.frombuffer(w.readframes(w.getnframes()), "<i2").astype(np.float32) / 32768
        if w.getnchannels() == 2:
            x = x[::2]
        return x, w.getframerate()


# --- engines: each returns speak(text, speed, k) -> (samples, rate) -------------------
def piper_engine(model, speaker_id, cache={}):
    from piper import PiperVoice, SynthesisConfig

    voice = cache.setdefault(model, PiperVoice.load(os.path.join(PIPER, model + ".onnx")))

    def speak(text, speed, k):
        # Piper's own variation, a bit different every try.
        noise = [0.5, 0.667, 0.8, 0.9][k % 4]
        cfg = SynthesisConfig(speaker_id=speaker_id, length_scale=1 / speed, noise_scale=noise, noise_w_scale=0.6 + 0.1 * (k % 4))
        chunks = list(voice.synthesize(text, syn_config=cfg))
        return np.concatenate([c.audio_float_array for c in chunks]), chunks[0].sample_rate

    return speak


_kokoro = None


def kokoro_engine(style):
    global _kokoro
    from kokoro_onnx import Kokoro

    if _kokoro is None:
        _kokoro = Kokoro(os.path.join(KOKORO, "kokoro-v1.0.onnx"), os.path.join(KOKORO, "voices-v1.0.bin"))
    if isinstance(style, tuple):
        a, b, w = style
        style = _kokoro.get_voice_style(a) * (1 - w) + _kokoro.get_voice_style(b) * w
    lang = "en-gb" if isinstance(style, str) and style[0] == "b" else "en-us"

    def speak(text, speed, k):
        # Kokoro is deterministic, so vary the speed a little more between tries.
        x, sr = _kokoro.create(text, voice=style, speed=min(2.0, speed * (1 + 0.03 * (k // 6))), lang=lang)
        return np.asarray(x, np.float32), sr

    return speak


def windows_engine(name):
    def speak(text, speed, k):
        out = os.path.join(tempfile.gettempdir(), f"rt-sapi-{os.getpid()}.wav")
        rate = int(round(np.clip(np.log2(speed) * 6, -10, 10)))
        ps = (
            "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.SelectVoice('{name}'); $s.Rate = {rate}; $s.SetOutputToWaveFile('{out}'); $s.Speak('{text}'); $s.Dispose()"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, capture_output=True)
        return read(out)

    return speak


def speakers():
    for voice, st in KOKORO_VOICES:
        yield {"name": f"kokoro-{voice}" + (f"-child" if st else ""), "engine": "kokoro", "model": voice, "semitones": st}, lambda v=voice: kokoro_engine(v)
    for a, b, w, st in KOKORO_BLENDS:
        yield {"name": f"kokoro-{a}+{b}" + (f"-child" if st else ""), "engine": "kokoro", "model": f"{a}+{b} ({w:.0%})", "semitones": st}, lambda a=a, b=b, w=w: kokoro_engine((a, b, w))
    for model, sid, st in PIPER_VOICES:
        short = model.split("-")[1]
        name = f"piper-{short}" + (f"-{sid}" if sid is not None else "") + ("-child" if st else "")
        yield {"name": name, "engine": "piper", "model": model, "speakerId": sid, "semitones": st}, lambda m=model, s=sid: piper_engine(m, s)
    if os.name == "nt":
        for voice, st in WINDOWS_VOICES:
            yield {"name": "windows-" + voice.split()[1].lower() + ("-child" if st else ""), "engine": "windows", "model": voice, "semitones": st}, lambda v=voice: windows_engine(v)


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    meta = []
    voices_for_chatter = []
    for spk, make in speakers():
        speak = make()
        skipped = 0
        for word, text in WORDS.items():
            n = 0
            best = None
            for k in range(TRIES):
                x, sr = speak(text, SPEEDS[k % len(SPEEDS)], k)
                if len(x) < 0.05 * sr:
                    continue
                if cut_off(x, sr):
                    skipped += 1
                    if best is None or ending_db(x, sr) < ending_db(*best):
                        best = (x, sr)
                    continue
                n += 1
                save(os.path.join(OUT, spk["name"], f"{word}-{n}.wav"), x, sr)
                if n == len(SPEEDS):
                    break
            if n == 0:
                # Never a clean ending (some voices clip words like "ten"): keep the least clipped.
                save(os.path.join(OUT, spk["name"], f"{word}-1.wav"), *best)
                n = 1
            if n < len(SPEEDS):
                print(f"  {spk['name']}: only {n} clean takes of '{word}'")
        meta.append(spk)
        if not spk["semitones"] and spk["engine"] != "windows":
            voices_for_chatter.append(speak)
        print(f"{spk['name']}: {spk['engine']} {spk['model']}{f' speaker {spk.get('speakerId')}' if spk.get('speakerId') is not None else ''} ({skipped} cut-off tries skipped)", flush=True)
    # Background talk: every sentence, by a few different adult voices.
    rng = np.random.default_rng(1)
    for i, text in enumerate(CHATTER):
        for j in range(3):
            speak = voices_for_chatter[rng.integers(len(voices_for_chatter))]
            x, sr = speak(text, 1.0, 0)
            save(os.path.join(OUT, "chatter", f"chatter-{i * 3 + j + 1:02d}.wav"), x, sr)
    json.dump({"words": list(WORDS), "speakers": meta, "chatter": len(CHATTER) * 3}, open(os.path.join(OUT, "speakers.json"), "w"), indent=1)
    print(f"{len(meta)} voices, {len(CHATTER) * 3} chatter clips")


if __name__ == "__main__":
    main()
