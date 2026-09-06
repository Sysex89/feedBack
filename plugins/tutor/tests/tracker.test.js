// Pure-logic tests for the tutor's in-player tracker: load screen.js in a bare
// vm window (no DOM at module scope beyond what the IIFE guards) and exercise
// window.feedBackTutor.__test.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
    const listeners = {};
    const window = {
        console,
        localStorage: { getItem: () => null, setItem: () => {} },
        document: { getElementById: () => null, addEventListener: () => {} },
        addEventListener: () => {},
        feedBack: { on: (n, fn) => { (listeners[n] = listeners[n] || []).push(fn); }, emit: () => {}, currentSong: null },
        navigator: {},
        performance: { now: () => 0 },
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
    };
    window.window = window;
    window.globalThis = window;
    const ctx = vm.createContext(window);
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    vm.runInContext(src, ctx, { filename: 'screen.js' });
    return { api: window.feedBackTutor, listeners };
}

test('module loads in a bare vm and registers bus listeners', () => {
    const { api, listeners } = load();
    assert.equal(api.version, 1);
    for (const ev of ['song:loading', 'song:ready', 'song:ended', 'song:stop', 'note:hit', 'note:miss', 'screen:changed']) {
        assert.ok(listeners[ev] && listeners[ev].length, ev);
    }
});

test('expectedMidi mirrors lib/song.py pitch_from_base', () => {
    const { expectedMidi } = load().api.__test;
    const g = { stringCount: 6, isBass: false, tuning: [0, 0, 0, 0, 0, 0], capo: 0 };
    assert.equal(expectedMidi(0, 0, g), 40);   // low E
    assert.equal(expectedMidi(1, 5, g), 50);   // A string 5th fret = D3
    assert.equal(expectedMidi(5, 12, g), 76);
    const b = { stringCount: 4, isBass: true, tuning: [0, 0, 0, 0], capo: 0 };
    assert.equal(expectedMidi(0, 0, b), 28);   // E1
    // A 4-string NON-bass borrows the guitar base; drop-D + capo apply.
    assert.equal(expectedMidi(0, 0, { stringCount: 4, isBass: false, tuning: [], capo: 0 }), 40);
    assert.equal(expectedMidi(0, 0, { stringCount: 6, isBass: false, tuning: [-2, 0, 0, 0, 0, 0], capo: 2 }), 40);
});

test('centsOff is signed (+ sharp) and honours the cent offset', () => {
    const { centsOff, midiToHz } = load().api.__test;
    assert.ok(Math.abs(centsOff(440, 69, 0)) < 1e-9);
    assert.ok(Math.abs(centsOff(440 * Math.pow(2, 10 / 1200), 69, 0) - 10) < 1e-6);
    assert.ok(centsOff(430, 69, 0) < 0);
    // A443 chart: 443 Hz IS the A.
    assert.ok(Math.abs(centsOff(443, 69, 1200 * Math.log2(443 / 440))) < 1e-6);
    assert.ok(Math.abs(midiToHz(69, -1200) - 220) < 1e-9);
    assert.ok(Number.isNaN(centsOff(0, 69, 0)));
});

test('classifiers and beat positions', () => {
    const { classifyTiming, classifyPitch, beatPos } = load().api.__test;
    assert.equal(classifyTiming(-80, 60), 'early');
    assert.equal(classifyTiming(80, 60), 'late');
    assert.equal(classifyTiming(10, 60), 'ok');
    assert.equal(classifyTiming(NaN, 60), null);
    assert.equal(classifyPitch(-20, 12), 'flat');
    assert.equal(classifyPitch(20, 12), 'sharp');
    assert.equal(classifyPitch(20, 25), 'ok');
    assert.equal(beatPos(4.0, 4.0, 0.5), 'on');
    assert.equal(beatPos(4.25, 4.0, 0.5), 'off');
    assert.equal(beatPos(4.17, 4.0, 0.5), 'sub');
    assert.equal(beatPos(3.5, 4.0, 0.5), 'on');   // before t0 still resolves
});

test('isTutorFile keys off the tutor/ library folder', () => {
    const { isTutorFile } = load().api.__test;
    assert.equal(isTutorFile('tutor/guitar__open_strings.sloppak'), true);
    assert.equal(isTutorFile('tutor\\bass__long_tones.sloppak'), true);
    assert.equal(isTutorFile('songs/tutor/x.sloppak'), false);
    assert.equal(isTutorFile(null), false);
});

function sine(freq, sr, n, amp) {
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
    return buf;
}

test('yinDetect finds a low bass E and a high guitar E', () => {
    const { yinDetect } = load().api.__test;
    const sr = 48000;
    const low = yinDetect(sine(41.2, sr, 4096, 0.5), sr, 35, 700, 0.15);
    assert.ok(low && Math.abs(low.freqHz - 41.2) < 0.5, JSON.stringify(low));
    assert.ok(low.confidence > 0.9);
    const high = yinDetect(sine(659.3, sr, 4096, 0.5), sr, 70, 1400, 0.15);
    assert.ok(high && Math.abs(high.freqHz - 659.3) < 1.0, JSON.stringify(high));
    // A note 15 cents sharp of A2 reads as +15 cents.
    const a2sharp = 110 * Math.pow(2, 15 / 1200);
    const r = yinDetect(sine(a2sharp, sr, 4096, 0.5), sr, 70, 1400, 0.15);
    const cents = 1200 * Math.log2(r.freqHz / 110);
    assert.ok(Math.abs(cents - 15) < 2, cents);
    assert.equal(yinDetect(new Float32Array(4096), sr, 70, 1400, 0.15), null);
});

