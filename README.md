# Robo-Boy ROS Time Series Panel

A standalone external panel for inspecting numeric ROS telemetry without changing Robo-Boy core. It uses the
Panel API v2 ROS broker and contains no ROSLIB client or direct rosbridge connection.

## Features

- Presents permitted discovered topics and message types in a sorted source dropdown.
- Plots up to eight nested or indexed numeric fields selected from detected message data.
- Automatically detects numeric fields from the first message and exposes them as removable field chips.
- Configurable time window, sample limit, rosbridge throttle, automatic/manual Y range, and point markers.
- Pause/resume, clear, CSV export, latest-value legend, connection state, and per-tile persisted settings.
- Stops sampling while the tile is inactive and releases the ROS subscription on reconfigure or unmount.

## Develop

```bash
npm install
npm run build
npm run integrity
npm run validate
```

After changing the bundle, copy the value printed by `npm run integrity` into `roboboy.panel.json`. The type-only
SDK development dependency is pinned to the versioned Panel SDK GitHub release.

To load this working tree in Robo-Boy, list `robo-boy-timeseries-panel` in a schema-v2 local source's
`repositories` array and rerun the panel installer. A local source reads the manifest and bundle directly; an
inventory entry is needed only for a published remote installation.

## Use

1. Add **ROS Time Series** to the Robo-Boy workspace.
2. Open **Configure** and choose a topic from the discovered-topic dropdown.
3. Apply with auto-detect enabled; numeric fields from the first message appear as removable chips and selectable
   data-field options.
4. Open **Advanced plot settings** only when you need to change retention, bridge throttling, Y scaling, point
   markers, or enter a custom topic/field path.

The configuration opens as a bounded, scrollable drawer so all controls remain reachable in short mobile tiles.

The panel runs in an opaque-origin iframe. Its manifest currently permits discovery and subscription only below
`/telemetry/**` and `/diagnostics/**`; the host filters discovery and rejects every other topic. A deployment
that needs another namespace must add that scope deliberately and review it during installation. The panel never
receives the raw ROSLIB connection, parent DOM, Robo-Boy stores, cookies, or unrelated runtime endpoints.
