// Chord Tutor — shape library tests. The single validateShape sweep is the
// gate for the user-facing guarantee: movable, no open strings, no barres.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/theory.js');
const S = require('../assets/shapes.js');

const setAligned = (shape) => shape.set.map((s) => shape.strings[6 - s].fret);

test('library size and per-type counts', () => {
    assert.equal(S.SHAPES.length, 245);
    const byType = {};
    for (const s of S.SHAPES) byType[s.type] = (byType[s.type] || 0) + 1;
    assert.deepEqual(byType, {
        maj: 16, min: 16, dim: 12, aug: 12, sus2: 12, sus4: 12,
        dom7: 20, min7: 20, maj7: 20, dim7: 20, m7b5: 20, mMaj7: 20, six: 20, m6: 20,
        add9: 5,
    });
    const byVoicing = {};
    for (const s of S.SHAPES) byVoicing[s.voicing] = (byVoicing[s.voicing] || 0) + 1;
    assert.deepEqual(byVoicing, { close: 72, drop2: 99, drop3: 66, frag: 8 });
});

test('ids unique, types known, specs aligned', () => {
    const ids = new Set(S.SHAPES.map((s) => s.id));
    assert.equal(ids.size, S.SHAPES.length);
    for (const s of S.SHAPES) assert.ok(T.byId(s.type), s.id);
    assert.equal(S.SHAPE_SPECS.length, S.SHAPES.length);
});

test('every shape passes validateShape (no open, no barre, span ≤ 4, exact pitch classes)', () => {
    for (const s of S.SHAPES) assert.deepEqual(T.validateShape(s), [], s.id);
});

test('every shape has no open string for every root, lowFret ≤ 12, highFret ≤ 17', () => {
    for (const s of S.SHAPES) {
        for (let root = 0; root < 12; root++) {
            const p = T.placeShape(s, root);
            assert.ok(p, `${s.id} root ${root} unplaceable`);
            assert.ok(p.lowFret >= 1 && p.lowFret <= 12, `${s.id} root ${root} lowFret ${p.lowFret}`);
            assert.ok(p.highFret <= T.MAX_FRET, `${s.id} root ${root} highFret ${p.highFret}`);
            for (const f of p.frets) if (f !== null) assert.ok(f >= 1, `${s.id} root ${root} open string`);
        }
    }
});

test('no two sounding strings share a finger (no barre) — structural check', () => {
    for (const s of S.SHAPES) {
        const fingers = s.strings.filter(Boolean).map((x) => x.finger);
        assert.equal(new Set(fingers).size, fingers.length, s.id);
        for (const f of fingers) assert.ok(f >= 1 && f <= 4, s.id);
    }
});

test('validateShape negative controls', () => {
    const base = S.shapeById('maj.321.close.r');
    const clone = () => JSON.parse(JSON.stringify(base));
    const has = (problems, word) => problems.some((p) => p.includes(word));

    let bad = clone(); bad.strings[4].finger = bad.strings[3].finger;
    assert.ok(has(T.validateShape(bad), 'barre'));

    bad = clone(); bad.strings[4].interval = 3; // C E♭ G under a 'maj' label
    assert.ok(has(T.validateShape(bad), 'pitch classes'));

    bad = clone(); bad.strings[5] = null;
    assert.ok(has(T.validateShape(bad), 'sounding strings'));

    bad = clone(); bad.strings[5].fret = -5; bad.minOffset = -5; bad.span = 5;
    assert.ok(has(T.validateShape(bad), 'span'));

    bad = clone(); bad.strings[3].finger = 1; bad.strings[5].finger = 2; // finger 1 above finger 2
    assert.ok(has(T.validateShape(bad), 'finger order'));

    bad = clone(); bad.rootString = 1;
    assert.ok(has(T.validateShape(bad), 'root'));
});

