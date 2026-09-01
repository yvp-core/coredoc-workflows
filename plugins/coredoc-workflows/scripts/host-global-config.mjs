import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const INGRESS_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLAUDE_MARKER_KEY = "COREDOC_CAPTURE_AGENT_MANAGED";
const CLAUDE_MARKER_PREFIX = "coredoc-workflows/v1:env-";
const CLAUDE_MANAGED_KEYS = [
  CLAUDE_MARKER_KEY,
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "COREDOC_CAPTURE_ENDPOINT",
  "COREDOC_CAPTURE_HEADERS",
  "COREDOC_CAPTURE_BINDING_ID",
  "COREDOC_CAPTURE_WORKSPACE_ID",
  "COREDOC_CAPTURE_HOST",
  "COREDOC_CAPTURE_WORKSPACE_MODE",
];
const CLAUDE_UNMANAGED_ROUTE_OVERRIDES = [
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
];
const CODEX_START_PREFIX =
  "# >>> coredoc capture-agent managed otel v1 eof-newline=";
const CODEX_END_MARKER = "# <<< coredoc capture-agent managed otel v1";
const DESKTOP_CODEX_START_PREFIX =
  "# >>> coredoc managed otel v1 eof-newline=";
const DESKTOP_CODEX_END_MARKER = "# <<< coredoc managed otel v1";
const CODEX_MANAGED_COMMAND_PREFIX =
  "COREDOC_CAPTURE_AGENT_SESSION_CLAIM=1 ";
const DESKTOP_CODEX_MANAGED_COMMAND_PREFIX =
  "COREDOC_CODEX_SESSION_CLAIM=1 ELECTRON_RUN_AS_NODE=1 ";
const OTEL_TABLE = /^\s*\[{1,2}\s*(?:otel|"otel"|'otel')(?:\s*\.|\s*\]{1,2})/;
const TOML_TABLE = /^\s*\[{1,2}/;
const ROOT_OTEL_KEY = /^\s*(?:otel|"otel"|'otel')\s*(?:\.|=)/;

export class HostConfigError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HostConfigError";
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new HostConfigError(code, message, cause === undefined ? undefined : { cause });
}

function operation(value) {
  if (value !== "install" && value !== "uninstall") {
    fail("INVALID_INPUT", "Host configuration operation must be install or uninstall.");
  }
  return value;
}

function ingressToken(value, name) {
  if (typeof value !== "string" || !INGRESS_TOKEN.test(value)) {
    fail("INVALID_INPUT", `${name} must be a valid local ingress token.`);
  }
  return value;
}

function uuidV4(value, name) {
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    fail("INVALID_INPUT", `${name} must be a UUID v4.`);
  }
  return value.toLowerCase();
}

