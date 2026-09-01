#!/usr/bin/env node

import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

import { createFileOutbox } from "../runtime/capture/file-outbox.mjs";
import {
  CAPTURE_HEALTH_ERROR_CODES,
  captureHealthSnapshot,
} from "../runtime/capture/health.mjs";

import {
  createConfiguredCaptureRecorder,
  managedCaptureDirectoryForConfig,
} from "./capture-client.mjs";
import {
  artifactCheckpointDirectory,
  artifactCheckpointHealth,
} from "./artifact-checkpoints.mjs";
import {
  managedRelayBindingStorageHash,
  readManagedRelayConfig,
} from "./managed-otel-relay.mjs";
import { codexAttributionHealth } from "./codex-attribution-state.mjs";

const MANAGED_CAPTURE_ENDPOINT =
  "http://127.0.0.1:43181/capture/v1/events";
const REPORT_ERROR_CODES = new Set([
  ...CAPTURE_HEALTH_ERROR_CODES,
  "REPOSITORY_UNAVAILABLE",
]);

function cleanReport(errorCode = null) {
  return {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode,
    attributionPendingCount: 0,
    attributionRejectedCount: 0,
    attributionLastClaimAt: null,
  };
}

function boundedReport(value) {
  const attributionPendingCount = value?.attributionPendingCount ?? 0;
  const attributionRejectedCount = value?.attributionRejectedCount ?? 0;
  const attributionLastClaimAt = value?.attributionLastClaimAt ?? null;
  if (
    value?.schemaVersion !== 1 ||
    !Number.isInteger(value.pendingCount) ||
    value.pendingCount < 0 ||
    value.pendingCount > 1_000 ||
    (value.errorCode !== null &&
      !REPORT_ERROR_CODES.has(value.errorCode)) ||
    !Number.isInteger(attributionPendingCount) ||
    attributionPendingCount < 0 ||
    attributionPendingCount > 1_000_000 ||
    !Number.isInteger(attributionRejectedCount) ||
    attributionRejectedCount < 0 ||
    attributionRejectedCount > 1_000_000 ||
    (attributionLastClaimAt !== null &&
      (typeof attributionLastClaimAt !== "string" ||
        Number.isNaN(Date.parse(attributionLastClaimAt))))
  ) {
    throw new Error("invalid capture health report");
  }
  return {
    schemaVersion: 1,
    pendingCount: value.pendingCount,
    errorCode: value.errorCode,
    attributionPendingCount,
    attributionRejectedCount,
    attributionLastClaimAt,
  };
}

function managedReport(env) {
  const configPath = env.COREDOC_RELAY_CONFIG_PATH;
  const bindingId = env.COREDOC_RELAY_BINDING_ID;
  if (
    typeof configPath !== "string" ||
    configPath.length === 0 ||
    typeof bindingId !== "string" ||
    bindingId.length === 0
  ) {
    throw new Error("invalid managed capture health input");
  }
  const binding = readManagedRelayConfig(configPath).bindings.find(
    (candidate) => candidate.bindingId === bindingId,
  );
  if (!binding) throw new Error("managed capture binding is unavailable");
  const localBindingHash = managedRelayBindingStorageHash(binding);
  const directory = managedCaptureDirectoryForConfig(localBindingHash, configPath);
  const credentialFingerprint =
    binding.host === "codex"
      ? createHash("sha256")
          .update(`${binding.bindingNonceHash}:${binding.bindingId}`)
          .digest("hex")
      : binding.bindingNonceHash;
  const outbox = createFileOutbox({
    directory,
    binding: {
      endpoint: MANAGED_CAPTURE_ENDPOINT,
      workspaceId: binding.workspaceId,
      credentialFingerprint,
    },
  });
  const capture = captureHealthSnapshot(directory, outbox.status());
  const artifacts = artifactCheckpointHealth(
    artifactCheckpointDirectory(
      dirname(configPath),
      localBindingHash,
    ),
  );
  const errors = new Set([capture.errorCode, artifacts.errorCode]);
  const errorCode = [
    "CONFIG_CONFLICT",
    "AUTH_REJECTED",
    "REPOSITORY_UNAVAILABLE",
    "UNSUPPORTED_SCHEMA_VERSION",
    "OUTBOX_OVERFLOW",
    "BINDING_MISMATCH",
    "TRANSPORT_UNAVAILABLE",
    "OUTBOX_PENDING",
  ].find((code) => errors.has(code));
  const attribution =
    binding.host === "codex"
      ? codexAttributionHealth(configPath, binding.bindingId)
      : { pendingCount: 0, rejectedCount: 0, lastClaimAt: null };
  return boundedReport({
    schemaVersion: 1,
    pendingCount: capture.pendingCount + artifacts.pendingCount,
    errorCode: errorCode ?? null,
    attributionPendingCount: attribution.pendingCount,
    attributionRejectedCount: attribution.rejectedCount,
    attributionLastClaimAt: attribution.lastClaimAt,
  });
}

export function captureHealthReport({
  env = process.env,
  cwd = process.cwd(),
  createRecorder = createConfiguredCaptureRecorder,
} = {}) {
  const managedInput =
    env.COREDOC_RELAY_CONFIG_PATH !== undefined ||
    env.COREDOC_RELAY_BINDING_ID !== undefined;
  if (!managedInput && !env.COREDOC_CAPTURE_ENDPOINT) return cleanReport();
  try {
    return managedInput
      ? managedReport(env)
      : boundedReport(createRecorder({ env, cwd }).health());
  } catch {
    return cleanReport("CONFIG_CONFLICT");
  }
}

function main() {
  process.stdout.write(`${JSON.stringify(captureHealthReport())}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
