// Configuration
const CONFIG = {
    ADSB_API_URL: '/api/aircraft', // Using local proxy to avoid CORS issues
    AIS_SOCKET_URL: 'http://192.168.1.16', // Socket.IO server URL (without /socket/)
    AIS_SOCKET_PATH: '/socket/', // Socket.IO path
    REFRESH_INTERVAL: 1000, // 1 second
    DEFAULT_CENTER: [51.505, -0.09], // Default to London area
    DEFAULT_ZOOM: 8,
    MAX_AIRCRAFT_AGE: 60 // Remove aircraft not seen for 60 seconds
};

// Initialize the map
const map = L.map('map', {
    center: CONFIG.DEFAULT_CENTER,
    zoom: CONFIG.DEFAULT_ZOOM,
    zoomControl: true
});

// Add dark mode OSM tile layer
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
}).addTo(map);

// Store aircraft markers
const aircraftMarkers = new Map();
const vesselMarkers = new Map();
let firstDataLoad = true;

// Socket.IO for AIS data
let aisSocket = null;

// Label positioning system to avoid overlaps
const labelPositions = new Map(); // Store label positions for collision detection

// Label positioning options - try these positions in order
const LABEL_POSITIONS = [
    { direction: 'right', offset: [25, 0], className: 'label-right' },
    { direction: 'left', offset: [-25, 0], className: 'label-left' },
    { direction: 'top', offset: [0, -25], className: 'label-top' },
    { direction: 'bottom', offset: [0, 25], className: 'label-bottom' },
    { direction: 'topright', offset: [18, -18], className: 'label-topright' },
    { direction: 'topleft', offset: [-18, -18], className: 'label-topleft' },
    { direction: 'bottomright', offset: [18, 18], className: 'label-bottomright' },
    { direction: 'bottomleft', offset: [-18, 18], className: 'label-bottomleft' }
];

// Check if two rectangles overlap
function rectanglesOverlap(rect1, rect2) {
    return !(rect1.right < rect2.left || 
             rect1.left > rect2.right || 
             rect1.bottom < rect2.top || 
             rect1.top > rect2.bottom);
}

// Find best label position to avoid overlaps
function findBestLabelPosition(marker, labelText, markerType) {
    const markerPoint = map.latLngToLayerPoint(marker.getLatLng());
    
    // Try each position until we find one without overlaps
    for (const posConfig of LABEL_POSITIONS) {
        const labelPoint = {
            x: markerPoint.x + posConfig.offset[0],
            y: markerPoint.y + posConfig.offset[1]
        };
        
        // Estimate label size (approximate based on text length)
        const labelWidth = labelText.length * 7 + 10; // ~7px per character + padding
        const labelHeight = 20;
        
        const proposedRect = {
            left: labelPoint.x - labelWidth / 2,
            right: labelPoint.x + labelWidth / 2,
            top: labelPoint.y - labelHeight / 2,
            bottom: labelPoint.y + labelHeight / 2
        };
        
        // Check against all existing labels
        let hasOverlap = false;
        for (const [id, existingRect] of labelPositions) {
            if (rectanglesOverlap(proposedRect, existingRect)) {
                hasOverlap = true;
                break;
            }
        }
        
        if (!hasOverlap) {
            return { config: posConfig, rect: proposedRect };
        }
    }
    
    // If all positions overlap, use default (right)
    const labelPoint = {
        x: markerPoint.x + 25,
        y: markerPoint.y
    };
    const labelWidth = labelText.length * 7 + 10;
    const labelHeight = 20;
    
    return {
        config: LABEL_POSITIONS[0],
        rect: {
            left: labelPoint.x - labelWidth / 2,
            right: labelPoint.x + labelWidth / 2,
            top: labelPoint.y - labelHeight / 2,
            bottom: labelPoint.y + labelHeight / 2
        }
    };
}

// Recalculate all label positions (called on zoom/pan)
function recalculateLabels() {
    labelPositions.clear();
    
    // Update aircraft labels
    aircraftMarkers.forEach((marker, hex) => {
        if (marker.getTooltip()) {
            const labelText = marker.getTooltip().getContent();
            const result = findBestLabelPosition(marker, labelText, 'aircraft');
            
            labelPositions.set(`aircraft-${hex}`, result.rect);
            
            // Update tooltip configuration
            marker.unbindTooltip();
            marker.bindTooltip(labelText, {
                permanent: true,
                direction: result.config.direction,
                className: `aircraft-label-tooltip ${result.config.className}`,
                offset: result.config.offset
            });
        }
    });
    
    // Update vessel labels
    vesselMarkers.forEach((marker, mmsi) => {
        if (marker.getTooltip()) {
            const labelText = marker.getTooltip().getContent();
            const result = findBestLabelPosition(marker, labelText, 'vessel');
            
            labelPositions.set(`vessel-${mmsi}`, result.rect);
            
            // Update tooltip configuration
            marker.unbindTooltip();
            marker.bindTooltip(labelText, {
                permanent: true,
                direction: result.config.direction,
                className: `vessel-label-tooltip ${result.config.className}`,
                offset: result.config.offset
            });
        }
        // If no tooltip exists, the vessel is stationary - don't add one
    });
}