function jsonObject(content, label) {
  if (content === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    fail("CONFIG_INVALID", `${label} is not valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("CONFIG_INVALID", `${label} must contain a JSON object.`);
  }
  return parsed;
}

function claudeOwnership(env) {
  const marker = env[CLAUDE_MARKER_KEY];
  if (marker === `${CLAUDE_MARKER_PREFIX}present`) return "present";
  if (marker === `${CLAUDE_MARKER_PREFIX}absent`) return "absent";
  return undefined;
}

function claudeStatus(content) {
  try {
    const settings = jsonObject(content, "Claude settings");
    if (
      settings.env !== undefined &&
      (settings.env === null ||
        typeof settings.env !== "object" ||
        Array.isArray(settings.env))
    ) {
      return "invalid";
    }
    const env = settings.env ?? {};
    const ownership = claudeOwnership(env);
    if (ownership !== undefined) {
      const expected =
        env.CLAUDE_CODE_ENABLE_TELEMETRY === "1" &&
        env.OTEL_METRICS_EXPORTER === "none" &&
        env.OTEL_LOGS_EXPORTER === "otlp" &&
        env.OTEL_EXPORTER_OTLP_PROTOCOL === "http/json" &&
        env.OTEL_EXPORTER_OTLP_ENDPOINT === "http://127.0.0.1:43181" &&
        typeof env.OTEL_EXPORTER_OTLP_HEADERS === "string" &&
        /^X-Coredoc-Relay-Binding=[A-Za-z0-9_-]{32,256}$/.test(
          env.OTEL_EXPORTER_OTLP_HEADERS,
        ) &&
        env.COREDOC_CAPTURE_ENDPOINT ===
          "http://127.0.0.1:43181/capture/v1/events" &&
        env.COREDOC_CAPTURE_HEADERS === env.OTEL_EXPORTER_OTLP_HEADERS &&
        typeof env.COREDOC_CAPTURE_BINDING_ID === "string" &&
        UUID_V4.test(env.COREDOC_CAPTURE_BINDING_ID) &&
        typeof env.COREDOC_CAPTURE_WORKSPACE_ID === "string" &&
        UUID_V4.test(env.COREDOC_CAPTURE_WORKSPACE_ID) &&
        env.COREDOC_CAPTURE_HOST === "claude-code" &&
        env.COREDOC_CAPTURE_WORKSPACE_MODE === "1" &&
        !CLAUDE_UNMANAGED_ROUTE_OVERRIDES.some((key) => Object.hasOwn(env, key));
      return expected ? "managed" : "partial";
    }
    return [...CLAUDE_MANAGED_KEYS, ...CLAUDE_UNMANAGED_ROUTE_OVERRIDES].some(
      (key) => Object.hasOwn(env, key),
    )
      ? "unmanaged"
      : "unconfigured";
  } catch {
    return "invalid";
  }
}

export function renderClaudeGlobalSettings(content, options) {
  const requested = operation(options?.operation);
  const settings = jsonObject(content, "Claude settings");
  if (
    settings.env !== undefined &&
    (settings.env === null ||
      typeof settings.env !== "object" ||
      Array.isArray(settings.env))
  ) {
    fail("CONFIG_INVALID", "Claude settings env must be a JSON object.");
  }
  const envExisted = settings.env !== undefined;
  const env = { ...(settings.env ?? {}) };
  const ownership = claudeOwnership(env);
  const hasManagedKeys = CLAUDE_MANAGED_KEYS.some((key) =>
    Object.hasOwn(env, key),
  );
  if (requested === "uninstall") {
    if (ownership === undefined) return content;
    for (const key of CLAUDE_MANAGED_KEYS) delete env[key];
    const next = { ...settings };
    if (Object.keys(env).length > 0 || ownership === "present") next.env = env;
    else delete next.env;
    return `${JSON.stringify(next, null, 2)}\n`;
  }

  if (ownership === undefined && hasManagedKeys) {
    fail(
      "CONFIG_CONFLICT",
      "Claude already has unmanaged or conflicting OpenTelemetry settings.",
    );
  }

  if (
    CLAUDE_UNMANAGED_ROUTE_OVERRIDES.some((key) => Object.hasOwn(env, key))
  ) {
    fail(
      "CONFIG_CONFLICT",
      "Claude already has a logs-specific OpenTelemetry route override.",
    );
  }

  const token = ingressToken(options.ingressToken, "claudeIngressToken");
  const bindingId = uuidV4(options.bindingId, "claudeBindingId");
  const workspaceId = uuidV4(options.workspaceId, "workspaceId");
  const originalEnvState =
    ownership ?? (envExisted ? "present" : "absent");
  Object.assign(env, {
    [CLAUDE_MARKER_KEY]: `${CLAUDE_MARKER_PREFIX}${originalEnvState}`,
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:43181",
    OTEL_EXPORTER_OTLP_HEADERS: `X-Coredoc-Relay-Binding=${token}`,
    COREDOC_CAPTURE_ENDPOINT:
      "http://127.0.0.1:43181/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Binding=${token}`,
    COREDOC_CAPTURE_BINDING_ID: bindingId,
    COREDOC_CAPTURE_WORKSPACE_ID: workspaceId,
    COREDOC_CAPTURE_HOST: "claude-code",
    COREDOC_CAPTURE_WORKSPACE_MODE: "1",
  });
  const next = { ...settings, env };
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  return content === rendered ? content : rendered;
}

