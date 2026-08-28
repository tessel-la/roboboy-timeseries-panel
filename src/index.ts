import type {
  RoboBoyJsonObject,
  RoboBoyPanelContext,
  RoboBoyPanelDefinition,
  RoboBoyPanelInstance,
} from "@tessel-la/roboboy-panel-sdk";
import ROSLIB from "roslib";
import {
  createCsv,
  discoverNumericFields,
  getNumericValueAtPath,
  getPlotRange,
  parseFieldPaths,
  trimSamples,
  type TimeseriesSample,
} from "./data";

interface TimeseriesConfig {
  topic: string;
  messageType: string;
  fieldPaths: string[];
  timeWindowSec: number;
  sampleLimit: number;
  throttleMs: number;
  autoScale: boolean;
  minY: number;
  maxY: number;
  showPoints: boolean;
}

interface TopicListResponse {
  topics?: string[];
  types?: string[];
}

const PANEL_ID = "la.tessel.roboboy.timeseries";
const COLORS = [
  "#57d68d",
  "#5ca9ff",
  "#ffb454",
  "#ff7597",
  "#bd93f9",
  "#35d0ba",
  "#f9e264",
  "#8be9fd",
];
const DEFAULT_CONFIG: TimeseriesConfig = {
  topic: "",
  messageType: "",
  fieldPaths: ["data"],
  timeWindowSec: 15,
  sampleLimit: 1200,
  throttleMs: 33,
  autoScale: true,
  minY: -1,
  maxY: 1,
  showPoints: false,
};
const CUSTOM_TOPIC_VALUE = "__custom_topic__";
const AUTO_FIELDS_VALUE = "__auto_fields__";

const clamp = (
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric)
    ? Math.min(max, Math.max(min, numeric))
    : fallback;
};

const sanitizeConfig = (value: unknown): TimeseriesConfig => {
  const candidate =
    value && typeof value === "object"
      ? (value as Partial<TimeseriesConfig>)
      : {};
  return {
    topic:
      typeof candidate.topic === "string"
        ? candidate.topic.trim()
        : DEFAULT_CONFIG.topic,
    messageType:
      typeof candidate.messageType === "string"
        ? candidate.messageType.trim()
        : DEFAULT_CONFIG.messageType,
    fieldPaths: Array.isArray(candidate.fieldPaths)
      ? candidate.fieldPaths
          .filter(
            (path): path is string =>
              typeof path === "string" && Boolean(path.trim()),
          )
          .slice(0, 8)
      : DEFAULT_CONFIG.fieldPaths,
    timeWindowSec: clamp(
      candidate.timeWindowSec,
      DEFAULT_CONFIG.timeWindowSec,
      1,
      600,
    ),
    sampleLimit: Math.round(
      clamp(candidate.sampleLimit, DEFAULT_CONFIG.sampleLimit, 100, 10000),
    ),
    throttleMs: Math.round(
      clamp(candidate.throttleMs, DEFAULT_CONFIG.throttleMs, 0, 2000),
    ),
    autoScale: candidate.autoScale !== false,
    minY: clamp(candidate.minY, DEFAULT_CONFIG.minY, -1e12, 1e12),
    maxY: clamp(candidate.maxY, DEFAULT_CONFIG.maxY, -1e12, 1e12),
    showPoints: candidate.showPoints === true,
  };
};

