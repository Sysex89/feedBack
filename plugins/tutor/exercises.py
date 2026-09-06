"""Tutor exercise catalog + pack builder (Part 1).

Every exercise is a small, generated song package (directory-form sloppak)
with a click track and, for intonation drills, a soft root-note drone. The
catalog is *data*: an exercise is a `(beat, string, fret, duration_beats,
flags)` event list produced by a tiny generator function, and the builder
turns that into the sloppak wire format the highway already understands.

Modelled on the note_detect benchmark builder
(docs/benchmarks/note_detect_v1/build_benchmark.py) and on the drum highway's
"one focused drill per failure mode" approach: each exercise isolates one
skill — pitch/fretboard, rhythm, intonation (fretless-first), technique — so
the analysis layer (analysis.py) can attribute mistakes to a skill and
recommend the next drill.

Pure Python: no ffmpeg (the stem is a WAV the media route already serves
with the right content type), no numpy, no server imports — so the module
is unit-testable in isolation. Manifest keys written here are exactly the
ones the feedpak spec already defines (title/artist/album/year/duration/
arrangements/stems) — no new keys, per the spec-conformance rule.
"""

from __future__ import annotations

import json
import math
import struct
import wave
from pathlib import Path

CATALOG_VERSION = 1

# Standard open-string MIDI, index 0 = lowest string (matches lib/song.py
# _TUNING_BASE_MIDI and the client's tuning-display table).
OPEN_MIDI = {
    "guitar": [40, 45, 50, 55, 59, 64],   # E2 A2 D3 G3 B3 E4
    "bass":   [28, 33, 38, 43],           # E1 A1 D2 G2
}

INSTRUMENTS = ("guitar", "bass")
SKILLS = ("pitch", "rhythm", "intonation", "technique")
SKILL_LABELS = {
    "pitch": "Pitch & fretboard",
    "rhythm": "Rhythm",
    "intonation": "Intonation",
    "technique": "Technique",
}

PACK_SUBDIR = "tutor"          # <DLC>/tutor/<instrument>__<exercise>.sloppak
ARTIST = "FeedBack Tutor"
SAMPLE_RATE = 16000            # click + drone only; small packs, no fidelity needed
INTRO_BARS = 2                 # count-in silence (click only) before the first note
OUTRO_BARS = 1

MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11, 12]


# ── Wire-format helpers ──────────────────────────────────────────────────────

def note(t, s, f, sus=0.0, **flags):
    """Single-note dict in the sloppak wire format (docs/sloppak-spec.md §3.2)."""
    return {
        "t": round(t, 3),
        "s": int(s),
        "f": int(f),
        "sus": round(sus, 3),
        "sl": flags.get("sl", -1),
        "slu": flags.get("slu", -1),
        "bn": flags.get("bn", 0.0),
        "ho": bool(flags.get("ho", False)),
        "po": bool(flags.get("po", False)),
        "hm": bool(flags.get("hm", False)),
        "hp": bool(flags.get("hp", False)),
        "pm": bool(flags.get("pm", False)),
        "mt": bool(flags.get("mt", False)),
        "vb": bool(flags.get("vb", False)),
        "tr": bool(flags.get("tr", False)),
        "ac": bool(flags.get("ac", False)),
        "tp": bool(flags.get("tp", False)),
    }


def chord_note(s, f, sus=0.0, **flags):
    n = note(0.0, s, f, sus, **flags)
    n.pop("t")
    return n


# ── Event model ──────────────────────────────────────────────────────────────
#
# Generators return a list of events. Two shapes:
#   ("n", beat, string, fret, dur_beats, flags_dict)
#   ("c", beat, name, [(string, fret), ...], dur_beats)
# plus section markers:
#   ("sec", beat, "Section name")
# `beat` is relative to the first note (the builder adds the count-in).

def N(beat, s, f, dur=1.0, **flags):
    return ("n", float(beat), int(s), int(f), float(dur), dict(flags))


def C(beat, name, pairs, dur=2.0):
    return ("c", float(beat), str(name), [(int(s), int(f)) for s, f in pairs], float(dur))


def SEC(beat, name):
    return ("sec", float(beat), str(name))


