// Configuration
const CONFIG = {
    ADSB_API_URL: '/api/aircraft', // Using local proxy to avoid CORS issues
    AIS_SOCKET_URL: 'http://192.168.1.16', // Socket.IO server URL (without /socket/)
    AIS_SOCKET_PATH: '/socket/', // Socket.IO path
    REFRESH_INTERVAL: 1000, // 1 second
    DEFAULT_CENTER: [51.505, -0.09], // Default to London area
    DEFAULT_ZOOM: 8,
    MAX_AIRCRAFT_AGE: 60, // Remove aircraft not seen for 60 seconds
    // Performance settings for low-powered devices
    VESSEL_UPDATE_THROTTLE: 500, // Throttle vessel updates to every 500ms
    BATCH_SIZE: 10, // Process vessels in batches
    LOW_POWER_MODE: true, // Enable additional optimizations for Raspberry Pi
    VIEWPORT_ONLY_UPDATES: true, // Only update markers visible in viewport
    AIRCRAFT_REFRESH_INTERVAL: 2000, // Slower aircraft updates for low-power devices (2 seconds)

    LABEL_GAP: 6, // Pixels between label boxes and other map objects
    LABEL_EDGE_PADDING: 8 // Keep labels inside the viewport
};

// Restore saved viewport or use defaults
function getSavedViewport() {
    const saved = localStorage.getItem('mapViewport');
    console.log('Saved viewport from localStorage:', saved);
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            console.log('Using saved viewport:', parsed);
            return parsed;
        } catch (e) {
            console.error('Error parsing saved viewport:', e);
        }
    }
    console.log('Using default viewport');
    return {
        center: CONFIG.DEFAULT_CENTER,
        zoom: CONFIG.DEFAULT_ZOOM
    };
}

// Initialize the map with saved or default viewport
const savedViewport = getSavedViewport();
console.log('Initializing map with:', savedViewport);
const map = L.map('map', {
    center: savedViewport.center,
    zoom: savedViewport.zoom,
    zoomControl: true
});

