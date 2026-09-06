// Chord Tutor — the movable-shape library.
//
// The 232 close / drop-2 / drop-3 voicings are GENERATED from three rules
// (rotate, drop2, drop3 over fixed string sets) rather than transcribed; the
// eight CAGED-derived triad fragments and the five add9 voicings are listed
// explicitly. Every spec is built into a frozen shape via theory.buildShape at
// load, and tests/shapes.test.js validates the whole library (V1–V9) plus the
// golden rows from the design tables.
//
// Pure: no DOM, no storage. Dual export (module.exports + window.ChordTutorShapes).
(function (root, factory) {
    'use strict';
    const dep = root.ChordTutorTheory || (typeof require === 'function' ? require('./theory.js') : null);
    if (!dep) throw new Error('chord_tutor/shapes.js: theory.js must be loaded first');
    const api = factory(dep);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    root.ChordTutorShapes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Theory) {
    'use strict';

    const TRIAD_TYPES = Object.freeze(['maj', 'min', 'dim', 'aug', 'sus2', 'sus4']);
    const SEVENTH_TYPES = Object.freeze(['dom7', 'min7', 'maj7', 'dim7', 'm7b5', 'mMaj7', 'six', 'm6']);
    const TRIAD_SETS = Object.freeze([[3, 2, 1], [4, 3, 2], [5, 4, 3], [6, 5, 4]]);
    const DROP2_SETS = Object.freeze([[4, 3, 2, 1], [5, 4, 3, 2], [6, 5, 4, 3]]);
    const DROP3_SETS = Object.freeze([[6, 4, 3, 2], [5, 3, 2, 1]]);

    // UI order everywhere: high sets first, contiguous before skip-string.
    const SET_ORDER = Object.freeze(['321', '432', '543', '654', '4321', '5432', '6543', '6432', '5321']);
    const SETS = Object.freeze(SET_ORDER.map((key) => Object.freeze({
        key,
        strings: Object.freeze(key.split('').map(Number)),
        label: key.split('').join('-'),
    })));
    const setIndex = (key) => SET_ORDER.indexOf(key);

    const rotate = (a, i) => a.slice(i).concat(a.slice(0, i));
    const drop2 = (c) => [c[2], c[0], c[1], c[3]];   // second-from-top note dropped an octave
    const drop3 = (c) => [c[1], c[0], c[2], c[3]];   // third-from-top note dropped an octave

    // The 232 rule-derived specs, in the order the UI shows them (type table
    // order, then set order, then inversion order).
    function generateRuleSpecs() {
        const out = [];
        for (const type of TRIAD_TYPES) {
            const iv = Theory.byId(type).intervals;
            for (const set of TRIAD_SETS) {
                for (let i = 0; i < 3; i++) out.push({ type, set: set.slice(), intervals: rotate(iv, i), voicing: 'close' });
            }
        }
        for (const type of SEVENTH_TYPES) {
            const iv = Theory.byId(type).intervals;
            for (const set of DROP2_SETS) {
                for (let i = 0; i < 4; i++) out.push({ type, set: set.slice(), intervals: drop2(rotate(iv, i)), voicing: 'drop2' });
            }
            for (const set of DROP3_SETS) {
                for (let i = 0; i < 4; i++) out.push({ type, set: set.slice(), intervals: drop3(rotate(iv, i)), voicing: 'drop3' });
            }
        }
        return out;
    }

    // Four-string triads with one doubled tone (barre-free CAGED fragments).
    const FRAG_SPECS = Object.freeze([
        { type: 'maj', set: [4, 3, 2, 1], intervals: [0, 4, 7, 0], voicing: 'frag' },
        { type: 'maj', set: [4, 3, 2, 1], intervals: [7, 0, 4, 7], voicing: 'frag' },
        { type: 'maj', set: [5, 4, 3, 2], intervals: [0, 7, 0, 4], voicing: 'frag' },
        { type: 'maj', set: [5, 4, 3, 2], intervals: [4, 7, 0, 4], voicing: 'frag' },
        { type: 'min', set: [4, 3, 2, 1], intervals: [0, 3, 7, 0], voicing: 'frag' },
        { type: 'min', set: [4, 3, 2, 1], intervals: [7, 0, 3, 7], voicing: 'frag' },
        { type: 'min', set: [5, 4, 3, 2], intervals: [0, 7, 0, 3], voicing: 'frag' },
        { type: 'min', set: [5, 4, 3, 2], intervals: [3, 7, 0, 3], voicing: 'frag' },
    ]);

    // add9 is not generated wholesale: most rotations of [0,2,4,7] need a
    // barre or a > 4-fret stretch. These five are the compact (span ≤ 1),
    // barre-free voicings — each is one row of the drop2/drop3 rule output.
    const ADD9_SPECS = Object.freeze([
        { type: 'add9', set: [4, 3, 2, 1], intervals: [2, 7, 0, 4], voicing: 'drop2' },
        { type: 'add9', set: [5, 4, 3, 2], intervals: [2, 7, 0, 4], voicing: 'drop2' },
        { type: 'add9', set: [6, 5, 4, 3], intervals: [2, 7, 0, 4], voicing: 'drop2' },
        { type: 'add9', set: [6, 4, 3, 2], intervals: [4, 2, 7, 0], voicing: 'drop3' },
        { type: 'add9', set: [5, 3, 2, 1], intervals: [4, 2, 7, 0], voicing: 'drop3' },
    ]);

    const RULE_SPECS = generateRuleSpecs();
    const SHAPE_SPECS = Object.freeze(RULE_SPECS.concat(FRAG_SPECS, ADD9_SPECS).map((s) => Object.freeze({
        type: s.type, set: Object.freeze(s.set.slice()), intervals: Object.freeze(s.intervals.slice()), voicing: s.voicing,
    })));
    const SHAPES = Object.freeze(SHAPE_SPECS.map((spec) => Theory.buildShape(spec)));

    const BY_ID = Object.create(null);
    SHAPES.forEach((s) => { BY_ID[s.id] = s; });
    const shapeById = (id) => BY_ID[id] || null;

    // Per-type, per-set index built once.
    const BY_TYPE = Object.create(null);
    SHAPES.forEach((s) => {
        if (!BY_TYPE[s.type]) BY_TYPE[s.type] = [];
        BY_TYPE[s.type].push(s);
    });
    Object.keys(BY_TYPE).forEach((t) => {
        BY_TYPE[t].sort((a, b) => setIndex(a.setKey) - setIndex(b.setKey) || SHAPES.indexOf(a) - SHAPES.indexOf(b));
        Object.freeze(BY_TYPE[t]);
    });

    // All shapes for a chord type on one string set ('all' = every set), in
    // UI set order then inversion order.
    function shapesFor(typeId, setKey) {
        const list = BY_TYPE[typeId] || [];
        if (!setKey || setKey === 'all') return list.slice();
        return list.filter((s) => s.setKey === setKey);
    }
    // Set keys (UI order) that have at least one shape for the type.
    function setsFor(typeId) {
        const have = new Set((BY_TYPE[typeId] || []).map((s) => s.setKey));
        return SET_ORDER.filter((k) => have.has(k));
    }
    // Chord types that ship at least one shape — what the UI exposes.
    function typesWithShapes() {
        return Theory.CHORD_TYPES.filter((t) => (BY_TYPE[t.id] || []).length > 0);
    }

    return Object.freeze({
        TRIAD_TYPES, SEVENTH_TYPES, TRIAD_SETS, DROP2_SETS, DROP3_SETS, SET_ORDER, SETS, setIndex,
        rotate, drop2, drop3, generateRuleSpecs, FRAG_SPECS, ADD9_SPECS, SHAPE_SPECS, SHAPES,
        shapeById, shapesFor, setsFor, typesWithShapes,
    });
});
