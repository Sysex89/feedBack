// Chord Tutor — pure SVG string builders.
//
// renderFretboard(placement, opts) draws one chord-chart style diagram;
// renderWheel(mode) draws the circle of fifths / fourths with data-* hooks the
// screen wires up. Everything returns strings (no DOM), colours live in the
// scoped CSS in screen.html (.ct-* classes). Dual export
// (module.exports + window.ChordTutorDiagram).
(function (root, factory) {
    'use strict';
    const dep = root.ChordTutorTheory || (typeof require === 'function' ? require('./theory.js') : null);
    if (!dep) throw new Error('chord_tutor/diagram.js: theory.js must be loaded first');
    const api = factory(dep);
    if (typeof module === 'object' && module && module.exports) module.exports = api;
    root.ChordTutorDiagram = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Theory) {
    'use strict';

    function esc(v) {
        return String(v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // Compact numeric formatting for path data (integers stay integers).
    const num = (x) => {
        const r = Math.round(x * 100) / 100;
        return String(r === 0 ? 0 : r);
    };

    // ── Fretboard ─────────────────────────────────────────────────────────
    const FB = Object.freeze({
        viewW: 160, viewH: 196,
        stringX0: 30, stringDx: 20,          // x = 30 + k·20, k = 0..5 ⇒ string 6..1
        fretY0: 34, fretDy: 28, fretSpaces: 5,
        dotR: 8.5, muteY: 22, footY: 188,
        sizes: { card: { width: 140, height: 172 }, focus: { width: 260, height: 320 } },
    });

    function fretboardTitle(placement) {
        const sh = placement.shape;
        return Theory.chordName(placement.rootPc, sh.type, placement.useFlats) +
            ' — strings ' + sh.set.join('-') + ', ' + sh.inversionName + ', ' + placement.lowFret + 'fr';
    }

    function renderFretboard(placement, opts) {
        opts = opts || {};
        const labelMode = opts.labelMode || 'finger';
        const size = FB.sizes[opts.size] || FB.sizes.card;
        const sh = placement.shape;
        const winStart = placement.lowFret;
        const x0 = FB.stringX0, dx = FB.stringDx, y0 = FB.fretY0, dy = FB.fretDy;
        const yBottom = y0 + dy * FB.fretSpaces;
        const xRight = x0 + dx * 5;
        const parts = [];
        parts.push('<svg xmlns="http://www.w3.org/2000/svg" class="ct-fretboard" viewBox="0 0 ' + FB.viewW + ' ' + FB.viewH +
            '" width="' + size.width + '" height="' + size.height + '" role="img">');
        parts.push('<title>' + esc(opts.title || fretboardTitle(placement)) + '</title>');
        // frets
        for (let j = 0; j <= FB.fretSpaces; j++) {
            const y = y0 + j * dy;
            parts.push('<line class="ct-fret" x1="' + x0 + '" y1="' + y + '" x2="' + xRight + '" y2="' + y + '"/>');
        }
        // strings
        for (let k = 0; k < 6; k++) {
            const x = x0 + k * dx;
            parts.push('<line class="ct-string" x1="' + x + '" y1="' + y0 + '" x2="' + x + '" y2="' + yBottom + '"/>');
        }
        // nut or fret label
        if (winStart === 1) {
            parts.push('<rect class="ct-nut" x="' + (x0 - 2) + '" y="' + (y0 - 3) + '" width="' + (xRight - x0 + 4) + '" height="4"/>');
        } else {
            parts.push('<text class="ct-frlabel" x="4" y="' + (y0 + dy / 2) + '" dominant-baseline="central">' + winStart + 'fr</text>');
        }
        // dots / mutes / footer
        for (let i = 0; i < 6; i++) {
            const x = x0 + i * dx;
            const s = sh.strings[i];
            if (!s) {
                parts.push('<text class="ct-mute" x="' + x + '" y="' + FB.muteY + '" text-anchor="middle">×</text>');
                continue;
            }
            const f = placement.frets[i];
            const cy = y0 + (f - winStart) * dy + dy / 2;
            const isRoot = s.interval === 0;
            const note = placement.namesByString[i];
            const ivl = Theory.intervalLabel(sh.type, s.interval);
            let dotText;
            if (labelMode === 'interval') dotText = ivl;
            else if (labelMode === 'note') dotText = note;
            else dotText = String(s.finger);
            const footText = labelMode === 'note' ? ivl : note;
            parts.push('<circle class="' + (isRoot ? 'ct-dot ct-dot-root' : 'ct-dot') + '" cx="' + x + '" cy="' + num(cy) + '" r="' + FB.dotR + '"/>');
            parts.push('<text class="ct-dot-text' + (isRoot ? ' ct-dot-text-root' : '') + (dotText.length > 1 ? ' ct-sm' : '') +
                '" x="' + x + '" y="' + num(cy) + '" text-anchor="middle" dominant-baseline="central">' + esc(dotText) + '</text>');
            parts.push('<text class="' + (isRoot ? 'ct-foot ct-foot-root' : 'ct-foot') + '" x="' + x + '" y="' + FB.footY +
                '" text-anchor="middle">' + esc(footText) + '</text>');
        }
        parts.push('</svg>');
        return parts.join('');
    }

    // ── Wheel ─────────────────────────────────────────────────────────────
    const WHEEL = Object.freeze({
        size: 420, cx: 210, cy: 210,
        rOuter: 200, rMid: 150, rInner: 100, rHub: 92,
        rLabelOuter: 175, rLabelInner: 125,
        rArrow: 207, arrowFrom: 6, arrowTo: 54,
        sectorDeg: 30, halfDeg: 15,
    });

    // θ in degrees, clockwise from 12 o'clock.
    function polar(cx, cy, r, deg) {
        const t = deg * Math.PI / 180;
        return { x: cx + r * Math.sin(t), y: cy - r * Math.cos(t) };
    }
    function sectorPath(rOut, rIn, a0, a1) {
        const o1 = polar(WHEEL.cx, WHEEL.cy, rOut, a0), o2 = polar(WHEEL.cx, WHEEL.cy, rOut, a1);
        const i1 = polar(WHEEL.cx, WHEEL.cy, rIn, a0), i2 = polar(WHEEL.cx, WHEEL.cy, rIn, a1);
        return 'M' + num(o1.x) + ' ' + num(o1.y) +
            ' A' + rOut + ' ' + rOut + ' 0 0 1 ' + num(o2.x) + ' ' + num(o2.y) +
            ' L' + num(i2.x) + ' ' + num(i2.y) +
            ' A' + rIn + ' ' + rIn + ' 0 0 0 ' + num(i1.x) + ' ' + num(i1.y) + ' Z';
    }
    // Sector i (0..11) spans [i·30° − 15°, i·30° + 15°]; sector 0 is centred on top.
    function sectorGeometry(i) {
        const centre = i * WHEEL.sectorDeg;
        const a0 = centre - WHEEL.halfDeg, a1 = centre + WHEEL.halfDeg;
        return {
            idx: i, a0, a1, centre,
            labelOuter: polar(WHEEL.cx, WHEEL.cy, WHEEL.rLabelOuter, centre),
            labelInner: polar(WHEEL.cx, WHEEL.cy, WHEEL.rLabelInner, centre),
            outerPath: sectorPath(WHEEL.rOuter, WHEEL.rMid, a0, a1),
            innerPath: sectorPath(WHEEL.rMid, WHEEL.rInner, a0, a1),
        };
    }
    // Per-sector labels for a mode — the in-place relabel path uses this too.
    function sectorLabelPositions(mode) {
        const out = [];
        for (let i = 0; i < 12; i++) {
            const pc = Theory.sectorPc(i, mode);
            const minorPc = Theory.relativeMinor(pc);
            out.push({ idx: i, pc, major: Theory.labelFor('outer', pc), minorPc, minor: Theory.labelFor('inner', minorPc) });
        }
        return out;
    }
    // Two-line labels ("F♯/G♭") become two tspans so they fit the sector.
    function labelMarkup(label) {
        const parts = String(label).split('/');
        if (parts.length < 2) return esc(label);
        return '<tspan x="0" dy="-0.55em">' + esc(parts[0]) + '</tspan><tspan x="0" dy="1.1em">' + esc(parts[1]) + '</tspan>';
    }
    // tspans reset x to the group's translate origin, so the text is placed
    // with a transform rather than x/y attributes.
    function sectorText(pos, label, extraClass) {
        return '<text class="ct-sector-label' + (extraClass ? ' ' + extraClass : '') + '" transform="translate(' + num(pos.x) + ' ' + num(pos.y) +
            ')" x="0" y="0" text-anchor="middle" dominant-baseline="central">' + labelMarkup(label) + '</text>';
    }
    function ariaFor(ring, label) {
        return label.replace(/m$/, '').replace(/m\//, '/') + (ring === 'outer' ? ' major' : ' minor');
    }
    function renderWheelArrow() {
        const a = polar(WHEEL.cx, WHEEL.cy, WHEEL.rArrow, WHEEL.arrowFrom);
        const b = polar(WHEEL.cx, WHEEL.cy, WHEEL.rArrow, WHEEL.arrowTo);
        return '<defs><marker id="ct-arrow-head" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto" markerUnits="userSpaceOnUse">' +
            '<path class="ct-arrow-head" d="M0 0 L8 4 L0 8 Z"/></marker></defs>' +
            '<path class="ct-arrow" d="M' + num(a.x) + ' ' + num(a.y) + ' A' + WHEEL.rArrow + ' ' + WHEEL.rArrow + ' 0 0 1 ' +
            num(b.x) + ' ' + num(b.y) + '" marker-end="url(#ct-arrow-head)"/>';
    }
    const hubCaption = (mode) => (mode === 'fourths' ? 'clockwise: up a fourth' : 'clockwise: up a fifth');

    // Whole inner markup of the wheel <svg> for a mode. The screen keeps the 24
    // <g> refs and relabels them in place when the mode toggles.
    function renderWheel(mode) {
        const labels = sectorLabelPositions(mode);
        const parts = [];
        for (const L of labels) {
            const g = sectorGeometry(L.idx);
            parts.push('<g class="ct-sector" data-ring="outer" data-idx="' + L.idx + '" data-pc="' + L.pc +
                '" role="button" tabindex="0" aria-label="' + esc(ariaFor('outer', L.major)) + '">' +
                '<path d="' + g.outerPath + '"/>' + sectorText(g.labelOuter, L.major) + '</g>');
        }
        for (const L of labels) {
            const g = sectorGeometry(L.idx);
            parts.push('<g class="ct-sector" data-ring="inner" data-idx="' + L.idx + '" data-pc="' + L.minorPc +
                '" role="button" tabindex="0" aria-label="' + esc(ariaFor('inner', L.minor)) + '">' +
                '<path d="' + g.innerPath + '"/>' + sectorText(g.labelInner, L.minor, 'ct-sector-label-inner') + '</g>');
        }
        parts.push(renderWheelArrow());
        parts.push('<circle class="ct-hub" cx="' + WHEEL.cx + '" cy="' + WHEEL.cy + '" r="' + WHEEL.rHub + '"/>');
        parts.push('<text id="ct-hub-key" x="' + WHEEL.cx + '" y="' + (WHEEL.cy - 6) + '" text-anchor="middle" dominant-baseline="central"></text>');
        parts.push('<text id="ct-hub-mode" x="' + WHEEL.cx + '" y="' + (WHEEL.cy + 22) + '" text-anchor="middle" dominant-baseline="central">' +
            esc(hubCaption(mode)) + '</text>');
        return parts.join('');
    }

    return Object.freeze({
        esc, num, FB, WHEEL, polar, sectorPath, sectorGeometry, sectorLabelPositions, labelMarkup, ariaFor,
        fretboardTitle, renderFretboard, renderWheelArrow, hubCaption, renderWheel,
    });
});
