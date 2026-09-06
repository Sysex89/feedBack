"""Tutor mistake analysis + recommendations (Part 2).

Input is a *session*: one play-through of one exercise, as recorded by the
in-player tracker (screen.js). Every chart note gets one record::

    {
      "t": 6.0, "s": 1, "f": 5, "midi": 50, "sus": 2.4,
      "result": "hit" | "miss" | "skipped",     # skipped = song stopped before it
      "timing_ms": -18.0 | None,                # signed attack error, + = late
      "cents": +9.5 | None,                     # signed landing pitch, + = sharp
      "drift": -4.0 | None,                     # cents change over the hold
      "beat_pos": "on" | "off" | "sub",         # where the note sits in the beat
    }

plus session-level context (instrument, fretless, tolerances, exercise key).

Three layers, all pure functions over dicts so they are testable without a
server or a browser:

* :func:`profile` — turns one session into a mistake profile: note accuracy,
  timing tendency (rush/drag, consistency, on- vs off-beat), intonation
  (sharp/flat, drift, per-string, per-neck-region) and the weak spots.
* :func:`aggregate` — the same profile over many sessions (recent history).
* :func:`recommend` — rule-based coaching: what to practise next and why.

Intonation is a first-class axis (not just "wrong note") because on a
fretless bass/guitar a note can be the *right* note and still 20 cents out —
the drum-highway style hit/miss window alone would call that a hit.
"""

from __future__ import annotations

import math
import statistics

REGION_LABELS = {"open": "open strings", "low": "frets 1–4", "mid": "frets 5–11", "high": "12th fret and up"}
BEAT_LABELS = {"on": "downbeats", "off": "off-beats", "sub": "subdivisions"}

DEFAULT_TOL_MS = 60.0
DEFAULT_TOL_CENTS_FRETTED = 25.0
DEFAULT_TOL_CENTS_FRETLESS = 12.0
MIN_SAMPLES = 4           # don't diagnose a tendency from fewer notes than this


def region_of(fret) -> str:
    f = int(fret or 0)
    if f <= 0:
        return "open"
    if f <= 4:
        return "low"
    if f <= 11:
        return "mid"
    return "high"


def beat_pos_of(t: float, t0: float, spb: float) -> str:
    """Where a note sits in the beat: on the beat, on the '&', or elsewhere."""
    if not spb or spb <= 0:
        return "on"
    frac = ((t - t0) / spb) % 1.0
    if frac < 0.08 or frac > 0.92:
        return "on"
    if abs(frac - 0.5) < 0.08:
        return "off"
    return "sub"


def tolerance_cents(session: dict) -> float:
    tol = session.get("tolerance_cents")
    if isinstance(tol, (int, float)) and tol > 0:
        return float(tol)
    return DEFAULT_TOL_CENTS_FRETLESS if session.get("fretless") else DEFAULT_TOL_CENTS_FRETTED


def tolerance_ms(session: dict) -> float:
    tol = session.get("tolerance_ms")
    if isinstance(tol, (int, float)) and tol > 0:
        return float(tol)
    return DEFAULT_TOL_MS


# ── helpers ─────────────────────────────────────────────────────────────────

def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _stats(values):
    vals = [float(v) for v in values if _num(v)]
    if not vals:
        return {"n": 0, "mean": None, "median": None, "std": None, "mean_abs": None}
    return {
        "n": len(vals),
        "mean": round(statistics.fmean(vals), 2),
        "median": round(statistics.median(vals), 2),
        "std": round(statistics.pstdev(vals), 2) if len(vals) > 1 else 0.0,
        "mean_abs": round(statistics.fmean(abs(v) for v in vals), 2),
    }


def _rate(k, n):
    return round(k / n, 3) if n else None


def _clamp01(x):
    return max(0.0, min(1.0, x))


# ── profile ─────────────────────────────────────────────────────────────────

def _tag_notes(session: dict) -> list[dict]:
    """Annotate each note with the tolerances of *its* session so notes from
    different sessions (fretless vs fretted) can be pooled."""
    tol_c = tolerance_cents(session)
    tol_t = tolerance_ms(session)
    out = []
    for n in session.get("notes") or []:
        if not isinstance(n, dict):
            continue
        m = dict(n)
        m["_tol_c"] = tol_c
        m["_tol_t"] = tol_t
        m["_region"] = region_of(m.get("f"))
        if m.get("beat_pos") not in BEAT_LABELS:
            m["beat_pos"] = "on"
        out.append(m)
    return out


