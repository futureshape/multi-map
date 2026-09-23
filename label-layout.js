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

        collides(rect) {
            return this.visit(rect, this.gap, key =>
                (this.cells.get(key) || []).some(other => overlaps(rect, other, this.gap)));
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

    function place(labels, {
        width, height, obstacles = [], previous = new Map(), gap = 6,
        edgePadding = 8, distances = [12, 24, 40, 64, 96, 128]
    }) {
        const occupied = new SpatialIndex(gap);
        obstacles.forEach(rect => occupied.insert(rect));
        const placements = new Map();
        const ordered = [...labels].sort((a, b) =>
            (b.priority || 0) - (a.priority || 0) ||
            String(a.id).localeCompare(String(b.id)));

        for (const label of ordered) {
            if (label.x < 0 || label.x > width || label.y < 0 || label.y > height ||
                label.width <= 0 || label.height <= 0 ||
                label.width > width - 2 * edgePadding || label.height > height - 2 * edgePadding) continue;

            const fits = rect => rect.left >= edgePadding && rect.top >= edgePadding &&
                rect.right <= width - edgePadding && rect.bottom <= height - edgePadding &&
                !occupied.collides(rect);
            let chosen;
            const old = previous.get(label.id);
            if (old) {
                const rect = rectangle(label, old.dx, old.dy);
                if (fits(rect)) chosen = rect;
            }

            // Offsets refer to the box edges, not an assumed text center.
            // Alternate sides before increasing the leader length.
            const directions = label.type === 'vessel'
                ? [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]]
                : [[1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, -1], [1, 1], [-1, 1]];
            for (const distance of distances) {
                if (chosen) break;
                const offset = (label.radius || 0) + distance;
                for (const [x, y] of directions) {
                    const dx = x > 0 ? offset : x < 0 ? -offset - label.width : -label.width / 2;
                    const dy = y > 0 ? offset : y < 0 ? -offset - label.height : -label.height / 2;
                    const rect = rectangle(label, dx, dy);
                    if (fits(rect)) {
                        chosen = rect;
                        break;
                    }
                }
            }

            // A hidden label is preferable to an unreadable overlap. It is
            // reconsidered on every layout, and its marker remains interactive.
            if (!chosen) continue;
            occupied.insert(chosen);
            placements.set(label.id, {
                rect: chosen,
                dx: chosen.left - label.x,
                dy: chosen.top - label.y,
                leader: leader(label, chosen)
            });
        }
        return placements;
    }

    return { place };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LabelLayout;
