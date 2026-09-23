# Robo-Boy ROS Time Series Panel

A standalone external panel for inspecting numeric ROS telemetry without changing Robo-Boy core. It uses the
Panel API v2 ROS broker and contains no ROSLIB client, React runtime, charting library, or direct rosbridge
connection.

## Features

- Plots up to 16 independently configurable fields from one or more ROS topics on the same time axis.
- Opens Robo-Boy's trusted topic picker; the panel sees only the topics the user approves.
- Detects nested and indexed numeric fields from the first message while still allowing custom field paths.
- Gives every series a stable color, optional short label and unit, legend visibility toggle, and remove action.
- Supports raw values, an incremental moving average (2–500 samples), and an incremental exponential moving
  average (alpha 0.01–1) independently for each series.
- Provides a configurable time window, per-series sample cap, rosbridge throttle, graph refresh rate,
  automatic/manual Y range, and point markers.
- Includes pause/resume (subscriptions stay healthy), clear, long-form CSV export, latest-value legend, and
  connection state.
- Stores schema-v3 settings per workspace tile and migrates existing schema-v1/v2 single-topic settings.
- Shares one ROS subscription among fields from the same topic, explicitly reconciles subscriptions on connection
  changes, and releases them when a series is disabled, the tile becomes inactive, or the panel closes.
- Uses bounded ring buffers, incremental filters, canvas point decimation, and a render-rate cap for predictable
  memory and CPU use on high-frequency streams.

## Use

1. Add **ROS Time Series** to the Robo-Boy workspace and open **Configure**.
2. Choose **Add ROS topic…** and approve a topic in Robo-Boy's trusted picker. The first live message adds up to
   eight useful numeric fields automatically, preserving the version-2 single-topic workflow.
3. Repeat **Add ROS topic…** to combine telemetry from other topics. Use **Add detected field…** or the custom
   field row to add more fields from a configured topic.
4. Expand a series row to set its label, unit, and smoothing. The moving-average value is a sample count; the
   exponential-average value is alpha, where a smaller alpha is smoother.
5. Use the checkbox or click the compact legend item to hide a series without deleting its settings. Use **×** in
   Configure to remove it permanently.

Changing a series filter resets only that series' buffered history so raw and differently filtered values are not
joined by a misleading line. **Pause** freezes plotted history but continues receiving ROS messages and updating
filter state; **Resume** continues with the current signal. **Clear** resets all plotted history and filter state.

### Examples

- Compare two joints: add `/joint_states`, keep `position[0]` and `position[1]`, label them `Shoulder` and `Elbow`,
  and set the unit to `rad`.
- Compare command and response: add `/arm/command` and `/arm/state`, plot their numeric position fields, and use a
  10-sample moving average on the measured state.
- Inspect a noisy sensor: add `/imu/data`, select `linear_acceleration.x/y/z`, set `m/s²`, and use EMA alpha `0.2`.

Topics may publish at different rates; each sample keeps its own arrival timestamp. A missing topic leaves the
other series live, and its broker subscription is recreated when Robo-Boy reports a new ROS connection generation.

## Performance controls

**Samples per series** is a hard memory bound (100–10,000). Old samples are also evicted as they leave the selected
time window. **Bridge throttle** reduces messages before they cross the panel boundary; **Graph refresh** controls
canvas work independently, so a 200 Hz source can be retained without forcing 200 UI updates per second. Before
drawing, large buffers are reduced to time-ordered bucket extrema so spikes remain visible.

## Develop

```bash
npm install
npm run validate
npm run integrity
```

After changing the bundle, copy the value printed by `npm run integrity` into `roboboy.panel.json`. `npm run
validate` type-checks, tests, builds, and verifies the production artifact. The type-only SDK dependency is pinned
to the versioned Panel SDK GitHub release and adds no runtime code.

To load this working tree in Robo-Boy, list `robo-boy-timeseries-panel` in a schema-v2 local source's
`repositories` array and rerun the panel installer. A local source reads the manifest and bundle directly; an
inventory entry is needed only for a published remote installation.

## Security and persistence

The panel runs in an opaque-origin iframe. Robo-Boy enumerates the ROS graph in trusted host UI and grants only
the exact topic/type pairs the user selects. The panel never receives the full graph, a raw ROSLIB connection,
parent DOM, Robo-Boy stores, cookies, or unrelated runtime endpoints.

Robo-Boy remembers approved topic/type pairs and the schema-v3 panel configuration with the current workspace
tile. Reopening a saved workspace restores series visibility, labels, units, colors, filters, and plot settings.
Portable workspace exports intentionally omit trusted topic grants, so imported workspaces ask the user to
reapprove their configured topics.
