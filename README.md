# Multi-Map Tracking

A real-time dual-source tracking web application displaying live ADS-B aircraft and AIS vessel data on a full-screen OpenStreetMap with dark mode styling.

## Features

- **Full-screen dark mode map** using OpenStreetMap and CartoDB dark tiles
- **Real-time dual-source tracking**: Aircraft (ADS-B) and vessels (AIS) with 1-second refresh
- **Measured label collision avoidance** with stable placement and decluttering in crowded areas
- **Visible leader lines** connecting labels to markers
- **Differential styling**: Bright moving objects with glow, faded stationary objects at 50% opacity
- **Conditional label display**: Labels shown only for moving objects (speed ≥0.5 kts)
- **Rotating icons** based on true heading
- **Interactive popups** with detailed information for aircraft and vessels
- **Auto-cleanup** of stale data (60-second timeout)
- **Live statistics** showing aircraft/vessel counts and last update time

## Data Sources

### ADS-B Aircraft Data
- **Endpoint:** `http://192.168.1.119/tar1090/data/aircraft.json`
- **Refresh Rate:** 1 second via HTTP proxy
- **Data Format:** JSON with aircraft array

### AIS Vessel Data
- **Endpoint:** `http://192.168.1.16` (Socket.IO WebSocket)
- **Path:** `/socket/`
- **Event:** `vesselPositions-update`
- **Refresh Rate:** Real-time streaming

### Aircraft Data Structure

Each aircraft object contains:
- `hex` (required): Unique aircraft identifier
- `lat`, `lon`: Aircraft position
- `true_heading`: Direction of travel (used for icon rotation)
- `alt_baro`, `alt_geom`: Altitude information
- `gs`: Ground speed
- `flight`: Flight number/callsign
- `squawk`: Transponder code
- `category`: Aircraft category

### Vessel Data Structure

Each vessel object contains:
- `mmsi` (required): Unique vessel identifier
- `lat`, `lon`: Vessel position
- `heading`: Direction of travel (used for icon rotation)
- `speed`: Speed over ground in knots
- `course`: Course over ground
- `name`: Vessel name
- `status`: Vessel status (e.g., "moored", "underway")
- `destination`: Destination port
- `callsign`: Vessel callsign

## Installation & Usage

### Prerequisites

- Python 3.6+ (for the proxy server)
- Access to ADS-B API at `http://192.168.1.119/tar1090/data/aircraft.json`
- Access to AIS WebSocket at `http://192.168.1.16:` with `/socket/` path

### Quick Start

1. **Run the proxy server** (in the project directory):

```bash
python3 proxy-server.py
```

The proxy server will:
- Serve your HTML, CSS, and JavaScript files on port 8000
- Fetch data from the ADS-B API and add CORS headers
- Handle errors gracefully

The map key is loaded from the local, Git-ignored `map-config.js` file. Copy `map-config.example.js` to `map-config.js` and add your key there. The key is still visible to browser users; this only keeps it out of the repository.

2. **Open your browser** and navigate to:

```
http://localhost:8000
```

The map will immediately start displaying real-time aircraft and vessel data.

## Configuration

Edit the `CONFIG` object in `app.js` to customize:

```javascript
const CONFIG = {
    ADSB_API_URL: 'http://localhost:8000/api/aircraft', // Via proxy server
    AIS_SERVER_URL: 'http://192.168.1.16', // Direct WebSocket connection
    REFRESH_INTERVAL: 1000, // milliseconds
    DEFAULT_CENTER: [51.505, -0.09], // [latitude, longitude]
    DEFAULT_ZOOM: 8,
    MAX_AIRCRAFT_AGE: 60, // seconds
    MAX_VESSEL_AGE: 300, // seconds
    MOVEMENT_THRESHOLD: 0.5 // knots - speed required to display label
};
```

### Key Settings

- **MOVEMENT_THRESHOLD**: Minimum speed (in knots) for a vessel to be considered "moving"
- **Labels appear** only for aircraft/vessels that are actively moving
- **Styling**: Moving objects are bright with glow; stationary objects are 50% transparent

## Technology Stack

- **Leaflet.js** (v1.9.4): Interactive map library
- **Socket.IO** (v4.7.2): Real-time WebSocket communication for vessel data
- **OpenStreetMap**: Map data provider
- **CartoDB Dark**: Dark mode tile layer
- **Vanilla JavaScript**: No frameworks required
- **HTML5 & CSS3**: Modern web standards
- **Font Awesome**: Icon library for markers
- **B612 Font**: Aviation-standard typeface from Google Fonts
- **Python HTTP Server**: CORS proxy for ADS-B data

