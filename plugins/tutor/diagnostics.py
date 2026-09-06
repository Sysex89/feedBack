"""Diagnostics contributor for the tutor plugin (Settings → Export Diagnostics).

Redaction-safe: counts and scores only — no filenames beyond the exercise
keys (which are catalog constants), no audio, no device info."""

from __future__ import annotations

import sqlite3


def collect(ctx: dict) -> dict:
    out = {"schema": "tutor.diag.v1", "sessions": 0, "by_instrument": {}, "recent": []}
    db = ctx["config_dir"] / "tutor" / "tutor.db"
    if not db.is_file():
        return out
    try:
        conn = sqlite3.connect(str(db), timeout=2)
        conn.row_factory = sqlite3.Row
        try:
            out["sessions"] = conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
            for r in conn.execute("SELECT instrument, COUNT(*) AS n, AVG(score) AS avg FROM sessions GROUP BY instrument"):
                out["by_instrument"][r["instrument"]] = {"sessions": r["n"], "avg_score": r["avg"]}
            for r in conn.execute("SELECT exercise_key, score, accuracy, fretless, created_at FROM sessions "
                                  "ORDER BY created_at DESC LIMIT 10"):
                out["recent"].append({"exercise_key": r["exercise_key"], "score": r["score"],
                                      "accuracy": r["accuracy"], "fretless": bool(r["fretless"]),
                                      "created_at": r["created_at"]})
        finally:
            conn.close()
    except sqlite3.DatabaseError as exc:
        out["error"] = str(exc)[:200]
    return out
