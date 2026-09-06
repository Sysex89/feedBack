// Chord Tutor — screen.js glue in a bare vm window (no real DOM). Exercises the
// __test seam: persistence prefix, wheel-click state mapping, shortcut scope and
// guards, and pause-on-hide via the screen:changed handler.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(opts) {
    opts = opts || {};
    const store = Object.assign({}, opts.seed);
    const timers = { set: 0, cleared: 0 };
    const handlers = {};
    const shortcuts = [];
    let activeElement = opts.activeElement || null;
    const window = {
        console,
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
        },
        document: {
            readyState: 'complete',
            currentScript: { dataset: { pluginVersion: '0.1.0' } },
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            addEventListener: () => {},
            get activeElement() { return activeElement; },
        },
        setTimeout: () => { timers.set++; return timers.set; },
        clearTimeout: () => { timers.cleared++; },
        feedBack: {
            on: (evt, fn) => { handlers[evt] = fn; },
            off: () => {},
            emit: () => {},
        },
        registerShortcut: (s) => shortcuts.push(s),
        unregisterShortcut: () => {},
        __feedBackChordTutorSkipLoad: true,
        ChordTutorTheory: require('../assets/theory.js'),
        ChordTutorShapes: require('../assets/shapes.js'),
        ChordTutorDiagram: require('../assets/diagram.js'),
        ChordTutorDrill: require('../assets/drill.js'),
    };
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    context.document = window.document;
    context.localStorage = window.localStorage;
    context.setTimeout = window.setTimeout;
    context.clearTimeout = window.clearTimeout;
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'chord_tutor/screen.js' });
    return { window, store, timers, handlers, shortcuts, setActive: (el) => { activeElement = el; } };
}

test('module boots in a bare vm window and exposes the test seam', async () => {
    const { window } = load();
    await new Promise((r) => setImmediate(r));
    const t = window.chordTutor.__test;
    assert.equal(typeof t.applySectorClick, 'function');
    assert.equal(t.PREFIX, 'chord_tutor_');
    assert.equal(t.SCOPE, 'plugin-chord_tutor');
    assert.equal(t.state.ready, true);
});

test('store prefixes keys and validates allowed values', () => {
    const { window, store } = load();
    const t = window.chordTutor.__test;
    t.store.set('type', 'min7');
    assert.equal(store.chord_tutor_type, 'min7');
    assert.equal(t.store.get('type', 'maj'), 'min7');
    t.store.set('labels', 'bogus');
    assert.equal(t.store.get('labels', 'finger', t.LABEL_MODES), 'finger');
    assert.equal(t.store.getInt('root', 0, 0, 11), 0);
    t.store.set('root', '13');
    assert.equal(t.store.getInt('root', 0, 0, 11), 0);
});

test('readPersisted falls back for unknown persisted values', async () => {
    const { window } = load({ seed: { chord_tutor_type: 'nope', chord_tutor_tab: 'weird', chord_tutor_root: '5' } });
    await new Promise((r) => setImmediate(r));
    const t = window.chordTutor.__test;
    assert.equal(t.state.type, 'maj');
    assert.equal(t.state.tab, 'browse');
    assert.equal(t.state.root, 5);
});

test('applySectorClick maps ring to key mode and snaps the chord family', async () => {
    const { window } = load();
    await new Promise((r) => setImmediate(r));
    const t = window.chordTutor.__test;
    const st = { type: 'maj' };
    t.applySectorClick(st, 'inner', 9);
    assert.equal(st.root, 9);
    assert.equal(st.chordRoot, 9);
    assert.equal(st.keyMode, 'minor');
    assert.equal(st.type, 'min');
    const st2 = { type: 'dom7' };
    t.applySectorClick(st2, 'outer', 7);
    assert.equal(st2.type, 'dom7');
    assert.equal(st2.keyMode, 'major');
});

test('toggleSetChip: "All" is exclusive and re-selected when empty', async () => {
    const { window } = load();
    await new Promise((r) => setImmediate(r));
    const t = window.chordTutor.__test;
    // Arrays come from the vm realm; spread them into host arrays before comparing.
    const chip = (sets, key) => [...t.toggleSetChip(sets, key)];
    assert.deepEqual(chip(['all'], '4321'), ['4321']);
    assert.deepEqual(chip(['4321'], '321'), ['321', '4321']);
    assert.deepEqual(chip(['4321'], '4321'), ['all']);
    assert.deepEqual(chip(['321', '4321'], 'all'), ['all']);
});

test('uiTypes hides chord types that have no shapes (review B2)', async () => {
    const { window } = load();
    await new Promise((r) => setImmediate(r));
    const t = window.chordTutor.__test;
    const S = window.ChordTutorShapes;
    const ids = t.uiTypes().map((x) => x.id);
    for (const id of ids) assert.ok(S.shapesFor(id, 'all').length > 0, id);
});

test('shortcuts are plugin-scoped and guarded in condition (review B5)', async () => {
    const h = load();
    await new Promise((r) => setImmediate(r));
    const keys = h.shortcuts.map((s) => s.key);
    for (const k of ['ArrowRight', 'ArrowLeft', 'n', 'r', 'Space', 'Escape', 'p', 'm', 'f', 'l', 'b', 'd']) {
        assert.ok(keys.includes(k), k);
    }
    for (const s of h.shortcuts) {
        assert.equal(s.scope, 'plugin-chord_tutor');
        assert.equal(typeof s.condition, 'function');
    }
    const t = h.window.chordTutor.__test;
    t.state.mounted = true;
    const f = h.shortcuts.find((s) => s.key === 'f');
    assert.equal(f.condition(), true);
    h.setActive({ tagName: 'INPUT', closest: () => ({}) });
    assert.equal(f.condition(), false);
    assert.equal(t.inFormControl(), true);
    h.setActive({ tagName: 'BUTTON', closest: () => ({}) });
    assert.equal(f.condition(), false);
    h.setActive({ tagName: 'BUTTON', closest: () => null });
    assert.equal(f.condition(), true);
});

test('leaving the screen pauses a running drill and clears its timer', async () => {
    const h = load();
    await new Promise((r) => setImmediate(r));
    const t = h.window.chordTutor.__test;
    t.state.visible = true;
    t.state.mounted = false; // no DOM in the harness; pauseDrill skips its re-render
    t.setDrillForTest({ status: 'running', timer: 42, runSince: Date.now() });
    const before = h.timers.cleared;
    h.handlers['screen:changed']({ detail: { id: 'player', from: 'plugin-chord_tutor' } });
    assert.equal(t.state.drill.status, 'paused');
    assert.equal(t.state.drill.pausedByHide, true);
    assert.ok(h.timers.cleared > before);
    assert.equal(t.state.visible, false);
});