## Browser Compatibility

Works on all modern browsers:
- Chrome/Edge 90+
- Firefox 88+
- Safari 14+
- Opera 76+

## How It Works

### Label Collision Avoidance

The application automatically positions labels to avoid overlaps:
- Measures each rendered label, including its font, padding and border
- Tries 8 directions at increasing distances, avoiding other labels, all traffic icons, map controls and open popups
- Keeps labels inside the viewport and preserves previous positions while they remain clear
- Prioritizes aircraft, then faster traffic; temporarily hides labels that cannot fit without a clash
- Keeps all markers and their clickable detail popups available, even when their labels are hidden
- Reconsiders hidden labels after live updates, pan, zoom, resize, popup changes and font loading
- Draws leader lines from label borders toward their markers

`LABEL_GAP` and `LABEL_EDGE_PADDING` in `app.js` control spacing in pixels. The placement algorithm lives in `label-layout.js` and uses a spatial index to check nearby rectangles. Updates share one animation-frame layout, without a continuous physics simulation or rebuilding every tooltip.

This handles the application's traffic labels. Text baked into the raster basemap cannot participate in collision detection. For a future renderer migration, [MapLibre GL JS symbol layers](https://maplibre.org/maplibre-gl-js/docs/examples/variable-label-placement/) provide built-in collision handling and variable label anchors; traffic markers and labels would need to become symbol layers to benefit.

### Dual-Source Integration

**Aircraft (ADS-B)**:
- Updates fetched via HTTP every 1 second
- Displayed with rotated aircraft icons
- Airplane emoji in labels

**Vessels (AIS)**:
- Real-time updates via WebSocket
- Displayed with rotated ship icons
- Ship emoji in labels

**Unified Behavior**:
- Labels only show for moving objects (speed ≥0.5 kts)
- Stationary objects rendered at 50% opacity without glow
- Moving objects rendered bright with blue glow effect
- Duplicate markers automatically detected and removed
- Stale data automatically removed after timeout

## Future Enhancements

Potential improvements for future versions:
- Layer visibility toggles (show/hide aircraft or vessels)
- Filtering by speed, altitude, or type
- Historical track trails
- Custom color schemes
- Search functionality

## Project Structure

```
multi-map/
├── index.html                      # Main HTML file
├── styles.css                      # Styling and dark mode theme
├── app.js                         # Application logic and data handling
├── label-layout.js                # Screen-space label placement
├── tests/                         # Placement and application regression tests
├── proxy-server.py                # CORS proxy for ADS-B API
├── README.md                      # This file
└── .github/
    └── copilot-instructions.md    # AI assistant context
```

## Troubleshooting

### No aircraft/vessels appearing?
- Check that the proxy server is running: `python3 proxy-server.py`
- Verify ADS-B API is accessible: `curl http://192.168.1.119/tar1090/data/aircraft.json`
- Verify AIS WebSocket is accessible from your network
- Check browser console for error messages (F12)
- Hard refresh browser cache: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows/Linux)

### Labels overlapping?
- Hard refresh to ensure the latest JavaScript and CSS are loaded.
- In crowded areas, some labels are intentionally hidden. Zoom in to make room, or click a marker to read its details.
- Traffic labels avoid one another; place names baked into map tiles are separate.
- Check the browser console for JavaScript errors if traffic labels still overlap.

## Tests

Run the regression tests with Node.js 18 or newer (no dependencies to install):

```bash
node --test tests/*.test.js
```

Tests cover dense clusters, long names, viewport edges, label priorities, stable movement, resizing, font metrics, panning away and back, popup changes and vessel movement state. The application tests use a small DOM/Leaflet adapter; visual verification in a real browser is still useful.

### Performance issues?
- The application is optimized to handle 100+ aircraft/vessels
- If performance degrades, check browser console for errors
- Reduce `REFRESH_INTERVAL` in CONFIG if network latency is not an issue

## Performance Notes

- Label collision detection runs on zoom/pan events and after data updates
- Icons are only recreated when movement state changes or heading changes >5°
- Duplicate markers are detected and removed automatically
- Stale aircraft/vessel records are removed after timeout
- Console logging is minimal to avoid performance overhead

## License

This project is provided as-is for educational and personal use.

## Acknowledgments

- OpenStreetMap contributors
- Leaflet.js team
- CartoDB for dark mode tiles
- Socket.IO team
- Font Awesome for icons
- B612 Mono font by Airbus
- ADS-B and AIS communities for data standards
