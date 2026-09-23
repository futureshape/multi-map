const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small Leaflet/DOM adapter exercises application lifecycle and its conversion
// to Leaflet's centered-tooltip geometry. This is not a browser rendering test.
function createApp() {
    const classList = () => {
        const values = new Set();
        return {
            add: name => values.add(name), remove: name => values.delete(name),
            contains: name => values.has(name),
            toggle: (name, enabled) => enabled ? values.add(name) : values.delete(name)
        };
    };
    const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
    const point = (x, y) => Array.isArray(x) ? { x: x[0], y: x[1] } : typeof x === 'object' ? x : { x, y };
    const latLng = value => Array.isArray(value) ? { lat: value[0], lng: value[1] } : value;
    const frameCallbacks = new Map();
    const events = new Map();
    const layers = new Set();
    let nextFrame = 0;
    const container = { classList: classList(), getBoundingClientRect: () => rect(55, 37, map.width, map.height) };
    const map = {
        width: 1000, height: 700, panX: 0, panY: 0,
        getContainer: () => container,
        getSize: () => point(map.width, map.height),
        getCenter: () => latLng([350, 500]), getZoom: () => 8,
        whenReady: () => {},
        on(names, callback) {
            for (const name of names.split(' ')) {
                if (!events.has(name)) events.set(name, []);
                events.get(name).push(callback);
            }
        },
        fire(name) { for (const callback of events.get(name) || []) callback(); },
        latLngToContainerPoint: value => point(value.lng - map.panX, value.lat - map.panY),
        // Deliberately different from container coordinates, as after a pan.
        latLngToLayerPoint(value) {
            const p = this.latLngToContainerPoint(value);
            return point(p.x + 800, p.y - 500);
        },
        getBounds: () => ({ getSouth: () => map.panY, getNorth: () => map.panY + map.height,
            getWest: () => map.panX, getEast: () => map.panX + map.width }),
        eachLayer: callback => layers.forEach(callback),
        removeLayer: layer => layers.delete(layer)
    };

    class Tooltip {
        constructor(marker, content, options) {
            this.marker = marker;
            this.content = content;
            this.options = options;
            this.element = {
                classList: classList(), clientLeft: 1, clientTop: 1,
                style: { setProperty() {} },
                getBoundingClientRect: () => {
                    const p = this.mapPosition || point(0, 0);
                    return rect(p.x - 800 + 55, p.y + 500 + 37, this.width, this.height);
                }
            };
            this.update();
        }
        update() {
            // Intentionally fractional metrics and unequal character widths.
            this.width = [...this.content.textContent].reduce((n, char) => n + (char === 'W' ? 11 : char === 'i' ? 2 : 6), 18.3);
            this.height = 23.4;
            this.element.offsetWidth = Math.round(this.width);
            this.element.offsetHeight = Math.round(this.height);
            const p = map.latLngToLayerPoint(this.marker.getLatLng());
            const offset = point(this.options.offset);
            const anchor = point(this.marker.options.icon.options.tooltipAnchor || [0, 0]);
            this.mapPosition = point(p.x - Math.round(this.element.offsetWidth / 2) + offset.x + anchor.x,
                p.y - Math.round(this.element.offsetHeight / 2) + offset.y + anchor.y);
        }
        getContent() { return this.content; }
        getElement() { return this.element; }
        isOpen() { return true; }
        setLatLng() { this.update(); }
    }
    class Marker {
        constructor(position, options) { this.position = latLng(position); this.options = options; }
        addTo() { layers.add(this); return this; }
        getLatLng() { return this.position; }
        setLatLng(value) { this.position = latLng(value); this.tooltip?.update(); }
        setIcon(icon) { this.options.icon = icon; }
        getElement() {
            return { getBoundingClientRect: () => {
                const p = map.latLngToContainerPoint(this.position);
                const [width, height] = this.options.icon.options.iconSize;
                return rect(55 + p.x - width / 2, 37 + p.y - height / 2, width, height);
            } };
        }
        bindPopup() { this.popup = { setContent() {} }; }
        getPopup() { return this.popup; }
        bindTooltip(content, options) { this.tooltip = new Tooltip(this, content, options); }
        unbindTooltip() { this.tooltip = null; }
        getTooltip() { return this.tooltip; }
        openTooltip() {}
        setTooltipContent(content) { this.tooltip.content = content; this.tooltip.update(); }
    }
    const panels = [];
    const context = vm.createContext({
        MAP_CONFIG: { CARTO_API_KEY: 'test-key' },
        console: { log() {}, warn() {}, error() {} },
        localStorage: { getItem: () => null },
        setTimeout() {}, clearTimeout() {}, setInterval() {},
        fetch: () => new Promise(() => {}), io: () => ({ on() {} }),
        requestAnimationFrame: callback => { frameCallbacks.set(++nextFrame, callback); return nextFrame; },
        cancelAnimationFrame: id => frameCallbacks.delete(id),
        document: { readyState: 'loading', addEventListener() {},
            createElement: () => ({ textContent: '' }), querySelectorAll: () => panels },
        L: { map: () => map, tileLayer: () => ({ addTo() {} }), point,
            divIcon: options => ({ options }), marker: (p, o) => new Marker(p, o), Marker,
            latLngBounds: (a, b) => ({ contains: p => p[0] >= a[0] && p[0] <= b[0] && p[1] >= a[1] && p[1] <= b[1] }) }
    });
    for (const file of ['label-layout.js', 'app.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
    }
    context.init();
    return {
        context, map, panels,
        get: expression => vm.runInContext(expression, context),
        aircraft: data => context.updateAircraftMarker({ hex: 'A', lat: 350, lon: 500, flight: 'BAW123', gs: 200, ...data }),
        vessel: data => context.updateVesselMarker({ mmsi: 'V', coordinates: [350, 500], name: 'Vessel', speed: 5, ...data }),
        pendingFrames: () => frameCallbacks.size,
        flush() {
            const callbacks = [...frameCallbacks.values()];
            frameCallbacks.clear();
            callbacks.forEach(callback => callback());
        }
    };
}

test('rendered tooltip boxes agree with planned bounds after a pan and fractional font measurement', () => {
    const app = createApp();
    for (let i = 0; i < 25; i++) app.aircraft({ hex: `A${i}`, lon: 250 + i % 5 * 35, lat: 250 + Math.floor(i / 5) * 25,
        flight: i % 2 ? 'WWWWWW' : 'iiiiiiii' });
    assert.equal(app.pendingFrames(), 1, 'Updates should share one animation frame');
    app.map.panX = 100;
    app.map.panY = 50;
    app.flush();
    const placements = app.get('previousLabelPlacements');
    assert.equal(placements.size, 25);
    for (const [id, placement] of placements) {
        const marker = app.get(`aircraftMarkers.get(${JSON.stringify(id.slice(9))})`);
        const bounds = marker.getTooltip().getElement().getBoundingClientRect();
        assert.equal(bounds.left - 55, placement.rect.left);
        assert.equal(bounds.top - 37, placement.rect.top);
        assert.ok(bounds.right - 55 <= placement.rect.right);
        assert.ok(bounds.bottom - 37 <= placement.rect.bottom);
    }
});

test('offscreen labels retain their tooltip and return after panning without new data', () => {
    const app = createApp();
    app.aircraft();
    app.flush();
    const marker = app.get("aircraftMarkers.get('A')");
    const tooltip = marker.getTooltip();
    app.map.fire('movestart');
    assert.ok(tooltip.getElement().classList.contains('label-placed'));
    assert.ok(!app.map.getContainer().classList.contains('labels-moving'));
    app.map.panX = 1100;
    app.map.fire('moveend');
    assert.equal(marker.getTooltip(), tooltip);
    assert.ok(!tooltip.getElement().classList.contains('label-placed'));
    app.map.fire('movestart');
    app.map.panX = 0;
    app.map.fire('moveend');
    assert.equal(marker.getTooltip(), tooltip);
    assert.ok(tooltip.getElement().classList.contains('label-placed'));
    assert.ok(!app.map.getContainer().classList.contains('labels-moving'));
});

test('callsign changes update measured text without rebinding, and missing callsigns remove it', () => {
    const app = createApp();
    app.aircraft(); app.flush();
    const marker = app.get("aircraftMarkers.get('A')");
    const tooltip = marker.getTooltip();
    app.aircraft({ flight: 'WWWWWWWW & <new>' }); app.flush();
    assert.equal(marker.getTooltip(), tooltip);
    assert.equal(tooltip.getContent().textContent, 'WWWWWWWW & <new>');
    assert.ok(app.get("previousLabelPlacements.get('aircraft-A').rect.right - previousLabelPlacements.get('aircraft-A').rect.left") >= tooltip.width);
    app.aircraft({ flight: '' }); app.flush();
    assert.equal(marker.getTooltip(), null);
    assert.equal(app.get('previousLabelPlacements.size'), 0);
});

test('vessel labels follow movement state and existing vessels update outside the viewport', () => {
    const app = createApp();
    app.vessel(); app.flush();
    const marker = app.get("vesselMarkers.get('V')");
    assert.ok(marker.getTooltip());
    app.vessel({ speed: 0 }); app.flush();
    assert.equal(marker.getTooltip(), null);
    app.vessel({ speed: 5 }); app.flush();
    assert.ok(marker.getTooltip().getElement().classList.contains('label-placed'));
    app.vessel({ coordinates: [350, 2000] }); app.flush();
    assert.equal(marker.getLatLng().lng, 2000);
    assert.ok(!marker.getTooltip().getElement().classList.contains('label-placed'));
    app.vessel({ coordinates: [350, 500] }); app.flush();
    assert.ok(marker.getTooltip().getElement().classList.contains('label-placed'));
});

test('labels remain placed even when an overlay leaves no clear space', () => {
    const app = createApp();
    app.aircraft(); app.flush();
    const tooltip = app.get("aircraftMarkers.get('A').getTooltip()");
    app.panels.push({ getBoundingClientRect: () => ({ left: 55, top: 37, right: 1055, bottom: 737, width: 1000, height: 700 }) });
    app.map.fire('popupopen'); app.flush();
    assert.ok(tooltip.getElement().classList.contains('label-placed'));
    app.panels.pop();
    app.map.fire('popupclose'); app.flush();
    assert.ok(tooltip.getElement().classList.contains('label-placed'));
});
