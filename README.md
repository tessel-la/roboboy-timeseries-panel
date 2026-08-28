# Robo-Boy ROS Time Series Panel

A standalone external panel for inspecting numeric ROS telemetry without changing Robo-Boy core. It bundles its
own ROSLIB client constructors and uses only the public panel context.

## Features

- Presents discovered topics and message types in a sorted source dropdown.
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

After changing the bundle, copy the value printed by `npm run integrity` into `roboboy.panel.json`. The SDK is a
local type-only dependency in this workspace; switch it to the published SDK version when that package exists.

## Use

1. Add **ROS Time Series** to the Robo-Boy workspace.
2. Open **Configure** and choose a topic from the discovered-topic dropdown.
3. Apply with auto-detect enabled; numeric fields from the first message appear as removable chips and selectable
   data-field options.
4. Open **Advanced plot settings** only when you need to change retention, bridge throttling, Y scaling, point
   markers, or enter a custom topic/field path.

The configuration opens as a bounded, scrollable drawer so all controls remain reachable in short mobile tiles.

The panel is trusted same-realm deployment code, like every v1 external panel. Its `ros` capability supplies the
shared connection; it does not access Robo-Boy stores or `window.ros`.
