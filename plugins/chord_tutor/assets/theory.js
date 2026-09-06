// Chord Tutor — pure music-theory core.
//
// Tuning, note spelling, the chord-type table, movable-shape construction
// (buildShape / validateShape / placeShape), circle-of-fifths data and the
// diatonic-chord tables. No DOM, no localStorage, no timers: this file is
// `require()`-able from Node for the tests and is also loaded in the browser
// as a classic <script> (dual export: module.exports + window.ChordTutorTheory).
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    root.ChordTutorTheory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // ── Tuning & note names ────────────────────────────────────────────────
    const STRINGS = [6, 5, 4, 3, 2, 1];                              // low → high
    const OPEN_MIDI = { 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 };  // E2 A2 D3 G3 B3 E4
    const OPEN_PC = { 6: 4, 5: 9, 4: 2, 3: 7, 2: 11, 1: 4 };         // C = 0
    const NAMES_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    const NAMES_FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
    const FLAT_ROOTS = new Set([1, 3, 5, 8, 10]);                    // D♭ E♭ F A♭ B♭
    const MAX_FRET = 17;
    const MAX_SPAN = 4;

    const mod = (a, n) => ((a % n) + n) % n;
    const pcName = (pc, useFlats) => (useFlats ? NAMES_FLAT : NAMES_SHARP)[mod(pc, 12)];
    const useFlatsFor = (rootPc) => FLAT_ROOTS.has(mod(rootPc, 12));
    // Label for a root picker: the enharmonic pair for pc 6, key-conventional
    // spelling elsewhere (D♭ E♭ F A♭ B♭ flat, the rest sharp).
    const rootLabel = (pc) => (mod(pc, 12) === 6 ? 'F♯/G♭' : pcName(pc, useFlatsFor(pc)));

    // ── Chord types ────────────────────────────────────────────────────────
    const CHORD_TYPES = Object.freeze([
        { id: 'maj', symbol: '', name: 'Major', intervals: [0, 4, 7], family: 'major', group: 'triad' },
        { id: 'min', symbol: 'm', name: 'Minor', intervals: [0, 3, 7], family: 'minor', group: 'triad' },
        { id: 'dim', symbol: 'dim', name: 'Diminished', intervals: [0, 3, 6], family: 'minor', group: 'triad' },
        { id: 'aug', symbol: 'aug', name: 'Augmented', intervals: [0, 4, 8], family: 'major', group: 'triad' },
        { id: 'sus2', symbol: 'sus2', name: 'Suspended 2nd', intervals: [0, 2, 7], family: 'major', group: 'triad' },
        { id: 'sus4', symbol: 'sus4', name: 'Suspended 4th', intervals: [0, 5, 7], family: 'major', group: 'triad' },
        { id: 'dom7', symbol: '7', name: 'Dominant 7th', intervals: [0, 4, 7, 10], family: 'major', group: 'seventh' },
        { id: 'min7', symbol: 'm7', name: 'Minor 7th', intervals: [0, 3, 7, 10], family: 'minor', group: 'seventh' },
        { id: 'maj7', symbol: 'maj7', name: 'Major 7th', intervals: [0, 4, 7, 11], family: 'major', group: 'seventh' },
        { id: 'dim7', symbol: 'dim7', name: 'Diminished 7th', intervals: [0, 3, 6, 9], family: 'minor', group: 'seventh' },
        { id: 'm7b5', symbol: 'm7♭5', name: 'Half-diminished', intervals: [0, 3, 6, 10], family: 'minor', group: 'seventh' },
        { id: 'mMaj7', symbol: 'mMaj7', name: 'Minor-major 7th', intervals: [0, 3, 7, 11], family: 'minor', group: 'seventh' },
        { id: 'six', symbol: '6', name: 'Major 6th', intervals: [0, 4, 7, 9], family: 'major', group: 'seventh' },
        { id: 'm6', symbol: 'm6', name: 'Minor 6th', intervals: [0, 3, 7, 9], family: 'minor', group: 'seventh' },
        { id: 'add9', symbol: 'add9', name: 'Added 9th', intervals: [0, 2, 4, 7], family: 'major', group: 'seventh' },
    ].map((t) => Object.freeze(Object.assign({}, t, { intervals: Object.freeze(t.intervals.slice()) }))));

    const TYPE_BY_ID = Object.create(null);
    CHORD_TYPES.forEach((t) => { TYPE_BY_ID[t.id] = t; });
    const byId = (id) => TYPE_BY_ID[id] || null;
    const familyOf = (id) => { const t = byId(id); return t ? t.family : null; };

    function chordName(rootPc, typeId, useFlats) {
        const t = byId(typeId);
        if (!t) throw new Error('unknown chord type ' + typeId);
        if (useFlats === undefined) useFlats = useFlatsFor(rootPc);
        return pcName(rootPc, useFlats) + t.symbol;
    }
    function chordToneNames(rootPc, typeId, useFlats) {
        const t = byId(typeId);
        if (!t) throw new Error('unknown chord type ' + typeId);
        if (useFlats === undefined) useFlats = useFlatsFor(rootPc);
        return t.intervals.map((i) => pcName(mod(rootPc + i, 12), useFlats));
    }

    // ── Interval labels ────────────────────────────────────────────────────
    const INTERVAL_LABEL = { 0: 'R', 1: '♭2', 2: '2', 3: '♭3', 4: '3', 5: '4', 6: '♭5', 7: '5', 8: '♯5', 9: '6', 10: '♭7', 11: '7' };
    const INTERVAL_LABEL_OVERRIDE = { dim7: { 9: '♭♭7' }, add9: { 2: '9' } };
    const INTERVAL_ID = { 0: 'r', 1: 'b2', 2: '2', 3: 'b3', 4: '3', 5: '4', 6: 'b5', 7: '5', 8: 's5', 9: '6', 10: 'b7', 11: '7' };
    const INTERVAL_ID_OVERRIDE = { dim7: { 9: 'bb7' }, add9: { 2: '9' } };

    function intervalLabel(typeId, interval) {
        const o = INTERVAL_LABEL_OVERRIDE[typeId];
        return (o && o[interval]) || INTERVAL_LABEL[mod(interval, 12)];
    }
    function intervalId(typeId, interval) {
        const o = INTERVAL_ID_OVERRIDE[typeId];
        return (o && o[interval]) || INTERVAL_ID[mod(interval, 12)];
    }

    // Name of an inversion from the interval sounding on the lowest string.
    // 9 is "3rd inversion" for the sevenths but "6th in bass" for the sixth
    // chords; 2 / 5 (sus and add9 bass notes) are spelled out.
    function inversionName(bassInterval, typeId) {
        const b = mod(bassInterval, 12);
        if (b === 0) return 'root position';
        if (b === 3 || b === 4) return '1st inversion';
        if (b >= 6 && b <= 8) return '2nd inversion';
        if (b === 9 && (typeId === 'six' || typeId === 'm6')) return '6th in bass';
        if (b >= 9) return '3rd inversion';
        if (b === 2) return (typeId === 'add9' ? '9th' : '2nd') + ' in bass';
        if (b === 5) return '4th in bass';
        return intervalLabel(typeId, b) + ' in bass';
    }

    const setKeyOf = (set) => set.join('');

    // ── Shape construction ─────────────────────────────────────────────────
    // Auto-fingering: sounding strings ordered by fret offset ascending, then
    // lower-pitched string first; fingers 1..n in that order. A 3-note shape
    // that spans 4 frets gets 1-2-4 (index → pinky) instead of 1-2-3.
    function autoFingers(set, offsets) {
        const n = set.length;
        const order = set.map((s, k) => ({ s, k, off: offsets[k] }))
            .sort((a, b) => a.off - b.off || b.s - a.s);
        const span = Math.max.apply(null, offsets) - Math.min.apply(null, offsets);
        const seq = (n === 3 && span === MAX_SPAN) ? [1, 2, 4] : [1, 2, 3, 4].slice(0, n);
        const fingers = new Array(n);
        order.forEach((o, i) => { fingers[o.k] = seq[i]; });
        return fingers;
    }

    function buildShape(spec) {
        const type = byId(spec.type);
        if (!type) throw new Error('buildShape: unknown type ' + spec.type);
        const set = spec.set.slice();
        const intervals = spec.intervals.slice();
        if (set.length !== intervals.length) throw new Error('buildShape: set/intervals length mismatch');
        const rootK = intervals.indexOf(0);
        if (rootK < 0) throw new Error('buildShape: spec has no root (interval 0)');
        const rootString = set[rootK];
        const raw = intervals.map((iv, k) => mod(OPEN_PC[rootString] + iv - OPEN_PC[set[k]], 12));
        const offsets = raw.map((r) => mod(r + 6, 12) - 6);
        const fingers = spec.fingers ? spec.fingers.slice() : autoFingers(set, offsets);
        const strings = new Array(6).fill(null);
        set.forEach((s, k) => {
            strings[6 - s] = Object.freeze({ fret: offsets[k], interval: intervals[k], finger: fingers[k] });
        });
        const minOffset = Math.min.apply(null, offsets);
        const maxOffset = Math.max.apply(null, offsets);
        const span = maxOffset - minOffset;
        const voicing = spec.voicing || 'close';
        const bassInterval = intervals[0];
        const setKey = setKeyOf(set);
        return Object.freeze({
            id: type.id + '.' + setKey + '.' + voicing + '.' + intervalId(type.id, bassInterval),
            type: type.id,
            set: Object.freeze(set),
            setKey,
            voicing,
            rootString,
            bassInterval,
            inversionName: inversionName(bassInterval, type.id),
            strings: Object.freeze(strings),
            minOffset,
            maxOffset,
            span,
            stretch: span === MAX_SPAN,
        });
    }

    // Absolute placement of a shape for a root pitch class. Never yields an
    // open string: rootFret is pushed up an octave until every offset ≥ 1.
    function placeAt(shape, rootPc, rootFret, maxFret, useFlats) {
        const lowFret = rootFret + shape.minOffset;
        const highFret = rootFret + shape.maxOffset;
        if (highFret > maxFret || lowFret < 1) return null;
        const frets = shape.strings.map((s) => (s ? rootFret + s.fret : null));
        const midi = [];
        const names = [];
        const namesByString = new Array(6).fill(null);
        frets.forEach((f, i) => {
            if (f == null) return;
            const m = OPEN_MIDI[6 - i] + f;
            midi.push(m);
            const nm = pcName(mod(m, 12), useFlats);
            names.push(nm);
            namesByString[i] = nm;
        });
        return {
            shape, rootPc: mod(rootPc, 12), rootFret, frets, lowFret, highFret,
            midi, names, namesByString, useFlats,
        };
    }

    function placeShape(shape, rootPc, maxFret, useFlats) {
        if (maxFret === undefined || maxFret === null) maxFret = MAX_FRET;
        if (useFlats === undefined) useFlats = useFlatsFor(rootPc);
        let rootFret = mod(rootPc - OPEN_PC[shape.rootString], 12);
        while (rootFret + shape.minOffset < 1) rootFret += 12;
        return placeAt(shape, rootPc, rootFret, maxFret, useFlats);
    }

    function octaveUp(placement, maxFret) {
        if (!placement) return null;
        if (maxFret === undefined || maxFret === null) maxFret = MAX_FRET;
        return placeAt(placement.shape, placement.rootPc, placement.rootFret + 12, maxFret, placement.useFlats);
    }

    const midiOf = (string, fret) => OPEN_MIDI[string] + fret;
    const freqOf = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

    // ── Validation (V1–V9) ─────────────────────────────────────────────────
    function validateShape(shape) {
        const problems = [];
        const type = byId(shape.type);
        if (!type) return ['V10 type: unknown chord type ' + shape.type];
        const sounding = [];
        (shape.strings || []).forEach((s, i) => { if (s) sounding.push({ string: 6 - i, s }); });
        const n = sounding.length;
        if (n < 3 || n > 4) problems.push('V1 sounding strings: expected 3 or 4, got ' + n);
        // V3 no barre: unique fingers, each 1..4
        const fingers = sounding.map((x) => x.s.finger);
        if (new Set(fingers).size !== fingers.length || fingers.some((f) => !(f >= 1 && f <= 4))) {
            problems.push('V3 barre: fingers must be unique and within 1..4, got ' + fingers.join(','));
        }
        // V4 finger order
        for (const a of sounding) {
            for (const b of sounding) {
                if (a.s.fret < b.s.fret && !(a.s.finger < b.s.finger)) {
                    problems.push('V4 finger order: string ' + a.string + ' (fret ' + a.s.fret + ', finger ' + a.s.finger +
                        ') vs string ' + b.string + ' (fret ' + b.s.fret + ', finger ' + b.s.finger + ')');
                }
            }
        }
        // V5 span
        if (n > 0) {
            const frets = sounding.map((x) => x.s.fret);
            const span = Math.max.apply(null, frets) - Math.min.apply(null, frets);
            if (span > MAX_SPAN) problems.push('V5 span: ' + span + ' > ' + MAX_SPAN);
            if (shape.span !== undefined && shape.span !== span) problems.push('V5 span: stored span ' + shape.span + ' != ' + span);
            if (shape.stretch !== undefined && shape.stretch !== (span === MAX_SPAN)) problems.push('V5 span: stretch flag inconsistent');
        }
        // V6 pitch classes
        const have = Array.from(new Set(sounding.map((x) => mod(x.s.interval, 12)))).sort((a, b) => a - b);
        const want = type.intervals.slice().sort((a, b) => a - b);
        if (have.join(',') !== want.join(',')) problems.push('V6 pitch classes: {' + have.join(',') + '} != {' + want.join(',') + '}');
        // V7 root present & rootString is the lowest root
        const rootEntry = shape.strings ? shape.strings[6 - shape.rootString] : null;
        if (!rootEntry || rootEntry.interval !== 0) {
            problems.push('V7 root: rootString ' + shape.rootString + ' does not sound the root');
        } else {
            for (const x of sounding) {
                if (x.string > shape.rootString && x.s.interval === 0) {
                    problems.push('V7 root: lower string ' + x.string + ' also sounds the root');
                }
            }
        }
        // V9 interval consistency
        if (rootEntry) {
            for (const x of sounding) {
                const derived = mod(OPEN_PC[x.string] + x.s.fret - OPEN_PC[shape.rootString] - rootEntry.fret, 12);
                if (derived !== mod(x.s.interval, 12)) {
                    problems.push('V9 interval: string ' + x.string + ' sounds ' + derived + ', stored ' + x.s.interval);
                }
            }
        }
        // V2 / V8: placeable for every root, no open strings, within the neck
        if (n > 0 && shape.minOffset !== undefined) {
            for (let pc = 0; pc < 12; pc++) {
                const p = placeShape(shape, pc, MAX_FRET);
                if (!p) { problems.push('V8 neck: not placeable for root ' + pc); continue; }
                if (p.lowFret < 1) problems.push('V2 open string: root ' + pc + ' lowFret ' + p.lowFret);
                if (p.lowFret > 12) problems.push('V8 neck: root ' + pc + ' lowFret ' + p.lowFret + ' > 12');
            }
        }
        return problems;
    }

    // ── Circle of fifths / fourths ─────────────────────────────────────────
    const FIFTHS = Object.freeze([0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5]);
    const MAJOR_LABELS = Object.freeze(['C', 'G', 'D', 'A', 'E', 'B', 'F♯/G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F']);
    const MINOR_LABELS = Object.freeze(['Am', 'Em', 'Bm', 'F♯m', 'C♯m', 'G♯m', 'D♯m/E♭m', 'B♭m', 'Fm', 'Cm', 'Gm', 'Dm']);

    const sectorPc = (i, mode) => (mode === 'fourths' ? FIFTHS[mod(12 - i, 12)] : FIFTHS[mod(i, 12)]);
    function sectorIndex(pc, mode) {
        const i = FIFTHS.indexOf(mod(pc, 12));
        return mode === 'fourths' ? mod(12 - i, 12) : i;
    }
    const relativeMinor = (pc) => mod(pc + 9, 12);
    const relativeMajor = (pc) => mod(pc + 3, 12);
    const nextInCircle = (pc, mode) => mod(pc + (mode === 'fourths' ? 5 : 7), 12);
    // Ring labels are fixed per pitch class (the wheel is mirrored by
    // relabelling, so no mode argument is needed).
    function labelFor(ring, pc) {
        return ring === 'outer'
            ? MAJOR_LABELS[FIFTHS.indexOf(mod(pc, 12))]
            : MINOR_LABELS[FIFTHS.indexOf(mod(pc - 9, 12))];
    }
    function keyName(pc, keyMode) {
        return keyMode === 'minor' ? labelFor('inner', pc) : labelFor('outer', pc);
    }

    // ── Diatonic chords ────────────────────────────────────────────────────
    const DIATONIC = Object.freeze({
        major: {
            degrees: [0, 2, 4, 5, 7, 9, 11],
            triads: ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'],
            sevenths: ['maj7', 'min7', 'min7', 'maj7', 'dom7', 'min7', 'm7b5'],
            numerals: ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'],
        },
        minor: {   // natural minor
            degrees: [0, 2, 3, 5, 7, 8, 10],
            triads: ['min', 'dim', 'maj', 'min', 'min', 'maj', 'maj'],
            sevenths: ['min7', 'm7b5', 'maj7', 'min7', 'min7', 'maj7', 'dom7'],
            numerals: ['i', 'ii°', 'III', 'iv', 'v', 'VI', 'VII'],
        },
    });

    // Chord names are spelled in the KEY's accidental (D♭ major → G♭, not F♯).
    function diatonicChords(rootPc, keyMode, sevenths) {
        const d = DIATONIC[keyMode === 'minor' ? 'minor' : 'major'];
        const majorKeyPc = keyMode === 'minor' ? relativeMajor(rootPc) : mod(rootPc, 12);
        const useFlats = useFlatsFor(majorKeyPc);
        return d.degrees.map((deg, i) => {
            const pc = mod(rootPc + deg, 12);
            const type = (sevenths ? d.sevenths : d.triads)[i];
            return { degree: i + 1, numeral: d.numerals[i], rootPc: pc, type, name: chordName(pc, type, useFlats), useFlats };
        });
    }

    // Roman numeral of (rootPc, type) in a key, '' when not diatonic.
    function numeralFor(chordRootPc, typeId, keyRootPc, keyMode) {
        for (const sev of [false, true]) {
            const hit = diatonicChords(keyRootPc, keyMode, sev).find((c) => c.rootPc === mod(chordRootPc, 12) && c.type === typeId);
            if (hit) return hit.numeral;
        }
        return '';
    }

    function circleHighlights(rootPc, keyMode) {
        const K = keyMode === 'minor' ? relativeMajor(rootPc) : mod(rootPc, 12);
        return {
            selected: { ring: keyMode === 'minor' ? 'inner' : 'outer', pc: mod(rootPc, 12) },
            outer: new Set([K, mod(K + 5, 12), mod(K + 7, 12)]),
            inner: new Set([mod(K + 9, 12), mod(K + 2, 12), mod(K + 4, 12)]),
            leadingDim: mod(K + 11, 12),
        };
    }

    // Chords that share a pitch-class set with (rootPc, typeId).
    function enharmonicEquivalents(rootPc, typeId) {
        const pc = mod(rootPc, 12);
        switch (typeId) {
            case 'six': return [{ rootPc: mod(pc + 9, 12), type: 'min7' }];
            case 'm6': return [{ rootPc: mod(pc + 9, 12), type: 'm7b5' }];
            case 'min7': return [{ rootPc: mod(pc + 3, 12), type: 'six' }];
            case 'm7b5': return [{ rootPc: mod(pc + 3, 12), type: 'm6' }];
            case 'dim7': return [3, 6, 9].map((d) => ({ rootPc: mod(pc + d, 12), type: 'dim7' }));
            case 'aug': return [4, 8].map((d) => ({ rootPc: mod(pc + d, 12), type: 'aug' }));
            default: return [];
        }
    }
    function enharmonicEquivalent(rootPc, typeId) {
        const all = enharmonicEquivalents(rootPc, typeId);
        return all.length ? all[0] : null;
    }

    return Object.freeze({
        STRINGS, OPEN_MIDI, OPEN_PC, NAMES_SHARP, NAMES_FLAT, FLAT_ROOTS, MAX_FRET, MAX_SPAN,
        mod, pcName, useFlatsFor, rootLabel,
        CHORD_TYPES, byId, familyOf, chordName, chordToneNames,
        INTERVAL_LABEL, INTERVAL_ID, intervalLabel, intervalId, inversionName, setKeyOf,
        autoFingers, buildShape, placeShape, octaveUp, midiOf, freqOf, validateShape,
        FIFTHS, MAJOR_LABELS, MINOR_LABELS, sectorPc, sectorIndex, relativeMinor, relativeMajor,
        nextInCircle, labelFor, keyName,
        DIATONIC, diatonicChords, numeralFor, circleHighlights, enharmonicEquivalents, enharmonicEquivalent,
    });
});
