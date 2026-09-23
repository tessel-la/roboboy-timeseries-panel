import type {
  RoboBoyJsonObject,
  RoboBoyPanelConnectionSnapshot,
  RoboBoyPanelContext,
  RoboBoyPanelDefinition,
  RoboBoyPanelInstance,
  RoboBoyRosTopic,
} from "@tessel-la/roboboy-panel-sdk";
import {
  AUTO_PLOT_FIELD_LIMIT,
  COLORS,
  DEFAULT_CONFIG,
  SERIES_LIMIT,
  createSeriesId,
  displayName,
  getDesiredSources,
  sanitizeConfig,
  sourceKey,
  type TimeseriesConfig,
  type TimeseriesSeriesConfig,
  type TopicSource,
} from "./config";
import {
  RealtimeFilter,
  SampleBuffer,
  chooseAutoPlotFields,
  createCsv,
  decimateSamples,
  discoverNumericFields,
  getNumericValueAtPath,
  getPlotRange,
  parseFieldPath,
  type FilterConfig,
  type TimeseriesSample,
} from "./data";
import { SubscriptionController } from "./subscriptions";

const PANEL_ID = "la.tessel.roboboy.timeseries";
const DISCOVERED_FIELD_LIMIT = 64;

const PANEL_MARKUP = `
  <style>
    .rb-timeseries { position: relative; height: 100%; min-height: 180px; box-sizing: border-box; display: grid; grid-template-rows: auto minmax(100px, 1fr) auto; gap: 9px; padding: 11px; color: var(--text-color, #eef3f8); background: var(--background-secondary, #171c24); font: 13px/1.35 var(--font-family-ui, system-ui, sans-serif); overflow: hidden; }
    .rb-timeseries[data-inactive] { opacity: .78; }
    .rb-timeseries * { box-sizing: border-box; }
    .rb-timeseries__toolbar, .rb-timeseries__status, .rb-timeseries__legend { display: flex; align-items: center; gap: 7px; }
    .rb-timeseries__toolbar { flex-wrap: wrap; }
    .rb-timeseries__title { margin: 0 auto 0 0; font-size: 15px; }
    .rb-timeseries button { border: 1px solid var(--border-color, #3d4654); border-radius: 6px; padding: 6px 9px; color: inherit; background: var(--card-bg, #242b36); cursor: pointer; font: inherit; }
    .rb-timeseries button:hover { border-color: var(--primary-color, #5ca9ff); }
    .rb-timeseries button:focus-visible, .rb-timeseries input:focus-visible, .rb-timeseries select:focus-visible { outline: 2px solid var(--primary-color, #5ca9ff); outline-offset: 1px; }
    .rb-timeseries button:disabled { opacity: .45; cursor: default; }
    .rb-timeseries__dot { width: 8px; height: 8px; border-radius: 50%; background: #7b8795; box-shadow: 0 0 0 3px #7b879522; }
    .rb-timeseries__dot[data-tone="live"] { background: var(--success-color, #57d68d); box-shadow: 0 0 0 3px #57d68d22; }
    .rb-timeseries__dot[data-tone="warn"] { background: var(--warning-color, #ffb454); box-shadow: 0 0 0 3px #ffb45422; }
    .rb-timeseries__settings { position: absolute; z-index: 10; inset: 7px 7px 7px auto; width: min(680px, calc(100% - 14px)); min-width: 0; max-width: 100%; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; border: 1px solid var(--border-color, #343d49); border-radius: 12px; overflow: hidden; box-shadow: 0 12px 32px #0008; background: var(--card-bg, #242b36); }
    .rb-timeseries__settings[hidden] { display: none; }
    .rb-timeseries__settings > *, .rb-timeseries__settings-content > *, .rb-timeseries__section > * { min-width: 0; max-width: 100%; }
    .rb-timeseries__settings-header, .rb-timeseries__settings-actions, .rb-timeseries__add-row { display: flex; align-items: center; gap: 8px; }
    .rb-timeseries__settings-header { justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--border-color, #343d49); background: var(--card-bg, #242b36); }
    .rb-timeseries__settings-heading { min-width: 0; }
    .rb-timeseries__kicker { display: block; margin-bottom: 1px; color: var(--primary-color, #5ca9ff); font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; }
    .rb-timeseries__settings-header h3 { margin: 0; font-size: 16px; line-height: 1.25; }
    .rb-timeseries__settings-header p { margin: 2px 0 0; color: var(--text-secondary, #aeb8c4); font-size: 11px; }
    .rb-timeseries__icon-button { width: 38px; height: 38px; flex: 0 0 auto; display: grid; place-items: center; padding: 0 !important; font-size: 20px !important; line-height: 1; }
    .rb-timeseries__settings-content { min-height: 0; display: grid; align-content: start; gap: 10px; padding: 10px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
    .rb-timeseries__section { min-width: 0; max-width: 100%; display: grid; gap: 9px; padding: 10px; border: 1px solid var(--border-color, #343d49); border-radius: 10px; background: color-mix(in srgb, var(--background-color, #11161d) 35%, transparent); }
    .rb-timeseries__section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .rb-timeseries__section-title h4 { margin: 0; font-size: 13px; }
    .rb-timeseries label { display: grid; gap: 4px; color: var(--text-secondary, #aeb8c4); min-width: 0; }
    .rb-timeseries input, .rb-timeseries select { width: 100%; min-width: 0; max-width: 100%; border: 1px solid var(--border-color, #414b59); border-radius: 7px; padding: 7px 8px; color: var(--text-color, #eef3f8); background: var(--background-color, #11161d); font: inherit; }
    .rb-timeseries input[type="checkbox"] { width: auto; }
    .rb-timeseries__add-row { min-width: 0; max-width: 100%; flex-wrap: wrap; }
    .rb-timeseries__add-row select { flex: 1 1 220px; }
    .rb-timeseries__series-list { min-width: 0; max-width: 100%; display: grid; gap: 8px; }
    .rb-timeseries__series-card { min-width: 0; max-width: 100%; display: grid; gap: 8px; padding: 9px; border: 1px solid var(--border-color, #343d49); border-radius: 9px; border-left: 3px solid var(--series-color, var(--primary-color, #5ca9ff)); background: #ffffff05; overflow: hidden; }
    .rb-timeseries__series-header { min-width: 0; max-width: 100%; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; gap: 8px; }
    .rb-timeseries__series-toggle { width: 34px; height: 34px; display: grid !important; place-items: center; cursor: pointer; }
    .rb-timeseries__series-toggle input { width: 18px; height: 18px; margin: 0; }
    .rb-timeseries__swatch { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 2px; }
    .rb-timeseries__series-identity { min-width: 0; max-width: 100%; display: grid; gap: 1px; }
    .rb-timeseries__series-name, .rb-timeseries__series-source { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rb-timeseries__series-name { color: var(--text-color, #eef3f8); font-weight: 600; }
    .rb-timeseries__series-source { color: var(--text-secondary, #8f9aa8); font-size: 11px; }
    .rb-timeseries__remove { width: 34px; height: 34px; display: grid; place-items: center; border-color: transparent !important; padding: 0 !important; color: var(--text-secondary, #aeb8c4) !important; background: transparent !important; font-size: 18px !important; line-height: 1; }
    .rb-timeseries__series-fields, .rb-timeseries__advanced-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .rb-timeseries__series-fields { padding: 8px 0 0; }
    .rb-timeseries__series-fields .wide { grid-column: 1 / -1; }
    .rb-timeseries__filter-control { min-width: 0; max-width: 100%; display: grid; gap: 5px; padding-top: 1px; }
    .rb-timeseries__control-label { color: var(--text-secondary, #aeb8c4); font-size: 12px; }
    .rb-timeseries__filter-row { min-width: 0; max-width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) minmax(82px, 110px); gap: 7px; align-items: end; }
    .rb-timeseries__filter-row[data-raw] { grid-template-columns: minmax(0, 1fr); }
    .rb-timeseries__filter-parameter { min-width: 0; display: grid; gap: 4px; }
    .rb-timeseries__filter-parameter span { color: var(--text-secondary, #aeb8c4); font-size: 11px; }
    .rb-timeseries__helper { min-width: 0; max-width: 100%; margin: 0; color: var(--text-secondary, #8f9aa8); font-size: 12px; overflow-wrap: anywhere; word-break: break-word; }
    .rb-timeseries__series-details { min-width: 0; max-width: 100%; border-top: 1px solid var(--border-color, #343d49); }
    .rb-timeseries__series-details-toggle { width: 100%; display: flex; align-items: center; gap: 6px; border: 0 !important; padding: 8px 0 0 !important; color: var(--text-secondary, #aeb8c4) !important; background: transparent !important; font-size: 12px !important; font-weight: 600 !important; text-align: left; }
    .rb-timeseries__series-details-toggle::before { content: "›"; transition: transform .12s; }
    .rb-timeseries__series-details-toggle[aria-expanded="true"]::before { transform: rotate(90deg); }
    .rb-timeseries__series-fields[hidden] { display: none; }
    .rb-timeseries__custom-row { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(140px, 1fr) auto; gap: 6px; }
    .rb-timeseries__advanced { padding: 0; }
    .rb-timeseries__advanced > summary { padding: 10px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .rb-timeseries__advanced-grid { padding: 0 10px 10px; }
    .rb-timeseries__check { display: flex !important; justify-content: start; align-items: center; align-content: end; padding-bottom: 6px; }
    .rb-timeseries__settings-actions { justify-content: flex-end; padding: 10px 14px; border-top: 1px solid var(--border-color, #343d49); background: var(--card-bg, #242b36); }
    .rb-timeseries__settings-actions button[data-action="apply-settings"] { border-color: var(--primary-color, #5ca9ff); background: var(--primary-color, #347fc4); }
    .rb-timeseries__chart { min-height: 100px; position: relative; border: 1px solid var(--border-color, #343d49); border-radius: 8px; overflow: hidden; background: var(--background-color, #10151c); }
    .rb-timeseries canvas { display: block; width: 100%; height: 100%; }
    .rb-timeseries__empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; text-align: center; color: var(--text-secondary, #8f9aa8); pointer-events: none; }
    .rb-timeseries__empty[hidden] { display: none; }
    .rb-timeseries__footer { min-width: 0; display: flex; align-items: center; gap: 9px; }
    .rb-timeseries__legend { min-width: 0; flex: 1; overflow-x: auto; scrollbar-width: thin; }
    .rb-timeseries__legend button { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; padding: 3px 6px; border-color: transparent; background: #ffffff0a; }
    .rb-timeseries__legend button[aria-pressed="false"] { opacity: .48; text-decoration: line-through; }
    .rb-timeseries__legend strong { font-variant-numeric: tabular-nums; }
    .rb-timeseries__stats { white-space: nowrap; color: var(--text-secondary, #aeb8c4); font-variant-numeric: tabular-nums; }
    @media (max-width: 760px) {
      .rb-timeseries { min-height: 150px; padding: 8px; gap: 7px; }
      .rb-timeseries__title { width: 100%; }
      .rb-timeseries__settings { inset: 0; width: 100%; max-width: 100%; border: 0; border-radius: 0; box-shadow: none; }
      .rb-timeseries__settings-content { padding: 8px; -webkit-overflow-scrolling: touch; }
      .rb-timeseries__settings-header { padding: 9px 10px; }
      .rb-timeseries__settings-actions { padding: 8px 10px; }
      .rb-timeseries__settings-actions button { min-height: 42px; width: 100%; }
      .rb-timeseries__settings button, .rb-timeseries__settings input, .rb-timeseries__settings select { min-height: 42px; }
      .rb-timeseries__series-toggle { width: 42px; height: 42px; }
      .rb-timeseries__remove { width: 42px; height: 42px; }
      .rb-timeseries__series-fields, .rb-timeseries__advanced-grid { grid-template-columns: minmax(0, 1fr); }
      .rb-timeseries__series-fields .wide { grid-column: auto; }
      .rb-timeseries__add-row, .rb-timeseries__custom-row { display: grid; grid-template-columns: minmax(0, 1fr); }
      .rb-timeseries__footer { align-items: flex-start; flex-direction: column; }
      .rb-timeseries__legend { width: 100%; }
    }
    @media (max-height: 420px) {
      .rb-timeseries__toolbar { gap: 5px; }
      .rb-timeseries__toolbar button { padding: 4px 7px; }
      .rb-timeseries__footer { flex-direction: row; align-items: center; }
      .rb-timeseries__legend { display: none; }
    }
  </style>
  <section class="rb-timeseries" aria-label="ROS Time Series panel">
    <header class="rb-timeseries__toolbar">
      <h2 class="rb-timeseries__title">ROS Time Series</h2>
      <span class="rb-timeseries__status"><i class="rb-timeseries__dot"></i><span data-role="status">Not configured</span></span>
      <button type="button" data-action="pause" disabled>Pause</button>
      <button type="button" data-action="clear">Clear</button>
      <button type="button" data-action="export" disabled>Export CSV</button>
      <button type="button" data-action="configure" aria-expanded="false">Configure</button>
    </header>
    <form class="rb-timeseries__settings" data-role="settings" aria-label="Time series configuration" hidden>
      <header class="rb-timeseries__settings-header">
        <div class="rb-timeseries__settings-heading">
          <span class="rb-timeseries__kicker">Time Series</span>
          <h3>Chart settings</h3>
          <p>Series changes save immediately.</p>
        </div>
        <button class="rb-timeseries__icon-button" type="button" data-action="close-settings" aria-label="Close chart settings">×</button>
      </header>
      <div class="rb-timeseries__settings-content">
        <section class="rb-timeseries__section" aria-labelledby="rb-timeseries-series-title">
          <div class="rb-timeseries__section-title"><h4 id="rb-timeseries-series-title">Data series</h4></div>
          <div class="rb-timeseries__add-row">
            <button type="button" data-action="choose-topic">Add ROS topic…</button>
            <select data-field="fieldPicker" aria-label="Add detected numeric field"><option value="">Add detected field…</option></select>
          </div>
          <div class="rb-timeseries__series-list" data-role="series-list"></div>
          <p class="rb-timeseries__helper" data-role="series-help">Choose a topic. Numeric fields are detected from its first live message.</p>
          <div class="rb-timeseries__custom-row">
            <select data-field="customSource" aria-label="Custom field topic"><option value="">Topic…</option></select>
            <input data-field="customField" aria-label="Custom numeric field" placeholder="pose.position.x" autocomplete="off" />
            <button type="button" data-action="add-custom-field">Add field</button>
          </div>
        </section>
        <details class="rb-timeseries__advanced rb-timeseries__section">
          <summary>Plot and performance</summary>
          <div class="rb-timeseries__advanced-grid">
            <label>Window (seconds)<input data-field="timeWindowSec" type="number" min="1" max="600" step="1" /></label>
            <label>Samples per series<input data-field="sampleLimit" type="number" min="100" max="10000" step="100" /></label>
            <label>Bridge throttle
              <select data-field="throttleMs">
                <option value="0">Every message</option><option value="16">60 Hz</option><option value="33">30 Hz</option>
                <option value="50">20 Hz</option><option value="100">10 Hz</option><option value="250">4 Hz</option><option value="500">2 Hz</option>
              </select>
            </label>
            <label>Graph refresh
              <select data-field="renderFps"><option value="5">5 Hz</option><option value="10">10 Hz</option><option value="20">20 Hz</option><option value="30">30 Hz</option><option value="60">60 Hz</option></select>
            </label>
            <label class="rb-timeseries__check"><input data-field="autoScale" type="checkbox" />Auto Y range</label>
            <label class="rb-timeseries__check"><input data-field="showPoints" type="checkbox" />Point markers</label>
            <label>Y minimum<input data-field="minY" type="number" step="any" /></label>
            <label>Y maximum<input data-field="maxY" type="number" step="any" /></label>
          </div>
        </details>
      </div>
      <div class="rb-timeseries__settings-actions">
        <button type="button" data-action="apply-settings">Apply &amp; close</button>
      </div>
    </form>
    <div class="rb-timeseries__chart" data-role="chart"><canvas aria-label="ROS numeric time-series chart"></canvas><div class="rb-timeseries__empty" data-role="empty">Add a ROS topic to begin.</div></div>
    <footer class="rb-timeseries__footer"><div class="rb-timeseries__legend" data-role="legend"></div><span class="rb-timeseries__stats" data-role="stats">0 samples</span></footer>
  </section>
`;

