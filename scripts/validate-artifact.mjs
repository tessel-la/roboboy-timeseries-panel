import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(resolve(projectRoot, "roboboy.panel.json"), "utf8"),
);
const bundlePath = resolve(projectRoot, manifest.entryPoint);
const bundle = await readFile(bundlePath);
const integrity = `sha256-${createHash("sha256").update(bundle).digest("base64")}`;
const module = await import(
  `${pathToFileURL(bundlePath).href}?validate=${Date.now()}`
);

if (
  manifest.schemaVersion !== 1 ||
  !manifest.id ||
  !manifest.version ||
  !manifest.entryPoint ||
  !manifest.integrity
) {
  throw new Error("roboboy.panel.json is missing required metadata.");
}
if (integrity !== manifest.integrity) {
  throw new Error(
    `Bundle integrity mismatch: expected ${manifest.integrity}, received ${integrity}.`,
  );
}
if (
  !module.default ||
  module.default.id !== manifest.id ||
  module.default.apiVersion !== "2.0.0"
) {
  throw new Error("The built module does not match roboboy.panel.json.");
}
if (typeof module.default.activate !== "function") {
  throw new Error("The built module must export an activate function.");
}

const noChange = () => () => undefined;
const instance = await module.default.activate({
  panelId: manifest.id,
  instanceId: "artifact-validation",
  capabilities: [],
  storage: null,
  ros: null,
  network: null,
  runtime: { target: "web" },
  connection: {
    getSnapshot: () => ({ status: "disconnected", generation: 0 }),
    subscribe: noChange,
  },
  viewport: {
    getSnapshot: () => ({
      width: 640,
      height: 360,
      isIntersecting: true,
      isDocumentVisible: true,
      isActive: true,
    }),
    subscribe: noChange,
    requestFullscreen: async () => undefined,
  },
  theme: {
    getSnapshot: () => ({ colorScheme: "dark", tokens: {} }),
    subscribe: noChange,
  },
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
});
if (
  typeof instance?.mount !== "function" ||
  typeof instance?.unmount !== "function"
) {
  throw new Error(
    "The panel instance must provide mount and unmount functions.",
  );
}

console.log(
  `Validated ${manifest.id}@${manifest.version} (${bundle.byteLength} bytes)`,
);
