"""Exercise catalog integrity + pack builder round-trip through the real loader."""

import json
import wave

import pytest

import exercises as ex


def test_catalog_has_both_instruments_and_all_skills():
    cat = ex.catalog()
    insts = {e["instrument"] for e in cat}
    assert insts == {"guitar", "bass"}
    for inst in ex.INSTRUMENTS:
        skills = {e["skill"] for e in cat if e["instrument"] == inst}
        assert skills == set(ex.SKILLS), inst


def test_catalog_keys_unique_and_well_formed():
    cat = ex.catalog()
    keys = [e["key"] for e in cat]
    assert len(keys) == len(set(keys))
    for e in cat:
        assert e["key"] == f"{e['instrument']}__{e['id']}"
        assert e["filename"] == f"tutor/{e['key']}.sloppak"
        assert 1 <= e["level"] <= 3
        assert 40 <= e["bpm"] <= 200
        assert e["duration"] > 5
        assert e["note_count"] > 0
        assert e["t0"] > 0 and e["spb"] > 0
        assert e["skill_label"] == ex.SKILL_LABELS[e["skill"]]


def test_guitar_only_drills_absent_for_bass():
    bass_ids = {e["id"] for e in ex.catalog("bass")}
    assert "power_chords" not in bass_ids
    assert "open_chords" not in bass_ids
    assert "power_chords" in {e["id"] for e in ex.catalog("guitar")}


@pytest.mark.parametrize("inst", ex.INSTRUMENTS)
def test_every_chart_is_sorted_and_in_range(inst):
    n = len(ex.OPEN_MIDI[inst])
    for e in ex.catalog(inst):
        gen = next(d[6] for d in ex._DEFS if d[0] == e["id"])
        chart = ex._events_to_chart(gen(n), e["bpm"], inst)
        ts = [x["t"] for x in chart["notes"]]
        assert ts == sorted(ts), e["key"]
        for note in chart["notes"]:
            assert 0 <= note["s"] < n, e["key"]
            assert 0 <= note["f"] <= 24, e["key"]
            assert note["sus"] >= 0
            assert note["t"] >= e["t0"] - 1e-6 - 0.5 * e["spb"]   # slide-ins may lead the first landing
        for ch in chart["chords"]:
            assert 0 <= ch["id"] < len(chart["templates"])
            for cn in ch["notes"]:
                assert 0 <= cn["s"] < n
        assert chart["beats"][0]["measure"] == 1
        assert chart["sections"], e["key"]
        assert chart["duration"] >= max(ts + [0]) + 1


def test_scale_shape_is_a_major_scale_on_both_instruments():
    for inst, (rs, rf) in (("guitar", (1, 5)), ("bass", (1, 5))):
        n = len(ex.OPEN_MIDI[inst])
        shape = ex._scale_shape(n, rs, rf)
        base = ex.OPEN_MIDI[inst]
        midis = [base[s] + f for s, f in shape]
        root = base[rs] + rf
        assert [m - root for m in midis] == ex.MAJOR_SCALE
        assert all(0 <= f <= rf + 4 for _, f in shape)


def test_next_level_walks_same_skill():
    cat = ex.catalog("guitar")
    lt = ex.find("guitar__long_tones")
    nxt = ex.next_level(lt, cat)
    assert nxt and nxt["skill"] == "intonation" and nxt["level"] >= lt["level"]
    top = max((e for e in cat if e["skill"] == "intonation"), key=lambda e: (e["level"], e["id"]))
    assert ex.next_level(top, cat) is None