function removeExactCodexManagedBlock(
  content,
  { startPrefix, endMarker, ownedLines, label },
) {
  const start = content.indexOf(startPrefix);
  const strayEnd = content.indexOf(endMarker);
  if (start < 0) {
    if (strayEnd >= 0) {
      fail("CONFIG_CONFLICT", `${label} managed markers are malformed.`);
    }
    return { content, changed: false };
  }
  if (
    (start > 0 && content[start - 1] !== "\n") ||
    content.indexOf(startPrefix, start + startPrefix.length) >= 0
  ) {
    fail("CONFIG_CONFLICT", `${label} has multiple managed blocks.`);
  }
  const flagIndex = start + startPrefix.length;
  const flag = content[flagIndex];
  if ((flag !== "0" && flag !== "1") || content[flagIndex + 1] !== "\n") {
    fail("CONFIG_CONFLICT", `${label} managed markers are malformed.`);
  }
  const endStart = content.indexOf(endMarker, flagIndex + 2);
  if (
    endStart < 0 ||
    content.indexOf(endMarker, endStart + endMarker.length) >= 0 ||
    content[endStart - 1] !== "\n"
  ) {
    fail("CONFIG_CONFLICT", `${label} managed markers are malformed.`);
  }
  const candidate = content.slice(start, endStart);
  const nonces = [
    ...candidate.matchAll(
      /"X-Coredoc-Relay-Ingress" = "([A-Za-z0-9_-]{32,256})"/g,
    ),
  ];
  if (nonces.length !== 1) {
    fail("CONFIG_CONFLICT", `${label} managed OTEL lines are not exact.`);
  }
  const exactHead = [
    `${startPrefix}${flag}`,
    ...ownedLines(nonces[0][1]),
    "",
  ].join("\n");
  if (!content.startsWith(exactHead, start)) {
    fail("CONFIG_CONFLICT", `${label} managed OTEL lines are not exact.`);
  }
  const ownedEnd = start + exactHead.length;
  if (ownedEnd > endStart) {
    fail("CONFIG_CONFLICT", `${label} managed markers are malformed.`);
  }
  const retained = content.slice(ownedEnd, endStart);
  let end = endStart + endMarker.length;
  if (content[end] === "\n") end += 1;
  let prefix = content.slice(0, start);
  if (flag === "0" && retained.length === 0 && prefix.length > 0) {
    if (!prefix.endsWith("\n")) {
      fail("CONFIG_CONFLICT", `${label} managed markers are malformed.`);
    }
    prefix = prefix.slice(0, -1);
  }
  return {
    content: prefix + retained + content.slice(end),
    changed: true,
  };
}

function codexOwnedLines(token) {
  return [
    "[otel]",
    "log_user_prompt = false",
    'metrics_exporter = "none"',
    'trace_exporter = "none"',
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:43181/v1/logs", protocol = "json", headers = { "X-Coredoc-Relay-Ingress" = "' +
      token +
      '" } } }',
  ];
}

function removeCodexManagedBlock(content) {
  return removeExactCodexManagedBlock(content, {
    startPrefix: CODEX_START_PREFIX,
    endMarker: CODEX_END_MARKER,
    ownedLines: codexOwnedLines,
    label: "Codex OTEL",
  });
}

function desktopCodexOwnedLines(token) {
  return [
    "[otel]",
    "log_user_prompt = false",
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:43181/v1/logs", protocol = "json", headers = { "X-Coredoc-Relay-Ingress" = "' +
      token +
      '" } } }',
  ];
}

