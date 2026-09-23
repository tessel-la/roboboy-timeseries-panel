// src/data.ts
var FIELD_SEGMENT_PATTERN = /^([^\[\]]+)(?:\[(\d+)\])?$/;
var readPathSegment = (value, segment) => {
  const match = FIELD_SEGMENT_PATTERN.exec(segment);
  if (!match || value === null || typeof value !== "object") return void 0;
  const next = value[match[1]];
  if (match[2] === void 0) return next;
  return Array.isArray(next) ? next[Number(match[2])] : void 0;
};
var getNumericValueAtPath = (message, fieldPath) => {
  const value = fieldPath.split(".").reduce((current, segment) => {
    if (current === void 0 || current === null) return void 0;
    return readPathSegment(current, segment);
  }, message);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
var parseFieldPath = (value) => value.trim();
var discoverNumericFields = (message, options = {}) => {
  const maxDepth = options.maxDepth ?? 5;
  const maxArrayItems = options.maxArrayItems ?? 8;
  const maxFields = options.maxFields ?? 8;
  const fields = [];
  const ancestors = /* @__PURE__ */ new Set();
  const visit = (value, path, depth) => {
    if (fields.length >= maxFields || depth > maxDepth) return;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (path) fields.push(path);
      return;
    }
    if (!value || typeof value !== "object" || ancestors.has(value)) return;
    ancestors.add(value);
    if (Array.isArray(value)) {
      value.slice(0, maxArrayItems).forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    } else {
      Object.entries(value).forEach(([key, item]) => {
        visit(item, path ? `${path}.${key}` : key, depth + 1);
      });
    }
    ancestors.delete(value);
  };
  visit(message, "", 0);
  return fields;
};
var chooseAutoPlotFields = (fields, limit = 8) => {
  const telemetryFields = fields.filter((path) => !isRosTimestampField(path));
  return (telemetryFields.length ? telemetryFields : fields).slice(
    0,
    Math.max(0, limit)
  );
};
var isRosTimestampField = (path) => /(^|\.)stamp\.(sec|nanosec)$/.test(path);
var SampleBuffer = class {
  constructor(capacity) {
    this.start = 0;
    this.length = 0;
    this.capacity = Math.max(1, Math.floor(capacity));
    this.values = new Array(this.capacity);
  }
  get size() {
    return this.length;
  }
  clear() {
    this.values = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
  }
  push(sample, minimumTime = -Infinity) {
    if (this.length < this.capacity) {
      this.values[(this.start + this.length) % this.capacity] = sample;
      this.length += 1;
    } else {
      this.values[this.start] = sample;
      this.start = (this.start + 1) % this.capacity;
    }
    while (this.length > 0) {
      const oldest = this.values[this.start];
      if (!oldest || oldest.time >= minimumTime) break;
      this.values[this.start] = void 0;
      this.start = (this.start + 1) % this.capacity;
      this.length -= 1;
    }
  }
  latest() {
    if (this.length === 0) return void 0;
    return this.values[(this.start + this.length - 1) % this.capacity];
  }
  toArray(minimumTime = -Infinity) {
    const result = [];
    for (let index = 0; index < this.length; index += 1) {
      const sample = this.values[(this.start + index) % this.capacity];
      if (sample && sample.time >= minimumTime) result.push(sample);
    }
    return result;
  }
};
var RealtimeFilter = class {
  constructor(config) {
    this.config = config;
    this.movingValues = [];
    this.movingStart = 0;
    this.movingLength = 0;
    this.movingSum = 0;
    this.emaValue = null;
    if (config.type === "movingAverage") {
      this.movingValues = new Array(Math.max(1, Math.floor(config.window)));
    }
  }
  next(value) {
    if (this.config.type === "raw") return value;
    if (this.config.type === "ema") {
      this.emaValue = this.emaValue === null ? value : this.config.alpha * value + (1 - this.config.alpha) * this.emaValue;
      return this.emaValue;
    }
    const capacity = this.movingValues.length;
    if (this.movingLength < capacity) {
      this.movingValues[(this.movingStart + this.movingLength) % capacity] = value;
      this.movingLength += 1;
    } else {
      this.movingSum -= this.movingValues[this.movingStart] ?? 0;
      this.movingValues[this.movingStart] = value;
      this.movingStart = (this.movingStart + 1) % capacity;
    }
    this.movingSum += value;
    return this.movingSum / this.movingLength;
  }
};
var getPlotRange = (samples, autoScale, fixedMin = -1, fixedMax = 1) => {
  if (!autoScale) {
    const min2 = Math.min(fixedMin, fixedMax);
    const max2 = Math.max(fixedMin, fixedMax);
    return min2 === max2 ? { min: min2 - 1, max: max2 + 1 } : { min: min2, max: max2 };
  }
  if (samples.length === 0) return { min: -1, max: 1 };
  let min = Infinity;
  let max = -Infinity;
  samples.forEach(({ value }) => {
    min = Math.min(min, value);
    max = Math.max(max, value);
  });
  if (min === max) {
    const padding2 = Math.max(Math.abs(min) * 0.1, 1);
    return { min: min - padding2, max: max + padding2 };
  }
  const padding = (max - min) * 0.08;
  return { min: min - padding, max: max + padding };
};
var decimateSamples = (samples, maxPoints) => {
  const limit = Math.max(4, Math.floor(maxPoints));
  if (samples.length <= limit) return [...samples];
  const result = [samples[0]];
  const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
  const interiorLength = samples.length - 2;
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const from = 1 + Math.floor(bucket * interiorLength / bucketCount);
    const to = 1 + Math.floor((bucket + 1) * interiorLength / bucketCount);
    let min = samples[from];
    let max = samples[from];
    for (let index = from + 1; index < Math.max(from + 1, to); index += 1) {
      if (samples[index].value < min.value) min = samples[index];
      if (samples[index].value > max.value) max = samples[index];
    }
    if (min.time <= max.time) result.push(min, max);
    else result.push(max, min);
  }
  result.push(samples[samples.length - 1]);
  return result;
};
var createCsv = (series) => {
  const rows = ["timestamp_iso,elapsed_seconds,series,value"];
  const allSamples = [...series.values()].flatMap((samples) => samples);
  const firstTime = allSamples.length ? Math.min(...allSamples.map((sample) => sample.time)) : Date.now();
  [...series.entries()].flatMap(([name, samples]) => samples.map((sample) => ({ name, ...sample }))).sort((left, right) => left.time - right.time).forEach((sample) => {
    const escapedName = `"${sample.name.replace(/"/g, '""')}"`;
    rows.push(
      `${new Date(sample.time).toISOString()},${((sample.time - firstTime) / 1e3).toFixed(6)},${escapedName},${sample.value}`
    );
  });
  return `${rows.join("\n")}
`;
};