def _string_count(instrument):
    return len(OPEN_MIDI[instrument])


# ── Exercise generators ──────────────────────────────────────────────────────
# Each takes `n` (string count) and returns the event list. Guitar-only drills
# check `n == 6`. Sustain defaults to ~90% of the slot so held notes read as
# held on the highway and give the intonation tracker something to measure.

def gen_open_strings(n):
    seq = list(range(n)) + list(range(n - 2, -1, -1))   # low→high→low, no repeat at top
    ev = [SEC(0, "Open strings")]
    b = 0.0
    for s in seq:
        ev.append(N(b, s, 0, 0.9))
        b += 1
    return ev


def gen_chromatic_walk(n):
    """1-2-3-4 on every string, ascending across strings then descending."""
    ev = [SEC(0, "Ascending")]
    b = 0.0
    for s in range(n):
        for f in (1, 2, 3, 4):
            ev.append(N(b, s, f, 0.9))
            b += 1
    ev.append(SEC(b, "Descending"))
    for s in range(n - 1, -1, -1):
        for f in (4, 3, 2, 1):
            ev.append(N(b, s, f, 0.9))
            b += 1
    return ev


def gen_fifth_position(n):
    ev = [SEC(0, "5th fret, up and down")]
    seq = [(s, 5) for s in range(n)] + [(s, 5) for s in range(n - 2, -1, -1)]
    b = 0.0
    for s, f in seq:
        ev.append(N(b, s, f, 0.9))
        b += 1
    return ev


def gen_octave_jumps(n):
    """Root then its octave two strings up (+2 frets; +3 across the G→B step)."""
    ev = [SEC(0, "Root / octave")]
    b = 0.0
    for s in range(n - 2):
        for root_fret in (3, 5):
            oct_fret = root_fret + (3 if (n == 6 and s + 2 >= 4) else 2)
            ev.append(N(b, s, root_fret, 0.9))
            ev.append(N(b + 1, s + 2, oct_fret, 0.9))
            b += 2
    return ev


def gen_string_skipping(n):
    ev = [SEC(0, "Skip a string")]
    order = []
    for s in range(n - 2):
        order += [(s, 5), (s + 2, 5), (s + 1, 5), (s + 2, 7) if s + 2 < n else (s + 1, 7)]
    b = 0.0
    for s, f in order:
        ev.append(N(b, s, f, 0.9))
        b += 1
    return ev


def gen_quarter_pulse(n):
    """One pitch on every beat, then only on beats 2 & 4 — locks the pulse."""
    s = 1
    ev = [SEC(0, "Every beat")]
    b = 0.0
    for _ in range(16):
        ev.append(N(b, s, 5, 0.5))
        b += 1
    ev.append(SEC(b, "Backbeat only (2 & 4)"))
    for _bar in range(4):
        ev.append(N(b + 1, s, 5, 0.5))
        ev.append(N(b + 3, s, 5, 0.5))
        b += 4
    return ev


def gen_eighth_notes(n):
    ev = [SEC(0, "Straight eighths")]
    b = 0.0
    for bar in range(6):
        s = bar % min(n, 3)
        for k in range(8):
            ev.append(N(b + k * 0.5, s, 5 if k % 2 == 0 else 7, 0.4))
        b += 4
    return ev


def gen_offbeats(n):
    """Notes on the '&' of every beat: the classic rushing trap."""
    ev = [SEC(0, "On the '&'")]
    b = 0.0
    for bar in range(6):
        s = 1 + (bar % 2) if n > 2 else 0
        for k in range(4):
            ev.append(N(b + k + 0.5, s, 7, 0.4))
        b += 4
    return ev


def gen_triplets(n):
    ev = [SEC(0, "Eighth-note triplets")]
    b = 0.0
    third = 1.0 / 3.0
    for bar in range(4):
        s = 1
        frets = (5, 7, 9)
        for beat in range(4):
            for k in range(3):
                ev.append(N(b + beat + k * third, s, frets[k], 0.28))
        b += 4
    return ev


