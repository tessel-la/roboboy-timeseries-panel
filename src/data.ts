export interface TimeseriesSample {
  time: number;
  value: number;
}

export interface TimeseriesRange {
  min: number;
  max: number;
}

const FIELD_SEGMENT_PATTERN = /^([^\[\]]+)(?:\[(\d+)\])?$/;

const readPathSegment = (value: unknown, segment: string): unknown => {
  const match = FIELD_SEGMENT_PATTERN.exec(segment);
  if (!match || value === null || typeof value !== "object") return undefined;

  const next = (value as Record<string, unknown>)[match[1]];
  if (match[2] === undefined) return next;
  return Array.isArray(next) ? next[Number(match[2])] : undefined;
};

export const getNumericValueAtPath = (
  message: unknown,
  fieldPath: string,
): number | null => {
  const value = fieldPath.split(".").reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) return undefined;
    return readPathSegment(current, segment);
  }, message);

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const parseFieldPaths = (value: string, limit = 8): string[] => {
  return [
    ...new Set(
      value
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean),
    ),
  ].slice(0, limit);
};

export const discoverNumericFields = (
  message: unknown,
  options: {
    maxDepth?: number;
    maxArrayItems?: number;
    maxFields?: number;
  } = {},
): string[] => {
  const maxDepth = options.maxDepth ?? 5;
  const maxArrayItems = options.maxArrayItems ?? 8;
  const maxFields = options.maxFields ?? 8;
  const fields: string[] = [];
  const ancestors = new Set<object>();

  const visit = (value: unknown, path: string, depth: number) => {
    if (fields.length >= maxFields || depth > maxDepth) return;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (path) fields.push(path);
      return;
    }
    if (!value || typeof value !== "object" || ancestors.has(value)) return;

    ancestors.add(value);
    if (Array.isArray(value)) {
      value
        .slice(0, maxArrayItems)
        .forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
    } else {
      Object.entries(value as Record<string, unknown>).forEach(
        ([key, item]) => {
          visit(item, path ? `${path}.${key}` : key, depth + 1);
        },
      );
    }
    ancestors.delete(value);
  };

  visit(message, "", 0);
  return fields;
};

export const chooseAutoPlotFields = (
  fields: readonly string[],
  limit = 8,
): string[] => {
  const telemetryFields = fields.filter(
    (path) => !/(^|\.)stamp\.(sec|nanosec)$/.test(path),
  );
  return (telemetryFields.length ? telemetryFields : fields).slice(
    0,
    Math.max(0, limit),
  );
};

export const trimSamples = (
  samples: readonly TimeseriesSample[],
  latestTime: number,
  timeWindowSec: number,
  sampleLimit: number,
): TimeseriesSample[] => {
  const minimumTime = latestTime - Math.max(1, timeWindowSec) * 1000;
  const byTime = samples.filter((sample) => sample.time >= minimumTime);
  return byTime.slice(Math.max(0, byTime.length - Math.max(1, sampleLimit)));
};

export const getPlotRange = (
  samples: readonly TimeseriesSample[],
  autoScale: boolean,
  fixedMin = -1,
  fixedMax = 1,
): TimeseriesRange => {
  if (!autoScale) {
    const min = Math.min(fixedMin, fixedMax);
    const max = Math.max(fixedMin, fixedMax);
    return min === max ? { min: min - 1, max: max + 1 } : { min, max };
  }
  if (samples.length === 0) return { min: -1, max: 1 };

  let min = Math.min(...samples.map((sample) => sample.value));
  let max = Math.max(...samples.map((sample) => sample.value));
  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.1, 1);
    return { min: min - padding, max: max + padding };
  }
  const padding = (max - min) * 0.08;
  min -= padding;
  max += padding;
  return { min, max };
};

export const createCsv = (
  series: ReadonlyMap<string, readonly TimeseriesSample[]>,
): string => {
  const rows = ["timestamp_iso,elapsed_seconds,field,value"];
  const firstTime = Math.min(
    ...[...series.values()].flatMap((samples) =>
      samples.map((sample) => sample.time),
    ),
    Date.now(),
  );
  [...series.entries()]
    .flatMap(([field, samples]) =>
      samples.map((sample) => ({ field, ...sample })),
    )
    .sort((left, right) => left.time - right.time)
    .forEach((sample) => {
      const escapedField = `"${sample.field.replace(/"/g, '""')}"`;
      rows.push(
        `${new Date(sample.time).toISOString()},${((sample.time - firstTime) / 1000).toFixed(6)},${escapedField},${sample.value}`,
      );
    });
  return `${rows.join("\n")}\n`;
};
