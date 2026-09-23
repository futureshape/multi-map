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

function assertClear(placements, obstacles = [], bounds = viewport) {
    const rectangles = [...placements.values()].map(p => p.rect);
    rectangles.forEach((rect, i) => {
        assert.ok(rect.left >= 8 && rect.top >= 8);
        assert.ok(rect.right <= bounds.width - 8 && rect.bottom <= bounds.height - 8);
        rectangles.slice(i + 1).forEach(other => assertSeparated(rect, other));
        obstacles.forEach(other => assertSeparated(rect, other));
    });
}

test('dense mixed traffic is decluttered without hiding every label', () => {
    const labels = Array.from({ length: 100 }, (_, i) => makeLabel(`traffic-${i}`,
        460 + i % 5 * 12, 340 + Math.floor(i / 5) * 3,
        { type: i % 2 ? 'vessel' : 'aircraft', width: 75 + i % 7 * 15 }));
    const obstacles = labels.map(iconRect);
    const placements = place(labels, { ...viewport, obstacles });
    assert.ok(placements.size >= 10, `Only ${placements.size} labels fit`);
    assert.ok(placements.size < labels.length);
    assertClear(placements, obstacles);
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
    assert.deepEqual([...placements.keys()], ['high']);
});

test('blocked, oversized and offscreen labels are hidden; they return when space opens', () => {
    const label = makeLabel('returning', 300, 300);
    const blocked = place([label], { ...viewport, obstacles: [{ left: 0, top: 0, right: 1024, bottom: 768 }] });
    assert.equal(blocked.size, 0);
    assert.equal(place([{ ...label, width: 2000 }], viewport).size, 0);
    assert.equal(place([{ ...label, x: -20 }], viewport).size, 0);
    assert.equal(place([label], { ...viewport, previous: blocked }).size, 1);
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

test('randomized mixed sizes, priorities and screen dimensions preserve all clearances', () => {
    let seed = 12345;
    let visible = 0;
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
        visible += placements.size;
        assertClear(placements, obstacles, bounds);
    }
    assert.ok(visible > 100);
});