def gen_dotted_rhythm(n):
    """Dotted-quarter + eighth, repeated: long-short-long-short."""
    ev = [SEC(0, "Dotted quarter + eighth")]
    b = 0.0
    for bar in range(6):
        s = 1
        ev.append(N(b, s, 5, 1.3))
        ev.append(N(b + 1.5, s, 7, 0.4))
        ev.append(N(b + 2, s, 5, 1.3))
        ev.append(N(b + 3.5, s, 7, 0.4))
        b += 4
    return ev


def gen_long_tones(n):
    """Four-beat holds in the middle of the neck — the intonation baseline.

    The tracker measures landing pitch and drift across the hold; the drone in
    the audio gives the ear a reference to lean on."""
    ev = [SEC(0, "Long tones")]
    targets = [(1, 5), (2, 5), (1, 7), (2, 7), (0, 5), (n - 1, 5)]
    b = 0.0
    for s, f in targets:
        ev.append(N(b, s, f, 3.6))
        b += 5   # 4-beat hold + 1-beat breath
    return ev


def gen_slow_scale(n):
    """One-octave major scale in position, half notes with long sustains."""
    ev = [SEC(0, "Ascending")]
    root_s, root_f = (1, 5)                  # A major on the A string (guitar) / D on bass
    shape = _scale_shape(n, root_s, root_f)
    b = 0.0
    for s, f in shape:
        ev.append(N(b, s, f, 1.7))
        b += 2
    ev.append(SEC(b, "Descending"))
    for s, f in reversed(shape[:-1]):
        ev.append(N(b, s, f, 1.7))
        b += 2
    return ev


def _scale_shape(n, root_s, root_f):
    """Map a one-octave major scale onto strings from a root, lowest fret first.
    Uses the instrument's real string intervals so it is correct on guitar
    (the G→B major third) and bass alike."""
    instrument = "guitar" if n == 6 else "bass"
    base = OPEN_MIDI[instrument]
    out = []
    root_midi = base[root_s] + root_f
    s = root_s
    for deg in MAJOR_SCALE:
        target = root_midi + deg
        # Prefer the next string when the fret would exceed root_f + 4.
        while s + 1 < n and target - base[s] > root_f + 4:
            s += 1
        out.append((s, target - base[s]))
    return out


def gen_position_shifts(n):
    """Slides up one string to a target — measures landing accuracy after a shift."""
    ev = [SEC(0, "Shifts on one string")]
    s = 1
    frets = [3, 5, 7, 9, 12, 9, 7, 5, 3]
    b = 0.0
    prev = None
    for f in frets:
        if prev is not None:
            # A short note at the old position that slides (sl) into the new
            # one, half a beat ahead of the landing note. The landing note is
            # what the tracker scores; the slide itself is just the road.
            ev.append(N(b - 0.5, s, prev, 0.45, sl=f))
        ev.append(N(b, s, f, 1.4))
        prev = f
        b += 2
    return ev


def gen_high_register(n):
    """Frets 12–17: positions crowd together up the neck, so small hand errors
    become big cents errors (especially fretless)."""
    ev = [SEC(0, "Above the 12th fret")]
    b = 0.0
    for s in range(1, n):
        for f in (12, 14, 15, 17):
            ev.append(N(b, s, f, 1.3))
            b += 1.5
    return ev


def gen_interval_fifths(n):
    """Root–fifth pairs across adjacent strings, held: the fifth must ring pure
    against the root's drone."""
    ev = [SEC(0, "Perfect fifths")]
    b = 0.0
    for s in range(n - 1):
        for f in (3, 5, 7):
            fifth_f = f + (1 if (n == 6 and s + 1 == 4) else 0)
            ev.append(N(b, s, f, 1.7))
            ev.append(N(b + 2, s + 1, fifth_f, 1.7))
            b += 4
    return ev


def gen_hammer_pull(n):
    ev = [SEC(0, "Pick · hammer · pull")]
    b = 0.0
    for bar in range(4):
        s = 1 + (bar % 2)
        ev.append(N(b, s, 5, 0.8))
        ev.append(N(b + 1, s, 7, 0.8, ho=True))
        ev.append(N(b + 2, s, 5, 0.8, po=True))
        b += 4
    return ev