function mkTracker(api, extra) {
    return api.__test.createTracker(Object.assign({
        notes: [
            { t: 4.0, s: 1, f: 5, sus: 0.6 },   // D3 = MIDI 50
            { t: 5.0, s: 2, f: 5, sus: 0.6 },   // G3 = 55
            { t: 6.0, s: 3, f: 5, sus: 2.0 },   // C4 = 60
        ],
        chords: [{ t: 8.0, notes: [{ s: 0, f: 0, sus: 0.5 }, { s: 1, f: 2, sus: 0.5 }] }],
        tuning: [0, 0, 0, 0, 0, 0], capo: 0, centOffset: 0, stringCount: 6, isBass: false,
        t0: 4.0, spb: 0.5, tolCents: 25, tolMs: 60, latencyMs: 0,
    }, extra || {}));
}
const hz = (midi, cents) => 440 * Math.pow(2, (midi - 69) / 12 + (cents || 0) / 1200);

test('tracker: own pitch frames yield hit/timing/cents/drift; unplayed notes miss; unreached skip', () => {
    const { api } = load();
    const tr = mkTracker(api);
    assert.equal(tr.count, 5);
    // Note 1: played 20 ms late, 10 cents sharp, steady.
    for (let k = 0; k < 8; k++) tr.feedPitch(4.02 + k * 0.04, hz(50, 10), 0.9);
    // Note 2: not played. Note 3: on time, drifting from -5 to +25 cents over the hold.
    for (let k = 0; k < 24; k++) tr.feedPitch(6.0 + k * 0.08, hz(60, -5 + k * 30 / 23), 0.9);
    // Chord: only the low E is heard.
    for (let k = 0; k < 4; k++) tr.feedPitch(8.0 + k * 0.05, hz(40, 0), 0.9);
    const res = tr.finalize(8.5);
    assert.equal(res.source, 'tutor');
    const [n1, n2, n3, c1, c2] = res.notes;
    assert.equal(n1.result, 'hit');
    assert.ok(Math.abs(n1.timing_ms - 20) < 1e-6, n1.timing_ms);
    assert.ok(Math.abs(n1.cents - 10) < 0.5, n1.cents);
    assert.equal(n1.beat_pos, 'on');
    assert.equal(n2.result, 'miss');
    assert.equal(n2.timing_ms, null);
    assert.equal(n3.result, 'hit');
    assert.ok(n3.drift > 12, 'drift ' + n3.drift);
    assert.equal(c1.result, 'hit');
    assert.equal(c2.result, 'miss');
});

test('tracker: latency compensation shifts timing; rewind rescans; too-far pitch ignored', () => {
    const { api } = load();
    const tr = mkTracker(api, { latencyMs: 50 });
    for (let k = 0; k < 4; k++) tr.feedPitch(4.05 + k * 0.04, hz(50, 0), 0.9);
    tr.feedPitch(5.0, hz(72, 0), 0.9);          // 2 octaves off G3 → not attributed
    assert.equal(tr.live.target, null);
    assert.ok(Number.isNaN(tr.live.cents));
    const res = tr.finalize(5.5);
    assert.ok(Math.abs(res.notes[0].timing_ms - 0) < 1e-6);
    assert.equal(res.notes[1].result, 'miss');
    assert.equal(res.notes[2].result, 'skipped');
    // Rewind and play note 2 this time.
    for (let k = 0; k < 4; k++) tr.feedPitch(5.0 + k * 0.04, hz(55, 0), 0.9);
    assert.equal(tr.finalize(5.5).notes[1].result, 'hit');
});

test('tracker: note_detect judgments win for hit/timing, own frames still supply cents', () => {
    const { api } = load();
    const tr = mkTracker(api);
    for (let k = 0; k < 6; k++) tr.feedPitch(4.0 + k * 0.05, hz(50, -20), 0.9);
    tr.onJudgment({ note: { s: 1, f: 5 }, noteTime: 4.0, timingError: -35, pitchError: -18 }, 'hit');
    tr.onJudgment({ note: { s: 1, f: 5 }, noteTime: 4.0, timingError: 99 }, 'hit');   // duplicate ignored
    tr.onJudgment({ note: { s: 2, f: 5 }, noteTime: 5.0 }, 'miss');
    tr.onJudgment({ note: { s: 9, f: 9 }, noteTime: 5.0 }, 'miss');                    // unknown → ignored
    assert.equal(tr.live.hits, 1);
    assert.equal(tr.live.misses, 1);
    const res = tr.finalize(5.5);
    assert.equal(res.source, 'mixed');
    assert.equal(res.notes[0].result, 'hit');
    assert.equal(res.notes[0].timing_ms, -35);
    assert.ok(Math.abs(res.notes[0].cents + 20) < 0.5);
    assert.equal(res.notes[1].result, 'miss');
    assert.equal(res.notes[1].cents, null);
});

test('tracker: tickOwn tallies closed notes live without note_detect', () => {
    const { api } = load();
    const tr = mkTracker(api);
    for (let k = 0; k < 4; k++) tr.feedPitch(4.0 + k * 0.05, hz(50, 40), 0.9);   // sharp hit
    tr.tickOwn(4.2);
    assert.equal(tr.live.hits, 0);            // window still open
    tr.tickOwn(5.9);                          // note 1 closed (hit, sharp), note 2 closed (miss)
    assert.equal(tr.live.hits, 1);
    assert.equal(tr.live.misses, 1);
    assert.equal(tr.live.sharp, 1);
    tr.tickOwn(5.95);
    assert.equal(tr.live.hits, 1);            // no double counting
});
