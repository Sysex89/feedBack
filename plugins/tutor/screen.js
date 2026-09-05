/*
 * Guitar & Bass Tutor — frontend.
 *
 *  1. Catalog screen (#plugin-tutor): instrument tabs, one-click pack
 *     generation, drill cards grouped by skill, coaching panel, history.
 *  2. In-player session tracker: when a tutor pack is playing it scores every
 *     chart note on three axes —
 *        notes    hit / miss          (note_detect judgments when installed,
 *                                      otherwise the tutor's own pitch tracker)
 *        rhythm   signed attack error (ms, + = late)
 *        intonation landing pitch     (cents, + = sharp) + drift across the hold
 *     The intonation axis is the tutor's own: a YIN pitch tracker (in a
 *     worker) fed from the instrument input, compared against the chart note's
 *     expected pitch (open-string base + tuning offset + capo + fret + the
 *     arrangement's cent offset). On a fretless instrument a note can be the
 *     right note and still 20 cents out — hit/miss alone would never show it.
 *  3. A small HUD over the player (live cents needle + tallies) and an
 *     end-of-drill report with the coach's recommendations.
 *
 * Pure helpers are exported on window.feedBackTutor.__test for node tests.
 * Vanilla JS, IIFE, fb-* tokens. No per-frame DOM queries: every element the
 * HUD touches is resolved once when it mounts.
 */