test('rule re-derivation matches the generated specs', () => {
    const rules = S.generateRuleSpecs();
    const key = (x) => `${x.type}|${x.set.join('')}|${x.voicing}|${x.intervals.join(',')}`;
    const stored = new Set(S.SHAPE_SPECS.filter((x) => x.voicing !== 'frag' && x.type !== 'add9').map(key));
    const derived = new Set(rules.map(key));
    assert.equal(derived.size, 232);
    assert.deepEqual([...derived].sort(), [...stored].sort());
});

test('minimal-span brute force agrees with buildShape', () => {
    for (const spec of S.SHAPE_SPECS) {
        const shape = T.buildShape(spec);
        const n = spec.set.length;
        // Raw fret offsets before octave choice, relative to the root string's fret
        // (the same reference buildShape uses).
        const raw = spec.set.map((str, i) => T.mod(T.OPEN_PC[shape.rootString] + spec.intervals[i] - T.OPEN_PC[str], 12));
        let best = Infinity;
        for (let mask = 0; mask < (1 << n); mask++) {
            const offs = raw.map((r, i) => r - ((mask >> i) & 1) * 12);
            const span = Math.max(...offs) - Math.min(...offs);
            if (span < best) best = span;
        }
        assert.equal(shape.span, best, spec.type + spec.set.join('') + spec.voicing);
        const offs = setAligned(shape);
        assert.equal(Math.max(...offs) - Math.min(...offs), best);
    }
});

test('stretch flag on exactly the nine span-4 shapes', () => {
    const stretch = S.SHAPES.filter((s) => s.stretch).map((s) => s.id).sort();
    assert.deepEqual(stretch, [
        'dim.543.close.r', 'dim.654.close.r',
        'maj7.5432.drop2.3', 'maj7.6543.drop2.3', 'maj7.5321.drop3.5',
        'mMaj7.5432.drop2.5', 'mMaj7.5432.drop2.b3', 'mMaj7.6543.drop2.b3', 'mMaj7.5321.drop3.5',
    ].sort());
    for (const s of S.SHAPES) assert.equal(s.stretch, s.span === 4, s.id);
});

test('shapesFor / setsFor / typesWithShapes', () => {
    assert.equal(S.shapesFor('dom7', 'all').length, 20);
    assert.deepEqual(S.shapesFor('maj', '321').map((s) => s.id), ['maj.321.close.r', 'maj.321.close.3', 'maj.321.close.5']);
    assert.deepEqual(S.shapesFor('maj', '4321').map((s) => s.id), ['maj.4321.frag.r', 'maj.4321.frag.5']);
    assert.equal(S.shapesFor('add9', 'all').length, 5);
    assert.deepEqual(S.shapesFor('sus4', '654').map((s) => s.id.split('.').pop()), ['r', '4', '5']);
    assert.deepEqual(S.shapesFor('dim', '321').map((s) => s.id.split('.').pop()), ['r', 'b3', 'b5']);
    assert.deepEqual(S.shapesFor('aug', '432').map((s) => s.id.split('.').pop()), ['r', '3', 's5']);
    const order = S.shapesFor('min7', 'all').map((s) => s.setKey);
    assert.deepEqual([...new Set(order)], ['4321', '5432', '6543', '6432', '5321']);
    assert.deepEqual(S.setsFor('maj'), ['321', '432', '543', '654', '4321', '5432']);
    assert.deepEqual(S.setsFor('dom7'), ['4321', '5432', '6543', '6432', '5321']);
    assert.equal(S.SET_ORDER.length, 9);
    // Every type in the UI list has at least one shape (review B2).
    const ui = S.typesWithShapes();
    assert.ok(ui.length >= 14);
    for (const t of ui) assert.ok(S.shapesFor(t.id, 'all').length > 0, t.id);
    assert.equal(S.shapesFor('nope', 'all').length, 0);
});

test('dim7 symmetry: same grip in all four inversions on 4321', () => {
    const grips = S.shapesFor('dim7', '4321').map((s) => {
        const offs = setAligned(s);
        const lo = Math.min(...offs);
        return offs.map((o) => o - lo).join(',');
    });
    assert.equal(grips.length, 4);
    assert.equal(new Set(grips).size, 1);
});
