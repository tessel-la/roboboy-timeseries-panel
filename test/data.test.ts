import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseAutoPlotFields,
  createCsv,
  discoverNumericFields,
  getNumericValueAtPath,
  getPlotRange,
  parseFieldPaths,
  trimSamples,
} from "../src/data.ts";

test("reads nested and indexed numeric ROS fields", () => {
  const message = { pose: { position: { x: 1.25 } }, ranges: [2, 3] };
  assert.equal(getNumericValueAtPath(message, "pose.position.x"), 1.25);
  assert.equal(getNumericValueAtPath(message, "ranges[1]"), 3);
  assert.equal(getNumericValueAtPath(message, "pose.position"), null);
});

test("discovers bounded numeric leaf fields", () => {
  assert.deepEqual(
    discoverNumericFields({
      linear: { x: 1, y: 2 },
      labels: ["ignored"],
      values: [3, 4],
    }),
    ["linear.x", "linear.y", "values[0]", "values[1]"],
  );
});

test("prefers telemetry values over ROS header timestamps for automatic plots", () => {
  assert.deepEqual(
    chooseAutoPlotFields([
      "header.stamp.sec",
      "header.stamp.nanosec",
      "position[0]",
      "position[1]",
    ]),
    ["position[0]", "position[1]"],
  );
  assert.deepEqual(chooseAutoPlotFields(["stamp.sec"]), ["stamp.sec"]);
});

test("normalizes field configuration and trims samples by time and count", () => {
  assert.deepEqual(parseFieldPaths(" data, pose.x, data, , pose.y "), [
    "data",
    "pose.x",
    "pose.y",
  ]);
  assert.deepEqual(
    trimSamples(
      [
        { time: 0, value: 1 },
        { time: 1500, value: 2 },
        { time: 1900, value: 3 },
        { time: 2000, value: 4 },
      ],
      2000,
      1,
      2,
    ),
    [
      { time: 1900, value: 3 },
      { time: 2000, value: 4 },
    ],
  );
});

test("calculates auto and fixed ranges", () => {
  assert.deepEqual(getPlotRange([{ time: 0, value: 5 }], true), {
    min: 4,
    max: 6,
  });
  assert.deepEqual(getPlotRange([], false, 10, -10), { min: -10, max: 10 });
});

test("exports ordered long-form CSV", () => {
  const csv = createCsv(
    new Map([
      ["pose.x", [{ time: 1000, value: 2 }]],
      ["pose.y", [{ time: 1500, value: 3 }]],
    ]),
  );
  assert.match(csv, /^timestamp_iso,elapsed_seconds,field,value/m);
  assert.match(csv, /0\.000000,"pose\.x",2/);
  assert.match(csv, /0\.500000,"pose\.y",3/);
});