def gen_power_chords(n):
    if n != 6:
        return None
    ev = [SEC(0, "Power chords")]
    voicings = [("E5", [(0, 0), (1, 2)]), ("A5", [(1, 0), (2, 2)]),
                ("D5", [(2, 0), (3, 2)]), ("G5", [(3, 0), (4, 3)])]
    b = 0.0
    for name, pairs in voicings * 2:
        ev.append(C(b, name, pairs, 1.7))
        b += 2
    return ev


def gen_open_chords(n):
    if n != 6:
        return None
    ev = [SEC(0, "Open chords")]
    voicings = [
        ("E", [(0, 0), (1, 2), (2, 2), (3, 1), (4, 0), (5, 0)]),
        ("A", [(1, 0), (2, 2), (3, 2), (4, 2), (5, 0)]),
        ("D", [(2, 0), (3, 2), (4, 3), (5, 2)]),
        ("G", [(0, 3), (1, 2), (2, 0), (3, 0), (4, 0), (5, 3)]),
    ]
    b = 0.0
    for name, pairs in voicings * 2:
        ev.append(C(b, name, pairs, 1.7))
        b += 2
    return ev


# ── Catalog ─────────────────────────────────────────────────────────────────
# (id, title, skill, level, bpm, description, generator, drone?)
_DEFS = [
    ("open_strings", "Open Strings", "pitch", 1, 80,
     "Pluck each open string in time, low to high and back. Clean attacks, let each note ring.",
     gen_open_strings, False),
    ("chromatic_walk", "Chromatic Walk", "pitch", 1, 90,
     "One finger per fret, 1-2-3-4 on every string, up and back down.",
     gen_chromatic_walk, False),
    ("fifth_position", "5th Position", "pitch", 2, 90,
     "The 5th fret on every string. Keep the finger just behind the fret (or exactly on the line if fretless).",
     gen_fifth_position, False),
    ("octave_jumps", "Octave Jumps", "pitch", 2, 80,
     "Root, then its octave two strings up. Great for learning the neck by ear.",
     gen_octave_jumps, False),
    ("string_skipping", "String Skipping", "pitch", 3, 100,
     "Cross over a string without brushing it. Accuracy of the picking hand.",
     gen_string_skipping, False),

    ("quarter_pulse", "Quarter Pulse", "rhythm", 1, 90,
     "One note on every beat, then only on 2 and 4. Feel the click, don't chase it.",
     gen_quarter_pulse, False),
    ("eighth_notes", "Straight Eighths", "rhythm", 2, 90,
     "Even eighth notes. Downbeats and upbeats must be the same length.",
     gen_eighth_notes, False),
    ("dotted_rhythm", "Dotted Rhythm", "rhythm", 2, 90,
     "Long-short, long-short. The short note is exactly one eighth.",
     gen_dotted_rhythm, False),
    ("offbeats", "Off-beats", "rhythm", 3, 90,
     "Every note lands on the '&'. Most players rush these — stay behind the click.",
     gen_offbeats, False),
    ("triplets", "Triplets", "rhythm", 3, 80,
     "Three even notes per beat. Say 'tri-pl-et' along with the click.",
     gen_triplets, False),

    ("long_tones", "Long Tones", "intonation", 1, 70,
     "Hold each note for four beats against the drone. Land in tune and stay there — no drift.",
     gen_long_tones, True),
    ("slow_scale", "Slow Scale", "intonation", 2, 70,
     "A major scale, one note every two beats. Every degree in tune with the drone.",
     gen_slow_scale, True),
    ("interval_fifths", "Perfect Fifths", "intonation", 2, 70,
     "Root then fifth on the next string. A fifth that beats against the drone is out of tune.",
     gen_interval_fifths, True),
    ("position_shifts", "Position Shifts", "intonation", 2, 70,
     "Slide up the string to each new position. The tracker scores where you land, not the slide.",
     gen_position_shifts, True),
    ("high_register", "High Register", "intonation", 3, 80,
     "Frets 12–17, where the spacing gets tight. Small hand errors become big cents errors.",
     gen_high_register, True),

    ("hammer_pull", "Hammer-on / Pull-off", "technique", 2, 90,
     "Pick, hammer, pull. The hammered and pulled notes need the same volume as the picked one.",
     gen_hammer_pull, False),
    ("power_chords", "Power Chords", "technique", 2, 90,
     "Two-string power chords. Mute everything you are not playing.",
     gen_power_chords, False),
    ("open_chords", "Open Chords", "technique", 3, 80,
     "E, A, D, G open chords. Every string must ring — no buzzing under the fingers.",
     gen_open_chords, False),
]


