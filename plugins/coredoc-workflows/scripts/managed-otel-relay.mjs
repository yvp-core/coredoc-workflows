#!/usr/bin/env node

import { createHash, randomInt, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  artifactRevisionRequest,
  artifactRevisionResponse,
  deliveryRoute,
  taskEnsureRequest,
  taskEnsureResponse,
} from "../runtime/artifacts/contract.mjs";
import { captureEvent, captureReceipt } from "../runtime/capture/contract.mjs";
import {
  captureHealthSnapshot,
  persistCaptureHealth,
} from "../runtime/capture/health.mjs";
import {
  NativeOtlpSanitizerError,
  sanitizeClaudeOtlp,
  sanitizeCodexOtlp,
} from "./native-otel-sanitizer.mjs";
import {
  codexAttributionStatePath,
  pruneCodexAttributionState,
  readCodexAttributionState,
  setCodexAttributionClaim,
  writeCodexAttributionState,
} from "./codex-attribution-state.mjs";
import {
  resolveRepositoryRoot,
  resolveRepositoryScopeKey,
} from "./project-key.mjs";

const CONFIG_VERSION = 1;
const MAX_BINDINGS = 128;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 1_000_000;
const MAX_NATIVE_BODY_BYTES = 25 * 1024 * 1024;
const MAX_DELIVERY_BODY_BYTES = 3 * 1024 * 1024;
const MAX_CAPTURE_EVENTS = 100;
const ACCEPTED_CAPTURE_SCHEMA_VERSIONS = Object.freeze([1, 2, 3]);
const MAX_CONNECTIONS = 32;
const MAX_HEADERS = 64;
const MAX_REQUESTS_PER_SOCKET = 100;
const HEADERS_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;
const KEEP_ALIVE_TIMEOUT_MS = 1_000;
const MANAGED_RELAY_PORT = 43_181;
const DEFAULT_TIMEOUT_MS = 4_500;
const OUTBOX_FLUSH_INTERVAL_MS = 30_000;
const NATIVE_OUTBOX_DIRECTORY_NAME = "native-outbox";
const NATIVE_OUTBOX_STATE_NAME = "state.json";
const NATIVE_OUTBOX_RECORD_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.native\.json$/;
const DEFAULT_NATIVE_OUTBOX_MAX_RECORDS = 512;
const DEFAULT_NATIVE_OUTBOX_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_NATIVE_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_NATIVE_OUTBOX_RECORD_BYTES = 26 * 1024 * 1024;
const MAX_NATIVE_RETRY_DELAY_MS = 60 * 60 * 1_000;
const OUTBOX_EVENT_FILE_RE = /^([0-9a-f-]{36})\.event\.json$/i;
const CODEX_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CODEX_BUFFER_TTL_MS = 30_000;
const MAX_CODEX_BUFFERED_RECORDS_PER_SESSION = 128;
const MAX_CODEX_BUFFERED_RECORDS = 1_000;
const MAX_CODEX_JOURNAL_BYTES = 32 * 1024 * 1024;
const CODEX_JOURNAL_NAME = "codex-relay-events.jsonl";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const WORKSPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REPOSITORY_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const AGENT_HEALTH_TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const RUNTIME_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const CAPTURE_AGENT_STATE_MARKER = "coredoc-workflows.capture-agent.v1";
const ARTIFACT_OUTBOX_RECORD_RE =
  /^revision-\d{6}-cda_[0-9a-f-]+-[0-9a-f]{64}\.json$/;
const ARTIFACT_QUARANTINE_RECORD_RE =
  /^quarantine-\d{6}-cda_[0-9a-f-]+-[0-9a-f]{64}\.json$/;
const MAX_HEALTH_QUEUE_ENTRIES = 10_000;
const MAX_HEALTH_QUEUE_FILE_BYTES = 26 * 1024 * 1024;
const MAX_ARTIFACT_HEALTH_STATE_BYTES = 64 * 1024;
const ARTIFACT_HEALTH_ERROR_CODES = new Set([
  "AUTH_REJECTED",
  "OUTBOX_OVERFLOW",
  "REPOSITORY_UNAVAILABLE",
  "TRANSPORT_UNAVAILABLE",
  "CONFIG_CONFLICT",
]);
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

export class ManagedRelayError extends Error {
  constructor(code) {
    super(code);
    this.name = "ManagedRelayError";
    this.code = code;
  }
}

function fail(code) {
  throw new ManagedRelayError(code);
}

function exactObject(value, fields, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) fail(code);
  }
  return value;
}

function normalizedRepositoryKey(value) {
  if (typeof value !== "string" || value.length > 256) fail("INVALID_CONFIG");
  const segments = value.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        !REPOSITORY_SEGMENT_RE.test(segment)
    )
  ) {
    fail("INVALID_CONFIG");
  }
  return value;
}

function normalizedForwardEndpoint(value, workspaceId, channel) {
  let target;
  try {
    target = new URL(value);
  } catch {
    fail("INVALID_CONFIG");
  }
  const loopback =
    target.hostname === "127.0.0.1" || target.hostname === "[::1]";
  const suffix = channel === "native" ? "/otel/v1/logs" : "/capture/v1/events";
  if (
    (target.protocol !== "https:" &&
      !(target.protocol === "http:" && loopback)) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname.replace(/\/$/, "") !==
      `/api/v1/workspaces/${workspaceId}${suffix}`
  ) {
    fail("INVALID_CONFIG");
  }
  return target.href;
}

export function sha256BindingNonce(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /[\s\0]/.test(value)
  ) {
    fail("INVALID_BINDING_NONCE");
  }
  return createHash("sha256").update(value).digest("hex");
}

export function relayBindingNonceFromCaptureHeaders(value) {
  if (typeof value !== "string") fail("INVALID_BINDING_NONCE");
  const entries = value.split(",");
  const separator = entries[0]?.indexOf("=") ?? -1;
  if (
    entries.length !== 1 ||
    separator < 1 ||
    entries[0].slice(0, separator).trim().toLowerCase() !==
      "x-coredoc-relay-binding"
  ) {
    fail("INVALID_BINDING_NONCE");
  }
  const nonce = entries[0].slice(separator + 1).trim();
  sha256BindingNonce(nonce);
  return nonce;
}

export function relayBinding(input) {
  const value = exactObject(
    input,
    new Set([
      "schemaVersion",
      "bindingId",
      "bindingNonceHash",
      "host",
      "workspaceId",
      "workspaceMode",
      "repositoryKey",
      "repositoryScopeKey",
      "repositoryRoot",
      "profileName",
      "nativeForwardEndpoint",
      "captureForwardEndpoint",
      "cloudAuthorization",
    ]),
    "INVALID_CONFIG"
  );
  if (
    value.schemaVersion !== CONFIG_VERSION ||
    typeof value.bindingId !== "string" ||
    !UUID_RE.test(value.bindingId) ||
    typeof value.bindingNonceHash !== "string" ||
    !SHA256_RE.test(value.bindingNonceHash) ||
    (value.host !== "claude-code" && value.host !== "codex") ||
    typeof value.workspaceId !== "string" ||
    !WORKSPACE_ID_RE.test(value.workspaceId) ||
    typeof value.cloudAuthorization !== "string" ||
    !/^Bearer [^\s]+$/.test(value.cloudAuthorization)
  ) {
    fail("INVALID_CONFIG");
  }
  const workspaceMode = value.workspaceMode === true;
  if (
    (value.workspaceMode !== undefined && !workspaceMode) ||
    (workspaceMode &&
      (value.repositoryKey !== undefined ||
        value.repositoryScopeKey !== undefined ||
        value.repositoryRoot !== undefined ||
        value.profileName !== undefined))
  ) {
    fail("INVALID_CONFIG");
  }
  return {
    schemaVersion: CONFIG_VERSION,
    bindingId: value.bindingId.toLowerCase(),
    bindingNonceHash: value.bindingNonceHash,
    host: value.host,
    workspaceId: value.workspaceId,
    ...(workspaceMode
      ? { workspaceMode: true }
      : { repositoryKey: normalizedRepositoryKey(value.repositoryKey) }),
    ...(!workspaceMode && value.host === "codex"
      ? {
          repositoryScopeKey:
            typeof value.repositoryScopeKey === "string" &&
            /^repo-[a-f0-9]{24}$/.test(value.repositoryScopeKey)
              ? value.repositoryScopeKey
              : fail("INVALID_CONFIG"),
          profileName:
            value.profileName === null ||
            (typeof value.profileName === "string" &&
              value.profileName !== "base" &&
              /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.profileName))
              ? value.profileName
              : fail("INVALID_CONFIG"),
          // Optional checkout root: pins the binding to one worktree, because
          // linked worktrees share the repository scope key.
          ...(value.repositoryRoot === undefined
            ? {}
            : {
                repositoryRoot:
                  typeof value.repositoryRoot === "string" &&
                  value.repositoryRoot.length <= 4096 &&
                  isAbsolute(value.repositoryRoot) &&
                  resolve(value.repositoryRoot) === value.repositoryRoot
                    ? value.repositoryRoot
                    : fail("INVALID_CONFIG"),
              }),
        }
      : value.repositoryScopeKey === undefined &&
        value.repositoryRoot === undefined &&
        value.profileName === undefined
      ? {}
      : fail("INVALID_CONFIG")),
    nativeForwardEndpoint: normalizedForwardEndpoint(
      value.nativeForwardEndpoint,
      value.workspaceId,
      "native"
    ),
    captureForwardEndpoint: normalizedForwardEndpoint(
      value.captureForwardEndpoint,
      value.workspaceId,
      "capture"
    ),
    cloudAuthorization: value.cloudAuthorization,
  };
}

export function managedCaptureBindingStorageHash({
  bindingId,
  bindingNonceHash,
  host,
  workspaceMode = false,
} = {}) {
  if (
    (host !== "claude-code" && host !== "codex") ||
    typeof workspaceMode !== "boolean"
  ) {
    fail("INVALID_CONFIG");
  }
  if (workspaceMode || host === "codex") {
    if (typeof bindingId !== "string" || !UUID_RE.test(bindingId)) {
      fail("INVALID_CONFIG");
    }
    return sha256BindingNonce(bindingId.toLowerCase());
  }
  if (typeof bindingNonceHash !== "string" || !SHA256_RE.test(bindingNonceHash)) {
    fail("INVALID_CONFIG");
  }
  return bindingNonceHash;
}

export function managedRelayBindingStorageHash(input) {
  const binding = relayBinding(input);
  return managedCaptureBindingStorageHash(binding);
}

export function managedRelayConfig(input) {
  const value = exactObject(
    input,
    new Set(["schemaVersion", "bindings"]),
    "INVALID_CONFIG"
  );
  if (
    value.schemaVersion !== CONFIG_VERSION ||
    !Array.isArray(value.bindings) ||
    value.bindings.length > MAX_BINDINGS
  ) {
    fail("INVALID_CONFIG");
  }
  const bindings = value.bindings.map(relayBinding);
  if (
    new Set(bindings.map(({ bindingId }) => bindingId)).size !==
      bindings.length ||
    new Set(
      bindings
        .filter(({ host }) => host === "claude-code")
        .map(({ bindingNonceHash }) => bindingNonceHash)
    ).size !== bindings.filter(({ host }) => host === "claude-code").length
  ) {
    fail("INVALID_CONFIG");
  }
  const codex = bindings.filter(({ host }) => host === "codex");
  const codexNonces = new Set(
    codex.map(({ bindingNonceHash }) => bindingNonceHash)
  );
  const codexScopes = codex
    .filter(({ workspaceMode }) => workspaceMode !== true)
    .map(({ repositoryScopeKey }) => repositoryScopeKey);
  const claudeNonces = new Set(
    bindings
      .filter(({ host }) => host === "claude-code")
      .map(({ bindingNonceHash }) => bindingNonceHash)
  );
  // One workspace-mode binding per host may coexist with repository bindings:
  // listed repositories route to their own destination and the workspace
  // binding is the fallback for every other session.
  if (
    codexNonces.size > 1 ||
    new Set(codexScopes).size !== codexScopes.length ||
    new Set(
      bindings
        .filter(({ workspaceMode }) => workspaceMode === true)
        .map(({ host }) => host)
    ).size !==
      bindings.filter(({ workspaceMode }) => workspaceMode === true).length ||
    [...codexNonces].some((nonce) => claudeNonces.has(nonce))
  )
    fail("INVALID_CONFIG");
  return { schemaVersion: CONFIG_VERSION, bindings };
}

