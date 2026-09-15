import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(
  new URL("../resources/coredoc-tool-classes.json", import.meta.url),
);

let cached;

function assertShape(classes) {
  const invalid =
    !classes ||
    typeof classes !== "object" ||
    !Array.isArray(classes.read) ||
    !Array.isArray(classes.write) ||
    typeof classes.byAction !== "object" ||
    classes.byAction === null;
  if (invalid) {
    throw new Error(
      `coredoc-tool-classes.json is malformed: expected { version, read: [], write: [], byAction: {} } at ${FIXTURE_PATH}`,
    );
  }
}

export function loadCoredocToolClasses() {
  if (cached) return cached;
  const raw = readFileSync(FIXTURE_PATH, "utf8");
  const classes = JSON.parse(raw);
  assertShape(classes);
  cached = classes;
  return classes;
}

export function classifyCoredocTool(
  toolName,
  toolInput,
  classes = loadCoredocToolClasses(),
) {
  if (classes.read.includes(toolName)) return { access: "read" };
  if (classes.write.includes(toolName)) return { access: "write" };
  const actionClass = classes.byAction[toolName];
  if (actionClass) {
    const action = toolInput?.action;
    if (typeof action === "string" && actionClass.read.includes(action)) {
      return { access: "read" };
    }
    if (typeof action === "string" && actionClass.write.includes(action)) {
      return { access: "write" };
    }
    return { access: "write", unclassified: true };
  }
  return { access: "write", unclassified: true };
}
