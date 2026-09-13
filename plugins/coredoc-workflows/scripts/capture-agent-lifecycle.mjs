#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const CAPTURE_AGENT_LABEL = "ai.coredoc.workflows.capture-relay";
export const DESKTOP_CAPTURE_AGENT_LABEL = "ai.coredoc.capture-relay";
export const PLUGIN_LAUNCH_AGENT_MARKER =
  "<!-- Coredoc Workflows plugin capture agent LaunchAgent v1 -->";
export const DESKTOP_LAUNCH_AGENT_MARKER =
  "<!-- Coredoc managed relay LaunchAgent v1 -->";
export const PLUGIN_SYSTEMD_UNIT_MARKER =
  "# Coredoc Workflows plugin capture agent systemd unit v1";
const SYSTEMD_UNIT_SUFFIX = ".service";
export const CAPTURE_AGENT_UNIT = `${CAPTURE_AGENT_LABEL}${SYSTEMD_UNIT_SUFFIX}`;

const SYSTEMCTL = "/usr/bin/systemctl";
// `failed` and `inactive` are the only ActiveState values in which nothing of
// ours is running and nothing is about to run.
const SYSTEMD_RUNNING_STATES = new Set([
  "activating",
  "active",
  "deactivating",
  "maintenance",
  "refreshing",
  "reloading",
]);
const SYSTEMD_SETTLED_STATES = new Set(["failed", "inactive"]);
const SYSTEMD_ACTIVE_STATES = new Set([
  ...SYSTEMD_RUNNING_STATES,
  ...SYSTEMD_SETTLED_STATES,
]);
// `systemctl --user` finds the user manager through these; the child otherwise
// runs with a pinned PATH only, which launchctl never needed.
const SUPERVISOR_ENVIRONMENT = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
const SERVICE_START_RETRY_DELAY_MS = 100;

const AGENT_STATE_MARKER = "coredoc-workflows.capture-agent.v1";
const AGENT_STATE_SCHEMA_VERSION = 1;
const AGENT_PROTOCOL_VERSION = 1;
const RELAY_CONFIG_SCHEMA_VERSION = 1;
const MANAGED_RELAY_PORT = 43_181;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_QUEUE_ENTRIES = 10_000;
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const HEALTH_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const RUNTIME_MODULE_PATH_RE = /^(?:scripts|runtime)\/[A-Za-z0-9._/-]+\.mjs$/;
const BUNDLED_RUNTIME_CONFIG_PATH = "runtime/bun/bunfig.toml";
const BUNDLED_RUNTIME_RUNNER_PATH = "runtime/bun/runner";
const BUNDLED_RUNTIME_SHARED_PATHS = new Set([
  BUNDLED_RUNTIME_CONFIG_PATH,
  BUNDLED_RUNTIME_RUNNER_PATH,
]);
// The plugin vendors one Bun build per supported host. A resolved bundle carries
// exactly one of them, so a macOS install never stages the Linux binary.
const BUNDLED_RUNTIME_EXECUTABLES = new Map([
  ["darwin-arm64", "runtime/bun/darwin-arm64/bun"],
  ["linux-x64", "runtime/bun/linux-x64/bun"],
]);
const BUNDLED_RUNTIME_EXECUTABLE_PATHS = new Set(
  BUNDLED_RUNTIME_EXECUTABLES.values(),
);
const BUNDLED_RUNTIME_PATHS = new Set([
  ...BUNDLED_RUNTIME_SHARED_PATHS,
  ...BUNDLED_RUNTIME_EXECUTABLE_PATHS,
]);
const BUNDLED_MANIFEST_SCHEMA_VERSION = 2;
const BUNDLED_RUNTIME_FILE_COUNT = 16;
const EVENT_ENTRY_RE = /^[0-9a-f-]{36}\.event\.json$/i;
const ARTIFACT_ENTRY_RE = /^revision-\d{6}-cda_[0-9a-f-]+-[0-9a-f]{64}\.json$/;
const ARTIFACT_QUARANTINE_ENTRY_RE =
  /^quarantine-\d{6}-cda_[0-9a-f-]+-[0-9a-f]{64}\.json$/;
const NATIVE_OUTBOX_BINDING_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NATIVE_OUTBOX_RECORD_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.native\.json$/;
const MAX_NATIVE_OUTBOX_RECORD_BYTES = 26 * 1024 * 1024;
const MAX_NATIVE_OUTBOX_STATE_BYTES = 16 * 1024;
const MAX_CODEX_ATTRIBUTION_STATE_BYTES = 256 * 1024;
const MAX_CODEX_JOURNAL_BYTES = 32 * 1024 * 1024;
const HEALTH_DEGRADED_REASONS = new Set([
  "ATTRIBUTION_PENDING",
  "ATTRIBUTION_REJECTED",
  "AUTH_REJECTED",
  "CHANNEL_DEGRADED",
  "CLAUDE_INGRESS_UNCONFIGURED",
  "CODEX_INGRESS_UNCONFIGURED",
  "CONFIG_CONFLICT",
  "CONFIG_UNAVAILABLE",
  "NATIVE_OUTBOX_UNAVAILABLE",
  "QUEUE_PENDING",
  "QUEUE_UNSAFE",
  "REPOSITORY_ATTRIBUTION_DEGRADED",
  "REPOSITORY_UNAVAILABLE",
  "TRANSPORT_UNAVAILABLE",
  "UPSTREAM_REJECTED",
  "WORKSPACE_CONFLICT",
]);
const execFileAsync = promisify(execFile);

const SAFE_ERROR_CODES = new Set([
  "FOREIGN_LISTENER",
  "HEALTH_MISMATCH",
  "INVALID_ARGUMENTS",
  "INVALID_RUNTIME_MANIFEST",
  "LOCKED",
  "NOT_INSTALLED",
  "NO_PREVIOUS_RUNTIME",
  "OWNERSHIP_CONFLICT",
  "ROLLBACK_FAILED",
  "SUPERVISOR_UNAVAILABLE",
  "UNSAFE_STATE",
  "UNSUPPORTED_PLATFORM",
]);

export class CaptureAgentLifecycleError extends Error {
  constructor(code, { rollback } = {}) {
    super(code);
    this.name = "CaptureAgentLifecycleError";
    this.code = SAFE_ERROR_CODES.has(code) ? code : "SUPERVISOR_UNAVAILABLE";
    if (rollback !== undefined) this.rollback = rollback;
  }
}

function fail(code, options) {
  throw new CaptureAgentLifecycleError(code, options);
}

function exactObject(value, fields, code = "UNSAFE_STATE") {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))
  ) {
    fail(code);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeHome(value) {
  if (typeof value !== "string" || !isAbsolute(value)) fail("UNSAFE_STATE");
  return resolve(value);
}

export function captureAgentPaths({
  env = process.env,
  homeDir = homedir(),
  platform = process.platform,
} = {}) {
  const resolvedHome = safeHome(homeDir);
  const configured = env.COREDOC_HOME?.trim();
  const coredocHome = configured ? safeHome(configured) : join(resolvedHome, ".coredoc");
  const agentRoot = join(coredocHome, "capture-agent");
  const runtimeRoot = join(agentRoot, "runtime");
  const currentPath = join(agentRoot, "current");
  return {
    homeDir: resolvedHome,
    coredocHome,
    agentRoot,
    runtimeRoot,
    runtimeVersionsDirectory: join(runtimeRoot, "versions"),
    currentPath,
    previousPath: join(agentRoot, "previous"),
    runtimeExecutablePath: join(currentPath, BUNDLED_RUNTIME_RUNNER_PATH),
    statePath: join(agentRoot, "state.json"),
    lockPath: join(coredocHome, ".capture-agent-lifecycle.lock"),
    relayRoot: join(agentRoot, "capture-relay"),
    relayConfigPath: join(agentRoot, "capture-relay", "relay.json"),
    desktopRelayRoot: join(coredocHome, "capture-relay"),
    ...captureAgentSupervisor(platform).servicePaths(resolvedHome, env),
  };
}

function validateManifest(value) {
  const candidate = exactObject(
    value,
    new Set(["schemaVersion", "entry", "files"]),
    "INVALID_RUNTIME_MANIFEST",
  );
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.entry !== "string" ||
    !Array.isArray(candidate.files) ||
    candidate.files.length !== BUNDLED_RUNTIME_FILE_COUNT
  ) {
    fail("INVALID_RUNTIME_MANIFEST");
  }
  const files = candidate.files.map((value) => {
    const file = exactObject(
      value,
      new Set(["path", "sha256"]),
      "INVALID_RUNTIME_MANIFEST",
    );
    if (
      typeof file.path !== "string" ||
      (!RUNTIME_MODULE_PATH_RE.test(file.path) &&
        !BUNDLED_RUNTIME_PATHS.has(file.path)) ||
      file.path.includes("//") ||
      file.path.split("/").some((segment) => segment === "." || segment === "..") ||
      typeof file.sha256 !== "string" ||
      !SHA256_RE.test(file.sha256)
    ) {
      fail("INVALID_RUNTIME_MANIFEST");
    }
    return { path: file.path, sha256: file.sha256 };
  });
  if (
    new Set(files.map(({ path }) => path)).size !== files.length ||
    !files.some(({ path }) => path === candidate.entry) ||
    [...BUNDLED_RUNTIME_SHARED_PATHS].some(
      (requiredPath) => !files.some(({ path }) => path === requiredPath),
    ) ||
    files.filter(({ path }) => BUNDLED_RUNTIME_EXECUTABLE_PATHS.has(path))
      .length !== 1
  ) {
    fail("INVALID_RUNTIME_MANIFEST");
  }
  return {
    schemaVersion: 1,
    entry: candidate.entry,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function runtimeDigestForManifest(value) {
  const manifest = validateManifest(value);
  return sha256(
    `schemaVersion=${manifest.schemaVersion}\nentry=${manifest.entry}\n${manifest.files
      .map(({ path, sha256 }) => `${path}\0${sha256}\n`)
      .join("")}`,
  );
}

function readBoundedJson(path, maxBytes, code) {
  let metadata;
  try {
    metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > maxBytes ||
      metadata.nlink !== 1
    ) {
      fail(code);
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof CaptureAgentLifecycleError) throw error;
    fail(code);
  }
}

function verifiedSourceFile(sourceRoot, file) {
  const source = resolve(sourceRoot, file.path);
  if (!source.startsWith(`${resolve(sourceRoot)}${sep}`)) {
    fail("INVALID_RUNTIME_MANIFEST");
  }
  let metadata;
  let content;
  try {
    metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      fail("INVALID_RUNTIME_MANIFEST");
    }
    content = readFileSync(source);
  } catch (error) {
    if (error instanceof CaptureAgentLifecycleError) throw error;
    fail("INVALID_RUNTIME_MANIFEST");
  }
  if (sha256(content) !== file.sha256) fail("INVALID_RUNTIME_MANIFEST");
  return source;
}