export function readManagedRelayConfig(path) {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      fail("CONFIG_UNAVAILABLE");
    if ((metadata.mode & 0o777) !== 0o600 || metadata.size > MAX_CONFIG_BYTES) {
      fail("CONFIG_UNAVAILABLE");
    }
    return managedRelayConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error instanceof ManagedRelayError) throw error;
    fail("CONFIG_UNAVAILABLE");
  }
}

export function writeManagedRelayConfig(path, input) {
  const config = managedRelayConfig(input);
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(config)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch {
    rmSync(temporary, { force: true });
    fail("CONFIG_WRITE_FAILED");
  }
  return config;
}

function configOrEmpty(path) {
  return existsSync(path)
    ? readManagedRelayConfig(path)
    : { schemaVersion: CONFIG_VERSION, bindings: [] };
}

export function upsertManagedRelayBinding(path, input) {
  const binding = relayBinding(input);
  const config = configOrEmpty(path);
  const existing = config.bindings.findIndex(
    ({ bindingId }) => bindingId === binding.bindingId
  );
  const bindings = [...config.bindings];
  if (existing < 0) bindings.push(binding);
  else bindings[existing] = binding;
  writeManagedRelayConfig(path, { schemaVersion: CONFIG_VERSION, bindings });
  return binding;
}

export function removeManagedRelayBinding(path, bindingId) {
  if (typeof bindingId !== "string" || !UUID_RE.test(bindingId)) {
    fail("INVALID_BINDING_ID");
  }
  if (!existsSync(path)) return false;
  const config = readManagedRelayConfig(path);
  const bindings = config.bindings.filter(
    (binding) => binding.bindingId !== bindingId.toLowerCase()
  );
  if (bindings.length === config.bindings.length) return false;
  writeManagedRelayConfig(path, { schemaVersion: CONFIG_VERSION, bindings });
  return true;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function readJsonBody(request, maximum = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const rejectTooLarge = () => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      request.pause();
      reject(new ManagedRelayError("PAYLOAD_TOO_LARGE"));
    };
    request.on("data", (chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maximum) {
        rejectTooLarge();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks, bytes).toString("utf8");
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new ManagedRelayError("INVALID_PAYLOAD"));
      }
    });
    request.on("error", () => {
      if (settled) return;
      settled = true;
      reject(new ManagedRelayError("INVALID_PAYLOAD"));
    });
  });
}

function closeOversizedRequest(request, response, code) {
  if (code !== "PAYLOAD_TOO_LARGE") return;
  request.pause();
  response.setHeader("connection", "close");
  const socket = request.socket;
  response.once("finish", () => {
    if (typeof socket.destroySoon === "function") socket.destroySoon();
    else socket.destroy();
  });
}

function bindingHeader(request) {
  const value = request.headers["x-coredoc-relay-binding"];
  if (typeof value !== "string") fail("BINDING_MISMATCH");
  try {
    return sha256BindingNonce(value);
  } catch {
    fail("BINDING_MISMATCH");
  }
}

function ingressHeader(request) {
  const value = request.headers["x-coredoc-relay-ingress"];
  if (typeof value !== "string") fail("BINDING_MISMATCH");
  try {
    return sha256BindingNonce(value);
  } catch {
    fail("BINDING_MISMATCH");
  }
}

function bindingIdHeader(request) {
  const value = request.headers["x-coredoc-relay-binding-id"];
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    fail("BINDING_MISMATCH");
  }
  return value.toLowerCase();
}

function channelHealth() {
  return {
    state: "waiting",
    lastSeenAt: null,
    lastForwardedAt: null,
    lastErrorCode: null,
  };
}

function bindingSignature(binding) {
  return createHash("sha256").update(JSON.stringify(binding)).digest("hex");
}

function healthSnapshot(binding, state, attribution) {
  return {
    schemaVersion: CONFIG_VERSION,
    bindingId: binding.bindingId,
    host: binding.host,
    workspaceId: binding.workspaceId,
    state: "ready",
    native: { ...state.native },
    capture: {
      ...state.capture,
      acceptedSchemaVersions: [...ACCEPTED_CAPTURE_SCHEMA_VERSIONS],
    },
    attribution:
      binding.host === "codex"
        ? attribution
        : { pendingCount: 0, rejectedCount: 0, lastClaimAt: null },
  };
}

function agentHealthSnapshot(value) {
  if (value === undefined) return null;
  const candidate = exactObject(
    value,
    new Set([
      "token",
      "runtimeVersion",
      "runtimeDigest",
      "protocolVersion",
      "configSchemaVersion",
    ]),
    "INVALID_CONFIG"
  );
  if (
    typeof candidate.token !== "string" ||
    !AGENT_HEALTH_TOKEN_RE.test(candidate.token) ||
    typeof candidate.runtimeVersion !== "string" ||
    !RUNTIME_VERSION_RE.test(candidate.runtimeVersion) ||
    typeof candidate.runtimeDigest !== "string" ||
    !SHA256_RE.test(candidate.runtimeDigest) ||
    candidate.protocolVersion !== 1 ||
    candidate.configSchemaVersion !== CONFIG_VERSION
  ) {
    fail("INVALID_CONFIG");
  }
  return {
    token: candidate.token,
    identity: {
      schemaVersion: 2,
      runtimeVersion: candidate.runtimeVersion,
      runtimeDigest: candidate.runtimeDigest,
      protocolVersion: 1,
      configSchemaVersion: CONFIG_VERSION,
    },
  };
}

function safeHealthQueueDirectory(path) {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    fail("QUEUE_UNSAFE");
  }
}

function safeHealthQueueFile(path) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size > MAX_HEALTH_QUEUE_FILE_BYTES ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    fail("QUEUE_UNSAFE");
  }
}

function bindingQueueCount(root, kind) {
  if (!existsSync(root)) return 0;
  safeHealthQueueDirectory(root);
  let count = 0;
  let visited = 0;
  for (const bindingHash of readdirSync(root).sort()) {
    if (!SHA256_RE.test(bindingHash)) fail("QUEUE_UNSAFE");
    const directory = join(root, bindingHash);
    safeHealthQueueDirectory(directory);
    for (const name of readdirSync(directory).sort()) {
      visited += 1;
      if (visited > MAX_HEALTH_QUEUE_ENTRIES) fail("QUEUE_UNSAFE");
      const path = join(directory, name);
      safeHealthQueueFile(path);
      if (kind === "semantic") {
        if (OUTBOX_EVENT_FILE_RE.test(name)) count += 1;
        else if (name !== "capture-health.json") fail("QUEUE_UNSAFE");
      } else if (ARTIFACT_OUTBOX_RECORD_RE.test(name)) {
        count += 1;
      } else if (
        name !== "state.json" &&
        !ARTIFACT_QUARANTINE_RECORD_RE.test(name)
      ) {
        fail("QUEUE_UNSAFE");
      }
    }
  }
  return count;
}

function artifactQueueErrorCodes(root) {
  if (!existsSync(root)) return new Set();
  safeHealthQueueDirectory(root);
  const errors = new Set();
  for (const bindingHash of readdirSync(root).sort()) {
    if (!SHA256_RE.test(bindingHash)) fail("QUEUE_UNSAFE");
    const directory = join(root, bindingHash);
    safeHealthQueueDirectory(directory);
    const statePath = join(directory, "state.json");
    if (!existsSync(statePath)) continue;
    safeHealthQueueFile(statePath);
    if (lstatSync(statePath).size > MAX_ARTIFACT_HEALTH_STATE_BYTES) {
      fail("QUEUE_UNSAFE");
    }
    let state;
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      fail("QUEUE_UNSAFE");
    }
    const fields = new Set([
      "schemaVersion",
      "nextSequence",
      "artifacts",
      "quarantined",
      "errorCode",
    ]);
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      Object.keys(state).some((field) => !fields.has(field)) ||
      state.schemaVersion !== 1 ||
      !Number.isInteger(state.nextSequence) ||
      state.nextSequence < 1 ||
      state.nextSequence > 999_999 ||
      !state.artifacts ||
      typeof state.artifacts !== "object" ||
      Array.isArray(state.artifacts) ||
      !Array.isArray(state.quarantined ?? []) ||
      (state.errorCode !== null &&
        !ARTIFACT_HEALTH_ERROR_CODES.has(state.errorCode))
    ) {
      fail("QUEUE_UNSAFE");
    }
    if (state.errorCode !== null) errors.add(state.errorCode);
  }
  return errors;
}

function agentQueueCount(configPath) {
  const relayRoot = dirname(configPath);
  if (
    basename(configPath) !== "relay.json" ||
    basename(relayRoot) !== "capture-relay" ||
    basename(dirname(relayRoot)) !== "capture-agent"
  ) {
    return 0;
  }
  const root = join(dirname(relayRoot), "outbox");
  if (!existsSync(root)) return 0;
  let count = 0;
  let visited = 0;
  const visit = (directory) => {
    safeHealthQueueDirectory(directory);
    for (const name of readdirSync(directory).sort()) {
      visited += 1;
      if (visited > MAX_HEALTH_QUEUE_ENTRIES) fail("QUEUE_UNSAFE");
      const path = join(directory, name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) fail("QUEUE_UNSAFE");
      if (metadata.isDirectory()) {
        visit(path);
      } else {
        safeHealthQueueFile(path);
        if (!name.endsWith(".json")) fail("QUEUE_UNSAFE");
        count += 1;
      }
    }
  };
  visit(root);
  return count;
}

function healthReasonForChannelError(code) {
  if (code === null) return null;
  if (HEALTH_DEGRADED_REASONS.has(code)) return code;
  if (code === "UPSTREAM_INVALID") return "UPSTREAM_REJECTED";
  if (code === "BINDING_MISMATCH") return "CONFIG_CONFLICT";
  return "CHANNEL_DEGRADED";
}

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function defaultNativeOutboxRetryDelay(attempt) {
  const base = Math.min(60_000, 1_000 * 2 ** Math.min(attempt - 1, 6));
  return base + randomInt(0, Math.floor(base / 4) + 1);
}

function ensureNativeOutboxDirectory(path, { create = false } = {}) {
  if (!existsSync(path)) {
    if (!create) return false;
    try {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    } catch {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
  }
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
  return true;
}

function nativeOutboxFile(path, maximum = MAX_NATIVE_OUTBOX_RECORD_BYTES) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > maximum ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
  return metadata;
}

function atomicNativeOutboxWrite(path, content) {
  const temporary = join(dirname(path), `.native-${randomUUID()}.tmp`);
  try {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    writeFileSync(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    if (error instanceof ManagedRelayError) throw error;
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
}

function sanitizedNativePayload(input, host) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 1 ||
    !Array.isArray(input.resourceLogs) ||
    input.resourceLogs.length !== 1
  ) {
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
  const resourceLog = input.resourceLogs[0];
  const resourceAttributes = resourceLog?.resource?.attributes;
  const scopeLogs = resourceLog?.scopeLogs;
  const attributeValue = (attributes, key) =>
    attributes?.find((entry) => entry?.key === key)?.value?.stringValue;
  if (
    attributeValue(resourceAttributes, "service.name") !==
      "coredoc-native-sanitizer" ||
    attributeValue(resourceAttributes, "coredoc.host") !== host ||
    !Array.isArray(scopeLogs) ||
    scopeLogs.length !== 1 ||
    scopeLogs[0]?.scope?.name !== `coredoc.${host}.sanitized` ||
    !Array.isArray(scopeLogs[0]?.logRecords) ||
    scopeLogs[0].logRecords.length < 1
  ) {
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
  const forbiddenKeys = new Set([
    "prompt",
    "path",
    "file",
    "cwd",
    "command",
    "argument",
    "arguments",
    "tool_input",
    "tool_output",
    "message",
    "content",
    "transcript",
  ]);
  const inspect = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) inspect(entry);
      return;
    }
    if (!value || typeof value !== "object") {
      if (
        typeof value === "string" &&
        (/Bearer\s/i.test(value) || value.includes("\0") || value.includes("/Users/"))
      ) {
        fail("NATIVE_OUTBOX_UNAVAILABLE");
      }
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLowerCase())) {
        fail("NATIVE_OUTBOX_UNAVAILABLE");
      }
      inspect(nested);
    }
  };
  inspect(input);
  try {
    return JSON.parse(JSON.stringify(input));
  } catch {
    fail("NATIVE_OUTBOX_UNAVAILABLE");
  }
}

