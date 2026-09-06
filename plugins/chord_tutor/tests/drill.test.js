// Chord Tutor — drill plan generation with a seeded RNG (deterministic).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/theory.js');
const S = require('../assets/shapes.js');
const R = require('../assets/drill.js');

const deps = { shapesFor: S.shapesFor, placeShape: T.placeShape, diatonicChords: T.diatonicChords, nextInCircle: T.nextInCircle };
const settings = (patch) => Object.assign({}, R.DEFAULT_SETTINGS, patch);

test('durations', () => {
    assert.equal(R.chordDurationMs(60, 4), 4000);
    assert.equal(R.chordDurationMs(120, 1), 500);
    assert.ok(Math.abs(R.chordDurationMs(90, 2) - 1333.333) < 0.01);
    assert.equal(R.beatDurationMs(120), 500);
    assert.equal(R.formatElapsed(65000), '1:05');
});

test('mulberry32 is deterministic and in [0,1)', () => {
    const a = R.mulberry32(1);
    const b = R.mulberry32(1);
    for (let i = 0; i < 5; i++) {
        const x = a();
        assert.equal(x, b());
        assert.ok(x >= 0 && x < 1);
    }
});

test('circle walk follows the displayed wheel', () => {
    let plan = R.makePlan(settings({ kind: 'circle', types: ['maj'], count: 12, circleMode: 'fifths', rootPc: 0 }), deps, R.mulberry32(1));
    assert.equal(plan.error, null);
    assert.deepEqual(plan.prompts.map((p) => p.rootPc), [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]);
    assert.ok(plan.prompts.every((p) => p.type === 'maj'));
    assert.equal(plan.prompts[0].next, 'G');          // circle walk shows "next" instead of a numeral
    assert.equal(plan.prompts[0].numeral, '');

    plan = R.makePlan(settings({ kind: 'circle', types: ['maj'], count: 12, circleMode: 'fourths', rootPc: 0 }), deps, R.mulberry32(1));
    assert.deepEqual(plan.prompts.map((p) => p.rootPc), [0, 5, 10, 3, 8, 1, 6, 11, 4, 9, 2, 7]);

    plan = R.makePlan(settings({ kind: 'circle', types: ['maj', 'min7'], count: 12, circleMode: 'fifths', rootPc: 0 }), deps, R.mulberry32(1));
    assert.deepEqual(plan.prompts.map((p) => p.type).slice(0, 4), ['maj', 'min7', 'maj', 'min7']);
});

test('diatonic drill covers the seven chords of the key with numerals', () => {
    const plan = R.makePlan(settings({ kind: 'diatonic', rootPc: 0, keyMode: 'major', sevenths: false, count: 7 }), deps, R.mulberry32(3));
    assert.equal(plan.prompts.length, 7);
    const got = plan.prompts.map((p) => `${p.rootPc}${p.type}`).sort();
    assert.deepEqual(got, ['0maj', '2min', '4min', '5maj', '7maj', '9min', '11dim'].sort());
    const g = plan.prompts.find((p) => p.rootPc === 7);
    assert.equal(g.numeral, 'V');
    assert.equal(g.name, 'G');

    const sev = R.makePlan(settings({ kind: 'diatonic', rootPc: 0, keyMode: 'major', sevenths: true, count: 7 }), deps, R.mulberry32(3));
    assert.ok(sev.prompts.some((p) => p.rootPc === 7 && p.type === 'dom7'));
    assert.ok(sev.prompts.some((p) => p.rootPc === 11 && p.type === 'm7b5'));
});

test('diatonic prompts use the key spelling (review B1)', () => {
    const plan = R.makePlan(settings({ kind: 'diatonic', rootPc: 1, keyMode: 'major', sevenths: false, count: 7 }), deps, R.mulberry32(3));
    const iv = plan.prompts.find((p) => p.rootPc === 6);
    assert.equal(iv.name, 'G♭');
});

test('random drill: allowed types, no immediate repeats, deterministic', () => {
    const a = R.makePlan(settings({ kind: 'random', types: ['maj', 'min'], count: 20 }), deps, R.mulberry32(42));
    const b = R.makePlan(settings({ kind: 'random', types: ['maj', 'min'], count: 20 }), deps, R.mulberry32(42));
    assert.equal(a.prompts.length, 20);
    assert.deepEqual(a.prompts.map((p) => p.name), b.prompts.map((p) => p.name));
    for (let i = 1; i < a.prompts.length; i++) {
        const x = a.prompts[i - 1], y = a.prompts[i];
        assert.ok(!(x.rootPc === y.rootPc && x.type === y.type), 'consecutive repeat at ' + i);
    }
    assert.ok(a.prompts.every((p) => p.type === 'maj' || p.type === 'min'));
});

test('placements follow the set filter; no-shape combos error or drop', () => {
    let plan = R.makePlan(settings({ kind: 'random', types: ['maj'], sets: ['4321'], count: 5 }), deps, R.mulberry32(1));
    assert.ok(plan.prompts.every((p) => p.placements.length === 2));
    plan = R.makePlan(settings({ kind: 'random', types: ['dom7'], sets: ['321'], count: 5 }), deps, R.mulberry32(1));
    assert.equal(plan.error, 'no-shapes');
    assert.deepEqual(plan.prompts, []);
    plan = R.makePlan(settings({ kind: 'random', types: ['dom7', 'maj'], sets: ['321'], count: 6 }), deps, R.mulberry32(1));
    assert.equal(plan.error, null);
    assert.ok(plan.prompts.every((p) => p.type === 'maj'));
    const all = R.makePlan(settings({ kind: 'random', types: ['maj'], count: 3 }), deps, R.mulberry32(1));
    assert.ok(all.prompts.every((p) => p.placements.length >= 1));
});

test('endless mode yields prompts on demand', () => {
    const plan = R.makePlan(settings({ kind: 'random', types: ['maj', 'min'], count: 0 }), deps, R.mulberry32(7));
    assert.equal(plan.endless, true);
    assert.equal(typeof plan.next, 'function');
    const first = [plan.next(), plan.next(), plan.next()].map((p) => p.name);
    const again = R.makePlan(settings({ kind: 'random', types: ['maj', 'min'], count: 0 }), deps, R.mulberry32(7));
    assert.deepEqual([again.next(), again.next(), again.next()].map((p) => p.name), first);
});

test('promptName and numeralFor', () => {
    const g7 = R.makePrompt(deps, 7, 'dom7', ['all']);
    assert.equal(R.promptName(g7), 'G7');
    assert.equal(R.promptName(R.makePrompt(deps, 6, 'm7b5', ['all'])), 'F♯m7♭5');
    assert.equal(R.numeralFor({ rootPc: 7, type: 'maj' }, { rootPc: 0, keyMode: 'major' }), 'V');
    assert.equal(R.numeralFor({ rootPc: 6, type: 'maj' }, { rootPc: 0, keyMode: 'major' }), '');
});

test('normalizeSettings clamps and filters', () => {
    const n = R.normalizeSettings({ bpm: 999, types: ['zzz', 'maj'], kind: 'bogus', sets: [] }, ['maj', 'min']);
    assert.equal(n.kind, 'random');
    assert.deepEqual(n.types, ['maj']);
    assert.deepEqual(n.sets, ['all']);
    assert.equal(n.bpm, R.BPM.max);
    assert.deepEqual(R.normalizeSettings(null, ['maj', 'min']), R.DEFAULT_SETTINGS);
});