function normalizeRuntimeBundle(value) {
  const candidate = exactObject(
    value,
    new Set(["sourceRoot", "version", "manifest", "runtimeDigest"]),
    "INVALID_RUNTIME_MANIFEST",
  );
  if (
    typeof candidate.sourceRoot !== "string" ||
    !isAbsolute(candidate.sourceRoot) ||
    typeof candidate.version !== "string" ||
    !VERSION_RE.test(candidate.version)
  ) {
    fail("INVALID_RUNTIME_MANIFEST");
  }
  const manifest = validateManifest(candidate.manifest);
  const runtimeDigest = runtimeDigestForManifest(manifest);
  if (candidate.runtimeDigest !== runtimeDigest) {
    fail("INVALID_RUNTIME_MANIFEST");
  }
  for (const file of manifest.files) verifiedSourceFile(candidate.sourceRoot, file);
  return {
    sourceRoot: resolve(candidate.sourceRoot),
    version: candidate.version,
    manifest,
    runtimeDigest,
  };
}

export function captureAgentPlatformKey({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const key = `${platform}-${arch}`;
  if (!BUNDLED_RUNTIME_EXECUTABLES.has(key)) fail("UNSUPPORTED_PLATFORM");
  return key;
}

// The bundled manifest carries every supported host; installing resolves it to
// the single-platform manifest that the rest of the lifecycle already speaks.
function resolveBundledManifest(value, platformKey) {
  const candidate = exactObject(
    value,
    new Set(["schemaVersion", "entry", "shared", "platforms"]),
    "INVALID_RUNTIME_MANIFEST",
  );
  const platforms = candidate.platforms;
  if (
    candidate.schemaVersion !== BUNDLED_MANIFEST_SCHEMA_VERSION ||
    !Array.isArray(candidate.shared) ||
    !platforms ||
    typeof platforms !== "object" ||
    Array.isArray(platforms) ||
    Object.keys(platforms).length === 0 ||
    Object.keys(platforms).some((key) => !BUNDLED_RUNTIME_EXECUTABLES.has(key))
  ) {
    fail("INVALID_RUNTIME_MANIFEST");
  }
  if (!Object.hasOwn(platforms, platformKey)) fail("UNSUPPORTED_PLATFORM");
  const executable = exactObject(
    platforms[platformKey],
    new Set(["sha256"]),
    "INVALID_RUNTIME_MANIFEST",
  );
  return validateManifest({
    schemaVersion: 1,
    entry: candidate.entry,
    files: [
      ...candidate.shared,
      {
        path: BUNDLED_RUNTIME_EXECUTABLES.get(platformKey),
        sha256: executable.sha256,
      },
    ],
  });
}

export function loadRuntimeBundle({ pluginRoot, platformKey } = {}) {
  if (typeof pluginRoot !== "string" || !isAbsolute(pluginRoot)) {
    fail("INVALID_RUNTIME_MANIFEST");
  }
  if (
    typeof platformKey !== "string" ||
    !BUNDLED_RUNTIME_EXECUTABLES.has(platformKey)
  ) {
    fail("UNSUPPORTED_PLATFORM");
  }
  const root = resolve(pluginRoot);
  const manifest = resolveBundledManifest(
    readBoundedJson(
      join(root, "runtime", "capture-agent-manifest.json"),
      MAX_MANIFEST_BYTES,
      "INVALID_RUNTIME_MANIFEST",
    ),
    platformKey,
  );
  const packageJson = readBoundedJson(
    join(root, "package.json"),
    MAX_MANIFEST_BYTES,
    "INVALID_RUNTIME_MANIFEST",
  );
  return normalizeRuntimeBundle({
    sourceRoot: root,
    version: packageJson?.version,
    manifest,
    runtimeDigest: runtimeDigestForManifest(manifest),
  });
}

// "private" is the plugin's own rule for everything it owns. "private-group"
// exists for one directory the plugin does not own, ~/.config/systemd/user: a
// Linux user-private-group umask (002) leaves it 0775, which systemd itself
// treats as owner-only because the group has a single member.
function ensureDirectory(path, mode = 0o700, policy = "private") {
  if (existsSync(path)) {
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("UNSAFE_STATE");
    if ((metadata.mode & 0o002) !== 0) fail("UNSAFE_STATE");
    if ((metadata.mode & 0o020) !== 0) {
      const ownGroup =
        policy === "private-group" &&
        typeof process.getuid === "function" &&
        typeof process.getgid === "function" &&
        metadata.uid === process.getuid() &&
        metadata.gid === process.getgid();
      if (!ownGroup) fail("UNSAFE_STATE");
    }
    return;
  }
  mkdirSync(path, { recursive: true, mode });
  chmodSync(path, mode);
}

function readOptional(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      fail("OWNERSHIP_CONFLICT");
    }
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function atomicWrite(path, content, mode = 0o600, directoryPolicy = "private") {
  ensureDirectory(dirname(path), 0o700, directoryPolicy);
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail("UNSAFE_STATE");
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function runtimeRecord(value) {
  const candidate = exactObject(
    value,
    new Set(["version", "digest", "directoryName", "entry", "files"]),
  );
  if (
    typeof candidate.version !== "string" ||
    !VERSION_RE.test(candidate.version) ||
    typeof candidate.digest !== "string" ||
    !SHA256_RE.test(candidate.digest) ||
    candidate.directoryName !== `${candidate.version}-${candidate.digest}`
  ) {
    fail("UNSAFE_STATE");
  }
  const manifest = validateManifest({
    schemaVersion: 1,
    entry: candidate.entry,
    files: candidate.files,
  });
  if (runtimeDigestForManifest(manifest) !== candidate.digest) fail("UNSAFE_STATE");
  return {
    version: candidate.version,
    digest: candidate.digest,
    directoryName: candidate.directoryName,
    entry: manifest.entry,
    files: manifest.files,
  };
}

function agentState(value) {
  const candidate = exactObject(
    value,
    new Set(["schemaVersion", "marker", "healthToken", "current", "previous"]),
  );
  if (
    candidate.schemaVersion !== AGENT_STATE_SCHEMA_VERSION ||
    candidate.marker !== AGENT_STATE_MARKER ||
    typeof candidate.healthToken !== "string" ||
    !HEALTH_TOKEN_RE.test(candidate.healthToken)
  ) {
    fail("UNSAFE_STATE");
  }
  return {
    schemaVersion: AGENT_STATE_SCHEMA_VERSION,
    marker: AGENT_STATE_MARKER,
    healthToken: candidate.healthToken,
    current: runtimeRecord(candidate.current),
    previous:
      candidate.previous === null ? null : runtimeRecord(candidate.previous),
  };
}

function readAgentState(path, { optional = false } = {}) {
  if (!existsSync(path)) {
    if (optional) return null;
    fail("NOT_INSTALLED");
  }
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_STATE_BYTES ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    fail("UNSAFE_STATE");
  }
  try {
    return agentState(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof CaptureAgentLifecycleError) throw error;
    fail("UNSAFE_STATE");
  }
}

function writeAgentState(path, value) {
  const validated = agentState(value);
  atomicWrite(path, `${JSON.stringify(validated)}\n`, 0o600);
  return validated;
}

function publicRuntime(record) {
  if (record === null) return null;
  return {
    version: record.version,
    digest: record.digest,
    directoryName: record.directoryName,
  };
}

function runtimeFileMode(path) {
  return path === BUNDLED_RUNTIME_RUNNER_PATH ||
    BUNDLED_RUNTIME_EXECUTABLE_PATHS.has(path)
    ? 0o555
    : 0o444;
}

function installedRuntimeExecutable(directory) {
  return join(directory, BUNDLED_RUNTIME_RUNNER_PATH);
}

function immutableDirectoryEntries(root) {
  const entries = [];
  const visit = (directory) => {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail("UNSAFE_STATE");
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const child = lstatSync(path);
      if (child.isSymbolicLink()) fail("UNSAFE_STATE");
      const relativePath = relative(root, path).split(sep).join("/");
      entries.push({ path, relativePath, directory: child.isDirectory() });
      if (child.isDirectory()) visit(path);
      else if (!child.isFile() || child.nlink !== 1) fail("UNSAFE_STATE");
    }
  };
  visit(root);
  return entries;
}

function verifyInstalledRuntime(
  directory,
  record,
  { allowWritableRoot = false } = {},
) {
  if (!existsSync(directory)) fail("UNSAFE_STATE");
  const entries = immutableDirectoryEntries(directory);
  const expectedFiles = new Set(record.files.map(({ path }) => path));
  const expectedDirectories = new Set();
  for (const file of record.files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
    const target = join(directory, file.path);
    if (sha256(readFileSync(target)) !== file.sha256) fail("UNSAFE_STATE");
    if ((statSync(target).mode & 0o777) !== runtimeFileMode(file.path)) {
      fail("UNSAFE_STATE");
    }
  }
  for (const entry of entries) {
    if (entry.directory) {
      if (!expectedDirectories.has(entry.relativePath)) fail("UNSAFE_STATE");
      if ((statSync(entry.path).mode & 0o777) !== 0o555) fail("UNSAFE_STATE");
    } else if (!expectedFiles.has(entry.relativePath)) {
      fail("UNSAFE_STATE");
    }
  }
  const rootMode = statSync(directory).mode & 0o777;
  if (rootMode !== 0o555 && !(allowWritableRoot && rootMode === 0o700)) {
    fail("UNSAFE_STATE");
  }
  return rootMode;
}