function createNativeOutboxStore({
  configPath,
  maxRecords,
  maxBytes,
  maxAgeMs,
  recordId,
  retryDelayMs,
  readFile,
}) {
  if (
    !Number.isInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 10_000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 256 * 1024 * 1024 ||
    !Number.isInteger(maxAgeMs) ||
    maxAgeMs < 1 ||
    maxAgeMs > 30 * 24 * 60 * 60 * 1_000 ||
    typeof recordId !== "function" ||
    typeof retryDelayMs !== "function" ||
    typeof readFile !== "function"
  ) {
    fail("INVALID_CONFIG");
  }
  const root = join(dirname(configPath), NATIVE_OUTBOX_DIRECTORY_NAME);
  const bindingDirectory = (bindingId) => join(root, bindingId);
  const statePath = (bindingId) =>
    join(bindingDirectory(bindingId), NATIVE_OUTBOX_STATE_NAME);
  const recordPath = (bindingId, id) =>
    join(bindingDirectory(bindingId), `${id}.native.json`);

  function emptyState() {
    return {
      schemaVersion: 1,
      evictedCount: 0,
      lastEvictionReason: null,
      lastEvictedAt: null,
    };
  }

  function readState(bindingId) {
    const path = statePath(bindingId);
    if (!existsSync(path)) return emptyState();
    nativeOutboxFile(path, 16 * 1024);
    let value;
    try {
      value = JSON.parse(readFile(path, "utf8"));
    } catch {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      value.schemaVersion !== 1 ||
      !Number.isInteger(value.evictedCount) ||
      value.evictedCount < 0 ||
      value.evictedCount > 1_000_000 ||
      !new Set([null, "age", "bytes", "count"]).has(
        value.lastEvictionReason
      ) ||
      (value.lastEvictedAt !== null && !isTimestamp(value.lastEvictedAt))
    ) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    return value;
  }

  function writeState(bindingId, value) {
    atomicNativeOutboxWrite(
      statePath(bindingId),
      `${JSON.stringify(value)}\n`
    );
  }

  function parsedRecord(path, expectedId) {
    const metadata = nativeOutboxFile(path);
    let value;
    try {
      value = JSON.parse(readFile(path, "utf8"));
    } catch {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 10 ||
      value.schemaVersion !== 1 ||
      typeof value.recordId !== "string" ||
      !UUID_RE.test(value.recordId) ||
      value.recordId.toLowerCase() !== expectedId ||
      typeof value.bindingId !== "string" ||
      !UUID_RE.test(value.bindingId) ||
      (value.host !== "claude-code" && value.host !== "codex") ||
      typeof value.workspaceId !== "string" ||
      !WORKSPACE_ID_RE.test(value.workspaceId) ||
      !isTimestamp(value.enqueuedAt) ||
      !Number.isInteger(value.attempts) ||
      value.attempts < 0 ||
      value.attempts > 1_000 ||
      !isTimestamp(value.nextAttemptAt) ||
      (value.lastErrorCode !== null &&
        (typeof value.lastErrorCode !== "string" ||
          !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.lastErrorCode)))
    ) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    value.payload = sanitizedNativePayload(value.payload, value.host);
    return { path, size: metadata.size, record: value };
  }

  function loadRecords() {
    if (!ensureNativeOutboxDirectory(root)) return [];
    const records = [];
    for (const bindingId of readdirSync(root).sort()) {
      if (!UUID_RE.test(bindingId)) fail("NATIVE_OUTBOX_UNAVAILABLE");
      const directory = bindingDirectory(bindingId);
      ensureNativeOutboxDirectory(directory);
      for (const name of readdirSync(directory).sort()) {
        if (name === NATIVE_OUTBOX_STATE_NAME) continue;
        if (/^\.native-[0-9a-f-]{36}\.tmp$/.test(name)) {
          nativeOutboxFile(join(directory, name));
          unlinkSync(join(directory, name));
          continue;
        }
        const match = NATIVE_OUTBOX_RECORD_RE.exec(name);
        if (!match) fail("NATIVE_OUTBOX_UNAVAILABLE");
        const entry = parsedRecord(join(directory, name), match[1]);
        if (entry.record.bindingId !== bindingId) {
          fail("NATIVE_OUTBOX_UNAVAILABLE");
        }
        records.push(entry);
      }
    }
    return records.sort(
      (left, right) =>
        left.record.enqueuedAt.localeCompare(right.record.enqueuedAt) ||
        left.record.recordId.localeCompare(right.record.recordId)
    );
  }

  const recordKey = ({ bindingId, recordId }) => `${bindingId}/${recordId}`;
  const cachedRecords = new Map();
  for (const entry of loadRecords()) {
    const key = recordKey(entry.record);
    if (cachedRecords.has(key)) fail("NATIVE_OUTBOX_UNAVAILABLE");
    cachedRecords.set(key, entry);
  }
  const orderedRecords = () =>
    [...cachedRecords.values()].sort(
      (left, right) =>
        left.record.enqueuedAt.localeCompare(right.record.enqueuedAt) ||
        left.record.recordId.localeCompare(right.record.recordId)
    );

  function evict(entry, reason, at) {
    const key = recordKey(entry.record);
    if (!existsSync(entry.path)) {
      cachedRecords.delete(key);
      return;
    }
    const current = parsedRecord(entry.path, entry.record.recordId);
    if (current.record.bindingId !== entry.record.bindingId) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    const bindingId = entry.record.bindingId;
    const state = readState(bindingId);
    writeState(bindingId, {
      schemaVersion: 1,
      evictedCount: Math.min(1_000_000, state.evictedCount + 1),
      lastEvictionReason: reason,
      lastEvictedAt: at,
    });
    unlinkSync(entry.path);
    cachedRecords.delete(key);
  }

  function pruneAge(records, at) {
    const atMs = Date.parse(at);
    const retained = [];
    for (const entry of records) {
      if (atMs - Date.parse(entry.record.enqueuedAt) >= maxAgeMs) {
        evict(entry, "age", at);
      } else {
        retained.push(entry);
      }
    }
    return retained;
  }

  function admit({ binding, payload, at }) {
    try {
      if (!isTimestamp(at)) fail("NATIVE_OUTBOX_UNAVAILABLE");
      const id = recordId();
      if (typeof id !== "string" || !UUID_RE.test(id)) {
        fail("NATIVE_OUTBOX_UNAVAILABLE");
      }
      const normalizedId = id.toLowerCase();
      const record = {
        schemaVersion: 1,
        recordId: normalizedId,
        bindingId: binding.bindingId,
        host: binding.host,
        workspaceId: binding.workspaceId,
        enqueuedAt: at,
        attempts: 0,
        nextAttemptAt: at,
        lastErrorCode: null,
        payload: sanitizedNativePayload(payload, binding.host),
      };
      const content = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(content);
      if (bytes > maxBytes || bytes > MAX_NATIVE_OUTBOX_RECORD_BYTES) {
        fail("NATIVE_OUTBOX_UNAVAILABLE");
      }
      ensureNativeOutboxDirectory(root, { create: true });
      ensureNativeOutboxDirectory(bindingDirectory(binding.bindingId), {
        create: true,
      });
      let records = pruneAge(orderedRecords(), at);
      let totalBytes = records.reduce((total, entry) => total + entry.size, 0);
      while (
        records.length + 1 > maxRecords ||
        totalBytes + bytes > maxBytes
      ) {
        const oldest = records.shift();
        if (!oldest) fail("NATIVE_OUTBOX_UNAVAILABLE");
        const reason = records.length + 2 > maxRecords ? "count" : "bytes";
        evict(oldest, reason, at);
        totalBytes -= oldest.size;
      }
      const path = recordPath(binding.bindingId, normalizedId);
      const key = recordKey(record);
      if (cachedRecords.has(key) || existsSync(path)) {
        fail("NATIVE_OUTBOX_UNAVAILABLE");
      }
      atomicNativeOutboxWrite(path, content);
      const entry = { path, size: bytes, record };
      cachedRecords.set(key, entry);
      return entry;
    } catch {
      throw new ManagedRelayError("NATIVE_OUTBOX_ADMISSION_FAILED");
    }
  }

  function ready(at) {
    if (!isTimestamp(at)) fail("NATIVE_OUTBOX_UNAVAILABLE");
    return pruneAge(orderedRecords(), at)
      .filter((entry) => Date.parse(entry.record.nextAttemptAt) <= Date.parse(at))
      .slice(0, 64);
  }

  function acknowledge(entry) {
    const key = recordKey(entry.record);
    if (!existsSync(entry.path)) {
      cachedRecords.delete(key);
      return;
    }
    const current = parsedRecord(entry.path, entry.record.recordId);
    if (current.record.bindingId !== entry.record.bindingId) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    unlinkSync(entry.path);
    cachedRecords.delete(key);
  }

  function defer(entry, code, at) {
    const key = recordKey(entry.record);
    if (!existsSync(entry.path)) {
      cachedRecords.delete(key);
      return;
    }
    if (!isTimestamp(at) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    const current = parsedRecord(entry.path, entry.record.recordId);
    const attempts = Math.min(1_000, current.record.attempts + 1);
    const delay = retryDelayMs(attempts);
    if (
      !Number.isInteger(delay) ||
      delay < 0 ||
      delay > MAX_NATIVE_RETRY_DELAY_MS
    ) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    const record = {
      ...current.record,
      attempts,
      nextAttemptAt: new Date(Date.parse(at) + delay).toISOString(),
      lastErrorCode: code,
    };
    const content = `${JSON.stringify(record)}\n`;
    atomicNativeOutboxWrite(entry.path, content);
    cachedRecords.set(key, {
      path: entry.path,
      size: Buffer.byteLength(content),
      record,
    });
  }

  function diagnostics(bindingId) {
    if (typeof bindingId !== "string" || !UUID_RE.test(bindingId)) {
      fail("NATIVE_OUTBOX_UNAVAILABLE");
    }
    const records = orderedRecords().filter(
      (entry) => entry.record.bindingId === bindingId
    );
    const state = existsSync(bindingDirectory(bindingId))
      ? readState(bindingId)
      : emptyState();
    return {
      schemaVersion: 1,
      bindingId,
      pendingCount: records.length,
      pendingBytes: records.reduce((total, entry) => total + entry.size, 0),
      evictedCount: state.evictedCount,
      lastEvictionReason: state.lastEvictionReason,
      lastEvictedAt: state.lastEvictedAt,
    };
  }

  function diagnosticsAll() {
    if (!ensureNativeOutboxDirectory(root)) return { pendingCount: 0 };
    let pendingCount = 0;
    let visited = 0;
    for (const bindingId of readdirSync(root).sort()) {
      visited += 1;
      if (visited > MAX_HEALTH_QUEUE_ENTRIES || !UUID_RE.test(bindingId)) {
        fail("NATIVE_OUTBOX_UNAVAILABLE");
      }
      const directory = bindingDirectory(bindingId);
      ensureNativeOutboxDirectory(directory);
      for (const name of readdirSync(directory).sort()) {
        visited += 1;
        if (visited > MAX_HEALTH_QUEUE_ENTRIES) {
          fail("NATIVE_OUTBOX_UNAVAILABLE");
        }
        const path = join(directory, name);
        if (name === NATIVE_OUTBOX_STATE_NAME) {
          readState(bindingId);
          continue;
        }
        if (/^\.native-[0-9a-f-]{36}\.tmp$/.test(name)) {
          nativeOutboxFile(path);
          continue;
        }
        if (!NATIVE_OUTBOX_RECORD_RE.test(name)) {
          fail("NATIVE_OUTBOX_UNAVAILABLE");
        }
        nativeOutboxFile(path);
        pendingCount += 1;
      }
    }
    return { pendingCount };
  }

  return { acknowledge, admit, defer, diagnostics, diagnosticsAll, ready };
}

