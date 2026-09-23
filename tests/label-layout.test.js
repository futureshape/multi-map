const { test } = require('node:test');
const assert = require('node:assert/strict');
const { place } = require('../label-layout.js');

const viewport = { width: 1024, height: 768 };
const makeLabel = (id, x, y, options = {}) => ({
    id, x, y, width: 100, height: 24, radius: 16, type: 'aircraft', ...options
});
const iconRect = label => ({
    left: label.x - label.radius, right: label.x + label.radius,
    top: label.y - label.radius, bottom: label.y + label.radius
});

function assertSeparated(a, b, gap = 6) {
    assert.ok(a.right + gap <= b.left || b.right + gap <= a.left ||
        a.bottom + gap <= b.top || b.bottom + gap <= a.top,
    `Overlapping rectangles: ${JSON.stringify(a)}, ${JSON.stringify(b)}`);
}

// Independent parametric segment test for checking the returned geometry.
function segmentsMeet(a, b) {
    const rx = a.endX - a.startX;
    const ry = a.endY - a.startY;
    const sx = b.endX - b.startX;
    const sy = b.endY - b.startY;
    const qx = b.startX - a.startX;
    const qy = b.startY - a.startY;
    const determinant = rx * sy - ry * sx;
    const epsilon = 1e-8;
    if (Math.abs(determinant) > epsilon) {
        const t = (qx * sy - qy * sx) / determinant;
        const u = (qx * ry - qy * rx) / determinant;
        return t >= -epsilon && t <= 1 + epsilon && u >= -epsilon && u <= 1 + epsilon;
    }
    if (Math.abs(qx * ry - qy * rx) > epsilon) return false;
    return Math.max(Math.min(a.startX, a.endX), Math.min(b.startX, b.endX)) <=
        Math.min(Math.max(a.startX, a.endX), Math.max(b.startX, b.endX)) + epsilon &&
        Math.max(Math.min(a.startY, a.endY), Math.min(b.startY, b.endY)) <=
        Math.min(Math.max(a.startY, a.endY), Math.max(b.startY, b.endY)) + epsilon;
}