def catalog(instrument: str | None = None) -> list[dict]:
    """The exercise definitions (no audio, no files) — what the UI lists.

    Each entry: id, key (instrument__id), instrument, title, skill, skill_label,
    level, bpm, description, drone, filename (DLC-relative pack path),
    duration (seconds), note_count. Guitar-only drills are omitted for bass."""
    out = []
    for inst in INSTRUMENTS:
        if instrument and inst != instrument:
            continue
        n = _string_count(inst)
        for (eid, title, skill, level, bpm, desc, gen, drone) in _DEFS:
            events = gen(n)
            if events is None:
                continue
            key = f"{inst}__{eid}"
            chart = _events_to_chart(events, bpm, inst)
            out.append({
                "id": eid,
                "key": key,
                "instrument": inst,
                "title": title,
                "skill": skill,
                "skill_label": SKILL_LABELS[skill],
                "level": level,
                "bpm": bpm,
                "description": desc,
                "drone": bool(drone),
                "filename": f"{PACK_SUBDIR}/{key}.sloppak",
                "duration": chart["duration"],
                "note_count": chart["note_count"],
                # Beat grid the in-player tracker uses to tag on/off-beat notes.
                "t0": chart["t0"],
                "spb": round(chart["spb"], 6),
            })
    return out


def find(key: str) -> dict | None:
    for e in catalog():
        if e["key"] == key:
            return e
    return None


def next_level(entry: dict, catalog_list: list[dict] | None = None) -> dict | None:
    """The next-harder drill of the same skill on the same instrument, if any."""
    pool = catalog_list or catalog(entry["instrument"])
    same = sorted((e for e in pool if e["skill"] == entry["skill"]
                   and e["instrument"] == entry["instrument"]),
                  key=lambda e: (e["level"], e["id"]))
    ids = [e["key"] for e in same]
    if entry["key"] not in ids:
        return None
    i = ids.index(entry["key"])
    return same[i + 1] if i + 1 < len(same) else None


# ── Chart assembly ───────────────────────────────────────────────────────────

def _events_to_chart(events, bpm, instrument):
    spb = 60.0 / bpm
    t0 = INTRO_BARS * 4 * spb
    notes, chords, templates, sections = [], [], [], []
    tmpl_index = {}
    n_strings = _string_count(instrument)
    last_end = t0
    note_count = 0
    for ev in events:
        kind = ev[0]
        if kind == "sec":
            sections.append({"name": ev[2], "number": len(sections) + 1,
                             "time": round(t0 + ev[1] * spb, 3)})
            continue
        if kind == "n":
            _, beat, s, f, dur, flags = ev
            if not (0 <= s < n_strings):
                raise ValueError(f"string {s} out of range for {instrument}")
            t = t0 + beat * spb
            notes.append(note(t, s, f, dur * spb, **flags))
            last_end = max(last_end, t + dur * spb)
            note_count += 1
            continue
        if kind == "c":
            _, beat, name, pairs, dur = ev
            if name not in tmpl_index:
                frets = [-1] * n_strings
                for s, f in pairs:
                    frets[s] = f
                tmpl_index[name] = len(templates)
                templates.append({"name": name, "displayName": name, "arp": False,
                                  "fingers": [-1] * n_strings, "frets": frets})
            t = t0 + beat * spb
            chords.append({"t": round(t, 3), "id": tmpl_index[name], "hd": False,
                           "notes": [chord_note(s, f, dur * spb) for s, f in pairs]})
            last_end = max(last_end, t + dur * spb)
            note_count += len(pairs)
            continue
        raise ValueError(f"unknown event kind {kind!r}")

    end_t = last_end + OUTRO_BARS * 4 * spb
    # Round the end to a bar boundary so the click stops cleanly.
    bar_s = 4 * spb
    end_t = math.ceil(end_t / bar_s) * bar_s

    beats = []
    bar = 0
    k = 0
    while k * spb < end_t - 1e-6:
        if k % 4 == 0:
            bar += 1
            beats.append({"time": round(k * spb, 3), "measure": bar})
        else:
            beats.append({"time": round(k * spb, 3), "measure": -1})
        k += 1

    max_fret = max([n["f"] for n in notes] + [cn["f"] for c in chords for cn in c["notes"]] + [0])
    anchor_fret = 1 if max_fret <= 12 else max(1, max_fret - 11)
    anchors = [{"time": 0.0, "fret": anchor_fret, "width": 12}]
    if not sections:
        sections.append({"name": "Exercise", "number": 1, "time": round(t0, 3)})

    return {
        "notes": sorted(notes, key=lambda n: n["t"]),
        "chords": sorted(chords, key=lambda c: c["t"]),
        "templates": templates,
        "sections": sections,
        "beats": beats,
        "anchors": anchors,
        "duration": round(end_t, 3),
        "note_count": note_count,
        "spb": spb,
        "t0": round(t0, 3),
    }


