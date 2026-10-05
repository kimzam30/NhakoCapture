"""Synthesise the launch film's soundtrack.

    python3 tools/make-soundtrack.py   ->  docs/launch/soundtrack.wav

A soft pad, a felt-piano arpeggio and quiet UI sounds, timed to the cues in
docs/launch/video.html. Standard library only (plus ffmpeg for the final
loudness pass to -14 LUFS, where the social apps normalise to). Every sound
is generated here, so there is nothing to license.
"""
import math
import random
import struct
import subprocess
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/launch/soundtrack.wav"
RAW = ROOT / "docs/launch/.soundtrack-raw.wav"
SR = 44100
DUR = 36.5
N = int(SR * DUR)
random.seed(7)

L = [0.0] * N
R = [0.0] * N


def hz(note):
    """MIDI note number to frequency."""
    return 440.0 * 2 ** ((note - 69) / 12)


def add(buf, start, samples, gain=1.0):
    i0 = int(start * SR)
    for i, v in enumerate(samples):
        j = i0 + i
        if 0 <= j < N:
            buf[j] += v * gain


def add_st(start, samples, gain=1.0, pan=0.0):
    add(L, start, samples, gain * (1 - pan) * 0.5 + gain * 0.5 * (1 - abs(pan)))
    add(R, start, samples, gain * (1 + pan) * 0.5 + gain * 0.5 * (1 - abs(pan)))


# ---------- instruments ----------

def pluck(freq, dur=1.4, bright=0.35):
    """Felt piano: a few harmonics, quick attack, exponential decay."""
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        a = min(1.0, t / 0.004)
        env = a * math.exp(-t * 3.2)
        w = 2 * math.pi * freq * t
        v = math.sin(w) + bright * math.exp(-t * 6) * math.sin(2 * w) + 0.12 * math.exp(-t * 9) * math.sin(3 * w)
        out.append(v * env)
    return out


def pad(notes, start, end, gain):
    """Detuned sine pairs with slow attack and release."""
    att, rel = 1.2, 1.6
    n = int(SR * (end - start + rel))
    freqs = []
    for m in notes:
        f = hz(m)
        freqs += [f * 0.9985, f * 1.0015]
    for side, buf in ((0, L), (1, R)):
        out = []
        for i in range(n):
            t = i / SR
            env = min(1.0, t / att)
            if t > end - start:
                env *= max(0.0, 1 - (t - (end - start)) / rel)
            v = 0.0
            for k, f in enumerate(freqs):
                v += math.sin(2 * math.pi * f * t + (k * 0.7 if side else 0))
            # slow breathing
            v *= 0.85 + 0.15 * math.sin(2 * math.pi * 0.18 * t + side)
            out.append(v * env / len(freqs))
        add(buf, start, out, gain)


def kick(dur=0.45):
    n = int(SR * dur)
    out, ph = [], 0.0
    for i in range(n):
        t = i / SR
        f = 42 + 70 * math.exp(-t * 28)
        ph += 2 * math.pi * f / SR
        out.append(math.sin(ph) * math.exp(-t * 7) * min(1, t / 0.002))
    return out


def noise_burst(dur, decay, cutoff=0.5):
    """One-pole low-passed noise. cutoff 0..1, lower is darker."""
    n = int(SR * dur)
    out, y = [], 0.0
    for i in range(n):
        t = i / SR
        y += cutoff * (random.uniform(-1, 1) - y)
        out.append(y * math.exp(-t * decay))
    return out


def click(freq=2200, dur=0.05):
    n = int(SR * dur)
    nb = noise_burst(dur, 260, 0.8)
    return [nb[i] * 0.6 + math.sin(2 * math.pi * freq * i / SR) * math.exp(-i / SR * 120) * 0.5 for i in range(n)]


def keycap(dur=0.16):
    n = int(SR * dur)
    nb = noise_burst(dur, 180, 0.6)
    return [nb[i] * 0.5 + math.sin(2 * math.pi * 170 * i / SR) * math.exp(-i / SR * 40) * 0.9 for i in range(n)]


def whoosh(dur=0.9, peak=0.45):
    n = int(SR * dur)
    out, y, y2 = [], 0.0, 0.0
    for i in range(n):
        t = i / SR
        x = t / dur
        env = (x / peak) ** 2 if x < peak else ((1 - x) / (1 - peak)) ** 1.5
        c = 0.02 + 0.10 * env
        y += c * (random.uniform(-1, 1) - y)
        y2 += c * (y - y2)
        out.append(y2 * env * 4)
    return out


def bell(freq, dur=2.6):
    n = int(SR * dur)
    out = []
    for i in range(n):
        t = i / SR
        a = min(1.0, t / 0.003)
        v = (math.sin(2 * math.pi * freq * t) * math.exp(-t * 1.6)
             + 0.35 * math.sin(2 * math.pi * freq * 2.76 * t) * math.exp(-t * 4.5)
             + 0.18 * math.sin(2 * math.pi * freq * 5.4 * t) * math.exp(-t * 8))
        out.append(v * a)
    return out


def sweep_down(dur=0.45, f0=320, f1=70):
    n = int(SR * dur)
    out, ph = [], 0.0
    for i in range(n):
        t = i / SR
        f = f1 + (f0 - f1) * math.exp(-t * 9)
        ph += 2 * math.pi * f / SR
        out.append(math.sin(ph) * math.exp(-t * 6) * min(1, t / 0.01))
    return out