function assertLeadersClear(placements) {
    const entries = [...placements.values()];
    entries.forEach(({ leader }, i) => {
        entries.forEach(({ rect, leader: other }, j) => {
            if (i === j) return;
            assert.ok(!segmentsMeet(leader, other), 'Leader lines cross, touch or overlap');
            for (const [startX, startY, endX, endY] of [
                [rect.left, rect.top, rect.right, rect.top],
                [rect.right, rect.top, rect.right, rect.bottom],
                [rect.right, rect.bottom, rect.left, rect.bottom],
                [rect.left, rect.bottom, rect.left, rect.top]
            ]) {
                assert.ok(!segmentsMeet(leader, { startX, startY, endX, endY }),
                    'Leader passes through another label');
            }
            const inside = (x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
            assert.ok(!inside(leader.startX, leader.startY) && !inside(leader.endX, leader.endY));
        });
    });
}

function assertClear(placements, obstacles = [], bounds = viewport) {
    const rectangles = [...placements.values()].map(p => p.rect);
    rectangles.forEach((rect, i) => {
        assert.ok(rect.left >= 8 && rect.top >= 8);
        assert.ok(rect.right <= bounds.width - 8 && rect.bottom <= bounds.height - 8);
        rectangles.slice(i + 1).forEach(other => assertSeparated(rect, other));
        obstacles.forEach(other => assertSeparated(rect, other));
    });
    assertLeadersClear(placements);
}

function assertOnscreen(placements, bounds = viewport) {
    for (const { rect, leader } of placements.values()) {
        for (const value of [...Object.values(rect), ...Object.values(leader)]) assert.ok(Number.isFinite(value));
        assert.ok(rect.left >= 0 && rect.top >= 0);
        assert.ok(rect.left < bounds.width && rect.top < bounds.height);
        if (rect.right - rect.left <= bounds.width) assert.ok(rect.right <= bounds.width);
        else assert.equal(rect.left, 0, 'Oversized text should start at the visible edge');
        if (rect.bottom - rect.top <= bounds.height) assert.ok(rect.bottom <= bounds.height);
        else assert.equal(rect.top, 0);
    }
}

test('dense mixed traffic keeps every label visible even when clashes are unavoidable', () => {
    const labels = Array.from({ length: 100 }, (_, i) => makeLabel(`traffic-${i}`,
        460 + i % 5 * 12, 340 + Math.floor(i / 5) * 3,
        { type: i % 2 ? 'vessel' : 'aircraft', width: 75 + i % 7 * 15 }));
    const obstacles = labels.map(iconRect);
    const placements = place(labels, { ...viewport, obstacles });
    assert.equal(placements.size, labels.length);
    assertOnscreen(placements);
});

test('long label bounds are checked even when centers are over 200px apart', () => {
    const labels = [makeLabel('long', 80, 250, { width: 650 }), makeLabel('near-end', 650, 250)];
    const obstacles = labels.map(iconRect);
    const placements = place(labels, { ...viewport, obstacles });
    assert.equal(placements.size, 2);
    assertClear(placements, obstacles);
});

test('labels avoid their own icon, unlabelled icons, controls and open popups', () => {
    const labels = [makeLabel('one', 500, 300)];
    const obstacles = [iconRect(labels[0]),
        { left: 524, right: 655, top: 278, bottom: 324 },
        { left: 780, right: 1014, top: 10, bottom: 110 },
        { left: 350, right: 480, top: 220, bottom: 330 }];
    const placements = place(labels, { ...viewport, obstacles });
    assert.equal(placements.size, 1);
    assertClear(placements, obstacles);
});

test('all four viewport corners get inward-facing labels', () => {
    const labels = [makeLabel('NW', 8, 8), makeLabel('NE', 1016, 8),
        makeLabel('SW', 8, 760), makeLabel('SE', 1016, 760)];
    const obstacles = labels.map(iconRect);
    const placements = place(labels, { ...viewport, obstacles });
    assert.equal(placements.size, 4);
    assertClear(placements, obstacles);
});

test('valid previous placements remain stable as markers move and data order changes', () => {
    const labels = [makeLabel('B', 400, 400), makeLabel('A', 420, 400)];
    const first = place(labels, { ...viewport, obstacles: labels.map(iconRect) });
    const moved = labels.map(label => ({ ...label, x: label.x + 3, y: label.y + 2 })).reverse();
    const next = place(moved, { ...viewport, obstacles: moved.map(iconRect), previous: first });
    assert.equal(next.size, 2);
    for (const [id, placement] of first) {
        assert.equal(next.get(id).dx, placement.dx);
        assert.equal(next.get(id).dy, placement.dy);
    }
    assertClear(next, moved.map(iconRect));
});

test('a changed name or font size invalidates colliding previous bounds', () => {
    const labels = [makeLabel('A', 400, 350), makeLabel('B', 560, 350)];
    const previous = place(labels, { ...viewport, obstacles: labels.map(iconRect) });
    labels[0].width = 470;
    labels[0].height = 38;
    const next = place(labels, { ...viewport, obstacles: labels.map(iconRect), previous });
    assert.equal(next.size, 2);
    assert.equal(next.get('A').rect.right - next.get('A').rect.left, 470);
    assertClear(next, labels.map(iconRect));
});

test('higher-priority labels get scarce space independent of insertion order', () => {
    const options = { width: 190, height: 70, distances: [12] };
    const low = makeLabel('low', 30, 35, { priority: 1 });
    const high = makeLabel('high', 30, 35, { priority: 1000 });
    const placements = place([low, high], { ...options, obstacles: [iconRect(high)] });
    assert.deepEqual([...placements.keys()], ['high', 'low']);
    const highOnly = place([high], { ...options, obstacles: [iconRect(high)] });
    assert.deepEqual(placements.get('high'), highOnly.get('high'));
    assertOnscreen(placements, options);
});

test('blocked and oversized labels stay visible; offscreen markers need no placement', () => {
    const label = makeLabel('returning', 300, 300);
    const blocked = place([label], { ...viewport, obstacles: [{ left: 0, top: 0, right: 1024, bottom: 768 }] });
    assert.equal(blocked.size, 1);
    assertOnscreen(blocked);
    const oversized = place([{ ...label, width: 2000 }], viewport);
    assert.equal(oversized.size, 1);
    assertOnscreen(oversized);
    assert.equal(place([{ ...label, x: -20 }], viewport).size, 0);
    assert.equal(place([label], { ...viewport, previous: blocked }).size, 1);
});

test('fallback minimizes overlap instead of blindly using the default position', () => {
    const label = makeLabel('blocked', 500, 300);
    const defaultPosition = { left: 528, top: 288, right: 628, bottom: 312 };
    // Every candidate hits the first obstacle. The default also hits the
    // second obstacle, so another direction must win the fallback scoring.
    const obstacles = [{ left: 0, top: 0, right: 1024, bottom: 768 }, defaultPosition];
    const placements = place([label], { ...viewport, obstacles, distances: [12] });
    assert.equal(placements.size, 1);
    assertSeparated(placements.get(label.id).rect, defaultPosition);
    assertOnscreen(placements);
});

test('even an empty candidate configuration keeps a label visible', () => {
    const placements = place([makeLabel('no-candidates', 500, 300)], { ...viewport, distances: [] });
    assert.equal(placements.size, 1);
    assertOnscreen(placements);
});

test('a resized viewport never reuses a placement beyond its new edges', () => {
    const label = makeLabel('resize', 285, 120);
    const previous = place([label], viewport);
    const bounds = { width: 320, height: 240 };
    const next = place([label], { ...bounds, previous, obstacles: [iconRect(label)] });
    assert.equal(next.size, 1);
    assertClear(next, [iconRect(label)], bounds);
});

test('leader ends touch their own label border and point back toward their marker', () => {
    const label = makeLabel('leader', 400, 400);
    const placement = place([label], { ...viewport, obstacles: [iconRect(label)] }).get(label.id);
    const { rect, leader } = placement;
    assert.ok(leader.endX === rect.left || leader.endX === rect.right ||
        leader.endY === rect.top || leader.endY === rect.bottom);
    assert.equal(Math.hypot(leader.startX - label.x, leader.startY - label.y), label.radius);
    assert.ok(leader.endX >= rect.left && leader.endX <= rect.right);
    assert.ok(leader.endY >= rect.top && leader.endY <= rect.bottom);
});

test('the crossing vessel leaders from the screenshot are repositioned without hiding a label', () => {
    const labels = [
        makeLabel('ELIZABETHAN', 253, 340, { width: 192, height: 48, type: 'vessel' }),
        makeLabel('GOLDEN JUBILEE', 218, 327, { width: 228, height: 48, type: 'vessel' }),
        makeLabel('TYPHOON CLIPPER', 301, 362, { width: 250, height: 48, type: 'vessel' })
    ];
    const previous = new Map([
        ['ELIZABETHAN', { dx: 156 - 253, dy: 136 - 340 }],
        ['GOLDEN JUBILEE', { dx: 371 - 218, dy: 128 - 327 }],
        ['TYPHOON CLIPPER', { dx: 277 - 301, dy: 222 - 362 }]
    ]);
    assert.ok(segmentsMeet(
        { startX: 253, startY: 324, endX: 253, endY: 184 },
        { startX: 230, startY: 315, endX: 371, endY: 176 }
    ));
    const bounds = { width: 690, height: 602 };
    const obstacles = labels.map(iconRect);
    const placements = place(labels, { ...bounds, obstacles, previous });
    assert.equal(placements.size, 3);
    assertClear(placements, obstacles, bounds);
    assert.notDeepEqual(
        { dx: placements.get('GOLDEN JUBILEE').dx, dy: placements.get('GOLDEN JUBILEE').dy },
        previous.get('GOLDEN JUBILEE')
    );
});

test('a later label avoids covering an accepted leader when alternatives exist', () => {
    const labels = [makeLabel('A', 100, 100, { width: 40 }), makeLabel('B', 200, 200, { width: 40 })];
    const previous = new Map([['A', { dx: 200, dy: -12 }], ['B', { dx: -20, dy: -112 }]]);
    const placements = place(labels, { ...viewport, previous });
    assert.equal(placements.size, 2);
    assertClear(placements);
});

test('a new leader avoids passing through an accepted label when alternatives exist', () => {
    const labels = [makeLabel('A', 300, 100, { width: 40 }), makeLabel('B', 100, 200, { width: 40 })];
    const previous = new Map([['A', { dx: -120, dy: 88 }], ['B', { dx: 200, dy: -12 }]]);
    const placements = place(labels, { ...viewport, previous });
    assert.equal(placements.size, 2);
    assertClear(placements);
});

test('crossing leaders are allowed as a last resort but avoided when alternatives exist', () => {
    const labels = [makeLabel('A', 100, 100, { width: 40 }), makeLabel('B', 180, 50, { width: 24 })];
    const previous = new Map([['A', { dx: 140, dy: -12 }], ['B', { dx: -12, dy: 100 }]]);
    const obstacles = labels.map(iconRect);
    const forced = place(labels, { ...viewport, previous, obstacles, distances: [] });
    assert.equal(forced.size, 2);
    assert.ok(segmentsMeet(forced.get('A').leader, forced.get('B').leader));
    const alternatives = place(labels, { ...viewport, previous, obstacles });
    assert.equal(alternatives.size, 2);
    assertClear(alternatives, obstacles);
});

test('diagonal leaders with overlapping bounding boxes can still fit side by side', () => {
    const labels = [makeLabel('A', 100, 100, { width: 40 }), makeLabel('B', 100, 150, { width: 40 })];
    const previous = new Map(labels.map(label => [label.id, { dx: 100, dy: 100 }]));
    const placements = place(labels, { ...viewport, previous, distances: [] });
    assert.equal(placements.size, 2);
    assertClear(placements);
});

test('collinear overlapping leaders and strokes only one pixel apart prefer clear alternatives', () => {
    for (const separation of [0, 1]) {
        const labels = [makeLabel('A', 100, 100, { width: 40 }),
            makeLabel('B', 170, 100 + separation, { width: 40 })];
        const previous = new Map([['A', { dx: 100, dy: -12 }], ['B', { dx: -140, dy: -12 }]]);
        const obstacles = labels.map(iconRect);
        const placements = place(labels, { ...viewport, previous, obstacles });
        assert.equal(placements.size, 2);
        assertClear(placements, obstacles);
    }
});

test('separate collinear leaders remain visible', () => {
    const labels = [makeLabel('A', 100, 100, { width: 40 }), makeLabel('B', 400, 100, { width: 40 })];
    const previous = new Map(labels.map(label => [label.id, { dx: 100, dy: -12 }]));
    const placements = place(labels, { ...viewport, previous, distances: [] });
    assert.equal(placements.size, 2);
    assertClear(placements);
});

test('moving markers revalidate old leaders even when both label boxes still fit', () => {
    const labels = [makeLabel('A', 250, 300, { width: 80 }), makeLabel('B', 400, 300, { width: 80 })];
    const previous = new Map([['A', { dx: -40, dy: -120 }], ['B', { dx: -40, dy: -120 }]]);
    const first = place(labels, { ...viewport, previous, obstacles: labels.map(iconRect) });
    const moved = [labels[0], { ...labels[1], x: 210, y: 240 }];
    const next = place(moved, { ...viewport, previous: first, obstacles: moved.map(iconRect) });
    assert.equal(next.size, 2);
    assertClear(next, moved.map(iconRect));
});

test('randomized mixed sizes, priorities and screen dimensions never drop an onscreen label', () => {
    let seed = 12345;
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let scene = 0; scene < 30; scene++) {
        const bounds = { width: 320 + Math.floor(random() * 1200), height: 240 + Math.floor(random() * 700) };
        const labels = Array.from({ length: 150 }, (_, id) => makeLabel(id,
            Math.round(random() * bounds.width), Math.round(random() * bounds.height), {
                width: 40 + Math.floor(random() * 400), height: 18 + Math.floor(random() * 20),
                priority: Math.floor(random() * 100), type: id % 2 ? 'aircraft' : 'vessel'
            }));
        const obstacles = labels.map(iconRect);
        const placements = place(labels, { ...bounds, obstacles });
        assert.equal(placements.size, labels.length);
        assertOnscreen(placements, bounds);
    }
});
