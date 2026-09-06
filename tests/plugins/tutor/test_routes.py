"""HTTP-level tests for the tutor plugin."""

import exercises as ex


def _session_body(key="guitar__open_strings", n=8, **note_kw):
    notes = []
    for i in range(n):
        note = {"t": 4.0 + i, "s": i % 6, "f": 0, "midi": 40, "sus": 0.6, "result": "hit",
                "timing_ms": 5.0, "cents": 4.0, "drift": 0.0, "beat_pos": "on"}
        note.update(note_kw)
        notes.append(note)
    return {"exercise_key": key, "fretless": False, "tolerance_cents": 25, "tolerance_ms": 60,
            "speed": 1.0, "source": "tutor", "notes": notes}


def test_catalog_lists_exercises_with_status(client, dlc):
    r = client.get("/api/plugins/tutor/catalog?instrument=bass")
    assert r.status_code == 200
    body = r.json()
    assert body["dlc_configured"] is True
    assert body["catalog_version"] == ex.CATALOG_VERSION
    assert {e["instrument"] for e in body["exercises"]} == {"bass"}
    assert all(e["status"] == "missing" for e in body["exercises"])
    assert all(e["best_score"] is None and e["sessions"] == 0 for e in body["exercises"])
    assert [s["id"] for s in body["skills"]] == list(ex.SKILLS)


def test_build_writes_packs_and_kicks_rescan(client, dlc, xp_log):
    r = client.post("/api/plugins/tutor/build", json={"keys": ["bass__open_strings", "guitar__open_strings"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert sorted(body["built"]) == ["bass__open_strings", "guitar__open_strings"]
    assert body["failed"] == []
    assert body["rescan_kicked"] is True
    assert ("scan", True) in xp_log
    assert (dlc / "tutor" / "bass__open_strings.sloppak" / "manifest.yaml").is_file()
    cat = client.get("/api/plugins/tutor/catalog").json()["exercises"]
    by_key = {e["key"]: e for e in cat}
    assert by_key["bass__open_strings"]["status"] == "built"
    assert by_key["bass__triplets"]["status"] == "missing"


def test_build_rejects_without_dlc(tmp_path):
    import routes as tutor_routes
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    cfg = tmp_path / "cfg"
    cfg.mkdir()
    tutor_routes.setup(app, {"config_dir": str(cfg), "get_dlc_dir": lambda: None})
    c = TestClient(app)
    assert c.post("/api/plugins/tutor/build", json={}).status_code == 409
    assert c.get("/api/plugins/tutor/catalog").json()["dlc_configured"] is False
    assert c.post("/api/plugins/tutor/build", json={"keys": ["nope"]}).status_code == 409


def test_record_session_returns_profile_and_coaching(client, xp_log):
    r = client.post("/api/plugins/tutor/sessions", json=_session_body())
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["exercise"]["key"] == "guitar__open_strings"
    assert body["profile"]["accuracy"] == 1.0
    assert body["profile"]["score"] >= 90
    assert body["stars"] == 3
    assert body["is_best"] is True
    assert body["recommendations"][0]["id"] == "level-up"
    assert body["xp_awarded"] > 0
    assert any(src == "tutor" for _amt, src in xp_log if src == "tutor")

    hist = client.get("/api/plugins/tutor/sessions?instrument=guitar").json()["sessions"]
    assert len(hist) == 1 and hist[0]["title"] == "Open Strings" and hist[0]["skill"] == "pitch"
    cat = client.get("/api/plugins/tutor/catalog?instrument=guitar").json()["exercises"]
    entry = next(e for e in cat if e["key"] == "guitar__open_strings")
    assert entry["sessions"] == 1 and entry["best_score"] == body["profile"]["score"]


def test_record_session_validation(client):
    assert client.post("/api/plugins/tutor/sessions", json={"exercise_key": "nope", "notes": []}).status_code == 400
    assert client.post("/api/plugins/tutor/sessions", json={"exercise_key": "guitar__open_strings"}).status_code == 400
    assert client.post("/api/plugins/tutor/sessions", content=b"not json",
                       headers={"Content-Type": "application/json"}).status_code == 400
    # Garbage notes are dropped, not fatal; NaN-ish values are nulled.
    body = _session_body(n=2)
    body["notes"].append({"result": "hit", "s": "x", "f": 1})
    body["notes"].append("junk")
    body["notes"][0]["timing_ms"] = "late"
    r = client.post("/api/plugins/tutor/sessions", json=body)
    assert r.status_code == 200
    assert r.json()["profile"]["total"] == 2
    assert r.json()["profile"]["timing"]["n"] == 1


def test_analysis_aggregates_recent_sessions(client):
    empty = client.get("/api/plugins/tutor/analysis?instrument=guitar").json()
    assert empty["sessions_considered"] == 0 and empty["profile"] is None
    assert empty["recommendations"][0]["id"] == "no-data"

    client.post("/api/plugins/tutor/sessions", json=_session_body(timing_ms=-50.0))
    client.post("/api/plugins/tutor/sessions", json=_session_body(key="guitar__quarter_pulse", timing_ms=-45.0))
    client.post("/api/plugins/tutor/sessions", json=_session_body(key="bass__open_strings", timing_ms=0.0))
    body = client.get("/api/plugins/tutor/analysis?instrument=guitar").json()
    assert body["sessions_considered"] == 2
    assert body["profile"]["total"] == 16
    assert {r["id"] for r in body["recommendations"]} >= {"rushing"}
    assert body["skills"]["pitch"]["sessions"] == 1 and body["skills"]["rhythm"]["sessions"] == 1

    assert client.post("/api/plugins/tutor/reset").json() == {"ok": True}
    assert client.get("/api/plugins/tutor/sessions").json()["sessions"] == []