const PANEL_MARKUP = `
  <style>
    .rb-timeseries { position: relative; height: 100%; min-height: 180px; box-sizing: border-box; display: grid; grid-template-rows: auto minmax(100px, 1fr) auto; gap: 10px; padding: 12px; color: var(--text-color, #eef3f8); background: var(--background-secondary, #171c24); font: 13px/1.35 system-ui, sans-serif; overflow: hidden; }
    .rb-timeseries[data-inactive] { opacity: .78; }
    .rb-timeseries * { box-sizing: border-box; }
    .rb-timeseries__toolbar, .rb-timeseries__actions, .rb-timeseries__status, .rb-timeseries__legend { display: flex; align-items: center; gap: 8px; }
    .rb-timeseries__toolbar { flex-wrap: wrap; }
    .rb-timeseries__title { margin: 0 auto 0 0; font-size: 15px; }
    .rb-timeseries button { border: 1px solid var(--border-color, #3d4654); border-radius: 6px; padding: 6px 10px; color: inherit; background: var(--card-bg, #242b36); cursor: pointer; font: inherit; }
    .rb-timeseries button:hover { border-color: var(--primary-color, #5ca9ff); }
    .rb-timeseries button:disabled { opacity: .45; cursor: default; }
    .rb-timeseries__dot { width: 8px; height: 8px; border-radius: 50%; background: #7b8795; box-shadow: 0 0 0 3px #7b879522; }
    .rb-timeseries__dot[data-tone="live"] { background: #57d68d; box-shadow: 0 0 0 3px #57d68d22; }
    .rb-timeseries__dot[data-tone="warn"] { background: #ffb454; box-shadow: 0 0 0 3px #ffb45422; }
    .rb-timeseries__settings { position: absolute; z-index: 10; top: 52px; right: 8px; bottom: 8px; width: min(720px, calc(100% - 16px)); display: flex; flex-direction: column; gap: 12px; padding: 12px; border: 1px solid var(--border-color, #343d49); border-radius: 10px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; box-shadow: 0 12px 32px #0008; background: var(--card-bg, #242b36); background: color-mix(in srgb, var(--card-bg, #242b36) 96%, transparent); }
    .rb-timeseries__settings[hidden] { display: none; }
    .rb-timeseries__settings-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .rb-timeseries__settings-header h3 { margin: 0; font-size: 15px; }
    .rb-timeseries__settings-header button { padding: 4px 8px; }
    .rb-timeseries__source-grid, .rb-timeseries__advanced-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .rb-timeseries label { display: grid; gap: 4px; color: var(--text-secondary, #aeb8c4); min-width: 0; }
    .rb-timeseries label.wide, .rb-timeseries__fields, .rb-timeseries__manual-source { grid-column: 1 / -1; }
    .rb-timeseries input, .rb-timeseries select { width: 100%; min-width: 0; border: 1px solid var(--border-color, #414b59); border-radius: 5px; padding: 6px 7px; color: var(--text-color, #eef3f8); background: var(--background-primary, #11161d); font: inherit; }
    .rb-timeseries__input-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
    .rb-timeseries__input-row button { white-space: nowrap; }
    .rb-timeseries__selected-fields { min-height: 32px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 6px; }
    .rb-timeseries__field-chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-color, #414b59); border-radius: 999px; padding: 3px 7px; color: var(--text-color, #eef3f8); background: #ffffff0a; }
    .rb-timeseries__field-chip button { border: 0; padding: 0 2px; color: var(--text-secondary, #aeb8c4); background: transparent; font-size: 16px; line-height: 1; }
    .rb-timeseries__helper { margin: 4px 0 0; color: var(--text-secondary, #8f9aa8); font-size: 12px; }
    .rb-timeseries__advanced { border: 1px solid var(--border-color, #343d49); border-radius: 8px; }
    .rb-timeseries__advanced summary { padding: 9px 10px; cursor: pointer; font-weight: 600; }
    .rb-timeseries__advanced-grid { padding: 2px 10px 10px; }
    .rb-timeseries__check { display: flex !important; grid-auto-flow: column; justify-content: start; align-content: end; align-items: center; padding-bottom: 6px; }
    .rb-timeseries__check input { width: auto; }
    .rb-timeseries__settings-actions { position: sticky; bottom: -12px; display: flex; justify-content: flex-start; gap: 8px; margin-top: auto; padding: 10px 0 2px; background: var(--card-bg, #242b36); }
    .rb-timeseries__settings-actions button { min-width: 92px; }
    .rb-timeseries__settings-actions button[type="submit"] { border-color: var(--primary-color, #5ca9ff); background: var(--primary-color, #347fc4); }
    .rb-timeseries__chart { min-height: 100px; position: relative; border: 1px solid var(--border-color, #343d49); border-radius: 8px; overflow: hidden; background: #10151c; }
    .rb-timeseries canvas { display: block; width: 100%; height: 100%; }
    .rb-timeseries__empty { position: absolute; inset: 0; display: grid; place-items: center; color: #8f9aa8; pointer-events: none; }
    .rb-timeseries__empty[hidden] { display: none; }
    .rb-timeseries__footer { min-width: 0; display: flex; align-items: center; gap: 10px; }
    .rb-timeseries__legend { min-width: 0; flex: 1; overflow-x: auto; scrollbar-width: thin; }
    .rb-timeseries__series { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; padding: 3px 6px; border-radius: 5px; background: #ffffff0a; }
    .rb-timeseries__series i { width: 8px; height: 8px; border-radius: 2px; flex: 0 0 auto; }
    .rb-timeseries__series strong { font-variant-numeric: tabular-nums; }
    .rb-timeseries__stats { white-space: nowrap; color: var(--text-secondary, #aeb8c4); font-variant-numeric: tabular-nums; }
    @media (max-width: 760px) {
      .rb-timeseries { min-height: 150px; padding: 8px; gap: 7px; }
      .rb-timeseries__title { width: 100%; }
      .rb-timeseries__settings { inset: 44px 6px 6px; width: auto; padding: 10px; -webkit-overflow-scrolling: touch; }
      .rb-timeseries__source-grid, .rb-timeseries__advanced-grid { grid-template-columns: minmax(0, 1fr); }
      .rb-timeseries label.wide, .rb-timeseries__fields, .rb-timeseries__manual-source { grid-column: auto; }
      .rb-timeseries__settings-actions { bottom: -10px; }
      .rb-timeseries__footer { align-items: flex-start; flex-direction: column; }
      .rb-timeseries__legend { width: 100%; }
    }
    @media (max-height: 420px) {
      .rb-timeseries__settings { top: 38px; }
      .rb-timeseries__toolbar { gap: 5px; }
      .rb-timeseries__toolbar button { padding: 4px 7px; }
      .rb-timeseries__footer { display: flex; flex-direction: row; align-items: center; }
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
      <div class="rb-timeseries__settings-header">
        <h3>Choose ROS data</h3>
        <button type="button" data-action="close-settings" aria-label="Close configuration">×</button>
      </div>
      <div class="rb-timeseries__source-grid">
        <label class="wide">Topic
          <span class="rb-timeseries__input-row">
            <select data-field="topic" aria-label="Topic"><option value="">Discovering topics…</option></select>
            <button type="button" data-action="refresh-topics" aria-label="Refresh ROS topics">Refresh</button>
          </span>
        </label>
        <div class="rb-timeseries__fields">
          <label>Data fields
            <select data-field="fieldPicker" aria-label="Data fields">
              <option value="">Add a numeric field…</option>
              <option value="__auto_fields__">Auto-detect from the next message</option>
            </select>
          </label>
          <input data-field="fieldPaths" type="hidden" />
          <div class="rb-timeseries__selected-fields" data-role="selected-fields"></div>
          <p class="rb-timeseries__helper" data-role="fields-help">Choose auto-detect to find numeric data in the first message.</p>
        </div>
      </div>
      <details class="rb-timeseries__advanced">
        <summary>Advanced plot settings</summary>
        <div class="rb-timeseries__advanced-grid">
          <label class="rb-timeseries__manual-source" data-role="manual-source" hidden>Custom topic path
            <input data-field="customTopic" placeholder="/joint_states" autocomplete="off" />
          </label>
          <label class="wide">Message type
            <input data-field="messageType" placeholder="sensor_msgs/msg/JointState" autocomplete="off" />
          </label>
          <label>Window (seconds)<input data-field="timeWindowSec" type="number" min="1" max="600" step="1" /></label>
          <label>Sample cap<input data-field="sampleLimit" type="number" min="100" max="10000" step="100" /></label>
          <label>Bridge throttle
            <select data-field="throttleMs">
              <option value="0">Every message</option><option value="16">60 Hz</option><option value="33">30 Hz</option>
              <option value="50">20 Hz</option><option value="100">10 Hz</option><option value="250">4 Hz</option><option value="500">2 Hz</option>
            </select>
          </label>
          <label class="rb-timeseries__check"><input data-field="autoScale" type="checkbox" />Auto Y range</label>
          <label>Y minimum<input data-field="minY" type="number" step="any" /></label>
          <label>Y maximum<input data-field="maxY" type="number" step="any" /></label>
          <label class="rb-timeseries__check"><input data-field="showPoints" type="checkbox" />Point markers</label>
          <label class="wide">Custom numeric field
            <span class="rb-timeseries__input-row">
              <input data-field="customField" placeholder="pose.position.x" autocomplete="off" />
              <button type="button" data-action="add-custom-field">Add field</button>
            </span>
          </label>
        </div>
      </details>
      <div class="rb-timeseries__settings-actions">
        <button type="submit">Apply</button>
        <button type="button" data-action="close-settings">Cancel</button>
      </div>
    </form>
    <div class="rb-timeseries__chart" data-role="chart"><canvas aria-label="ROS numeric time-series chart"></canvas><div class="rb-timeseries__empty" data-role="empty">Choose a topic and fields in Configure.</div></div>
    <footer class="rb-timeseries__footer"><div class="rb-timeseries__legend" data-role="legend"></div><span class="rb-timeseries__stats" data-role="stats">0 samples</span></footer>
  </section>
`;