# ---------- the score ----------
# F major, 100 bpm. Chords as MIDI notes (pad voicing, arpeggio tones).
F, Am, Bb, C, Dm, Gm, Csus = (
    ([53, 57, 60, 64, 67], [65, 69, 72, 76, 79]),   # Fmaj9
    ([57, 60, 64, 67], [69, 72, 76, 79, 81]),       # Am7
    ([58, 62, 65, 69], [70, 74, 77, 81, 82]),       # Bbmaj7
    ([48, 55, 60, 64], [67, 72, 74, 76, 79]),       # C(add9)
    ([50, 57, 60, 64], [69, 72, 74, 76, 77]),       # Dm9
    ([55, 58, 62, 65], [67, 70, 74, 77, 79]),       # Gm7
    ([48, 55, 60, 65], [67, 72, 77, 79, 84]),       # Csus4
)
SECTIONS = [
    (0.0, 3.4, F), (3.4, 5.5, F), (5.5, 7.6, Am), (7.6, 10.0, Bb),
    (10.0, 12.4, F), (12.4, 14.7, C), (14.7, 17.2, Dm), (17.2, 19.6, Bb),
    (19.6, 21.8, Gm), (21.8, 23.9, C), (23.9, 26.1, F), (26.1, 28.3, Am),
    (28.3, 30.0, Bb), (30.0, 31.6, Csus), (31.6, 36.5, F),
]
BEAT = 0.6

print("pad")
for a, b, (voicing, _) in SECTIONS:
    pad(voicing, a, b, 0.16)

print("arpeggio")
ARP = [0, 2, 1, 3, 2, 4, 3, 1]
k = 0
t = 3.4
while t < 31.55:
    step = BEAT if t < 10.0 else BEAT / 2
    sec = next(s for s in SECTIONS if s[0] <= t < s[1])
    tones = sec[2][1]
    note = tones[ARP[k % len(ARP)] % len(tones)]
    accent = 1.0 if k % 4 == 0 else 0.72
    add_st(t, pluck(hz(note), 1.3), 0.11 * accent, pan=(-0.35 if k % 2 else 0.35))
    # bass on the bar
    if k % (4 if t < 10 else 8) == 0:
        add_st(t, pluck(hz(sec[2][0][0] - 12), 2.0, 0.2), 0.16)
    t += step
    k += 1

print("pulse")
t = 10.0
while t < 31.4:
    add_st(t, kick(), 0.30)
    t += BEAT * 2

print("effects")
for w in (3.25, 9.75, 23.7, 28.15, 31.4):
    add_st(w, whoosh(0.8), 0.22)
# logo arrival
add_st(0.9, bell(hz(77)), 0.10, 0.1)
add_st(1.0, bell(hz(84)), 0.06, -0.1)
# the shortcut, on screen and then over the window
for kt in (8.7, 8.82, 8.94):
    add_st(kt, keycap(), 0.55)
for kt in (11.1, 11.17, 11.24):
    add_st(kt, keycap(), 0.35)
# the page holds still
add_st(11.35, sweep_down(), 0.35)
# clicks
for c in (15.0, 16.4, 17.55, 17.85, 18.8):
    add_st(c, click(), 0.28)
# copy: click, shutter, confirmation
add_st(20.75, click(1800), 0.32)
add_st(20.8, noise_burst(0.09, 60, 0.55), 0.55, -0.1)
add_st(20.87, noise_burst(0.12, 45, 0.45), 0.45, 0.1)
add_st(21.7, bell(hz(84), 1.6), 0.08)
add_st(21.78, bell(hz(88), 1.6), 0.07)
# nine captures, rising
for i, m in enumerate([72, 74, 77, 79, 81, 84, 86, 89, 91]):
    add_st(24.55 + i * 0.24, pluck(hz(m), 0.6, 0.5), 0.07, pan=(-0.3 + 0.075 * i))
# privacy ticks
for i, m in enumerate([81, 84, 88]):
    add_st(29.3 + i * 0.25, bell(hz(m), 1.2), 0.06)
# end chord
for i, m in enumerate([53, 65, 69, 72, 76, 79]):
    add_st(31.95 + i * 0.03, pluck(hz(m), 4.5, 0.3), 0.12)
add_st(32.0, bell(hz(89), 3.0), 0.05)

print("space")
# a little room: two taps of stereo delay
for buf, d, other in ((L, 0.31, R), (R, 0.43, L)):
    di = int(d * SR)
    src = list(other)
    for i in range(N - 1, di - 1, -1):
        buf[i] += src[i - di] * 0.18

# master: fade the tail, soft clip, write
for i in range(N):
    t = i / SR
    g = 1.0
    if t > DUR - 2.0:
        g = max(0.0, (DUR - t) / 2.0)
    g *= min(1.0, t / 0.05)
    L[i] = math.tanh(L[i] * g * 1.2)
    R[i] = math.tanh(R[i] * g * 1.2)

with wave.open(str(RAW), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(b"".join(struct.pack("<hh", int(l * 30000), int(r * 30000)) for l, r in zip(L, R)))

subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(RAW),
                "-af", "loudnorm=I=-14:TP=-1.5:LRA=9", "-ar", str(SR), str(OUT)], check=True)
RAW.unlink()
print(f"wrote {OUT.relative_to(ROOT)}")
