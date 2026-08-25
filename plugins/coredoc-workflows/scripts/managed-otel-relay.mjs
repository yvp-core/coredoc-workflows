#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, isAbsolute, join } from "node:path";
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
import { resolveRepositoryScopeKey } from "./project-key.mjs";

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
      "repositoryKey",
      "repositoryScopeKey",
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
  return {
    schemaVersion: CONFIG_VERSION,
    bindingId: value.bindingId.toLowerCase(),
    bindingNonceHash: value.bindingNonceHash,
    host: value.host,
    workspaceId: value.workspaceId,
    repositoryKey: normalizedRepositoryKey(value.repositoryKey),
    ...(value.host === "codex"
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
        }
      : value.repositoryScopeKey === undefined &&
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
  const codexScopes = codex.map(({ repositoryScopeKey }) => repositoryScopeKey);
  const claudeNonces = new Set(
    bindings
      .filter(({ host }) => host === "claude-code")
      .map(({ bindingNonceHash }) => bindingNonceHash)
  );
  if (
    codexNonces.size > 1 ||
    new Set(codexScopes).size !== codexScopes.length ||
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

function isTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function captureBatch(input, binding) {
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
  return { events: forwarded, attemptedEventIds, rejected };
}

async function cancelResponseBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the bounded upstream result exposed by the relay.
  }
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
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outboxFlushIntervalMs = OUTBOX_FLUSH_INTERVAL_MS,
} = {}) {
  if (typeof configPath !== "string" || configPath.length === 0) {
    fail("INVALID_CONFIG");
  }
  const states = new Map();
  const attributionPath = codexAttributionStatePath(configPath);
  const journalPath = join(dirname(configPath), CODEX_JOURNAL_NAME);

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
    let repositoryScopeKey;
    try {
      repositoryScopeKey = resolveRepositoryScopeKey(body.cwd);
    } catch {
      repositoryScopeKey = null;
    }
    const binding = bindings.find(
      (candidate) => candidate.repositoryScopeKey === repositoryScopeKey
    );
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
    resolveCodexIngress(request);
    const seenAt = now();
    if (!isTimestamp(seenAt)) fail("CLOCK_UNAVAILABLE");
    const seenAtMs = Date.parse(seenAt);
    attribution = pruneCodexAttributionState(attribution, seenAtMs);
    rejectExpiredBuffers(seenAtMs);
    const sanitized = sanitizeCodexOtlp(
      await readJsonBody(request, MAX_NATIVE_BODY_BYTES)
    );
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
        (request.method === "GET" && request.url === "/health") ||
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

    if (request.method === "GET") {
      rejectExpiredBuffers(Date.now());
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
        if (binding.repositoryKey === undefined) fail("INVALID_DELIVERY");
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
          if (body.repositoryKey !== binding.repositoryKey) {
            fail("INVALID_DELIVERY");
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
              repositoryKey: binding.repositoryKey,
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
        if (body.repositoryKey !== binding.repositoryKey) {
          fail("INVALID_DELIVERY");
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
        if (sanitized.payload.resourceLogs.length > 0) {
          const forwarded = await forward(
            binding,
            channel,
            sanitized.payload,
            fetchImpl,
            timeoutMs
          );
          await cancelResponseBody(forwarded);
          state.native.lastForwardedAt = seenAt;
        }
        state.native.state =
          sanitized.coverage.nativeUsage === "observed" ? "observed" : "ready";
        state.native.lastErrorCode = null;
        json(response, 200, { partialSuccess: {} });
        return;
      }

      const batch = captureBatch(input, binding);
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
      state.capture.lastErrorCode = null;
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
  // ---------------------------------------------------------------------------
  // Interval outbox drain. Hooks enqueue capture events into the relay-owned
  // outbox (`<capture-relay>/outbox/<bindingNonceHash>/`) whenever forwarding
  // fails; historically only the next SessionStart retried them, so a transport
  // blip mid-session left events pending until a NEW session began. The relay is
  // the long-lived process, so it drains every binding's outbox in batches on an
  // interval (and once at startup). Double delivery against the session-start
  // flusher is safe: the upstream dedupes by eventId and returns duplicates as
  // delivered, and both sides delete acknowledged files idempotently.
  // ---------------------------------------------------------------------------
  function outboxDirectoryFor(binding) {
    return join(dirname(configPath), "outbox", binding.bindingNonceHash);
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
          // capture-health.json, which the desktop's health report reads. Probe the same
          // endpoint instead: ANY HTTP response — even the 4xx an empty batch earns — proves
          // the transport recovered. Other error codes (auth, upstream verdicts) are not
          // transport facts and stay until a real forward.
          const state = bindingState(binding);
          let persistedError = null;
          try {
            persistedError = captureHealthSnapshot(outboxDirectoryFor(binding), {
              pending: 0,
            }).errorCode;
          } catch {
            // An unreadable health file is the client's fact to re-establish, not ours.
          }
          if (
            state.capture.lastErrorCode !== "TRANSPORT_UNAVAILABLE" &&
            persistedError !== "TRANSPORT_UNAVAILABLE"
          ) {
            continue;
          }
          try {
            const probed = await fetchImpl(binding.captureForwardEndpoint, {
              method: "POST",
              redirect: "error",
              headers: {
                "content-type": "application/json",
                Authorization: binding.cloudAuthorization,
              },
              body: '{"events":[]}',
              signal: AbortSignal.timeout(timeoutMs),
            });
            await cancelResponseBody(probed);
            state.capture.state = "ready";
            state.capture.lastErrorCode = null;
            if (persistedError === "TRANSPORT_UNAVAILABLE") {
              persistCaptureHealth({
                directory: outboxDirectoryFor(binding),
                status: { pending: 0 },
                errorCode: null,
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
          const batch = captureBatch(
            { events: entries.map(({ event }) => event) },
            binding
          );
          // Rejections are FINAL verdicts (host/repository mismatch against the binding, or an
          // upstream contradiction) — leaving those files pending would retry a poison event
          // every tick forever, which is exactly the failure mode this drain replaces.
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
            state.capture.lastErrorCode = null;
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
          // The binding's persisted capture-health.json is what the desktop's health report
          // reads; a client-latched error must not outlive the delivery that resolved it. The
          // error clears only when a forward actually succeeded — settling nothing but local
          // rejections proves no transport fact.
          try {
            persistCaptureHealth({
              directory: outboxDirectoryFor(binding),
              status: { pending: remaining },
              ...(batch.events.length > 0 ? { errorCode: null } : {}),
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
  server.on("listening", () => {
    void drainCaptureOutboxes();
    outboxDrainTimer = setInterval(
      () => void drainCaptureOutboxes(),
      outboxFlushIntervalMs
    );
    outboxDrainTimer.unref?.();
  });
  server.on("close", () => {
    if (outboxDrainTimer) clearInterval(outboxDrainTimer);
  });

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
  ...options
} = {}) {
  readManagedRelayConfig(configPath);
  const server = createManagedRelay({ configPath, ...options });
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
    if (!new Set(["--config", "--endpoint"]).has(flag) || !value) {
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
    const server = await startManagedRelay({ configPath: values["--config"] });
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
