"""Tutor plugin backend: exercise catalog + pack builder + session store + coaching.

Endpoints (all under /api/plugins/tutor/):
  GET  catalog?instrument=       exercises with build status + personal bests
  POST build                     {instrument?, keys?, force?} → writes packs into <DLC>/tutor/
  POST sessions                  one scored play-through → stored; returns profile + coaching
  GET  sessions?instrument=&key=&limit=
  GET  analysis?instrument=      aggregate profile + recommendations over recent sessions
  POST reset                     wipe the session history

State lives in <config_dir>/tutor/tutor.db (sqlite, WAL) — declared in
plugin.json settings.server_files so it rides the Settings export.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

RECENT_SESSIONS_FOR_ANALYSIS = 12
MAX_NOTES_PER_SESSION = 2000

_state = {
    "db_path": None,
    "log": logging.getLogger("feedBack.plugin.tutor"),
    "get_dlc_dir": None,
    "award_xp": None,
    "exercises": None,
    "analysis": None,
    "kick_scan": None,
}
_build_lock = threading.Lock()


# ── persistence ─────────────────────────────────────────────────────────────

def _conn():
    if not _state["db_path"]:
        raise RuntimeError("tutor plugin not initialised")
    conn = sqlite3.connect(_state["db_path"], timeout=5)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL")
    except sqlite3.DatabaseError:
        pass
    return conn


def _init_db():
    conn = _conn()
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                exercise_key TEXT    NOT NULL,
                instrument   TEXT    NOT NULL,
                fretless     INTEGER NOT NULL DEFAULT 0,
                score        INTEGER,
                accuracy     REAL,
                payload      TEXT    NOT NULL,
                profile      TEXT    NOT NULL,
                created_at   INTEGER NOT NULL
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS sessions_key_idx ON sessions(exercise_key, created_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS sessions_inst_idx ON sessions(instrument, created_at DESC)")
        conn.commit()
    finally:
        conn.close()


def _row_summary(row) -> dict:
    return {
        "id": row["id"],
        "exercise_key": row["exercise_key"],
        "instrument": row["instrument"],
        "fretless": bool(row["fretless"]),
        "score": row["score"],
        "accuracy": row["accuracy"],
        "created_at": row["created_at"],
    }


def _recent_sessions(instrument: str | None, key: str | None, limit: int):
    conn = _conn()
    try:
        sql = "SELECT * FROM sessions"
        where, args = [], []
        if instrument:
            where.append("instrument = ?")
            args.append(instrument)
        if key:
            where.append("exercise_key = ?")
            args.append(key)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY created_at DESC, id DESC LIMIT ?"
        args.append(int(limit))
        return conn.execute(sql, args).fetchall()
    finally:
        conn.close()


def _best_by_key(instrument: str | None) -> dict:
    conn = _conn()
    try:
        sql = ("SELECT exercise_key, MAX(score) AS best, COUNT(*) AS n, MAX(created_at) AS last "
               "FROM sessions")
        args = []
        if instrument:
            sql += " WHERE instrument = ?"
            args.append(instrument)
        sql += " GROUP BY exercise_key"
        return {r["exercise_key"]: {"best_score": r["best"], "sessions": r["n"], "last_played": r["last"]}
                for r in conn.execute(sql, args).fetchall()}
    finally:
        conn.close()


# ── validation ──────────────────────────────────────────────────────────────

def _num(v, default=None):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    if v != v or v in (float("inf"), float("-inf")):
        return default
    return float(v)


def _clean_session(raw: dict, exercises) -> tuple[dict | None, str | None]:
    if not isinstance(raw, dict):
        return None, "session must be an object"
    key = raw.get("exercise_key")
    entry = exercises.find(key) if isinstance(key, str) else None
    if entry is None:
        return None, "unknown exercise_key"
    notes_in = raw.get("notes")
    if not isinstance(notes_in, list):
        return None, "notes must be a list"
    notes = []
    for n in notes_in[:MAX_NOTES_PER_SESSION]:
        if not isinstance(n, dict):
            continue
        result = n.get("result")
        if result not in ("hit", "miss", "skipped"):
            continue
        s = n.get("s")
        f = n.get("f")
        if isinstance(s, bool) or not isinstance(s, int) or isinstance(f, bool) or not isinstance(f, int):
            continue
        notes.append({
            "t": _num(n.get("t"), 0.0),
            "s": s,
            "f": f,
            "midi": n.get("midi") if isinstance(n.get("midi"), int) else None,
            "sus": _num(n.get("sus"), 0.0),
            "result": result,
            "timing_ms": _num(n.get("timing_ms")),
            "cents": _num(n.get("cents")),
            "drift": _num(n.get("drift")),
            "beat_pos": n.get("beat_pos") if n.get("beat_pos") in ("on", "off", "sub") else "on",
        })
    session = {
        "exercise_key": key,
        "instrument": entry["instrument"],
        "fretless": bool(raw.get("fretless")),
        "tolerance_cents": _num(raw.get("tolerance_cents")),
        "tolerance_ms": _num(raw.get("tolerance_ms")),
        "speed": _num(raw.get("speed"), 1.0),
        "source": raw.get("source") if isinstance(raw.get("source"), str) else "tutor",
        "notes": notes,
    }
    return session, None


# ── setup ───────────────────────────────────────────────────────────────────

def setup(app, context):
    config_dir = Path(context["config_dir"])
    base = config_dir / "tutor"
    base.mkdir(parents=True, exist_ok=True)
    _state["db_path"] = str(base / "tutor.db")
    _state["log"] = context.get("log") or _state["log"]
    _state["get_dlc_dir"] = context.get("get_dlc_dir")
    _state["award_xp"] = context.get("award_xp")
    load_sibling = context.get("load_sibling")
    if load_sibling:
        _state["exercises"] = load_sibling("exercises")
        _state["analysis"] = load_sibling("analysis")
    else:  # tests / standalone: fall back to plain sibling imports
        import analysis as _analysis  # noqa: WPS433
        import exercises as _exercises  # noqa: WPS433
        _state["exercises"] = _exercises
        _state["analysis"] = _analysis
    _state["kick_scan"] = context.get("kick_scan") or _find_kick_scan()
    _init_db()
    log = _state["log"]
    exercises = _state["exercises"]
    analysis = _state["analysis"]

    def _dlc():
        fn = _state["get_dlc_dir"]
        try:
            d = fn() if callable(fn) else None
        except Exception:  # noqa: BLE001
            d = None
        return Path(d) if d else None

    @app.get("/api/plugins/tutor/catalog")
    def tutor_catalog(instrument: str | None = None):
        inst = instrument if instrument in exercises.INSTRUMENTS else None
        dlc = _dlc()
        best = _best_by_key(inst)
        items = []
        for e in exercises.catalog(inst):
            row = dict(e)
            row["status"] = exercises.pack_status(e, dlc)
            row.update(best.get(e["key"]) or {"best_score": None, "sessions": 0, "last_played": None})
            items.append(row)
        return {
            "catalog_version": exercises.CATALOG_VERSION,
            "dlc_configured": dlc is not None,
            "skills": [{"id": s, "label": exercises.SKILL_LABELS[s]} for s in exercises.SKILLS],
            "exercises": items,
        }

    @app.post("/api/plugins/tutor/build")
    async def tutor_build(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        if not isinstance(body, dict):
            body = {}
        dlc = _dlc()
        if dlc is None:
            return JSONResponse({"error": "No library folder configured yet — set one in Settings first."}, 409)
        inst = body.get("instrument") if body.get("instrument") in exercises.INSTRUMENTS else None
        keys = body.get("keys") if isinstance(body.get("keys"), list) else None
        force = bool(body.get("force"))
        targets = [e for e in exercises.catalog(inst) if not keys or e["key"] in keys]
        if not targets:
            return JSONResponse({"error": "nothing to build"}, 400)
        if not _build_lock.acquire(blocking=False):
            return JSONResponse({"error": "A build is already running"}, 409)
        built, failed = [], []
        t0 = time.time()
        try:
            for e in targets:
                try:
                    exercises.build_pack(e, dlc, force=force)
                    built.append(e["key"])
                except Exception as exc:  # noqa: BLE001
                    log.warning("tutor: building %s failed: %s", e["key"], exc)
                    failed.append({"key": e["key"], "error": str(exc)[:200]})
        finally:
            _build_lock.release()
        kicked = False
        ks = _state["kick_scan"]
        if built and callable(ks):
            try:
                ks(force=True)
                kicked = True
            except Exception as exc:  # noqa: BLE001
                log.warning("tutor: rescan kick failed: %s", exc)
        log.info("tutor: built %d packs (%d failed) in %.1fs", len(built), len(failed), time.time() - t0)
        return {"built": built, "failed": failed, "rescan_kicked": kicked,
                "folder": str(dlc / exercises.PACK_SUBDIR)}

    @app.post("/api/plugins/tutor/sessions")
    async def tutor_record_session(request: Request):
        try:
            raw = await request.json()
        except Exception:  # noqa: BLE001
            return JSONResponse({"error": "invalid JSON"}, 400)
        session, err = _clean_session(raw, exercises)
        if err:
            return JSONResponse({"error": err}, 400)
        entry = exercises.find(session["exercise_key"])
        prof = analysis.profile(session)
        cat = exercises.catalog(entry["instrument"])
        recs = analysis.recommend(prof, entry, cat, fretless=session["fretless"])
        now = int(time.time())
        conn = _conn()
        try:
            cur = conn.execute(
                "INSERT INTO sessions (exercise_key, instrument, fretless, score, accuracy, payload, profile, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (session["exercise_key"], session["instrument"], int(session["fretless"]),
                 prof.get("score"), prof.get("accuracy"),
                 json.dumps(session, separators=(",", ":")),
                 json.dumps(prof, separators=(",", ":")), now))
            conn.commit()
            sid = cur.lastrowid
        finally:
            conn.close()
        xp = 0
        if prof.get("score") is not None and prof.get("total", 0) > 0 and callable(_state["award_xp"]):
            xp = 5 + int(prof["score"] // 5)
            try:
                _state["award_xp"](xp, "tutor")
            except Exception as exc:  # noqa: BLE001
                log.warning("tutor: award_xp failed: %s", exc)
                xp = 0
        best = _best_by_key(entry["instrument"]).get(session["exercise_key"]) or {}
        return {
            "id": sid,
            "exercise": entry,
            "profile": prof,
            "stars": analysis.stars(prof.get("score")),
            "recommendations": recs,
            "xp_awarded": xp,
            "best_score": best.get("best_score"),
            "is_best": best.get("best_score") is not None and prof.get("score") == best.get("best_score"),
        }

    @app.get("/api/plugins/tutor/sessions")
    def tutor_sessions(instrument: str | None = None, key: str | None = None, limit: int = 20):
        inst = instrument if instrument in exercises.INSTRUMENTS else None
        limit = max(1, min(int(limit), 200))
        rows = _recent_sessions(inst, key, limit)
        out = []
        for r in rows:
            item = _row_summary(r)
            entry = exercises.find(r["exercise_key"])
            item["title"] = entry["title"] if entry else r["exercise_key"]
            item["skill"] = entry["skill"] if entry else None
            out.append(item)
        return {"sessions": out}

    @app.get("/api/plugins/tutor/analysis")
    def tutor_analysis(instrument: str | None = None, limit: int = RECENT_SESSIONS_FOR_ANALYSIS):
        inst = instrument if instrument in exercises.INSTRUMENTS else None
        limit = max(1, min(int(limit), 100))
        rows = _recent_sessions(inst, None, limit)
        sessions = []
        for r in rows:
            try:
                s = json.loads(r["payload"])
                s["profile"] = json.loads(r["profile"])
                sessions.append(s)
            except (TypeError, ValueError):
                continue
        cat = exercises.catalog(inst)
        if not sessions:
            return {"sessions_considered": 0, "profile": None,
                    "recommendations": analysis.recommend({"total": 0}, None, cat),
                    "skills": {}}
        prof = analysis.aggregate(sessions)
        prof["exercise_key"] = sessions[0].get("exercise_key")
        fretless = any(s.get("fretless") for s in sessions)
        recs = analysis.recommend(prof, None, cat, fretless=fretless)
        return {
            "sessions_considered": len(sessions),
            "profile": prof,
            "recommendations": recs,
            "skills": analysis.skill_summary(sessions, cat),
        }

    @app.post("/api/plugins/tutor/reset")
    def tutor_reset():
        conn = _conn()
        try:
            conn.execute("DELETE FROM sessions")
            conn.commit()
        finally:
            conn.close()
        return {"ok": True}

    log.info("tutor plugin ready (%d exercises)", len(exercises.catalog()))


def _find_kick_scan():
    """The core scan module isn't in the plugin context; import it when we run
    inside the server (lib/ is on sys.path there) and skip it elsewhere."""
    try:
        import scan  # noqa: WPS433
    except Exception:  # noqa: BLE001
        return None
    fn = getattr(scan, "kick_scan", None)
    return fn if callable(fn) else None
