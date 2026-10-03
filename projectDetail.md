# PublicPort: transit driving simulator on OpenStreetMap

Pick any city on Earth, choose a real metro, train, tram, monorail, bus or ferry line, and drive it. Routes, stops, tunnels, viaducts and speed limits all come live from OpenStreetMap. The app is mobile-first, installs as a PWA, and keeps working offline for cities you've already loaded.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173 (also exposed on your LAN, open it on a phone)
npm run build      # production build + service worker in dist/
npm run preview    # serve the production build
npm run test:sim   # headless regression: parser + engine drive the Kolkata Blue Line end to end
npm run icons      # regenerate PWA icons from public/favicon.svg
```

## Gameplay

- **Master controller lever** (right edge): push up for power notches (P1–P5), centre for coast (N), pull down for brake notches (B1–B8), and the striped zone at the bottom is the emergency brake.
- **Timetable**: every stop has a scheduled time derived from the line's real speed profile. Leaving early costs points, and so does arriving late.
- **Stopping**: stop the front of the vehicle in the green zone (shown on the track and on the gauge), then open the doors. Passengers get off and on, and you close the doors at departure time.
- **Speed limits** come from OSM `maxspeed` tags and track curvature. Metro, train and monorail have **ATP**: more than 10 km/h over the limit triggers an emergency brake.
- **Comfort**: harsh acceleration, jerk and taking curves too fast upset passengers.
- **Weather** (live from Open-Meteo, or chosen): rain, storms and snow reduce adhesion, which causes wheel slip when braking hard.
- **Time of day**: lighting follows the real sun position at the city, and the UI switches between light and dark.
- **Cameras**: 3D chase, cab view, and 2D (heading-up or north-up). Drag to look around, pinch or scroll to zoom.
- **Score** is out of a maximum for each shift, with 0–3 stars, personal bests and career totals.

Keyboard: `W`/`S` or arrow keys move the lever · `E` emergency · `N` neutral · `Space` doors · `H` horn · `C` camera · `R` reverse · `P`/`Esc` pause.

## Architecture

```
src/
  lib/osm/        city search (Photon), route lists + geometry (Overpass), IndexedDB cache
  lib/sim/        vehicle profiles, Track (speed limits, tunnels, viaducts), timetable, passengers, Engine
  lib/env/        sun position, weather, day→golden→dusk→night map palettes
  lib/audio/      fully synthesised sound (VVVF motors, diesel gearbox, rail joints, horns, chimes) + voice announcements
  map/            MapLibre controller, custom vector style, WebGL scene layer (3D vehicles, track, platforms, crowds)
  game/           runner (frame loop), actions (navigation and data flow), theme sync
  components/     screens (Home, Search, City, Route, Drive, Results, Settings) and HUD widgets
  store/          zustand stores: app, HUD, persisted settings and progress
```

Key decisions:

- **Fetching routes**: two parallel Overpass queries find route relations *through their member ways* (rails/ferries, then roads). This is about 10× cheaper than `rel(bbox)`, so rail lines appear in about 2 s. Results are cached for 7 days. Requests fall back across four public Overpass mirrors.
- **Route geometry**: ordered way members are chained into one directed polyline, with handling for reversed ways, roundabouts and gaps (there's a greedy fallback for unordered relations). Stops are projected onto the line in sequence, so loop routes work. Bus routes with no ways are routed through their stops with OSRM.
- **Rendering**: the vehicle, track, platforms and passengers are drawn by a custom WebGL layer that shares MapLibre's depth buffer. A ghost pass shows the vehicle through OSM station buildings, and tunnels switch to an x-ray view.
- **Physics** runs at a fixed ≤1/60 s step, decoupled from the frame rate, and supports 2×/4× time warp.

## Data & credits

Map data © OpenStreetMap contributors (ODbL) · vector tiles: OpenFreeMap / OpenMapTiles · city search: Photon (Komoot) · weather and time zones: Open-Meteo · fallback bus routing: OSRM demo server · flags: flagcdn.

## Known limitations

- How playable a line is depends on OSM data quality. Routes with missing stops or geometry show a clear message instead of a broken run.
- Public Overpass servers can be busy. The app retries and falls back, but a first visit to a huge city can still take a while.
- Vibration isn't available on iOS Safari. Announcement voices depend on the device.
