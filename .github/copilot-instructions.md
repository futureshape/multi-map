# Multi-Map Dual-Source Tracking Project

## Project Overview
A full-screen web map displaying real-time aircraft (ADS-B) and vessel (AIS) data with OpenStreetMap and dark mode styling. Features intelligent label collision avoidance, visible leader lines, and differential styling for moving vs. stationary objects.

## Technology Stack
- **Leaflet.js** (v1.9.4): Interactive map rendering
- **Socket.IO** (v4.7.2): Real-time AIS vessel data streaming
- **OpenStreetMap & CartoDB Dark**: Map tiles and dark theme
- **Vanilla JavaScript**: Data fetching, marker management, collision detection
- **Python HTTP Server**: CORS proxy for ADS-B API
- **Font Awesome**: Icon library
- **B612 Font**: Aviation-standard typeface

## Data Sources

### ADS-B Aircraft
- **Endpoint:** `http://192.168.1.119/tar1090/data/aircraft.json`
- **Proxy:** `http://localhost:8000/api/aircraft`
- **Refresh:** 1 second via HTTP polling
- **Key ID:** `hex`

### AIS Vessels
- **Endpoint:** `http://192.168.1.16` (WebSocket)
- **Path:** `/socket/`
- **Event:** `vesselPositions-update`
- **Refresh:** Real-time streaming
- **Key ID:** `mmsi`

## Core Features

### Label Collision Avoidance
- 8-position placement system (right, left, top, bottom, 4 diagonals)
- Rectangle overlap detection algorithm
- Automatic recalculation on zoom/pan/data update
- Visible CSS pseudo-element leader lines

### Conditional Label Display
- Labels show only for moving objects (speed ≥ 0.5 knots)
- Aircraft always have labels (constantly moving)
- Vessels show labels only when actively moving
- Labels dynamically show/hide on state changes

### Differential Styling
- **Moving Objects:** Bright with blue glow effect (100% opacity)
- **Stationary Objects:** Faded at 50% opacity, no glow
- **Visual Distinction:** Immediately clear what's active vs. idle

### Performance Optimization
- Icons recreated only when movement state changes or heading >5° delta
- Duplicate marker detection via `map.eachLayer()` scan
- Stale data auto-cleanup (60s aircraft, 300s vessels)
- Minimal console logging (no Socket.IO event spam)

## Key Code Architecture

### File: `app.js`
**Main Application Logic**

**Key Data Structures:**
- `aircraftMarkers` (Map): `hex` → marker object
- `vesselMarkers` (Map): `mmsi` → marker object
- `labelPositions` (Map): marker object → position object
- `LABEL_POSITIONS` (Array): 8 position definitions

**Core Functions:**
- `findBestLabelPosition()`: Iterates through 8 positions, returns non-overlapping position
- `rectanglesOverlap()`: Collision detection between two rectangles
- `recalculateLabels()`: Repositions all labels, called on zoom/pan/update
- `updateAircraftMarker()`: Creates/updates aircraft markers with rotation
- `updateVesselMarker()`: Creates/updates vessel markers, manages label visibility based on speed
- `createVesselPopupContent()`: Generates popup HTML with null checks on speed/course
- `removeStaleVessels()`: Removes vessels >300s old
- `updateInfoPanel()`: Updates live count display

**Socket.IO Integration:**
- Connects to `AIS_SERVER_URL` with `/socket/` path
- Listens only to `vesselPositions-update` event
- No console logging - background operation

### File: `styles.css`
**Styling & Visual Effects**

**Key Classes:**
- `.vessel-icon-wrapper.vessel-dot`: Static vessel at 50% opacity
- `.vessel-icon-wrapper:not(.vessel-dot)`: Moving vessel at 100% opacity with glow
- `.label-right`, `.label-left`, etc.: 8 position classes with ::after leader lines
- `.vessel-marker.vessel-dot svg`: Static vessel filter (black shadow only)
- `.vessel-marker:not(.vessel-dot) svg`: Moving vessel filter (shadow + blue glow)

**Leader Lines:**
- CSS ::after pseudo-elements on tooltip element
- Different line directions for each of 8 positions
- Diagonal lines use CSS transforms (rotate, translateX)
- Color: currentColor with 0.6 opacity

### File: `proxy-server.py`
**CORS Proxy & Static File Server**
- Port 8000
- Serves `/` → `index.html`, `/api/aircraft` → ADS-B API
- Adds CORS headers to all responses
- Python 3.6+ required

## Key Implementation Details

### Label Positioning Algorithm
```
For each label (on zoom/pan/update):
  For each of 8 positions:
    Calculate label rectangle at that position
    Check if overlaps any other label rectangle
    If no overlap found:
      Apply position class
      Store in labelPositions Map
      Break
```

### Vessel Movement Detection
```
speed < 0.5 knots OR status === "moored"
  → Vessel is stationary
  → Apply vessel-dot class (50% opacity, no glow)
  → Hide label (unbind tooltip)
  
speed >= 0.5 knots AND status !== "moored"
  → Vessel is moving
  → Remove vessel-dot class (100% opacity, with glow)
  → Show label (bind tooltip)
```

### Icon Optimization
```
Store on marker: lastMovementState, lastHeading
On update:
  Calculate current movement state and heading
  If movement state changed OR |heading - lastHeading| > 5°:
    Recreate icon SVG
    Update marker.setIcon()
  Else:
    Update position only via marker.setLatLng()
```

## Project Status & Completion

✅ **Completed Features:**
- Dual-source tracking (aircraft + vessels)
- Label collision avoidance with 8 positions
- Visible leader lines connecting labels to markers
- Conditional label display based on movement state
- Differential styling (moving bright/glow, stationary faded)
- Performance optimization (icon recreation only on state changes)
- Duplicate marker detection and removal
- Null-safe popup content generation
- Console logging cleaned up (no noise)
- Error handling for missing/null data fields

✅ **Testing Verified:**
- Aircraft display with rotating icons
- Vessel display with rotating icons and movement labels
- Labels reposition on zoom/pan without overlaps
- Stationary vessels appear faded and labelless
- Moving vessels appear bright with labels
- No progressive brightening of icons
- No unhandled promise rejections

## Debugging Notes

### Browser Console
- No logging output in normal operation
- Check browser console (F12) for any errors
- Network tab shows HTTP requests to proxy and WebSocket connections

### Common Issues
- **No data showing:** Verify proxy running (`python3 proxy-server.py`)
- **Old code running:** Hard refresh with `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R`
- **Labels overlapping:** Shouldn't happen; verify latest code is loaded
- **Icons getting brighter:** Fixed by icon optimization; hard refresh if still occurs

## Future Enhancement Ideas

- Layer toggles to show/hide aircraft or vessels separately
- Filtering by speed, altitude, distance, destination
- Historical track trails for moving objects
- Custom color schemes by object type or source
- Search/locate specific aircraft or vessels
- Heatmap visualization of traffic density
- Performance metrics dashboard

## Development Workflow

1. Make changes to `app.js` or `styles.css`
2. Hard refresh browser (`Cmd+Shift+R`)
3. Open browser console to check for errors
4. Test with live data from both sources
5. Verify label positioning, styling, and performance