function repositoryResolverEndpoint(binding) {
  const endpoint = new URL(binding.captureForwardEndpoint);
  endpoint.pathname = `/api/v1/workspaces/${binding.workspaceId}/capture/v1/repositories/resolve`;
  return endpoint.href;
}

async function resolveWorkspaceRepository(
  binding,
  repositoryKey,
  { fetchImpl, timeoutMs, allowDegraded }
) {
  let response;
  try {
    response = await fetchImpl(repositoryResolverEndpoint(binding), {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        Authorization: binding.cloudAuthorization,
      },
      body: JSON.stringify({ repositoryKey }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    if (allowDegraded) return { status: "degraded" };
    fail("REPOSITORY_UNAVAILABLE");
  }
  if (response.status >= 500) {
    await cancelResponseBody(response);
    if (allowDegraded) return { status: "degraded" };
    fail("REPOSITORY_UNAVAILABLE");
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    if (response.status === 401 || response.status === 403) {
      fail("AUTH_REJECTED");
    }
    fail("REPOSITORY_UNAVAILABLE");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    fail("REPOSITORY_UNAVAILABLE");
  }
  if (
    result?.status === "unregistered" &&
    Object.keys(result).length === 1
  ) {
    return { status: "unregistered" };
  }
  if (
    result?.status === "resolved" &&
    Object.keys(result).length === 2 &&
    result.repositoryKey === repositoryKey
  ) {
    return { status: "resolved", repositoryKey };
  }
  fail("REPOSITORY_UNAVAILABLE");
}

async function captureBatch(input, binding, { fetchImpl, timeoutMs }) {
  const candidate = exactObject(input, new Set(["events"]), "INVALID_CAPTURE");
  if (
    !Array.isArray(candidate.events) ||
    candidate.events.length < 1 ||
    candidate.events.length > MAX_CAPTURE_EVENTS
  ) {
    fail("INVALID_CAPTURE");
  }
  const attemptedEventIds = [];
  const forwarded = [];
  const rejected = [];
  const resolutions = new Map();
  let repositoryAttributionDegraded = false;
  for (const inputEvent of candidate.events) {
    let event;
    try {
      event = captureEvent(inputEvent);
    } catch {
      const eventId =
        typeof inputEvent?.eventId === "string" &&
        UUID_RE.test(inputEvent.eventId)
          ? inputEvent.eventId.toLowerCase()
          : null;
      if (eventId) attemptedEventIds.push(eventId);
      rejected.push({ eventId, code: "INVALID_EVENT" });
      continue;
    }
    attemptedEventIds.push(event.eventId);
    if (event.host !== binding.host) {
      rejected.push({ eventId: event.eventId, code: "INVALID_EVENT" });
    } else if (binding.workspaceMode === true) {
      if (event.repositoryKey === undefined) {
        forwarded.push(event);
        continue;
      }
      let resolution = resolutions.get(event.repositoryKey);
      if (!resolution) {
        resolution = resolveWorkspaceRepository(binding, event.repositoryKey, {
          fetchImpl,
          timeoutMs,
          allowDegraded: true,
        });
        resolutions.set(event.repositoryKey, resolution);
      }
      const result = await resolution;
      if (result.status === "resolved") {
        forwarded.push(event);
      } else {
        const { repositoryKey: _omitted, ...workspaceEvent } = event;
        forwarded.push(workspaceEvent);
        if (result.status === "degraded") {
          repositoryAttributionDegraded = true;
        }
      }
    } else if (
      (binding.host === "codex" && event.repositoryKey === undefined) ||
      (event.repositoryKey !== undefined &&
        event.repositoryKey !== binding.repositoryKey)
    ) {
      rejected.push({
        eventId: event.eventId,
        code: "OUT_OF_WORKSPACE_REPOSITORY",
      });
    } else {
      forwarded.push(event);
    }
  }
  return {
    events: forwarded,
    attemptedEventIds,
    rejected,
    repositoryAttributionDegraded,
  };
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the bounded upstream result exposed by the relay.
  }
}

function captureProbeEndpoint(binding) {
  const endpoint = new URL(binding.captureForwardEndpoint);
  endpoint.pathname = `/api/v1/workspaces/${binding.workspaceId}/capture/v1/probe`;
  return endpoint.href;
}

async function captureProbeError(response) {
  if (response.status === 401 || response.status === 403) {
    await cancelResponseBody(response);
    return "AUTH_REJECTED";
  }
  if (response.status === 200) {
    try {
      const body = await response.json();
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        Object.keys(body).length === 1 &&
        body.status === "ready"
      ) {
        return null;
      }
    } catch {
      // A non-contract body proves neither authentication nor capture readiness.
    }
    return "TRANSPORT_UNAVAILABLE";
  }
  await cancelResponseBody(response);
  return "TRANSPORT_UNAVAILABLE";
}

async function forward(binding, channel, body, fetchImpl, timeoutMs) {
  const endpoint =
    channel === "native"
      ? binding.nativeForwardEndpoint
      : binding.captureForwardEndpoint;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        Authorization: binding.cloudAuthorization,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail("TRANSPORT_UNAVAILABLE");
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    fail(
      response.status === 401 || response.status === 403
        ? "AUTH_REJECTED"
        : "UPSTREAM_REJECTED"
    );
  }
  return response;
}

function deliveryEndpoint(binding, route) {
  const endpoint = new URL(binding.captureForwardEndpoint);
  endpoint.pathname = `/api/v1/workspaces/${binding.workspaceId}${route}`;
  return endpoint.href;
}