def _profile_notes(notes: list[dict]) -> dict:
    played = [n for n in notes if n.get("result") in ("hit", "miss")]
    hits = [n for n in played if n["result"] == "hit"]
    total = len(played)

    # Timing: only hits carry a meaningful attack time.
    timed = [n for n in hits if _num(n.get("timing_ms"))]
    early = sum(1 for n in timed if n["timing_ms"] < -n["_tol_t"])
    late = sum(1 for n in timed if n["timing_ms"] > n["_tol_t"])
    timing = _stats(n["timing_ms"] for n in timed)
    timing.update({
        "early_rate": _rate(early, len(timed)),
        "late_rate": _rate(late, len(timed)),
        "on_time_rate": _rate(len(timed) - early - late, len(timed)),
        "by_beat_pos": {},
    })
    for bp in BEAT_LABELS:
        sub = [n for n in timed if n.get("beat_pos") == bp]
        if sub:
            st = _stats(n["timing_ms"] for n in sub)
            st["late_rate"] = _rate(sum(1 for n in sub if n["timing_ms"] > n["_tol_t"]), len(sub))
            st["early_rate"] = _rate(sum(1 for n in sub if n["timing_ms"] < -n["_tol_t"]), len(sub))
            timing["by_beat_pos"][bp] = st

    # Intonation: landing pitch on hits; drift across the hold.
    tuned = [n for n in hits if _num(n.get("cents"))]
    sharp = sum(1 for n in tuned if n["cents"] > n["_tol_c"])
    flat = sum(1 for n in tuned if n["cents"] < -n["_tol_c"])
    inton = _stats(n["cents"] for n in tuned)
    inton.update({
        "sharp_rate": _rate(sharp, len(tuned)),
        "flat_rate": _rate(flat, len(tuned)),
        "in_tune_rate": _rate(len(tuned) - sharp - flat, len(tuned)),
        "drift": _stats(n["drift"] for n in tuned if _num(n.get("drift"))),
        "by_string": {},
        "by_region": {},
    })
    for key, field in (("by_string", "s"), ("by_region", "_region")):
        groups = {}
        for n in played:
            groups.setdefault(str(n.get(field)), []).append(n)
        for gk, gnotes in sorted(groups.items()):
            g_hits = [n for n in gnotes if n["result"] == "hit"]
            g_tuned = [n for n in g_hits if _num(n.get("cents"))]
            st = _stats(n["cents"] for n in g_tuned)
            st["hit_rate"] = _rate(len(g_hits), len(gnotes))
            st["total"] = len(gnotes)
            st["sharp_rate"] = _rate(sum(1 for n in g_tuned if n["cents"] > n["_tol_c"]), len(g_tuned))
            st["flat_rate"] = _rate(sum(1 for n in g_tuned if n["cents"] < -n["_tol_c"]), len(g_tuned))
            inton[key][gk] = st

    accuracy = _rate(len(hits), total)
    weak_strings = []
    if accuracy is not None:
        for sk, st in inton["by_string"].items():
            if st["total"] >= MIN_SAMPLES and st["hit_rate"] is not None and st["hit_rate"] < accuracy - 0.15:
                weak_strings.append(int(sk))
    weak_regions = []
    overall_abs = inton.get("mean_abs")
    for rk, st in inton["by_region"].items():
        if st["n"] >= MIN_SAMPLES and st["mean_abs"] is not None and overall_abs is not None \
                and st["mean_abs"] > max(overall_abs * 1.5, overall_abs + 5):
            weak_regions.append(rk)

    return {
        "total": total,
        "hits": len(hits),
        "misses": total - len(hits),
        "skipped": sum(1 for n in notes if n.get("result") == "skipped"),
        "accuracy": accuracy,
        "timing": timing,
        "intonation": inton,
        "weak_strings": weak_strings,
        "weak_regions": weak_regions,
        "score": composite_score(accuracy, timing.get("mean_abs"), inton.get("mean_abs")),
    }


def composite_score(accuracy, timing_mean_abs_ms, cents_mean_abs) -> int | None:
    """0–100: half notes, a quarter rhythm, a quarter intonation. Axes the
    session carries no data for are scored as neutral rather than zero, so a
    session without pitch tracking is not punished for it."""
    if accuracy is None:
        return None
    parts = [(0.5, accuracy)]
    parts.append((0.25, _clamp01(1.0 - timing_mean_abs_ms / 120.0) if _num(timing_mean_abs_ms) else accuracy))
    parts.append((0.25, _clamp01(1.0 - cents_mean_abs / 50.0) if _num(cents_mean_abs) else accuracy))
    return int(round(100 * sum(w * v for w, v in parts)))


def stars(score) -> int:
    if score is None:
        return 0
    return 3 if score >= 90 else 2 if score >= 75 else 1 if score >= 60 else 0


