// Chord Tutor — pure theory module tests (no DOM).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/theory.js');

const setAligned = (shape) => ({
    offsets: shape.set.map((s) => shape.strings[6 - s].fret),
    fingers: shape.set.map((s) => shape.strings[6 - s].finger),
});

test('pitch-class helpers', () => {
    assert.equal(T.mod(-1, 12), 11);
    assert.equal(T.pcName(10, true), 'B♭');
    assert.equal(T.pcName(10, false), 'A♯');
    assert.equal(T.useFlatsFor(3), true);
    assert.equal(T.useFlatsFor(7), false);
});

test('chord-type table', () => {
    assert.equal(T.CHORD_TYPES.length, 15);
    assert.deepEqual(T.byId('m7b5').intervals, [0, 3, 6, 10]);
    assert.deepEqual(T.byId('add9').intervals, [0, 2, 4, 7]);
    for (const t of T.CHORD_TYPES) {
        assert.equal(t.intervals[0], 0, t.id);
        for (let i = 1; i < t.intervals.length; i++) assert.ok(t.intervals[i] > t.intervals[i - 1], t.id);
    }
});

test('interval labels', () => {
    assert.equal(T.intervalLabel('dim7', 9), '♭♭7');
    assert.equal(T.intervalLabel('six', 9), '6');
    assert.equal(T.intervalLabel('sus2', 2), '2');
    assert.equal(T.intervalLabel('add9', 2), '9');
    assert.equal(T.intervalId('m7b5', 6), 'b5');
});

test('chord names and tones', () => {
    assert.equal(T.chordName(7, 'dom7'), 'G7');
    assert.equal(T.chordName(10, 'maj7'), 'B♭maj7');
    assert.equal(T.chordName(6, 'min'), 'F♯m');
    assert.deepEqual(T.chordToneNames(10, 'maj'), ['B♭', 'D', 'F']);
    assert.deepEqual(T.chordToneNames(4, 'maj'), ['E', 'G♯', 'B']);
    // Key-context spelling (review B1): the caller can force flats.
    assert.equal(T.chordName(6, 'maj', true), 'G♭');
});

test('buildShape golden rows', () => {
    let s = T.buildShape({ type: 'maj', set: [3, 2, 1], intervals: [0, 4, 7], voicing: 'close' });
    assert.equal(s.id, 'maj.321.close.r');
    assert.equal(s.rootString, 3);
    assert.deepEqual(setAligned(s), { offsets: [0, 0, -2], fingers: [2, 3, 1] });
    assert.equal(s.span, 2);
    assert.equal(s.bassInterval, 0);
    assert.equal(s.inversionName, 'root position');
    assert.equal(s.strings.length, 6);
    assert.deepEqual(s.strings.slice(0, 3), [null, null, null]);

    s = T.buildShape({ type: 'dom7', set: [4, 3, 2, 1], intervals: [7, 0, 4, 10], voicing: 'drop2' });
    assert.equal(s.id, 'dom7.4321.drop2.5');
    assert.equal(s.rootString, 3);
    assert.deepEqual(setAligned(s), { offsets: [0, 0, 0, 1], fingers: [1, 2, 3, 4] });
    assert.equal(s.span, 1);
    assert.equal(s.inversionName, '2nd inversion');

    s = T.buildShape({ type: 'maj', set: [4, 3, 2, 1], intervals: [0, 4, 7, 0], voicing: 'frag' });
    assert.equal(s.id, 'maj.4321.frag.r');
    assert.equal(s.rootString, 4);
    assert.deepEqual(setAligned(s), { offsets: [0, -1, -2, -2], fingers: [4, 3, 1, 2] });
    assert.equal(s.span, 2);

    // Span-4 triads get 1-2-4 (review N2a).
    s = T.buildShape({ type: 'dim', set: [5, 4, 3], intervals: [0, 3, 6], voicing: 'close' });
    assert.deepEqual(setAligned(s), { offsets: [0, -2, -4], fingers: [4, 2, 1] });
    assert.equal(s.span, 4);
    assert.equal(s.stretch, true);

    s = T.buildShape({ type: 'min7', set: [4, 3, 2, 1], intervals: [10, 3, 7, 0], voicing: 'drop2' });
    assert.equal(s.id, 'min7.4321.drop2.b7');
    assert.equal(s.rootString, 1);
    assert.deepEqual(setAligned(s), { offsets: [0, 0, 0, 0], fingers: [1, 2, 3, 4] });
    assert.equal(s.inversionName, '3rd inversion');

    s = T.buildShape({ type: 'dim7', set: [6, 4, 3, 2], intervals: [3, 0, 6, 9], voicing: 'drop3' });
    assert.equal(s.id, 'dim7.6432.drop3.b3');
    assert.equal(s.rootString, 4);
    assert.deepEqual(setAligned(s), { offsets: [1, 0, 1, 0], fingers: [3, 1, 4, 2] });

    s = T.buildShape({ type: 'maj7', set: [5, 3, 2, 1], intervals: [7, 4, 11, 0], voicing: 'drop3' });
    assert.deepEqual(setAligned(s).offsets, [2, 1, 4, 0]);
    assert.equal(s.span, 4);
    assert.equal(s.stretch, true);
});

test('fingering ties resolve lower-pitched string first', () => {
    const s = T.buildShape({ type: 'aug', set: [3, 2, 1], intervals: [0, 4, 8], voicing: 'close' });
    assert.deepEqual(setAligned(s), { offsets: [0, 0, -1], fingers: [2, 3, 1] });
});