async function forwardDelivery(binding, route, body, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(deliveryEndpoint(binding, route), {
      method: "PUT",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        Authorization: binding.cloudAuthorization,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail("TRANSPORT_UNAVAILABLE");
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    if (response.status === 401 || response.status === 403) {
      fail("AUTH_REJECTED");
    }
    if (response.status === 409) fail("CONFIG_CONFLICT");
    fail("UPSTREAM_REJECTED");
  }
  return response;
}

function failureStatus(code) {
  if (code === "BINDING_MISMATCH") return 401;
  if (code === "AUTH_REJECTED") return 403;
  if (code === "CONFIG_CONFLICT") return 409;
  if (code === "REPOSITORY_UNAVAILABLE") return 503;
  if (code === "PAYLOAD_TOO_LARGE") return 413;
  if (
    code === "INVALID_CAPTURE" ||
    code === "INVALID_DELIVERY" ||
    code === "INVALID_PAYLOAD" ||
    code === "UNKNOWN_PAYLOAD_SHAPE" ||
    code === "INVALID_RECORD" ||
    code === "UNSUPPORTED_VERSION" ||
    code === "MIXED_VERSIONS"
  ) {
    return 422;
  }
  return 502;
}

export function createManagedRelay({
  configPath,
  agentHealth,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outboxFlushIntervalMs = OUTBOX_FLUSH_INTERVAL_MS,
  nativeOutboxFlushIntervalMs = OUTBOX_FLUSH_INTERVAL_MS,
  nativeOutboxMaxRecords = DEFAULT_NATIVE_OUTBOX_MAX_RECORDS,
  nativeOutboxMaxBytes = DEFAULT_NATIVE_OUTBOX_MAX_BYTES,
  nativeOutboxMaxAgeMs = DEFAULT_NATIVE_OUTBOX_MAX_AGE_MS,
  nativeOutboxRecordId = randomUUID,
  nativeOutboxRetryDelayMs = defaultNativeOutboxRetryDelay,
  nativeOutboxReadFileSync = readFileSync,
} = {}) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    fail("INVALID_CONFIG");
  }
  if (
    !Number.isInteger(nativeOutboxFlushIntervalMs) ||
    nativeOutboxFlushIntervalMs < 10 ||
    nativeOutboxFlushIntervalMs > 60 * 60 * 1_000
  ) {
    fail("INVALID_CONFIG");
  }
  const healthV2 = agentHealthSnapshot(agentHealth);
  const nativeOutbox = createNativeOutboxStore({
    configPath,
    maxRecords: nativeOutboxMaxRecords,
    maxBytes: nativeOutboxMaxBytes,
    maxAgeMs: nativeOutboxMaxAgeMs,
    recordId: nativeOutboxRecordId,
    retryDelayMs: nativeOutboxRetryDelayMs,
    readFile: nativeOutboxReadFileSync,
  });
  const nativeOutboxInFlight = new Set();
  const states = new Map();
  const attributionPath = codexAttributionStatePath(configPath);
  const journalPath = join(dirname(configPath), CODEX_JOURNAL_NAME);

  function queueCounts() {
    const counts = {};
    let unsafe = false;
    let artifactErrors = new Set();
    const inspect = (name, operation) => {
      try {
        counts[name] = operation();
      } catch {
        counts[name] = null;
        unsafe = true;
      }
    };
    inspect("native", () => nativeOutbox.diagnosticsAll().pendingCount);
    inspect("semantic", () =>
      bindingQueueCount(join(dirname(configPath), "outbox"), "semantic")
    );
    inspect("artifact", () => {
      const root = join(dirname(configPath), "artifact-outbox");
      const count = bindingQueueCount(root, "artifact");
      artifactErrors = artifactQueueErrorCodes(root);
      return count;
    });
    inspect("agent", () => agentQueueCount(configPath));
    const values = [counts.native, counts.semantic, counts.artifact, counts.agent];
    counts.total = values.every(Number.isInteger)
      ? values.reduce((total, value) => total + value, 0)
      : null;
    return { counts, unsafe, artifactErrors };
  }

  function agentHealthDiagnostics() {
    const reasons = new Set();
    let config;
    try {
      config = configAndStates();
    } catch {
      reasons.add("CONFIG_UNAVAILABLE");
    }
    const hostIngress = {
      claudeCode: config === undefined ? "unknown" : "unconfigured",
      codex: config === undefined ? "unknown" : "unconfigured",
    };
    let fixedWorkspaceHash = null;
    let lastSuccessfulDeliveryAt = null;
    let repositoryAttribution = config === undefined ? "unknown" : "ready";
    if (config !== undefined) {
      // Repository bindings may point at other destinations; when
      // workspace-mode (default) bindings exist they alone define the fixed
      // workspace. A legacy repository-only config keeps the old rule.
      const workspaceModeBindings = config.bindings.filter(
        ({ workspaceMode }) => workspaceMode === true
      );
      const workspaceIds = new Set(
        (workspaceModeBindings.length > 0
          ? workspaceModeBindings
          : config.bindings
        ).map(({ workspaceId }) => workspaceId)
      );
      if (workspaceIds.size === 1) {
        fixedWorkspaceHash = createHash("sha256")
          .update([...workspaceIds][0])
          .digest("hex");
      } else if (workspaceIds.size > 1) {
        reasons.add("WORKSPACE_CONFLICT");
        repositoryAttribution = "unavailable";
      }
      for (const host of ["claude-code", "codex"]) {
        const field = host === "claude-code" ? "claudeCode" : "codex";
        if (config.bindings.some((binding) => binding.host === host)) {
          hostIngress[field] = "ready";
        } else {
          reasons.add(
            host === "claude-code"
              ? "CLAUDE_INGRESS_UNCONFIGURED"
              : "CODEX_INGRESS_UNCONFIGURED"
          );
        }
      }
      for (const binding of config.bindings) {
        const state = bindingState(binding);
        for (const channel of [state.native, state.capture]) {
          if (
            channel.lastForwardedAt !== null &&
            (lastSuccessfulDeliveryAt === null ||
              channel.lastForwardedAt > lastSuccessfulDeliveryAt)
          ) {
            lastSuccessfulDeliveryAt = channel.lastForwardedAt;
          }
          const reason = healthReasonForChannelError(channel.lastErrorCode);
          if (reason !== null) reasons.add(reason);
        }
        if (state.capture.lastErrorCode === "REPOSITORY_UNAVAILABLE") {
          repositoryAttribution = "unavailable";
        } else if (
          repositoryAttribution !== "unavailable" &&
          state.capture.lastErrorCode === "REPOSITORY_ATTRIBUTION_DEGRADED"
        ) {
          repositoryAttribution = "degraded";
        }
      }
      if (attribution.unattributed.pendingCount > 0) {
        reasons.add("ATTRIBUTION_PENDING");
        if (repositoryAttribution === "ready") repositoryAttribution = "degraded";
      }
      if (attribution.unattributed.rejectedCount > 0) {
        reasons.add("ATTRIBUTION_REJECTED");
        if (repositoryAttribution === "ready") repositoryAttribution = "degraded";
      }
    }
    const queues = queueCounts();
    for (const errorCode of queues.artifactErrors) {
      const reason = healthReasonForChannelError(errorCode);
      if (reason !== null) reasons.add(reason);
      if (errorCode === "REPOSITORY_UNAVAILABLE") {
        repositoryAttribution = "unavailable";
      }
    }
    if (queues.unsafe) reasons.add("QUEUE_UNSAFE");
    if (queues.counts.total !== null && queues.counts.total > 0) {
      reasons.add("QUEUE_PENDING");
    }
    const degradedReasons = [...reasons].sort().slice(0, 16);
    return {
      ...healthV2.identity,
      state: degradedReasons.length === 0 ? "ready" : "degraded",
      fixedWorkspaceHash,
      hostIngress,
      queueCounts: queues.counts,
      lastSuccessfulDeliveryAt,
      repositoryAttribution,
      degradedReasons,
    };
  }

  function journalCodex(entry) {
    try {
      const at = now();
      if (!isTimestamp(at)) return;
      const line = `${JSON.stringify({ schemaVersion: 1, at, ...entry })}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (lineBytes > MAX_CODEX_JOURNAL_BYTES) return;
      mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
      if (existsSync(journalPath)) {
        const metadata = lstatSync(journalPath);
        if (!metadata.isFile() || metadata.isSymbolicLink()) return;
        if ((metadata.mode & 0o777) !== 0o600) chmodSync(journalPath, 0o600);
        if (metadata.size + lineBytes > MAX_CODEX_JOURNAL_BYTES) {
          const rotatedPath = `${journalPath}.1`;
          rmSync(rotatedPath, { force: true });
          renameSync(journalPath, rotatedPath);
          chmodSync(rotatedPath, 0o600);
        }
      }
      writeFileSync(journalPath, line, {
        encoding: "utf8",
        mode: 0o600,
        flag: "a",
      });
      chmodSync(journalPath, 0o600);
    } catch {
      // Local diagnostics must never interrupt capture delivery.
    }
  }

  function codexSessionHash(sessionId) {
    return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  }

  function bindingJournalFields(binding) {
    return {
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      repositoryKey: binding.repositoryKey,
    };
  }

  let attribution = pruneCodexAttributionState(
    readCodexAttributionState(attributionPath),
    Date.now()
  );
  if (attribution.unattributed.pendingCount > 0) {
    const rejectedOnRestart = attribution.unattributed.pendingCount;
    attribution.unattributed.rejectedCount = Math.min(
      1_000_000,
      attribution.unattributed.rejectedCount +
        attribution.unattributed.pendingCount
    );
    attribution.unattributed.pendingCount = 0;
    writeCodexAttributionState(attributionPath, attribution);
    journalCodex({
      event: "native.rejected",
      reason: "relay_restart",
      recordCount: rejectedOnRestart,
      payload: null,
    });
  }
  const codexBuffers = new Map();
  const codexClaimTails = new Map();
  let bufferedRecordCount = 0;

  function persistAttribution() {
    writeCodexAttributionState(attributionPath, attribution);
  }

  function serializeCodexClaim(sessionId, operation) {
    const previous = codexClaimTails.get(sessionId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    codexClaimTails.set(sessionId, tail);
    return result.finally(() => {
      if (codexClaimTails.get(sessionId) === tail) {
        codexClaimTails.delete(sessionId);
      }
    });
  }

  function configAndStates() {
    const config = readManagedRelayConfig(configPath);
    const configuredIds = new Set(
      config.bindings.map(({ bindingId }) => bindingId)
    );
    for (const bindingId of states.keys()) {
      if (!configuredIds.has(bindingId)) states.delete(bindingId);
    }
    for (const [sessionId, claim] of Object.entries(attribution.claims)) {
      if (!configuredIds.has(claim.bindingId))
        delete attribution.claims[sessionId];
    }
    for (const bindingId of Object.keys(attribution.health)) {
      if (!configuredIds.has(bindingId)) delete attribution.health[bindingId];
    }
    return config;
  }

  function bindingState(binding) {
    const signature = bindingSignature(binding);
    const current = states.get(binding.bindingId);
    if (!current || current.signature !== signature) {
      states.set(binding.bindingId, {
        signature,
        native: channelHealth(),
        capture: channelHealth(),
      });
    }
    return states.get(binding.bindingId);
  }

  function codexHealth(binding) {
    const entry = attribution.health[binding.bindingId];
    return {
      pendingCount: attribution.unattributed.pendingCount,
      rejectedCount: attribution.unattributed.rejectedCount,
      lastClaimAt: entry?.lastClaimAt ?? null,
    };
  }

  function nativeFailureCode(error) {
    return error instanceof ManagedRelayError
      ? error.code
      : "TRANSPORT_UNAVAILABLE";
  }

  async function deliverNativeDurably(binding, payload, seenAt, coverageState) {
    const state = bindingState(binding);
    const entry = nativeOutbox.admit({ binding, payload, at: seenAt });
    nativeOutboxInFlight.add(entry.record.recordId);
    try {
      const forwarded = await forward(
        binding,
        "native",
        payload,
        fetchImpl,
        timeoutMs
      );
      await cancelResponseBody(forwarded);
      try {
        nativeOutbox.acknowledge(entry);
        state.native.state = coverageState;
        state.native.lastForwardedAt = seenAt;
        state.native.lastErrorCode = null;
      } catch {
        state.native.state = "error";
        state.native.lastErrorCode = "NATIVE_OUTBOX_UNAVAILABLE";
      }
    } catch (error) {
      const code = nativeFailureCode(error);
      state.native.state = "error";
      state.native.lastErrorCode = code;
      try {
        nativeOutbox.defer(entry, code, seenAt);
      } catch {
        // Initial admission is already durable. A later drain can safely retry it.
      }
    } finally {
      nativeOutboxInFlight.delete(entry.record.recordId);
    }
  }

  function rejectExpiredBuffers(nowMs) {
    let rejected = 0;
    for (const [sessionId, entries] of codexBuffers) {
      const retained = entries.filter((entry) => {
        if (entry.expiresAt > nowMs) return true;
        rejected += entry.recordCount;
        bufferedRecordCount -= entry.recordCount;
        journalCodex({
          event: "native.rejected",
          reason: "claim_timeout",
          sessionHash: codexSessionHash(sessionId),
          seenAt: entry.seenAt,
          recordCount: entry.recordCount,
          payload: entry.payload,
        });
        return false;
      });
      if (retained.length > 0) codexBuffers.set(sessionId, retained);
      else codexBuffers.delete(sessionId);
    }
    if (rejected > 0) {
      attribution.unattributed.pendingCount = Math.max(
        0,
        attribution.unattributed.pendingCount - rejected
      );
      attribution.unattributed.rejectedCount = Math.min(
        1_000_000,
        attribution.unattributed.rejectedCount + rejected
      );
      persistAttribution();
    }
  }

  function resolveCodexIngress(request) {
    const config = configAndStates();
    const nonceHash = ingressHeader(request);
    const bindings = config.bindings.filter(
      ({ host, bindingNonceHash }) =>
        host === "codex" && bindingNonceHash === nonceHash
    );
    if (bindings.length === 0) fail("BINDING_MISMATCH");
    return { config, bindings };
  }

  function resolveBinding(request) {
    const config = configAndStates();
    const hasIngress = request.headers["x-coredoc-relay-ingress"] !== undefined;
    const nonceHash = hasIngress
      ? ingressHeader(request)
      : bindingHeader(request);
    const binding = hasIngress
      ? config.bindings.find(
          ({ bindingId, bindingNonceHash, host }) =>
            host === "codex" &&
            bindingId === bindingIdHeader(request) &&
            bindingNonceHash === nonceHash
        )
      : config.bindings.find(
          ({ bindingNonceHash, host }) =>
            host === "claude-code" && bindingNonceHash === nonceHash
        );
    if (!binding) fail("BINDING_MISMATCH");
    return { binding, state: bindingState(binding) };
  }

  function conversationId(record) {
    const attribute = record.attributes?.find(
      (candidate) => candidate?.key === "conversation.id"
    );
    const value = attribute?.value?.stringValue;
    if (typeof value !== "string" || value.length === 0) fail("INVALID_RECORD");
    return value;
  }

  function codexPayloadsBySession(payload) {
    const template = payload.resourceLogs[0];
    if (!template) return new Map();
    const grouped = new Map();
    for (const record of template.scopeLogs[0]?.logRecords ?? []) {
      const sessionId = conversationId(record);
      const records = grouped.get(sessionId) ?? [];
      records.push(record);
      grouped.set(sessionId, records);
    }
    return new Map(
      [...grouped].map(([sessionId, records]) => [
        sessionId,
        {
          resourceLogs: [
            {
              ...template,
              scopeLogs: [{ ...template.scopeLogs[0], logRecords: records }],
            },
          ],
        },
      ])
    );
  }

  async function forwardCodexPayload(binding, payload, seenAt, sessionId) {
    const state = bindingState(binding);
    const recordCount =
      payload.resourceLogs[0]?.scopeLogs[0]?.logRecords?.length ?? 0;
    state.native.lastSeenAt = seenAt;
    try {
      const forwarded = await forward(
        binding,
        "native",
        payload,
        fetchImpl,
        timeoutMs
      );
      await cancelResponseBody(forwarded);
      state.native.state = "observed";
      state.native.lastForwardedAt = seenAt;
      state.native.lastErrorCode = null;
      journalCodex({
        event: "native.forwarded",
        sessionHash: codexSessionHash(sessionId),
        seenAt,
        recordCount,
        ...bindingJournalFields(binding),
        payload,
      });
    } catch (error) {
      state.native.state = "error";
      state.native.lastErrorCode =
        error instanceof ManagedRelayError
          ? error.code
          : "TRANSPORT_UNAVAILABLE";
      journalCodex({
        event: "native.forward_failed",
        reason: state.native.lastErrorCode,
        sessionHash: codexSessionHash(sessionId),
        seenAt,
        recordCount,
        ...bindingJournalFields(binding),
        payload,
      });
      throw error;
    }
  }

  async function registerCodexClaim(request) {
    const { bindings } = resolveCodexIngress(request);
    const body = exactObject(
      await readJsonBody(request),
      new Set(["sessionId", "cwd"]),
      "INVALID_PAYLOAD"
    );
    if (
      typeof body.sessionId !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(body.sessionId) ||
      typeof body.cwd !== "string" ||
      body.cwd.length === 0 ||
      body.cwd.length > 4_096 ||
      !isAbsolute(body.cwd)
    ) {
      fail("INVALID_PAYLOAD");
    }
    // A repository binding for the claimed cwd wins; the workspace-mode
    // binding is the fallback for every session outside a listed repository.
    let repositoryScopeKey;
    let repositoryRoot;
    try {
      repositoryScopeKey = resolveRepositoryScopeKey(body.cwd);
      repositoryRoot = resolveRepositoryRoot(body.cwd);
    } catch {
      repositoryScopeKey = null;
      repositoryRoot = null;
    }
    const binding = bindings.find(
      (candidate) =>
        candidate.workspaceMode !== true &&
        candidate.repositoryScopeKey === repositoryScopeKey &&
        (candidate.repositoryRoot === undefined ||
          candidate.repositoryRoot === repositoryRoot)
    );
    const workspaceBinding = bindings.find(
      (candidate) => candidate.workspaceMode === true
    );
    if (!binding && workspaceBinding) {
      const claimedAt = now();
      if (!isTimestamp(claimedAt)) fail("CLOCK_UNAVAILABLE");
      attribution = pruneCodexAttributionState(
        attribution,
        Date.parse(claimedAt)
      );
      attribution.health[workspaceBinding.bindingId] = { lastClaimAt: claimedAt };
      persistAttribution();
      journalCodex({
        event: "claim.observed",
        sessionHash: codexSessionHash(body.sessionId),
        ...bindingJournalFields(workspaceBinding),
      });
      return { status: "claimed", bindingId: workspaceBinding.bindingId };
    }
    if (!binding) {
      journalCodex({
        event: "claim.unmapped",
        reason: "repository_unmapped",
        sessionHash: codexSessionHash(body.sessionId),
      });
      return { status: "unmapped" };
    }
    return serializeCodexClaim(body.sessionId, async () => {
      const claimedAt = now();
      if (!isTimestamp(claimedAt)) fail("CLOCK_UNAVAILABLE");
      const claimedMs = Date.parse(claimedAt);
      attribution = pruneCodexAttributionState(attribution, claimedMs);
      const existing = Object.hasOwn(attribution.claims, body.sessionId)
        ? attribution.claims[body.sessionId]
        : undefined;
      if (
        existing &&
        (existing.bindingId !== binding.bindingId ||
          existing.repositoryScopeKey !== repositoryScopeKey)
      ) {
        attribution.unattributed.rejectedCount = Math.min(
          1_000_000,
          attribution.unattributed.rejectedCount + 1
        );
        persistAttribution();
        journalCodex({
          event: "claim.rejected",
          reason: "claim_conflict",
          sessionHash: codexSessionHash(body.sessionId),
          ...bindingJournalFields(binding),
        });
        fail("CONFIG_CONFLICT");
      }
      setCodexAttributionClaim(attribution, body.sessionId, {
        bindingId: binding.bindingId,
        repositoryScopeKey,
        claimedAt: new Date(claimedMs).toISOString(),
        expiresAt: new Date(claimedMs + CODEX_CLAIM_TTL_MS).toISOString(),
      });
      attribution.health[binding.bindingId] = {
        lastClaimAt: new Date(claimedMs).toISOString(),
      };
      persistAttribution();
      journalCodex({
        event: "claim.accepted",
        sessionHash: codexSessionHash(body.sessionId),
        ...bindingJournalFields(binding),
      });
      const pending = codexBuffers.get(body.sessionId) ?? [];
      while (pending.length > 0) {
        const entry = pending[0];
        await forwardCodexPayload(
          binding,
          entry.payload,
          entry.seenAt,
          body.sessionId
        );
        pending.shift();
        bufferedRecordCount -= entry.recordCount;
        attribution.unattributed.pendingCount = Math.max(
          0,
          attribution.unattributed.pendingCount - entry.recordCount
        );
        if (pending.length === 0) codexBuffers.delete(body.sessionId);
        persistAttribution();
      }
      return { status: "claimed", bindingId: binding.bindingId };
    });
  }

  async function handleCodexNative(request, response) {
    const { bindings } = resolveCodexIngress(request);
    const seenAt = now();
    if (!isTimestamp(seenAt)) fail("CLOCK_UNAVAILABLE");
    const seenAtMs = Date.parse(seenAt);
    attribution = pruneCodexAttributionState(attribution, seenAtMs);
    rejectExpiredBuffers(seenAtMs);
    const sanitized = sanitizeCodexOtlp(
      await readJsonBody(request, MAX_NATIVE_BODY_BYTES)
    );
    const workspaceBinding = bindings.find(
      (candidate) => candidate.workspaceMode === true
    );
    const hasRepositoryBindings = bindings.some(
      (candidate) => candidate.workspaceMode !== true
    );
    if (workspaceBinding) {
      const state = bindingState(workspaceBinding);
      state.native.lastSeenAt = seenAt;
      const coverageState =
        sanitized.coverage.nativeUsage === "observed" ? "observed" : "ready";
      let fallbackPayload = sanitized.payload;
      if (hasRepositoryBindings && sanitized.payload.resourceLogs.length > 0) {
        // Sessions claimed by a listed repository go to that repository's
        // destination; every other session falls back to the workspace
        // binding. Records that arrive before the session claim fall back.
        const template = sanitized.payload.resourceLogs[0];
        const fallbackRecords = [];
        for (const [sessionId, payload] of codexPayloadsBySession(
          sanitized.payload
        )) {
          const claim = attribution.claims[sessionId];
          const repositoryBinding = claim
            ? bindings.find(
                (candidate) =>
                  candidate.workspaceMode !== true &&
                  candidate.bindingId === claim.bindingId &&
                  candidate.repositoryScopeKey === claim.repositoryScopeKey
              )
            : undefined;
          if (repositoryBinding) {
            await forwardCodexPayload(
              repositoryBinding,
              payload,
              seenAt,
              sessionId
            );
            continue;
          }
          fallbackRecords.push(
            ...(payload.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? [])
          );
        }
        fallbackPayload = {
          resourceLogs:
            fallbackRecords.length === 0
              ? []
              : [
                  {
                    ...template,
                    scopeLogs: [
                      { ...template.scopeLogs[0], logRecords: fallbackRecords },
                    ],
                  },
                ],
        };
      }
      if (fallbackPayload.resourceLogs.length > 0) {
        await deliverNativeDurably(
          workspaceBinding,
          fallbackPayload,
          seenAt,
          coverageState
        );
      } else {
        state.native.state = coverageState;
        state.native.lastErrorCode = null;
      }
      attribution.unattributed.pendingCount = 0;
      persistAttribution();
      json(response, 200, { partialSuccess: {} });
      return;
    }
    for (const [sessionId, payload] of codexPayloadsBySession(
      sanitized.payload
    )) {
      const recordCount =
        payload.resourceLogs[0]?.scopeLogs[0]?.logRecords?.length ?? 0;
      const claim = attribution.claims[sessionId];
      const binding = claim
        ? configAndStates().bindings.find(
            (candidate) =>
              candidate.host === "codex" &&
              candidate.bindingId === claim.bindingId &&
              candidate.repositoryScopeKey === claim.repositoryScopeKey
          )
        : undefined;
      if (binding) {
        await forwardCodexPayload(binding, payload, seenAt, sessionId);
        continue;
      }
      const existing = codexBuffers.get(sessionId) ?? [];
      const existingCount = existing.reduce(
        (total, entry) => total + entry.recordCount,
        0
      );
      if (
        existingCount + recordCount > MAX_CODEX_BUFFERED_RECORDS_PER_SESSION ||
        bufferedRecordCount + recordCount > MAX_CODEX_BUFFERED_RECORDS
      ) {
        attribution.unattributed.rejectedCount = Math.min(
          1_000_000,
          attribution.unattributed.rejectedCount + recordCount
        );
        journalCodex({
          event: "native.rejected",
          reason: "buffer_capacity",
          sessionHash: codexSessionHash(sessionId),
          seenAt,
          recordCount,
          payload,
        });
        continue;
      }
      existing.push({
        payload,
        recordCount,
        seenAt,
        expiresAt: Date.parse(seenAt) + CODEX_BUFFER_TTL_MS,
      });
      codexBuffers.set(sessionId, existing);
      bufferedRecordCount += recordCount;
      attribution.unattributed.pendingCount += recordCount;
      journalCodex({
        event: "native.buffered",
        reason: "missing_claim",
        sessionHash: codexSessionHash(sessionId),
        seenAt,
        recordCount,
        payload,
      });
    }
    persistAttribution();
    json(response, 200, { partialSuccess: {} });
  }

  const server = createServer(async (request, response) => {
    const delivery =
      request.method === "PUT" ? deliveryRoute(request.url) : null;
    if (
      !(
        (request.method === "GET" &&
          new Set([
            "/health",
            "/health/v1",
            "/health/v2",
            "/native-outbox/v1",
          ]).has(request.url)) ||
        (request.method === "POST" && request.url === "/v1/logs") ||
        (request.method === "POST" &&
          request.url === "/codex/v1/session-claims") ||
        (request.method === "POST" && request.url === "/capture/v1/events") ||
        delivery
      )
    ) {
      json(response, 404, { error: "NOT_FOUND" });
      return;
    }

    if (request.method === "GET" && request.url === "/health/v2") {
      if (
        healthV2 === null ||
        request.headers["x-coredoc-agent-health"] !== healthV2.token
      ) {
        json(response, 401, { error: "AUTH_REJECTED" });
        return;
      }
      json(response, 200, agentHealthDiagnostics());
      return;
    }

    if (
      request.method === "POST" &&
      request.url === "/codex/v1/session-claims"
    ) {
      try {
        const result = await registerCodexClaim(request);
        json(response, result.status === "claimed" ? 200 : 202, result);
      } catch (error) {
        const code =
          error instanceof ManagedRelayError
            ? error.code
            : "CONFIG_UNAVAILABLE";
        closeOversizedRequest(request, response, code);
        json(response, failureStatus(code), { error: code });
      }
      return;
    }

    if (
      request.method === "POST" &&
      request.url === "/v1/logs" &&
      request.headers["x-coredoc-relay-ingress"] !== undefined
    ) {
      try {
        await handleCodexNative(request, response);
      } catch (error) {
        const code =
          error instanceof ManagedRelayError ||
          error instanceof NativeOtlpSanitizerError
            ? error.code
            : "TRANSPORT_UNAVAILABLE";
        closeOversizedRequest(request, response, code);
        json(response, failureStatus(code), {
          partialSuccess: { rejectedLogRecords: 1, errorMessage: code },
        });
      }
      return;
    }

    let resolved;
    try {
      resolved = resolveBinding(request);
    } catch (error) {
      const code =
        error instanceof ManagedRelayError ? error.code : "CONFIG_UNAVAILABLE";
      json(response, failureStatus(code), { error: code });
      return;
    }
    const { binding, state } = resolved;

    if (request.method === "GET" && request.url === "/native-outbox/v1") {
      try {
        json(response, 200, nativeOutbox.diagnostics(binding.bindingId));
      } catch {
        json(response, 502, { error: "NATIVE_OUTBOX_UNAVAILABLE" });
      }
      return;
    }

    if (request.method === "GET") {
      const checkedAt = now();
      if (!isTimestamp(checkedAt)) {
        json(response, failureStatus("CLOCK_UNAVAILABLE"), {
          error: "CLOCK_UNAVAILABLE",
        });
        return;
      }
      rejectExpiredBuffers(Date.parse(checkedAt));
      json(response, 200, healthSnapshot(binding, state, codexHealth(binding)));
      return;
    }

    if (delivery) {
      try {
        const seenAt = now();
        if (!isTimestamp(seenAt)) fail("CLOCK_UNAVAILABLE");
        state.capture.lastSeenAt = seenAt;
        if (request.headers.authorization !== undefined) {
          fail("INVALID_DELIVERY");
        }
        const input = await readJsonBody(
          request,
          delivery.kind === "artifact"
            ? MAX_DELIVERY_BODY_BYTES
            : MAX_BODY_BYTES
        );
        if (delivery.kind === "task") {
          let body;
          try {
            body = taskEnsureRequest(input);
          } catch {
            fail("INVALID_DELIVERY");
          }
          if (
            binding.workspaceMode !== true &&
            body.repositoryKey !== binding.repositoryKey
          ) {
            fail("INVALID_DELIVERY");
          }
          if (binding.workspaceMode === true) {
            await resolveWorkspaceRepository(binding, body.repositoryKey, {
              fetchImpl,
              timeoutMs,
              allowDegraded: false,
            }).then((result) => {
              if (result.status !== "resolved") fail("REPOSITORY_UNAVAILABLE");
            });
          }
          const forwarded = await forwardDelivery(
            binding,
            request.url,
            body,
            fetchImpl,
            timeoutMs
          );
          let receipt;
          try {
            receipt = taskEnsureResponse(await forwarded.json(), {
              taskId: delivery.taskId,
              repositoryKey: body.repositoryKey,
            });
          } catch {
            fail("UPSTREAM_INVALID");
          }
          state.capture.state = "observed";
          state.capture.lastForwardedAt = seenAt;
          state.capture.lastErrorCode = null;
          json(response, 200, receipt);
          return;
        }

        let body;
        try {
          body = artifactRevisionRequest(input);
        } catch {
          fail("INVALID_DELIVERY");
        }
        if (
          binding.workspaceMode !== true &&
          body.repositoryKey !== binding.repositoryKey
        ) {
          fail("INVALID_DELIVERY");
        }
        if (binding.workspaceMode === true) {
          await resolveWorkspaceRepository(binding, body.repositoryKey, {
            fetchImpl,
            timeoutMs,
            allowDegraded: false,
          }).then((result) => {
            if (result.status !== "resolved") fail("REPOSITORY_UNAVAILABLE");
          });
        }
        const forwarded = await forwardDelivery(
          binding,
          request.url,
          body,
          fetchImpl,
          timeoutMs
        );
        let receipt;
        try {
          receipt = artifactRevisionResponse(await forwarded.json(), {
            artifactId: delivery.artifactId,
            body,
            digest: createHash("sha256").update(body.markdown).digest("hex"),
          });
        } catch {
          fail("UPSTREAM_INVALID");
        }
        state.capture.state = "observed";
        state.capture.lastForwardedAt = seenAt;
        state.capture.lastErrorCode = null;
        json(response, 200, receipt);
        return;
      } catch (error) {
        const code =
          error instanceof ManagedRelayError
            ? error.code
            : "TRANSPORT_UNAVAILABLE";
        state.capture.state = "error";
        state.capture.lastErrorCode = code;
        closeOversizedRequest(request, response, code);
        json(response, failureStatus(code), { error: code });
        return;
      }
    }

    const channel = request.url === "/v1/logs" ? "native" : "capture";
    try {
      const seenAt = now();
      if (!isTimestamp(seenAt)) fail("CLOCK_UNAVAILABLE");
      state[channel].lastSeenAt = seenAt;
      const input = await readJsonBody(
        request,
        channel === "native" ? MAX_NATIVE_BODY_BYTES : MAX_BODY_BYTES
      );
      if (channel === "native") {
        const sanitized =
          binding.host === "codex"
            ? sanitizeCodexOtlp(input)
            : sanitizeClaudeOtlp(input);
        const coverageState =
          sanitized.coverage.nativeUsage === "observed" ? "observed" : "ready";
        if (sanitized.payload.resourceLogs.length > 0) {
          await deliverNativeDurably(
            binding,
            sanitized.payload,
            seenAt,
            coverageState
          );
        } else {
          state.native.state = coverageState;
          state.native.lastErrorCode = null;
        }
        json(response, 200, { partialSuccess: {} });
        return;
      }

      const batch = await captureBatch(input, binding, {
        fetchImpl,
        timeoutMs,
      });
      let upstreamReceipt = {
        acceptedEventIds: [],
        duplicateEventIds: [],
        rejected: [],
      };
      if (batch.events.length > 0) {
        const forwarded = await forward(
          binding,
          channel,
          { events: batch.events },
          fetchImpl,
          timeoutMs
        );
        try {
          upstreamReceipt = captureReceipt(
            await forwarded.json(),
            batch.events.map(({ eventId }) => eventId)
          );
        } catch {
          fail("UPSTREAM_INVALID");
        }
        state.capture.lastForwardedAt = seenAt;
      }
      const receipt = captureReceipt(
        {
          ...upstreamReceipt,
          rejected: [...upstreamReceipt.rejected, ...batch.rejected],
        },
        batch.attemptedEventIds
      );
      state.capture.state = batch.events.length > 0 ? "observed" : "ready";
      state.capture.lastErrorCode = batch.repositoryAttributionDegraded
        ? "REPOSITORY_ATTRIBUTION_DEGRADED"
        : null;
      json(response, 200, receipt);
    } catch (error) {
      const code =
        error instanceof ManagedRelayError ||
        error instanceof NativeOtlpSanitizerError
          ? error.code
          : "TRANSPORT_UNAVAILABLE";
      state[channel].state = "error";
      state[channel].lastErrorCode = code;
      closeOversizedRequest(request, response, code);
      if (channel === "native") {
        json(response, failureStatus(code), {
          partialSuccess: {
            rejectedLogRecords: 1,
            errorMessage: code,
          },
        });
      } else {
        json(response, failureStatus(code), { error: code });
      }
    }
  });
  let nativeOutboxDrainInFlight = false;
  async function drainNativeOutbox(maximum = 8) {
    if (nativeOutboxDrainInFlight) return;
    nativeOutboxDrainInFlight = true;
    try {
      const at = now();
      if (!isTimestamp(at)) return;
      let entries;
      let config;
      try {
        entries = nativeOutbox.ready(at).slice(0, maximum);
        config = configAndStates();
      } catch {
        return;
      }
      for (const entry of entries) {
        if (nativeOutboxInFlight.has(entry.record.recordId)) continue;
        const binding = config.bindings.find(
          (candidate) => candidate.bindingId === entry.record.bindingId
        );
        if (
          !binding ||
          binding.host !== entry.record.host ||
          binding.workspaceId !== entry.record.workspaceId
        ) {
          try {
            nativeOutbox.defer(
              entry,
              binding ? "CONFIG_CONFLICT" : "CONFIG_UNAVAILABLE",
              at
            );
          } catch {
            // Marker-owned evidence remains queued for a later healthy drain.
          }
          continue;
        }
        nativeOutboxInFlight.add(entry.record.recordId);
        const state = bindingState(binding);
        try {
          const forwarded = await forward(
            binding,
            "native",
            entry.record.payload,
            fetchImpl,
            timeoutMs
          );
          await cancelResponseBody(forwarded);
          nativeOutbox.acknowledge(entry);
          state.native.state = "observed";
          state.native.lastForwardedAt = at;
          state.native.lastErrorCode = null;
        } catch (error) {
          const code = nativeFailureCode(error);
          state.native.state = "error";
          state.native.lastErrorCode = code;
          try {
            nativeOutbox.defer(entry, code, at);
          } catch {
            // The original durable record remains authoritative.
          }
        } finally {
          nativeOutboxInFlight.delete(entry.record.recordId);
        }
      }
    } catch {
      // A malformed clock or local queue race must not escape an unawaited
      // startup/interval drain. The durable records remain for a later tick.
    } finally {
      nativeOutboxDrainInFlight = false;
    }
  }
  // ---------------------------------------------------------------------------
  // Interval outbox drain. Hooks enqueue capture events into the relay-owned
  // outbox (`<capture-relay>/outbox/<bindingIdentityHash>/`) whenever forwarding
  // fails; historically only the next SessionStart retried them, so a transport
  // blip mid-session left events pending until a NEW session began. The relay is
  // the long-lived process, so it drains every binding's outbox in batches on an
  // interval (and once at startup). Double delivery against the session-start
  // flusher is safe: the upstream dedupes by eventId and returns duplicates as
  // delivered, and both sides delete acknowledged files idempotently.
  // ---------------------------------------------------------------------------
  function outboxDirectoryFor(binding) {
    return join(
      dirname(configPath),
      "outbox",
      managedRelayBindingStorageHash(binding)
    );
  }

  function outboxEntriesFor(binding) {
    const directory = outboxDirectoryFor(binding);
    let names;
    try {
      names = readdirSync(directory).filter((name) =>
        OUTBOX_EVENT_FILE_RE.test(name)
      );
    } catch {
      return [];
    }
    const entries = [];
    for (const name of names.slice(0, MAX_CAPTURE_EVENTS)) {
      const path = join(directory, name);
      try {
        const record = JSON.parse(readFileSync(path, "utf8"));
        const event = captureEvent(record?.event);
        if (`${event.eventId}.event.json` !== name.toLowerCase()) continue;
        if (record?.binding?.workspaceId !== binding.workspaceId) continue;
        entries.push({ path, event });
      } catch {
        // Unreadable entries stay on disk; the session-start flusher owns their accounting.
      }
    }
    entries.sort(
      (left, right) =>
        left.event.occurredAt.localeCompare(right.event.occurredAt) ||
        left.event.eventId.localeCompare(right.event.eventId)
    );
    return entries;
  }

  let outboxDrainInFlight = false;
  async function drainCaptureOutboxes() {
    if (outboxDrainInFlight) return;
    outboxDrainInFlight = true;
    try {
      let config;
      try {
        config = configAndStates();
      } catch {
        return; // Unreadable config heals on a later tick; never crash the relay.
      }
      for (const binding of config.bindings) {
        const entries = outboxEntriesFor(binding);
        if (entries.length === 0) {
          // A transport failure latched by a mid-session forward (e.g. an upstream restart)
          // has nothing left to retry once the outbox is empty, so it would stay red until the
          // NEXT session flush — in relay memory AND in the binding's persisted
          // capture-health.json, which the capture health reporter reads. Probe the same
          // side-effect-free probe endpoint instead. Only its exact authenticated ready contract
          // proves capture readiness; auth and upstream failures remain visible and are retried
          // without fabricating queued events.
          const state = bindingState(binding);
          let persistedError = null;
          try {
            persistedError = captureHealthSnapshot(outboxDirectoryFor(binding), {
              pending: 0,
            }).errorCode;
          } catch {
            // An unreadable health file is the client's fact to re-establish, not ours.
          }
          const probeableErrors = new Set([
            "AUTH_REJECTED",
            "TRANSPORT_UNAVAILABLE",
          ]);
          if (
            !probeableErrors.has(state.capture.lastErrorCode) &&
            !probeableErrors.has(persistedError)
          ) {
            continue;
          }
          try {
            const probed = await fetchImpl(captureProbeEndpoint(binding), {
              method: "POST",
              redirect: "error",
              headers: {
                "content-type": "application/json",
                Authorization: binding.cloudAuthorization,
              },
              body: "{}",
              signal: AbortSignal.timeout(timeoutMs),
            });
            const probeError = await captureProbeError(probed);
            state.capture.state = probeError === null ? "ready" : "error";
            state.capture.lastErrorCode = probeError;
            if (probeableErrors.has(persistedError)) {
              persistCaptureHealth({
                directory: outboxDirectoryFor(binding),
                status: { pending: 0 },
                errorCode: probeError,
                now,
              });
            }
          } catch {
            // Still unreachable — the latched error remains the honest status.
          }
          continue;
        }
        const state = bindingState(binding);
        try {
          const batch = await captureBatch(
            { events: entries.map(({ event }) => event) },
            binding,
            { fetchImpl, timeoutMs }
          );
          // Only local terminal event invalidity and explicit upstream receipt verdicts are
          // settled. Resolver/auth/config failures throw before this point, leaving every valid
          // record durable for a later retry.
          const settled = new Set(
            batch.rejected
              .map(({ eventId }) => eventId)
              .filter((eventId) => eventId !== null)
          );
          if (batch.events.length > 0) {
            const forwarded = await forward(
              binding,
              "capture",
              { events: batch.events },
              fetchImpl,
              timeoutMs
            );
            let receipt;
            try {
              receipt = captureReceipt(
                await forwarded.json(),
                batch.events.map(({ eventId }) => eventId)
              );
            } catch {
              fail("UPSTREAM_INVALID");
            }
            const at = now();
            if (isTimestamp(at)) state.capture.lastForwardedAt = at;
            state.capture.state = "observed";
            state.capture.lastErrorCode = batch.repositoryAttributionDegraded
              ? "REPOSITORY_ATTRIBUTION_DEGRADED"
              : null;
            for (const eventId of receipt.acceptedEventIds) settled.add(eventId);
            for (const eventId of receipt.duplicateEventIds) settled.add(eventId);
            for (const { eventId } of receipt.rejected) {
              if (eventId !== null) settled.add(eventId);
            }
          }
          let remaining = 0;
          for (const { path, event } of entries) {
            if (settled.has(event.eventId)) rmSync(path, { force: true });
            else remaining += 1;
          }
          // The binding's persisted capture-health.json is what the capture health reporter
          // reads; a client-latched error must not outlive the delivery that resolved it. The
          // error clears only when a forward actually succeeded — settling nothing but local
          // rejections proves no transport fact.
          try {
            persistCaptureHealth({
              directory: outboxDirectoryFor(binding),
              status: { pending: remaining },
              ...(batch.events.length > 0
                ? {
                    errorCode: batch.repositoryAttributionDegraded
                      ? "REPOSITORY_ATTRIBUTION_DEGRADED"
                      : null,
                  }
                : {}),
              now,
            });
          } catch {
            // Health persistence is advisory; delivery already succeeded.
          }
        } catch (error) {
          state.capture.state = "error";
          state.capture.lastErrorCode =
            error instanceof ManagedRelayError
              ? error.code
              : "TRANSPORT_UNAVAILABLE";
        }
      }
    } finally {
      outboxDrainInFlight = false;
    }
  }

  let outboxDrainTimer;
  let nativeOutboxDrainTimer;
  server.on("listening", () => {
    void drainCaptureOutboxes();
    void drainNativeOutbox();
    outboxDrainTimer = setInterval(
      () => void drainCaptureOutboxes(),
      outboxFlushIntervalMs
    );
    outboxDrainTimer.unref?.();
    nativeOutboxDrainTimer = setInterval(
      () => void drainNativeOutbox(),
      nativeOutboxFlushIntervalMs
    );
    nativeOutboxDrainTimer.unref?.();
  });
  server.on("close", () => {
    if (outboxDrainTimer) clearInterval(outboxDrainTimer);
    if (nativeOutboxDrainTimer) clearInterval(nativeOutboxDrainTimer);
  });

  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    if (outboxDrainTimer) clearInterval(outboxDrainTimer);
    if (nativeOutboxDrainTimer) clearInterval(nativeOutboxDrainTimer);
    return closeServer((error) => {
      void drainNativeOutbox(1).finally(() => callback?.(error));
    });
  };

  server.maxConnections = MAX_CONNECTIONS;
  server.maxHeadersCount = MAX_HEADERS;
  server.maxRequestsPerSocket = MAX_REQUESTS_PER_SOCKET;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.connectionsCheckingInterval = CONNECTIONS_CHECKING_INTERVAL_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  return server;
}

function relayEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    fail("INVALID_ENDPOINT");
  }
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== "/" ||
    endpoint.search ||
    endpoint.hash
  ) {
    fail("INVALID_ENDPOINT");
  }
  return endpoint.href.replace(/\/$/, "");
}

function healthChannel(value, { capture = false } = {}) {
  const candidate = exactObject(
    value,
    new Set([
      "state",
      "lastSeenAt",
      "lastForwardedAt",
      "lastErrorCode",
      ...(capture ? ["acceptedSchemaVersions"] : []),
    ]),
    "HEALTH_MISMATCH"
  );
  if (
    !new Set(["waiting", "ready", "observed", "error"]).has(candidate.state) ||
    ![candidate.lastSeenAt, candidate.lastForwardedAt].every(
      (entry) => entry === null || isTimestamp(entry)
    ) ||
    (candidate.lastErrorCode !== null &&
      (typeof candidate.lastErrorCode !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,63}$/.test(candidate.lastErrorCode))) ||
    (capture &&
      JSON.stringify(candidate.acceptedSchemaVersions) !==
        JSON.stringify(ACCEPTED_CAPTURE_SCHEMA_VERSIONS))
  ) {
    fail("HEALTH_MISMATCH");
  }
  return {
    state: candidate.state,
    lastSeenAt: candidate.lastSeenAt,
    lastForwardedAt: candidate.lastForwardedAt,
    lastErrorCode: candidate.lastErrorCode,
    ...(capture
      ? { acceptedSchemaVersions: [...ACCEPTED_CAPTURE_SCHEMA_VERSIONS] }
      : {}),
  };
}

export function managedRelayHealth(value) {
  const candidate = exactObject(
    value,
    new Set([
      "schemaVersion",
      "bindingId",
      "host",
      "workspaceId",
      "state",
      "native",
      "capture",
      "attribution",
    ]),
    "HEALTH_MISMATCH"
  );
  if (
    candidate.schemaVersion !== CONFIG_VERSION ||
    typeof candidate.bindingId !== "string" ||
    !UUID_RE.test(candidate.bindingId) ||
    (candidate.host !== "claude-code" && candidate.host !== "codex") ||
    typeof candidate.workspaceId !== "string" ||
    !WORKSPACE_ID_RE.test(candidate.workspaceId) ||
    candidate.state !== "ready"
  ) {
    fail("HEALTH_MISMATCH");
  }
  const attribution = exactObject(
    candidate.attribution,
    new Set(["pendingCount", "rejectedCount", "lastClaimAt"]),
    "HEALTH_MISMATCH"
  );
  if (
    !Number.isInteger(attribution.pendingCount) ||
    attribution.pendingCount < 0 ||
    attribution.pendingCount > 1_000_000 ||
    !Number.isInteger(attribution.rejectedCount) ||
    attribution.rejectedCount < 0 ||
    attribution.rejectedCount > 1_000_000 ||
    (attribution.lastClaimAt !== null && !isTimestamp(attribution.lastClaimAt))
  ) {
    fail("HEALTH_MISMATCH");
  }
  return {
    schemaVersion: CONFIG_VERSION,
    bindingId: candidate.bindingId.toLowerCase(),
    host: candidate.host,
    workspaceId: candidate.workspaceId,
    state: "ready",
    native: healthChannel(candidate.native),
    capture: healthChannel(candidate.capture, { capture: true }),
    attribution: {
      pendingCount: attribution.pendingCount,
      rejectedCount: attribution.rejectedCount,
      lastClaimAt: attribution.lastClaimAt,
    },
  };
}

export async function checkManagedRelay({
  endpoint = `http://127.0.0.1:${MANAGED_RELAY_PORT}`,
  bindingNonce,
  expectedBinding,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  sha256BindingNonce(bindingNonce);
  const expected = relayBinding(expectedBinding);
  let response;
  try {
    response = await fetchImpl(`${relayEndpoint(endpoint)}/health`, {
      method: "GET",
      redirect: "error",
      headers:
        expected.host === "codex"
          ? {
              "X-Coredoc-Relay-Ingress": bindingNonce,
              "X-Coredoc-Relay-Binding-Id": expected.bindingId,
            }
          : { "X-Coredoc-Relay-Binding": bindingNonce },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail("TRANSPORT_UNAVAILABLE");
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    fail(
      response.status === 401 ? "BINDING_MISMATCH" : "TRANSPORT_UNAVAILABLE"
    );
  }
  let health;
  try {
    health = managedRelayHealth(await response.json());
  } catch (error) {
    if (error instanceof ManagedRelayError) throw error;
    fail("HEALTH_MISMATCH");
  }
  if (
    health.bindingId !== expected.bindingId ||
    health.host !== expected.host ||
    health.workspaceId !== expected.workspaceId
  ) {
    fail("HEALTH_MISMATCH");
  }
  return health;
}

export async function ensureManagedRelay({
  attempts = 3,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  retryDelayMs = 100,
  ...options
} = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    fail("INVALID_ENSURE_OPTIONS");
  }
  let failure;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await checkManagedRelay(options);
    } catch (error) {
      failure =
        error instanceof ManagedRelayError
          ? error
          : new ManagedRelayError("TRANSPORT_UNAVAILABLE");
      if (attempt + 1 < attempts) {
        try {
          await wait(retryDelayMs);
        } catch {
          throw failure;
        }
      }
    }
  }
  throw failure;
}

