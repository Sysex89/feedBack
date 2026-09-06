// Chord Tutor — pure drill-plan generation.
//
// makePlan(settings, deps, rng) turns the drill form's settings into a list of
// prompts (chord + placements), deterministically under a seeded rng. Timing
// helpers live here too; the screen owns the actual timers. Dual export
// (module.exports + window.ChordTutorDrill).
(function (root, factory) {
    'use strict';
    const dep = root.ChordTutorTheory || (typeof require === 'function' ? require('./theory.js') : null);
    if (!dep) throw new Error('chord_tutor/drill.js: theory.js must be loaded first');
    const api = factory(dep);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    root.ChordTutorDrill = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Theory) {
    'use strict';

    const KINDS = Object.freeze(['random', 'circle', 'diatonic']);
    const REVEALS = Object.freeze(['immediate', 'hidden']);
    const BEATS = Object.freeze([1, 2, 4, 8]);
    const COUNTS = Object.freeze([8, 12, 24, 0]);
    const BPM = Object.freeze({ min: 30, max: 160, step: 2 });

    const DEFAULT_SETTINGS = Object.freeze({
        kind: 'random',
        types: Object.freeze(['maj', 'min', 'dom7', 'min7', 'maj7']),
        sets: Object.freeze(['all']),
        bpm: 60,
        beats: 4,
        autoAdvance: true,
        reveal: 'immediate',
        count: 12,
        click: false,
    });

    // Small, fast, seedable PRNG (32-bit state) → floats in [0, 1).
    function mulberry32(seed) {
        let a = (seed >>> 0) || 0x9e3779b9;
        return function () {
            a = (a + 0x6D2B79F5) | 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const randInt = (rng, n) => Math.floor(rng() * n);
    function shuffle(arr, rng) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) {
            const j = randInt(rng, i + 1);
            const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a;
    }

    const chordDurationMs = (bpm, beats) => beats * 60000 / bpm;
    const beatDurationMs = (bpm) => 60000 / bpm;

    // Validate a stored settings blob against the allowed values.
    function normalizeSettings(raw, knownTypes) {
        const d = DEFAULT_SETTINGS;
        const s = raw && typeof raw === 'object' ? raw : {};
        const types = Array.isArray(s.types) ? s.types.filter((t) => !knownTypes || knownTypes.includes(t)) : d.types.slice();
        let sets = Array.isArray(s.sets) ? s.sets.filter((k) => k === 'all' || /^[1-6]{3,4}$/.test(k)) : d.sets.slice();
        if (!sets.length || sets.includes('all')) sets = ['all'];
        let bpm = Number(s.bpm);
        if (!Number.isFinite(bpm)) bpm = d.bpm;
        bpm = Math.min(BPM.max, Math.max(BPM.min, Math.round(bpm)));
        const beats = BEATS.includes(Number(s.beats)) ? Number(s.beats) : d.beats;
        const count = COUNTS.includes(Number(s.count)) ? Number(s.count) : d.count;
        return {
            kind: KINDS.includes(s.kind) ? s.kind : d.kind,
            types: types.length ? types : d.types.slice(),
            sets,
            bpm,
            beats,
            autoAdvance: typeof s.autoAdvance === 'boolean' ? s.autoAdvance : d.autoAdvance,
            reveal: REVEALS.includes(s.reveal) ? s.reveal : d.reveal,
            count,
            click: typeof s.click === 'boolean' ? s.click : d.click,
        };
    }

    // Placements of (rootPc, type) on the chosen sets, UI set order.
    function placementsFor(deps, rootPc, type, sets, useFlats) {
        const shapes = (!sets || !sets.length || sets.includes('all'))
            ? deps.shapesFor(type, 'all')
            : deps.shapesFor(type, 'all').filter((s) => sets.includes(s.setKey));
        return shapes.map((s) => deps.placeShape(s, rootPc, undefined, useFlats)).filter(Boolean);
    }

    function makePrompt(deps, rootPc, type, sets, extra) {
        const useFlats = extra && extra.useFlats !== undefined ? extra.useFlats : Theory.useFlatsFor(rootPc);
        return Object.assign({
            rootPc: Theory.mod(rootPc, 12),
            type,
            name: Theory.chordName(rootPc, type, useFlats),
            numeral: '',
            next: '',
            useFlats,
            placements: placementsFor(deps, rootPc, type, sets, useFlats),
        }, extra || {});
    }

    // settings: normalized form settings plus the key context
    //   { rootPc, keyMode, circleMode, sevenths } from the screen state.
    // deps: { shapesFor, placeShape, diatonicChords, nextInCircle }.
    function makePlan(settings, deps, rng) {
        rng = rng || mulberry32(Date.now());
        const sets = settings.sets && settings.sets.length ? settings.sets : ['all'];
        const count = Number(settings.count) || 0;          // 0 = endless
        const keyRoot = Theory.mod(settings.rootPc || 0, 12);
        const keyMode = settings.keyMode === 'minor' ? 'minor' : 'major';
        const circleMode = settings.circleMode === 'fourths' ? 'fourths' : 'fifths';
        const hasShapes = (type) => placementsFor(deps, 0, type, sets).length > 0;

        let gen;   // () => prompt | null
        if (settings.kind === 'diatonic') {
            const chords = deps.diatonicChords(keyRoot, keyMode, !!settings.sevenths).filter((c) => hasShapes(c.type));
            if (!chords.length) return { prompts: [], error: 'no-shapes', next: () => null };
            let bag = [];
            gen = () => {
                if (!bag.length) bag = shuffle(chords, rng);
                const c = bag.shift();
                return makePrompt(deps, c.rootPc, c.type, sets, { numeral: c.numeral, useFlats: c.useFlats });
            };
        } else if (settings.kind === 'circle') {
            const types = (settings.types || []).filter(hasShapes);
            if (!types.length) return { prompts: [], error: 'no-shapes', next: () => null };
            let pc = keyRoot;
            let step = 0;
            gen = () => {
                const type = types[step % types.length];
                const nextPc = deps.nextInCircle(pc, circleMode);
                const nextType = types[(step + 1) % types.length];
                const p = makePrompt(deps, pc, type, sets, { next: Theory.chordName(nextPc, nextType) });
                pc = nextPc;
                step++;
                return p;
            };
        } else {
            const types = (settings.types || []).filter(hasShapes);
            if (!types.length) return { prompts: [], error: 'no-shapes', next: () => null };
            let prev = null;
            gen = () => {
                let rootPc, type;
                for (let tries = 0; tries < 24; tries++) {
                    rootPc = randInt(rng, 12);
                    type = types[randInt(rng, types.length)];
                    if (!prev || prev.rootPc !== rootPc || prev.type !== type) break;
                }
                prev = { rootPc, type };
                return makePrompt(deps, rootPc, type, sets);
            };
        }

        const prompts = [];
        const emit = () => {
            const p = gen();
            if (!p) return null;
            p.index = prompts.length;
            prompts.push(p);
            return p;
        };
        const n = count > 0 ? count : 1;   // endless plans start with one prompt
        for (let i = 0; i < n; i++) emit();
        return {
            prompts,
            error: null,
            endless: count === 0,
            // Endless plans grow on demand; finite plans are complete already.
            next: () => (count === 0 ? emit() : null),
        };
    }

    const promptName = (prompt) => (prompt ? prompt.name : '');
    const numeralFor = (prompt, key) => (prompt && key ? Theory.numeralFor(prompt.rootPc, prompt.type, key.rootPc, key.keyMode) : '');

    function formatElapsed(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        const m = Math.floor(s / 60);
        return m + ':' + String(s % 60).padStart(2, '0');
    }

    return Object.freeze({
        KINDS, REVEALS, BEATS, COUNTS, BPM, DEFAULT_SETTINGS,
        mulberry32, shuffle, chordDurationMs, beatDurationMs, normalizeSettings,
        placementsFor, makePrompt, makePlan, promptName, numeralFor, formatElapsed,
    });
});