def _root_midi(events, instrument):
    """Drone pitch: the first played note, dropped to a low register."""
    base = OPEN_MIDI[instrument]
    for ev in events:
        if ev[0] == "n":
            m = base[ev[2]] + ev[3]
            while m > base[0] + 12:
                m -= 12
            return m
        if ev[0] == "c":
            s, f = ev[3][0]
            return base[s] + f
    return base[0]


# ── Audio: click track + optional drone ──────────────────────────────────────

def _burst(freq, dur_s, amp):
    n = int(SAMPLE_RATE * dur_s)
    fade = max(1, int(0.003 * SAMPLE_RATE))
    out = [0.0] * n
    for i in range(n):
        env = 1.0
        if i < fade:
            env = i / fade
        elif i >= n - fade:
            env = (n - 1 - i) / fade
        out[i] = math.sin(2 * math.pi * freq * i / SAMPLE_RATE) * amp * env
    return out


def render_audio(duration_s, spb, drone_midi=None, first_note_t=0.0):
    """Float sample list: a click on every beat (downbeat higher + louder),
    plus a soft drone (fundamental + 2 harmonics) from the first note onward."""
    total = int(math.ceil(duration_s * SAMPLE_RATE))
    buf = [0.0] * total
    down = _burst(1500, 0.04, 0.28)
    up = _burst(1000, 0.04, 0.16)
    k = 0
    while k * spb < duration_s:
        click = down if k % 4 == 0 else up
        i0 = int(k * spb * SAMPLE_RATE)
        for j, v in enumerate(click):
            if i0 + j < total:
                buf[i0 + j] += v
        k += 1
    if drone_midi is not None:
        f0 = 440.0 * (2 ** ((drone_midi - 69) / 12.0))
        start = int(first_note_t * SAMPLE_RATE)
        ramp = int(0.5 * SAMPLE_RATE)
        w1, w2, w3 = 2 * math.pi * f0, 2 * math.pi * f0 * 2, 2 * math.pi * f0 * 3
        for i in range(start, total):
            t = i / SAMPLE_RATE
            env = min(1.0, (i - start) / ramp)
            # Fade out over the last half second.
            env *= min(1.0, (total - i) / ramp)
            buf[i] += env * 0.10 * (math.sin(w1 * t) + 0.35 * math.sin(w2 * t) + 0.15 * math.sin(w3 * t))
    return buf


def write_wav(path: Path, samples):
    pcm = bytearray()
    for v in samples:
        s = max(-1.0, min(1.0, v))
        pcm += struct.pack("<h", int(s * 32000))
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(bytes(pcm))


# ── Pack builder ─────────────────────────────────────────────────────────────