function makeRuntimeRecord(bundle) {
  return runtimeRecord({
    version: bundle.version,
    digest: bundle.runtimeDigest,
    directoryName: `${bundle.version}-${bundle.runtimeDigest}`,
    entry: bundle.manifest.entry,
    files: bundle.manifest.files,
  });
}

function chmodChildDirectoriesImmutable(root) {
  const directories = [];
  for (const entry of immutableDirectoryEntries(root)) {
    if (entry.directory) directories.push(entry.path);
  }
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) chmodSync(directory, 0o555);
}

function removeStagedRuntime(directory) {
  if (!existsSync(directory)) return;
  for (const entry of immutableDirectoryEntries(directory).sort(
    (left, right) => right.path.length - left.path.length,
  )) {
    if (entry.directory) chmodSync(entry.path, 0o700);
    else chmodSync(entry.path, 0o600);
  }
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
}

async function defaultImportSmoke(entryPath, { runtimeExecutablePath }) {
  try {
    await execFileAsync(
      runtimeExecutablePath,
      [
        "--eval",
        `await import(${JSON.stringify(pathToFileURL(entryPath).href)})`,
      ],
      {
        timeout: 5_000,
        env: { PATH: "/usr/bin:/bin", DO_NOT_TRACK: "1" },
      },
    );
  } catch {
    fail("INVALID_RUNTIME_MANIFEST");
  }
}

async function stageRuntime({
  bundle,
  paths,
  importSmoke,
  renameRuntime,
}) {
  const record = makeRuntimeRecord(bundle);
  ensureDirectory(paths.agentRoot);
  ensureDirectory(paths.runtimeRoot);
  ensureDirectory(paths.runtimeVersionsDirectory);
  const destination = join(paths.runtimeVersionsDirectory, record.directoryName);
  if (existsSync(destination)) {
    const rootMode = verifyInstalledRuntime(destination, record, {
      allowWritableRoot: true,
    });
    if (rootMode === 0o700) {
      chmodSync(destination, 0o555);
      verifyInstalledRuntime(destination, record);
    }
    return { record, directory: destination, created: false };
  }
  const temporary = join(
    paths.runtimeVersionsDirectory,
    `.stage-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  let cleanupPath = temporary;
  try {
    mkdirSync(temporary, { mode: 0o700 });
    for (const file of bundle.manifest.files) {
      const source = verifiedSourceFile(bundle.sourceRoot, file);
      const target = join(temporary, file.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      chmodSync(target, runtimeFileMode(file.path));
    }
    await importSmoke(join(temporary, bundle.manifest.entry), {
      runtimeExecutablePath: installedRuntimeExecutable(temporary),
    });
    chmodChildDirectoriesImmutable(temporary);
    renameRuntime(temporary, destination);
    cleanupPath = destination;
    chmodSync(destination, 0o555);
    verifyInstalledRuntime(destination, record);
    return { record, directory: destination, created: true };
  } catch (error) {
    try {
      removeStagedRuntime(cleanupPath);
    } catch {
      // The original bounded lifecycle failure remains authoritative.
    }
    if (error instanceof CaptureAgentLifecycleError) throw error;
    fail("INVALID_RUNTIME_MANIFEST");
  }
}

function linkTarget(record) {
  return join("runtime", "versions", record.directoryName);
}

function atomicLink(path, record) {
  ensureDirectory(dirname(path));
  if (existsSync(path) && !lstatSync(path).isSymbolicLink()) fail("UNSAFE_STATE");
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    symlinkSync(linkTarget(record), temporary);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function removeLink(path) {
  if (!entryExists(path)) return;
  if (!lstatSync(path).isSymbolicLink()) fail("UNSAFE_STATE");
  unlinkSync(path);
}

function assertLink(path, record) {
  if (!entryExists(path) || !lstatSync(path).isSymbolicLink()) fail("UNSAFE_STATE");
  if (readlinkSync(path) !== linkTarget(record)) fail("UNSAFE_STATE");
}

function entryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("UNSAFE_STATE");
  }
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildCaptureAgentLaunchAgentPlist({
  runtimeExecutablePath,
  entryPath,
  configPath,
  statePath,
  runtimeVersion,
  runtimeDigest,
} = {}) {
  for (const value of [runtimeExecutablePath, entryPath, configPath, statePath]) {
    if (typeof value !== "string" || !isAbsolute(value)) fail("UNSAFE_STATE");
  }
  if (!VERSION_RE.test(runtimeVersion) || !SHA256_RE.test(runtimeDigest)) {
    fail("UNSAFE_STATE");
  }
  const argumentsList = [
    runtimeExecutablePath,
    entryPath,
    "serve",
    "--config",
    configPath,
    "--agent-state",
    statePath,
    "--runtime-version",
    runtimeVersion,
    "--runtime-digest",
    runtimeDigest,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  ${PLUGIN_LAUNCH_AGENT_MARKER}
  <key>Label</key>
  <string>${CAPTURE_AGENT_LABEL}</string>
  <key>Program</key>
  <string>${xml(runtimeExecutablePath)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map((value) => `    <string>${xml(value)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

// systemd expands `%` specifiers and `${VAR}` references (even inside double
// quotes) before argument splitting and rejects control characters, so an
// installation path has to survive all three passes verbatim.
function systemdLiteral(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) fail("UNSAFE_STATE");
  return value.replaceAll("%", "%%").replaceAll("$", "$$$$");
}

function systemdArgument(value) {
  return `"${systemdLiteral(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')}"`;
}

export function buildCaptureAgentSystemdUnit({
  runtimeExecutablePath,
  entryPath,
  configPath,
  statePath,
  runtimeVersion,
  runtimeDigest,
} = {}) {
  for (const value of [runtimeExecutablePath, entryPath, configPath, statePath]) {
    if (typeof value !== "string" || !isAbsolute(value)) fail("UNSAFE_STATE");
  }
  if (!VERSION_RE.test(runtimeVersion) || !SHA256_RE.test(runtimeDigest)) {
    fail("UNSAFE_STATE");
  }
  const command = [
    runtimeExecutablePath,
    entryPath,
    "serve",
    "--config",
    configPath,
    "--agent-state",
    statePath,
    "--runtime-version",
    runtimeVersion,
    "--runtime-digest",
    runtimeDigest,
  ]
    .map(systemdArgument)
    .join(" ");
  // StartLimitIntervalSec=0 gives launchd KeepAlive semantics: the default
  // 5-starts-per-10s limit would park a briefly crash-looping relay in `failed`
  // for good, with nothing left to restart it. RestartSec matches launchd's
  // 10 s throttle, and TimeoutStopSec stays below the 10 s the lifecycle grants
  // a synchronous `systemctl stop`; the outboxes are durable, so a relay killed
  // mid-drain loses nothing.
  return `${PLUGIN_SYSTEMD_UNIT_MARKER}
# Unit: ${CAPTURE_AGENT_UNIT}
[Unit]
Description=Coredoc capture relay
After=default.target
StartLimitIntervalSec=0

[Service]
Type=simple
ExecStart=${command}
Restart=always
RestartSec=10
TimeoutStopSec=8
KillMode=mixed

[Install]
WantedBy=default.target
`;
}

function launchDomain(uid) {
  return `gui/${uid}`;
}

function launchService(uid, label = CAPTURE_AGENT_LABEL) {
  return `${launchDomain(uid)}/${label}`;
}

function launchctlServiceNotFound(error, uid, label) {
  return (
    error?.code === 113 &&
    typeof error.stderr === "string" &&
    error.stderr.includes(
      `Could not find service "${label}" in domain for user gui: ${uid}`,
    )
  );
}

function wantsLinkPath(paths) {
  return join(
    dirname(paths.servicePath),
    "default.target.wants",
    CAPTURE_AGENT_UNIT,
  );
}

function removeOwnedWantsLink(paths) {
  const link = wantsLinkPath(paths);
  let metadata;
  try {
    metadata = lstatSync(link);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail("UNSAFE_STATE");
  }
  if (!metadata.isSymbolicLink() || readlinkSync(link) !== paths.servicePath) {
    fail("OWNERSHIP_CONFLICT");
  }
  unlinkSync(link);
}

const LAUNCHD_SUPERVISOR = {
  directoryPolicy: "private",
  marker: PLUGIN_LAUNCH_AGENT_MARKER,
  legacyMarker: DESKTOP_LAUNCH_AGENT_MARKER,
  legacyLabel: DESKTOP_CAPTURE_AGENT_LABEL,
  buildDefinition: buildCaptureAgentLaunchAgentPlist,
  servicePaths(homeDir) {
    return {
      servicePath: join(
        homeDir,
        "Library",
        "LaunchAgents",
        `${CAPTURE_AGENT_LABEL}.plist`,
      ),
      legacyServicePath: join(
        homeDir,
        "Library",
        "LaunchAgents",
        `${DESKTOP_CAPTURE_AGENT_LABEL}.plist`,
      ),
    };
  },
  declaresLabel(content, label) {
    return (
      content.includes(`<key>Label</key><string>${label}</string>`) ||
      content.includes(`<key>Label</key>\n  <string>${label}</string>`)
    );
  },
  async start({ paths, uid, runCommand }) {
    await runCommand("/bin/launchctl", [
      "bootstrap",
      launchDomain(uid),
      paths.servicePath,
    ]);
  },
  async stop({ uid, runCommand }) {
    try {
      await runCommand("/bin/launchctl", ["bootout", launchService(uid)]);
      return;
    } catch {
      try {
        await runCommand("/bin/launchctl", ["print", launchService(uid)]);
      } catch (error) {
        if (launchctlServiceNotFound(error, uid, CAPTURE_AGENT_LABEL)) return;
        fail("SUPERVISOR_UNAVAILABLE");
      }
      fail("SUPERVISOR_UNAVAILABLE");
    }
  },
  async forget() {
    // launchd forgets a booted-out service immediately.
  },
  async isLoaded({ uid, runCommand, label }) {
    try {
      await runCommand("/bin/launchctl", ["print", launchService(uid, label)]);
      return true;
    } catch (error) {
      if (launchctlServiceNotFound(error, uid, label)) return false;
      fail("SUPERVISOR_UNAVAILABLE");
    }
  },
};

const SYSTEMD_SUPERVISOR = {
  directoryPolicy: "private-group",
  marker: PLUGIN_SYSTEMD_UNIT_MARKER,
  legacyMarker: null,
  legacyLabel: null,
  buildDefinition: buildCaptureAgentSystemdUnit,
  servicePaths(homeDir, env = {}) {
    // systemd.unit(5): the user manager reads $XDG_CONFIG_HOME/systemd/user in
    // place of ~/.config/systemd/user whenever that variable is set.
    const configured = env.XDG_CONFIG_HOME?.trim();
    const configHome =
      configured && isAbsolute(configured)
        ? resolve(configured)
        : join(homeDir, ".config");
    return {
      servicePath: join(configHome, "systemd", "user", CAPTURE_AGENT_UNIT),
      legacyServicePath: null,
    };
  },
  declaresLabel(content, label) {
    return content.includes(`\n# Unit: ${label}${SYSTEMD_UNIT_SUFFIX}\n`);
  },
  async start({ runCommand }) {
    // A rewritten unit file stays invisible to the user manager until it
    // reloads, so every activation reloads before enabling.
    await runCommand(SYSTEMCTL, ["--user", "daemon-reload"]);
    await runCommand(SYSTEMCTL, ["--user", "enable", "--now", CAPTURE_AGENT_UNIT]);
  },
  async stop({ paths, uid, runCommand }) {
    // A loaded unit outlives its file until the next reload, and `stop` exits
    // 5 for a unit that is not loaded, so each step is gated on what systemd
    // and the disk actually hold rather than on one another.
    const running = await this.isLoaded({
      paths,
      uid,
      runCommand,
      label: CAPTURE_AGENT_LABEL,
    });
    try {
      if (running) {
        await runCommand(SYSTEMCTL, ["--user", "stop", CAPTURE_AGENT_UNIT]);
      }
      if (readOptional(paths.servicePath) !== undefined) {
        await runCommand(SYSTEMCTL, ["--user", "disable", CAPTURE_AGENT_UNIT]);
      } else {
        // `enable` left this behind and `disable` cannot run without the unit
        // file; a dangling entry makes every login log a failed unit load.
        removeOwnedWantsLink(paths);
      }
    } catch (error) {
      if (error instanceof CaptureAgentLifecycleError) throw error;
      fail("SUPERVISOR_UNAVAILABLE");
    }
  },
  async forget({ runCommand }) {
    // The manager keeps a removed unit loaded until it reloads. Nothing of
    // ours is left to protect at this point, so a failed reload is not fatal.
    try {
      await runCommand(SYSTEMCTL, ["--user", "daemon-reload"]);
    } catch {
      // Best effort: the unit file is already gone.
    }
  },
  async isLoaded({ runCommand, label }) {
    if (label !== CAPTURE_AGENT_LABEL) fail("SUPERVISOR_UNAVAILABLE");
    let output;
    try {
      output = await runCommand(SYSTEMCTL, [
        "--user",
        "show",
        CAPTURE_AGENT_UNIT,
        "--property=ActiveState",
        "--value",
      ]);
    } catch {
      fail("SUPERVISOR_UNAVAILABLE");
    }
    if (typeof output !== "string") fail("SUPERVISOR_UNAVAILABLE");
    const state = output.trim();
    if (!SYSTEMD_ACTIVE_STATES.has(state)) fail("SUPERVISOR_UNAVAILABLE");
    return SYSTEMD_RUNNING_STATES.has(state);
  },
};

const CAPTURE_AGENT_SUPERVISORS = new Map([
  ["darwin", LAUNCHD_SUPERVISOR],
  ["linux", SYSTEMD_SUPERVISOR],
]);

function captureAgentSupervisor(platform) {
  const supervisor = CAPTURE_AGENT_SUPERVISORS.get(platform);
  if (supervisor === undefined) fail("UNSUPPORTED_PLATFORM");
  return supervisor;
}

function definitionOwnership(
  content,
  { supervisor, label, marker, otherMarker, ownership },
) {
  if (content === undefined) return "absent";
  if (!supervisor.declaresLabel(content, label)) return "foreign";
  const expectedMarker = content.includes(marker);
  const conflictingMarker =
    otherMarker !== null && content.includes(otherMarker);
  return expectedMarker && !conflictingMarker ? ownership : "foreign";
}

// Only macOS ever had a Desktop-managed relay, so a host without that namespace
// reads as permanently absent rather than as an unreadable path.
function readLegacyDefinition(paths) {
  return paths.legacyServicePath === null
    ? undefined
    : readOptional(paths.legacyServicePath);
}

function serviceOwnership(paths, supervisor) {
  const content = readOptional(paths.servicePath);
  const legacyContent = readLegacyDefinition(paths);
  return {
    content,
    legacyContent,
    ownership: definitionOwnership(content, {
      supervisor,
      label: CAPTURE_AGENT_LABEL,
      marker: supervisor.marker,
      otherMarker: supervisor.legacyMarker,
      ownership: "plugin-v1",
    }),
    legacyOwnership: definitionOwnership(legacyContent, {
      supervisor,
      label: supervisor.legacyLabel,
      marker: supervisor.legacyMarker,
      otherMarker: supervisor.marker,
      ownership: "desktop-v1",
    }),
  };
}

function assertServiceDefinitionMatches(paths, expectedContents) {
  const current = readOptional(paths.servicePath);
  if (!expectedContents.some((expected) => current === expected)) {
    fail("OWNERSHIP_CONFLICT");
  }
  return current;
}

function ownedRuntimeDirectory(path, uid) {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === uid;
  } catch {
    return false;
  }
}

export function supervisorEnvironment(
  env,
  { uid, runtimeDirectoryFor = (id) => `/run/user/${id}` } = {},
) {
  const forwarded = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const name of SUPERVISOR_ENVIRONMENT) {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) continue;
    if (name === "XDG_RUNTIME_DIR" && !isAbsolute(value)) continue;
    forwarded[name] = value;
  }
  // A shell reached through su, tmux, or a bare SSH session can lack the
  // variable while the user manager is up; /run/user/<uid> is what systemd
  // itself assumes in that case.
  if (forwarded.XDG_RUNTIME_DIR === undefined && Number.isInteger(uid) && uid >= 0) {
    const fallback = runtimeDirectoryFor(uid);
    if (ownedRuntimeDirectory(fallback, uid)) forwarded.XDG_RUNTIME_DIR = fallback;
  }
  return forwarded;
}

