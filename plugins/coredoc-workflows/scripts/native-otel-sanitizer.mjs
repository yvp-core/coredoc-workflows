#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const NATIVE_OTLP_LOOPBACK_PORT = 43_181;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const COMPACT_VALUE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:+/-]{0,127}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const CODEX_KNOWN_EVENTS = new Set([
  "codex.conversation_starts",
  "codex.sse_event",
  "codex.tool_decision",
  "codex.tool_result",
]);
const CLAUDE_KNOWN_EVENTS = new Set([
  "claude_code.api_request",
  "claude_code.tool_result",
]);

export class NativeOtlpSanitizerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeOtlpSanitizerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new NativeOtlpSanitizerError(code, message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_PAYLOAD", `${label} must be an object`);
  }
  return value;
}

function onlyFields(value, allowed, label) {
  const candidate = object(value, label);
  for (const field of Object.keys(candidate)) {
    if (!allowed.has(field)) {
      fail("UNKNOWN_PAYLOAD_SHAPE", `Unsupported ${label} field: ${field}`);
    }
  }
  return candidate;
}

function attrsToMap(attributes) {
  const result = new Map();
  if (!Array.isArray(attributes)) return result;
  for (const attribute of attributes) {
    if (
      attribute &&
      typeof attribute === "object" &&
      typeof attribute.key === "string" &&
      attribute.value &&
      typeof attribute.value === "object" &&
      !Array.isArray(attribute.value)
    ) {
      result.set(attribute.key, attribute.value);
    }
  }
  return result;
}

function mergeAttributes(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [key, value] of map) merged.set(key, value);
  }
  return merged;
}

function stringValue(attributes, key) {
  const value = attributes.get(key)?.stringValue;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(attributes, key) {
  const value = attributes.get(key);
  if (typeof value?.boolValue === "boolean") return value.boolValue;
  if (value?.stringValue === "true") return true;
  if (value?.stringValue === "false") return false;
  fail("INVALID_RECORD", `${key} must be true or false`);
}

function compactValue(value, label, pattern = COMPACT_VALUE_RE) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("INVALID_RECORD", `${label} must be a compact identifier`);
  }
  return value;
}