def build_pack(entry: dict, dlc_root: Path, force: bool = False) -> Path:
    """Write `<dlc_root>/tutor/<key>.sloppak/` for one catalog entry.

    Idempotent: an existing pack built from the same catalog version is left
    alone unless `force`. Returns the pack directory."""
    inst = entry["instrument"]
    n = _string_count(inst)
    gen = next(d[6] for d in _DEFS if d[0] == entry["id"])
    events = gen(n)
    chart = _events_to_chart(events, entry["bpm"], inst)

    pack = Path(dlc_root) / PACK_SUBDIR / f"{entry['key']}.sloppak"
    stamp = pack / ".tutor-build"
    if pack.is_dir() and not force:
        try:
            if stamp.read_text(encoding="utf-8").strip() == str(CATALOG_VERSION):
                return pack
        except OSError:
            pass
    (pack / "arrangements").mkdir(parents=True, exist_ok=True)
    (pack / "stems").mkdir(parents=True, exist_ok=True)

    arr_id = "bass" if inst == "bass" else "lead"
    arr_name = "Bass" if inst == "bass" else "Lead"
    tuning = [0] * n
    arrangement = {
        "name": arr_name,
        "tuning": tuning,
        "capo": 0,
        "notes": chart["notes"],
        "chords": chart["chords"],
        "anchors": chart["anchors"],
        "handshapes": [],
        "templates": chart["templates"],
        "beats": chart["beats"],
        "sections": chart["sections"],
    }
    manifest = {
        "title": f"{entry['title']} (L{entry['level']})",
        "artist": ARTIST,
        "album": f"{inst.capitalize()} Tutor",
        "year": 2026,
        "duration": chart["duration"],
        "arrangements": [{
            "id": arr_id,
            "name": arr_name,
            "file": f"arrangements/{arr_id}.json",
            "tuning": tuning,
            "capo": 0,
        }],
        "stems": [{"id": "full", "file": "stems/full.wav", "default": True}],
    }
    (pack / "arrangements" / f"{arr_id}.json").write_text(
        json.dumps(arrangement, separators=(",", ":")), encoding="utf-8")
    (pack / "manifest.yaml").write_text(_manifest_yaml(manifest), encoding="utf-8")

    drone = _root_midi(events, inst) if entry.get("drone") else None
    samples = render_audio(chart["duration"], chart["spb"], drone, chart["t0"])
    write_wav(pack / "stems" / "full.wav", samples)
    stamp.write_text(f"{CATALOG_VERSION}\n", encoding="utf-8")
    return pack


def _manifest_yaml(manifest: dict) -> str:
    """Hand-rolled YAML for the flat manifest shape we emit — keeps the builder
    free of a PyYAML import so tests run anywhere. Every value is a scalar, a
    list of scalars, or a list of flat mappings."""
    def scalar(v):
        if isinstance(v, bool):
            return "true" if v else "false"
        if isinstance(v, (int, float)):
            return repr(v) if isinstance(v, float) else str(v)
        return json.dumps(str(v))   # JSON string == YAML double-quoted string
    lines = []
    for k, v in manifest.items():
        if isinstance(v, list) and v and isinstance(v[0], dict):
            lines.append(f"{k}:")
            for item in v:
                first = True
                for ik, iv in item.items():
                    prefix = "  - " if first else "    "
                    first = False
                    if isinstance(iv, list):
                        lines.append(f"{prefix}{ik}: [{', '.join(scalar(x) for x in iv)}]")
                    else:
                        lines.append(f"{prefix}{ik}: {scalar(iv)}")
        elif isinstance(v, list):
            lines.append(f"{k}: [{', '.join(scalar(x) for x in v)}]")
        else:
            lines.append(f"{k}: {scalar(v)}")
    return "\n".join(lines) + "\n"


def pack_status(entry: dict, dlc_root: Path | None) -> str:
    """'built' | 'stale' | 'missing' for the UI."""
    if dlc_root is None:
        return "missing"
    pack = Path(dlc_root) / PACK_SUBDIR / f"{entry['key']}.sloppak"
    if not pack.is_dir():
        return "missing"
    try:
        ok = (pack / ".tutor-build").read_text(encoding="utf-8").strip() == str(CATALOG_VERSION)
    except OSError:
        ok = False
    return "built" if ok else "stale"