const createPanelInstance = (
  context: RoboBoyPanelContext,
): RoboBoyPanelInstance => {
  let root: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let settings: HTMLFormElement | null = null;
  let viewportUnsubscribe: (() => void) | null = null;
  let connectionUnsubscribe: (() => void) | null = null;
  let subscriptions: SubscriptionController | null = null;
  let animationFrame: number | null = null;
  let renderTimer: number | null = null;
  let lastRenderAt = 0;
  let active = true;
  let paused = false;
  let statusText = "";
  let statusTone = "";
  let connection = context.connection.getSnapshot();
  let lastConnectionGeneration = connection.generation;

  const storedConfig = context.storage?.get(
    "config",
    DEFAULT_CONFIG as unknown as RoboBoyJsonObject,
  );
  let config = sanitizeConfig(storedConfig);
  const buffers = new Map<string, SampleBuffer>();
  const filters = new Map<string, RealtimeFilter>();
  const discoveredFields = new Map<string, string[]>();
  const expandedSeries = new Set<string>();

  const query = <T extends Element>(selector: string): T => {
    const element = root?.querySelector<T>(selector);
    if (!element) throw new Error(`ROS Time Series is missing ${selector}.`);
    return element;
  };

  const persistConfig = () => {
    try {
      context.storage?.set("config", config as unknown as RoboBoyJsonObject);
    } catch (error) {
      context.logger.warn("Unable to persist time-series settings.", error);
    }
  };

  const setStatus = (
    message: string,
    tone: "idle" | "live" | "warn" = "idle",
  ) => {
    if (!root || (statusText === message && statusTone === tone)) return;
    statusText = message;
    statusTone = tone;
    query<HTMLElement>('[data-role="status"]').textContent = message;
    query<HTMLElement>(".rb-timeseries__dot").dataset.tone = tone;
  };

  const ensureRuntime = (series: TimeseriesSeriesConfig, reset = false) => {
    if (!series.fieldPath) return;
    const current = buffers.get(series.id);
    if (reset || !current || current.capacity !== config.sampleLimit) {
      buffers.set(series.id, new SampleBuffer(config.sampleLimit));
    }
    if (reset || !filters.has(series.id)) {
      filters.set(series.id, new RealtimeFilter(series.filter));
    }
  };

  const reconcileRuntime = (reset = false) => {
    const ids = new Set(config.series.map((series) => series.id));
    [...buffers.keys()].forEach((id) => {
      if (!ids.has(id)) buffers.delete(id);
    });
    [...filters.keys()].forEach((id) => {
      if (!ids.has(id)) filters.delete(id);
    });
    config.series.forEach((series) => ensureRuntime(series, reset));
  };

  const desiredSources = () =>
    active && connection.status === "connected" ? getDesiredSources(config) : [];

  const updatePauseButton = () => {
    if (!root) return;
    const button = query<HTMLButtonElement>('[data-action="pause"]');
    button.disabled = config.series.every((series) => !series.enabled) || !context.ros;
    button.textContent = paused ? "Resume" : "Pause";
  };

  const reconcileSubscriptions = (restart = false) => {
    updatePauseButton();
    const desired = desiredSources();
    if (restart) subscriptions?.restart(desired);
    else subscriptions?.reconcile(desired);
    if (!active) setStatus("Inactive · subscriptions released");
    else if (connection.status !== "connected") {
      setStatus(`ROS ${connection.status}`, connection.status === "connecting" ? "warn" : "idle");
    } else if (desired.length === 0) setStatus("Add or enable a series");
    else if (!paused) setStatus(`Waiting for ${desired.length} topic${desired.length === 1 ? "" : "s"}…`);
  };

  const requestFrame = () => {
    if (!root || !active || animationFrame !== null) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = null;
      lastRenderAt = performance.now();
      renderChart();
    });
  };

  const scheduleRender = (immediate = false) => {
    if (!root || !active) return;
    if (immediate) {
      if (renderTimer !== null) window.clearTimeout(renderTimer);
      renderTimer = null;
      requestFrame();
      return;
    }
    if (renderTimer !== null || animationFrame !== null) return;
    const interval = 1000 / config.renderFps;
    const delay = Math.max(0, lastRenderAt + interval - performance.now());
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      requestFrame();
    }, delay);
  };

  const totalSamples = () =>
    [...buffers.values()].reduce((total, buffer) => total + buffer.size, 0);

  const uniqueSources = (): TopicSource[] => {
    const sources = new Map<string, TopicSource>();
    config.series.forEach((series) => {
      const key = sourceKey(series.topic, series.messageType);
      sources.set(key, { key, topic: series.topic, messageType: series.messageType, throttleMs: config.throttleMs });
    });
    return [...sources.values()];
  };

  const updateSeries = (
    id: string,
    mutate: (series: TimeseriesSeriesConfig) => TimeseriesSeriesConfig,
    options: { reset?: boolean; reconcile?: boolean; renderControls?: boolean } = {},
  ) => {
    config = {
      ...config,
      series: config.series.map((series) => series.id === id ? mutate(series) : series),
    };
    if (options.reset) {
      const series = config.series.find((item) => item.id === id);
      if (series) ensureRuntime(series, true);
    }
    persistConfig();
    if (options.renderControls !== false) renderSeriesControls();
    if (options.reconcile) reconcileSubscriptions();
    scheduleRender(true);
  };

  const addSeries = (
    topic: string,
    messageType: string,
    fieldPath: string,
    preferred?: Partial<TimeseriesSeriesConfig>,
  ): TimeseriesSeriesConfig | null => {
    if (config.series.length >= SERIES_LIMIT) {
      setStatus(`Series limit reached (${SERIES_LIMIT})`, "warn");
      return null;
    }
    if (config.series.some((series) =>
      series.topic === topic && series.messageType === messageType && series.fieldPath === fieldPath
    )) return null;
    const used = new Set(config.series.map((series) => series.id));
    const series: TimeseriesSeriesConfig = {
      id: createSeriesId(topic, fieldPath || "pending", used),
      topic,
      messageType,
      fieldPath,
      enabled: preferred?.enabled !== false,
      label: preferred?.label ?? "",
      unit: preferred?.unit ?? "",
      color: preferred?.color ?? COLORS[config.series.length % COLORS.length],
      filter: preferred?.filter ?? { type: "raw" },
    };
    config = { ...config, series: [...config.series, series] };
    ensureRuntime(series);
    persistConfig();
    renderSeriesControls();
    reconcileSubscriptions();
    scheduleRender(true);
    return series;
  };

  const removeSeries = (id: string) => {
    config = { ...config, series: config.series.filter((series) => series.id !== id) };
    buffers.delete(id);
    filters.delete(id);
    expandedSeries.delete(id);
    persistConfig();
    renderSeriesControls();
    reconcileSubscriptions();
    scheduleRender(true);
  };

  const renderSeriesControls = () => {
    if (!root) return;
    const list = query<HTMLElement>('[data-role="series-list"]');
    list.replaceChildren();
    config.series.forEach((series) => {
      const card = document.createElement("article");
      card.className = "rb-timeseries__series-card";
      card.dataset.seriesId = series.id;
      card.style.setProperty("--series-color", series.color);
      const header = document.createElement("div");
      header.className = "rb-timeseries__series-header";
      const toggle = document.createElement("label");
      toggle.className = "rb-timeseries__series-toggle";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = series.enabled;
      enabled.dataset.seriesToggle = series.id;
      enabled.setAttribute("aria-label", `Show ${displayName(series)}`);
      toggle.append(enabled);
      const swatch = document.createElement("i");
      swatch.className = "rb-timeseries__swatch";
      swatch.style.backgroundColor = series.color;
      const identity = document.createElement("div");
      identity.className = "rb-timeseries__series-identity";
      const fullSource = `${series.topic} · ${series.messageType}${series.fieldPath ? ` · ${series.fieldPath}` : ""}`;
      const name = document.createElement("span");
      name.className = "rb-timeseries__series-name";
      name.textContent = `${displayName(series)}${series.unit ? ` (${series.unit})` : ""}`;
      name.title = fullSource;
      const sourceName = document.createElement("span");
      sourceName.className = "rb-timeseries__series-source";
      sourceName.textContent = series.fieldPath ? `${series.topic} · ${series.fieldPath}` : `${series.topic} · detecting numeric fields…`;
      sourceName.title = fullSource;
      identity.append(name, sourceName);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "rb-timeseries__remove";
      remove.dataset.action = "remove-series";
      remove.dataset.seriesId = series.id;
      remove.setAttribute("aria-label", `Remove ${displayName(series)}`);
      remove.textContent = "×";
      header.append(toggle, swatch, identity, remove);
      card.append(header);

      if (series.fieldPath) {
        card.append(createFilterControl(series));
        const details = document.createElement("div");
        details.className = "rb-timeseries__series-details";
        const detailsId = `rb-timeseries-series-fields-${series.id}`;
        const detailsToggle = document.createElement("button");
        detailsToggle.type = "button";
        detailsToggle.className = "rb-timeseries__series-details-toggle";
        detailsToggle.dataset.action = "toggle-series-details";
        detailsToggle.dataset.seriesId = series.id;
        detailsToggle.setAttribute("aria-controls", detailsId);
        detailsToggle.setAttribute("aria-expanded", String(expandedSeries.has(series.id)));
        detailsToggle.textContent = "Label, unit and source";
        const fields = document.createElement("div");
        fields.className = "rb-timeseries__series-fields";
        fields.id = detailsId;
        fields.hidden = !expandedSeries.has(series.id);
        fields.append(
          createTextInput("Label", series.label, "seriesLabel", series.id, "Optional short name"),
          createTextInput("Unit", series.unit, "seriesUnit", series.id, "m/s, °C, rad…"),
        );
        const source = document.createElement("p");
        source.className = "rb-timeseries__helper wide";
        source.textContent = fullSource;
        source.title = fullSource;
        fields.append(source);
        details.append(detailsToggle, fields);
        card.append(details);
      }
      list.append(card);
    });

    const picker = query<HTMLSelectElement>('[data-field="fieldPicker"]');
    picker.replaceChildren(new Option("Add detected field…", ""));
    uniqueSources().forEach((source) => {
      const available = (discoveredFields.get(source.key) ?? []).filter((field) =>
        !config.series.some((series) => series.topic === source.topic && series.messageType === source.messageType && series.fieldPath === field)
      );
      if (!available.length) return;
      const group = document.createElement("optgroup");
      group.label = source.topic;
      available.forEach((field) => group.append(new Option(field, JSON.stringify({ key: source.key, field }))));
      picker.append(group);
    });
    picker.disabled = config.series.length >= SERIES_LIMIT;

    const customSource = query<HTMLSelectElement>('[data-field="customSource"]');
    const previousSource = customSource.value;
    customSource.replaceChildren(new Option("Topic…", ""));
    uniqueSources().forEach((source) => customSource.append(new Option(source.topic, source.key)));
    customSource.value = Array.from(customSource.options).some((option) => option.value === previousSource) ? previousSource : customSource.options[1]?.value ?? "";

    const helper = query<HTMLElement>('[data-role="series-help"]');
    const pending = config.series.filter((series) => !series.fieldPath).length;
    helper.textContent = config.series.length === 0
      ? "Choose a topic. Numeric fields are detected from its first live message."
      : `${config.series.length} of ${SERIES_LIMIT} series configured${pending ? ` · ${pending} awaiting field detection` : ""}. Series changes save immediately.`;
    updatePauseButton();
  };

  const createTextInput = (
    labelText: string,
    value: string,
    dataName: string,
    id: string,
    placeholder: string,
  ): HTMLLabelElement => {
    const label = document.createElement("label");
    label.append(document.createTextNode(labelText));
    const input = document.createElement("input");
    input.value = value;
    input.placeholder = placeholder;
    input.dataset[dataName] = id;
    input.maxLength = dataName === "seriesUnit" ? 24 : 80;
    label.append(input);
    return label;
  };

  const createFilterControl = (series: TimeseriesSeriesConfig): HTMLDivElement => {
    const control = document.createElement("div");
    control.className = "rb-timeseries__filter-control";
    const heading = document.createElement("span");
    heading.className = "rb-timeseries__control-label";
    heading.textContent = "Smoothing";
    const row = document.createElement("div");
    row.className = "rb-timeseries__filter-row";
    row.toggleAttribute("data-raw", series.filter.type === "raw");
    const select = document.createElement("select");
    select.dataset.seriesFilter = series.id;
    select.setAttribute("aria-label", `Smoothing for ${displayName(series)}`);
    select.append(
      new Option("Raw · no filter", "raw"),
      new Option("Moving average", "movingAverage"),
      new Option("Exponential moving average", "ema"),
    );
    select.value = series.filter.type;
    row.append(select);
    if (series.filter.type !== "raw") {
      const parameterLabel = document.createElement("label");
      parameterLabel.className = "rb-timeseries__filter-parameter";
      const parameterName = document.createElement("span");
      const parameter = document.createElement("input");
      parameter.type = "number";
      parameter.dataset.seriesFilterParameter = series.id;
      if (series.filter.type === "movingAverage") {
        parameterName.textContent = "Window";
        parameter.value = String(series.filter.window);
        parameter.min = "2";
        parameter.max = "500";
        parameter.step = "1";
        parameter.title = "Sample window";
        parameter.setAttribute("aria-label", "Moving average sample window");
      } else {
        parameterName.textContent = "Factor";
        parameter.value = String(series.filter.alpha);
        parameter.min = "0.01";
        parameter.max = "1";
        parameter.step = "0.01";
        parameter.title = "EMA alpha";
        parameter.setAttribute("aria-label", "Exponential average alpha");
      }
      parameterLabel.append(parameterName, parameter);
      row.append(parameterLabel);
    }
    control.append(heading, row);
    return control;
  };

  const populatePlotInputs = () => {
    query<HTMLInputElement>('[data-field="timeWindowSec"]').value = String(config.timeWindowSec);
    query<HTMLInputElement>('[data-field="sampleLimit"]').value = String(config.sampleLimit);
    query<HTMLSelectElement>('[data-field="throttleMs"]').value = String(config.throttleMs);
    query<HTMLSelectElement>('[data-field="renderFps"]').value = String(config.renderFps);
    query<HTMLInputElement>('[data-field="autoScale"]').checked = config.autoScale;
    query<HTMLInputElement>('[data-field="showPoints"]').checked = config.showPoints;
    query<HTMLInputElement>('[data-field="minY"]').value = String(config.minY);
    query<HTMLInputElement>('[data-field="maxY"]').value = String(config.maxY);
    query<HTMLInputElement>('[data-field="minY"]').disabled = config.autoScale;
    query<HTMLInputElement>('[data-field="maxY"]').disabled = config.autoScale;
  };

  const readPlotInputs = (): TimeseriesConfig => sanitizeConfig({
    ...config,
    schemaVersion: 3,
    series: config.series,
    timeWindowSec: query<HTMLInputElement>('[data-field="timeWindowSec"]').valueAsNumber,
    sampleLimit: query<HTMLInputElement>('[data-field="sampleLimit"]').valueAsNumber,
    throttleMs: Number(query<HTMLSelectElement>('[data-field="throttleMs"]').value),
    renderFps: Number(query<HTMLSelectElement>('[data-field="renderFps"]').value),
    autoScale: query<HTMLInputElement>('[data-field="autoScale"]').checked,
    showPoints: query<HTMLInputElement>('[data-field="showPoints"]').checked,
    minY: query<HTMLInputElement>('[data-field="minY"]').valueAsNumber,
    maxY: query<HTMLInputElement>('[data-field="maxY"]').valueAsNumber,
  });

  const chooseTopic = async () => {
    if (!context.ros || typeof context.ros.selectTopic !== "function") {
      setStatus("Connect ROS before choosing a topic", "warn");
      return;
    }
    setStatus("Waiting for topic approval…");
    try {
      const selected: RoboBoyRosTopic = await context.ros.selectTopic();
      if (!root) return;
      const key = sourceKey(selected.name, selected.messageType);
      if (config.series.some((series) => sourceKey(series.topic, series.messageType) === key)) {
        reconcileSubscriptions();
        setStatus(`${selected.name} is already configured`, "warn");
        return;
      }
      addSeries(selected.name, selected.messageType, "");
      setStatus(`Waiting for ${selected.name} fields…`);
    } catch (error) {
      if (!root) return;
      context.logger.info("ROS topic selection was not completed.", error);
      setStatus("Topic selection cancelled", "warn");
    }
  };

  const expandPendingSeries = (source: TopicSource, fields: readonly string[]) => {
    const pending = config.series.find((series) =>
      series.fieldPath === "" && sourceKey(series.topic, series.messageType) === source.key
    );
    if (!pending) return;
    const remaining = SERIES_LIMIT - config.series.length + 1;
    const selected = chooseAutoPlotFields(fields, Math.min(AUTO_PLOT_FIELD_LIMIT, remaining));
    if (!selected.length) {
      setStatus(`No numeric fields found on ${source.topic}`, "warn");
      return;
    }
    const used = new Set(config.series.map((series) => series.id));
    const replacement = selected.map((fieldPath, index): TimeseriesSeriesConfig => {
      const id = index === 0 ? pending.id : createSeriesId(source.topic, fieldPath, used);
      used.add(id);
      return {
        ...pending,
        id,
        fieldPath,
        color: COLORS[(config.series.indexOf(pending) + index) % COLORS.length],
      };
    });
    config = {
      ...config,
      series: config.series.flatMap((series) => series.id === pending.id ? replacement : [series]),
    };
    buffers.delete(pending.id);
    filters.delete(pending.id);
    reconcileRuntime();
    persistConfig();
    renderSeriesControls();
  };

  const onSourceMessage = (source: TopicSource, message: unknown) => {
    if (!active) return;
    if (!discoveredFields.has(source.key)) {
      const fields = discoverNumericFields(message, {
        maxDepth: 8,
        maxArrayItems: DISCOVERED_FIELD_LIMIT,
        maxFields: DISCOVERED_FIELD_LIMIT,
      });
      discoveredFields.set(source.key, fields);
      expandPendingSeries(source, fields);
      renderSeriesControls();
    }

    const now = Date.now();
    let captured = 0;
    config.series.forEach((series) => {
      if (!series.enabled || !series.fieldPath || sourceKey(series.topic, series.messageType) !== source.key) return;
      const value = getNumericValueAtPath(message, series.fieldPath);
      if (value === null) return;
      ensureRuntime(series);
      const filtered = filters.get(series.id)!.next(value);
      if (!paused) {
        buffers.get(series.id)!.push(
          { time: now, value: filtered },
          now - config.timeWindowSec * 1000,
        );
      }
      captured += 1;
    });
    if (paused) setStatus("Paused · ROS remains connected", "warn");
    else if (captured > 0) {
      const count = getDesiredSources(config).length;
      setStatus(`Live · ${count} topic${count === 1 ? "" : "s"}`, "live");
      scheduleRender();
    }
  };

  const renderLegend = () => {
    if (!root) return;
    const legend = query<HTMLElement>('[data-role="legend"]');
    legend.replaceChildren();
    config.series.filter((series) => series.fieldPath).forEach((series) => {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.action = "toggle-series";
      item.dataset.seriesId = series.id;
      item.setAttribute("aria-pressed", String(series.enabled));
      item.title = `${series.enabled ? "Hide" : "Show"} ${displayName(series)}`;
      const swatch = document.createElement("i");
      swatch.className = "rb-timeseries__swatch";
      swatch.style.backgroundColor = series.color;
      const label = document.createElement("span");
      label.textContent = displayName(series);
      const latest = document.createElement("strong");
      const sample = buffers.get(series.id)?.latest();
      latest.textContent = sample ? `${Number(sample.value.toPrecision(6))}${series.unit ? ` ${series.unit}` : ""}` : "—";
      item.append(swatch, label, latest);
      legend.append(item);
    });
    const count = totalSamples();
    const topicCount = uniqueSources().length;
    query<HTMLElement>('[data-role="stats"]').textContent = `${count.toLocaleString()} samples · ${topicCount} topic${topicCount === 1 ? "" : "s"}`;
    query<HTMLButtonElement>('[data-action="export"]').disabled = count === 0;
  };

  const renderChart = () => {
    if (!root || !canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.round(bounds.width));
    const height = Math.max(150, Math.round(bounds.height));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * pixelRatio);
    const pixelHeight = Math.round(height * pixelRatio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    const drawing = canvas.getContext("2d");
    if (!drawing) return;
    drawing.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawing.clearRect(0, 0, width, height);

    const visible = config.series.filter((series) => series.enabled && series.fieldPath && (buffers.get(series.id)?.size ?? 0) > 0);
    const empty = query<HTMLElement>('[data-role="empty"]');
    empty.hidden = visible.length > 0;
    if (!visible.length) {
      empty.textContent = config.series.length === 0
        ? "Add a ROS topic to begin."
        : config.series.every((series) => !series.enabled)
          ? "All series are hidden. Use the legend or Configure to show one."
          : "Waiting for numeric ROS messages…";
      renderLegend();
      return;
    }

    const latestTimes = visible.map((series) => buffers.get(series.id)?.latest()?.time ?? 0);
    const newestTime = Math.max(...latestTimes);
    const oldestTime = newestTime - config.timeWindowSec * 1000;
    const rendered = new Map<string, TimeseriesSample[]>();
    visible.forEach((series) => {
      rendered.set(series.id, buffers.get(series.id)!.toArray(oldestTime));
    });
    const allSamples = [...rendered.values()].flat();
    const padding = { left: 58, right: 18, top: 20, bottom: 32 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const range = getPlotRange(allSamples, config.autoScale, config.minY, config.maxY);
    const valueSpan = Math.max(1e-12, range.max - range.min);

    drawing.lineWidth = 1;
    drawing.font = "11px system-ui, sans-serif";
    drawing.textBaseline = "middle";
    for (let index = 0; index <= 4; index += 1) {
      const ratio = index / 4;
      const y = padding.top + ratio * chartHeight;
      const value = range.max - ratio * valueSpan;
      drawing.strokeStyle = "#8ba0b51f";
      drawing.beginPath();
      drawing.moveTo(padding.left, y);
      drawing.lineTo(width - padding.right, y);
      drawing.stroke();
      drawing.fillStyle = "#91a0b0";
      drawing.textAlign = "right";
      drawing.fillText(Number(value.toPrecision(4)).toString(), padding.left - 8, y);
    }
    for (let index = 0; index <= 5; index += 1) {
      const ratio = index / 5;
      const x = padding.left + ratio * chartWidth;
      drawing.strokeStyle = "#8ba0b516";
      drawing.beginPath();
      drawing.moveTo(x, padding.top);
      drawing.lineTo(x, height - padding.bottom);
      drawing.stroke();
      drawing.fillStyle = "#91a0b0";
      drawing.textAlign = "center";
      drawing.fillText(`${(-config.timeWindowSec + ratio * config.timeWindowSec).toFixed(0)}s`, x, height - 13);
    }
    const units = [...new Set(visible.map((series) => series.unit).filter(Boolean))];
    if (units.length === 1) {
      drawing.fillStyle = "#91a0b0";
      drawing.textAlign = "left";
      drawing.fillText(units[0], padding.left, 10);
    }

    visible.forEach((series) => {
      const samples = decimateSamples(rendered.get(series.id) ?? [], Math.max(80, chartWidth * 2));
      if (!samples.length) return;
      drawing.strokeStyle = series.color;
      drawing.fillStyle = series.color;
      drawing.lineWidth = 1.7;
      drawing.lineJoin = "round";
      drawing.beginPath();
      samples.forEach((sample, index) => {
        const x = padding.left + ((sample.time - oldestTime) / (config.timeWindowSec * 1000)) * chartWidth;
        const y = padding.top + (1 - (sample.value - range.min) / valueSpan) * chartHeight;
        if (index === 0) drawing.moveTo(x, y);
        else drawing.lineTo(x, y);
      });
      drawing.stroke();
      if (config.showPoints) {
        samples.forEach((sample) => {
          const x = padding.left + ((sample.time - oldestTime) / (config.timeWindowSec * 1000)) * chartWidth;
          const y = padding.top + (1 - (sample.value - range.min) / valueSpan) * chartHeight;
          drawing.beginPath();
          drawing.arc(x, y, 2.1, 0, Math.PI * 2);
          drawing.fill();
        });
      }
    });
    renderLegend();
  };

  const clearSamples = () => {
    buffers.forEach((buffer) => buffer.clear());
    filters.clear();
    config.series.forEach((series) => ensureRuntime(series));
    scheduleRender(true);
  };

  const exportCsv = () => {
    if (totalSamples() === 0) return;
    const data = new Map<string, TimeseriesSample[]>();
    config.series.forEach((series) => {
      const samples = buffers.get(series.id)?.toArray() ?? [];
      if (!samples.length) return;
      data.set(`${displayName(series)}${series.unit ? ` [${series.unit}]` : ""} · ${series.topic}:${series.fieldPath}`, samples);
    });
    const blob = new Blob([createCsv(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `roboboy-timeseries-${new Date().toISOString().replace(/:/g, "-")}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const setSettingsOpen = (open: boolean) => {
    if (!settings || !root) return;
    if (open) {
      renderSeriesControls();
      populatePlotInputs();
    }
    settings.hidden = !open;
    query<HTMLButtonElement>('[data-action="configure"]').setAttribute("aria-expanded", String(open));
    scheduleRender(true);
  };

  const applyPlotSettings = () => {
    const previousThrottle = config.throttleMs;
    config = readPlotInputs();
    reconcileRuntime(true);
    persistConfig();
    setSettingsOpen(false);
    reconcileSubscriptions(previousThrottle !== config.throttleMs);
    scheduleRender(true);
  };

  const setSeriesFilter = (id: string, filter: FilterConfig, renderControls = true) => {
    updateSeries(id, (series) => ({ ...series, filter }), { reset: true, renderControls });
  };

  return {
    mount(container) {
      container.innerHTML = PANEL_MARKUP;
      root = container.querySelector<HTMLElement>(".rb-timeseries");
      if (!root) throw new Error("Unable to create the ROS Time Series panel root.");
      canvas = query<HTMLCanvasElement>("canvas");
      settings = query<HTMLFormElement>('[data-role="settings"]');
      reconcileRuntime();
      renderSeriesControls();
      populatePlotInputs();

      if (context.ros) {
        subscriptions = new SubscriptionController(
          (source, listener) => context.ros!.subscribe(
            { topic: source.topic, messageType: source.messageType, queueLength: 1, throttleMs: source.throttleMs },
            listener as (message: RoboBoyJsonObject) => void,
          ),
          onSourceMessage,
          (source, error, operation) => {
            context.logger.warn(`ROS ${operation} failed for ${source.topic}.`, error);
            if (operation === "unsubscribe") return;
            const message = error instanceof Error ? error.message : String(error);
            setStatus(message.includes("not permitted") ? `Reapprove ${source.topic}` : `Unable to subscribe to ${source.topic}`, "warn");
          },
        );
      }

      root.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const actionElement = target?.closest<HTMLElement>("[data-action]");
        const action = actionElement?.dataset.action;
        if (action === "configure") setSettingsOpen(settings!.hidden);
        else if (action === "close-settings") setSettingsOpen(false);
        else if (action === "choose-topic") void chooseTopic();
        else if (action === "apply-settings") applyPlotSettings();
        else if (action === "remove-series") {
          event.preventDefault();
          event.stopPropagation();
          if (actionElement?.dataset.seriesId) removeSeries(actionElement.dataset.seriesId);
        } else if (action === "toggle-series-details") {
          const id = actionElement?.dataset.seriesId;
          if (id) {
            if (expandedSeries.has(id)) expandedSeries.delete(id);
            else expandedSeries.add(id);
            renderSeriesControls();
          }
        } else if (action === "toggle-series") {
          const id = actionElement?.dataset.seriesId;
          const series = config.series.find((item) => item.id === id);
          if (series) updateSeries(series.id, (item) => ({ ...item, enabled: !item.enabled }), { reconcile: true });
        } else if (action === "add-custom-field") {
          const source = uniqueSources().find((item) => item.key === query<HTMLSelectElement>('[data-field="customSource"]').value);
          const input = query<HTMLInputElement>('[data-field="customField"]');
          const field = parseFieldPath(input.value);
          if (source && field) {
            addSeries(source.topic, source.messageType, field);
            input.value = "";
          }
        } else if (action === "pause") {
          paused = !paused;
          updatePauseButton();
          setStatus(paused ? "Paused · ROS remains connected" : "Resumed · waiting for messages", paused ? "warn" : "idle");
        } else if (action === "clear") clearSamples();
        else if (action === "export") exportCsv();
      });

      settings.addEventListener("submit", (event) => {
        event.preventDefault();
        applyPlotSettings();
      });
      root.addEventListener("change", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
        const toggleId = target.dataset.seriesToggle;
        if (toggleId && target instanceof HTMLInputElement) {
          updateSeries(toggleId, (series) => ({ ...series, enabled: target.checked }), { reconcile: true });
          return;
        }
        const labelId = target.dataset.seriesLabel;
        if (labelId) {
          updateSeries(labelId, (series) => ({ ...series, label: target.value.trim().slice(0, 80) }), { renderControls: false });
          return;
        }
        const unitId = target.dataset.seriesUnit;
        if (unitId) {
          updateSeries(unitId, (series) => ({ ...series, unit: target.value.trim().slice(0, 24) }), { renderControls: false });
          return;
        }
        const filterId = target.dataset.seriesFilter;
        if (filterId) {
          const type = target.value;
          setSeriesFilter(filterId, type === "movingAverage" ? { type, window: 10 } : type === "ema" ? { type, alpha: 0.2 } : { type: "raw" });
          return;
        }
        const parameterId = target.dataset.seriesFilterParameter;
        if (parameterId && target instanceof HTMLInputElement) {
          const series = config.series.find((item) => item.id === parameterId);
          if (series?.filter.type === "movingAverage") {
            setSeriesFilter(parameterId, { type: "movingAverage", window: Math.min(500, Math.max(2, Math.round(target.valueAsNumber || 10))) }, false);
          } else if (series?.filter.type === "ema") {
            setSeriesFilter(parameterId, { type: "ema", alpha: Math.min(1, Math.max(0.01, target.valueAsNumber || 0.2)) }, false);
          }
          return;
        }
        if (target.matches('[data-field="fieldPicker"]') && target.value) {
          try {
            const selection = JSON.parse(target.value) as { key: string; field: string };
            const source = uniqueSources().find((item) => item.key === selection.key);
            if (source) addSeries(source.topic, source.messageType, selection.field);
          } catch {
            setStatus("Unable to add the selected field", "warn");
          }
          target.value = "";
          return;
        }
        if (target.matches('[data-field="autoScale"]') && target instanceof HTMLInputElement) {
          query<HTMLInputElement>('[data-field="minY"]').disabled = target.checked;
          query<HTMLInputElement>('[data-field="maxY"]').disabled = target.checked;
        }
      });

      viewportUnsubscribe = context.viewport.subscribe(() => scheduleRender(true));
      connectionUnsubscribe = context.connection.subscribe((snapshot: RoboBoyPanelConnectionSnapshot) => {
        const generationChanged = snapshot.generation !== lastConnectionGeneration;
        connection = snapshot;
        if (generationChanged) {
          lastConnectionGeneration = snapshot.generation;
          discoveredFields.clear();
        }
        reconcileSubscriptions(generationChanged && snapshot.status === "connected");
        renderSeriesControls();
      });
      if (!storedConfig || (storedConfig as { schemaVersion?: unknown }).schemaVersion !== 3) persistConfig();
      reconcileSubscriptions();
      scheduleRender(true);
    },
    setActive(isActive) {
      active = isActive;
      root?.toggleAttribute("data-inactive", !isActive);
      if (!isActive) {
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
        if (renderTimer !== null) window.clearTimeout(renderTimer);
        animationFrame = null;
        renderTimer = null;
      }
      reconcileSubscriptions();
      if (isActive) scheduleRender(true);
    },
    unmount() {
      subscriptions?.dispose();
      subscriptions = null;
      viewportUnsubscribe?.();
      connectionUnsubscribe?.();
      viewportUnsubscribe = null;
      connectionUnsubscribe = null;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (renderTimer !== null) window.clearTimeout(renderTimer);
      animationFrame = null;
      renderTimer = null;
      root?.remove();
      root = null;
      canvas = null;
      settings = null;
      buffers.clear();
      filters.clear();
      discoveredFields.clear();
      expandedSeries.clear();
    },
  };
};

const definition: RoboBoyPanelDefinition = {
  apiVersion: "2.0.0",
  id: PANEL_ID,
  activate: createPanelInstance,
};

export default definition;