def profile(session: dict) -> dict:
    """Mistake profile for a single session."""
    prof = _profile_notes(_tag_notes(session))
    prof["sessions"] = 1
    prof["exercise_key"] = session.get("exercise_key")
    prof["fretless"] = bool(session.get("fretless"))
    return prof


def aggregate(sessions: list[dict]) -> dict:
    """One profile over many sessions (each note keeps its own tolerances)."""
    notes = []
    for s in sessions:
        notes.extend(_tag_notes(s))
    prof = _profile_notes(notes)
    prof["sessions"] = len(sessions)
    prof["fretless"] = any(bool(s.get("fretless")) for s in sessions)
    return prof


# ── recommendations ─────────────────────────────────────────────────────────

def _find(catalog, instrument, exercise_id):
    for e in catalog:
        if e["instrument"] == instrument and e["id"] == exercise_id:
            return e
    return None


def _rec(rid, priority, title, reason, exercise=None, tip=None, speed=None):
    r = {"id": rid, "priority": priority, "title": title, "reason": reason}
    if exercise:
        r["exercise_key"] = exercise["key"]
        r["exercise_title"] = exercise["title"]
    if tip:
        r["tip"] = tip
    if speed:
        r["speed"] = speed
    return r


def recommend(prof: dict, entry: dict | None, catalog: list[dict], fretless: bool = False) -> list[dict]:
    """Rule-based coaching from a profile. `entry` is the exercise the profile
    was scored on (None for an aggregate). Returns recommendations ordered by
    priority (1 = do this first)."""
    recs = []
    inst = (entry or {}).get("instrument") or _guess_instrument(catalog, prof)
    ex = lambda eid: _find(catalog, inst, eid)  # noqa: E731
    acc = prof.get("accuracy")
    tm = prof.get("timing") or {}
    it = prof.get("intonation") or {}
    hand = "toward the nut" if fretless else "closer to the fret wire"

    if acc is None or prof.get("total", 0) == 0:
        return [_rec("no-data", 9, "Play an exercise to get coaching",
                     "No scored notes yet. Run any drill with your instrument plugged in.")]

    # 1. Notes: accuracy first — nothing else matters until the notes are there.
    if acc < 0.6:
        recs.append(_rec("slow-down", 1, "Slow it down",
                         f"Only {int(acc * 100)}% of notes landed. Practise the same drill at 70% speed until it is clean, then bring the tempo back up.",
                         entry, speed=0.7))
    elif acc < 0.85:
        recs.append(_rec("repeat", 2, "Repeat this drill",
                         f"{int(acc * 100)}% of notes landed. One or two more passes at 85% speed should make it stick.",
                         entry, speed=0.85))

    for s in prof.get("weak_strings") or []:
        st = it["by_string"].get(str(s), {})
        recs.append(_rec(f"weak-string-{s}", 2, f"String {s + 1} is your weak string",
                         f"Only {int((st.get('hit_rate') or 0) * 100)}% hit rate on string {s + 1} (lowest = 1) versus {int(acc * 100)}% overall.",
                         ex("string_skipping") or ex("chromatic_walk"),
                         tip="Slow down and watch the picking hand cross to that string."))

    # 2. Rhythm: a tendency (mean) needs enough notes; inconsistency is the std.
    if tm.get("n", 0) >= MIN_SAMPLES:
        mean = tm["mean"]
        if mean > 25:
            recs.append(_rec("dragging", 2, "You are dragging",
                             f"On average you play {int(mean)} ms behind the click. Anticipate the beat — start the motion before you hear it.",
                             ex("quarter_pulse")))
        elif mean < -25:
            recs.append(_rec("rushing", 2, "You are rushing",
                             f"On average you play {int(-mean)} ms ahead of the click. Relax and let the click come to you.",
                             ex("quarter_pulse")))
        if tm.get("std") is not None and tm["std"] > 45:
            recs.append(_rec("timing-consistency", 3, "Timing is inconsistent",
                             f"Your attacks scatter by ±{int(tm['std'])} ms. Lock in with steady quarter notes before adding subdivisions.",
                             ex("quarter_pulse") or ex("eighth_notes")))
        bp = tm.get("by_beat_pos") or {}
        off = bp.get("off")
        on = bp.get("on")
        if off and off["n"] >= MIN_SAMPLES and on and on["n"] >= MIN_SAMPLES \
                and off["mean"] is not None and on["mean"] is not None and off["mean"] - on["mean"] < -25:
            recs.append(_rec("rushing-offbeats", 3, "Off-beats rush",
                             f"Your off-beat notes land {int(on['mean'] - off['mean'])} ms earlier than your downbeats. Count the '&' out loud.",
                             ex("offbeats")))
        sub = bp.get("sub")
        if sub and sub["n"] >= MIN_SAMPLES and sub.get("std") is not None and sub["std"] > 50:
            recs.append(_rec("uneven-subdivisions", 3, "Subdivisions are uneven",
                             "Triplets and dotted figures are not evenly spaced yet.",
                             ex("triplets") or ex("dotted_rhythm")))

    # 3. Intonation — the fretless axis. Direction first, then drift, then where.
    if it.get("n", 0) >= MIN_SAMPLES:
        sharp, flat = it.get("sharp_rate") or 0, it.get("flat_rate") or 0
        mean_c = it.get("mean") or 0
        if sharp >= 0.3 and sharp > flat:
            recs.append(_rec("sharp", 2, "You land sharp",
                             f"{int(sharp * 100)}% of notes are sharp (average {mean_c:+.0f}¢). Your finger is landing past the pitch — shift the hand slightly {hand}.",
                             ex("long_tones") if fretless else ex("position_shifts"),
                             tip="Play against the drone and listen for the beating to slow down and stop."))
        elif flat >= 0.3 and flat > sharp:
            recs.append(_rec("flat", 2, "You land flat",
                             f"{int(flat * 100)}% of notes are flat (average {mean_c:+.0f}¢). Reach a little further up the neck for each note.",
                             ex("long_tones") if fretless else ex("position_shifts"),
                             tip="Play against the drone and listen for the beating to slow down and stop."))
        elif it.get("std") is not None and it["std"] > 18 and (it.get("in_tune_rate") or 1) < 0.7:
            recs.append(_rec("intonation-scatter", 3, "Intonation is inconsistent",
                             f"Notes scatter ±{int(it['std'])}¢ around the pitch with no clear direction. Slow, held notes will settle the hand.",
                             ex("long_tones")))
        drift = (it.get("drift") or {})
        if drift.get("n", 0) >= MIN_SAMPLES and drift.get("mean") is not None and abs(drift["mean"]) > 8:
            direction = "sharp" if drift["mean"] > 0 else "flat"
            recs.append(_rec("drift", 3, f"Held notes drift {direction}",
                             f"Across a sustain your pitch moves {drift['mean']:+.0f}¢. Keep the finger pressure and position steady for the whole hold.",
                             ex("long_tones")))
        for rk in prof.get("weak_regions") or []:
            st = it["by_region"].get(rk, {})
            target = ex("high_register") if rk == "high" else ex("slow_scale") if rk == "mid" else ex("chromatic_walk")
            recs.append(_rec(f"region-{rk}", 3, f"Intonation slips on {REGION_LABELS.get(rk, rk)}",
                             f"Average error there is {st.get('mean_abs')}¢ versus {it.get('mean_abs')}¢ overall.",
                             target))

    # 4. Nothing wrong? Move up.
    if not recs and entry is not None:
        nxt = _next_level(entry, catalog)
        if nxt:
            recs.append(_rec("level-up", 1, "Level up",
                             f"Clean run: {int(acc * 100)}% notes, in time and in tune. Move on to the next drill of this skill.",
                             nxt))
        else:
            recs.append(_rec("mastered", 1, "Skill mastered — for now",
                             "That was the top drill of this skill. Try a different skill, or the same one faster.",
                             entry, speed=1.15))
    elif not recs:
        recs.append(_rec("keep-going", 4, "Keep going",
                         "No clear weaknesses in your recent sessions. Mix skills to keep the picture fresh."))

    recs.sort(key=lambda r: r["priority"])
    seen = set()
    out = []
    for r in recs:
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(r)
    return out[:6]


def _next_level(entry, catalog):
    same = sorted((e for e in catalog if e["skill"] == entry["skill"] and e["instrument"] == entry["instrument"]),
                  key=lambda e: (e["level"], e["id"]))
    keys = [e["key"] for e in same]
    if entry["key"] not in keys:
        return None
    i = keys.index(entry["key"])
    return same[i + 1] if i + 1 < len(same) else None


def _guess_instrument(catalog, prof):
    key = prof.get("exercise_key") or ""
    if "__" in key:
        return key.split("__", 1)[0]
    return "guitar"


def skill_summary(sessions: list[dict], catalog: list[dict]) -> dict:
    """Per-skill snapshot for the dashboard: best score + session count."""
    by_key = {e["key"]: e for e in catalog}
    out = {}
    for s in sessions:
        e = by_key.get(s.get("exercise_key"))
        if not e:
            continue
        sc = (s.get("profile") or {}).get("score")
        slot = out.setdefault(e["skill"], {"sessions": 0, "best_score": None, "last_score": None})
        slot["sessions"] += 1
        if sc is not None:
            slot["best_score"] = sc if slot["best_score"] is None else max(slot["best_score"], sc)
            if slot["last_score"] is None:
                slot["last_score"] = sc
    return out