export async function startManagedRelay({
  configPath,
  port = MANAGED_RELAY_PORT,
  agentStatePath,
  runtimeVersion,
  runtimeDigest,
  ...options
} = {}) {
  readManagedRelayConfig(configPath);
  const agentArguments = [agentStatePath, runtimeVersion, runtimeDigest];
  const configuredAgentArguments = agentArguments.filter(
    (value) => value !== undefined
  ).length;
  if (configuredAgentArguments !== 0 && configuredAgentArguments !== 3) {
    fail("INVALID_CONFIG");
  }
  const agentHealth =
    configuredAgentArguments === 0
      ? undefined
      : readCaptureAgentHealthContext({
          statePath: agentStatePath,
          runtimeVersion,
          runtimeDigest,
        });
  const server = createManagedRelay({ configPath, agentHealth, ...options });
  await new Promise((resolve, reject) => {
    const onError = () => reject(new ManagedRelayError("LISTENER_UNAVAILABLE"));
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  return server;
}

export function readCaptureAgentHealthContext({
  statePath,
  runtimeVersion,
  runtimeDigest,
} = {}) {
  if (
    typeof statePath !== "string" ||
    !isAbsolute(statePath) ||
    typeof runtimeVersion !== "string" ||
    !RUNTIME_VERSION_RE.test(runtimeVersion) ||
    typeof runtimeDigest !== "string" ||
    !SHA256_RE.test(runtimeDigest)
  ) {
    fail("INVALID_CONFIG");
  }
  let metadata;
  let candidate;
  try {
    metadata = lstatSync(statePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 64 * 1024 ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && metadata.uid !== process.getuid())
    ) {
      fail("INVALID_CONFIG");
    }
    candidate = JSON.parse(readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error instanceof ManagedRelayError) throw error;
    fail("INVALID_CONFIG");
  }
  if (
    candidate?.schemaVersion !== 1 ||
    candidate?.marker !== CAPTURE_AGENT_STATE_MARKER ||
    typeof candidate?.healthToken !== "string" ||
    !AGENT_HEALTH_TOKEN_RE.test(candidate.healthToken) ||
    candidate?.current?.version !== runtimeVersion ||
    candidate?.current?.digest !== runtimeDigest
  ) {
    fail("INVALID_CONFIG");
  }
  return {
    token: candidate.healthToken,
    runtimeVersion,
    runtimeDigest,
    protocolVersion: 1,
    configSchemaVersion: CONFIG_VERSION,
  };
}

function cliArguments(args) {
  let command = "serve";
  let offset = 0;
  if (new Set(["serve", "check", "ensure"]).has(args[0])) {
    command = args[0];
    offset = 1;
  }
  const values = {};
  for (let index = offset; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !new Set([
        "--config",
        "--endpoint",
        "--agent-state",
        "--runtime-version",
        "--runtime-digest",
      ]).has(flag) ||
      !value
    ) {
      fail("INVALID_ARGUMENTS");
    }
    values[flag] = value;
  }
  if (!values["--config"]) fail("INVALID_ARGUMENTS");
  return { command, values };
}

