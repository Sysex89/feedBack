# Chord Tutor

A bundled FeedBack plugin that teaches **movable, barre-free chord shapes** and
how they relate around the **circle of fifths / circle of fourths**.

## What it does

- **Movable shapes only.** Every voicing is closed-position: no open strings,
  no barres. Each sounding string is fretted by exactly one finger; unused
  strings are muted. A shape is stored relative to its root and transposed to
  any of the 12 keys, so one grip is learned once and reused everywhere on the
  neck.
- **15 chord types** — major, minor, diminished, augmented, sus2, sus4,
  dominant 7, minor 7, major 7, diminished 7, half-diminished (m7♭5),
  minor-major 7, 6, m6 and add9 — each defined by an interval formula.
- **245 shapes** generated from rules (close-voiced triads on four 3-string
  sets in three inversions; drop-2 and drop-3 sevenths on five 4-string sets in
  four inversions; a handful of explicit fragments) and validated at load
  time: exact pitch-class set, no barre, fingers ascend with frets, span ≤ 4
  frets, placeable between fret 1 and 17 for all 12 roots.
- **Circle of fifths / fourths.** An SVG wheel (majors outside, relative
  minors inside). Clicking a sector selects that key and root; the wheel
  highlights the key's diatonic chords (I ii iii IV V vi vii°) and a toggle
  flips the whole wheel to fourths order. Chord names follow the key's
  accidentals (D♭ major's IV is G♭, not F♯).
- **Browse mode.** Pick a root, chord type and string set; see every matching
  shape as a fretboard diagram with finger numbers, interval names or note
  names; hear it via a WebAudio preview; step through shapes with ←/→.
- **Drill mode.** Timed prompts at a chosen BPM and beats-per-chord: random
  chords from a type list, a walk around the circle (fifths or fourths), or
  the diatonic chords of the selected key. Shapes can be shown immediately or
  hidden until you reveal them.

## Files

| File | Role |
|------|------|
| `plugin.json` | Manifest (`nav` → `plugin-chord_tutor`, category `practice`). |
| `screen.html` | Static markup with stable `ct-*` ids plus a scoped `<style>` block. |
| `screen.js` | Classic IIFE controller: loads the sibling modules, owns DOM/state, persistence, drill timers, WebAudio and shortcuts. No theory here. |
| `assets/theory.js` | Pure: tuning, note spelling, chord-type table, `buildShape`, `placeShape`, `validateShape`, circle-of-fifths data, diatonic chords. |
| `assets/shapes.js` | Pure: rule-generated shape specs, the built `SHAPES` library, `shapesFor` / `setsFor` / `typesWithShapes`. |
| `assets/diagram.js` | Pure SVG string builders for fretboard diagrams and the wheel. |
| `assets/drill.js` | Pure drill plan generation with a seeded RNG. |
| `tests/*.test.js` | `node:test` suites (run by CI's `node --test` glob). |

The `assets/*.js` modules are dual-export (browser global
`window.ChordTutor<Name>` + CommonJS `module.exports`) and touch no DOM,
storage or timers at load, so tests `require()` them directly.

## Keyboard shortcuts (scope `plugin-chord_tutor`)

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / next shape (Browse) or chord (Drill) |
| `n` | Next drill chord |
| `r` | Reveal hidden shapes |
| `Space` | Pause / resume drill |
| `Esc` | Stop drill |
| `p` | Play the current chord |
| `m` | Toggle sound |
| `f` | Toggle fifths / fourths |
| `l` | Cycle dot labels (fingers → intervals → notes) |
| `b` / `d` | Switch to Browse / Drill |

Shortcuts are inactive while a form control inside the plugin has focus.

## Persistence

All keys are prefixed `chord_tutor_` in `localStorage` (root, chord root,
key mode, circle mode, sevenths, type, set, labels, muted, tab, drill
settings). Every access is wrapped in try/catch; unknown values fall back to
defaults.

## Development

```bash
node --test plugins/chord_tutor/tests/*.test.js
npx eslint plugins/chord_tutor
```

The plugin uses only Tailwind utilities already present in core's prebuilt
stylesheet; everything else lives in the scoped `<style>` block in
`screen.html`, so adding this plugin does not require a Tailwind rebuild.
