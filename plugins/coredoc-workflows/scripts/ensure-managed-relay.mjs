#!/usr/bin/env node

import { appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  acceptedSchemaVersionList,
  relayBindingNonceFromCaptureHeaders,
} from "./managed-otel-relay.mjs";

const MANAGED_CAPTURE_ENDPOINT =
  "http://127.0.0.1:43181/capture/v1/events";
const MANAGED_RELAY_ENDPOINT = "http://127.0.0.1:43181";
const SAFE_FAILURE_CODES = new Set([
  "BINDING_MISMATCH",
  "CONFIG_UNAVAILABLE",
  "HEALTH_MISMATCH",
  "TRANSPORT_UNAVAILABLE",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKSPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function managedRelayConfigPath(home) {
  if (
    typeof home !== "string" ||
    home.length === 0 ||
    !isAbsolute(home)
  ) {
    throw new Error("INVALID_HOME");
  }
  return join(
    home,
    ".coredoc",
    "capture-agent",
    "capture-relay",
    "relay.json",
  );
}

function unavailable(error, fallback = "CONFIG_UNAVAILABLE") {
  const code = SAFE_FAILURE_CODES.has(error?.code) ? error.code : fallback;
  return { status: "unavailable", code };
}

function relayFailure(code) {
  return Object.assign(new Error(code), { code });
}

function exactFields(value, fields) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.size &&
    Object.keys(value).every((field) => fields.has(field))
  );
}

function validTimestamp(value) {
  return (
    value === null ||
    (typeof value === "string" &&
      ISO_TIMESTAMP_RE.test(value) &&
      !Number.isNaN(Date.parse(value)))
  );
}

function validHealthChannel(value, { capture = false } = {}) {
  return (
    exactFields(
      value,
      new Set([
        "state",
        "lastSeenAt",
        "lastForwardedAt",
        "lastErrorCode",
        ...(capture ? ["acceptedSchemaVersions"] : []),
      ]),
    ) &&
    new Set(["waiting", "ready", "observed", "error"]).has(value.state) &&
    validTimestamp(value.lastSeenAt) &&
    validTimestamp(value.lastForwardedAt) &&
    (value.lastErrorCode === null ||
      (typeof value.lastErrorCode === "string" &&
        /^[A-Z][A-Z0-9_]{0,63}$/.test(value.lastErrorCode))) &&
    (!capture || acceptedSchemaVersionList(value.acceptedSchemaVersions) !== null)
  );
}

function validAttributionHealth(value) {
  return (
    exactFields(
      value,
      new Set(["pendingCount", "rejectedCount", "lastClaimAt"]),
    ) &&
    Number.isInteger(value.pendingCount) &&
    value.pendingCount >= 0 &&
    value.pendingCount <= 1_000_000 &&
    Number.isInteger(value.rejectedCount) &&
    value.rejectedCount >= 0 &&
    value.rejectedCount <= 1_000_000 &&
    validTimestamp(value.lastClaimAt)
  );
}

function validHealth(value, expectedWorkspaceId) {
  return (
    exactFields(
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
    ) &&
    value.schemaVersion === 1 &&
    typeof value.bindingId === "string" &&
    UUID_RE.test(value.bindingId) &&
    value.host === "claude-code" &&
    typeof value.workspaceId === "string" &&
    WORKSPACE_ID_RE.test(value.workspaceId) &&
    value.workspaceId === expectedWorkspaceId &&
    value.state === "ready" &&
    validHealthChannel(value.native) &&
    validHealthChannel(value.capture, { capture: true }) &&
    validAttributionHealth(value.attribution)
  );
}