(function () {
    'use strict';

    const PLUGIN_ID = 'tutor';
    const SCREEN_ID = 'plugin-' + PLUGIN_ID;
    const API = '/api/plugins/' + PLUGIN_ID;
    const PACK_PREFIX = 'tutor/';
    const LS_SETTINGS = 'tutor.settings';
    const LS_INSTRUMENT = 'tutor.instrument';
    const LS_SKILL = 'tutor.skill';

    const OPEN_MIDI = {
        4: [28, 33, 38, 43],
        5: [23, 28, 33, 38, 43],
        6: [40, 45, 50, 55, 59, 64],
        7: [35, 40, 45, 50, 55, 59, 64],
        8: [30, 35, 40, 45, 50, 55, 59, 64],
    };

    const DEFAULT_SETTINGS = {
        fretless: false,
        toleranceCentsFretted: 25,
        toleranceCentsFretless: 12,
        toleranceMs: 60,
        latencyMs: 60,
        hud: true,
        ownTracker: true,       // run the tutor's pitch tracker even when note_detect is present
    };

    // ── settings ────────────────────────────────────────────────────────────
    function loadSettings() {
        let s = {};
        try { s = JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') || {}; } catch (e) { s = {}; }
        return Object.assign({}, DEFAULT_SETTINGS, s);
    }
    function saveSettings(patch) {
        const next = Object.assign(loadSettings(), patch || {});
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify(next)); } catch (e) { /* storage unavailable */ }
        return next;
    }
    function toleranceCents(s) {
        return s.fretless ? Number(s.toleranceCentsFretless) : Number(s.toleranceCentsFretted);
    }

    // ── pure helpers (tested) ───────────────────────────────────────────────
    function baseOpenMidi(stringCount, isBass) {
        const n = Number(stringCount) || 6;
        if (n === 4 || n === 5) return isBass ? OPEN_MIDI[n] : OPEN_MIDI[6];
        return OPEN_MIDI[n] || OPEN_MIDI[6];
    }

    // Absolute sounding MIDI for string s / fret f — mirrors lib/song.py
    // pitch_from_base: base[s] + tuning offset[s] + capo + fret.
    function expectedMidi(s, f, ctx) {
        const base = baseOpenMidi(ctx.stringCount, ctx.isBass);
        const root = s < base.length ? base[s] : base[base.length - 1];
        const off = (ctx.tuning && Number.isFinite(Number(ctx.tuning[s]))) ? Number(ctx.tuning[s]) : 0;
        return root + off + (Number(ctx.capo) || 0) + (Number(f) || 0);
    }

    function midiToHz(midi, centOffset) {
        return 440 * Math.pow(2, (midi - 69) / 12 + (Number(centOffset) || 0) / 1200);
    }

    // Signed cents of a detected frequency against an expected MIDI note
    // (+ = sharp), honouring the arrangement's cent offset (A443, -1200, …).
    function centsOff(freqHz, midi, centOffset) {
        if (!(freqHz > 0)) return NaN;
        return 1200 * Math.log2(freqHz / midiToHz(midi, centOffset));
    }

    function classifyTiming(ms, tolMs) {
        if (!Number.isFinite(ms)) return null;
        if (ms < -tolMs) return 'early';
        if (ms > tolMs) return 'late';
        return 'ok';
    }
    function classifyPitch(cents, tolCents) {
        if (!Number.isFinite(cents)) return null;
        if (cents < -tolCents) return 'flat';
        if (cents > tolCents) return 'sharp';
        return 'ok';
    }

    function beatPos(t, t0, spb) {
        if (!(spb > 0)) return 'on';
        let frac = ((t - t0) / spb) % 1;
        if (frac < 0) frac += 1;
        if (frac < 0.08 || frac > 0.92) return 'on';
        if (Math.abs(frac - 0.5) < 0.08) return 'off';
        return 'sub';
    }

    function median(arr) {
        if (!arr.length) return NaN;
        const a = arr.slice().sort((x, y) => x - y);
        const m = a.length >> 1;
        return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
    }

    // Compact YIN (de Cheveigné & Kawahara 2002). Runs in the worker below;
    // kept a plain self-contained function so it can be stringified into the
    // worker source AND unit-tested on the main thread.
    function yinDetect(buf, sampleRate, minHz, maxHz, threshold) {
        const n = buf.length;
        const W = n >> 1;                                    // integration window
        const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
        const tauMax = Math.min(W - 1, Math.ceil(sampleRate / minHz));
        if (tauMax <= tauMin) return null;
        const d = new Float32Array(tauMax + 1);
        for (let tau = tauMin; tau <= tauMax; tau++) {
            let sum = 0;
            for (let i = 0; i < W; i++) {
                const diff = buf[i] - buf[i + tau];
                sum += diff * diff;
            }
            d[tau] = sum;
        }
        // Cumulative mean normalised difference, over the evaluated range only.
        const cmnd = new Float32Array(tauMax + 1);
        let running = 0;
        for (let tau = tauMin; tau <= tauMax; tau++) {
            running += d[tau];
            cmnd[tau] = running > 0 ? d[tau] * (tau - tauMin + 1) / running : 1;
        }
        let best = -1;
        for (let tau = tauMin + 1; tau < tauMax; tau++) {
            if (cmnd[tau] < threshold) {
                while (tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
                best = tau;
                break;
            }
        }
        if (best < 0) {
            // No dip under threshold: take the global minimum if it is convincing.
            let mv = Infinity;
            for (let tau = tauMin + 1; tau < tauMax; tau++) if (cmnd[tau] < mv) { mv = cmnd[tau]; best = tau; }
            if (!(mv < 0.5)) return null;
        }
        // Parabolic interpolation around the minimum.
        let tau = best;
        if (tau > tauMin && tau < tauMax) {
            const a = cmnd[tau - 1], b = cmnd[tau], c = cmnd[tau + 1];
            const denom = a - 2 * b + c;
            if (denom !== 0) tau = tau + 0.5 * (a - c) / denom;
        }
        return { freqHz: sampleRate / tau, confidence: 1 - Math.max(0, Math.min(1, cmnd[best])) };
    }

    // ── session tracker (tested) ────────────────────────────────────────────
    // cfg: { notes, chords, tuning, capo, centOffset, stringCount, isBass,
    //        t0, spb, tolCents, tolMs, latencyMs }
    function createTracker(cfg) {
        const ctx = { tuning: cfg.tuning || [], capo: cfg.capo || 0, stringCount: cfg.stringCount || 6, isBass: !!cfg.isBass };
        const centOffset = Number(cfg.centOffset) || 0;
        const targets = [];
        (cfg.notes || []).forEach((n) => targets.push(mkTarget(n.t, n.s, n.f, n.sus)));
        (cfg.chords || []).forEach((c) => (c.notes || []).forEach((cn) => targets.push(mkTarget(c.t, cn.s, cn.f, cn.sus))));
        targets.sort((a, b) => a.t - b.t || a.s - b.s);
        function mkTarget(t, s, f, sus) {
            const midi = expectedMidi(s, f, ctx);
            return {
                t: Number(t) || 0, s: Number(s) || 0, f: Number(f) || 0, sus: Number(sus) || 0, midi,
                beat_pos: beatPos(Number(t) || 0, cfg.t0 || 0, cfg.spb || 0),
                frames: [], nd: null,
            };
        }
        const PRE = 0.12, POST = 0.35;
        let cursor = 0;
        let lastT = -Infinity;
        const live = { cents: NaN, target: null, hits: 0, misses: 0, sharp: 0, flat: 0, early: 0, late: 0 };
        const judged = new Set();

        function windowEnd(tg) { return tg.t + Math.max(tg.sus, POST) + 0.05; }

        // One pitch frame at chart time `chartT` (already latency-compensated).
        function feedPitch(chartT, freqHz, confidence) {
            if (!(confidence > 0.5) || !(freqHz > 0) || !Number.isFinite(chartT)) return;
            if (chartT < lastT - 1) cursor = 0;          // rewind → rescan from the top
            lastT = Math.max(lastT, chartT);
            while (cursor < targets.length && windowEnd(targets[cursor]) < chartT - 2) cursor++;
            let best = null, bestAbs = Infinity;
            for (let i = cursor; i < targets.length; i++) {
                const tg = targets[i];
                if (tg.t - PRE > chartT) break;
                if (windowEnd(tg) < chartT) continue;
                const c = centsOff(freqHz, tg.midi, centOffset);
                const a = Math.abs(c);
                if (a < bestAbs) { bestAbs = a; best = { tg, c }; }
            }
            if (!best || bestAbs > 150) { live.cents = NaN; live.target = null; return; }
            best.tg.frames.push({ dt: chartT - best.tg.t, cents: best.c });
            live.cents = best.c;
            live.target = best.tg;
        }

        // A note_detect judgment (window 'notedetect:hit'/'miss' or bus 'note:hit'/'miss').
        function onJudgment(detail, result) {
            if (!detail) return;
            const note = detail.note || detail.chartNote;
            const t = Number(detail.noteTime);
            if (!note || !Number.isFinite(t)) return;
            const tg = targets.find((x) => Math.abs(x.t - t) < 0.02 && x.s === note.s && x.f === note.f);
            if (!tg) return;
            const key = tg.t + '_' + tg.s + '_' + tg.f;
            if (judged.has(key)) return;
            judged.add(key);
            tg.nd = {
                result: result === 'hit' ? 'hit' : 'miss',
                timing_ms: Number.isFinite(detail.timingError) ? Number(detail.timingError) : null,
                cents: Number.isFinite(detail.pitchError) ? Number(detail.pitchError) : null,
            };
            // The live hit/miss tally is note_detect's when it speaks first;
            // if the own tracker already closed this note, it was counted.
            if (!tg._closed) tallyResult(tg.nd.result, tg.nd.timing_ms);
        }

        function tallyResult(result, timingMs) {
            if (result === 'hit') live.hits++; else if (result === 'miss') live.misses++;
            const tc = classifyTiming(timingMs, cfg.tolMs);
            if (tc === 'early') live.early++; else if (tc === 'late') live.late++;
        }
        function tallyPitch(cents) {
            const pc = classifyPitch(cents, cfg.tolCents);
            if (pc === 'sharp') live.sharp++; else if (pc === 'flat') live.flat++;
        }

        // Own-tracker verdict for one target: hit if the pitch locked on for a
        // couple of frames; timing from the first locked frame; landing cents
        // from the frames after the attack; drift = last third − first third.
        function scoreOwn(tg) {
            const near = tg.frames.filter((fr) => Math.abs(fr.cents) <= 100 && fr.dt >= -PRE);
            if (near.length < 2) return { hit: false, timing_ms: null, cents: null, drift: null };
            const onset = near[0].dt;
            const timing = onset * 1000 - (cfg.latencyMs || 0);
            let settled = near.filter((fr) => fr.dt >= onset + 0.08);
            if (settled.length < 2) settled = near;
            const cs = settled.map((fr) => fr.cents);
            let drift = null;
            if (settled.length >= 6) {
                const third = Math.floor(settled.length / 3);
                drift = median(cs.slice(-third)) - median(cs.slice(0, third));
            }
            return { hit: true, timing_ms: timing, cents: median(cs), drift };
        }

        function finalize(lastChartT) {
            const end = Number.isFinite(lastChartT) ? lastChartT : lastT;
            const out = [];
            let anyNd = false, anyOwn = false;
            targets.forEach((tg) => {
                if (tg.t > end + 0.25) { out.push(rec(tg, 'skipped', null, null, null)); return; }
                const own = scoreOwn(tg);
                if (own.hit) anyOwn = true;
                if (tg.nd) anyNd = true;
                const result = tg.nd ? tg.nd.result : (own.hit ? 'hit' : 'miss');
                const timing = tg.nd && tg.nd.timing_ms != null ? tg.nd.timing_ms : (own.hit ? own.timing_ms : null);
                const cents = own.cents != null ? own.cents : (tg.nd ? tg.nd.cents : null);
                out.push(rec(tg, result, result === 'hit' ? timing : null, result === 'hit' ? cents : null, result === 'hit' ? own.drift : null));
            });
            return { notes: out, source: anyNd && anyOwn ? 'mixed' : anyNd ? 'note_detect' : 'tutor' };
        }
        function rec(tg, result, timing, cents, drift) {
            return {
                t: round3(tg.t), s: tg.s, f: tg.f, midi: tg.midi, sus: round3(tg.sus), result,
                timing_ms: fin(timing), cents: fin(cents), drift: fin(drift), beat_pos: tg.beat_pos,
            };
        }
        function fin(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; }
        function round3(v) { return Math.round(v * 1000) / 1000; }

        // Live tallies for notes whose window has closed. Intonation always
        // comes from the own tracker's frames; hit/miss + timing only when
        // note_detect has not already judged the note.
        function tickOwn(chartT) {
            for (let i = cursor; i < targets.length; i++) {
                const tg = targets[i];
                if (tg.t > chartT) break;
                if (tg._closed) continue;
                if (windowEnd(tg) + 0.1 < chartT) {
                    tg._closed = true;
                    const own = scoreOwn(tg);
                    if (own.hit) tallyPitch(own.cents);
                    if (!tg.nd) tallyResult(own.hit ? 'hit' : 'miss', own.hit ? own.timing_ms : null);
                }
            }
        }

        return { feedPitch, onJudgment, finalize, tickOwn, live, targets, get count() { return targets.length; } };
    }

    // ── pitch source: instrument input → YIN worker → callback ──────────────
    const YIN_SRC = yinDetect.toString();
    function workerSource() {
        return YIN_SRC + '\n' +
            'self.onmessage = function (e) {\n' +
            '  var d = e.data; var r = yinDetect(d.buf, d.sampleRate, d.minHz, d.maxHz, 0.15);\n' +
            '  self.postMessage({ id: d.id, freqHz: r ? r.freqHz : 0, confidence: r ? r.confidence : 0 });\n' +
            '};';
    }

    function createPitchSource(opts) {
        const minHz = opts.minHz || 35, maxHz = opts.maxHz || 1400;
        const onPitch = opts.onPitch;
        const N = 4096;                       // 85 ms @ 48 kHz → down to ~24 Hz
        const ring = new Float32Array(N);
        let write = 0, filled = 0, audioCtx = null, stream = null, proc = null, worker = null;
        let busy = false, stopped = false, seq = 0;
        const win = new Float32Array(N);

        function analyse() {
            if (busy || filled < N) return;
            for (let i = 0; i < N; i++) win[i] = ring[(write + i) % N];
            let rms = 0;
            for (let i = 0; i < N; i++) rms += win[i] * win[i];
            rms = Math.sqrt(rms / N);
            if (rms < 0.002) { onPitch(0, 0); return; }          // -54 dBFS gate
            const sr = audioCtx.sampleRate;
            if (worker) {
                busy = true;
                const copy = win.slice();
                worker.postMessage({ id: ++seq, buf: copy, sampleRate: sr, minHz, maxHz }, [copy.buffer]);
            } else {
                const r = yinDetect(win, sr, minHz, maxHz, 0.15);
                onPitch(r ? r.freqHz : 0, r ? r.confidence : 0);
            }
        }

        async function start() {
            try {
                worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: 'application/javascript' })));
                worker.onmessage = (e) => { busy = false; if (!stopped) onPitch(e.data.freqHz, e.data.confidence); };
                worker.onerror = () => { worker = null; busy = false; };
            } catch (e) { worker = null; }
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
            });
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const src = audioCtx.createMediaStreamSource(stream);
            proc = audioCtx.createScriptProcessor(2048, 1, 1);
            proc.onaudioprocess = (ev) => {
                if (stopped) return;
                const inp = ev.inputBuffer.getChannelData(0);
                for (let i = 0; i < inp.length; i++) { ring[write] = inp[i]; write = (write + 1) % N; }
                filled = Math.min(N, filled + inp.length);
                analyse();
            };
            src.connect(proc);
            // ScriptProcessor needs a sink to run; a muted gain keeps it silent.
            const sink = audioCtx.createGain(); sink.gain.value = 0;
            proc.connect(sink); sink.connect(audioCtx.destination);
            if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch (e) { /* ignore */ } }
        }
        function stop() {
            stopped = true;
            try { if (proc) { proc.disconnect(); proc.onaudioprocess = null; } } catch (e) { /* ignore */ }
            try { if (stream) stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
            try { if (audioCtx) audioCtx.close(); } catch (e) { /* ignore */ }
            try { if (worker) worker.terminate(); } catch (e) { /* ignore */ }
            proc = stream = audioCtx = worker = null;
        }
        return { start, stop };
    }

    // ── catalog cache ───────────────────────────────────────────────────────
    let _catalog = null;           // { exercises: [...], skills: [...] } for ALL instruments
    async function fetchCatalog(force) {
        if (_catalog && !force) return _catalog;
        try {
            const r = await fetch(API + '/catalog');
            if (!r.ok) return _catalog;
            _catalog = await r.json();
        } catch (e) { /* offline */ }
        return _catalog;
    }
    function entryForFilename(filename) {
        if (!_catalog || !filename) return null;
        const f = String(filename).replace(/\\/g, '/');
        return _catalog.exercises.find((e) => e.filename === f) || null;
    }

    // ── in-player session ───────────────────────────────────────────────────
    const sess = { active: null, tracker: null, pitch: null, entry: null, filename: null, raf: 0, posted: false, pendingSpeed: null };
    const bus = () => window.feedBack;

    function isTutorFile(filename) {
        return typeof filename === 'string' && filename.replace(/\\/g, '/').indexOf(PACK_PREFIX) === 0;
    }

    async function startSession(filename) {
        const hw = window.highway;
        if (!hw || typeof hw.getFilteredNotes !== 'function') return;
        const cat = await fetchCatalog(false);
        if (!cat) return;
        const entry = entryForFilename(filename);
        if (!entry) return;
        endSession(false);
        const s = loadSettings();
        const info = (typeof hw.getSongInfo === 'function' && hw.getSongInfo()) || {};
        const stringCount = (typeof hw.getStringCount === 'function' && hw.getStringCount()) || info.stringCount || (entry.instrument === 'bass' ? 4 : 6);
        const tracker = createTracker({
            notes: hw.getFilteredNotes() || [],
            chords: (typeof hw.getFilteredChords === 'function' && hw.getFilteredChords()) || [],
            tuning: (typeof hw.getTuning === 'function' && hw.getTuning()) || info.tuning || [],
            capo: (typeof hw.getCapo === 'function' ? hw.getCapo() : info.capo) || 0,
            centOffset: (typeof hw.getCentOffset === 'function' ? hw.getCentOffset() : info.centOffset) || 0,
            stringCount, isBass: entry.instrument === 'bass',
            t0: entry.t0, spb: entry.spb,
            tolCents: toleranceCents(s), tolMs: Number(s.toleranceMs) || 60, latencyMs: Number(s.latencyMs) || 0,
        });
        sess.active = { startedAt: Date.now(), settings: s };
        sess.tracker = tracker;
        sess.entry = entry;
        sess.filename = filename;
        sess.posted = false;
        if (s.ownTracker !== false && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            const lat = (Number(s.latencyMs) || 0) / 1000;
            const isBass = entry.instrument === 'bass';
            sess.pitch = createPitchSource({
                minHz: isBass ? 35 : 70, maxHz: isBass ? 700 : 1400,
                onPitch: (freq, conf) => {
                    if (sess.tracker !== tracker) return;
                    const t = window.highway.getTime() - lat;
                    tracker.feedPitch(t, freq, conf);
                    if (!(conf > 0.5)) { tracker.live.cents = NaN; tracker.live.target = null; }
                    tracker.tickOwn(t);
                },
            });
            sess.pitch.start().catch((err) => {
                console.warn('[tutor] input unavailable — intonation tracking off:', err && err.message);
                sess.pitch = null;
                hudNote('No input — install note_detect or allow the microphone for intonation tracking.');
            });
        }
        mountHud(entry, s);
        if (sess.pendingSpeed && typeof window.setSpeed === 'function') {
            try { window.setSpeed(sess.pendingSpeed); } catch (e) { /* ignore */ }
            sess.pendingSpeed = null;
        }
    }

    function hasNoteDetect() {
        return typeof window.createNoteDetector === 'function';
    }

    function endSession(post, lastChartT, natural) {
        if (!sess.active) return;
        const tracker = sess.tracker, entry = sess.entry, filename = sess.filename, settings = sess.active.settings;
        if (sess.pitch) { try { sess.pitch.stop(); } catch (e) { /* ignore */ } }
        sess.pitch = null;
        unmountHud();
        sess.active = null; sess.tracker = null; sess.entry = null; sess.filename = null;
        if (!post || sess.posted) return;
        const t = Number.isFinite(lastChartT) ? lastChartT : (window.highway && window.highway.getTime());
        const result = tracker.finalize(t);
        const played = result.notes.filter((n) => n.result !== 'skipped').length;
        if (played === 0) return;                 // nothing scored — no session, no noise
        sess.posted = true;
        const body = {
            exercise_key: entry.key,
            fretless: !!settings.fretless,
            tolerance_cents: toleranceCents(settings),
            tolerance_ms: Number(settings.toleranceMs) || 60,
            speed: currentSpeed(),
            source: result.source,
            notes: result.notes,
        };
        fetch(API + '/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then((r) => (r.ok ? r.json() : null))
            .then((res) => {
                if (!res) return;
                if (natural) showReport(res, filename);
                try { bus().emit('tutor:session-recorded', { exercise_key: entry.key, score: res.profile && res.profile.score }); } catch (e) { /* ignore */ }
                if (document.getElementById('tt-grid') && isScreenActive()) renderScreen();
            })
            .catch((err) => console.warn('[tutor] session post failed', err));
    }

    function currentSpeed() {
        try {
            const a = document.getElementById('audio');
            if (a && Number.isFinite(a.playbackRate) && a.playbackRate > 0) return a.playbackRate;
        } catch (e) { /* ignore */ }
        return 1;
    }

    // ── HUD ─────────────────────────────────────────────────────────────────
    const hud = { root: null, needle: null, cents: null, tally: null, note: null, label: null };
    function mountHud(entry, s) {
        if (!s.hud) return;
        const player = document.getElementById('player') || document.body;
        unmountHud();
        const el = document.createElement('div');
        el.id = 'tutor-hud';
        el.setAttribute('style', 'position:absolute;top:56px;right:12px;z-index:15;min-width:220px;padding:10px 12px;border-radius:12px;' +
            'background:rgba(15,23,42,.82);border:1px solid rgba(51,65,85,.7);color:#f8fafc;font:12px/1.35 system-ui,sans-serif;backdrop-filter:blur(6px);pointer-events:none;');
        el.innerHTML =
            '<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px">' +
            '<span style="font-weight:600">Tutor · ' + esc(entry.title) + '</span>' +
            '<span style="color:#94a3b8">' + (s.fretless ? 'fretless ±' + toleranceCents(s) + '¢' : '±' + toleranceCents(s) + '¢') + '</span></div>' +
            '<div style="position:relative;height:8px;border-radius:9999px;background:linear-gradient(90deg,#3b82f6,#22c55e 50%,#ef4444);opacity:.9">' +
            '<i data-needle style="position:absolute;top:-4px;left:50%;width:4px;height:16px;margin-left:-2px;border-radius:2px;background:#fff;box-shadow:0 0 6px rgba(0,0,0,.6);transition:left .06s linear"></i></div>' +
            '<div style="display:flex;justify-content:space-between;margin-top:4px;color:#94a3b8"><span>♭ flat</span><span data-cents style="color:#f8fafc;font-variant-numeric:tabular-nums">—</span><span>sharp ♯</span></div>' +
            '<div data-tally style="margin-top:6px;color:#cbd5e1;font-variant-numeric:tabular-nums"></div>' +
            '<div data-note style="margin-top:4px;color:#fbbf24;display:none"></div>';
        player.appendChild(el);
        hud.root = el;
        hud.needle = el.querySelector('[data-needle]');
        hud.cents = el.querySelector('[data-cents]');
        hud.tally = el.querySelector('[data-tally]');
        hud.note = el.querySelector('[data-note]');
        let last = 0;
        const loop = (ts) => {
            if (!hud.root) return;
            sess.raf = requestAnimationFrame(loop);
            if (ts - last < 66) return;            // ~15 fps is plenty for a needle
            last = ts;
            paintHud();
        };
        sess.raf = requestAnimationFrame(loop);
    }
    function paintHud() {
        const tr = sess.tracker;
        if (!tr || !hud.root) return;
        const c = tr.live.cents;
        if (Number.isFinite(c)) {
            const pct = 50 + Math.max(-50, Math.min(50, c));
            hud.needle.style.left = pct + '%';
            hud.cents.textContent = (c > 0 ? '+' : '') + c.toFixed(0) + '¢';
            hud.cents.style.color = Math.abs(c) <= toleranceCents(sess.active.settings) ? '#22c55e' : (Math.abs(c) <= 30 ? '#eab308' : '#ef4444');
        } else {
            hud.cents.textContent = '—';
            hud.cents.style.color = '#94a3b8';
        }
        const l = tr.live;
        hud.tally.textContent = '✓ ' + l.hits + '  ✗ ' + l.misses + '   early ' + l.early + ' · late ' + l.late + '   ♭ ' + l.flat + ' · ♯ ' + l.sharp;
    }
    function hudNote(text) {
        if (!hud.note) return;
        hud.note.textContent = text;
        hud.note.style.display = 'block';
    }
    function unmountHud() {
        if (sess.raf) cancelAnimationFrame(sess.raf);
        sess.raf = 0;
        if (hud.root && hud.root.parentNode) hud.root.parentNode.removeChild(hud.root);
        hud.root = hud.needle = hud.cents = hud.tally = hud.note = null;
    }

    // ── report modal (lives on body so it shows over the player) ────────────
    let _modal = null;
    function ensureModal() {
        if (_modal && _modal.isConnected) return _modal;
        _modal = document.createElement('div');
        _modal.id = 'tutor-report';
        _modal.className = 'hidden fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4';
        _modal.innerHTML = '<div class="bg-fb-card border border-fb-border/60 rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl"><div data-body class="p-6"></div></div>';
        _modal.addEventListener('click', (e) => { if (e.target === _modal) closeReport(); });
        document.body.appendChild(_modal);
        return _modal;
    }
    function closeReport() { if (_modal) _modal.classList.add('hidden'); }

    function fmtSigned(v, unit, digits) {
        if (!Number.isFinite(v)) return '—';
        return (v > 0 ? '+' : '') + v.toFixed(digits == null ? 0 : digits) + unit;
    }

    function reportHtml(res, filename) {
        const p = res.profile || {};
        const tm = p.timing || {}, it = p.intonation || {};
        const acc = p.accuracy == null ? '—' : Math.round(p.accuracy * 100) + '%';
        const starStr = '★'.repeat(res.stars || 0) + '<span class="text-fb-textDim">' + '★'.repeat(3 - (res.stars || 0)) + '</span>';
        const recs = (res.recommendations || []).map((r) => recHtml(r)).join('');
        const drift = (it.drift || {}).mean;
        return '' +
            '<div class="flex items-start justify-between gap-4 mb-4">' +
            '<div><div class="text-xs uppercase tracking-wider text-fb-textDim">Drill complete</div>' +
            '<h2 class="text-2xl font-bold text-fb-text">' + esc(res.exercise ? res.exercise.title : '') + '</h2>' +
            '<div class="text-sm text-fb-textDim">' + esc(res.exercise ? res.exercise.skill_label + ' · level ' + res.exercise.level : '') + (p.fretless ? ' · fretless' : '') + '</div></div>' +
            '<div class="text-right"><div class="text-4xl font-bold ' + scoreColor(p.score) + '">' + (p.score == null ? '—' : p.score) + '</div>' +
            '<div class="text-fb-gold text-lg leading-none">' + starStr + '</div>' +
            (res.is_best ? '<div class="text-xs text-fb-good mt-1">New best</div>' : (res.best_score != null ? '<div class="text-xs text-fb-textDim mt-1">Best ' + res.best_score + '</div>' : '')) +
            '</div></div>' +
            '<div class="grid grid-cols-3 gap-3 mb-5">' +
            stat('Notes', acc, p.hits + ' / ' + p.total + ' hit') +
            stat('Rhythm', tm.n ? fmtSigned(tm.mean, ' ms') : '—', tm.n ? 'early ' + pct(tm.early_rate) + ' · late ' + pct(tm.late_rate) : 'no attack data') +
            stat('Intonation', it.n ? fmtSigned(it.mean, '¢') : '—', it.n ? 'flat ' + pct(it.flat_rate) + ' · sharp ' + pct(it.sharp_rate) + (Number.isFinite(drift) ? ' · drift ' + fmtSigned(drift, '¢') : '') : 'no pitch data') +
            '</div>' +
            stringRows(it.by_string, p.weak_strings) +
            '<h3 class="text-sm font-semibold text-fb-text mb-2">Coach</h3>' +
            '<div class="space-y-2 mb-5">' + (recs || '<div class="text-sm text-fb-textDim">No notes.</div>') + '</div>' +
            '<div class="flex flex-wrap gap-2 justify-end">' +
            '<button data-act="close" class="px-3 py-2 rounded-md text-sm text-fb-textDim hover:text-fb-text">Close</button>' +
            '<button data-act="tutor" class="px-3 py-2 rounded-md text-sm bg-fb-cardMuted border border-fb-border/60 text-fb-text hover:border-fb-primary/60">Back to Tutor</button>' +
            '<button data-act="retry" data-file="' + esc(filename) + '" class="px-4 py-2 rounded-md text-sm bg-fb-primary hover:bg-fb-primaryHi text-white font-medium">Play again</button>' +
            '</div>';
    }
    function stat(label, big, small) {
        return '<div class="bg-fb-cardMuted/80 border border-fb-border/40 rounded-xl p-3 tt-stat">' +
            '<div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim">' + label + '</div>' +
            '<div class="text-xl font-bold text-fb-text"><b>' + big + '</b></div>' +
            '<div class="text-xs text-fb-textDim">' + small + '</div></div>';
    }
    function pct(v) { return v == null ? '—' : Math.round(v * 100) + '%'; }
    function scoreColor(sc) { return sc == null ? 'text-fb-textDim' : sc >= 90 ? 'text-fb-good' : sc >= 60 ? 'text-fb-mid' : 'text-fb-low'; }
    function stringRows(byString, weak) {
        const keys = Object.keys(byString || {}).sort((a, b) => Number(a) - Number(b));
        if (!keys.length) return '';
        const rows = keys.map((k) => {
            const st = byString[k];
            const isWeak = (weak || []).indexOf(Number(k)) >= 0;
            return '<div class="flex items-center gap-2 text-xs' + (isWeak ? ' text-fb-low' : ' text-fb-textDim') + '">' +
                '<span class="w-16">String ' + (Number(k) + 1) + '</span>' +
                '<div class="flex-1 h-1.5 rounded-full bg-black/40 overflow-hidden"><span class="block h-full ' + (isWeak ? 'bg-fb-low' : 'bg-fb-primary') + '" style="width:' + Math.round((st.hit_rate || 0) * 100) + '%"></span></div>' +
                '<span class="w-10 text-right">' + pct(st.hit_rate) + '</span>' +
                '<span class="w-14 text-right">' + (st.n ? fmtSigned(st.mean, '¢') : '') + '</span></div>';
        }).join('');
        return '<div class="mb-5"><h3 class="text-sm font-semibold text-fb-text mb-2">Per string (1 = lowest)</h3><div class="space-y-1">' + rows + '</div></div>';
    }
    function recHtml(r) {
        const prio = r.priority <= 1 ? 'border-fb-primary/60' : r.priority === 2 ? 'border-fb-mid/60' : 'border-fb-border/50';
        return '<div class="bg-fb-cardMuted/70 border ' + prio + ' rounded-xl p-3">' +
            '<div class="flex items-start justify-between gap-3"><div>' +
            '<div class="text-sm font-semibold text-fb-text">' + esc(r.title) + '</div>' +
            '<div class="text-xs text-fb-textDim mt-0.5">' + esc(r.reason) + '</div>' +
            (r.tip ? '<div class="text-xs text-fb-primaryHi mt-1">Tip: ' + esc(r.tip) + '</div>' : '') + '</div>' +
            (r.exercise_key ? '<button data-act="practice" data-key="' + esc(r.exercise_key) + '" data-speed="' + (r.speed || '') + '" class="shrink-0 text-xs px-3 py-1.5 rounded-md bg-fb-primary/20 border border-fb-primary/50 text-fb-text hover:bg-fb-primary/35 whitespace-nowrap">' +
                esc(r.exercise_title || 'Practise') + (r.speed ? ' @ ' + Math.round(r.speed * 100) + '%' : '') + '</button>' : '') +
            '</div></div>';
    }

    function showReport(res, filename) {
        const m = ensureModal();
        const body = m.querySelector('[data-body]');
        body.innerHTML = reportHtml(res, filename);
        body.onclick = (e) => {
            const btn = e.target.closest('button[data-act]');
            if (!btn) return;
            const act = btn.getAttribute('data-act');
            if (act === 'close') closeReport();
            else if (act === 'tutor') { closeReport(); if (typeof window.showScreen === 'function') window.showScreen(SCREEN_ID); }
            else if (act === 'retry') { closeReport(); practise(btn.getAttribute('data-file'), null); }
            else if (act === 'practice') { closeReport(); practiseKey(btn.getAttribute('data-key'), Number(btn.getAttribute('data-speed')) || null); }
        };
        m.classList.remove('hidden');
    }

    async function practiseKey(key, speed) {
        const cat = await fetchCatalog(false);
        const e = cat && cat.exercises.find((x) => x.key === key);
        if (!e) return;
        if (e.status !== 'built') {
            await buildPacks({ keys: [key] });
        }
        practise(e.filename, speed);
    }
    function practise(filename, speed) {
        if (typeof window.playSong !== 'function') return;
        sess.pendingSpeed = speed && speed !== 1 ? speed : null;
        try { window.playSong(filename, 0); } catch (err) { console.warn('[tutor] playSong failed', err); }
    }

    // ── pack generation ─────────────────────────────────────────────────────
    async function buildPacks(body) {
        const btn = document.getElementById('tt-build-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
        let res = null;
        try {
            const r = await fetch(API + '/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
            res = await r.json().catch(() => null);
            if (!r.ok) {
                setBanner('Could not generate exercises', (res && res.error) || ('HTTP ' + r.status), true);
                return null;
            }
            if (!res.rescan_kicked) { try { await fetch('/api/rescan', { method: 'POST' }); } catch (e) { /* ignore */ } }
            await waitForScan();
        } catch (err) {
            setBanner('Could not generate exercises', String(err && err.message || err), true);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = 'Generate exercises'; }
        }
        await fetchCatalog(true);
        if (isScreenActive()) renderScreen();
        return res;
    }
    async function waitForScan() {
        for (let i = 0; i < 40; i++) {
            try {
                const r = await fetch('/api/scan-status');
                const st = r.ok ? await r.json() : null;
                if (!st || !st.running) return;
            } catch (e) { return; }
            await new Promise((ok) => setTimeout(ok, 500));
        }
    }
    function setBanner(title, body, show) {
        const b = document.getElementById('tt-build-banner');
        if (!b) return;
        b.classList.toggle('hidden', !show);
        const t = document.getElementById('tt-build-title'), d = document.getElementById('tt-build-body');
        if (t && title) t.textContent = title;
        if (d && body) d.textContent = body;
    }

    // ── catalog screen ──────────────────────────────────────────────────────
    const ui = { instrument: 'guitar', skill: 'all' };
    try { ui.instrument = localStorage.getItem(LS_INSTRUMENT) || 'guitar'; ui.skill = localStorage.getItem(LS_SKILL) || 'all'; } catch (e) { /* ignore */ }

    function isScreenActive() {
        const el = document.getElementById(SCREEN_ID);
        return !!el && !el.classList.contains('hidden') && el.offsetParent !== null;
    }

    async function renderScreen() {
        const root = document.getElementById('tt-root');
        if (!root) return;
        const s = loadSettings();
        const fl = document.getElementById('tt-fretless');
        if (fl) { fl.checked = !!s.fretless; fl.onchange = () => { saveSettings({ fretless: fl.checked }); renderScreen(); }; }
        const cat = await fetchCatalog(true);
        if (!cat) {
            setBanner('Tutor backend unreachable', 'Could not load the exercise catalog.', true);
            return;
        }
        // Instrument tabs
        const tabs = document.getElementById('tt-instruments');
        if (tabs) {
            tabs.innerHTML = ['guitar', 'bass'].map((i) =>
                '<button role="tab" data-inst="' + i + '" aria-selected="' + (ui.instrument === i) + '" class="px-4 py-2 text-sm ' +
                (ui.instrument === i ? 'bg-fb-primary text-white' : 'bg-fb-card/70 text-fb-textDim hover:text-fb-text') + '">' + (i === 'guitar' ? 'Guitar' : 'Bass') + '</button>').join('');
            tabs.onclick = (e) => {
                const b = e.target.closest('button[data-inst]');
                if (!b) return;
                ui.instrument = b.getAttribute('data-inst');
                try { localStorage.setItem(LS_INSTRUMENT, ui.instrument); } catch (err) { /* ignore */ }
                renderScreen();
            };
        }
        const mine = cat.exercises.filter((e) => e.instrument === ui.instrument);
        const missing = mine.filter((e) => e.status !== 'built');
        if (!cat.dlc_configured) {
            setBanner('No library folder yet', 'Pick a library folder in Settings first — the tutor writes its drills there.', true);
        } else if (missing.length) {
            setBanner(missing.length === mine.length ? 'Exercises need to be generated once' : missing.length + ' drills are missing or outdated',
                'The tutor writes each drill as a small song package into your library folder (click track + drone, under a megabyte each).', true);
            const btn = document.getElementById('tt-build-btn');
            if (btn) btn.onclick = () => buildPacks({ keys: missing.map((e) => e.key), force: true });
        } else {
            setBanner(null, null, false);
        }
        // Skill pills
        const pills = document.getElementById('tt-skills');
        if (pills) {
            const all = [{ id: 'all', label: 'All' }].concat(cat.skills || []);
            pills.innerHTML = all.map((sk) => '<button data-skill="' + sk.id + '" aria-pressed="' + (ui.skill === sk.id) + '" class="tt-pill text-xs px-3 py-1.5 rounded-full border border-fb-border/60 text-fb-textDim hover:text-fb-text">' + esc(sk.label) + '</button>').join('');
            pills.onclick = (e) => {
                const b = e.target.closest('button[data-skill]');
                if (!b) return;
                ui.skill = b.getAttribute('data-skill');
                try { localStorage.setItem(LS_SKILL, ui.skill); } catch (err) { /* ignore */ }
                renderScreen();
            };
        }
        const shown = mine.filter((e) => ui.skill === 'all' || e.skill === ui.skill);
        const grid = document.getElementById('tt-grid');
        if (grid) {
            grid.innerHTML = shown.map(cardHtml).join('') || '<div class="text-sm text-fb-textDim">No drills in this skill.</div>';
            grid.onclick = (e) => {
                const b = e.target.closest('button[data-play]');
                if (!b) return;
                practiseKey(b.getAttribute('data-play'), null);
            };
        }
        const sum = document.getElementById('tt-summary');
        if (sum) {
            const done = mine.filter((e) => e.best_score != null).length;
            sum.textContent = done + ' of ' + mine.length + ' drills played' + (s.fretless ? ' · fretless tolerance ±' + toleranceCents(s) + '¢' : '');
        }
        const refresh = document.getElementById('tt-refresh');
        if (refresh) refresh.onclick = () => renderScreen();
        renderCoach();
        renderHistory();
    }

    function cardHtml(e) {
        const best = e.best_score;
        const badge = best == null ? '<span class="text-xs text-fb-textDim">Not played</span>' :
            '<span class="text-sm font-bold ' + scoreColor(best) + '">' + best + '</span><span class="text-fb-gold text-xs ml-1">' + '★'.repeat(best >= 90 ? 3 : best >= 75 ? 2 : best >= 60 ? 1 : 0) + '</span>';
        const status = e.status === 'built' ? '' : '<span class="text-[0.625rem] uppercase tracking-wider text-fb-mid ml-2">' + (e.status === 'stale' ? 'outdated' : 'not generated') + '</span>';
        return '<div class="tt-card bg-fb-card/80 backdrop-blur border border-fb-border/50 rounded-xl p-4 flex flex-col gap-2">' +
            '<div class="flex items-start justify-between gap-2">' +
            '<div><div class="text-[0.625rem] uppercase tracking-wider text-fb-textDim tt-level">' + esc(e.skill_label) + ' · L' + e.level + (e.drone ? ' · drone' : '') + '</div>' +
            '<div class="text-base font-semibold text-fb-text">' + esc(e.title) + status + '</div></div>' +
            '<div class="text-right whitespace-nowrap">' + badge + '</div></div>' +
            '<p class="text-xs text-fb-textDim flex-1">' + esc(e.description) + '</p>' +
            '<div class="flex items-center justify-between text-xs text-fb-textDim">' +
            '<span>' + e.bpm + ' bpm · ' + Math.round(e.duration) + ' s · ' + e.note_count + ' notes' + (e.sessions ? ' · ' + e.sessions + '×' : '') + '</span>' +
            '<button data-play="' + esc(e.key) + '" class="px-3 py-1.5 rounded-md bg-fb-primary hover:bg-fb-primaryHi text-white font-medium">' + (e.status === 'built' ? 'Practise' : 'Generate & play') + '</button>' +
            '</div></div>';
    }

    async function renderCoach() {
        const el = document.getElementById('tt-coach');
        if (!el) return;
        let data = null;
        try {
            const r = await fetch(API + '/analysis?instrument=' + encodeURIComponent(ui.instrument));
            data = r.ok ? await r.json() : null;
        } catch (e) { data = null; }
        if (!data) { el.innerHTML = ''; return; }
        const p = data.profile;
        const recs = (data.recommendations || []).slice(0, 4).map(recHtml).join('');
        const skills = data.skills || {};
        const skillRow = Object.keys(skills).length ? '<div class="flex flex-wrap gap-2 mb-3">' + Object.keys(skills).map((k) => {
            const sk = skills[k];
            return '<span class="text-xs px-2 py-1 rounded-md bg-fb-cardMuted/80 border border-fb-border/40 text-fb-textDim">' + esc(k) + ' <b class="' + scoreColor(sk.best_score) + '">' + (sk.best_score == null ? '—' : sk.best_score) + '</b> <span class="opacity-70">(' + sk.sessions + ')</span></span>';
        }).join('') + '</div>' : '';
        const head = p ? '<div class="text-xs text-fb-textDim mb-2">Based on your last ' + data.sessions_considered + ' session' + (data.sessions_considered === 1 ? '' : 's') +
            ' — notes ' + pct(p.accuracy) + ', timing ' + (p.timing && p.timing.n ? fmtSigned(p.timing.mean, ' ms') : '—') + ', pitch ' + (p.intonation && p.intonation.n ? fmtSigned(p.intonation.mean, '¢') : '—') + '.</div>' : '';
        el.innerHTML = '<div class="bg-fb-card/80 backdrop-blur border border-fb-border/50 rounded-xl p-4">' +
            '<div class="flex items-center justify-between mb-2"><h2 class="text-sm font-semibold text-fb-text">Coach</h2>' +
            (p ? '<span class="text-xs text-fb-textDim">' + (p.fretless ? 'fretless' : 'fretted') + ' profile</span>' : '') + '</div>' +
            head + skillRow + '<div class="grid grid-cols-1 md:grid-cols-2 gap-2">' + recs + '</div></div>';
        el.onclick = (e) => {
            const btn = e.target.closest('button[data-act="practice"]');
            if (!btn) return;
            practiseKey(btn.getAttribute('data-key'), Number(btn.getAttribute('data-speed')) || null);
        };
    }

    async function renderHistory() {
        const el = document.getElementById('tt-history');
        if (!el) return;
        let data = null;
        try {
            const r = await fetch(API + '/sessions?instrument=' + encodeURIComponent(ui.instrument) + '&limit=12');
            data = r.ok ? await r.json() : null;
        } catch (e) { data = null; }
        const rows = (data && data.sessions) || [];
        if (!rows.length) { el.innerHTML = '<div class="text-sm text-fb-textDim">No sessions yet. Pick a drill above.</div>'; return; }
        el.innerHTML = rows.map((r) => {
            const when = new Date(r.created_at * 1000);
            return '<div class="flex items-center gap-3 text-sm bg-fb-card/60 border border-fb-border/40 rounded-lg px-3 py-2">' +
                '<span class="w-24 text-xs text-fb-textDim">' + when.toLocaleDateString() + ' ' + when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>' +
                '<span class="flex-1 text-fb-text">' + esc(r.title) + (r.fretless ? ' <span class="text-[0.625rem] uppercase text-fb-textDim">fretless</span>' : '') + '</span>' +
                '<span class="text-xs text-fb-textDim">' + pct(r.accuracy) + ' notes</span>' +
                '<b class="' + scoreColor(r.score) + '">' + (r.score == null ? '—' : r.score) + '</b></div>';
        }).join('');
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // ── wiring ──────────────────────────────────────────────────────────────
    function wire() {
        const b = bus();
        if (!b || typeof b.on !== 'function') {
            window.addEventListener('feedBack:capabilities:ready', wire, { once: true });
            return;
        }
        b.on('screen:changed', (e) => {
            const id = e && e.detail && e.detail.id;
            if (id === SCREEN_ID) renderScreen();
            else if (id !== 'player' && sess.active) endSession(true, null, false);
        });
        b.on('song:loading', (e) => {
            const d = (e && e.detail) || {};
            if (sess.active) endSession(true, null, false);
            sess._next = isTutorFile(d.filename) ? d.filename : null;
        });
        b.on('song:ready', () => {
            const f = sess._next || (window.feedBack.currentSong && window.feedBack.currentSong.filename);
            if (isTutorFile(f)) startSession(f);
        });
        b.on('song:arrangement-changed', () => {
            if (sess.active) { const f = sess.filename; endSession(false); startSession(f); }
        });
        b.on('song:ended', (e) => endSession(true, e && e.detail && e.detail.chartT, true));
        b.on('song:stop', (e) => endSession(true, e && e.detail && e.detail.time, false));
        // Rewind past the start = a fresh attempt; drop what was tallied.
        b.on('song:seek', (e) => {
            const d = (e && e.detail) || {};
            if (sess.active && Number.isFinite(d.to) && d.to < 0.5 && d.from > 2) { const f = sess.filename; endSession(false); startSession(f); }
        });
        // note_detect judgments (bus form; the window CustomEvents carry the same detail).
        b.on('note:hit', (e) => { if (sess.tracker) sess.tracker.onJudgment(e && e.detail, 'hit'); });
        b.on('note:miss', (e) => { if (sess.tracker) sess.tracker.onJudgment(e && e.detail, 'miss'); });
        if (b.diagnostics && typeof b.diagnostics.contribute === 'function') {
            b.diagnostics.contribute(PLUGIN_ID, { schema: 'tutor.client_diag.v1', settings: loadSettings() });
        }
    }
    wire();
    if (document.getElementById('tt-root') && isScreenActive()) renderScreen();

    window.feedBackTutor = {
        version: 1,
        getSettings: loadSettings,
        saveSettings,
        refresh: () => { if (isScreenActive()) renderScreen(); },
        practise: practiseKey,
        __test: { OPEN_MIDI, baseOpenMidi, expectedMidi, midiToHz, centsOff, classifyTiming, classifyPitch, beatPos, median, yinDetect, createTracker, isTutorFile, DEFAULT_SETTINGS },
    };
    // settings.html mounts before this script runs; let it hydrate now.
    try { window.dispatchEvent(new CustomEvent('tutor:ready')); } catch (e) { /* no CustomEvent in bare vm */ }
})();