// Create custom aircraft icon using Font Awesome
function createAircraftIcon(heading = 0) {
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
    // Use true_heading, fallback to mag_heading, then calc_track, default to 0
    const heading = aircraft.true_heading !== undefined ? aircraft.true_heading :
                    aircraft.mag_heading !== undefined ? aircraft.mag_heading :
                    aircraft.calc_track !== undefined ? aircraft.calc_track : 0;
    
    const labelText = aircraft.flight ? aircraft.flight.trim() : '';
    
    if (aircraftMarkers.has(aircraft.hex)) {
        // Update existing marker
        const marker = aircraftMarkers.get(aircraft.hex);
        marker.setLatLng(position);
        marker.setIcon(createAircraftIcon(heading));
        marker.getPopup().setContent(createPopupContent(aircraft));
        marker.lastSeen = Date.now();
        
        // Label will be repositioned in recalculateLabels()
    } else {
        // Create new marker
        const marker = L.marker(position, {
            icon: createAircraftIcon(heading)
        }).addTo(map);
        
        marker.bindPopup(createPopupContent(aircraft));
        marker.lastSeen = Date.now();
        marker.hex = aircraft.hex;
        
        // Initial label (will be repositioned in recalculateLabels())
        if (labelText) {
            marker.bindTooltip(labelText, {
                permanent: true,
                direction: 'right',
                className: 'aircraft-label-tooltip',
                offset: [25, 0]
            });
        }
        
        aircraftMarkers.set(aircraft.hex, marker);
    }
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

// Update or create vessel marker
function updateVesselMarker(vessel) {
    // Check if vessel has position (coordinates array: [lat, lon])
    if (!vessel.coordinates || !Array.isArray(vessel.coordinates) || vessel.coordinates.length < 2) {
        console.warn('⚠️ Vessel missing coordinates:', vessel);
        return;
    }
    
    const position = [vessel.coordinates[0], vessel.coordinates[1]];
    const heading = vessel.course !== undefined && vessel.course !== null ? vessel.course : 0;
    const speed = vessel.speed !== undefined ? vessel.speed : 0;
    const status = vessel.navigationalStatus || '';
    const mmsi = vessel.mmsi;
    const labelText = vessel.name ? vessel.name.trim() : `${mmsi}`;
    
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
        
        if (shouldShowLabel && !marker.getTooltip()) {
            // Add label if it doesn't exist and vessel is now moving
            marker.bindTooltip(labelText, {
                permanent: true,
                direction: 'right',
                className: 'vessel-label-tooltip',
                offset: [25, 0]
            });
        } else if (!shouldShowLabel && marker.getTooltip()) {
            // Remove label if vessel is now stationary
            marker.unbindTooltip();
        } else if (shouldShowLabel && marker.getTooltip()) {
            // Update label text if it exists
            marker.setTooltipContent(labelText);
        }
        
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
        
        if (shouldShowLabel) {
            marker.bindTooltip(labelText, {
                permanent: true,
                direction: 'right',
                className: 'vessel-label-tooltip',
                offset: [25, 0]
            });
        }
        
        vesselMarkers.set(mmsi, marker);
    }
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
            
            // Recalculate label positions to avoid overlaps
            recalculateLabels();
            
            // Update info panel
            updateInfoPanel(data.aircraft.length);
            
            // Auto-center map on first data load
            if (firstDataLoad && aircraftMarkers.size > 0) {
                const bounds = L.latLngBounds(
                    Array.from(aircraftMarkers.values()).map(m => m.getLatLng())
                );
                map.fitBounds(bounds, { padding: [50, 50] });
                firstDataLoad = false;
            }
        }
    } catch (error) {
        console.error('Error fetching aircraft data:', error);
        document.getElementById('aircraft-count').textContent = `Error: ${error.message}`;
        document.getElementById('aircraft-count').style.color = '#f44336';
    }
}

// Update info panel
function updateInfoPanel(count) {
    const now = new Date();
    const timeString = now.toLocaleTimeString();
    
    document.getElementById('aircraft-count').textContent = `Aircraft: ${aircraftMarkers.size} | Vessels: ${vesselMarkers.size}`;
    document.getElementById('aircraft-count').style.color = '#4CAF50';
    document.getElementById('last-update').textContent = `Last update: ${timeString}`;
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
        aisSocket.on('vesselPositions-update', function(vessels) {
            // Handle both single object and array
            const vesselArray = Array.isArray(vessels) ? vessels : [vessels];
            
            vesselArray.forEach((vessel) => {
                updateVesselMarker(vessel);
            });
            
            // Remove stale vessels
            removeStaleVessels();
            
            // Recalculate label positions to avoid overlaps
            recalculateLabels();
            
            // Update info panel
            updateInfoPanel();
        });
        
    } catch (error) {
        console.error('Failed to create AIS Socket.IO connection:', error);
    }
}

// Initialize the application
function init() {
    // Initial data fetch for aircraft
    fetchAircraftData();
    
    // Set up periodic updates for aircraft
    setInterval(fetchAircraftData, CONFIG.REFRESH_INTERVAL);
    
    // Connect to AIS Socket.IO
    connectAISSocket();
    
    // Recalculate labels on map zoom/move
    map.on('zoomend moveend', () => {
        recalculateLabels();
    });
}

// Start the application when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