// src/config.ts
var SERIES_LIMIT = 16;
var AUTO_PLOT_FIELD_LIMIT = 8;
var COLORS = [
  "#57d68d",
  "#5ca9ff",
  "#ffb454",
  "#ff7597",
  "#bd93f9",
  "#35d0ba",
  "#f9e264",
  "#8be9fd",
  "#ff8f5c",
  "#7ee787",
  "#d2a8ff",
  "#79c0ff",
  "#ffa657",
  "#a5d6ff",
  "#f2cc60",
  "#db6dbe"
];
var DEFAULT_CONFIG = {
  schemaVersion: 3,
  series: [],
  timeWindowSec: 15,
  sampleLimit: 1200,
  throttleMs: 33,
  renderFps: 20,
  autoScale: true,
  minY: -1,
  maxY: 1,
  showPoints: false
};
var clamp = (value, fallback, min, max) => {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
};
var hash = (value) => {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
};
var sourceKey = (topic, messageType) => `${topic}\0${messageType}`;
var createSeriesId = (topic, fieldPath, used) => {
  const base = `series-${hash(`${topic}\0${fieldPath}`)}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
};
var sanitizeFilter = (value) => {
  const candidate = value && typeof value === "object" ? value : {};
  if (candidate.type === "movingAverage") {
    return {
      type: "movingAverage",
      window: Math.round(clamp(candidate.window, 10, 2, 500))
    };
  }
  if (candidate.type === "ema") {
    return { type: "ema", alpha: clamp(candidate.alpha, 0.2, 0.01, 1) };
  }
  return { type: "raw" };
};
var sanitizeSeries = (value, index, usedIds) => {
  if (!value || typeof value !== "object") return null;
  const candidate = value;
  const topic = typeof candidate.topic === "string" ? candidate.topic.trim() : "";
  const messageType = typeof candidate.messageType === "string" ? candidate.messageType.trim() : "";
  const fieldPath = typeof candidate.fieldPath === "string" ? candidate.fieldPath.trim() : "";
  if (!topic || !messageType) return null;
  const requestedId = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const id = requestedId && !usedIds.has(requestedId) ? requestedId : createSeriesId(topic, fieldPath || `pending-${index}`, usedIds);
  usedIds.add(id);
  return {
    id,
    topic,
    messageType,
    fieldPath,
    enabled: candidate.enabled !== false,
    label: typeof candidate.label === "string" ? candidate.label.trim().slice(0, 80) : "",
    unit: typeof candidate.unit === "string" ? candidate.unit.trim().slice(0, 24) : "",
    color: typeof candidate.color === "string" && /^#[0-9a-f]{6}$/i.test(candidate.color) ? candidate.color : COLORS[index % COLORS.length],
    filter: sanitizeFilter(candidate.filter)
  };
};
var migrateLegacySeries = (candidate) => {
  const topic = typeof candidate.topic === "string" ? candidate.topic.trim() : "";
  const messageType = typeof candidate.messageType === "string" ? candidate.messageType.trim() : "";
  if (!topic || !messageType) return [];
  const fields = Array.isArray(candidate.fieldPaths) ? [...new Set(candidate.fieldPaths.filter((path) => typeof path === "string").map((path) => path.trim()).filter(Boolean))] : [];
  const shouldDropLegacyTimestamps = candidate.schemaVersion !== 2 && fields.some(isRosTimestampField) && fields.some((path) => !isRosTimestampField(path));
  const normalizedFields = shouldDropLegacyTimestamps ? chooseAutoPlotFields(fields, AUTO_PLOT_FIELD_LIMIT) : fields.slice(0, AUTO_PLOT_FIELD_LIMIT);
  const paths = normalizedFields.length ? normalizedFields : [""];
  const used = /* @__PURE__ */ new Set();
  return paths.map((fieldPath, index) => {
    const id = createSeriesId(topic, fieldPath || "pending", used);
    used.add(id);
    return {
      id,
      topic,
      messageType,
      fieldPath,
      enabled: true,
      label: "",
      unit: "",
      color: COLORS[index % COLORS.length],
      filter: { type: "raw" }
    };
  });
};
var sanitizeConfig = (value) => {
  const candidate = value && typeof value === "object" ? value : {};
  const usedIds = /* @__PURE__ */ new Set();
  const series = candidate.schemaVersion === 3 && Array.isArray(candidate.series) ? candidate.series.map((item, index) => sanitizeSeries(item, index, usedIds)).filter((item) => item !== null).slice(0, SERIES_LIMIT) : migrateLegacySeries(candidate);
  return {
    schemaVersion: 3,
    series,
    timeWindowSec: clamp(candidate.timeWindowSec, DEFAULT_CONFIG.timeWindowSec, 1, 600),
    sampleLimit: Math.round(clamp(candidate.sampleLimit, DEFAULT_CONFIG.sampleLimit, 100, 1e4)),
    throttleMs: Math.round(clamp(candidate.throttleMs, DEFAULT_CONFIG.throttleMs, 0, 2e3)),
    renderFps: Math.round(clamp(candidate.renderFps, DEFAULT_CONFIG.renderFps, 5, 60)),
    autoScale: candidate.autoScale !== false,
    minY: clamp(candidate.minY, DEFAULT_CONFIG.minY, -1e12, 1e12),
    maxY: clamp(candidate.maxY, DEFAULT_CONFIG.maxY, -1e12, 1e12),
    showPoints: candidate.showPoints === true
  };
};
var getDesiredSources = (config) => {
  const sources = /* @__PURE__ */ new Map();
  config.series.filter((series) => series.enabled).forEach((series) => {
    const key = sourceKey(series.topic, series.messageType);
    sources.set(key, {
      key,
      topic: series.topic,
      messageType: series.messageType,
      throttleMs: config.throttleMs
    });
  });
  return [...sources.values()];
};
var displayName = (series) => {
  if (series.label) return series.label;
  if (!series.fieldPath) return `${series.topic} \xB7 detecting fields\u2026`;
  return `${series.topic} \xB7 ${series.fieldPath}`;
};

// src/subscriptions.ts
var sameSource = (left, right) => left.key === right.key && left.topic === right.topic && left.messageType === right.messageType && left.throttleMs === right.throttleMs;
var SubscriptionController = class {
  constructor(subscribe, onMessage, onError, onChange = () => void 0) {
    this.subscribe = subscribe;
    this.onMessage = onMessage;
    this.onError = onError;
    this.onChange = onChange;
    this.entries = /* @__PURE__ */ new Map();
    this.nextToken = 0;
    this.disposed = false;
  }
  get size() {
    return this.entries.size;
  }
  reconcile(desired) {
    if (this.disposed) return;
    const next = new Map(desired.map((source) => [source.key, source]));
    [...this.entries.entries()].forEach(([key, entry]) => {
      const replacement = next.get(key);
      if (!replacement || !sameSource(entry.source, replacement)) this.remove(key);
    });
    desired.forEach((source) => {
      if (!this.entries.has(source.key)) this.add(source);
    });
    this.onChange();
  }
  restart(desired) {
    [...this.entries.keys()].forEach((key) => this.remove(key));
    this.reconcile(desired);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    [...this.entries.keys()].forEach((key) => this.remove(key));
  }
  add(source) {
    const token = ++this.nextToken;
    const entry = { source, token, subscription: null };
    this.entries.set(source.key, entry);
    void this.subscribe(source, (message) => {
      const current = this.entries.get(source.key);
      if (!this.disposed && current?.token === token) this.onMessage(source, message);
    }).then(
      (subscription) => {
        const current = this.entries.get(source.key);
        if (this.disposed || current?.token !== token) {
          this.release(source, subscription);
          return;
        }
        current.subscription = subscription;
        this.onChange();
      },
      (error) => {
        const current = this.entries.get(source.key);
        if (current?.token !== token) return;
        this.entries.delete(source.key);
        this.onError(source, error, "subscribe");
        this.onChange();
      }
    );
  }
  remove(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.token = ++this.nextToken;
    if (entry.subscription) this.release(entry.source, entry.subscription);
  }
  release(source, subscription) {
    void subscription.unsubscribe().catch((error) => {
      this.onError(source, error, "unsubscribe");
    });
  }
};

// src/index.ts
var PANEL_ID = "la.tessel.roboboy.timeseries";
var DISCOVERED_FIELD_LIMIT = 64;
var PANEL_MARKUP = `
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
    .rb-timeseries__settings { position: absolute; z-index: 10; top: 50px; right: 7px; bottom: 7px; width: min(760px, calc(100% - 14px)); display: flex; flex-direction: column; gap: 10px; padding: 11px; border: 1px solid var(--border-color, #343d49); border-radius: 10px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; box-shadow: 0 12px 32px #0008; background: var(--card-bg, #242b36); }
    .rb-timeseries__settings[hidden] { display: none; }
    .rb-timeseries__settings-header, .rb-timeseries__settings-actions, .rb-timeseries__add-row { display: flex; align-items: center; gap: 7px; }
    .rb-timeseries__settings-header { justify-content: space-between; }
    .rb-timeseries__settings-header h3 { margin: 0; font-size: 15px; }
    .rb-timeseries__settings-header button { padding: 4px 8px; }
    .rb-timeseries label { display: grid; gap: 4px; color: var(--text-secondary, #aeb8c4); min-width: 0; }
    .rb-timeseries input, .rb-timeseries select { width: 100%; min-width: 0; border: 1px solid var(--border-color, #414b59); border-radius: 7px; padding: 7px 8px; color: var(--text-color, #eef3f8); background: var(--background-color, #11161d); font: inherit; }
    .rb-timeseries input[type="checkbox"] { width: auto; }
    .rb-timeseries__add-row { flex-wrap: wrap; }
    .rb-timeseries__add-row select { flex: 1 1 220px; }
    .rb-timeseries__series-list { display: grid; gap: 6px; }
    .rb-timeseries__series-editor { border: 1px solid var(--border-color, #343d49); border-radius: 8px; background: #ffffff05; }
    .rb-timeseries__series-editor summary { display: flex; align-items: center; gap: 7px; min-width: 0; padding: 7px 8px; cursor: pointer; list-style: none; }
    .rb-timeseries__series-editor summary::-webkit-details-marker { display: none; }
    .rb-timeseries__series-editor summary::before { content: "\u203A"; color: var(--text-secondary, #aeb8c4); transition: transform .12s; }
    .rb-timeseries__series-editor[open] summary::before { transform: rotate(90deg); }
    .rb-timeseries__swatch { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 2px; }
    .rb-timeseries__series-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rb-timeseries__series-editor summary button { border: 0; padding: 1px 4px; color: var(--text-secondary, #aeb8c4); background: transparent; font-size: 17px; line-height: 1; }
    .rb-timeseries__series-fields, .rb-timeseries__advanced-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .rb-timeseries__series-fields { padding: 2px 9px 9px 30px; }
    .rb-timeseries__series-fields .wide { grid-column: 1 / -1; }
    .rb-timeseries__filter-row { display: grid; grid-template-columns: minmax(0, 1fr) 92px; gap: 6px; }
    .rb-timeseries__helper { margin: 0; color: var(--text-secondary, #8f9aa8); font-size: 12px; }
    .rb-timeseries__custom-row { display: grid; grid-template-columns: minmax(120px, .8fr) minmax(140px, 1fr) auto; gap: 6px; }
    .rb-timeseries__advanced { border: 1px solid var(--border-color, #343d49); border-radius: 8px; }
    .rb-timeseries__advanced summary { padding: 8px 9px; cursor: pointer; font-weight: 600; }
    .rb-timeseries__advanced-grid { padding: 2px 9px 9px; }
    .rb-timeseries__check { display: flex !important; justify-content: start; align-items: center; align-content: end; padding-bottom: 6px; }
    .rb-timeseries__settings-actions { position: sticky; bottom: -11px; margin-top: auto; padding: 9px 0 1px; background: var(--card-bg, #242b36); }
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
      .rb-timeseries__settings { inset: 43px 6px 6px; width: auto; padding: 9px; -webkit-overflow-scrolling: touch; }
      .rb-timeseries__series-fields, .rb-timeseries__advanced-grid { grid-template-columns: minmax(0, 1fr); }
      .rb-timeseries__series-fields .wide { grid-column: auto; }
      .rb-timeseries__custom-row { grid-template-columns: minmax(0, 1fr) auto; }
      .rb-timeseries__custom-row select { grid-column: 1 / -1; }
      .rb-timeseries__footer { align-items: flex-start; flex-direction: column; }
      .rb-timeseries__legend { width: 100%; }
    }
    @media (max-height: 420px) {
      .rb-timeseries__settings { top: 37px; }
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
      <div class="rb-timeseries__settings-header">
        <h3>Series</h3>
        <button type="button" data-action="close-settings" aria-label="Close configuration">\xD7</button>
      </div>
      <div class="rb-timeseries__add-row">
        <button type="button" data-action="choose-topic">Add ROS topic\u2026</button>
        <select data-field="fieldPicker" aria-label="Add detected numeric field"><option value="">Add detected field\u2026</option></select>
      </div>
      <div class="rb-timeseries__series-list" data-role="series-list"></div>
      <p class="rb-timeseries__helper" data-role="series-help">Choose a topic. Numeric fields are detected from its first live message.</p>
      <div class="rb-timeseries__custom-row">
        <select data-field="customSource" aria-label="Custom field topic"><option value="">Topic\u2026</option></select>
        <input data-field="customField" aria-label="Custom numeric field" placeholder="pose.position.x" autocomplete="off" />
        <button type="button" data-action="add-custom-field">Add field</button>
      </div>
      <details class="rb-timeseries__advanced">
        <summary>Plot settings</summary>
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
      <div class="rb-timeseries__settings-actions">
        <button type="button" data-action="apply-settings">Apply plot settings</button>
        <button type="button" data-action="close-settings">Done</button>
      </div>
    </form>
    <div class="rb-timeseries__chart" data-role="chart"><canvas aria-label="ROS numeric time-series chart"></canvas><div class="rb-timeseries__empty" data-role="empty">Add a ROS topic to begin.</div></div>
    <footer class="rb-timeseries__footer"><div class="rb-timeseries__legend" data-role="legend"></div><span class="rb-timeseries__stats" data-role="stats">0 samples</span></footer>
  </section>
`;
var createPanelInstance = (context) => {
  let root = null;
  let canvas = null;
  let settings = null;
  let viewportUnsubscribe = null;
  let connectionUnsubscribe = null;
  let subscriptions = null;
  let animationFrame = null;
  let renderTimer = null;
  let lastRenderAt = 0;
  let active = true;
  let paused = false;
  let statusText = "";
  let statusTone = "";
  let connection = context.connection.getSnapshot();
  let lastConnectionGeneration = connection.generation;
  const storedConfig = context.storage?.get(
    "config",
    DEFAULT_CONFIG
  );
  let config = sanitizeConfig(storedConfig);
  const buffers = /* @__PURE__ */ new Map();
  const filters = /* @__PURE__ */ new Map();
  const discoveredFields = /* @__PURE__ */ new Map();
  const query = (selector) => {
    const element = root?.querySelector(selector);
    if (!element) throw new Error(`ROS Time Series is missing ${selector}.`);
    return element;
  };
  const persistConfig = () => {
    try {
      context.storage?.set("config", config);
    } catch (error) {
      context.logger.warn("Unable to persist time-series settings.", error);
    }
  };
  const setStatus = (message, tone = "idle") => {
    if (!root || statusText === message && statusTone === tone) return;
    statusText = message;
    statusTone = tone;
    query('[data-role="status"]').textContent = message;
    query(".rb-timeseries__dot").dataset.tone = tone;
  };
  const ensureRuntime = (series, reset = false) => {
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
  const desiredSources = () => active && connection.status === "connected" ? getDesiredSources(config) : [];
  const updatePauseButton = () => {
    if (!root) return;
    const button = query('[data-action="pause"]');
    button.disabled = config.series.every((series) => !series.enabled) || !context.ros;
    button.textContent = paused ? "Resume" : "Pause";
  };
  const reconcileSubscriptions = (restart = false) => {
    updatePauseButton();
    const desired = desiredSources();
    if (restart) subscriptions?.restart(desired);
    else subscriptions?.reconcile(desired);
    if (!active) setStatus("Inactive \xB7 subscriptions released");
    else if (connection.status !== "connected") {
      setStatus(`ROS ${connection.status}`, connection.status === "connecting" ? "warn" : "idle");
    } else if (desired.length === 0) setStatus("Add or enable a series");
    else if (!paused) setStatus(`Waiting for ${desired.length} topic${desired.length === 1 ? "" : "s"}\u2026`);
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
    const interval = 1e3 / config.renderFps;
    const delay = Math.max(0, lastRenderAt + interval - performance.now());
    renderTimer = window.setTimeout(() => {
      renderTimer = null;
      requestFrame();
    }, delay);
  };
  const totalSamples = () => [...buffers.values()].reduce((total, buffer) => total + buffer.size, 0);
  const uniqueSources = () => {
    const sources = /* @__PURE__ */ new Map();
    config.series.forEach((series) => {
      const key = sourceKey(series.topic, series.messageType);
      sources.set(key, { key, topic: series.topic, messageType: series.messageType, throttleMs: config.throttleMs });
    });
    return [...sources.values()];
  };
  const updateSeries = (id, mutate, options = {}) => {
    config = {
      ...config,
      series: config.series.map((series) => series.id === id ? mutate(series) : series)
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
  const addSeries = (topic, messageType, fieldPath, preferred) => {
    if (config.series.length >= SERIES_LIMIT) {
      setStatus(`Series limit reached (${SERIES_LIMIT})`, "warn");
      return null;
    }
    if (config.series.some(
      (series2) => series2.topic === topic && series2.messageType === messageType && series2.fieldPath === fieldPath
    )) return null;
    const used = new Set(config.series.map((series2) => series2.id));
    const series = {
      id: createSeriesId(topic, fieldPath || "pending", used),
      topic,
      messageType,
      fieldPath,
      enabled: preferred?.enabled !== false,
      label: preferred?.label ?? "",
      unit: preferred?.unit ?? "",
      color: preferred?.color ?? COLORS[config.series.length % COLORS.length],
      filter: preferred?.filter ?? { type: "raw" }
    };
    config = { ...config, series: [...config.series, series] };
    ensureRuntime(series);
    persistConfig();
    renderSeriesControls();
    reconcileSubscriptions();
    scheduleRender(true);
    return series;
  };
  const removeSeries = (id) => {
    config = { ...config, series: config.series.filter((series) => series.id !== id) };
    buffers.delete(id);
    filters.delete(id);
    persistConfig();
    renderSeriesControls();
    reconcileSubscriptions();
    scheduleRender(true);
  };
  const renderSeriesControls = () => {
    if (!root) return;
    const list = query('[data-role="series-list"]');
    const openSeries = new Set(
      Array.from(list.querySelectorAll("details[open]")).map((details) => details.dataset.seriesId).filter((id) => Boolean(id))
    );
    list.replaceChildren();
    config.series.forEach((series) => {
      const details = document.createElement("details");
      details.className = "rb-timeseries__series-editor";
      details.dataset.seriesId = series.id;
      details.open = openSeries.has(series.id);
      const summary = document.createElement("summary");
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = series.enabled;
      enabled.dataset.seriesToggle = series.id;
      enabled.setAttribute("aria-label", `Show ${displayName(series)}`);
      enabled.addEventListener("click", (event) => event.stopPropagation());
      const swatch = document.createElement("i");
      swatch.className = "rb-timeseries__swatch";
      swatch.style.backgroundColor = series.color;
      const name = document.createElement("span");
      name.className = "rb-timeseries__series-name";
      name.textContent = `${displayName(series)}${series.unit ? ` (${series.unit})` : ""}`;
      name.title = `${series.topic} \xB7 ${series.messageType}${series.fieldPath ? ` \xB7 ${series.fieldPath}` : ""}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.action = "remove-series";
      remove.dataset.seriesId = series.id;
      remove.setAttribute("aria-label", `Remove ${displayName(series)}`);
      remove.textContent = "\xD7";
      summary.append(enabled, swatch, name, remove);
      details.append(summary);
      if (series.fieldPath) {
        const fields = document.createElement("div");
        fields.className = "rb-timeseries__series-fields";
        fields.append(
          createTextInput("Label", series.label, "seriesLabel", series.id, "Optional short name"),
          createTextInput("Unit", series.unit, "seriesUnit", series.id, "m/s, \xB0C, rad\u2026"),
          createFilterControl(series)
        );
        const source = document.createElement("p");
        source.className = "rb-timeseries__helper wide";
        source.textContent = `${series.topic} \xB7 ${series.fieldPath} \xB7 ${series.messageType}`;
        fields.append(source);
        details.append(fields);
      }
      list.append(details);
    });
    const picker = query('[data-field="fieldPicker"]');
    picker.replaceChildren(new Option("Add detected field\u2026", ""));
    uniqueSources().forEach((source) => {
      const available = (discoveredFields.get(source.key) ?? []).filter(
        (field) => !config.series.some((series) => series.topic === source.topic && series.messageType === source.messageType && series.fieldPath === field)
      );
      if (!available.length) return;
      const group = document.createElement("optgroup");
      group.label = source.topic;
      available.forEach((field) => group.append(new Option(field, JSON.stringify({ key: source.key, field }))));
      picker.append(group);
    });
    picker.disabled = config.series.length >= SERIES_LIMIT;
    const customSource = query('[data-field="customSource"]');
    const previousSource = customSource.value;
    customSource.replaceChildren(new Option("Topic\u2026", ""));
    uniqueSources().forEach((source) => customSource.append(new Option(source.topic, source.key)));
    customSource.value = Array.from(customSource.options).some((option) => option.value === previousSource) ? previousSource : customSource.options[1]?.value ?? "";
    const helper = query('[data-role="series-help"]');
    const pending = config.series.filter((series) => !series.fieldPath).length;
    helper.textContent = config.series.length === 0 ? "Choose a topic. Numeric fields are detected from its first live message." : `${config.series.length} of ${SERIES_LIMIT} series configured${pending ? ` \xB7 ${pending} awaiting field detection` : ""}. Series changes save immediately.`;
    updatePauseButton();
  };
  const createTextInput = (labelText, value, dataName, id, placeholder) => {
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
  const createFilterControl = (series) => {
    const label = document.createElement("label");
    label.className = "wide";
    label.append(document.createTextNode("Smoothing"));
    const row = document.createElement("span");
    row.className = "rb-timeseries__filter-row";
    const select = document.createElement("select");
    select.dataset.seriesFilter = series.id;
    select.append(
      new Option("Raw signal", "raw"),
      new Option("Moving average", "movingAverage"),
      new Option("Exponential average", "ema")
    );
    select.value = series.filter.type;
    row.append(select);
    if (series.filter.type !== "raw") {
      const parameter = document.createElement("input");
      parameter.type = "number";
      parameter.dataset.seriesFilterParameter = series.id;
      if (series.filter.type === "movingAverage") {
        parameter.value = String(series.filter.window);
        parameter.min = "2";
        parameter.max = "500";
        parameter.step = "1";
        parameter.title = "Sample window";
        parameter.setAttribute("aria-label", "Moving average sample window");
      } else {
        parameter.value = String(series.filter.alpha);
        parameter.min = "0.01";
        parameter.max = "1";
        parameter.step = "0.01";
        parameter.title = "EMA alpha";
        parameter.setAttribute("aria-label", "Exponential average alpha");
      }
      row.append(parameter);
    }
    label.append(row);
    return label;
  };
  const populatePlotInputs = () => {
    query('[data-field="timeWindowSec"]').value = String(config.timeWindowSec);
    query('[data-field="sampleLimit"]').value = String(config.sampleLimit);
    query('[data-field="throttleMs"]').value = String(config.throttleMs);
    query('[data-field="renderFps"]').value = String(config.renderFps);
    query('[data-field="autoScale"]').checked = config.autoScale;
    query('[data-field="showPoints"]').checked = config.showPoints;
    query('[data-field="minY"]').value = String(config.minY);
    query('[data-field="maxY"]').value = String(config.maxY);
    query('[data-field="minY"]').disabled = config.autoScale;
    query('[data-field="maxY"]').disabled = config.autoScale;
  };
  const readPlotInputs = () => sanitizeConfig({
    ...config,
    schemaVersion: 3,
    series: config.series,
    timeWindowSec: query('[data-field="timeWindowSec"]').valueAsNumber,
    sampleLimit: query('[data-field="sampleLimit"]').valueAsNumber,
    throttleMs: Number(query('[data-field="throttleMs"]').value),
    renderFps: Number(query('[data-field="renderFps"]').value),
    autoScale: query('[data-field="autoScale"]').checked,
    showPoints: query('[data-field="showPoints"]').checked,
    minY: query('[data-field="minY"]').valueAsNumber,
    maxY: query('[data-field="maxY"]').valueAsNumber
  });
  const chooseTopic = async () => {
    if (!context.ros || typeof context.ros.selectTopic !== "function") {
      setStatus("Connect ROS before choosing a topic", "warn");
      return;
    }
    setStatus("Waiting for topic approval\u2026");
    try {
      const selected = await context.ros.selectTopic();
      if (!root) return;
      const key = sourceKey(selected.name, selected.messageType);
      if (config.series.some((series) => sourceKey(series.topic, series.messageType) === key)) {
        reconcileSubscriptions();
        setStatus(`${selected.name} is already configured`, "warn");
        return;
      }
      addSeries(selected.name, selected.messageType, "");
      setStatus(`Waiting for ${selected.name} fields\u2026`);
    } catch (error) {
      if (!root) return;
      context.logger.info("ROS topic selection was not completed.", error);
      setStatus("Topic selection cancelled", "warn");
    }
  };
  const expandPendingSeries = (source, fields) => {
    const pending = config.series.find(
      (series) => series.fieldPath === "" && sourceKey(series.topic, series.messageType) === source.key
    );
    if (!pending) return;
    const remaining = SERIES_LIMIT - config.series.length + 1;
    const selected = chooseAutoPlotFields(fields, Math.min(AUTO_PLOT_FIELD_LIMIT, remaining));
    if (!selected.length) {
      setStatus(`No numeric fields found on ${source.topic}`, "warn");
      return;
    }
    const used = new Set(config.series.map((series) => series.id));
    const replacement = selected.map((fieldPath, index) => {
      const id = index === 0 ? pending.id : createSeriesId(source.topic, fieldPath, used);
      used.add(id);
      return {
        ...pending,
        id,
        fieldPath,
        color: COLORS[(config.series.indexOf(pending) + index) % COLORS.length]
      };
    });
    config = {
      ...config,
      series: config.series.flatMap((series) => series.id === pending.id ? replacement : [series])
    };
    buffers.delete(pending.id);
    filters.delete(pending.id);
    reconcileRuntime();
    persistConfig();
    renderSeriesControls();
  };
  const onSourceMessage = (source, message) => {
    if (!active) return;
    if (!discoveredFields.has(source.key)) {
      const fields = discoverNumericFields(message, {
        maxDepth: 8,
        maxArrayItems: DISCOVERED_FIELD_LIMIT,
        maxFields: DISCOVERED_FIELD_LIMIT
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
      const filtered = filters.get(series.id).next(value);
      if (!paused) {
        buffers.get(series.id).push(
          { time: now, value: filtered },
          now - config.timeWindowSec * 1e3
        );
      }
      captured += 1;
    });
    if (paused) setStatus("Paused \xB7 ROS remains connected", "warn");
    else if (captured > 0) {
      const count = getDesiredSources(config).length;
      setStatus(`Live \xB7 ${count} topic${count === 1 ? "" : "s"}`, "live");
      scheduleRender();
    }
  };
  const renderLegend = () => {
    if (!root) return;
    const legend = query('[data-role="legend"]');
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
      latest.textContent = sample ? `${Number(sample.value.toPrecision(6))}${series.unit ? ` ${series.unit}` : ""}` : "\u2014";
      item.append(swatch, label, latest);
      legend.append(item);
    });
    const count = totalSamples();
    const topicCount = uniqueSources().length;
    query('[data-role="stats"]').textContent = `${count.toLocaleString()} samples \xB7 ${topicCount} topic${topicCount === 1 ? "" : "s"}`;
    query('[data-action="export"]').disabled = count === 0;
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
    const empty = query('[data-role="empty"]');
    empty.hidden = visible.length > 0;
    if (!visible.length) {
      empty.textContent = config.series.length === 0 ? "Add a ROS topic to begin." : config.series.every((series) => !series.enabled) ? "All series are hidden. Use the legend or Configure to show one." : "Waiting for numeric ROS messages\u2026";
      renderLegend();
      return;
    }
    const latestTimes = visible.map((series) => buffers.get(series.id)?.latest()?.time ?? 0);
    const newestTime = Math.max(...latestTimes);
    const oldestTime = newestTime - config.timeWindowSec * 1e3;
    const rendered = /* @__PURE__ */ new Map();
    visible.forEach((series) => {
      rendered.set(series.id, buffers.get(series.id).toArray(oldestTime));
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
        const x = padding.left + (sample.time - oldestTime) / (config.timeWindowSec * 1e3) * chartWidth;
        const y = padding.top + (1 - (sample.value - range.min) / valueSpan) * chartHeight;
        if (index === 0) drawing.moveTo(x, y);
        else drawing.lineTo(x, y);
      });
      drawing.stroke();
      if (config.showPoints) {
        samples.forEach((sample) => {
          const x = padding.left + (sample.time - oldestTime) / (config.timeWindowSec * 1e3) * chartWidth;
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
    const data = /* @__PURE__ */ new Map();
    config.series.forEach((series) => {
      const samples = buffers.get(series.id)?.toArray() ?? [];
      if (!samples.length) return;
      data.set(`${displayName(series)}${series.unit ? ` [${series.unit}]` : ""} \xB7 ${series.topic}:${series.fieldPath}`, samples);
    });
    const blob = new Blob([createCsv(data)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `roboboy-timeseries-${(/* @__PURE__ */ new Date()).toISOString().replace(/:/g, "-")}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const setSettingsOpen = (open) => {
    if (!settings || !root) return;
    if (open) {
      renderSeriesControls();
      populatePlotInputs();
    }
    settings.hidden = !open;
    query('[data-action="configure"]').setAttribute("aria-expanded", String(open));
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
  const setSeriesFilter = (id, filter) => {
    updateSeries(id, (series) => ({ ...series, filter }), { reset: true });
  };
  return {
    mount(container) {
      container.innerHTML = PANEL_MARKUP;
      root = container.querySelector(".rb-timeseries");
      if (!root) throw new Error("Unable to create the ROS Time Series panel root.");
      canvas = query("canvas");
      settings = query('[data-role="settings"]');
      reconcileRuntime();
      renderSeriesControls();
      populatePlotInputs();
      if (context.ros) {
        subscriptions = new SubscriptionController(
          (source, listener) => context.ros.subscribe(
            { topic: source.topic, messageType: source.messageType, queueLength: 1, throttleMs: source.throttleMs },
            listener
          ),
          onSourceMessage,
          (source, error, operation) => {
            context.logger.warn(`ROS ${operation} failed for ${source.topic}.`, error);
            if (operation === "unsubscribe") return;
            const message = error instanceof Error ? error.message : String(error);
            setStatus(message.includes("not permitted") ? `Reapprove ${source.topic}` : `Unable to subscribe to ${source.topic}`, "warn");
          }
        );
      }
      root.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const actionElement = target?.closest("[data-action]");
        const action = actionElement?.dataset.action;
        if (action === "configure") setSettingsOpen(settings.hidden);
        else if (action === "close-settings") setSettingsOpen(false);
        else if (action === "choose-topic") void chooseTopic();
        else if (action === "apply-settings") applyPlotSettings();
        else if (action === "remove-series") {
          event.preventDefault();
          event.stopPropagation();
          if (actionElement?.dataset.seriesId) removeSeries(actionElement.dataset.seriesId);
        } else if (action === "toggle-series") {
          const id = actionElement?.dataset.seriesId;
          const series = config.series.find((item) => item.id === id);
          if (series) updateSeries(series.id, (item) => ({ ...item, enabled: !item.enabled }), { reconcile: true });
        } else if (action === "add-custom-field") {
          const source = uniqueSources().find((item) => item.key === query('[data-field="customSource"]').value);
          const input = query('[data-field="customField"]');
          const field = parseFieldPath(input.value);
          if (source && field) {
            addSeries(source.topic, source.messageType, field);
            input.value = "";
          }
        } else if (action === "pause") {
          paused = !paused;
          updatePauseButton();
          setStatus(paused ? "Paused \xB7 ROS remains connected" : "Resumed \xB7 waiting for messages", paused ? "warn" : "idle");
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
            setSeriesFilter(parameterId, { type: "movingAverage", window: Math.min(500, Math.max(2, Math.round(target.valueAsNumber || 10))) });
          } else if (series?.filter.type === "ema") {
            setSeriesFilter(parameterId, { type: "ema", alpha: Math.min(1, Math.max(0.01, target.valueAsNumber || 0.2)) });
          }
          return;
        }
        if (target.matches('[data-field="fieldPicker"]') && target.value) {
          try {
            const selection = JSON.parse(target.value);
            const source = uniqueSources().find((item) => item.key === selection.key);
            if (source) addSeries(source.topic, source.messageType, selection.field);
          } catch {
            setStatus("Unable to add the selected field", "warn");
          }
          target.value = "";
          return;
        }
        if (target.matches('[data-field="autoScale"]') && target instanceof HTMLInputElement) {
          query('[data-field="minY"]').disabled = target.checked;
          query('[data-field="maxY"]').disabled = target.checked;
        }
      });
      viewportUnsubscribe = context.viewport.subscribe(() => scheduleRender(true));
      connectionUnsubscribe = context.connection.subscribe((snapshot) => {
        const generationChanged = snapshot.generation !== lastConnectionGeneration;
        connection = snapshot;
        if (generationChanged) {
          lastConnectionGeneration = snapshot.generation;
          discoveredFields.clear();
        }
        reconcileSubscriptions(generationChanged && snapshot.status === "connected");
        renderSeriesControls();
      });
      if (!storedConfig || storedConfig.schemaVersion !== 3) persistConfig();
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
    }
  };
};
var definition = {
  apiVersion: "2.0.0",
  id: PANEL_ID,
  activate: createPanelInstance
};
var index_default = definition;
export {
  index_default as default
};