function removeDesktopCodexManagedBlock(content) {
  return removeExactCodexManagedBlock(content, {
    startPrefix: DESKTOP_CODEX_START_PREFIX,
    endMarker: DESKTOP_CODEX_END_MARKER,
    ownedLines: desktopCodexOwnedLines,
    label: "Desktop Codex OTEL",
  });
}

function hasUnmanagedCodexOtel(content) {
  let rootTable = true;
  for (const line of content.split(/\r?\n/)) {
    if (OTEL_TABLE.test(line)) return true;
    if (TOML_TABLE.test(line)) {
      rootTable = false;
      continue;
    }
    if (rootTable && ROOT_OTEL_KEY.test(line)) return true;
  }
  return false;
}

function codexStatus(content) {
  try {
    const plugin = removeCodexManagedBlock(content);
    const desktop = removeDesktopCodexManagedBlock(plugin.content);
    const unmanaged = hasUnmanagedCodexOtel(desktop.content);
    if (plugin.changed || desktop.changed) {
      return unmanaged ? "partial" : "managed";
    }
    return unmanaged ? "unmanaged" : "unconfigured";
  } catch {
    return "invalid";
  }
}

function codexManagedBlock(token, originalEndedWithNewline) {
  return [
    `${CODEX_START_PREFIX}${originalEndedWithNewline ? "1" : "0"}`,
    ...codexOwnedLines(token),
    CODEX_END_MARKER,
    "",
  ].join("\n");
}

export function renderCodexOtelConfig(content, options) {
  const requested = operation(options?.operation);
  const plugin = removeCodexManagedBlock(content);
  const removed = removeDesktopCodexManagedBlock(plugin.content);
  if (requested === "uninstall") return removed.content;
  if (hasUnmanagedCodexOtel(removed.content)) {
    fail("CONFIG_CONFLICT", "Codex already has an unmanaged [otel] configuration.");
  }
  const token = ingressToken(options.ingressToken, "codexIngressToken");
  const endedWithNewline =
    removed.content.length === 0 || removed.content.endsWith("\n");
  const rendered = codexManagedBlock(token, endedWithNewline) + removed.content;
  return rendered === content ? content : rendered;
}

function absoluteInstalledPath(value, name) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    fail("INVALID_INPUT", `${name} must be an absolute installed path.`);
  }
  return value;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function managedCodexHandler(runtimeExecutablePath, claimProgramPath) {
  return {
    type: "command",
    command:
      `${CODEX_MANAGED_COMMAND_PREFIX}${shellQuote(runtimeExecutablePath)} ` +
      shellQuote(claimProgramPath),
    timeout: 3,
    async: true,
    statusMessage: "Connecting Coredoc capture",
  };
}

function isManagedCodexHandler(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.command === "string" &&
    (value.command.startsWith(CODEX_MANAGED_COMMAND_PREFIX) ||
      value.command.startsWith(DESKTOP_CODEX_MANAGED_COMMAND_PREFIX))
  );
}

function withoutManagedCodexHandlers(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if (!Array.isArray(value.hooks)) return value;
  const retained = value.hooks.filter((handler) => !isManagedCodexHandler(handler));
  if (retained.length === value.hooks.length) return value;
  if (retained.length === 0) return null;
  return { ...value, hooks: retained };
}

function validatedHooksDocument(content) {
  const document = jsonObject(content, "Codex hooks");
  if (
    document.hooks !== undefined &&
    (document.hooks === null ||
      typeof document.hooks !== "object" ||
      Array.isArray(document.hooks))
  ) {
    fail("CONFIG_INVALID", "Codex hooks must contain a hooks object.");
  }
  const hooks = { ...(document.hooks ?? {}) };
  for (const hookName of ["SessionStart", "UserPromptSubmit"]) {
    if (hooks[hookName] !== undefined && !Array.isArray(hooks[hookName])) {
      fail("CONFIG_INVALID", `Codex ${hookName} hooks must be an array.`);
    }
  }
  return { document, hooks };
}

