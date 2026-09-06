"""Mistake profile + recommendation rules."""

import analysis as an
import exercises as ex

CAT = ex.catalog()


def _note(t, s=1, f=5, result="hit", timing=0.0, cents=0.0, drift=None, beat_pos="on"):
    return {"t": t, "s": s, "f": f, "midi": 50, "sus": 0.5, "result": result,
            "timing_ms": timing, "cents": cents, "drift": drift, "beat_pos": beat_pos}


def _session(notes, key="guitar__long_tones", fretless=False, **extra):
    s = {"exercise_key": key, "instrument": key.split("__")[0], "fretless": fretless, "notes": notes}
    s.update(extra)
    return s


def test_region_and_beat_pos_helpers():
    assert an.region_of(0) == "open"
    assert an.region_of(3) == "low"
    assert an.region_of(7) == "mid"
    assert an.region_of(12) == "high"
    assert an.beat_pos_of(2.0, 0.0, 0.5) == "on"
    assert an.beat_pos_of(2.25, 0.0, 0.5) == "off"
    assert an.beat_pos_of(2.17, 0.0, 0.5) == "sub"
    assert an.beat_pos_of(1.0, 0.0, 0) == "on"


def test_tolerances_follow_fretless_flag_unless_overridden():
    assert an.tolerance_cents({"fretless": False}) == an.DEFAULT_TOL_CENTS_FRETTED
    assert an.tolerance_cents({"fretless": True}) == an.DEFAULT_TOL_CENTS_FRETLESS
    assert an.tolerance_cents({"fretless": True, "tolerance_cents": 8}) == 8
    assert an.tolerance_ms({}) == an.DEFAULT_TOL_MS
    assert an.tolerance_ms({"tolerance_ms": 40}) == 40


def test_profile_counts_and_rates():
    notes = [
        _note(1, timing=-90, cents=30),        # early + sharp
        _note(2, timing=10, cents=-30),        # ok + flat
        _note(3, timing=100, cents=5),         # late
        _note(4, result="miss", timing=None, cents=None),
        _note(5, result="skipped", timing=None, cents=None),
    ]
    p = an.profile(_session(notes))
    assert p["total"] == 4 and p["hits"] == 3 and p["misses"] == 1 and p["skipped"] == 1
    assert p["accuracy"] == 0.75
    tm = p["timing"]
    assert tm["n"] == 3 and tm["early_rate"] == round(1 / 3, 3) and tm["late_rate"] == round(1 / 3, 3)
    it = p["intonation"]
    assert it["n"] == 3 and it["sharp_rate"] == round(1 / 3, 3) and it["flat_rate"] == round(1 / 3, 3)
    assert it["by_region"]["mid"]["total"] == 4
    assert 0 <= p["score"] <= 100
    assert an.stars(95) == 3 and an.stars(80) == 2 and an.stars(60) == 1 and an.stars(10) == 0 and an.stars(None) == 0


def test_composite_score_neutral_without_axis_data():
    assert an.composite_score(1.0, None, None) == 100
    assert an.composite_score(1.0, 0.0, 0.0) == 100
    assert an.composite_score(0.5, None, None) == 50
    assert an.composite_score(1.0, 120.0, 50.0) == 50
    assert an.composite_score(None, 0, 0) is None


def test_fretless_tolerance_changes_the_verdict():
    notes = [_note(i, cents=18) for i in range(6)]
    fretted = an.profile(_session(notes, fretless=False))
    fretless = an.profile(_session(notes, fretless=True))
    assert fretted["intonation"]["sharp_rate"] == 0.0
    assert fretless["intonation"]["sharp_rate"] == 1.0


def test_weak_string_detection():
    notes = [_note(i, s=0) for i in range(8)]
    notes += [_note(10 + i, s=3, result="miss", timing=None, cents=None) for i in range(6)]
    notes += [_note(20 + i, s=3) for i in range(2)]
    p = an.profile(_session(notes))
    assert p["weak_strings"] == [3]
    recs = an.recommend(p, ex.find("guitar__long_tones"), CAT)
    ids = [r["id"] for r in recs]
    assert "weak-string-3" in ids
    weak = next(r for r in recs if r["id"] == "weak-string-3")
    assert "String 4" in weak["title"]
    assert weak["exercise_key"] == "guitar__string_skipping"


