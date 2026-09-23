// Screen-space label placement, independent of Leaflet and the DOM.
const LabelLayout = (() => {
    function overlaps(a, b, gap = 0) {
        return a.left < b.right + gap && a.right + gap > b.left &&
            a.top < b.bottom + gap && a.bottom + gap > b.top;
    }

    // Index whole rectangles, so even very long names are checked correctly.
    class SpatialIndex {
        constructor(gap) {
            this.gap = gap;
            this.cells = new Map();
            this.cellSize = 128;
        }

        visit(rect, padding, callback) {
            const size = this.cellSize;
            for (let x = Math.floor((rect.left - padding) / size); x <= Math.floor((rect.right + padding) / size); x++) {
                for (let y = Math.floor((rect.top - padding) / size); y <= Math.floor((rect.bottom + padding) / size); y++) {
                    if (callback(`${x},${y}`)) return true;
                }
            }
            return false;
        }

        insert(rect) {
            this.visit(rect, 0, key => {
                if (!this.cells.has(key)) this.cells.set(key, []);
                this.cells.get(key).push(rect);
            });
        }

        some(rect, predicate) {
            return this.visit(rect, this.gap, key =>
                (this.cells.get(key) || []).some(predicate));
        }

        collides(rect) {
            return this.some(rect, other => overlaps(rect, other, this.gap));
        }

        sum(rect, measure) {
            const seen = new Set();
            let total = 0;
            this.visit(rect, this.gap, key => {
                for (const item of this.cells.get(key) || []) {
                    if (seen.has(item)) continue;
                    seen.add(item);
                    total += measure(item);
                }
            });
            return total;
        }
    }

    function rectangle(label, dx, dy) {
        const left = Math.round(label.x + dx);
        const top = Math.round(label.y + dy);
        return { left, top, right: left + label.width, bottom: top + label.height };
    }

    function leader(label, rect) {
        // End the line at the nearest point on the label's border.
        const endX = Math.max(rect.left, Math.min(rect.right, label.x));
        const endY = Math.max(rect.top, Math.min(rect.bottom, label.y));
        const dx = endX - label.x;
        const dy = endY - label.y;
        const distance = Math.hypot(dx, dy);
        const inset = Math.min(label.radius || 0, distance);
        return {
            startX: label.x + (distance ? dx / distance * inset : 0),
            startY: label.y + (distance ? dy / distance * inset : 0),
            endX,
            endY
        };
    }

    function lineBounds(line) {
        return {
            left: Math.min(line.startX, line.endX), right: Math.max(line.startX, line.endX),
            top: Math.min(line.startY, line.endY), bottom: Math.max(line.startY, line.endY)
        };
    }

    function lineIntersectsRect(line, rect, padding) {
        // Clip the segment's parameter interval against each rectangle axis.
        // Inclusive bounds also catch a line touching a label corner or edge.
        let first = 0;
        let last = 1;
        for (const [start, delta, min, max] of [
            [line.startX, line.endX - line.startX, rect.left - padding, rect.right + padding],
            [line.startY, line.endY - line.startY, rect.top - padding, rect.bottom + padding]
        ]) {
            if (delta === 0) {
                if (start < min || start > max) return false;
            } else {
                const a = (min - start) / delta;
                const b = (max - start) / delta;
                first = Math.max(first, Math.min(a, b));
                last = Math.min(last, Math.max(a, b));
                if (first > last) return false;
            }
        }
        return true;
    }

    function pointToLineDistanceSquared(x, y, line) {
        const dx = line.endX - line.startX;
        const dy = line.endY - line.startY;
        const lengthSquared = dx * dx + dy * dy;
        const t = lengthSquared ? Math.max(0, Math.min(1,
            ((x - line.startX) * dx + (y - line.startY) * dy) / lengthSquared)) : 0;
        return (x - line.startX - t * dx) ** 2 + (y - line.startY - t * dy) ** 2;
    }

    function linesConflict(a, b, gap) {
        const cross = (line, x, y) => (line.endX - line.startX) * (y - line.startY) -
            (line.endY - line.startY) * (x - line.startX);
        if (cross(a, b.startX, b.startY) * cross(a, b.endX, b.endY) <= 0 &&
            cross(b, a.startX, a.startY) * cross(b, a.endX, a.endY) <= 0 &&
            lineIntersectsRect(a, lineBounds(b), 0)) return true;

        // Include stroke clearance and collinear overlap, not just X crossings.
        const distanceSquared = Math.min(
            pointToLineDistanceSquared(a.startX, a.startY, b),
            pointToLineDistanceSquared(a.endX, a.endY, b),
            pointToLineDistanceSquared(b.startX, b.startY, a),
            pointToLineDistanceSquared(b.endX, b.endY, a)
        );
        return distanceSquared < gap * gap;
    }

    function place(labels, {
        width, height, obstacles = [], previous = new Map(), gap = 6,
        edgePadding = 8, distances = [12, 24, 40, 64, 96, 128], lineGap = 2
    }) {
        const occupied = new SpatialIndex(gap);
        const labelBoxes = new SpatialIndex(lineGap);
        const leaders = new SpatialIndex(lineGap);
        obstacles.forEach(rect => occupied.insert(rect));
        const placements = new Map();
        const ordered = [...labels].sort((a, b) =>
            (b.priority || 0) - (a.priority || 0) ||
            String(a.id).localeCompare(String(b.id)));

        for (const label of ordered) {
            if (label.x < 0 || label.x > width || label.y < 0 || label.y > height ||
                label.width <= 0 || label.height <= 0) continue;

            const fits = rect => {
                if (rect.left < edgePadding || rect.top < edgePadding ||
                    rect.right > width - edgePadding || rect.bottom > height - edgePadding ||
                    occupied.collides(rect)) return false;

                const line = leader(label, rect);
                const bounds = lineBounds(line);
                // Check both insertion orders: a new line must avoid existing
                // labels, and a new label must avoid already accepted lines.
                return !labelBoxes.some(bounds, box => lineIntersectsRect(line, box, lineGap)) &&
                    !leaders.some(rect, other => lineIntersectsRect(other.line, rect, lineGap)) &&
                    !leaders.some(bounds, other => linesConflict(line, other.line, lineGap));
            };
            let chosen;
            const candidates = [];
            const old = previous.get(label.id);
            if (old) {
                const rect = rectangle(label, old.dx, old.dy);
                candidates.push(rect);
                if (fits(rect)) chosen = rect;
            }

            // Offsets refer to the box edges, not an assumed text center.
            // Alternate sides before increasing the leader length.
            const directions = label.type === 'vessel'
                ? [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]]
                : [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
            // Extra angles give leaders routes between neighbours before we
            // resort to a longer line or accept a clash in a crowded cluster.
            directions.push([0.5, -1], [-0.5, -1], [0.5, 1], [-0.5, 1],
                [1, -0.5], [-1, -0.5], [1, 0.5], [-1, 0.5]);
            for (const distance of distances) {
                if (chosen) break;
                const offset = (label.radius || 0) + distance;
                for (const [x, y] of directions) {
                    const dx = x > 0 ? offset * x : x < 0 ? offset * x - label.width : -label.width / 2;
                    const dy = y > 0 ? offset * y : y < 0 ? offset * y - label.height : -label.height / 2;
                    const rect = rectangle(label, dx, dy);
                    candidates.push(rect);
                    if (fits(rect)) {
                        chosen = rect;
                        break;
                    }
                }
            }

            // Visibility is mandatory. If every candidate clashes, minimize
            // overlapping box area, then lines through labels, then crossings.
            // Prefer shorter leaders when the conflict scores are equal.
            if (!chosen) {
                if (!candidates.length) candidates.push(rectangle(label, (label.radius || 0) + 12, -label.height / 2));
                let bestScore;
                const seen = new Set();
                for (const candidate of candidates) {
                    // Keep fallback labels on screen. An oversized label starts
                    // at the edge so as much of its text as possible is visible.
                    const insetX = label.width <= width - 2 * edgePadding ? edgePadding : 0;
                    const insetY = label.height <= height - 2 * edgePadding ? edgePadding : 0;
                    const left = Math.max(insetX, Math.min(candidate.left, width - label.width - insetX));
                    const top = Math.max(insetY, Math.min(candidate.top, height - label.height - insetY));
                    const key = `${left},${top}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    const rect = { left, top, right: left + label.width, bottom: top + label.height };
                    const line = leader(label, rect);
                    const bounds = lineBounds(line);
                    const score = [
                        occupied.sum(rect, box =>
                            Math.max(0, Math.min(rect.right, box.right + gap) - Math.max(rect.left, box.left - gap)) *
                            Math.max(0, Math.min(rect.bottom, box.bottom + gap) - Math.max(rect.top, box.top - gap))),
                        labelBoxes.sum(bounds, box => Number(lineIntersectsRect(line, box, lineGap))) +
                            leaders.sum(rect, other => Number(lineIntersectsRect(other.line, rect, lineGap))),
                        leaders.sum(bounds, other => Number(linesConflict(line, other.line, lineGap))),
                        Math.hypot(line.endX - label.x, line.endY - label.y)
                    ];
                    const difference = bestScore ? score.findIndex((value, i) => value !== bestScore[i]) : -1;
                    if (!bestScore || (difference >= 0 && score[difference] < bestScore[difference])) {
                        chosen = rect;
                        bestScore = score;
                    }
                }
            }
            const line = leader(label, chosen);
            occupied.insert(chosen);
            labelBoxes.insert(chosen);
            leaders.insert({ ...lineBounds(line), line });
            placements.set(label.id, {
                rect: chosen,
                dx: chosen.left - label.x,
                dy: chosen.top - label.y,
                leader: line
            });
        }
        return placements;
    }

    return { place };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LabelLayout;
