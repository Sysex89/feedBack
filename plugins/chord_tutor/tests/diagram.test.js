// Chord Tutor — SVG string builders (fretboard + wheel), pure string checks.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../assets/theory.js');
const S = require('../assets/shapes.js');
const D = require('../assets/diagram.js');

const count = (s, re) => (s.match(re) || []).length;
const dotTexts = (svg) => (svg.match(/<text class="ct-dot-text[^"]*"[^>]*>([^<]*)<\/text>/g) || [])
    .map((t) => t.replace(/^.*>([^<]*)<\/text>$/, '$1'));

const shape = S.shapeById('maj.321.close.r');
const dMajor = T.placeShape(shape, 2);

test('fretboard: dots, mutes, root, fret label', () => {
    const svg = D.renderFretboard(dMajor, {});
    assert.equal(count(svg, /<circle class="ct-dot/g), 3);
    assert.equal(count(svg, /ct-dot-root"/g), 1);
    assert.equal(count(svg, /class="ct-mute"/g), 3);
    assert.ok(svg.includes('>5fr<'));
    assert.ok(!svg.includes('ct-nut'));
    // fret 7 sits in the third window row: fretY0 + 2*fretDy + fretDy/2
    assert.ok(svg.includes('cx="90" cy="104"'));
});

test('fretboard: nut rendering near the first fret', () => {
    const svg = D.renderFretboard(T.placeShape(shape, 10), {});
    assert.ok(svg.includes('class="ct-nut"'));
    assert.ok(!svg.includes('ct-frlabel'));
});

test('fretboard: label modes', () => {
    assert.deepEqual(dotTexts(D.renderFretboard(dMajor, { labelMode: 'finger' })), ['2', '3', '1']);
    assert.deepEqual(dotTexts(D.renderFretboard(dMajor, { labelMode: 'interval' })), ['R', '3', '5']);
    assert.deepEqual(dotTexts(D.renderFretboard(dMajor, { labelMode: 'note' })), ['D', 'F♯', 'A']);
});

test('fretboard: sizes and title', () => {
    assert.ok(D.renderFretboard(dMajor, { size: 'focus' }).includes('width="260" height="320"'));
    assert.ok(D.renderFretboard(dMajor, {}).includes('width="140" height="172"'));
    assert.ok(D.renderFretboard(dMajor, {}).includes('viewBox="0 0 160 196"'));
    assert.equal(D.fretboardTitle(dMajor), 'D — strings 3-2-1, root position, 5fr');
});

test('escaping: no script, hostile symbol is escaped', () => {
    const svg = D.renderFretboard(dMajor, { title: '<script>x</script>' });
    assert.ok(!svg.includes('<script'));
    assert.ok(svg.includes('&lt;script&gt;'));
    assert.equal(D.esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('wheel geometry: C on top, clockwise angles (review B3)', () => {
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    let p = D.polar(210, 210, 100, 0);
    assert.ok(near(p.x, 210) && near(p.y, 110));
    p = D.polar(210, 210, 100, 90);
    assert.ok(near(p.x, 310) && near(p.y, 210));
    const g0 = D.sectorGeometry(0);
    assert.equal(g0.a0, -15);
    assert.equal(g0.a1, 15);
    assert.ok(near(g0.labelOuter.x, 210) && near(g0.labelOuter.y, 35));
    const g3 = D.sectorGeometry(3);
    assert.ok(near(g3.labelOuter.x, 385) && near(g3.labelOuter.y, 210));
});

test('wheel arrow is one fixed clockwise arc (review B4)', () => {
    const arrow = D.renderWheelArrow();
    assert.ok(arrow.includes('class="ct-arrow"'));
    assert.ok(arrow.includes('marker-end="url(#ct-arrow-head)"'));
    assert.equal(D.WHEEL.arrowFrom, 6);
    assert.equal(D.WHEEL.arrowTo, 54);
    assert.equal(D.hubCaption('fifths'), 'clockwise: up a fifth');
    assert.equal(D.hubCaption('fourths'), 'clockwise: up a fourth');
});

test('wheel sectors: 24 groups, mode relabels, hub ids, a11y', () => {
    const w = D.renderWheel('fifths');
    assert.equal(count(w, /<g class="ct-sector"/g), 24);
    assert.equal(count(w, /data-ring="outer"/g), 12);
    assert.equal(count(w, /data-ring="inner"/g), 12);
    assert.equal(count(w, /role="button"/g), 24);
    assert.ok(/<g class="ct-sector" data-ring="outer" data-idx="1" data-pc="7"[^>]*>[^]*?>G<\/text>/.test(w));
    assert.ok(w.includes('id="ct-hub-key"') && w.includes('id="ct-hub-mode"'));
    assert.ok(w.includes('aria-label="G major"'));

    const w4 = D.renderWheel('fourths');
    assert.ok(/<g class="ct-sector" data-ring="outer" data-idx="1" data-pc="5"[^>]*>[^]*?>F<\/text>/.test(w4));
    assert.ok(/<g class="ct-sector" data-ring="inner" data-idx="1" data-pc="2"[^>]*>[^]*?>Dm<\/text>/.test(w4));
});

test('sectorLabelPositions matches renderWheel for every sector in both modes', () => {
    for (const mode of ['fifths', 'fourths']) {
        const pos = D.sectorLabelPositions(mode);
        assert.equal(pos.length, 12);
        const w = D.renderWheel(mode);
        for (const p of pos) {
            assert.ok(w.includes(`data-ring="outer" data-idx="${p.idx}" data-pc="${p.pc}"`), mode + p.idx);
            assert.ok(w.includes(`data-ring="inner" data-idx="${p.idx}" data-pc="${p.minorPc}"`), mode + p.idx);
            // Enharmonic labels ("F♯/G♭") render as two tspans; labelMarkup is the shared builder.
            assert.ok(w.includes(D.labelMarkup(p.major)) && w.includes(D.labelMarkup(p.minor)), mode + p.idx);
        }
    }
});