// Add dark mode OSM tile layer
L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${MAP_CONFIG.CARTO_API_KEY}`, {
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);

// Save viewport (center and zoom) to localStorage
function saveViewport() {
    const center = map.getCenter();
    const zoom = map.getZoom();
    const viewport = {
        center: [center.lat, center.lng],
        zoom: zoom
    };
    console.log('Saving viewport:', viewport);
    localStorage.setItem('mapViewport', JSON.stringify(viewport));
    console.log('Viewport saved to localStorage');
}

// Save viewport when map is moved or zoomed (with throttling)
let saveViewportTimeout = null;
let mapInitialized = false;

// Wait for map to be fully initialized before saving viewport changes
map.whenReady(() => {
    console.log('Map is ready');
    // Give it a moment to settle
    setTimeout(() => {
        mapInitialized = true;
        console.log('Map initialized - viewport saving enabled');
    }, 1000);
});

map.on('moveend', () => {
    if (!mapInitialized) {
        console.log('Map moveend event (ignored - map not ready)');
        return;
    }
    console.log('Map moveend event');
    clearTimeout(saveViewportTimeout);
    saveViewportTimeout = setTimeout(saveViewport, 500);
});

map.on('zoomend', () => {
    if (!mapInitialized) {
        console.log('Map zoomend event (ignored - map not ready)');
        return;
    }
    console.log('Map zoomend event');
    clearTimeout(saveViewportTimeout);
    saveViewportTimeout = setTimeout(saveViewport, 500);
});

// Store aircraft markers
const aircraftMarkers = new Map();
const vesselMarkers = new Map();
let firstDataLoad = true;

// Socket.IO for AIS data
let aisSocket = null;

// Performance optimization variables
let vesselUpdateQueue = [];
let isProcessingVessels = false;
let labelLayoutFrame = null;
let previousLabelPlacements = new Map();
let mapIsMoving = false;

// Keep one tooltip per eligible marker, even in crowded areas.
// Text content avoids interpreting callsigns and vessel names as HTML.
function updateMarkerLabel(marker, text, type) {
    if (!text) {
        marker.unbindTooltip();
        return;
    }
    const tooltip = marker.getTooltip();
    if (tooltip) {
        if (tooltip.getContent().textContent !== text) {
            const content = document.createElement('span');
            content.textContent = text;
            marker.setTooltipContent(content);
        }
    } else {
        const content = document.createElement('span');
        content.textContent = text;
        marker.bindTooltip(content, {
            permanent: true,
            direction: 'center',
            className: `${type}-label-tooltip managed-label`,
            offset: [0, 0]
        });
    }
}

// Coalesce live updates into one layout before the next paint. No continuous
// physics animation or repeated tooltip rebinding is needed.
function scheduleLabelLayout() {
    if (labelLayoutFrame !== null) return;
    labelLayoutFrame = requestAnimationFrame(() => {
        labelLayoutFrame = null;
        recalculateLabels();
    });
}

function setLabelLeader(element, placement) {
    const { rect, leader } = placement;
    const dx = leader.startX - leader.endX;
    const dy = leader.startY - leader.endY;
    element.style.setProperty('--leader-x', `${leader.endX - rect.left - element.clientLeft}px`);
    element.style.setProperty('--leader-y', `${leader.endY - rect.top - element.clientTop}px`);
    element.style.setProperty('--leader-length', `${Math.hypot(dx, dy)}px`);
    element.style.setProperty('--leader-angle', `${Math.atan2(dy, dx)}rad`);
}

function recalculateLabels() {
    if (labelLayoutFrame !== null) {
        cancelAnimationFrame(labelLayoutFrame);
        labelLayoutFrame = null;
    }
    if (mapIsMoving) return;

    const size = map.getSize();
    const containerRect = map.getContainer().getBoundingClientRect();
    const labels = [];
    const obstacles = [];
    const tooltipElements = [];
    const toMapRect = rect => ({
        left: rect.left - containerRect.left,
        right: rect.right - containerRect.left,
        top: rect.top - containerRect.top,
        bottom: rect.bottom - containerRect.top
    });

    function collect(marker, id, type) {
        // Use container coordinates for BOTH labels and viewport limits. Layer
        // coordinates acquire an offset when the map is panned.
        const point = map.latLngToContainerPoint(marker.getLatLng());
        const icon = marker.getElement();
        if (icon) {
            const rect = toMapRect(icon.getBoundingClientRect());
            if (rect.right >= 0 && rect.left <= size.x && rect.bottom >= 0 && rect.top <= size.y) {
                // Include stationary/unlabelled icons and the label's own icon.
                obstacles.push(rect);
            }
        }

        const tooltip = marker.getTooltip();
        if (!tooltip) return;
        if (!tooltip.isOpen()) marker.openTooltip();
        const element = tooltip.getElement();
        if (!element) return;
        tooltipElements.push({ element, id });
        if (point.x < 0 || point.x > size.x || point.y < 0 || point.y > size.y) return;

        // Measure the rendered font, padding and border; text length is not a
        // reliable width estimate, and screen-space text does not scale at zoom.
        const bounds = element.getBoundingClientRect();
        const iconSize = marker.options.icon.options.iconSize;
        const isAircraftDot = marker.options.icon.options.className?.includes('aircraft-dot-wrapper');
        labels.push({
            id, type, marker, tooltip, element,
            x: point.x, y: point.y,
            width: Math.ceil(bounds.width), height: Math.ceil(bounds.height),
            radius: isAircraftDot ? 6 : Math.max(iconSize[0], iconSize[1]) / 2,
            priority: (type === 'aircraft' ? 1000 : 0) + (marker.speed || 0),
            // Leaflet rounds half of offsetWidth/Height when centering tooltips.
            halfWidth: Math.round(element.offsetWidth / 2),
            halfHeight: Math.round(element.offsetHeight / 2)
        });
    }

    aircraftMarkers.forEach((marker, id) => collect(marker, `aircraft-${id}`, 'aircraft'));
    vesselMarkers.forEach((marker, id) => collect(marker, `vessel-${id}`, 'vessel'));
    document.querySelectorAll('#info-panel, .leaflet-control, .leaflet-popup').forEach(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width && rect.height) obstacles.push(toMapRect(rect));
    });

    const placements = LabelLayout.place(labels, {
        width: size.x, height: size.y, obstacles,
        previous: previousLabelPlacements,
        gap: CONFIG.LABEL_GAP, edgePadding: CONFIG.LABEL_EDGE_PADDING
    });

    // Apply only after all DOM measurements are complete.
    for (const label of labels) {
        const placement = placements.get(label.id);
        if (!placement) continue;
        const anchor = L.point(label.marker.options.icon.options.tooltipAnchor || [0, 0]);
        label.tooltip.options.offset = L.point(
            placement.dx + label.halfWidth - anchor.x,
            placement.dy + label.halfHeight - anchor.y
        );
        // Reposition without rebuilding the tooltip's content on every frame.
        label.tooltip.setLatLng(label.marker.getLatLng());
        setLabelLeader(label.element, placement);
    }
    for (const { element, id } of tooltipElements) {
        element.classList.toggle('label-placed', placements.has(id));
    }
    previousLabelPlacements = placements;
}

// Create custom aircraft icon using Font Awesome
function createAircraftIcon(heading) {
    if (heading === undefined || heading === null || !Number.isFinite(Number(heading))) {
        return L.divIcon({
            html: '<div class="aircraft-marker aircraft-dot"></div>',
            className: 'aircraft-icon-wrapper aircraft-dot-wrapper',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
            popupAnchor: [0, -8]
        });
    }

    // Font Awesome plane points right (90°), so subtract 90 to make 0° point north
    const adjustedHeading = heading - 90;

    const iconHtml = `
        <div class="aircraft-marker" style="transform: rotate(${adjustedHeading}deg);">
            <i class="fas fa-plane"></i>
        </div>
    `;

    return L.divIcon({
        html: iconHtml,
        className: 'aircraft-icon-wrapper',
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -16]
    });
}

// Create custom vessel icon using SVG (boat shape from above)
function createVesselIcon(heading = 0, speed = 0, status = '') {
    // Check if vessel is moored or moving very slowly
    const isMoored = status && status.toLowerCase().includes('moored');
    const isStationary = speed < 0.5;
    const showDot = isMoored || isStationary;

    let svgIcon;
    if (showDot) {
        // Show as a simple blue dot
        svgIcon = `
            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
                <circle cx="8" cy="8" r="5"
                        fill="#64B5F6"
                        stroke="#ffffff"
                        stroke-width="1.5"/>
            </svg>
        `;
    } else {
        // Show as boat shape with rotation
        const adjustedHeading = heading;
        svgIcon = `
            <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <g transform="translate(12,12) rotate(${adjustedHeading}) translate(-12,-12)">
                    <!-- Boat hull from above view -->
                    <path d="M 12 4 L 16 8 L 16 20 L 8 20 L 8 8 Z"
                          fill="#64B5F6"
                          stroke="#ffffff"
                          stroke-width="1.5"/>
                </g>
            </svg>
        `;
    }

    const iconHtml = `
        <div class="vessel-marker ${showDot ? 'vessel-dot' : ''}">
            ${svgIcon}
        </div>
    `;

    const iconSize = showDot ? [16, 16] : [24, 24];
    const iconAnchor = showDot ? [8, 8] : [12, 12];

    return L.divIcon({
        html: iconHtml,
        className: `vessel-icon-wrapper ${showDot ? 'vessel-dot' : ''}`,
        iconSize: iconSize,
        iconAnchor: iconAnchor,
        popupAnchor: [0, showDot ? -8 : -12]
    });
}

// Format altitude with units
function formatAltitude(alt) {
    if (alt === undefined || alt === null) return 'N/A';
    return `${alt.toLocaleString()} ft`;
}

// Format speed
function formatSpeed(speed) {
    if (speed === undefined || speed === null) return 'N/A';
    return `${Math.round(speed)} kts`;
}

// Create popup content for aircraft
function createPopupContent(aircraft) {
    const flight = aircraft.flight ? aircraft.flight.trim() : 'Unknown';
    const altitude = formatAltitude(aircraft.alt_baro || aircraft.alt_geom);
    const speed = formatSpeed(aircraft.gs);
    const heading = aircraft.true_heading !== undefined ? `${Math.round(aircraft.true_heading)}°` : 'N/A';
    const squawk = aircraft.squawk || 'N/A';
    const category = aircraft.category || 'N/A';

    return `
        <div class="popup-content">
            <strong>Flight:</strong> ${flight}<br>
            <strong>Hex:</strong> ${aircraft.hex}<br>
            <strong>Altitude:</strong> ${altitude}<br>
            <strong>Speed:</strong> ${speed}<br>
            <strong>Heading:</strong> ${heading}<br>
            <strong>Squawk:</strong> ${squawk}<br>
            <strong>Category:</strong> ${category}
        </div>
    `;
}

// Create popup content for vessels
function createVesselPopupContent(vessel) {
    const name = vessel.name || 'Unknown';
    const mmsi = vessel.mmsi || 'N/A';
    const speed = (vessel.speed !== undefined && vessel.speed !== null) ? `${vessel.speed.toFixed(1)} kts` : 'N/A';
    const course = (vessel.course !== undefined && vessel.course !== null) ? `${vessel.course.toFixed(1)}°` : 'N/A';
    const status = vessel.navigationalStatus || 'N/A';
    const type = vessel.legend || 'Unspecified';

    return `
        <div class="popup-content">
            <strong>Vessel:</strong> ${name}<br>
            <strong>MMSI:</strong> ${mmsi}<br>
            <strong>Type:</strong> ${type}<br>
            <strong>Status:</strong> ${status}<br>
            <strong>Speed:</strong> ${speed}<br>
            <strong>Course:</strong> ${course}
        </div>
    `;
}

// Update or create aircraft marker
function updateAircraftMarker(aircraft) {
    // Check if aircraft has position
    if (aircraft.lat === undefined || aircraft.lon === undefined) {
        return;
    }

    const position = [aircraft.lat, aircraft.lon];
    // Prefer true heading, then magnetic heading, then calculated track.
    const heading = [aircraft.true_heading, aircraft.mag_heading, aircraft.calc_track]
        .find(value => value !== undefined && value !== null && Number.isFinite(Number(value)));

    const labelText = aircraft.flight ? aircraft.flight.trim() : '';

    if (aircraftMarkers.has(aircraft.hex)) {
        // Update existing marker
        const marker = aircraftMarkers.get(aircraft.hex);
        marker.setLatLng(position);
        marker.setIcon(createAircraftIcon(heading));
        marker.getPopup().setContent(createPopupContent(aircraft));
        marker.lastSeen = Date.now();

        marker.speed = aircraft.gs || 0;
        updateMarkerLabel(marker, labelText, 'aircraft');

        // Label will be repositioned in recalculateLabels()
    } else {
        // Create new marker
        const marker = L.marker(position, {
            icon: createAircraftIcon(heading)
        }).addTo(map);

        marker.bindPopup(createPopupContent(aircraft));
        marker.lastSeen = Date.now();
        marker.hex = aircraft.hex;

        marker.speed = aircraft.gs || 0;
        updateMarkerLabel(marker, labelText, 'aircraft');

        aircraftMarkers.set(aircraft.hex, marker);
    }
    scheduleLabelLayout();
}

// Remove stale aircraft markers
function removeStaleAircraft() {
    const now = Date.now();
    const staleThreshold = CONFIG.MAX_AIRCRAFT_AGE * 1000;

    aircraftMarkers.forEach((marker, hex) => {
        if (now - marker.lastSeen > staleThreshold) {
            map.removeLayer(marker);
            aircraftMarkers.delete(hex);
        }
    });
}

// Batch process vessel updates for better performance
function processBatchedVessels() {
    if (isProcessingVessels || vesselUpdateQueue.length === 0) {
        return;
    }

    isProcessingVessels = true;
    const batch = vesselUpdateQueue.splice(0, CONFIG.BATCH_SIZE);

    // Process batch
    batch.forEach(vessel => {
        updateVesselMarker(vessel);
    });

    // Schedule next batch if more vessels remain
    if (vesselUpdateQueue.length > 0) {
        setTimeout(() => {
            isProcessingVessels = false;
            processBatchedVessels();
        }, 16); // ~60fps
    } else {
        isProcessingVessels = false;
        // Coalesce this batch's updates before the next paint.
        scheduleLabelLayout();
    }
}

// Queue vessel for batch processing
function queueVesselUpdate(vessel) {
    vesselUpdateQueue.push(vessel);

    // Start processing if not already running
    if (!isProcessingVessels) {
        setTimeout(processBatchedVessels, 0);
    }
}

// Update or create vessel marker
function updateVesselMarker(vessel) {
    // Check if vessel has position (coordinates array: [lat, lon])
    if (!vessel.coordinates || !Array.isArray(vessel.coordinates) || vessel.coordinates.length < 2) {
        console.warn('⚠️ Vessel missing coordinates:', vessel);
        return;
    }

    const position = [vessel.coordinates[0], vessel.coordinates[1]];

    // Performance optimization: Skip updates for vessels outside current view (if enabled)
    if (CONFIG.VIEWPORT_ONLY_UPDATES) {
        const bounds = map.getBounds();
        const padding = 0.1; // degrees
        const extendedBounds = L.latLngBounds(
            [bounds.getSouth() - padding, bounds.getWest() - padding],
            [bounds.getNorth() + padding, bounds.getEast() + padding]
        );

        if (!extendedBounds.contains(position) && !vesselMarkers.has(vessel.mmsi)) {
            // Keep existing markers current when they leave the viewport, so
            // their labels disappear and can return correctly after panning.
            return;
        }
    }

    const heading = vessel.course !== undefined && vessel.course !== null ? vessel.course : 0;
    const speed = vessel.speed !== undefined ? vessel.speed : 0;
    const status = vessel.navigationalStatus || '';
    const mmsi = vessel.mmsi;
    const labelText = vessel.name ? vessel.name.trim() : `MMSI: ${mmsi}`;

    if (!mmsi) {
        console.warn('⚠️ Vessel missing MMSI:', vessel);
        return; // Skip if no MMSI
    }

    // Check if there are any markers on the map at this position that shouldn't be there
    const existingLayers = [];
    map.eachLayer((layer) => {
        if (layer instanceof L.Marker && layer.mmsi === mmsi && layer !== vesselMarkers.get(mmsi)) {
            existingLayers.push(layer);
        }
    });

    // Remove any duplicate markers
    if (existingLayers.length > 0) {
        console.warn(`⚠️ Found ${existingLayers.length} duplicate markers for MMSI ${mmsi}, removing...`);
        existingLayers.forEach(layer => map.removeLayer(layer));
    }

    if (vesselMarkers.has(mmsi)) {
        // Update existing marker
        const marker = vesselMarkers.get(mmsi);
        marker.setLatLng(position);
        marker.getPopup().setContent(createVesselPopupContent(vessel));
        marker.lastSeen = Date.now();

        // Check if movement state has changed
        const isMoored = status && status.toLowerCase().includes('moored');
        const isStationary = speed < 0.5;
        const wasStationary = marker.speed !== undefined && marker.speed < 0.5;
        const movementStateChanged = (isStationary !== wasStationary);

        // Update speed and status
        marker.speed = speed;
        marker.status = status;

        // Only recreate icon if movement state changed or heading changed significantly
        const headingChanged = marker.heading === undefined || Math.abs(marker.heading - heading) > 5;
        if (movementStateChanged || headingChanged) {
            marker.setIcon(createVesselIcon(heading, speed, status));
            marker.heading = heading;
        }

        // Check if we should show/hide the label based on movement
        const shouldShowLabel = labelText && !isMoored && !isStationary;

        updateMarkerLabel(marker, shouldShowLabel ? labelText : '', 'vessel');

        // Label will be repositioned in recalculateLabels()
    } else {
        // Create new marker
        const marker = L.marker(position, {
            icon: createVesselIcon(heading, speed, status)
        }).addTo(map);

        marker.bindPopup(createVesselPopupContent(vessel));
        marker.lastSeen = Date.now();
        marker.mmsi = mmsi;
        marker.speed = speed; // Store speed for label visibility check
        marker.status = status; // Store status for label visibility check
        marker.heading = heading; // Store heading for comparison

        // Initial label (will be repositioned in recalculateLabels())
        // Only show labels for moving vessels
        const isMoored = status && status.toLowerCase().includes('moored');
        const isStationary = speed < 0.5;
        const shouldShowLabel = labelText && !isMoored && !isStationary;

        updateMarkerLabel(marker, shouldShowLabel ? labelText : '', 'vessel');

        vesselMarkers.set(mmsi, marker);
    }
    scheduleLabelLayout();
}

// Remove stale vessel markers
function removeStaleVessels() {
    const now = Date.now();
    const staleThreshold = CONFIG.MAX_AIRCRAFT_AGE * 1000;

    vesselMarkers.forEach((marker, mmsi) => {
        if (now - marker.lastSeen > staleThreshold) {
            map.removeLayer(marker);
            vesselMarkers.delete(mmsi);
        }
    });
}

// Fetch and update aircraft data
async function fetchAircraftData() {
    try {
        const response = await fetch(CONFIG.ADSB_API_URL);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (data.aircraft && Array.isArray(data.aircraft)) {
            // Update all aircraft
            data.aircraft.forEach(aircraft => {
                updateAircraftMarker(aircraft);
            });

            // Remove stale aircraft
            removeStaleAircraft();

            // Update panel bounds before placing labels around it.
            updateInfoPanel(data.aircraft.length);
            scheduleLabelLayout();

            // Auto-center map on first data load (only if no saved viewport exists)
            if (firstDataLoad && aircraftMarkers.size > 0) {
                const hasSavedViewport = localStorage.getItem('mapViewport') !== null;
                if (!hasSavedViewport) {
                    const bounds = L.latLngBounds(
                        Array.from(aircraftMarkers.values()).map(m => m.getLatLng())
                    );
                    map.fitBounds(bounds, { padding: [50, 50] });
                }
                firstDataLoad = false;
            }
        }
    } catch (error) {
        console.error('Error fetching aircraft data:', error);
        document.getElementById('aircraft-count').textContent = `Error: ${error.message}`;
        document.getElementById('aircraft-count').style.color = '#f44336';
        scheduleLabelLayout();
    }
}

// Update info panel
function updateInfoPanel(count) {
    const now = new Date();
    const timeString = now.toLocaleTimeString();

    document.getElementById('aircraft-count').textContent = `Aircraft: ${aircraftMarkers.size} | Vessels: ${vesselMarkers.size}`;
    document.getElementById('aircraft-count').style.color = '#4CAF50';
    document.getElementById('last-update').textContent = `Last update: ${timeString}`;
    scheduleLabelLayout();
}

// Connect to AIS Socket.IO server
function connectAISSocket() {
    try {
        aisSocket = io(CONFIG.AIS_SOCKET_URL, {
            path: CONFIG.AIS_SOCKET_PATH,
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionAttempts: 5
        });

        // Listen for vessel position updates
        let lastVesselUpdate = 0;
        aisSocket.on('vesselPositions-update', function(vessels) {
            const now = Date.now();

            // Throttle vessel updates for performance
            if (now - lastVesselUpdate < CONFIG.VESSEL_UPDATE_THROTTLE) {
                return;
            }
            lastVesselUpdate = now;

            // Handle both single object and array
            const vesselArray = Array.isArray(vessels) ? vessels : [vessels];

            // Queue vessels for batch processing instead of processing immediately
            vesselArray.forEach((vessel) => {
                queueVesselUpdate(vessel);
            });

            // Remove stale vessels (less frequently)
            if (now % 5000 < CONFIG.VESSEL_UPDATE_THROTTLE) { // Every ~5 seconds
                removeStaleVessels();
            }

            // Update info panel (less frequently)
            if (now % 2000 < CONFIG.VESSEL_UPDATE_THROTTLE) { // Every ~2 seconds
                updateInfoPanel();
            }
        });

    } catch (error) {
        console.error('Failed to create AIS Socket.IO connection:', error);
    }
}

// Initialize the application
function init() {
    // Initial data fetch for aircraft
    fetchAircraftData();

    // Set up periodic updates for aircraft (use slower interval if in low power mode)
    const aircraftInterval = CONFIG.LOW_POWER_MODE ? CONFIG.AIRCRAFT_REFRESH_INTERVAL : CONFIG.REFRESH_INTERVAL;
    setInterval(fetchAircraftData, aircraftInterval);

    // Connect to AIS Socket.IO
    connectAISSocket();

    // Keep labels visible using Leaflet's movement/zoom transforms, then
    // recalculate screen-space placement as soon as movement ends.
    map.on('movestart', () => {
        mapIsMoving = true;
    });
    map.on('moveend', () => {
        mapIsMoving = false;
        recalculateLabels();
    });
    map.on('resize popupopen popupclose', scheduleLabelLayout);
    if (document.fonts) {
        document.fonts.ready.then(scheduleLabelLayout);
        document.fonts.addEventListener('loadingdone', scheduleLabelLayout);
    }
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