function configuredBinding(configPath, nonce) {
  const hash = sha256BindingNonce(nonce);
  const binding = readManagedRelayConfig(configPath).bindings.find(
    ({ bindingNonceHash }) => bindingNonceHash === hash
  );
  if (!binding) fail("BINDING_MISMATCH");
  return binding;
}

async function main(env = process.env) {
  const { command, values } = cliArguments(process.argv.slice(2));
  if (command === "serve") {
    const server = await startManagedRelay({
      configPath: values["--config"],
      agentStatePath: values["--agent-state"],
      runtimeVersion: values["--runtime-version"],
      runtimeDigest: values["--runtime-digest"],
    });
    const close = () => server.close();
    server.on("error", () => {
      process.stderr.write("LISTENER_UNAVAILABLE\n");
      process.exitCode = 1;
      close();
    });
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    return;
  }
  const nonce = relayBindingNonceFromCaptureHeaders(
    env.COREDOC_CAPTURE_HEADERS
  );
  const expectedBinding = configuredBinding(values["--config"], nonce);
  const options = {
    endpoint: values["--endpoint"] ?? `http://127.0.0.1:${MANAGED_RELAY_PORT}`,
    bindingNonce: nonce,
    expectedBinding,
  };
  if (command === "check") await checkManagedRelay(options);
  else await ensureManagedRelay(options);
  process.stdout.write("READY\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code ?? "RELAY_FAILED"}\n`);
    process.exitCode = 1;
  });
}