test('placeShape and octaveUp', () => {
    const s = T.buildShape({ type: 'maj', set: [3, 2, 1], intervals: [0, 4, 7], voicing: 'close' });
    const d = T.placeShape(s, 2);
    assert.equal(d.rootFret, 7);
    assert.deepEqual(d.frets, [null, null, null, 7, 7, 5]);
    assert.equal(d.lowFret, 5);
    assert.equal(d.highFret, 7);
    assert.deepEqual(d.midi, [62, 66, 69]);
    assert.deepEqual(d.names, ['D', 'F♯', 'A']);

    const a = T.placeShape(s, 9); // rootFret 2 would leave string 1 open
    assert.equal(a.rootFret, 14);
    assert.deepEqual(a.frets, [null, null, null, 14, 14, 12]);

    const bb = T.placeShape(s, 10);
    assert.equal(bb.rootFret, 3);
    assert.equal(bb.lowFret, 1);
    assert.equal(bb.useFlats, true);

    assert.equal(T.placeShape(s, 9, 12), null);
    assert.equal(T.octaveUp(d), null); // 19 > 17

    const m7 = T.buildShape({ type: 'min7', set: [4, 3, 2, 1], intervals: [10, 3, 7, 0], voicing: 'drop2' });
    const up = T.octaveUp(T.placeShape(m7, 9));
    assert.ok(up);
    assert.deepEqual(up.frets, [null, null, 17, 17, 17, 17]);
    assert.equal(T.octaveUp(T.placeShape(m7, 11)), null);
});

test('midi and frequency', () => {
    assert.equal(T.freqOf(69), 440);
    assert.ok(Math.abs(T.freqOf(57) - 220) < 1e-9);
    assert.equal(T.midiOf(6, 0), 40);
    assert.equal(T.midiOf(1, 12), 76);
});

test('circle of fifths / fourths', () => {
    assert.equal(T.FIFTHS.length, 12);
    assert.deepEqual([...T.FIFTHS].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.deepEqual(T.FIFTHS, [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]);
    assert.equal(T.sectorPc(1, 'fifths'), 7);
    assert.equal(T.sectorPc(1, 'fourths'), 5);
    assert.equal(T.sectorPc(0, 'fifths'), 0);
    assert.equal(T.sectorPc(0, 'fourths'), 0);
    for (const mode of ['fifths', 'fourths']) {
        for (let i = 0; i < 12; i++) assert.equal(T.sectorIndex(T.sectorPc(i, mode), mode), i);
        const seen = new Set();
        let pc = 0;
        for (let k = 0; k < 12; k++) { seen.add(pc); pc = T.nextInCircle(pc, mode); }
        assert.equal(pc, 0);
        assert.equal(seen.size, 12);
    }
    assert.equal(T.nextInCircle(0, 'fifths'), 7);
    assert.equal(T.nextInCircle(0, 'fourths'), 5);
    assert.equal(T.relativeMinor(0), 9);
    assert.equal(T.relativeMajor(9), 0);
    assert.equal(T.labelFor('outer', 6, 'fifths'), 'F♯/G♭');
    assert.equal(T.labelFor('inner', 9, 'fourths'), 'Am');
});

test('diatonic chords', () => {
    const c = T.diatonicChords(0, 'major');
    assert.deepEqual(c.map((x) => x.name), ['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim']);
    assert.deepEqual(c.map((x) => x.numeral), ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°']);
    assert.deepEqual(T.diatonicChords(0, 'major', true).map((x) => x.name),
        ['Cmaj7', 'Dm7', 'Em7', 'Fmaj7', 'G7', 'Am7', 'Bm7♭5']);
    assert.deepEqual(T.diatonicChords(9, 'minor').map((x) => x.name), ['Am', 'Bdim', 'C', 'Dm', 'Em', 'F', 'G']);
    const am7 = T.diatonicChords(9, 'minor', true);
    assert.equal(am7[am7.length - 1].name, 'G7');
});

test('diatonic chords are spelled in the key context (review B1)', () => {
    assert.deepEqual(T.diatonicChords(1, 'major').map((x) => x.name),
        ['D♭', 'E♭m', 'Fm', 'G♭', 'A♭', 'B♭m', 'Cdim']);
    assert.deepEqual(T.diatonicChords(10, 'minor').map((x) => x.name),
        ['B♭m', 'Cdim', 'D♭', 'E♭m', 'Fm', 'G♭', 'A♭']);
});

test('circleHighlights', () => {
    const g = T.circleHighlights(7, 'major');
    assert.deepEqual([...g.outer].sort(), [0, 2, 7]);
    assert.deepEqual([...g.inner].sort(), [11, 4, 9].sort());
    assert.equal(g.leadingDim, 6);
    assert.deepEqual(g.selected, { ring: 'outer', pc: 7 });
    const em = T.circleHighlights(4, 'minor');
    assert.deepEqual([...em.outer].sort(), [0, 2, 7]);
    assert.deepEqual(em.selected, { ring: 'inner', pc: 4 });
});

test('enharmonic equivalents and families', () => {
    assert.deepEqual(T.enharmonicEquivalent(0, 'six'), { rootPc: 9, type: 'min7' });
    assert.deepEqual(T.enharmonicEquivalent(0, 'm6'), { rootPc: 9, type: 'm7b5' });
    assert.equal(T.enharmonicEquivalent(0, 'maj'), null);
    assert.equal(T.familyOf('dom7'), 'major');
    assert.equal(T.familyOf('m7b5'), 'minor');
});

test('inversion names', () => {
    assert.equal(T.inversionName(0), 'root position');
    assert.equal(T.inversionName(4), '1st inversion');
    assert.equal(T.inversionName(7), '2nd inversion');
    assert.equal(T.inversionName(10), '3rd inversion');
    assert.equal(T.inversionName(9, 'six'), '6th in bass');
    assert.equal(T.inversionName(2), '2nd in bass');
    assert.equal(T.inversionName(5), '4th in bass');
});