function integerValue(attributes, key) {
  const value = attributes.get(key);
  const raw = value?.intValue ?? value?.stringValue;
  if (
    (typeof raw !== "string" && typeof raw !== "number") ||
    !/^\d+$/.test(String(raw))
  ) {
    fail("INVALID_RECORD", `${key} must be a non-negative integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > 1_000_000_000) {
    fail("INVALID_RECORD", `${key} is outside the supported range`);
  }
  return { key, value: { intValue: String(parsed) } };
}

function eventTimestamp(attributes) {
  const timestamp = stringValue(attributes, "event.timestamp");
  if (!timestamp || !ISO_TIMESTAMP_RE.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    fail("INVALID_RECORD", "event.timestamp must be an ISO-8601 timestamp");
  }
  return timestamp;
}

function recordTime(record, field) {
  const value = record[field];
  if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) {
    fail("INVALID_RECORD", `${field} must be an OTLP nanosecond timestamp`);
  }
  return value;
}

function attribute(key, string) {
  return { key, value: { stringValue: string } };
}

function codexCommonAttributes(attributes, version) {
  const sessionId = compactValue(
    stringValue(attributes, "conversation.id"),
    "conversation.id",
    SESSION_ID_RE,
  );
  const model = compactValue(stringValue(attributes, "model"), "model");
  return [
    attribute("event.name", stringValue(attributes, "event.name")),
    attribute("event.timestamp", eventTimestamp(attributes)),
    attribute("conversation.id", sessionId),
    attribute("app.version", version),
    attribute("model", model),
  ];
}

function sanitizedCodexRecord(record, attributes, version, eventName) {
  const output = codexCommonAttributes(attributes, version);
  if (eventName === "codex.conversation_starts") {
    const provider = stringValue(attributes, "provider_name");
    if (provider !== "OpenAI") {
      fail("INVALID_RECORD", "provider_name is not supported");
    }
    output.push(attribute("provider_name", "openai"));
  } else if (eventName === "codex.sse_event") {
    if (stringValue(attributes, "event.kind") !== "response.completed") return null;
    // The genuine 0.146.0 trace contained an internal zero-output completion
    // without this field which Codex excluded from its own turn totals. Keeping
    // the same discriminator prevents inflating the durable session usage.
    const reasoningEffort = stringValue(attributes, "model_reasoning_effort");
    if (!reasoningEffort) return null;
    compactValue(reasoningEffort, "model_reasoning_effort");
    output.push(
      attribute("event.kind", "response.completed"),
      integerValue(attributes, "input_token_count"),
      integerValue(attributes, "output_token_count"),
      integerValue(attributes, "cached_token_count"),
      integerValue(attributes, "cache_write_token_count"),
      integerValue(attributes, "reasoning_token_count"),
      attribute("model_reasoning_effort", reasoningEffort),
    );
  } else if (eventName === "codex.tool_decision") {
    const tool = compactValue(stringValue(attributes, "tool_name"), "tool_name");
    const decision = stringValue(attributes, "decision");
    if (!new Set(["approved", "denied"]).has(decision)) {
      fail("INVALID_RECORD", "tool decision is not supported");
    }
    output.push(attribute("tool_name", tool), attribute("decision", decision));
  } else if (eventName === "codex.tool_result") {
    const tool = compactValue(stringValue(attributes, "tool_name"), "tool_name");
    const success = stringValue(attributes, "success");
    if (success !== "true" && success !== "false") {
      fail("INVALID_RECORD", "tool success must be true or false");
    }
    output.push(
      attribute("tool_name", tool),
      { key: "success", value: { boolValue: success === "true" } },
      integerValue(attributes, "duration_ms"),
    );
  }

  return {
    timeUnixNano: recordTime(record, "timeUnixNano"),
    observedTimeUnixNano: recordTime(record, "observedTimeUnixNano"),
    severityNumber: 9,
    severityText: "INFO",
    body: { stringValue: eventName },
    attributes: output,
    droppedAttributesCount: 0,
  };
}

function versionFor(attributes, resourceAttributes) {
  const recordVersion = stringValue(attributes, "app.version");
  const resourceVersion = stringValue(resourceAttributes, "service.version");
  if (recordVersion && resourceVersion && recordVersion !== resourceVersion) {
    fail("MIXED_VERSIONS", "Resource and record telemetry versions disagree");
  }
  return compactValue(
    recordVersion ?? resourceVersion,
    "telemetry version",
    VERSION_RE,
  );
}

export function sanitizeCodexOtlp(input) {
  const payload = onlyFields(input, new Set(["resourceLogs"]), "OTLP payload");
  if (!Array.isArray(payload.resourceLogs) || payload.resourceLogs.length > 16) {
    fail("INVALID_PAYLOAD", "resourceLogs must contain at most 16 entries");
  }

  const records = [];
  const versions = new Set();
  let usageObserved = false;
  let inspected = 0;
  let hostRecords = 0;

  for (const resourceLog of payload.resourceLogs) {
    const resource = object(resourceLog, "resource log");
    const resourceAttributes = attrsToMap(resource.resource?.attributes);
    if (!Array.isArray(resource.scopeLogs)) continue;
    for (const scopeLog of resource.scopeLogs) {
      if (!Array.isArray(scopeLog?.logRecords)) continue;
      for (const record of scopeLog.logRecords) {
        inspected += 1;
        if (inspected > 1_000) {
          fail("PAYLOAD_TOO_LARGE", "OTLP payload contains more than 1000 records");
        }
        const attributes = mergeAttributes(
          resourceAttributes,
          attrsToMap(record?.attributes),
        );
        const eventName = stringValue(attributes, "event.name");
        if (!eventName?.startsWith("codex.")) continue;
        hostRecords += 1;
        const version = versionFor(attributes, resourceAttributes);
        versions.add(version);
        if (!CODEX_KNOWN_EVENTS.has(eventName)) continue;
        const safe = sanitizedCodexRecord(record, attributes, version, eventName);
        if (!safe) continue;
        if (eventName === "codex.sse_event") usageObserved = true;
        records.push(safe);
      }
    }
  }

  if (versions.size > 1) {
    fail("MIXED_VERSIONS", "One OTLP request must contain one Codex version");
  }
  if (hostRecords === 0) {
    fail("UNKNOWN_PAYLOAD_SHAPE", "OTLP payload contains no Codex records");
  }
  const version = versions.values().next().value ?? null;
  return {
    host: "codex",
    version,
    coverage: {
      nativeUsage: usageObserved ? "observed" : "waiting",
      capabilities: "unavailable",
    },
    droppedRecords: inspected - records.length,
    payload: {
      resourceLogs:
        records.length === 0
          ? []
          : [
              {
                resource: {
                  attributes: [
                    attribute("service.name", "coredoc-native-sanitizer"),
                    attribute("service.version", "1"),
                    attribute("coredoc.host", "codex"),
                    attribute("app.version", version),
                  ],
                  droppedAttributesCount: 0,
                },
                scopeLogs: [
                  {
                    scope: {
                      name: "coredoc.codex.sanitized",
                      version: "1",
                      attributes: [],
                      droppedAttributesCount: 0,
                    },
                    logRecords: records,
                    schemaUrl: "",
                  },
                ],
                schemaUrl: "",
              },
            ],
    },
  };
}

function claudeEventName(record, attributes) {
  const body = record?.body?.stringValue;
  if (typeof body === "string" && body.startsWith("claude_code.")) return body;
  const eventName = stringValue(attributes, "event.name");
  return eventName?.startsWith("claude_code.") ? eventName : undefined;
}

function sanitizedClaudeRecord(record, attributes, version, eventName) {
  const sessionId = compactValue(
    stringValue(attributes, "session.id"),
    "session.id",
    SESSION_ID_RE,
  );
  const output = [
    attribute("event.name", eventName),
    attribute("session.id", sessionId),
    attribute("app.version", version),
  ];
  const model = stringValue(attributes, "model");
  if (model) output.push(attribute("model", compactValue(model, "model")));

  if (eventName === "claude_code.api_request") {
    if (!model) fail("INVALID_RECORD", "model is required for api_request");
    output.push(
      integerValue(attributes, "input_tokens"),
      integerValue(attributes, "output_tokens"),
      integerValue(attributes, "cache_read_tokens"),
      integerValue(attributes, "cache_creation_tokens"),
    );
  } else if (eventName === "claude_code.tool_result") {
    const tool = compactValue(stringValue(attributes, "tool_name"), "tool_name");
    output.push(
      attribute("tool_name", tool),
      { key: "success", value: { boolValue: booleanValue(attributes, "success") } },
      integerValue(attributes, "duration_ms"),
    );
  }

  return {
    timeUnixNano: recordTime(record, "timeUnixNano"),
    observedTimeUnixNano: recordTime(record, "observedTimeUnixNano"),
    severityNumber: 9,
    severityText: "INFO",
    body: { stringValue: eventName },
    attributes: output,
    droppedAttributesCount: 0,
  };
}

export function sanitizeClaudeOtlp(input) {
  const payload = onlyFields(input, new Set(["resourceLogs"]), "OTLP payload");
  if (!Array.isArray(payload.resourceLogs) || payload.resourceLogs.length > 16) {
    fail("INVALID_PAYLOAD", "resourceLogs must contain at most 16 entries");
  }

  const records = [];
  const versions = new Set();
  let usageObserved = false;
  let inspected = 0;
  let hostRecords = 0;

  for (const resourceLog of payload.resourceLogs) {
    const resource = object(resourceLog, "resource log");
    const resourceAttributes = attrsToMap(resource.resource?.attributes);
    if (!Array.isArray(resource.scopeLogs)) continue;
    for (const scopeLog of resource.scopeLogs) {
      if (!Array.isArray(scopeLog?.logRecords)) continue;
      for (const record of scopeLog.logRecords) {
        inspected += 1;
        if (inspected > 1_000) {
          fail("PAYLOAD_TOO_LARGE", "OTLP payload contains more than 1000 records");
        }
        const attributes = mergeAttributes(
          resourceAttributes,
          attrsToMap(record?.attributes),
        );
        const eventName = claudeEventName(record, attributes);
        if (!eventName) continue;
        hostRecords += 1;
        const version = versionFor(attributes, resourceAttributes);
        versions.add(version);
        if (!CLAUDE_KNOWN_EVENTS.has(eventName)) continue;
        const safe = sanitizedClaudeRecord(record, attributes, version, eventName);
        if (eventName === "claude_code.api_request") usageObserved = true;
        records.push(safe);
      }
    }
  }

  if (versions.size > 1) {
    fail("MIXED_VERSIONS", "One OTLP request must contain one Claude version");
  }
  if (hostRecords === 0) {
    fail("UNKNOWN_PAYLOAD_SHAPE", "OTLP payload contains no Claude records");
  }
  const version = versions.values().next().value ?? null;
  return {
    host: "claude-code",
    version,
    coverage: {
      nativeUsage: usageObserved ? "observed" : "waiting",
      capabilities: "unavailable",
    },
    droppedRecords: inspected - records.length,
    payload: {
      resourceLogs:
        records.length === 0
          ? []
          : [
              {
                resource: {
                  attributes: [
                    attribute("service.name", "coredoc-native-sanitizer"),
                    attribute("service.version", "1"),
                    attribute("coredoc.host", "claude-code"),
                    attribute("app.version", version),
                  ],
                  droppedAttributesCount: 0,
                },
                scopeLogs: [
                  {
                    scope: {
                      name: "coredoc.claude-code.sanitized",
                      version: "1",
                      attributes: [],
                      droppedAttributesCount: 0,
                    },
                    logRecords: records,
                    schemaUrl: "",
                  },
                ],
                schemaUrl: "",
              },
            ],
    },
  };
}

function forwardTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    fail("INVALID_CONFIG", "native OTLP forward endpoint must be a URL");
  }
  const loopback = target.hostname === "127.0.0.1" || target.hostname === "[::1]";
  if (
    (target.protocol !== "https:" && !(target.protocol === "http:" && loopback)) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !/^\/api\/v1\/workspaces\/[^/]+\/otel\/v1\/logs\/?$/.test(
      target.pathname,
    )
  ) {
    fail(
      "INVALID_CONFIG",
      "native OTLP forward endpoint must be HTTPS (or loopback HTTP) on a workspace otel/v1/logs path",
    );
  }
  return target.href;
}

function requestAuthorization(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !/^Bearer\s+\S+$/.test(authorization)) {
    fail("INVALID_AUTHORIZATION", "native OTLP loopback request requires Authorization");
  }
  return authorization;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function readJsonBody(request, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let raw = "";
    let tooLarge = false;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        tooLarge = true;
        return;
      }
      raw += chunk;
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new NativeOtlpSanitizerError("PAYLOAD_TOO_LARGE", "OTLP payload is too large"));
        return;
      }
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new NativeOtlpSanitizerError("INVALID_PAYLOAD", "OTLP payload must be JSON"));
      }
    });
    request.on("error", reject);
  });
}

function initialHealth(host) {
  return {
    schemaVersion: 1,
    host,
    configured: true,
    state: "ready",
    lastSeenAt: null,
    lastForwardedAt: null,
    lastError: null,
    coverage: { nativeUsage: "waiting", capabilities: "unavailable" },
  };
}

export function createNativeOtlpSanitizer({
  host = "codex",
  forwardEndpoint,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  timeoutMs = 4_500,
} = {}) {
  if (host !== "codex" && host !== "claude-code") {
    fail("INVALID_CONFIG", "COREDOC_NATIVE_OTLP_HOST must be codex or claude-code");
  }
  const target = forwardTarget(forwardEndpoint);
  const health = initialHealth(host);

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, health);
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/logs") {
      json(response, 404, { error: "NOT_FOUND" });
      return;
    }

    const seenAt = now();
    health.lastSeenAt = seenAt;
    try {
      const input = await readJsonBody(request);
      const sanitized =
        host === "codex" ? sanitizeCodexOtlp(input) : sanitizeClaudeOtlp(input);
      health.coverage = sanitized.coverage;

      if (sanitized.payload.resourceLogs.length > 0) {
        const authorization = requestAuthorization(request);
        const forwarded = await fetchImpl(target, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            Authorization: authorization,
          },
          body: JSON.stringify(sanitized.payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!forwarded.ok) {
          throw new NativeOtlpSanitizerError(
            "FORWARD_FAILED",
            `native OTLP endpoint responded with HTTP ${forwarded.status}`,
          );
        }
        health.lastForwardedAt = seenAt;
      }

      health.state = sanitized.coverage.nativeUsage === "observed" ? "observed" : "ready";
      health.lastError = null;
      json(response, 200, { partialSuccess: {} });
    } catch (error) {
      const code =
        error instanceof NativeOtlpSanitizerError
          ? error.code
          : "FORWARD_FAILED";
      health.state = "error";
      health.lastError = code;
      health.coverage = {
        nativeUsage: "unavailable",
        capabilities: "unavailable",
      };
      const status =
        code === "FORWARD_FAILED"
          ? 502
          : code === "PAYLOAD_TOO_LARGE"
            ? 413
            : 422;
      json(response, status, {
        partialSuccess: {
          rejectedLogRecords: 1,
          errorMessage: code,
        },
      });
    }
  });
}

export async function startNativeOtlpSanitizer({ env = process.env } = {}) {
  const server = createNativeOtlpSanitizer({
    host: env.COREDOC_NATIVE_OTLP_HOST,
    forwardEndpoint: env.COREDOC_NATIVE_OTLP_FORWARD_ENDPOINT,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(NATIVE_OTLP_LOOPBACK_PORT, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startNativeOtlpSanitizer();
    const close = () => server.close();
    server.on("error", (error) => {
      process.stderr.write(`${error.code ?? "RUNTIME_FAILED"}\n`);
      process.exitCode = 1;
      close();
    });
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    process.stderr.write(`${error.code ?? "START_FAILED"}\n`);
    process.exitCode = 1;
  }
}
