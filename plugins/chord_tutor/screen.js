// Chord Tutor — screen controller (classic IIFE).
//
// Loads the pure sibling modules from assets/ (theory → shapes → diagram →
// drill), owns all DOM/state/persistence, the circle-of-fifths wiring, the
// Browse grid + focus panel, the Drill timers, WebAudio preview and the
// plugin-scoped keyboard shortcuts. No music theory lives here.
//
// Lifecycle: the host injects this script once per plugin version; re-entering
// the screen does NOT re-run it, so per-visit work hangs off
// `window.feedBack.on('screen:changed')`. Element refs are resolved ONCE in
// mount() and cached — nothing on a timer path queries the DOM.
//
// Test seam: `window.__feedBackChordTutorSkipLoad = true` (with the four
// sibling globals pre-set) skips the <script> injection so screen.js can run
// in a bare Node vm context; the pure helpers are exposed on
// `window.chordTutor.__test`.
(function () {
    'use strict';

    const PLUGIN_ID = 'chord_tutor';
    const SCREEN_ID = 'plugin-chord_tutor';
    const SCOPE = 'plugin-chord_tutor';
    const PREFIX = 'chord_tutor_';
    const VERSION = (document.currentScript && document.currentScript.dataset && document.currentScript.dataset.pluginVersion) || '';

    const g = window.__feedBackChordTutor || (window.__feedBackChordTutor = {});
    if (g.instance && typeof g.instance.dispose === 'function') {
        try { g.instance.dispose(); } catch (e) { console.error('[chord_tutor] previous instance dispose failed', e); }
    }

    const log = function () {
        const args = Array.prototype.slice.call(arguments);
        args.unshift('[chord_tutor]');
        console.error.apply(console, args);
    };
    const wrap = (fn) => function () {
        try { return fn.apply(this, arguments); } catch (e) { log(e); return undefined; }
    };

    // ── Persistence (all keys prefixed chord_tutor_, every access try/catch) ──
    const store = {
        get(key, def, allowed) {
            try {
                const v = localStorage.getItem(PREFIX + key);
                if (v === null || v === undefined) return def;
                if (allowed && allowed.indexOf(v) < 0) return def;
                return v;
            } catch (e) { return def; }
        },
        set(key, val) {
            try { localStorage.setItem(PREFIX + key, String(val)); } catch (e) { /* storage unavailable */ }
        },
        getInt(key, def, min, max) {
            const n = parseInt(store.get(key, null), 10);
            return Number.isInteger(n) && n >= min && n <= max ? n : def;
        },
        getJSON(key, def) {
            try {
                const v = localStorage.getItem(PREFIX + key);
                return v === null || v === undefined ? def : JSON.parse(v);
            } catch (e) { return def; }
        },
        setJSON(key, val) {
            try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ }
        },
    };

    // Sibling modules — assigned once loading finishes.
    let Theory = null, Shapes = null, Diagram = null, Drill = null;

    const LABEL_MODES = ['finger', 'interval', 'note'];
    const state = {
        ready: false, visible: false, mounted: false, tab: 'browse',
        root: 0, chordRoot: 0, keyMode: 'major', circleMode: 'fifths', sevenths: false,
        type: 'maj', setFilter: 'all', labelMode: 'finger', muted: false,
        placements: [], focusIndex: 0, octaveUp: false,
        drillSettings: null,
        drill: {
            status: 'idle', settings: null, plan: null, index: 0, beat: 0, revealed: false, waiting: false,
            runSince: 0, elapsedMs: 0, history: [], timer: null, pausedByHide: false,
        },
    };
    let els = {};
    let pendingShow = false;

    // ── Pure helpers (exposed for tests) ──────────────────────────────────
    const familyOf = (typeId) => (Theory ? Theory.familyOf(typeId) : null);
    const uiTypes = (shapesApi) => (shapesApi || Shapes).typesWithShapes();

    // Wheel click: the sector's key becomes the key AND the browsed root; the
    // chord type snaps to the ring's family only when it disagrees.
    function applySectorClick(st, ring, pc) {
        st.root = pc;
        st.chordRoot = pc;
        st.keyMode = ring === 'inner' ? 'minor' : 'major';
        const fam = familyOf(st.type);
        if (ring === 'outer' && fam !== 'major') st.type = 'maj';
        if (ring === 'inner' && fam !== 'minor') st.type = 'min';
        st.focusIndex = 0;
        st.octaveUp = false;
        return st;
    }

    // Drill string-set chips: "All" is exclusive; picking a set drops "All";
    // deselecting the last set re-selects "All".
    function toggleSetChip(sets, key) {
        if (key === 'all') return ['all'];
        let next = sets.filter((k) => k !== 'all');
        if (next.indexOf(key) >= 0) next = next.filter((k) => k !== key);
        else next.push(key);
        if (!next.length) return ['all'];
        const order = Shapes ? Shapes.SET_ORDER : [];
        return next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }

    // Shortcut guard: the host dispatcher preventDefault()s BEFORE calling a
    // handler, so this must live in `condition`, not the handler.
    function inFormControl() {
        const a = document.activeElement;
        if (!a) return false;
        const tag = a.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
        if (tag === 'BUTTON' && typeof a.closest === 'function' && a.closest('#ct-drill-setup')) return true;
        return false;
    }

    const esc = (s) => Diagram.esc(s);

    // ── Sibling loader ────────────────────────────────────────────────────
    const SIBLINGS = [
        ['theory', 'ChordTutorTheory'], ['shapes', 'ChordTutorShapes'],
        ['diagram', 'ChordTutorDiagram'], ['drill', 'ChordTutorDrill'],
    ];
    function loadSibling(name, globalName) {
        return new Promise((resolve, reject) => {
            const existing = document.querySelector('script[data-ct-sibling="' + name + '"]');
            if (existing) {
                if (existing.dataset.pluginVersion === VERSION && window[globalName]) { resolve(); return; }
                existing.remove();
            }
            const s = document.createElement('script');
            s.src = '/api/plugins/' + PLUGIN_ID + '/assets/' + name + '.js' + (VERSION ? '?v=' + encodeURIComponent(VERSION) : '');
            s.dataset.ctSibling = name;
            s.dataset.pluginId = PLUGIN_ID;          // host clears these on a version bump
            s.dataset.pluginVersion = VERSION;
            s.onload = () => (window[globalName] ? resolve() : reject(new Error(name + '.js loaded but did not define window.' + globalName)));
            s.onerror = () => reject(new Error('failed to load ' + name + '.js'));
            (document.head || document.body).appendChild(s);
        });
    }
    function loadAll() {
        return SIBLINGS.reduce((p, pair) => p.then(() => loadSibling(pair[0], pair[1])), Promise.resolve());
    }
    function showLoadError(err) {
        const box = document.getElementById('ct-error');
        const body = document.getElementById('ct-body');
        const name = String(err && err.message || err).match(/(\w+)\.js/);
        if (box) {
            box.textContent = 'Chord Tutor could not load ' + (name ? name[1] : 'a sibling') + '.js (HTTP/JS error). Reload the page; ' +
                'if it persists, check the server log for /api/plugins/chord_tutor/assets/.';
            box.classList.remove('hidden');
        }
        if (body) body.classList.add('hidden');
    }

    // ── Element cache ─────────────────────────────────────────────────────
    const IDS = [
        'ct-root', 'ct-mute', 'ct-error', 'ct-body', 'ct-tab-browse', 'ct-tab-drill',
        'ct-mode-fifths', 'ct-mode-fourths', 'ct-wheel', 'ct-sevenths', 'ct-diatonic',
        'ct-panel-browse', 'ct-root-select', 'ct-type', 'ct-labels', 'ct-sets', 'ct-focus', 'ct-focus-svg',
        'ct-focus-title', 'ct-focus-sub', 'ct-focus-formula', 'ct-focus-hint', 'ct-play', 'ct-octave',
        'ct-prev', 'ct-next', 'ct-grid', 'ct-empty', 'ct-panel-drill', 'ct-drill-setup', 'ct-d-kind',
        'ct-d-types-field', 'ct-d-types', 'ct-d-types-note', 'ct-d-sets', 'ct-d-bpm', 'ct-d-bpm-val',
        'ct-d-beats', 'ct-d-count', 'ct-d-auto', 'ct-d-reveal', 'ct-d-click', 'ct-d-error', 'ct-d-start',
        'ct-drill-run', 'ct-d-prompt', 'ct-d-numeral', 'ct-d-counter', 'ct-d-beat', 'ct-d-bar', 'ct-d-bar-fill',
        'ct-d-reveal-btn', 'ct-d-prev', 'ct-d-next', 'ct-d-pause', 'ct-d-play', 'ct-d-stop',
        'ct-d-shapes-wrap', 'ct-d-shapes', 'ct-drill-done', 'ct-d-summary', 'ct-d-history', 'ct-d-again', 'ct-d-setup',
    ];
    const camel = (id) => id.replace(/^ct-/, '').split('-').map((w, i) => (i ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join('');
    const on = (el, evt, fn) => { if (el) el.addEventListener(evt, wrap(fn)); };

    // ── Persisted state ───────────────────────────────────────────────────
    function readPersisted() {
        state.root = store.getInt('root', 0, 0, 11);
        state.chordRoot = store.getInt('chord_root', state.root, 0, 11);
        state.keyMode = store.get('key_mode', 'major', ['major', 'minor']);
        state.circleMode = store.get('circle_mode', 'fifths', ['fifths', 'fourths']);
        state.sevenths = store.get('sevenths', '0', ['0', '1']) === '1';
        const typeIds = uiTypes().map((t) => t.id);
        const t = store.get('type', 'maj');
        state.type = typeIds.indexOf(t) >= 0 ? t : 'maj';
        const sf = store.get('set', 'all');
        state.setFilter = (sf === 'all' || Shapes.setsFor(state.type).indexOf(sf) >= 0) ? sf : 'all';
        state.labelMode = store.get('labels', 'finger', LABEL_MODES);
        state.muted = store.get('muted', '0', ['0', '1']) === '1';
        state.tab = store.get('tab', 'browse', ['browse', 'drill']);
        state.drillSettings = Drill.normalizeSettings(store.getJSON('drill', null), typeIds);
    }

    // ── Audio (WebAudio, lazy, gesture-created) ───────────────────────────
    const audio = {
        ctx: null, master: null, filter: null, live: new Set(), available: true,
        ensure() {
            if (this.ctx) {
                if (this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) { /* ignore */ } }
                return this.ctx;
            }
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { this.available = false; return null; }
            try {
                const ctx = new AC();
                this.master = ctx.createGain();
                this.master.gain.value = 0.8;
                this.filter = ctx.createBiquadFilter();
                this.filter.type = 'lowpass';
                this.filter.frequency.value = 2400;
                this.filter.Q.value = 0.7;
                this.filter.connect(this.master);
                this.master.connect(ctx.destination);
                this.ctx = ctx;
            } catch (e) {
                this.available = false;
                log('AudioContext unavailable', e);
                return null;
            }
            return this.ctx;
        },
        playChord(midis, opts) {
            if (state.muted || !midis || !midis.length) return;
            const ctx = this.ensure();
            if (!ctx) { renderAudioAvailability(); return; }
            this.stopAll();
            const strumMs = (opts && opts.strumMs) || 35;
            const duration = (opts && opts.duration) || 1.8;
            const t0 = ctx.currentTime + 0.01;
            const sorted = midis.slice().sort((a, b) => a - b);
            const peak = 0.32 / Math.sqrt(sorted.length);
            sorted.forEach((m, k) => {
                const t = t0 + k * strumMs / 1000;
                const osc = ctx.createOscillator();
                osc.type = 'triangle';
                osc.frequency.value = Theory.freqOf(m);
                const gain = ctx.createGain();
                gain.gain.setValueAtTime(0, t);
                gain.gain.linearRampToValueAtTime(peak, t + 0.006);
                gain.gain.exponentialRampToValueAtTime(0.0008, t + duration);
                osc.connect(gain);
                gain.connect(this.filter);
                osc.start(t);
                osc.stop(t + duration + 0.05);
                const rec = { osc, gain };
                this.live.add(rec);
                osc.onended = () => {
                    this.live.delete(rec);
                    try { osc.disconnect(); gain.disconnect(); } catch (e) { /* ignore */ }
                };
            });
        },
        stopAll() {
            const ctx = this.ctx;
            if (!ctx) return;
            const t = ctx.currentTime;
            this.live.forEach((r) => {
                try {
                    r.gain.gain.cancelScheduledValues(t);
                    r.gain.gain.setValueAtTime(r.gain.gain.value, t);
                    r.gain.gain.linearRampToValueAtTime(0, t + 0.03);
                    r.osc.stop(t + 0.04);
                } catch (e) { /* already stopped */ }
            });
            this.live.clear();
        },
        click(accent) {
            if (state.muted) return;
            const ctx = this.ensure();
            if (!ctx) return;
            try {
                const t = ctx.currentTime;
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = 1000;
                const gain = ctx.createGain();
                gain.gain.setValueAtTime(accent ? 0.3 : 0.15, t);
                gain.gain.exponentialRampToValueAtTime(0.001, t + 0.025);
                osc.connect(gain);
                gain.connect(this.master);
                osc.start(t);
                osc.stop(t + 0.03);
                osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch (e) { /* ignore */ } };
            } catch (e) { log('click failed', e); }
        },
        suspend() {
            this.stopAll();
            if (this.ctx && this.ctx.state === 'running') { try { this.ctx.suspend(); } catch (e) { /* ignore */ } }
        },
        close() {
            if (!this.ctx) return;
            try { this.ctx.close(); } catch (e) { /* ignore */ }
            this.ctx = null; this.master = null; this.filter = null; this.live.clear();
        },
    };
    function renderAudioAvailability() {
        if (!state.mounted) return;
        [els.play, els.dPlay].forEach((b) => {
            if (!b) return;
            b.disabled = !audio.available;
            if (!audio.available) b.title = 'Audio unavailable';
        });
    }

    // ── Mount / wiring ────────────────────────────────────────────────────
    function mount() {
        const rootEl = document.getElementById('ct-root');
        if (!rootEl) return false;
        els = {};
        IDS.forEach((id) => { els[camel(id)] = document.getElementById(id); });

        // Wheel: built once; the 24 sector groups are cached for in-place updates.
        els.wheel.innerHTML = Diagram.renderWheel(state.circleMode);
        els.sectors = { outer: new Array(12), inner: new Array(12) };
        els.wheel.querySelectorAll('.ct-sector').forEach((gEl) => {
            els.sectors[gEl.dataset.ring][Number(gEl.dataset.idx)] = { g: gEl, text: gEl.querySelector('text') };
        });
        els.hubKey = document.getElementById('ct-hub-key');
        els.hubMode = document.getElementById('ct-hub-mode');

        fillRootSelect();
        fillTypeSelect();
        fillDrillTypes();
        fillDrillSets();
        els.dKindRadios = Array.prototype.slice.call(els.dKind.querySelectorAll('input[type=radio]'));
        wire();
        state.mounted = true;
        renderAll();
        return true;
    }

    function wire() {
        on(els.mute, 'click', toggleMute);
        on(els.tabBrowse, 'click', () => setTab('browse'));
        on(els.tabDrill, 'click', () => setTab('drill'));
        on(els.modeFifths, 'click', () => setCircleMode('fifths'));
        on(els.modeFourths, 'click', () => setCircleMode('fourths'));
        on(els.wheel, 'click', (e) => {
            const gEl = e.target && e.target.closest ? e.target.closest('.ct-sector') : null;
            if (gEl) onSectorActivate(gEl);
        });
        on(els.wheel, 'keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return;
            const gEl = e.target && e.target.closest ? e.target.closest('.ct-sector') : null;
            if (!gEl) return;
            e.preventDefault();
            onSectorActivate(gEl);
        });
        on(els.sevenths, 'change', () => {
            state.sevenths = !!els.sevenths.checked;
            store.set('sevenths', state.sevenths ? '1' : '0');
            renderDiatonic();
        });
        on(els.diatonic, 'click', (e) => {
            const chip = e.target && e.target.closest ? e.target.closest('button[data-pc]') : null;
            if (!chip) return;
            selectChord(Number(chip.dataset.pc), chip.dataset.type);
            if (state.tab === 'drill') setTab('browse');
        });
        on(els.rootSelect, 'change', () => setRoot(Number(els.rootSelect.value)));
        on(els.type, 'change', () => setType(els.type.value));
        on(els.labels, 'click', (e) => {
            const b = e.target && e.target.closest ? e.target.closest('button[data-labels]') : null;
            if (b) setLabelMode(b.dataset.labels);
        });
        on(els.sets, 'click', (e) => {
            const b = e.target && e.target.closest ? e.target.closest('button[data-set]') : null;
            if (b) setSetFilter(b.dataset.set);
        });
        on(els.grid, 'click', (e) => {
            const card = e.target && e.target.closest ? e.target.closest('button[data-idx]') : null;
            if (!card) return;
            setFocus(Number(card.dataset.idx));
            playCurrent();
        });
        on(els.play, 'click', playCurrent);
        on(els.octave, 'click', () => {
            const base = state.placements[state.focusIndex];
            if (!base || !Theory.octaveUp(base)) return;
            state.octaveUp = !state.octaveUp;
            renderFocus();
        });
        on(els.prev, 'click', () => setFocus(state.focusIndex - 1));
        on(els.next, 'click', () => setFocus(state.focusIndex + 1));

        // Drill form
        on(els.drillSetup, 'submit', (e) => { e.preventDefault(); startDrill(); });
        on(els.drillSetup, 'change', onDrillFormChange);
        on(els.dBpm, 'input', () => { els.dBpmVal.textContent = els.dBpm.value; });
        on(els.dSets, 'click', (e) => {
            const chip = e.target && e.target.closest ? e.target.closest('button[data-set]') : null;
            if (!chip) return;
            state.drillSettings.sets = toggleSetChip(state.drillSettings.sets, chip.dataset.set);
            store.setJSON('drill', state.drillSettings);
            renderDrillForm();
        });
        // Drill run
        on(els.dRevealBtn, 'click', reveal);
        on(els.dPrev, 'click', () => advance(-1));
        on(els.dNext, 'click', () => advance(1));
        on(els.dPause, 'click', togglePause);
        on(els.dPlay, 'click', playCurrent);
        on(els.dStop, 'click', stopDrill);
        on(els.dHistory, 'click', (e) => {
            const chip = e.target && e.target.closest ? e.target.closest('button[data-pc]') : null;
            if (!chip) return;
            selectChord(Number(chip.dataset.pc), chip.dataset.type);
            setTab('browse');
        });
        on(els.dAgain, 'click', startDrill);
        on(els.dSetup, 'click', () => { state.drill.status = 'idle'; state.drill.plan = null; renderDrillPanels(); });
    }

    function onSectorActivate(gEl) {
        applySectorClick(state, gEl.dataset.ring, Number(gEl.dataset.pc));
        store.set('root', state.root);
        store.set('chord_root', state.chordRoot);
        store.set('key_mode', state.keyMode);
        store.set('type', state.type);
        if (Shapes.setsFor(state.type).indexOf(state.setFilter) < 0) { state.setFilter = 'all'; store.set('set', 'all'); }
        renderWheelState();
        renderBrowse();
    }

    // ── Fill static controls (once, at mount) ─────────────────────────────
    function fillRootSelect() {
        let html = '';
        for (let pc = 0; pc < 12; pc++) html += '<option value="' + pc + '">' + esc(Theory.rootLabel(pc)) + '</option>';
        els.rootSelect.innerHTML = html;
    }
    function fillTypeSelect() {
        const types = uiTypes();
        const group = (label, gid) => {
            const items = types.filter((t) => t.group === gid);
            if (!items.length) return '';
            return '<optgroup label="' + esc(label) + '">' +
                items.map((t) => '<option value="' + esc(t.id) + '">' + esc(t.name + (t.symbol ? ' (' + t.symbol + ')' : '')) + '</option>').join('') +
                '</optgroup>';
        };
        els.type.innerHTML = group('Triads', 'triad') + group('Sevenths, sixths & add9', 'seventh');
    }
    function fillDrillTypes() {
        els.dTypes.innerHTML = uiTypes().map((t) =>
            '<label class="ct-check"><input type="checkbox" name="ct-d-type" value="' + esc(t.id) + '"> ' + esc(t.name) +
            (t.symbol ? ' <span class="ct-fine">' + esc(t.symbol) + '</span>' : '') + '</label>').join('');
        els.dTypeBoxes = Array.prototype.slice.call(els.dTypes.querySelectorAll('input[type=checkbox]'));
    }
    function fillDrillSets() {
        els.dSets.innerHTML = '<button type="button" class="ct-chip" data-set="all">All</button>' +
            Shapes.SETS.map((s) => '<button type="button" class="ct-chip" data-set="' + s.key + '">' + s.label + '</button>').join('');
        els.dSetChips = Array.prototype.slice.call(els.dSets.querySelectorAll('button[data-set]'));
    }

    // ── Rendering ─────────────────────────────────────────────────────────
    function renderAll() {
        if (!state.mounted) return;
        renderMute();
        renderTabs();
        renderModeButtons();
        renderWheelState();
        renderBrowse();
        renderDrillForm();
        renderDrillPanels();
        renderAudioAvailability();
    }
    function renderBrowse() {
        renderRootSelect();
        renderTypeSelect();
        renderSetChips();
        renderLabelsSeg();
        recomputePlacements();
        renderGrid();
        renderFocus();
        renderDiatonic();
    }
    function renderMute() {
        els.mute.textContent = state.muted ? 'Sound: off' : 'Sound: on';
        els.mute.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
    }
    function renderTabs() {
        const browse = state.tab === 'browse';
        els.tabBrowse.classList.toggle('active', browse);
        els.tabDrill.classList.toggle('active', !browse);
        els.tabBrowse.setAttribute('aria-selected', browse ? 'true' : 'false');
        els.tabDrill.setAttribute('aria-selected', browse ? 'false' : 'true');
        els.panelBrowse.classList.toggle('active', browse);
        els.panelDrill.classList.toggle('active', !browse);
    }
    function renderModeButtons() {
        els.modeFifths.classList.toggle('active', state.circleMode === 'fifths');
        els.modeFourths.classList.toggle('active', state.circleMode === 'fourths');
    }
    function renderWheelState() {
        const H = Theory.circleHighlights(state.root, state.keyMode);
        ['outer', 'inner'].forEach((ring) => {
            for (let i = 0; i < 12; i++) {
                const rec = els.sectors[ring][i];
                if (!rec) continue;
                const pc = Number(rec.g.dataset.pc);
                const sel = H.selected.ring === ring && H.selected.pc === pc;
                const dia = ring === 'outer' ? H.outer.has(pc) : H.inner.has(pc);
                rec.g.classList.toggle('ct-sel', sel);
                rec.g.classList.toggle('ct-dia', dia && !sel);
                rec.g.classList.toggle('ct-lead', ring === 'outer' && pc === H.leadingDim);
            }
        });
        els.hubKey.textContent = Theory.keyName(state.root, state.keyMode);
        els.hubMode.textContent = Diagram.hubCaption(state.circleMode);
    }
    // Mode toggle: relabel the cached 24 groups in place (no rebuild).
    function relabelWheel() {
        Diagram.sectorLabelPositions(state.circleMode).forEach((L) => {
            const o = els.sectors.outer[L.idx], n = els.sectors.inner[L.idx];
            if (o) {
                o.g.dataset.pc = String(L.pc);
                o.text.innerHTML = Diagram.labelMarkup(L.major);
                o.g.setAttribute('aria-label', Diagram.ariaFor('outer', L.major));
            }
            if (n) {
                n.g.dataset.pc = String(L.minorPc);
                n.text.innerHTML = Diagram.labelMarkup(L.minor);
                n.g.setAttribute('aria-label', Diagram.ariaFor('inner', L.minor));
            }
        });
    }
    function renderDiatonic() {
        const chords = Theory.diatonicChords(state.root, state.keyMode, state.sevenths);
        els.diatonic.innerHTML = chords.map((c) => {
            const active = c.rootPc === state.chordRoot && c.type === state.type;
            return '<button type="button" class="ct-chip' + (active ? ' active' : '') + '" data-pc="' + c.rootPc + '" data-type="' + esc(c.type) +
                '" title="' + esc(Theory.byId(c.type).name) + '"><small>' + esc(c.numeral) + '</small>' + esc(c.name) + '</button>';
        }).join('');
    }
    function renderRootSelect() { els.rootSelect.value = String(state.chordRoot); }
    function renderTypeSelect() { els.type.value = state.type; }
    function renderLabelsSeg() {
        Array.prototype.forEach.call(els.labels.children, (b) => b.classList.toggle('active', b.dataset.labels === state.labelMode));
    }
    function renderSetChips() {
        const sets = Shapes.setsFor(state.type);
        els.sets.innerHTML = '<button type="button" class="ct-chip' + (state.setFilter === 'all' ? ' active' : '') + '" data-set="all">All sets</button>' +
            sets.map((k) => '<button type="button" class="ct-chip' + (state.setFilter === k ? ' active' : '') + '" data-set="' + k + '">strings ' +
                k.split('').join('-') + '</button>').join('');
    }
    function recomputePlacements() {
        const useFlats = Theory.useFlatsFor(state.chordRoot);
        state.placements = Shapes.shapesFor(state.type, state.setFilter)
            .map((s) => Theory.placeShape(s, state.chordRoot, Theory.MAX_FRET, useFlats))
            .filter(Boolean)
            .sort((a, b) => Shapes.setIndex(a.shape.setKey) - Shapes.setIndex(b.shape.setKey) || a.lowFret - b.lowFret);
        if (state.focusIndex >= state.placements.length) state.focusIndex = 0;
    }
    const VOICING_NAME = { close: 'Close voicing', drop2: 'Drop 2', drop3: 'Drop 3', frag: 'Fragment' };
    function badgesFor(sh) {
        const out = [];
        if (sh.voicing === 'drop2') out.push('drop 2');
        if (sh.voicing === 'drop3') out.push('drop 3');
        if (sh.voicing === 'frag') out.push('fragment');
        let html = out.map((b) => '<span class="ct-badge">' + b + '</span>').join('');
        if (sh.stretch) html += '<span class="ct-badge ct-badge-stretch">stretch</span>';
        return html;
    }
    function cardMarkup(p, idx, tag) {
        const sh = p.shape;
        const open = tag === 'button'
            ? '<button type="button" class="ct-card' + (idx === state.focusIndex ? ' active' : '') + '" data-idx="' + idx + '">'
            : '<div class="ct-card">';
        return open + Diagram.renderFretboard(p, { labelMode: state.labelMode, size: 'card' }) +
            '<div class="ct-card-cap">strings ' + sh.set.join('-') + '</div>' +
            '<div>' + esc(sh.inversionName) + ' · ' + p.lowFret + 'fr</div>' +
            '<div>' + badgesFor(sh) + '</div>' + (tag === 'button' ? '</button>' : '</div>');
    }
    function renderGrid() {
        const n = state.placements.length;
        if (!n) {
            const t = Theory.byId(state.type);
            els.empty.textContent = 'No shapes for ' + (t ? t.name : state.type) + ' on strings ' +
                (state.setFilter === 'all' ? '(any)' : state.setFilter.split('').join('-')) + '.';
            els.empty.classList.remove('hidden');
            els.grid.classList.add('hidden');
            els.focus.classList.add('hidden');
            els.grid.innerHTML = '';
            return;
        }
        els.empty.classList.add('hidden');
        els.grid.classList.remove('hidden');
        els.focus.classList.remove('hidden');
        els.grid.innerHTML = state.placements.map((p, i) => cardMarkup(p, i, 'button')).join('');
    }
    function renderFocus() {
        const base = state.placements[state.focusIndex];
        if (!base) return;
        const up = state.octaveUp ? Theory.octaveUp(base) : null;
        const p = up || base;
        const sh = p.shape;
        const type = Theory.byId(sh.type);
        els.focusSvg.innerHTML = Diagram.renderFretboard(p, { labelMode: state.labelMode, size: 'focus' });
        els.focusTitle.textContent = Theory.chordName(p.rootPc, sh.type, p.useFlats);
        const bass = sh.bassInterval === 0 ? '' : ' (' + Theory.intervalLabel(sh.type, sh.bassInterval) + ' in bass)';
        els.focusSub.textContent = (VOICING_NAME[sh.voicing] || sh.voicing) + ' · ' + sh.inversionName + bass +
            ' · strings ' + sh.set.join('-') + ' · ' + p.lowFret + 'fr';
        els.focusFormula.textContent = type.intervals.map((i) => Theory.intervalLabel(sh.type, i)).join(' ') +
            '  →  ' + Theory.chordToneNames(p.rootPc, sh.type, p.useFlats).join(' ');
        const hints = [];
        const eq = Theory.enharmonicEquivalents(p.rootPc, sh.type);
        if (eq.length) hints.push('Same notes as ' + eq.map((c) => Theory.chordName(c.rootPc, c.type)).join(', '));
        if (sh.stretch) hints.push('Stretch: 4-fret span');
        const sounding = sh.strings.filter(Boolean);
        if (sounding.length === 4 && sh.span === 0) hints.push('Often played as a barre — here with four fingers');
        els.focusHint.textContent = hints.join(' · ');
        els.octave.disabled = !Theory.octaveUp(base);
        els.octave.setAttribute('aria-pressed', state.octaveUp ? 'true' : 'false');
        els.octave.textContent = state.octaveUp ? 'Octave down' : 'Octave up';
    }

    // ── Browse actions ────────────────────────────────────────────────────
    function setFocus(i) {
        const n = state.placements.length;
        if (!n) return;
        const prev = els.grid.children[state.focusIndex];
        if (prev) prev.classList.remove('active');
        state.focusIndex = Theory.mod(i, n);
        state.octaveUp = false;
        const cur = els.grid.children[state.focusIndex];
        if (cur) cur.classList.add('active');
        renderFocus();
    }
    function setRoot(pc) {
        state.root = pc;
        state.chordRoot = pc;
        state.focusIndex = 0;
        state.octaveUp = false;
        store.set('root', pc);
        store.set('chord_root', pc);
        renderWheelState();
        renderBrowse();
    }
    // A specific chord (from the diatonic strip or the drill history): the
    // browsed root/type change, the key stays.
    function selectChord(pc, typeId) {
        if (!Theory.byId(typeId) || !Shapes.shapesFor(typeId).length) return;
        state.chordRoot = pc;
        state.type = typeId;
        if (Shapes.setsFor(typeId).indexOf(state.setFilter) < 0) { state.setFilter = 'all'; store.set('set', 'all'); }
        state.focusIndex = 0;
        state.octaveUp = false;
        store.set('chord_root', pc);
        store.set('type', typeId);
        renderBrowse();
    }
    function setType(typeId) {
        if (!Theory.byId(typeId)) return;
        state.type = typeId;
        if (Shapes.setsFor(typeId).indexOf(state.setFilter) < 0) { state.setFilter = 'all'; store.set('set', 'all'); }
        state.focusIndex = 0;
        state.octaveUp = false;
        store.set('type', typeId);
        renderBrowse();
    }
    function setSetFilter(key) {
        state.setFilter = key === 'all' || Shapes.setsFor(state.type).indexOf(key) >= 0 ? key : 'all';
        state.focusIndex = 0;
        state.octaveUp = false;
        store.set('set', state.setFilter);
        renderSetChips();
        recomputePlacements();
        renderGrid();
        renderFocus();
    }
    function setLabelMode(mode) {
        if (LABEL_MODES.indexOf(mode) < 0) return;
        state.labelMode = mode;
        store.set('labels', mode);
        renderLabelsSeg();
        renderGrid();
        renderFocus();
        if (state.drill.plan && state.drill.status !== 'idle') renderDrillShapes();
    }
    function cycleLabels() {
        setLabelMode(LABEL_MODES[(LABEL_MODES.indexOf(state.labelMode) + 1) % LABEL_MODES.length]);
    }
    function setCircleMode(mode) {
        if (mode !== 'fifths' && mode !== 'fourths') return;
        state.circleMode = mode;
        store.set('circle_mode', mode);
        renderModeButtons();
        relabelWheel();
        renderWheelState();
    }
    function toggleMute() {
        state.muted = !state.muted;
        store.set('muted', state.muted ? '1' : '0');
        if (state.muted) audio.stopAll();
        renderMute();
    }
    function setTab(tab) {
        if (tab !== 'browse' && tab !== 'drill') return;
        state.tab = tab;
        store.set('tab', tab);
        if (tab === 'browse' && state.drill.status === 'running') pauseDrill();
        renderTabs();
    }
    function currentMidis() {
        if (state.tab === 'drill' && state.drill.plan && state.drill.status !== 'idle') {
            const p = state.drill.plan.prompts[state.drill.index];
            return p && p.placements[0] ? p.placements[0].midi : null;
        }
        const base = state.placements[state.focusIndex];
        if (!base) return null;
        const up = state.octaveUp ? Theory.octaveUp(base) : null;
        return (up || base).midi;
    }
    function playCurrent() {
        const midis = currentMidis();
        if (midis) audio.playChord(midis);
    }

    // ── Drill: form ───────────────────────────────────────────────────────
    function readDrillSettings() {
        const kindRadio = els.dKindRadios.filter((r) => r.checked)[0];
        return Drill.normalizeSettings({
            kind: kindRadio ? kindRadio.value : 'random',
            types: els.dTypeBoxes.filter((b) => b.checked).map((b) => b.value),
            sets: state.drillSettings.sets,
            bpm: Number(els.dBpm.value),
            beats: Number(els.dBeats.value),
            autoAdvance: !!els.dAuto.checked,
            reveal: els.dReveal.value,
            count: Number(els.dCount.value),
            click: !!els.dClick.checked,
        }, uiTypes().map((t) => t.id));
    }
    function onDrillFormChange() {
        state.drillSettings = readDrillSettings();
        store.setJSON('drill', state.drillSettings);
        hideFormError();
        renderDrillForm();
    }
    function renderDrillForm() {
        const s = state.drillSettings;
        if (!s) return;
        els.dKindRadios.forEach((r) => { r.checked = r.value === s.kind; });
        els.dTypeBoxes.forEach((b) => { b.checked = s.types.indexOf(b.value) >= 0; });
        els.dTypesField.classList.toggle('ct-disabled', s.kind === 'diatonic');
        els.dTypesNote.classList.toggle('hidden', s.kind !== 'diatonic');
        els.dSetChips.forEach((c) => c.classList.toggle('active', s.sets.indexOf(c.dataset.set) >= 0));
        els.dBpm.value = String(s.bpm);
        els.dBpmVal.textContent = String(s.bpm);
        els.dBeats.value = String(s.beats);
        els.dCount.value = String(s.count);
        els.dAuto.checked = s.autoAdvance;
        els.dReveal.value = s.reveal;
        els.dClick.checked = s.click;
    }
    function showFormError(msg) { els.dError.textContent = msg; els.dError.classList.remove('hidden'); }
    function hideFormError() { els.dError.textContent = ''; els.dError.classList.add('hidden'); }

    // ── Drill: run ────────────────────────────────────────────────────────
    const drillDeps = () => ({
        shapesFor: Shapes.shapesFor, placeShape: Theory.placeShape,
        diatonicChords: Theory.diatonicChords, nextInCircle: Theory.nextInCircle,
    });
    function clearDrillTimer() {
        const dr = state.drill;
        if (dr.timer !== null && dr.timer !== undefined) { clearTimeout(dr.timer); dr.timer = null; }
    }
    function startDrill() {
        const settings = state.drillSettings;
        const seed = ((Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
        const plan = Drill.makePlan(Object.assign({}, settings, {
            rootPc: state.root, keyMode: state.keyMode, circleMode: state.circleMode, sevenths: state.sevenths,
        }), drillDeps(), Drill.mulberry32(seed));
        if (plan.error || !plan.prompts.length) {
            state.drill.status = 'idle';
            renderDrillPanels();
            showFormError('No shapes match these types and string sets.');
            return;
        }
        hideFormError();
        clearDrillTimer();
        Object.assign(state.drill, {
            status: 'running', settings, plan, index: 0, beat: 0, revealed: settings.reveal === 'immediate',
            waiting: false, runSince: Date.now(), elapsedMs: 0, history: [], pausedByHide: false,
        });
        renderDrillPanels();
        showPrompt();
        scheduleBeat();
    }
    function currentPrompt() {
        const dr = state.drill;
        return dr.plan ? dr.plan.prompts[dr.index] : null;
    }
    function showPrompt() {
        const dr = state.drill;
        const p = currentPrompt();
        if (!p) return;
        const s = dr.settings;
        els.dPrompt.textContent = p.name;
        const key = Theory.keyName(state.root, state.keyMode);
        let sub = '';
        if (s.kind === 'diatonic') sub = p.numeral + ' of ' + key;
        else if (s.kind === 'circle') sub = p.next ? 'next: ' + p.next : '';
        else {
            const n = Theory.numeralFor(p.rootPc, p.type, state.root, state.keyMode);
            sub = n ? n + ' of ' + key : '';
        }
        els.dNumeral.textContent = sub;
        els.dCounter.textContent = (dr.index + 1) + ' / ' + (s.count ? s.count : '∞');
        dr.beat = 1;
        els.dBar.classList.remove('ct-waiting');
        renderBeat();
        renderDrillShapes();
        renderDrillControls();
        if (s.click) audio.click(true);
        if (!dr.history.length || dr.history[dr.history.length - 1].name !== p.name) {
            dr.history.push({ name: p.name, rootPc: p.rootPc, type: p.type });
        }
    }
    function renderBeat() {
        const dr = state.drill;
        const beats = dr.settings.beats;
        els.dBeat.textContent = 'beat ' + dr.beat + ' of ' + beats;
        els.dBarFill.style.width = Math.round(Math.min(1, dr.beat / beats) * 100) + '%';
    }
    function renderDrillShapes() {
        const dr = state.drill;
        const p = currentPrompt();
        if (!p) return;
        els.dShapes.innerHTML = p.placements.map((pl, i) => cardMarkup(pl, i, 'div')).join('');
        els.dShapesWrap.classList.toggle('ct-hidden-shapes', !dr.revealed);
    }
    function renderDrillControls() {
        const dr = state.drill;
        els.dPause.innerHTML = (dr.status === 'paused' ? 'Resume' : 'Pause') + '<kbd>Space</kbd>';
        els.dRevealBtn.disabled = dr.revealed;
        els.dNumeral.classList.toggle('text-fb-textDim', true);
    }
    function renderDrillPanels() {
        const st = state.drill.status;
        els.drillSetup.classList.toggle('hidden', st !== 'idle');
        els.drillRun.classList.toggle('hidden', !(st === 'running' || st === 'paused'));
        els.drillDone.classList.toggle('hidden', st !== 'finished');
    }
    function scheduleBeat() {
        const dr = state.drill;
        clearDrillTimer();
        if (dr.status !== 'running') return;
        dr.timer = setTimeout(tick, Drill.beatDurationMs(dr.settings.bpm));
    }
    // Per-beat tick: cached refs only — never a DOM query here.
    function tick() {
        const dr = state.drill;
        dr.timer = null;
        if (dr.status !== 'running') return;
        const s = dr.settings;
        if (dr.beat >= s.beats) {
            if (s.autoAdvance) { advance(1); return; }
            dr.waiting = true;
            els.dBar.classList.add('ct-waiting');
            els.dBeat.textContent = 'your move — N for next';
            return;
        }
        dr.beat++;
        renderBeat();
        if (s.click) audio.click(false);
        if (s.reveal === 'hidden' && !dr.revealed && dr.beat > s.beats / 2) reveal();
        scheduleBeat();
    }
    function reveal() {
        const dr = state.drill;
        if (!dr.plan || dr.revealed) return;
        dr.revealed = true;
        if (state.mounted) {
            els.dShapesWrap.classList.remove('ct-hidden-shapes');
            els.dRevealBtn.disabled = true;
        }
    }
    function advance(d) {
        const dr = state.drill;
        if (!dr.plan || (dr.status !== 'running' && dr.status !== 'paused')) return;
        let next = dr.index + d;
        if (next < 0) next = 0;
        if (next >= dr.plan.prompts.length) {
            const p = dr.plan.next();
            if (!p) { finishDrill(false); return; }
        }
        dr.index = next;
        dr.revealed = dr.settings.reveal === 'immediate';
        dr.waiting = false;
        showPrompt();
        if (dr.status === 'running') scheduleBeat();
    }
    function pauseDrill() {
        const dr = state.drill;
        if (dr.status !== 'running') return;
        clearDrillTimer();
        dr.status = 'paused';
        dr.elapsedMs += Date.now() - dr.runSince;
        if (state.mounted) renderDrillControls();
    }
    function resumeDrill() {
        const dr = state.drill;
        if (dr.status !== 'paused') return;
        dr.status = 'running';
        dr.pausedByHide = false;
        dr.runSince = Date.now();
        if (!dr.waiting) scheduleBeat();
        if (state.mounted) renderDrillControls();
    }
    function togglePause() {
        if (state.drill.status === 'running') pauseDrill();
        else if (state.drill.status === 'paused') resumeDrill();
    }
    function stopDrill() { finishDrill(true); }
    function finishDrill(stopped) {
        const dr = state.drill;
        if (dr.status !== 'running' && dr.status !== 'paused') return;
        if (dr.status === 'running') dr.elapsedMs += Date.now() - dr.runSince;
        clearDrillTimer();
        dr.status = 'finished';
        audio.stopAll();
        if (!state.mounted) return;
        const done = dr.history.length;
        const avg = done ? Drill.formatElapsed(dr.elapsedMs / done) : '0:00';
        els.dSummary.textContent = (stopped ? 'Stopped after ' : 'Completed ') + done + ' chord' + (done === 1 ? '' : 's') +
            ' in ' + Drill.formatElapsed(dr.elapsedMs) + ' · ' + avg + ' per chord.';
        els.dHistory.innerHTML = dr.history.map((h) =>
            '<button type="button" class="ct-chip" data-pc="' + h.rootPc + '" data-type="' + esc(h.type) + '">' + esc(h.name) + '</button>').join('');
        renderDrillPanels();
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────
    function onShow() {
        if (!state.mounted || !els.root || !els.root.isConnected) {
            state.mounted = false;
            if (!mount()) return;
        } else {
            renderAll();
        }
    }
    function onHide() {
        if (state.drill.status === 'running') { pauseDrill(); state.drill.pausedByHide = true; }
        audio.suspend();
    }
    function onScreenChanged(e) {
        const id = e && e.detail && e.detail.id;
        if (id === SCREEN_ID) {
            state.visible = true;
            if (state.ready) onShow(); else pendingShow = true;
        } else if (state.visible) {
            state.visible = false;
            onHide();
        }
    }
    const bus = window.feedBack && typeof window.feedBack.on === 'function' ? window.feedBack : null;
    if (bus) bus.on('screen:changed', onScreenChanged);

    // ── Shortcuts (registered once per script instance) ───────────────────
    const drillActive = () => state.drill.status === 'running' || state.drill.status === 'paused';
    const inDrill = () => state.tab === 'drill' && drillActive();
    const guard = (extra) => () => state.mounted && !inFormControl() && (!extra || !!extra());
    const SHORTCUTS = [
        { key: 'ArrowRight', description: 'Next shape / next drill chord', condition: guard(),
            handler: () => { if (state.tab === 'drill') { if (drillActive()) advance(1); } else setFocus(state.focusIndex + 1); } },
        { key: 'ArrowLeft', description: 'Previous shape / previous drill chord', condition: guard(),
            handler: () => { if (state.tab === 'drill') { if (drillActive()) advance(-1); } else setFocus(state.focusIndex - 1); } },
        { key: 'n', description: 'Next drill chord', condition: guard(inDrill), handler: () => advance(1) },
        { key: 'r', description: 'Reveal hidden shapes', condition: guard(() => state.tab === 'drill' && state.drill.status === 'running'), handler: reveal },
        { key: 'Space', description: 'Pause / resume drill', condition: guard(inDrill), handler: togglePause },
        { key: 'Escape', description: 'Stop drill', condition: guard(inDrill), handler: stopDrill },
        { key: 'p', description: 'Play the focused / current chord', condition: guard(() => !state.muted), handler: playCurrent },
        { key: 'm', description: 'Toggle sound', condition: guard(), handler: toggleMute },
        { key: 'f', description: 'Toggle fifths / fourths', condition: guard(), handler: () => setCircleMode(state.circleMode === 'fifths' ? 'fourths' : 'fifths') },
        { key: 'l', description: 'Cycle dot labels (fingers → intervals → notes)', condition: guard(), handler: cycleLabels },
        { key: 'b', description: 'Switch to Browse', condition: guard(), handler: () => setTab('browse') },
        { key: 'd', description: 'Switch to Drill', condition: guard(), handler: () => setTab('drill') },
    ];
    function installShortcuts() {
        if (typeof window.registerShortcut !== 'function') return;
        SHORTCUTS.forEach((s) => window.registerShortcut({
            key: s.key, description: s.description, scope: SCOPE, condition: s.condition, handler: wrap(s.handler),
        }));
    }
    function uninstallShortcuts() {
        if (typeof window.unregisterShortcut !== 'function') return;
        SHORTCUTS.forEach((s) => { try { window.unregisterShortcut(s.key, SCOPE); } catch (e) { /* ignore */ } });
    }
    installShortcuts();

    function dispose() {
        clearDrillTimer();
        audio.close();
        uninstallShortcuts();
        if (bus && typeof bus.off === 'function') { try { bus.off('screen:changed', onScreenChanged); } catch (e) { /* ignore */ } }
        state.mounted = false;
        state.ready = false;
    }
    g.instance = { dispose, version: VERSION };

    // ── Boot ──────────────────────────────────────────────────────────────
    const preloaded = window.__feedBackChordTutorSkipLoad && SIBLINGS.every((pair) => !!window[pair[1]]);
    (preloaded ? Promise.resolve() : loadAll()).then(wrap(() => {
        Theory = window.ChordTutorTheory;
        Shapes = window.ChordTutorShapes;
        Diagram = window.ChordTutorDiagram;
        Drill = window.ChordTutorDrill;
        readPersisted();
        state.ready = true;
        // Build the DOM eagerly when screen.html is already mounted so the first
        // visit is instant; if the screen is ALREADY the active one (session
        // restore landed here before this script ran) treat that as a show.
        const screenEl = document.getElementById(SCREEN_ID);
        const activeNow = !!(screenEl && screenEl.classList && screenEl.classList.contains('active'));
        if (document.getElementById('ct-root')) mount();
        if (pendingShow || activeNow) {
            pendingShow = false;
            state.visible = true;
            onShow();
        }
    })).catch((err) => { log('load failed', err); showLoadError(err); });

    window.chordTutor = {
        __test: {
            store, state, PREFIX, SCOPE, LABEL_MODES, SHORTCUTS,
            els: () => els,
            familyOf, applySectorClick, uiTypes, toggleSetChip, inFormControl, readPersisted, camel,
            onScreenChanged, pauseDrill, resumeDrill, advance, reveal, finishDrill, clearDrillTimer,
            setDrillForTest: (patch) => Object.assign(state.drill, patch),
            audio,
        },
    };
})();