def test_build_pack_writes_a_loadable_sloppak(tmp_path):
    import sloppak  # lib/ is on the pytest path

    entry = ex.find("bass__long_tones")
    pack = ex.build_pack(entry, tmp_path)
    assert pack == tmp_path / "tutor" / "bass__long_tones.sloppak"
    assert (pack / "manifest.yaml").is_file()
    assert (pack / "arrangements" / "bass.json").is_file()
    assert (pack / "stems" / "full.wav").is_file()
    with wave.open(str(pack / "stems" / "full.wav")) as w:
        assert w.getnchannels() == 1
        assert w.getframerate() == ex.SAMPLE_RATE
        assert abs(w.getnframes() / w.getframerate() - entry["duration"]) < 0.05

    cache = tmp_path / "cache"
    cache.mkdir()
    loaded = sloppak.load_song(entry["filename"], tmp_path, cache)
    assert loaded.song.title.startswith("Long Tones")
    assert loaded.song.artist == ex.ARTIST
    arr = loaded.song.arrangements[0]
    assert arr.name == "Bass"
    assert len(arr.tuning) == 4
    assert len(arr.notes) == entry["note_count"]
    assert [s["id"] for s in loaded.stems] == ["full"]
    assert abs(loaded.song.song_length - entry["duration"]) < 1e-6


def test_build_pack_guitar_chords_round_trip(tmp_path):
    import sloppak

    entry = ex.find("guitar__power_chords")
    ex.build_pack(entry, tmp_path)
    loaded = sloppak.load_song(entry["filename"], tmp_path, sloppak_cache(tmp_path))
    arr = loaded.song.arrangements[0]
    assert len(arr.chords) == 8
    assert len(arr.chord_templates) == 4
    raw = json.loads((tmp_path / "tutor" / "guitar__power_chords.sloppak" / "arrangements" / "lead.json").read_text())
    assert {t["name"] for t in raw["templates"]} == {"E5", "A5", "D5", "G5"}


def sloppak_cache(tmp_path):
    c = tmp_path / "cache"
    c.mkdir(exist_ok=True)
    return c


def test_build_is_idempotent_and_force_rebuilds(tmp_path):
    entry = ex.find("guitar__open_strings")
    pack = ex.build_pack(entry, tmp_path)
    wav = pack / "stems" / "full.wav"
    first = wav.stat().st_mtime_ns
    ex.build_pack(entry, tmp_path)
    assert wav.stat().st_mtime_ns == first          # untouched
    assert ex.pack_status(entry, tmp_path) == "built"
    (pack / ".tutor-build").write_text("0\n")
    assert ex.pack_status(entry, tmp_path) == "stale"
    ex.build_pack(entry, tmp_path)                  # stale stamp → rebuilt without force
    assert ex.pack_status(entry, tmp_path) == "built"
    assert ex.pack_status(entry, None) == "missing"
    assert ex.pack_status(ex.find("bass__triplets"), tmp_path) == "missing"


def test_manifest_yaml_is_valid_yaml_with_only_spec_keys():
    import yaml

    text = ex._manifest_yaml({
        "title": "T (L1)", "artist": ex.ARTIST, "album": "Guitar Tutor", "year": 2026, "duration": 18.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json", "tuning": [0] * 6, "capo": 0}],
        "stems": [{"id": "full", "file": "stems/full.wav", "default": True}],
    })
    m = yaml.safe_load(text)
    assert set(m) == {"title", "artist", "album", "year", "duration", "arrangements", "stems"}
    assert m["arrangements"][0]["tuning"] == [0] * 6
    assert m["stems"][0]["default"] is True
    assert m["duration"] == 18.0


def test_drone_only_on_intonation_drills_and_audio_has_clicks():
    cat = ex.catalog("guitar")
    for e in cat:
        assert e["drone"] == (e["skill"] == "intonation"), e["key"]
    samples = ex.render_audio(2.0, 0.5, drone_midi=None)
    assert len(samples) == 2 * ex.SAMPLE_RATE
    # A click sits at every beat; silence in between.
    assert max(abs(v) for v in samples[:200]) > 0.1
    quiet = samples[int(0.2 * ex.SAMPLE_RATE):int(0.45 * ex.SAMPLE_RATE)]
    assert max(abs(v) for v in quiet) < 1e-6
    droned = ex.render_audio(2.0, 0.5, drone_midi=45, first_note_t=1.0)
    tail = droned[int(1.6 * ex.SAMPLE_RATE):int(1.7 * ex.SAMPLE_RATE)]
    assert max(abs(v) for v in tail) > 0.05
    assert max(abs(v) for v in droned) <= 1.0