def test_recommend_slow_down_on_low_accuracy():
    notes = [_note(i, result="miss", timing=None, cents=None) for i in range(6)] + [_note(10)]
    p = an.profile(_session(notes))
    recs = an.recommend(p, ex.find("guitar__long_tones"), CAT)
    assert recs[0]["id"] == "slow-down" and recs[0]["speed"] == 0.7
    assert recs[0]["exercise_key"] == "guitar__long_tones"


def test_recommend_rushing_and_dragging():
    rush = an.profile(_session([_note(i, timing=-40) for i in range(6)]))
    recs = {r["id"] for r in an.recommend(rush, ex.find("guitar__quarter_pulse"), CAT)}
    assert "rushing" in recs and "dragging" not in recs
    drag = an.profile(_session([_note(i, timing=45) for i in range(6)]))
    recs = {r["id"] for r in an.recommend(drag, ex.find("guitar__quarter_pulse"), CAT)}
    assert "dragging" in recs


def test_recommend_offbeat_rush_needs_both_populations():
    notes = [_note(i, timing=0, beat_pos="on") for i in range(5)]
    notes += [_note(10 + i, timing=-40, beat_pos="off") for i in range(5)]
    p = an.profile(_session(notes))
    recs = {r["id"]: r for r in an.recommend(p, ex.find("guitar__offbeats"), CAT)}
    assert "rushing-offbeats" in recs
    assert recs["rushing-offbeats"]["exercise_key"] == "guitar__offbeats"


def test_recommend_sharp_flat_and_drift_fretless_wording():
    sharp = an.profile(_session([_note(i, cents=20) for i in range(6)], fretless=True))
    recs = {r["id"]: r for r in an.recommend(sharp, ex.find("bass__long_tones"), CAT, fretless=True)}
    assert "sharp" in recs and "toward the nut" in recs["sharp"]["reason"]
    assert recs["sharp"]["exercise_key"] == "bass__long_tones"  # the entry's instrument wins

    flat = an.profile(_session([_note(i, cents=-40) for i in range(6)], key="bass__slow_scale"))
    recs = {r["id"]: r for r in an.recommend(flat, ex.find("bass__slow_scale"), CAT)}
    assert "flat" in recs and recs["flat"]["exercise_key"] == "bass__position_shifts"

    drift = an.profile(_session([_note(i, cents=0, drift=12) for i in range(6)]))
    recs = {r["id"] for r in an.recommend(drift, ex.find("guitar__long_tones"), CAT)}
    assert "drift" in recs


def test_recommend_weak_region_targets_high_register_drill():
    notes = [_note(i, f=5, cents=2) for i in range(6)] + [_note(10 + i, f=14, cents=30) for i in range(6)]
    p = an.profile(_session(notes))
    assert p["weak_regions"] == ["high"]
    recs = {r["id"]: r for r in an.recommend(p, ex.find("guitar__slow_scale"), CAT)}
    assert recs["region-high"]["exercise_key"] == "guitar__high_register"


def test_recommend_level_up_when_clean_and_mastered_at_top():
    clean = an.profile(_session([_note(i, timing=5, cents=3) for i in range(8)]))
    recs = an.recommend(clean, ex.find("guitar__long_tones"), CAT)
    assert recs[0]["id"] == "level-up"
    assert recs[0]["exercise_key"] == "guitar__interval_fifths"   # first L2 intonation drill by id
    top = an.recommend(clean, ex.find("guitar__high_register"), CAT)
    assert top[0]["id"] == "mastered" and top[0]["speed"] > 1


def test_recommend_no_data_and_aggregate_keep_going():
    assert an.recommend({"total": 0}, None, CAT)[0]["id"] == "no-data"
    sessions = [_session([_note(i, timing=5, cents=3) for i in range(8)]) for _ in range(3)]
    agg = an.aggregate(sessions)
    assert agg["sessions"] == 3 and agg["total"] == 24
    recs = an.recommend(agg, None, CAT)
    assert recs[0]["id"] == "keep-going"


def test_skill_summary():
    sessions = [
        {"exercise_key": "guitar__long_tones", "profile": {"score": 70}},
        {"exercise_key": "guitar__long_tones", "profile": {"score": 90}},
        {"exercise_key": "guitar__triplets", "profile": {"score": None}},
        {"exercise_key": "nope", "profile": {"score": 1}},
    ]
    s = an.skill_summary(sessions, CAT)
    assert s["intonation"] == {"sessions": 2, "best_score": 90, "last_score": 70}
    assert s["rhythm"] == {"sessions": 1, "best_score": None, "last_score": None}