function codexHooksStatus(content) {
  try {
    const { hooks } = validatedHooksDocument(content);
    for (const hookName of ["SessionStart", "UserPromptSubmit"]) {
      for (const entry of hooks[hookName] ?? []) {
        if (
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          Array.isArray(entry.hooks) &&
          entry.hooks.some(isManagedCodexHandler)
        ) {
          return "managed";
        }
      }
    }
    return "unconfigured";
  } catch {
    return "invalid";
  }
}

export function renderCodexHooks(content, options) {
  const requested = operation(options?.operation);
  const { document, hooks } = validatedHooksDocument(content);
  let changed = false;
  for (const hookName of ["SessionStart", "UserPromptSubmit"]) {
    const retained = (hooks[hookName] ?? []).flatMap((entry) => {
      const stripped = withoutManagedCodexHandlers(entry);
      if (stripped !== entry) changed = true;
      return stripped === null ? [] : [stripped];
    });
    if (retained.length > 0) hooks[hookName] = retained;
    else delete hooks[hookName];
  }
  if (requested === "install") {
    const runtimeExecutablePath = absoluteInstalledPath(
      options.runtimeExecutablePath,
      "runtimeExecutablePath",
    );
    const claimProgramPath = absoluteInstalledPath(
      options.claimProgramPath,
      "claimProgramPath",
    );
    hooks.SessionStart = [
      ...(hooks.SessionStart ?? []),
      {
        matcher: "startup|resume|clear|compact",
        hooks: [managedCodexHandler(runtimeExecutablePath, claimProgramPath)],
      },
    ];
    hooks.UserPromptSubmit = [
      ...(hooks.UserPromptSubmit ?? []),
      { hooks: [managedCodexHandler(runtimeExecutablePath, claimProgramPath)] },
    ];
    changed = true;
  }
  if (!changed) return content;
  const next = { ...document };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;
  const rendered = `${JSON.stringify(next, null, 2)}\n`;
  return rendered === content ? content : rendered;
}

function requiredAbsolutePath(value, name) {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    value.includes("\0")
  ) {
    fail("INVALID_INPUT", `${name} must be an absolute path.`);
  }
  return value;
}

async function metadata(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail("UNSAFE_PATH", "Host configuration path could not be inspected.", error);
  }
}

function assertOwned(metadataValue) {
  if (typeof process.getuid === "function" && metadataValue.uid !== process.getuid()) {
    fail("UNSAFE_PATH", "Host configuration path is not owned by the current user.");
  }
}

async function assertSafeParent(path, { allowMissing = true } = {}) {
  let candidate = dirname(path);
  for (;;) {
    const info = await metadata(candidate);
    if (info !== undefined) {
      if (info.isSymbolicLink() || !info.isDirectory()) {
        fail("UNSAFE_PATH", "Host configuration parent is not a safe directory.");
      }
      assertOwned(info);
      if ((info.mode & 0o022) !== 0) {
        fail("UNSAFE_PATH", "Host configuration parent is writable by another user.");
      }
      return;
    }
    if (!allowMissing) {
      fail("UNSAFE_PATH", "Host configuration parent does not exist.");
    }
    const parent = dirname(candidate);
    if (parent === candidate) {
      fail("UNSAFE_PATH", "Host configuration has no safe parent directory.");
    }
    candidate = parent;
  }
}

async function readSafeSnapshot(path) {
  requiredAbsolutePath(path, "host configuration path");
  await assertSafeParent(path);
  const info = await metadata(path);
  if (info === undefined) return { exists: false, content: "", mode: undefined };
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    fail("UNSAFE_PATH", "Host configuration target is not a safe regular file.");
  }
  assertOwned(info);
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    fail("UNSAFE_PATH", "Host configuration target could not be read.", error);
  }
  return { exists: true, content, mode: info.mode & 0o777 };
}