function defaultRunCommand(executable, args, { env, uid }) {
  return execFileAsync(executable, args, {
    timeout: 10_000,
    env: supervisorEnvironment(env, { uid }),
  }).then(({ stdout }) => stdout);
}

async function defaultProbeListener() {
  try {
    const response = await fetch(`http://127.0.0.1:${MANAGED_RELAY_PORT}/health`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(500),
    });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export function validateCaptureAgentHealthV2(value, expected) {
  const candidate = exactObject(
    value,
    new Set([
      "schemaVersion",
      "state",
      "runtimeVersion",
      "runtimeDigest",
      "protocolVersion",
      "configSchemaVersion",
      "fixedWorkspaceHash",
      "hostIngress",
      "queueCounts",
      "lastSuccessfulDeliveryAt",
      "repositoryAttribution",
      "degradedReasons",
    ]),
    "HEALTH_MISMATCH",
  );
  const hostIngress = exactObject(
    candidate.hostIngress,
    new Set(["claudeCode", "codex"]),
    "HEALTH_MISMATCH",
  );
  const queueCounts = exactObject(
    candidate.queueCounts,
    new Set(["native", "semantic", "artifact", "agent", "total"]),
    "HEALTH_MISMATCH",
  );
  const queueValues = [
    queueCounts.native,
    queueCounts.semantic,
    queueCounts.artifact,
    queueCounts.agent,
  ];
  const queueCount = (entry) =>
    entry === null ||
    (Number.isInteger(entry) && entry >= 0 && entry <= 1_000_000);
  const allQueueCountsKnown = queueValues.every(Number.isInteger);
  const reasons = candidate.degradedReasons;
  if (
    candidate.schemaVersion !== 2 ||
    !new Set(["ready", "degraded"]).has(candidate.state) ||
    candidate.runtimeVersion !== expected.runtimeVersion ||
    candidate.runtimeDigest !== expected.runtimeDigest ||
    candidate.protocolVersion !== AGENT_PROTOCOL_VERSION ||
    candidate.configSchemaVersion !== RELAY_CONFIG_SCHEMA_VERSION ||
    (candidate.fixedWorkspaceHash !== null &&
      (typeof candidate.fixedWorkspaceHash !== "string" ||
        !SHA256_RE.test(candidate.fixedWorkspaceHash))) ||
    ![hostIngress.claudeCode, hostIngress.codex].every((entry) =>
      new Set(["ready", "unconfigured", "unknown"]).has(entry),
    ) ||
    !queueValues.every(queueCount) ||
    !queueCount(queueCounts.total) ||
    (allQueueCountsKnown
      ? queueCounts.total !== queueValues.reduce((total, entry) => total + entry, 0)
      : queueCounts.total !== null) ||
    (candidate.lastSuccessfulDeliveryAt !== null &&
      (typeof candidate.lastSuccessfulDeliveryAt !== "string" ||
        !ISO_TIMESTAMP_RE.test(candidate.lastSuccessfulDeliveryAt) ||
        Number.isNaN(Date.parse(candidate.lastSuccessfulDeliveryAt)))) ||
    !new Set(["ready", "degraded", "unavailable", "unknown"]).has(
      candidate.repositoryAttribution,
    ) ||
    !Array.isArray(reasons) ||
    reasons.length > 16 ||
    reasons.some(
      (reason) =>
        typeof reason !== "string" || !HEALTH_DEGRADED_REASONS.has(reason),
    ) ||
    new Set(reasons).size !== reasons.length ||
    JSON.stringify(reasons) !== JSON.stringify([...reasons].sort()) ||
    (candidate.state === "ready") !== (reasons.length === 0)
  ) {
    fail("HEALTH_MISMATCH");
  }
  return {
    schemaVersion: 2,
    state: candidate.state,
    runtimeVersion: candidate.runtimeVersion,
    runtimeDigest: candidate.runtimeDigest,
    protocolVersion: AGENT_PROTOCOL_VERSION,
    configSchemaVersion: RELAY_CONFIG_SCHEMA_VERSION,
    fixedWorkspaceHash: candidate.fixedWorkspaceHash,
    hostIngress: { ...hostIngress },
    queueCounts: { ...queueCounts },
    lastSuccessfulDeliveryAt: candidate.lastSuccessfulDeliveryAt,
    repositoryAttribution: candidate.repositoryAttribution,
    degradedReasons: [...reasons],
  };
}

async function defaultProbeHealth(expected) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${MANAGED_RELAY_PORT}/health/v2`, {
      method: "GET",
      redirect: "error",
      headers: { "X-Coredoc-Agent-Health": expected.token },
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) fail("HEALTH_MISMATCH");
    return validateCaptureAgentHealthV2(await response.json(), expected);
  } catch (error) {
    if (error instanceof CaptureAgentLifecycleError) throw error;
    fail("HEALTH_MISMATCH");
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

function sameLockIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateLifecycleLockFile(path, descriptor, uid) {
  let opened;
  let visible;
  try {
    opened = fstatSync(descriptor);
    visible = lstatSync(path);
  } catch {
    fail("LOCKED");
  }
  if (
    !opened.isFile() ||
    !visible.isFile() ||
    visible.isSymbolicLink() ||
    opened.nlink !== 1 ||
    visible.nlink !== 1 ||
    (opened.mode & 0o777) !== 0o600 ||
    (visible.mode & 0o777) !== 0o600 ||
    opened.uid !== uid ||
    visible.uid !== uid ||
    !sameLockIdentity(opened, visible)
  ) {
    fail("LOCKED");
  }
}

function lockCommand() {
  if (process.platform === "darwin") {
    return { executable: "/usr/bin/lockf", args: ["-s", "-t", "0", "3"] };
  }
  if (process.platform === "linux") {
    return { executable: "/usr/bin/flock", args: ["-n", "3"] };
  }
  fail("LOCKED");
}

export function acquireCaptureAgentFileLock(
  path,
  { uid = typeof process.getuid === "function" ? process.getuid() : -1 } = {},
) {
  if (!Number.isInteger(uid) || uid < 0) fail("LOCKED");
  let descriptor;
  let acquired = false;
  ensureDirectory(dirname(path));
  try {
    descriptor = openSync(
      path,
      fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    validateLifecycleLockFile(path, descriptor, uid);
    const command = lockCommand();
    const result = spawnSync(command.executable, command.args, {
      stdio: ["ignore", "ignore", "ignore", descriptor],
      timeout: 2_000,
    });
    if (result.error || result.signal !== null || result.status !== 0) {
      fail("LOCKED");
    }
    validateLifecycleLockFile(path, descriptor, uid);
    acquired = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        closeSync(descriptor);
      } catch {
        // Closing an already invalidated descriptor cannot authorize mutation.
      }
    };
  } catch (error) {
    if (error instanceof CaptureAgentLifecycleError) throw error;
    fail("LOCKED");
  } finally {
    if (!acquired && descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The bounded LOCKED result remains authoritative.
      }
    }
  }
}

function installedDirectory(paths, record) {
  return join(paths.runtimeVersionsDirectory, record.directoryName);
}

function removeInstalledRuntime(paths, record, { allowPartial = false } = {}) {
  const directory = installedDirectory(paths, record);
  if (!existsSync(directory)) return;
  if (allowPartial) verifyPartiallyRemovedRuntime(directory, record);
  else verifyInstalledRuntime(directory, record);
  for (const entry of immutableDirectoryEntries(directory).sort(
    (left, right) => right.path.length - left.path.length,
  )) {
    if (entry.directory) chmodSync(entry.path, 0o700);
    else chmodSync(entry.path, 0o600);
  }
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true });
}

function writeRuntimeLinks(paths, state) {
  if (state.previous === null) removeLink(paths.previousPath);
  else atomicLink(paths.previousPath, state.previous);
  atomicLink(paths.currentPath, state.current);
}

// A home directory shared between hosts (NFS, dual boot) can present another
// platform's install as ours; its runner would then exit 70 in a restart loop.
function assertHostRuntime(record, platformKey) {
  if (record === null) return;
  const executable = BUNDLED_RUNTIME_EXECUTABLES.get(platformKey);
  if (!record.files.some(({ path }) => path === executable)) {
    fail("UNSUPPORTED_PLATFORM");
  }
}

function validateInstalledState(paths, state, platformKey) {
  assertHostRuntime(state.current, platformKey);
  assertHostRuntime(state.previous, platformKey);
  verifyInstalledRuntime(installedDirectory(paths, state.current), state.current);
  assertLink(paths.currentPath, state.current);
  if (state.previous === null) {
    if (existsSync(paths.previousPath)) fail("UNSAFE_STATE");
  } else {
    verifyInstalledRuntime(installedDirectory(paths, state.previous), state.previous);
    assertLink(paths.previousPath, state.previous);
  }
}

function validatePartiallyUninstalledState(paths, state, platformKey) {
  assertHostRuntime(state.current, platformKey);
  assertHostRuntime(state.previous, platformKey);
  for (const record of [state.current, state.previous]) {
    if (record === null) continue;
    const directory = installedDirectory(paths, record);
    if (entryExists(directory)) verifyPartiallyRemovedRuntime(directory, record);
  }
  if (entryExists(paths.currentPath)) assertLink(paths.currentPath, state.current);
  if (state.previous === null) {
    if (entryExists(paths.previousPath)) fail("UNSAFE_STATE");
  } else if (entryExists(paths.previousPath)) {
    assertLink(paths.previousPath, state.previous);
  }
}

function verifyPartiallyRemovedRuntime(directory, record) {
  const root = lstatSync(directory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    !new Set([0o555, 0o700]).has(root.mode & 0o777) ||
    (typeof process.getuid === "function" && root.uid !== process.getuid())
  ) {
    fail("UNSAFE_STATE");
  }
  const expectedFiles = new Map(
    record.files.map((file) => [
      file.path,
      { sha256: file.sha256, mode: runtimeFileMode(file.path) },
    ]),
  );
  const expectedDirectories = new Set();
  for (const file of record.files) {
    const segments = file.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  for (const entry of immutableDirectoryEntries(directory)) {
    const metadata = lstatSync(entry.path);
    if (
      (typeof process.getuid === "function" && metadata.uid !== process.getuid()) ||
      (entry.directory &&
        (!expectedDirectories.has(entry.relativePath) ||
          !new Set([0o555, 0o700]).has(metadata.mode & 0o777))) ||
      (!entry.directory &&
        (!expectedFiles.has(entry.relativePath) ||
          !new Set([
            expectedFiles.get(entry.relativePath)?.mode,
            0o600,
          ]).has(metadata.mode & 0o777) ||
          sha256(readFileSync(entry.path)) !==
            expectedFiles.get(entry.relativePath)?.sha256))
    ) {
      fail("UNSAFE_STATE");
    }
  }
}

function lifecyclePurgeProof(value) {
  const candidate = exactObject(
    value,
    new Set(["schemaVersion", "stateSha256", "launchAgentSha256"]),
  );
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.stateSha256 !== "string" ||
    !SHA256_RE.test(candidate.stateSha256) ||
    typeof candidate.launchAgentSha256 !== "string" ||
    !SHA256_RE.test(candidate.launchAgentSha256)
  ) {
    fail("UNSAFE_STATE");
  }
  return { ...candidate };
}

// One retry after a short pause is lifecycle policy, not a supervisor detail:
// both launchd and systemd occasionally reject an activation that lands in the
// same instant as the previous teardown.
async function startService({ paths, supervisor, uid, runCommand, wait }) {
  try {
    await supervisor.start({ paths, uid, runCommand });
  } catch {
    await wait(SERVICE_START_RETRY_DELAY_MS);
    try {
      await supervisor.start({ paths, uid, runCommand });
    } catch {
      fail("SUPERVISOR_UNAVAILABLE");
    }
  }
}

async function isServiceLoaded({
  paths,
  supervisor,
  uid,
  runCommand,
  label = CAPTURE_AGENT_LABEL,
}) {
  return supervisor.isLoaded({ paths, uid, runCommand, label });
}

async function waitForListenerDown({ probeListener, wait }) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (!(await probeListener())) return;
    } catch {
      fail("SUPERVISOR_UNAVAILABLE");
    }
    if (attempt + 1 < 20) await wait(100);
  }
  fail("SUPERVISOR_UNAVAILABLE");
}

async function waitForPluginStop({
  paths,
  supervisor,
  uid,
  runCommand,
  probeListener,
  wait,
}) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      if (!(await probeListener())) return;
    } catch {
      fail("SUPERVISOR_UNAVAILABLE");
    }
    if (attempt + 1 < 20) await wait(100);
  }

  const { ownership, legacyOwnership } = serviceOwnership(paths, supervisor);
  if (ownership !== "plugin-v1" || legacyOwnership !== "desktop-v1") {
    fail("SUPERVISOR_UNAVAILABLE");
  }
  if (
    await isServiceLoaded({ paths, supervisor, uid, runCommand }) ||
    !(await isServiceLoaded({
      paths,
      supervisor,
      uid,
      runCommand,
      label: DESKTOP_CAPTURE_AGENT_LABEL,
    }))
  ) {
    fail("SUPERVISOR_UNAVAILABLE");
  }
}

function desiredDefinition({ paths, supervisor, state }) {
  const installed = installedDirectory(paths, state.current);
  return supervisor.buildDefinition({
    runtimeExecutablePath: installedRuntimeExecutable(installed),
    entryPath: join(installed, state.current.entry),
    configPath: paths.relayConfigPath,
    statePath: paths.statePath,
    runtimeVersion: state.current.version,
    runtimeDigest: state.current.digest,
  });
}

async function installAndStart({
  paths,
  supervisor,
  uid,
  runCommand,
  wait,
  definition,
  oldDefinition,
}) {
  assertServiceDefinitionMatches(paths, [oldDefinition]);
  if (oldDefinition !== undefined) {
    await supervisor.stop({ paths, uid, runCommand });
    assertServiceDefinitionMatches(paths, [oldDefinition]);
  }
  atomicWrite(paths.servicePath, definition, 0o600, supervisor.directoryPolicy);
  assertServiceDefinitionMatches(paths, [definition]);
  await startService({ paths, supervisor, uid, runCommand, wait });
  assertServiceDefinitionMatches(paths, [definition]);
}

async function installWithoutStart({
  paths,
  supervisor,
  uid,
  runCommand,
  wait,
  probeListener,
  definition,
  oldDefinition,
}) {
  assertServiceDefinitionMatches(paths, [oldDefinition]);
  await supervisor.stop({ paths, uid, runCommand });
  assertServiceDefinitionMatches(paths, [oldDefinition]);
  await waitForPluginStop({
    paths,
    supervisor,
    uid,
    runCommand,
    probeListener,
    wait,
  });
  assertServiceDefinitionMatches(paths, [oldDefinition]);
  atomicWrite(paths.servicePath, definition, 0o600, supervisor.directoryPolicy);
  assertServiceDefinitionMatches(paths, [definition]);
  if (await isServiceLoaded({ paths, supervisor, uid, runCommand })) {
    fail("SUPERVISOR_UNAVAILABLE");
  }
}

async function verifyHealthWithRetry({ state, probeHealth, wait }) {
  const expected = {
    token: state.healthToken,
    runtimeVersion: state.current.version,
    runtimeDigest: state.current.digest,
  };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const health = healthDiagnosticState(await probeHealth(expected));
      // A validated degraded response still proves the newly activated runtime,
      // protocol, configuration identity, and health capability. Operational
      // degradation is surfaced by status; it is not an activation rollback.
      if (health.state !== "ready" && health.state !== "degraded") {
        fail("HEALTH_MISMATCH");
      }
      return;
    } catch {
      if (attempt + 1 < 10) await wait(100);
    }
  }
  fail("HEALTH_MISMATCH");
}

function healthDiagnosticState(value) {
  if (value === undefined) return { state: "ready", degradedReasons: [] };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !new Set(["ready", "degraded"]).has(value.state) ||
    !Array.isArray(value.degradedReasons) ||
    value.degradedReasons.length > 16 ||
    value.degradedReasons.some(
      (reason) =>
        typeof reason !== "string" || !HEALTH_DEGRADED_REASONS.has(reason),
    ) ||
    new Set(value.degradedReasons).size !== value.degradedReasons.length ||
    JSON.stringify(value.degradedReasons) !==
      JSON.stringify([...value.degradedReasons].sort()) ||
    (value.state === "ready") !== (value.degradedReasons.length === 0)
  ) {
    fail("HEALTH_MISMATCH");
  }
  return {
    state: value.state,
    degradedReasons: [...value.degradedReasons],
  };
}

async function restoreSnapshot({
  paths,
  supervisor,
  oldDefinition,
  oldLoaded,
  transactionDefinition,
  oldStateRaw,
  oldState,
  uid,
  runCommand,
  wait,
  probeHealth,
  probeListener,
}) {
  try {
    const transactionDefinitions = [oldDefinition, transactionDefinition];
    assertServiceDefinitionMatches(paths, transactionDefinitions);
    await supervisor.stop({ paths, uid, runCommand });
    assertServiceDefinitionMatches(paths, transactionDefinitions);
    await waitForPluginStop({
      paths,
      supervisor,
      uid,
      runCommand,
      probeListener,
      wait,
    });
    assertServiceDefinitionMatches(paths, transactionDefinitions);
    if (oldState === null) {
      removeLink(paths.currentPath);
      removeLink(paths.previousPath);
      if (existsSync(paths.statePath)) unlinkSync(paths.statePath);
    } else {
      writeRuntimeLinks(paths, oldState);
      atomicWrite(paths.statePath, oldStateRaw, 0o600);
    }
    if (oldDefinition === undefined) {
      const currentDefinition = assertServiceDefinitionMatches(
        paths,
        transactionDefinitions,
      );
      if (currentDefinition !== undefined) {
        unlinkSync(paths.servicePath);
        await supervisor.forget({ runCommand });
      }
    } else {
      assertServiceDefinitionMatches(paths, transactionDefinitions);
      atomicWrite(paths.servicePath, oldDefinition, 0o600, supervisor.directoryPolicy);
      assertServiceDefinitionMatches(paths, [oldDefinition]);
      if (oldLoaded) {
        await startService({ paths, supervisor, uid, runCommand, wait });
        assertServiceDefinitionMatches(paths, [oldDefinition]);
        if (oldState === null) {
          if (!(await probeListener())) fail("ROLLBACK_FAILED");
        } else {
          await verifyHealthWithRetry({ state: oldState, probeHealth, wait });
        }
      } else if (await isServiceLoaded({ paths, supervisor, uid, runCommand })) {
        fail("ROLLBACK_FAILED");
      }
    }
  } catch {
    fail("ROLLBACK_FAILED");
  }
}

function captureStateInventory(paths) {
  const roots = [
    { path: join(paths.relayRoot, "outbox"), kind: "semantic" },
    { path: join(paths.relayRoot, "artifact-outbox"), kind: "artifact" },
    { path: join(paths.agentRoot, "outbox"), kind: "agent" },
  ];
  const pending = [];
  const removableFiles = [];
  const removableDirectories = [];
  let visited = 0;
  const expectedUid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const pathPresent = (path) => {
    try {
      lstatSync(path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      fail("UNSAFE_STATE");
    }
  };
  const visit = (root, directory, kind) => {
    if (!pathPresent(directory)) return;
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o022) !== 0 ||
      (expectedUid !== undefined && metadata.uid !== expectedUid)
    ) {
      fail("UNSAFE_STATE");
    }
    removableDirectories.push(directory);
    for (const name of readdirSync(directory)) {
      visited += 1;
      if (visited > MAX_QUEUE_ENTRIES) fail("UNSAFE_STATE");
      const path = join(directory, name);
      const child = lstatSync(path);
      if (child.isSymbolicLink()) fail("UNSAFE_STATE");
      if (child.isDirectory()) {
        if (kind !== "agent" && directory === root && !SHA256_RE.test(name)) {
          fail("UNSAFE_STATE");
        }
        if (kind !== "agent" && directory !== root) fail("UNSAFE_STATE");
        visit(root, path, kind);
        continue;
      }
      if (
        !child.isFile() ||
        child.nlink !== 1 ||
        (child.mode & 0o077) !== 0 ||
        (expectedUid !== undefined && child.uid !== expectedUid)
      ) {
        fail("UNSAFE_STATE");
      }
      if (kind === "semantic") {
        if (EVENT_ENTRY_RE.test(name)) pending.push(path);
        else if (name !== "capture-health.json") fail("UNSAFE_STATE");
      } else if (kind === "artifact") {
        if (ARTIFACT_ENTRY_RE.test(name)) pending.push(path);
        else if (
          name !== "state.json" &&
          !ARTIFACT_QUARANTINE_ENTRY_RE.test(name)
        ) {
          fail("UNSAFE_STATE");
        }
      } else if (name.endsWith(".json")) {
        pending.push(path);
      } else {
        fail("UNSAFE_STATE");
      }
      removableFiles.push(path);
    }
  };
  for (const root of roots) visit(root.path, root.path, root.kind);

  const nativeRoot = join(paths.relayRoot, "native-outbox");
  const nativeDirectory = (path) => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      fail("UNSAFE_STATE");
    }
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o700 ||
      (expectedUid !== undefined && metadata.uid !== expectedUid)
    ) {
      fail("UNSAFE_STATE");
    }
  };
  const nativeFile = (path, maximumBytes) => {
    let metadata;
    try {
      metadata = lstatSync(path);
    } catch {
      fail("UNSAFE_STATE");
    }
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size > maximumBytes ||
      (metadata.mode & 0o777) !== 0o600 ||
      (expectedUid !== undefined && metadata.uid !== expectedUid)
    ) {
      fail("UNSAFE_STATE");
    }
  };
  if (pathPresent(nativeRoot)) {
    nativeDirectory(nativeRoot);
    removableDirectories.push(nativeRoot);
    for (const bindingId of readdirSync(nativeRoot).sort()) {
      visited += 1;
      if (visited > MAX_QUEUE_ENTRIES || !NATIVE_OUTBOX_BINDING_RE.test(bindingId)) {
        fail("UNSAFE_STATE");
      }
      const bindingDirectory = join(nativeRoot, bindingId);
      nativeDirectory(bindingDirectory);
      removableDirectories.push(bindingDirectory);
      for (const name of readdirSync(bindingDirectory).sort()) {
        visited += 1;
        if (visited > MAX_QUEUE_ENTRIES) fail("UNSAFE_STATE");
        const path = join(bindingDirectory, name);
        if (name === "state.json") {
          nativeFile(path, MAX_NATIVE_OUTBOX_STATE_BYTES);
          removableFiles.push(path);
          continue;
        }
        if (!NATIVE_OUTBOX_RECORD_RE.test(name)) fail("UNSAFE_STATE");
        nativeFile(path, MAX_NATIVE_OUTBOX_RECORD_BYTES);
        pending.push(path);
        removableFiles.push(path);
      }
    }
  }

  const auxiliaryFiles = [
    {
      path: join(paths.relayRoot, "codex-attribution-state.json"),
      maximumBytes: MAX_CODEX_ATTRIBUTION_STATE_BYTES,
    },
    {
      path: join(paths.relayRoot, "codex-relay-events.jsonl"),
      maximumBytes: MAX_CODEX_JOURNAL_BYTES,
    },
    {
      path: join(paths.relayRoot, "codex-relay-events.jsonl.1"),
      maximumBytes: MAX_CODEX_JOURNAL_BYTES,
    },
  ];
  for (const file of auxiliaryFiles) {
    if (!pathPresent(file.path)) continue;
    nativeFile(file.path, file.maximumBytes);
    removableFiles.push(file.path);
  }

  return { pending, removableFiles, removableDirectories };
}

function pendingQueueEntries(paths) {
  return captureStateInventory(paths).pending;
}

function purgeCaptureState(paths) {
  const inventory = captureStateInventory(paths);
  for (const path of inventory.removableFiles) unlinkSync(path);
  for (const path of inventory.removableDirectories.sort(
    (left, right) => right.length - left.length,
  )) {
    try {
      rmdirSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") fail("UNSAFE_STATE");
    }
  }
  return inventory.pending.length;
}

function removeEmptyDirectory(path) {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
  }
}

export function createCaptureAgentLifecycle({
  env = process.env,
  homeDir = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(),
  pluginRoot = dirname(dirname(fileURLToPath(import.meta.url))),
  platform = process.platform,
  arch = process.arch,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  loadRuntimeBundle: loadBundle = () =>
    loadRuntimeBundle({
      pluginRoot,
      platformKey: captureAgentPlatformKey({ platform, arch }),
    }),
  runCommand = (executable, args) => defaultRunCommand(executable, args, { env, uid }),
  probeListener = defaultProbeListener,
  probeHealth = defaultProbeHealth,
  importSmoke = defaultImportSmoke,
  renameRuntime = renameSync,
  acquireFileLock = acquireCaptureAgentFileLock,
  randomToken = () => randomBytes(32).toString("base64url"),
  wait = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
} = {}) {
  const paths = captureAgentPaths({ env, homeDir, platform });
  const supervisor = captureAgentSupervisor(platform);

  function environment() {
    if (!Number.isInteger(uid) || uid < 0) fail("SUPERVISOR_UNAVAILABLE");
    captureAgentPlatformKey({ platform, arch });
  }

  function hostPlatformKey() {
    return captureAgentPlatformKey({ platform, arch });
  }

  async function withLock(operation) {
    const release = acquireFileLock(paths.lockPath, { uid });
    try {
      return await operation();
    } finally {
      release();
    }
  }

  function ownedPluginService() {
    const ownership = serviceOwnership(paths, supervisor);
    if (ownership.ownership === "foreign") fail("OWNERSHIP_CONFLICT");
    return ownership;
  }

  function activationOwnership() {
    const ownership = ownedPluginService();
    if (ownership.legacyOwnership !== "absent") {
      fail("OWNERSHIP_CONFLICT");
    }
    return ownership;
  }

  function assertDefinitionMatches(expectedContents) {
    return assertServiceDefinitionMatches(paths, expectedContents);
  }

  async function activateBundle(action, { requireInstalled = false } = {}) {
    environment();
    return withLock(async () => {
      const initialOwnership = activationOwnership();
      const { content: oldDefinition, legacyContent: oldLegacyDefinition, ownership } =
        initialOwnership;
      const oldState = readAgentState(paths.statePath, { optional: true });
      if (requireInstalled && oldState === null) fail("NOT_INSTALLED");
      if (
        oldState === null && ownership === "plugin-v1"
      ) {
        fail("OWNERSHIP_CONFLICT");
      }
      if (ownership === "absent" && (await probeListener())) {
        fail("FOREIGN_LISTENER");
      }
      if (oldState !== null) validateInstalledState(paths, oldState, hostPlatformKey());
      const oldLoaded =
        ownership === "plugin-v1"
          ? await isServiceLoaded({ paths, supervisor, uid, runCommand })
          : false;
      const bundle = normalizeRuntimeBundle(await loadBundle());
      assertDefinitionMatches([oldDefinition]);
      if (readLegacyDefinition(paths) !== oldLegacyDefinition) {
        fail("OWNERSHIP_CONFLICT");
      }
      const staged = await stageRuntime({
        bundle,
        paths,
        importSmoke,
        renameRuntime,
      });
      const oldStateRaw =
        oldState === null ? undefined : readFileSync(paths.statePath, "utf8");
      const healthToken = oldState?.healthToken ?? randomToken();
      if (!HEALTH_TOKEN_RE.test(healthToken)) fail("UNSAFE_STATE");
      const sameRuntime =
        oldState?.current.directoryName === staged.record.directoryName;
      const nextState = agentState({
        schemaVersion: AGENT_STATE_SCHEMA_VERSION,
        marker: AGENT_STATE_MARKER,
        healthToken,
        current: staged.record,
        previous: sameRuntime
          ? oldState?.previous ?? null
          : oldState?.current ?? null,
      });
      let mutated = false;
      const definition = desiredDefinition({ paths, supervisor, state: nextState });
      try {
        assertDefinitionMatches([oldDefinition]);
        mutated = true;
        writeRuntimeLinks(paths, nextState);
        writeAgentState(paths.statePath, nextState);
        await installAndStart({
          paths,
          supervisor,
          uid,
          runCommand,
          wait,
          definition,
          oldDefinition,
        });
        await verifyHealthWithRetry({ state: nextState, probeHealth, wait });
        assertDefinitionMatches([definition]);
        if (
          oldState?.previous &&
          oldState.previous.directoryName !== nextState.current.directoryName &&
          oldState.previous.directoryName !== nextState.previous?.directoryName
        ) {
          try {
            removeInstalledRuntime(paths, oldState.previous);
          } catch {
            // The activation is already committed and healthy; the retired
            // runtime is unreferenced, so a failed cleanup must not roll the
            // upgrade back. The leftover directory is inert and harmless.
          }
        }
        return {
          schemaVersion: 1,
          status: "ready",
          action,
          current: publicRuntime(nextState.current),
          previous: publicRuntime(nextState.previous),
        };
      } catch (error) {
        if (mutated) {
          try {
            await restoreSnapshot({
              paths,
              supervisor,
              oldDefinition,
              oldLoaded,
              transactionDefinition: definition,
              oldStateRaw,
              oldState,
              uid,
              runCommand,
              wait,
              probeHealth,
              probeListener,
            });
            if (staged.created) removeInstalledRuntime(paths, staged.record);
          } catch {
            fail("ROLLBACK_FAILED", { rollback: "failed" });
          }
          const code =
            error instanceof CaptureAgentLifecycleError
              ? error.code
              : "HEALTH_MISMATCH";
          throw new CaptureAgentLifecycleError(code, { rollback: "restored" });
        }
        if (staged.created) removeInstalledRuntime(paths, staged.record);
        throw error;
      }
    });
  }

  async function setupRuntime() {
    return activateBundle("setup-runtime");
  }

  async function startInstalledRuntime() {
    environment();
    return withLock(async () => {
      const { content: definition, ownership } = activationOwnership();
      const state = readAgentState(paths.statePath, { optional: true });
      if (state === null || ownership !== "plugin-v1") {
        fail("OWNERSHIP_CONFLICT");
      }
      validateInstalledState(paths, state, hostPlatformKey());
      const alreadyLoaded = await isServiceLoaded({ paths, supervisor, uid, runCommand });
      try {
        if (!alreadyLoaded) {
          assertDefinitionMatches([definition]);
          await startService({ paths, supervisor, uid, runCommand, wait });
          assertDefinitionMatches([definition]);
        }
        await verifyHealthWithRetry({ state, probeHealth, wait });
        assertDefinitionMatches([definition]);
      } catch (error) {
        if (!alreadyLoaded) {
          try {
            assertDefinitionMatches([definition]);
            await supervisor.stop({ paths, uid, runCommand });
            await waitForListenerDown({ probeListener, wait });
          } catch {
            // Preserve the activation error without touching a replaced definition.
          }
        }
        throw error;
      }
      return {
        schemaVersion: 1,
        status: "ready",
        action: "start-installed-runtime",
        current: publicRuntime(state.current),
        previous: publicRuntime(state.previous),
      };
    });
  }

  async function upgrade() {
    return activateBundle("upgrade", { requireInstalled: true });
  }

  async function rollback({ start = true } = {}) {
    environment();
    if (typeof start !== "boolean") fail("INVALID_ARGUMENTS");
    return withLock(async () => {
      const { content: oldDefinition, ownership } = activationOwnership();
      if (ownership !== "plugin-v1") fail("OWNERSHIP_CONFLICT");
      const oldState = readAgentState(paths.statePath);
      validateInstalledState(paths, oldState, hostPlatformKey());
      if (oldState.previous === null) fail("NO_PREVIOUS_RUNTIME");
      const oldStateRaw = readFileSync(paths.statePath, "utf8");
      const oldLoaded = await isServiceLoaded({ paths, supervisor, uid, runCommand });
      const nextState = agentState({
        ...oldState,
        current: oldState.previous,
        previous: oldState.current,
      });
      const definition = desiredDefinition({ paths, supervisor, state: nextState });
      let mutated = false;
      try {
        assertDefinitionMatches([oldDefinition]);
        mutated = true;
        writeRuntimeLinks(paths, nextState);
        writeAgentState(paths.statePath, nextState);
        if (start) {
          await installAndStart({
            paths,
            supervisor,
            uid,
            runCommand,
            wait,
            definition,
            oldDefinition,
          });
          await verifyHealthWithRetry({ state: nextState, probeHealth, wait });
        } else {
          await installWithoutStart({
            paths,
            supervisor,
            uid,
            runCommand,
            wait,
            probeListener,
            definition,
            oldDefinition,
          });
        }
        assertDefinitionMatches([definition]);
        return {
          schemaVersion: 1,
          status: start ? "ready" : "disabled",
          action: "rollback",
          current: publicRuntime(nextState.current),
          previous: publicRuntime(nextState.previous),
        };
      } catch (error) {
        if (!mutated) throw error;
        try {
          await restoreSnapshot({
            paths,
            supervisor,
            oldDefinition,
            oldLoaded,
            transactionDefinition: definition,
            oldStateRaw,
            oldState,
            uid,
            runCommand,
            wait,
            probeHealth,
            probeListener,
          });
        } catch {
          fail("ROLLBACK_FAILED", { rollback: "failed" });
        }
        const code =
          error instanceof CaptureAgentLifecycleError
            ? error.code
            : "HEALTH_MISMATCH";
        throw new CaptureAgentLifecycleError(code, { rollback: "restored" });
      }
    });
  }

  async function status() {
    environment();
    const state = readAgentState(paths.statePath, { optional: true });
    const { ownership, legacyOwnership } = serviceOwnership(paths, supervisor);
    const listener = (await probeListener()) ? "occupied" : "free";
    let pendingCount = 0;
    let queueState = "empty";
    const degradedReasons = new Set();
    try {
      pendingCount = pendingQueueEntries(paths).length;
      if (pendingCount > 0) {
        queueState = "pending";
        degradedReasons.add("QUEUE_PENDING");
      }
    } catch {
      pendingCount = null;
      queueState = "unsafe";
      degradedReasons.add("QUEUE_UNSAFE");
    }
    if (state === null) {
      return {
        schemaVersion: 1,
        status: queueState === "unsafe" ? "degraded" : "not-installed",
        runtime: null,
        previousRuntime: null,
        launchAgent: ownership,
        desktopLaunchAgent: legacyOwnership,
        listener,
        health: "not-installed",
        pendingCount,
        queueState,
        degradedReasons: [...degradedReasons].sort(),
      };
    }
    let health = "ready";
    let statusValue = queueState === "empty" ? "ready" : "degraded";
    try {
      validateInstalledState(paths, state, hostPlatformKey());
      if (ownership !== "plugin-v1" || legacyOwnership !== "absent") {
        fail("OWNERSHIP_CONFLICT");
      }
      const diagnostic = healthDiagnosticState(await probeHealth({
        token: state.healthToken,
        runtimeVersion: state.current.version,
        runtimeDigest: state.current.digest,
      }));
      health = diagnostic.state;
      for (const reason of diagnostic.degradedReasons) {
        degradedReasons.add(reason);
      }
      if (diagnostic.state === "degraded") statusValue = "degraded";
    } catch {
      health = "unavailable";
      statusValue = "degraded";
      degradedReasons.add("HEALTH_UNAVAILABLE");
    }
    return {
      schemaVersion: 1,
      status: statusValue,
      runtime: publicRuntime(state.current),
      previousRuntime: publicRuntime(state.previous),
      launchAgent: ownership,
      desktopLaunchAgent: legacyOwnership,
      listener,
      health,
      pendingCount,
      queueState,
      degradedReasons: [...degradedReasons].sort(),
    };
  }

  async function disable() {
    environment();
    return withLock(async () => {
      const { content: definition, ownership } = ownedPluginService();
      const state = readAgentState(paths.statePath, { optional: true });
      if (state === null || ownership !== "plugin-v1") {
        fail("OWNERSHIP_CONFLICT");
      }
      validateInstalledState(paths, state, hostPlatformKey());
      assertDefinitionMatches([definition]);
      await supervisor.stop({ paths, uid, runCommand });
      assertDefinitionMatches([definition]);
      await waitForPluginStop({
        paths,
        supervisor,
        uid,
        runCommand,
        probeListener,
        wait,
      });
      assertDefinitionMatches([definition]);
      return {
        schemaVersion: 1,
        status: "disabled",
        preservedPending: pendingQueueEntries(paths).length,
      };
    });
  }

  async function preflightDisable() {
    environment();
    return withLock(async () => {
      const { ownership } = ownedPluginService();
      const state = readAgentState(paths.statePath, { optional: true });
      if (state === null || ownership !== "plugin-v1") {
        fail("OWNERSHIP_CONFLICT");
      }
      validateInstalledState(paths, state, hostPlatformKey());
      return {
        schemaVersion: 1,
        status: "ready",
        loaded: await isServiceLoaded({ paths, supervisor, uid, runCommand }),
      };
    });
  }

  function uninstallPreflight(discardPending, purgeProof) {
    const { content: definition, ownership } = ownedPluginService();
    const state = readAgentState(paths.statePath, { optional: true });
    const proof = purgeProof === undefined ? null : lifecyclePurgeProof(purgeProof);
    const absent = state === null && ownership === "absent";
    if (state === null && ownership !== "absent") {
      fail("OWNERSHIP_CONFLICT");
    }
    let resolvedProof = proof;
    if (state !== null) {
      const stateRaw = readFileSync(paths.statePath, "utf8");
      if (ownership === "plugin-v1") {
        validateInstalledState(paths, state, hostPlatformKey());
        const currentProof = {
          schemaVersion: 1,
          stateSha256: sha256(stateRaw),
          launchAgentSha256: sha256(definition),
        };
        if (
          proof !== null &&
          (proof.stateSha256 !== currentProof.stateSha256 ||
            proof.launchAgentSha256 !== currentProof.launchAgentSha256)
        ) {
          fail("OWNERSHIP_CONFLICT");
        }
        resolvedProof = currentProof;
      } else if (ownership === "absent" && (!discardPending || proof !== null)) {
        // A prior uninstall removed the plist but failed before deleting
        // state.json. The documented recovery is retrying the default
        // uninstall, so a preserve-mode retry resumes from partially
        // uninstalled state; discarding pending data still requires a proof.
        if (proof !== null && sha256(stateRaw) !== proof.stateSha256) {
          fail("OWNERSHIP_CONFLICT");
        }
        validatePartiallyUninstalledState(paths, state, hostPlatformKey());
      } else {
        fail("OWNERSHIP_CONFLICT");
      }
    } else if (proof !== null && !discardPending) {
      fail("INVALID_ARGUMENTS");
    }
    const pending = captureStateInventory(paths).pending;
    return {
      definition,
      state,
      absent,
      pending,
      discardPending,
      purgeProof: resolvedProof,
      resumePurge: proof !== null,
      resumePartial: state !== null && ownership === "absent",
    };
  }

  async function preflightUninstall({
    discardPending = false,
    purgeProof,
  } = {}) {
    environment();
    if (typeof discardPending !== "boolean") fail("INVALID_ARGUMENTS");
    return withLock(async () => {
      const plan = uninstallPreflight(discardPending, purgeProof);
      const loaded = plan.absent
        ? false
        : await isServiceLoaded({ paths, supervisor, uid, runCommand });
      return {
        schemaVersion: 1,
        status: "ready",
        installed: !plan.absent,
        partial: plan.resumePartial,
        loaded,
        pendingCount: plan.pending.length,
        disposition: discardPending ? "discard" : "preserve",
        purgeProof: discardPending ? plan.purgeProof : null,
      };
    });
  }

  async function uninstall({ discardPending = false, purgeProof } = {}) {
    environment();
    if (typeof discardPending !== "boolean") fail("INVALID_ARGUMENTS");
    return withLock(async () => {
      const plan = uninstallPreflight(discardPending, purgeProof);
      const { definition, state, absent } = plan;
      let { pending } = plan;
      if (absent) {
        if (discardPending) purgeCaptureState(paths);
        return {
          schemaVersion: 1,
          status: "uninstalled",
          preservedPending: discardPending ? 0 : pending.length,
          discardedPending: discardPending ? pending.length : 0,
        };
      }
      assertDefinitionMatches([definition]);
      await supervisor.stop({ paths, uid, runCommand });
      assertDefinitionMatches([definition]);
      await waitForPluginStop({
        paths,
        supervisor,
        uid,
        runCommand,
        probeListener,
        wait,
      });
      assertDefinitionMatches([definition]);
      pending = pendingQueueEntries(paths);
      if (discardPending) purgeCaptureState(paths);
      const currentDefinition = assertDefinitionMatches([definition]);
      if (currentDefinition !== undefined) {
        unlinkSync(paths.servicePath);
        await supervisor.forget({ runCommand });
      }
      removeLink(paths.currentPath);
      removeLink(paths.previousPath);
      removeInstalledRuntime(paths, state.current, {
        allowPartial: plan.resumePurge || plan.resumePartial,
      });
      if (
        state.previous !== null &&
        state.previous.directoryName !== state.current.directoryName
      ) {
        removeInstalledRuntime(paths, state.previous, {
          allowPartial: plan.resumePurge || plan.resumePartial,
        });
      }
      removeEmptyDirectory(paths.runtimeVersionsDirectory);
      removeEmptyDirectory(paths.runtimeRoot);
      unlinkSync(paths.statePath);
      removeEmptyDirectory(paths.agentRoot);
      return {
        schemaVersion: 1,
        status: "uninstalled",
        preservedPending: discardPending ? 0 : pending.length,
        discardedPending: discardPending ? pending.length : 0,
      };
    });
  }

  return {
    setupRuntime,
    startInstalledRuntime,
    status,
    upgrade,
    rollback,
    preflightDisable,
    disable,
    preflightUninstall,
    uninstall,
  };
}

function cliArguments(args) {
  const command = args[0];
  if (
    !new Set([
      "setup-runtime",
      "status",
      "upgrade",
      "rollback",
      "uninstall",
    ]).has(command)
  ) {
    fail("INVALID_ARGUMENTS");
  }
  const flags = args.slice(1);
  if (
    (command !== "uninstall" && flags.length > 0) ||
    (command === "uninstall" &&
      (flags.length > 1 ||
        (flags.length === 1 && flags[0] !== "--discard-pending")))
  ) {
    fail("INVALID_ARGUMENTS");
  }
  return { command, discardPending: flags[0] === "--discard-pending" };
}

export async function runCaptureAgentCli({
  args = process.argv.slice(2),
  env = process.env,
  write = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
  lifecycle,
} = {}) {
  try {
    const activeLifecycle = lifecycle ?? createCaptureAgentLifecycle({ env });
    const { command, discardPending } = cliArguments(args);
    const result =
      command === "setup-runtime"
        ? await activeLifecycle.setupRuntime()
        : command === "status"
          ? await activeLifecycle.status()
          : command === "upgrade"
            ? await activeLifecycle.upgrade()
            : command === "rollback"
              ? await activeLifecycle.rollback()
              : await activeLifecycle.uninstall({ discardPending });
    write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const code =
      error instanceof CaptureAgentLifecycleError
        ? error.code
        : "SUPERVISOR_UNAVAILABLE";
    writeError(
      `${JSON.stringify({
        schemaVersion: 1,
        status: "failed",
        code,
        ...(error?.rollback === undefined ? {} : { rollback: error.rollback }),
      })}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exitCode = await runCaptureAgentCli();
  process.exitCode = exitCode;
}