const createPanelInstance = (
  context: RoboBoyPanelContext,
): RoboBoyPanelInstance => {
  let root: HTMLElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let settings: HTMLFormElement | null = null;
  let topic: ROSLIB.Topic | null = null;
  let viewportUnsubscribe: (() => void) | null = null;
  let connectionUnsubscribe: (() => void) | null = null;
  let animationFrame: number | null = null;
  let active = true;
  let paused = false;
  let awaitingFieldDetection = false;
  let receivedMessages = 0;
  let config = sanitizeConfig(
    context.storage?.get(
      "config",
      DEFAULT_CONFIG as unknown as RoboBoyJsonObject,
    ),
  );
  let draftFieldPaths = [...config.fieldPaths];
  let discoveredFields: string[] = [];
  let discoveredTopic = "";
  const samples = new Map<string, TimeseriesSample[]>();
  const topicTypes = new Map<string, string>();

  const query = <T extends Element>(selector: string): T => {
    const element = root?.querySelector<T>(selector);
    if (!element) throw new Error(`ROS Time Series is missing ${selector}.`);
    return element;
  };

  const setManualSourceVisibility = () => {
    if (!root) return;
    const isManual =
      query<HTMLSelectElement>('[data-field="topic"]').value ===
      CUSTOM_TOPIC_VALUE;
    query<HTMLElement>('[data-role="manual-source"]').hidden = !isManual;
  };

  const populateTopicSelect = (preferredValue?: string) => {
    if (!root) return;
    const select = query<HTMLSelectElement>('[data-field="topic"]');
    const selectedValue = preferredValue ?? select.value ?? config.topic;
    select.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = topicTypes.size
      ? "Select a ROS topic…"
      : "No discovered topics";
    select.append(placeholder);

    [...topicTypes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .forEach(([name, messageType]) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = messageType ? `${name} · ${messageType}` : name;
        select.append(option);
      });

    if (
      selectedValue &&
      selectedValue !== CUSTOM_TOPIC_VALUE &&
      !topicTypes.has(selectedValue)
    ) {
      const saved = document.createElement("option");
      saved.value = selectedValue;
      saved.textContent = `${selectedValue} · saved`;
      select.append(saved);
    }

    const custom = document.createElement("option");
    custom.value = CUSTOM_TOPIC_VALUE;
    custom.textContent = "Enter another topic…";
    select.append(custom);
    select.value = selectedValue || "";
    setManualSourceVisibility();
  };

  const renderFieldControls = () => {
    if (!root) return;
    const hidden = query<HTMLInputElement>('[data-field="fieldPaths"]');
    const picker = query<HTMLSelectElement>('[data-field="fieldPicker"]');
    const selected = query<HTMLElement>('[data-role="selected-fields"]');
    const helper = query<HTMLElement>('[data-role="fields-help"]');
    hidden.value = draftFieldPaths.join(", ");
    selected.replaceChildren();

    if (draftFieldPaths.length === 0) {
      const automatic = document.createElement("span");
      automatic.className = "rb-timeseries__helper";
      automatic.textContent = "Auto-detect is enabled";
      selected.append(automatic);
    } else {
      draftFieldPaths.forEach((path) => {
        const chip = document.createElement("span");
        chip.className = "rb-timeseries__field-chip";
        chip.append(document.createTextNode(path));
        const remove = document.createElement("button");
        remove.type = "button";
        remove.dataset.removeField = path;
        remove.setAttribute("aria-label", `Remove ${path}`);
        remove.textContent = "×";
        chip.append(remove);
        selected.append(chip);
      });
    }

    picker.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Add a numeric field…";
    picker.append(placeholder);
    const automatic = document.createElement("option");
    automatic.value = AUTO_FIELDS_VALUE;
    automatic.textContent = "Auto-detect from the next message";
    picker.append(automatic);
    discoveredFields
      .filter((path) => !draftFieldPaths.includes(path))
      .sort((left, right) => left.localeCompare(right))
      .forEach((path) => {
        const option = document.createElement("option");
        option.value = path;
        option.textContent = path;
        picker.append(option);
      });
    picker.value = "";
    helper.textContent = discoveredFields.length
      ? `${discoveredFields.length} numeric field${discoveredFields.length === 1 ? "" : "s"} available from the latest message.`
      : "Apply with auto-detect to find numeric data in the first message.";
  };

  const addDraftField = (path: string) => {
    const normalized = parseFieldPaths(path, 1)[0];
    if (!normalized || draftFieldPaths.includes(normalized)) return;
    draftFieldPaths = [...draftFieldPaths, normalized].slice(0, 8);
    renderFieldControls();
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
    if (!root) return;
    query<HTMLElement>('[data-role="status"]').textContent = message;
    query<HTMLElement>(".rb-timeseries__dot").dataset.tone = tone;
  };

  const totalSamples = () =>
    [...samples.values()].reduce((total, series) => total + series.length, 0);

  const scheduleRender = () => {
    if (!root || !active || animationFrame !== null) return;
    animationFrame = requestAnimationFrame(() => {
      animationFrame = null;
      renderChart();
    });
  };

  const renderLegend = () => {
    if (!root) return;
    const legend = query<HTMLElement>('[data-role="legend"]');
    legend.replaceChildren();
    config.fieldPaths.forEach((path, index) => {
      const series = samples.get(path) ?? [];
      const item = document.createElement("span");
      item.className = "rb-timeseries__series";
      const swatch = document.createElement("i");
      swatch.style.backgroundColor = COLORS[index % COLORS.length];
      const label = document.createElement("span");
      label.textContent = path;
      const latest = document.createElement("strong");
      latest.textContent = series.length
        ? series[series.length - 1].value.toPrecision(6)
        : "—";
      item.append(swatch, label, latest);
      legend.append(item);
    });
    const sampleCount = totalSamples();
    query<HTMLElement>('[data-role="stats"]').textContent =
      `${sampleCount.toLocaleString()} sample${sampleCount === 1 ? "" : "s"}`;
    query<HTMLButtonElement>('[data-action="export"]').disabled =
      totalSamples() === 0;
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

    const visibleSamples = config.fieldPaths.flatMap(
      (path) => samples.get(path) ?? [],
    );
    const empty = query<HTMLElement>('[data-role="empty"]');
    empty.hidden = visibleSamples.length > 0;
    if (visibleSamples.length === 0) {
      renderLegend();
      return;
    }

    const padding = { left: 58, right: 18, top: 18, bottom: 32 };
    const chartWidth = Math.max(1, width - padding.left - padding.right);
    const chartHeight = Math.max(1, height - padding.top - padding.bottom);
    const range = getPlotRange(
      visibleSamples,
      config.autoScale,
      config.minY,
      config.maxY,
    );
    const newestTime = Math.max(...visibleSamples.map((sample) => sample.time));
    const oldestTime = newestTime - config.timeWindowSec * 1000;
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
      drawing.fillText(
        Number(value.toPrecision(4)).toString(),
        padding.left - 8,
        y,
      );
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
      drawing.fillText(
        `${(-config.timeWindowSec + ratio * config.timeWindowSec).toFixed(0)}s`,
        x,
        height - 13,
      );
    }

    config.fieldPaths.forEach((path, seriesIndex) => {
      const series = (samples.get(path) ?? []).filter(
        (sample) => sample.time >= oldestTime,
      );
      if (series.length === 0) return;
      drawing.strokeStyle = COLORS[seriesIndex % COLORS.length];
      drawing.fillStyle = COLORS[seriesIndex % COLORS.length];
      drawing.lineWidth = 1.7;
      drawing.lineJoin = "round";
      drawing.beginPath();
      series.forEach((sample, index) => {
        const x =
          padding.left +
          ((sample.time - oldestTime) / (config.timeWindowSec * 1000)) *
            chartWidth;
        const y =
          padding.top +
          (1 - (sample.value - range.min) / valueSpan) * chartHeight;
        if (index === 0) drawing.moveTo(x, y);
        else drawing.lineTo(x, y);
      });
      drawing.stroke();
      if (config.showPoints) {
        series.forEach((sample) => {
          const x =
            padding.left +
            ((sample.time - oldestTime) / (config.timeWindowSec * 1000)) *
              chartWidth;
          const y =
            padding.top +
            (1 - (sample.value - range.min) / valueSpan) * chartHeight;
          drawing.beginPath();
          drawing.arc(x, y, 2.2, 0, Math.PI * 2);
          drawing.fill();
        });
      }
    });
    renderLegend();
  };

  const clearSamples = () => {
    samples.clear();
    config.fieldPaths.forEach((path) => samples.set(path, []));
    receivedMessages = 0;
    scheduleRender();
  };

  const unsubscribeTopic = () => {
    if (!topic) return;
    try {
      topic.unsubscribe();
    } catch (error) {
      context.logger.warn("ROS topic cleanup failed.", error);
    }
    topic = null;
  };

  const onMessage = (message: unknown) => {
    if (!active || paused) return;
    if (discoveredTopic !== config.topic || discoveredFields.length === 0) {
      discoveredFields = discoverNumericFields(message, { maxFields: 8 });
      discoveredTopic = config.topic;
      renderFieldControls();
    }
    if (awaitingFieldDetection) {
      if (discoveredFields.length === 0) {
        setStatus("No numeric fields detected", "warn");
        return;
      }
      config = { ...config, fieldPaths: discoveredFields };
      draftFieldPaths = [...discoveredFields];
      awaitingFieldDetection = false;
      persistConfig();
      renderFieldControls();
      clearSamples();
    }

    const now = Date.now();
    let captured = 0;
    config.fieldPaths.forEach((path) => {
      const value = getNumericValueAtPath(message, path);
      if (value === null) return;
      const next = [...(samples.get(path) ?? []), { time: now, value }];
      samples.set(
        path,
        trimSamples(next, now, config.timeWindowSec, config.sampleLimit),
      );
      captured += 1;
    });
    receivedMessages += 1;
    if (captured === 0) {
      if (receivedMessages % 30 === 1)
        setStatus(
          "Configured fields are not numeric in received messages",
          "warn",
        );
      return;
    }
    setStatus(`Live · ${config.topic}`, "live");
    scheduleRender();
  };

  const configureSubscription = () => {
    unsubscribeTopic();
    clearSamples();
    awaitingFieldDetection = config.fieldPaths.length === 0;
    const pauseButton = query<HTMLButtonElement>('[data-action="pause"]');
    pauseButton.disabled = !config.topic || !context.ros;
    if (!context.ros) {
      setStatus("ROS is unavailable", "warn");
      return;
    }
    if (!config.topic) {
      setStatus("Choose a topic in Configure");
      return;
    }
    if (!config.messageType) {
      setStatus("Enter the ROS message type", "warn");
      return;
    }

    topic = new ROSLIB.Topic({
      ros: context.ros,
      name: config.topic,
      messageType: config.messageType,
      queue_length: 1,
      throttle_rate: config.throttleMs,
    });
    topic.subscribe(onMessage as (message: ROSLIB.Message) => void);
    setStatus(
      awaitingFieldDetection
        ? "Waiting to detect numeric fields…"
        : "Waiting for messages…",
    );
  };

  const populateConfigInputs = () => {
    if (!root) return;
    draftFieldPaths = [...config.fieldPaths];
    populateTopicSelect(config.topic);
    query<HTMLInputElement>('[data-field="customTopic"]').value = config.topic;
    query<HTMLInputElement>('[data-field="messageType"]').value =
      config.messageType;
    renderFieldControls();
    query<HTMLInputElement>('[data-field="timeWindowSec"]').value = String(
      config.timeWindowSec,
    );
    query<HTMLInputElement>('[data-field="sampleLimit"]').value = String(
      config.sampleLimit,
    );
    query<HTMLSelectElement>('[data-field="throttleMs"]').value = String(
      config.throttleMs,
    );
    query<HTMLInputElement>('[data-field="autoScale"]').checked =
      config.autoScale;
    query<HTMLInputElement>('[data-field="minY"]').value = String(config.minY);
    query<HTMLInputElement>('[data-field="maxY"]').value = String(config.maxY);
    query<HTMLInputElement>('[data-field="showPoints"]').checked =
      config.showPoints;
    query<HTMLInputElement>('[data-field="minY"]').disabled = config.autoScale;
    query<HTMLInputElement>('[data-field="maxY"]').disabled = config.autoScale;
  };

  const readConfigInputs = (): TimeseriesConfig => {
    const selectedTopic = query<HTMLSelectElement>(
      '[data-field="topic"]',
    ).value;
    return sanitizeConfig({
      topic:
        selectedTopic === CUSTOM_TOPIC_VALUE
          ? query<HTMLInputElement>('[data-field="customTopic"]').value
          : selectedTopic,
      messageType: query<HTMLInputElement>('[data-field="messageType"]').value,
      fieldPaths: parseFieldPaths(
        query<HTMLInputElement>('[data-field="fieldPaths"]').value,
      ),
      timeWindowSec: query<HTMLInputElement>('[data-field="timeWindowSec"]')
        .valueAsNumber,
      sampleLimit: query<HTMLInputElement>('[data-field="sampleLimit"]')
        .valueAsNumber,
      throttleMs: Number(
        query<HTMLSelectElement>('[data-field="throttleMs"]').value,
      ),
      autoScale: query<HTMLInputElement>('[data-field="autoScale"]').checked,
      minY: query<HTMLInputElement>('[data-field="minY"]').valueAsNumber,
      maxY: query<HTMLInputElement>('[data-field="maxY"]').valueAsNumber,
      showPoints: query<HTMLInputElement>('[data-field="showPoints"]').checked,
    });
  };

  const refreshTopics = () => {
    if (!context.ros) {
      setStatus("Connect ROS before refreshing topics", "warn");
      return;
    }
    setStatus("Discovering ROS topics…");
    const ros = context.ros as typeof context.ros & {
      getTopics(
        success: (response: TopicListResponse) => void,
        failure?: (error: unknown) => void,
      ): void;
    };
    ros.getTopics(
      (response) => {
        if (!root) return;
        const selectedTopic = query<HTMLSelectElement>(
          '[data-field="topic"]',
        ).value;
        topicTypes.clear();
        (response.topics ?? []).forEach((name, index) => {
          const messageType = response.types?.[index] ?? "";
          topicTypes.set(name, messageType);
        });
        populateTopicSelect(selectedTopic || config.topic);
        setStatus(
          `Discovered ${topicTypes.size} topics`,
          topicTypes.size ? "live" : "warn",
        );
      },
      (error) => {
        if (!root) return;
        context.logger.warn("ROS topic discovery failed.", error);
        populateTopicSelect(config.topic);
        setStatus("Topic discovery failed; use Enter another topic", "warn");
      },
    );
  };

  const exportCsv = () => {
    if (totalSamples() === 0) return;
    const blob = new Blob([createCsv(samples)], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `roboboy-timeseries-${new Date().toISOString().replace(/:/g, "-")}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const setSettingsOpen = (open: boolean) => {
    if (!settings || !root) return;
    if (open) populateConfigInputs();
    settings.hidden = !open;
    query<HTMLButtonElement>('[data-action="configure"]').setAttribute(
      "aria-expanded",
      String(open),
    );
    scheduleRender();
  };

  return {
    mount(container) {
      container.innerHTML = PANEL_MARKUP;
      root = container.querySelector<HTMLElement>(".rb-timeseries");
      if (!root)
        throw new Error("Unable to create the ROS Time Series panel root.");
      canvas = query<HTMLCanvasElement>("canvas");
      settings = query<HTMLFormElement>('[data-role="settings"]');
      populateConfigInputs();

      root.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const removeField = target?.closest<HTMLElement>("[data-remove-field]")
          ?.dataset.removeField;
        if (removeField) {
          draftFieldPaths = draftFieldPaths.filter(
            (path) => path !== removeField,
          );
          renderFieldControls();
          return;
        }
        const action =
          target?.closest<HTMLElement>("[data-action]")?.dataset.action;
        if (action === "configure") {
          setSettingsOpen(settings!.hidden);
        } else if (action === "close-settings") {
          setSettingsOpen(false);
        } else if (action === "refresh-topics") {
          refreshTopics();
        } else if (action === "add-custom-field") {
          const input = query<HTMLInputElement>('[data-field="customField"]');
          addDraftField(input.value);
          input.value = "";
        } else if (action === "pause") {
          paused = !paused;
          query<HTMLButtonElement>('[data-action="pause"]').textContent = paused
            ? "Resume"
            : "Pause";
          setStatus(
            paused ? "Paused" : `Live · ${config.topic}`,
            paused ? "warn" : "live",
          );
        } else if (action === "clear") {
          clearSamples();
        } else if (action === "export") {
          exportCsv();
        }
      });
      settings.addEventListener("submit", (event) => {
        event.preventDefault();
        config = readConfigInputs();
        persistConfig();
        paused = false;
        query<HTMLButtonElement>('[data-action="pause"]').textContent = "Pause";
        setSettingsOpen(false);
        configureSubscription();
      });
      query<HTMLInputElement>('[data-field="autoScale"]').addEventListener(
        "change",
        (event) => {
          const autoScale = (event.currentTarget as HTMLInputElement).checked;
          query<HTMLInputElement>('[data-field="minY"]').disabled = autoScale;
          query<HTMLInputElement>('[data-field="maxY"]').disabled = autoScale;
        },
      );
      query<HTMLSelectElement>('[data-field="topic"]').addEventListener(
        "change",
        (event) => {
          const selectedTopic = (event.currentTarget as HTMLSelectElement)
            .value;
          setManualSourceVisibility();
          if (selectedTopic === CUSTOM_TOPIC_VALUE) {
            query<HTMLDetailsElement>(".rb-timeseries__advanced").open = true;
            query<HTMLInputElement>('[data-field="customTopic"]').focus();
            return;
          }
          const detectedType = topicTypes.get(selectedTopic);
          if (detectedType)
            query<HTMLInputElement>('[data-field="messageType"]').value =
              detectedType;
          if (selectedTopic !== config.topic) {
            draftFieldPaths = [];
            discoveredFields = [];
            discoveredTopic = "";
            renderFieldControls();
          }
        },
      );
      query<HTMLSelectElement>('[data-field="fieldPicker"]').addEventListener(
        "change",
        (event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          if (value === AUTO_FIELDS_VALUE) {
            draftFieldPaths = [];
            renderFieldControls();
          } else if (value) {
            addDraftField(value);
          }
        },
      );

      viewportUnsubscribe = context.viewport.subscribe(() => scheduleRender());
      connectionUnsubscribe = context.connection.subscribe((snapshot) => {
        if (snapshot.status !== "connected")
          setStatus(
            `ROS ${snapshot.status}`,
            snapshot.status === "connecting" ? "warn" : "idle",
          );
      });
      configureSubscription();
      refreshTopics();
      scheduleRender();
    },
    setActive(isActive) {
      active = isActive;
      root?.toggleAttribute("data-inactive", !isActive);
      if (!isActive) {
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
        animationFrame = null;
        setStatus("Inactive · sampling paused");
      } else {
        setStatus(
          paused
            ? "Paused"
            : config.topic
              ? `Live · ${config.topic}`
              : "Choose a topic in Configure",
          paused ? "warn" : "idle",
        );
        scheduleRender();
      }
    },
    unmount() {
      unsubscribeTopic();
      viewportUnsubscribe?.();
      connectionUnsubscribe?.();
      viewportUnsubscribe = null;
      connectionUnsubscribe = null;
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      animationFrame = null;
      root?.remove();
      root = null;
      canvas = null;
      settings = null;
      samples.clear();
    },
  };
};

const definition: RoboBoyPanelDefinition = {
  apiVersion: "1.0.0",
  id: PANEL_ID,
  activate: createPanelInstance,
};

export default definition;