function sameSnapshot(left, right) {
  return (
    left.exists === right.exists &&
    left.content === right.content &&
    left.mode === right.mode
  );
}

async function ensureExpected(path, expected) {
  const current = await readSafeSnapshot(path);
  if (!sameSnapshot(current, expected)) {
    fail("CONFIG_CHANGED", "Host configuration changed after it was prepared.");
  }
}

async function atomicWrite(path, content, mode, expected) {
  await ensureExpected(path, expected);
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    fail("UNSAFE_PATH", "Host configuration directory could not be created.", error);
  }
  await assertSafeParent(path, { allowMissing: false });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    await chmod(temporary, mode);
    await ensureExpected(path, expected);
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (error instanceof HostConfigError) throw error;
    fail("WRITE_FAILED", "Host configuration could not be written atomically.", error);
  }
}

async function removeFile(path, expected) {
  await ensureExpected(path, expected);
  if (!expected.exists) return;
  try {
    await unlink(path);
  } catch (error) {
    fail("WRITE_FAILED", "Host configuration could not be removed.", error);
  }
}

function changedSnapshot(before, content, requested) {
  if (requested === "uninstall" && content === before.content) {
    return before;
  }
  return {
    exists: true,
    content,
    mode: 0o600,
  };
}

async function restorePlan(plan) {
  if (plan.before.exists) {
    await atomicWrite(
      plan.path,
      plan.before.content,
      plan.before.mode,
      plan.after,
    );
  } else {
    await removeFile(plan.path, plan.after);
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  for (const path of paths) {
    requiredAbsolutePath(path, "host configuration path");
    if (seen.has(path)) fail("INVALID_INPUT", "Host configuration paths must be unique.");
    seen.add(path);
  }
}

export async function inspectHostGlobalConfig({
  claudeSettingsPath,
  codexConfigPaths,
  codexHooksPath,
} = {}) {
  if (!Array.isArray(codexConfigPaths) || codexConfigPaths.length < 1) {
    fail("INVALID_INPUT", "At least one explicit Codex config path is required.");
  }
  uniquePaths([claudeSettingsPath, ...codexConfigPaths, codexHooksPath]);
  const [claude, ...configs] = await Promise.all(
    [claudeSettingsPath, ...codexConfigPaths].map(readSafeSnapshot),
  );
  let hooks;
  try {
    hooks = await readSafeSnapshot(codexHooksPath);
  } catch {
    hooks = null;
  }
  return {
    claude: claude.exists ? claudeStatus(claude.content) : "absent",
    codex: configs.map((snapshot) =>
      snapshot.exists ? codexStatus(snapshot.content) : "absent",
    ),
    codexHooks:
      hooks === null
        ? "invalid"
        : hooks.exists
          ? codexHooksStatus(hooks.content)
          : "absent",
  };
}

function preparedTransaction(plans) {
  let state = "prepared";

  async function rollbackApplied(applied) {
    const errors = [];
    for (const plan of applied) {
      try {
        await ensureExpected(plan.path, plan.after);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      fail(
        "ROLLBACK_FAILED",
        "Host configuration rollback was refused because a file changed.",
        new AggregateError(errors),
      );
    }
    for (const plan of [...applied].reverse()) {
      try {
        await restorePlan(plan);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      fail(
        "ROLLBACK_FAILED",
        "Host configuration rollback was incomplete.",
        new AggregateError(errors),
      );
    }
  }

  return {
    summary: plans.map(({ path, kind, changed }) => ({ path, kind, changed })),
    get state() {
      return state;
    },
    async apply() {
      if (state !== "prepared") {
        fail("INVALID_STATE", "Host configuration transaction is not prepared.");
      }
      const applied = [];
      try {
        for (const plan of plans) {
          if (!plan.changed) continue;
          await atomicWrite(
            plan.path,
            plan.after.content,
            plan.after.mode,
            plan.before,
          );
          applied.push(plan);
        }
        state = "applied";
      } catch (error) {
        try {
          await rollbackApplied(applied);
        } finally {
          state = "rolled-back";
        }
        throw error;
      }
    },
    async rollback() {
      if (state === "rolled-back") return;
      if (state === "prepared") {
        state = "rolled-back";
        return;
      }
      if (state !== "applied") {
        fail("INVALID_STATE", "Host configuration transaction cannot be rolled back.");
      }
      await rollbackApplied(plans.filter(({ changed }) => changed));
      state = "rolled-back";
    },
  };
}

function planFor(path, kind, before, rendered, requested) {
  const after = changedSnapshot(before, rendered, requested);
  return {
    path,
    kind,
    before,
    after,
    changed: !sameSnapshot(before, after),
  };
}

export async function prepareCodexHooksTransaction(input = {}) {
  const requested = operation(input.operation);
  const path = requiredAbsolutePath(input.codexHooksPath, "codexHooksPath");
  const before = await readSafeSnapshot(path);
  const rendered = renderCodexHooks(before.content, {
    operation: requested,
    ...(requested === "install"
      ? {
          runtimeExecutablePath: input.runtimeExecutablePath,
          claimProgramPath: input.claimProgramPath,
        }
      : {}),
  });
  return preparedTransaction([
    planFor(path, "codex-hooks", before, rendered, requested),
  ]);
}

export async function prepareHostGlobalConfigTransaction(input = {}) {
  const requested = operation(input.operation);
  if (!Array.isArray(input.codexConfigPaths) || input.codexConfigPaths.length < 1) {
    fail("INVALID_INPUT", "At least one explicit Codex config path is required.");
  }
  const includeCodexHooks = input.includeCodexHooks ?? true;
  if (typeof includeCodexHooks !== "boolean") {
    fail("INVALID_INPUT", "includeCodexHooks must be a boolean.");
  }
  const paths = [
    input.claudeSettingsPath,
    ...input.codexConfigPaths,
    ...(includeCodexHooks ? [input.codexHooksPath] : []),
  ];
  uniquePaths(paths);
  let claudeToken;
  let codexToken;
  if (requested === "install") {
    claudeToken = ingressToken(input.claudeIngressToken, "claudeIngressToken");
    codexToken = ingressToken(input.codexIngressToken, "codexIngressToken");
    if (claudeToken === codexToken) {
      fail("INVALID_INPUT", "Claude and Codex must use distinct local ingress tokens.");
    }
  }
  const snapshots = await Promise.all(paths.map(readSafeSnapshot));
  const rendered = [
    renderClaudeGlobalSettings(snapshots[0].content, {
      operation: requested,
      ...(claudeToken === undefined
        ? {}
        : {
            ingressToken: claudeToken,
            bindingId: input.claudeBindingId,
            workspaceId: input.workspaceId,
          }),
    }),
    ...input.codexConfigPaths.map((_, index) =>
      renderCodexOtelConfig(snapshots[index + 1].content, {
        operation: requested,
        ...(codexToken === undefined ? {} : { ingressToken: codexToken }),
      }),
    ),
    ...(includeCodexHooks
      ? [
          renderCodexHooks(snapshots.at(-1).content, {
            operation: requested,
            ...(requested === "install"
              ? {
                  runtimeExecutablePath: input.runtimeExecutablePath,
                  claimProgramPath: input.claimProgramPath,
                }
              : {}),
          }),
        ]
      : []),
  ];
  const kinds = [
    "claude-settings",
    ...input.codexConfigPaths.map(() => "codex-otel"),
    ...(includeCodexHooks ? ["codex-hooks"] : []),
  ];
  return preparedTransaction(
    paths.map((path, index) =>
      planFor(path, kinds[index], snapshots[index], rendered[index], requested),
    ),
  );
}