async function pollManagedRelay({
  bindingNonce,
  expectedWorkspaceId,
  fetchImpl,
  wait,
}) {
  let failure = relayFailure("TRANSPORT_UNAVAILABLE");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(`${MANAGED_RELAY_ENDPOINT}/health`, {
        method: "GET",
        redirect: "error",
        headers: { "X-Coredoc-Relay-Binding": bindingNonce },
        signal: AbortSignal.timeout(300),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // The closed status below remains safe when disposal fails.
        }
        throw relayFailure(
          response.status === 401
            ? "BINDING_MISMATCH"
            : "TRANSPORT_UNAVAILABLE",
        );
      }
      let health;
      try {
        health = await response.json();
      } catch {
        throw relayFailure("HEALTH_MISMATCH");
      }
      if (!validHealth(health, expectedWorkspaceId)) {
        throw relayFailure("HEALTH_MISMATCH");
      }
      return health;
    } catch (error) {
      failure = SAFE_FAILURE_CODES.has(error?.code)
        ? error
        : relayFailure("TRANSPORT_UNAVAILABLE");
      if (attempt === 0) {
        try {
          await wait(50);
        } catch {
          throw failure;
        }
      }
    }
  }
  throw failure;
}

export async function ensureManagedRelayAtSessionStart({
  env = process.env,
  home = homedir(),
  exists = existsSync,
  fetchImpl = fetch,
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (env.COREDOC_CAPTURE_ENDPOINT !== MANAGED_CAPTURE_ENDPOINT) {
    return { status: "unconfigured" };
  }

  let bindingNonce;
  try {
    bindingNonce = relayBindingNonceFromCaptureHeaders(
      env.COREDOC_CAPTURE_HEADERS,
    );
  } catch {
    return { status: "unconfigured" };
  }
  const expectedWorkspaceId = env.COREDOC_CAPTURE_WORKSPACE_ID;
  if (
    typeof expectedWorkspaceId !== "string" ||
    !WORKSPACE_ID_RE.test(expectedWorkspaceId)
  ) {
    return { status: "unconfigured" };
  }

  let configPath;
  try {
    configPath = managedRelayConfigPath(home);
    if (!exists(configPath)) return { status: "unconfigured" };
  } catch (error) {
    return unavailable(error);
  }

  try {
    const health = await pollManagedRelay({
      bindingNonce,
      expectedWorkspaceId,
      fetchImpl,
      wait,
    });
    return {
      status: "ready",
      acceptedSchemaVersions: acceptedSchemaVersionList(
        health.capture.acceptedSchemaVersions,
      ),
    };
  } catch (error) {
    return unavailable(error, "TRANSPORT_UNAVAILABLE");
  }
}

/**
 * Hand the relay's accepted schema versions to the frequent hooks of this
 * session through the host env file. The observer performs no HTTP, so this
 * SessionStart read is its only way to know whether the relay takes a newer
 * event schema before recording one.
 */
export function sessionEnvExport(result) {
  return result?.status === "ready" && result.acceptedSchemaVersions
    ? `export COREDOC_CAPTURE_ACCEPTED_SCHEMA_VERSIONS=${result.acceptedSchemaVersions.join(",")}\n`
    : "";
}

// The one failure worth surfacing: a listener answered on the managed relay
// port but refused or failed our binding identity, so host telemetry may be
// flowing to an unknown local process. Everything else stays silent fail-open.
export const BINDING_MISMATCH_NOTICE =
  "Coredoc: the local capture relay port is answering with a different identity; " +
  "telemetry export may not be reaching the managed relay. " +
  "Run capture doctor, then repair the plugin-managed capture agent.";

export async function runSessionStartEnsure({
  write = (line) => process.stdout.write(line),
  envFile = process.env.CLAUDE_ENV_FILE,
  appendEnv = (path, text) => appendFileSync(path, text, "utf8"),
  ...options
} = {}) {
  const result = await ensureManagedRelayAtSessionStart(options);
  if (result.status === "unavailable" && result.code === "BINDING_MISMATCH") {
    write(`${BINDING_MISMATCH_NOTICE}\n`);
  }
  const exported = sessionEnvExport(result);
  if (exported && envFile) {
    try {
      appendEnv(envFile, exported);
    } catch {
      // The env export is best-effort; a missing version list only keeps newer events local-off.
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSessionStartEnsure().catch(() => {
    /* Managed relay recovery is fail-open and silent during SessionStart. */
  });
}
