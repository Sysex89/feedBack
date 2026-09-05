# Guitar & Bass Tutor (bundled plugin)

Guided drills for guitar and bass with mistake tracking and coaching. Modelled on
the [drum highway](https://github.com/got-feedback/feedBack-plugin-drums)'s
"one focused drill, tight hit window, live tally" approach and the note_detect
benchmark builder's generated click-track packs — extended with a third scoring
axis, **intonation**, because on a fretless bass or guitar the *right* note can
still be 20 cents out and a hit/miss window would never show it.

## Part 1 — exercises

`exercises.py` is a data catalog: 18 drills per instrument (guitar-only chord
drills are skipped for bass), each a short event list a generator produces, in
four skills and three levels:

| Skill | Drills |
| --- | --- |
| Pitch & fretboard | Open Strings · Chromatic Walk · 5th Position · Octave Jumps · String Skipping |
| Rhythm | Quarter Pulse · Straight Eighths · Dotted Rhythm · Off-beats · Triplets |
| Intonation | Long Tones · Slow Scale · Perfect Fifths · Position Shifts · High Register |
| Technique | Hammer-on / Pull-off · Power Chords · Open Chords |

Each drill is written on demand as a **directory-form sloppak** under
`<library>/tutor/<instrument>__<id>.sloppak/` — manifest, one arrangement in the
wire format the highway already renders, and a generated `stems/full.wav`
(click track; intonation drills add a soft root-note drone to tune against).
Only spec-defined manifest keys are written. Packs are stamped with the catalog
version so an update regenerates them; the Tutor screen offers the build
button and kicks a library rescan afterwards.

## Part 2 — mistake tracking and coaching

While a tutor pack plays, `screen.js` scores every chart note on three axes:

* **notes** — hit / miss. From note_detect's judgments when that plugin is
  installed, otherwise from the tutor's own pitch tracker.
* **rhythm** — signed attack error in ms (+ = late), with the note's beat
  position (downbeat / off-beat / subdivision) so rushing off-beats is
  distinguishable from dragging everything.
* **intonation** — landing pitch in cents (+ = sharp) measured after the
  attack transient, and drift across the hold. The tutor runs a YIN tracker
  in a Web Worker on the instrument input (4096-sample window, so a low bass
  E at 41 Hz resolves), compares each frame against the chart note's expected
  pitch (open-string base + tuning offset + capo + fret + the arrangement's
  cent offset), and attributes it to the nearest sounding note.

Fretless mode (Tutor screen toggle or Settings) tightens the tolerance
(12 ¢ default vs 25 ¢) and switches the coaching wording to hand-position
tips. A HUD over the player shows a live cents needle and tallies.

At the end of a drill the session is posted to `/api/plugins/tutor/sessions`.
`analysis.py` builds the **mistake profile** — accuracy, timing mean/std and
early/late rates (overall and per beat position), sharp/flat rates, drift,
per-string and per-neck-region breakdowns, weak strings/regions — and a
composite 0–100 score (½ notes, ¼ rhythm, ¼ intonation; axes without data are
neutral). `recommend()` turns that into ordered coaching: slow down, repeat,
weak string, rushing/dragging, inconsistent timing, off-beats rush, uneven
subdivisions, sharp/flat, drift, weak region, and level-up when clean — each
pointing at a specific drill (and speed) to practise next. The Tutor screen's
Coach panel aggregates the last 12 sessions per instrument.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/plugins/tutor/catalog?instrument=` | drills + build status + personal bests |
| POST | `/api/plugins/tutor/build` `{instrument?, keys?, force?}` | write packs, kick rescan |
| POST | `/api/plugins/tutor/sessions` | record a play-through → profile + coaching |
| GET | `/api/plugins/tutor/sessions?instrument=&key=&limit=` | history |
| GET | `/api/plugins/tutor/analysis?instrument=` | aggregate profile + coaching |
| POST | `/api/plugins/tutor/reset` | wipe history |

State: `<config_dir>/tutor/tutor.db` (exported with Settings). Client settings
live in `localStorage` under `tutor.settings`.

## Tests

```bash
pytest tests/plugins/tutor -v
node --test plugins/tutor/tests/*.test.js
```

## Limitations

* The tutor's own tracker uses the browser microphone path. On the desktop
  build with an exclusive ASIO device the browser may not see the interface;
  install note_detect (which reads the engine) for hit/timing and the tutor
  still records pitch when the browser can hear the instrument.
* Pitch attribution is monophonic: in chord drills the tracker credits the
  loudest sounding string; note_detect's chord verdicts fill the rest.
