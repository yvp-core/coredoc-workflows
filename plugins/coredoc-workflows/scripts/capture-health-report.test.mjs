import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "../test/test-api.mjs";

import { createConfiguredCaptureRecorder } from "./capture-client.mjs";
import {
  artifactCheckpointDirectory,
  createArtifactCheckpointStore,
} from "./artifact-checkpoints.mjs";
import { captureHealthReport } from "./capture-health-report.mjs";
import { renderClaudeGlobalSettings } from "./host-global-config.mjs";
import {
  sha256BindingNonce,
  writeManagedRelayConfig,
} from "./managed-otel-relay.mjs";

const MANAGED_ENDPOINT = "http://127.0.0.1:43181/capture/v1/events";
const BINDING_ONE_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_TWO_ID = "22222222-2222-4222-8222-222222222222";
const NONCE_ONE = "local_binding_abcdefghijklmnopqrstuvwxyz012345";
const NONCE_TWO = "second_binding_abcdefghijklmnopqrstuvwxyz012345";
const EMPTY_ATTRIBUTION = {
  attributionPendingCount: 0,
  attributionRejectedCount: 0,
  attributionLastClaimAt: null,
};

function binding({
  bindingId = BINDING_ONE_ID,
  nonce = NONCE_ONE,
  workspaceId = "workspace-one",
  cloudAuthorization = "Bearer PRIVATE_CLOUD_TOKEN",
} = {}) {
  return {
    schemaVersion: 1,
    bindingId,
    bindingNonceHash: sha256BindingNonce(nonce),
    host: "claude-code",
    workspaceId,
    repositoryKey: "acme/api",
    nativeForwardEndpoint: `https://capture.invalid/api/v1/workspaces/${workspaceId}/otel/v1/logs`,
    captureForwardEndpoint: `https://capture.invalid/api/v1/workspaces/${workspaceId}/capture/v1/events`,
    cloudAuthorization,
  };
}

function managedFixture() {
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-capture-report-state-"));
  const configPath = join(stateHome, "capture-relay", "relay.json");
  const first = binding();
  const second = binding({
    bindingId: BINDING_TWO_ID,
    nonce: NONCE_TWO,
    workspaceId: "workspace-two",
    cloudAuthorization: "Bearer PRIVATE_SECOND_CLOUD_TOKEN",
  });
  writeManagedRelayConfig(configPath, {
    schemaVersion: 1,
    bindings: [first, second],
  });
  return { stateHome, configPath, first, second };
}

test("disabled reporting is exact and direct-cloud reporting uses production env and cwd", () => {
  const never = () => {
    throw new Error("disabled report must not construct a recorder");
  };
  assert.deepEqual(captureHealthReport({ env: {}, createRecorder: never }), {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode: null,
    ...EMPTY_ATTRIBUTION,
  });

  const env = {
    COREDOC_CAPTURE_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer PRIVATE_DIRECT_TOKEN",
  };
  let options;
  const report = captureHealthReport({
    env,
    cwd: "/private/project/path",
    createRecorder: (value) => {
      options = value;
      return {
        health: () => ({
          schemaVersion: 1,
          pendingCount: 2,
          errorCode: "TRANSPORT_UNAVAILABLE",
          updatedAt: "2026-08-16T15:00:00.000Z",
          counters: { overflow: 0, transportFailures: 1 },
          rawMessage: "PRIVATE_RAW_DIAGNOSTIC",
        }),
      };
    },
  });
  assert.deepEqual(options, { env, cwd: "/private/project/path" });
  assert.deepEqual(report, {
    schemaVersion: 1,
    pendingCount: 2,
    errorCode: "TRANSPORT_UNAVAILABLE",
    ...EMPTY_ATTRIBUTION,
  });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|project|path|Bearer/);
});

test("managed reporting resolves exact global binding health without cwd or plaintext nonce", async () => {
  const { stateHome, configPath } = managedFixture();
  const recorder = createConfiguredCaptureRecorder({
    env: {
      COREDOC_CAPTURE_ENDPOINT: MANAGED_ENDPOINT,
      COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Binding=${NONCE_ONE}`,
      COREDOC_CAPTURE_WORKSPACE_ID: "workspace-one",
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    sessionId: "session-42",
    idFactory: () => "33333333-3333-4333-8333-333333333333",
  });
  recorder.record({
    occurredAt: "2026-08-16T15:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
  });

  const managedEnv = {
    COREDOC_RELAY_CONFIG_PATH: configPath,
    COREDOC_RELAY_BINDING_ID: BINDING_ONE_ID,
  };
  assert.deepEqual(captureHealthReport({ env: managedEnv, cwd: "/not-used" }), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "OUTBOX_PENDING",
    ...EMPTY_ATTRIBUTION,
  });
  assert.deepEqual(
    captureHealthReport({
      env: { ...managedEnv, COREDOC_RELAY_BINDING_ID: BINDING_TWO_ID },
      cwd: "/another-not-used",
    }),
    { schemaVersion: 1, pendingCount: 0, errorCode: null, ...EMPTY_ATTRIBUTION },
  );

  await assert.rejects(
    recorder.flush({
      send: async () => {
        throw Object.assign(new Error("PRIVATE_AUTH_RESPONSE"), { status: 403 });
      },
    }),
  );
  assert.deepEqual(captureHealthReport({ env: managedEnv }), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "AUTH_REJECTED",
    ...EMPTY_ATTRIBUTION,
  });
  assert.deepEqual(
    captureHealthReport({
      env: {
        ...managedEnv,
        COREDOC_RELAY_BINDING_ID: "99999999-9999-4999-8999-999999999999",
      },
    }),
    {
      schemaVersion: 1,
      pendingCount: 0,
      errorCode: "CONFIG_CONFLICT",
      ...EMPTY_ATTRIBUTION,
    },
  );
});

test("managed Codex reporting reads pending events under the writer's exact binding fingerprint", () => {
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-codex-report-state-"));
  const configPath = join(stateHome, "capture-relay", "relay.json");
  const configured = {
    ...binding({ bindingId: BINDING_ONE_ID, nonce: NONCE_ONE, workspaceId: "workspace-one" }),
    host: "codex",
    repositoryScopeKey: "repo-111111111111111111111111",
    profileName: null,
  };
  writeManagedRelayConfig(configPath, { schemaVersion: 1, bindings: [configured] });
  const recorder = createConfiguredCaptureRecorder({
    env: {
      COREDOC_CAPTURE_ENDPOINT: MANAGED_ENDPOINT,
      COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Ingress=${NONCE_ONE},X-Coredoc-Relay-Binding-Id=${BINDING_ONE_ID}`,
      COREDOC_CAPTURE_BINDING_ID: BINDING_ONE_ID,
      COREDOC_CAPTURE_WORKSPACE_ID: "workspace-one",
      COREDOC_CAPTURE_HOST: "codex",
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    sessionId: "codex-session",
    idFactory: () => "44444444-4444-4444-8444-444444444444",
  });
  recorder.record({
    occurredAt: "2026-08-18T15:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
  });

  assert.deepEqual(
    captureHealthReport({
      env: {
        COREDOC_RELAY_CONFIG_PATH: configPath,
        COREDOC_RELAY_BINDING_ID: BINDING_ONE_ID,
      },
    }),
    {
      schemaVersion: 1,
      pendingCount: 1,
      errorCode: "OUTBOX_PENDING",
      ...EMPTY_ATTRIBUTION,
    },
  );
});

test("rendered workspace Claude env records and reports from the stable binding-ID directory", () => {
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-claude-workspace-report-state-"));
  const configPath = join(stateHome, "capture-relay", "relay.json");
  const legacy = binding({
    bindingId: BINDING_ONE_ID,
    nonce: NONCE_ONE,
    workspaceId: "33333333-3333-4333-8333-333333333333",
  });
  const { repositoryKey: _repositoryKey, ...withoutRepository } = legacy;
  const configured = { ...withoutRepository, workspaceMode: true };
  writeManagedRelayConfig(configPath, {
    schemaVersion: 1,
    bindings: [configured],
  });
  const rendered = JSON.parse(
    renderClaudeGlobalSettings("{}", {
      operation: "install",
      ingressToken: NONCE_ONE,
      bindingId: BINDING_ONE_ID,
      workspaceId: "33333333-3333-4333-8333-333333333333",
    }),
  ).env;
  const recorder = createConfiguredCaptureRecorder({
    env: {
      ...rendered,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    cwd: stateHome,
    sessionId: "claude-session",
    idFactory: () => "55555555-5555-4555-8555-555555555555",
  });
  recorder.record({
    occurredAt: "2026-09-01T12:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
  });

  assert.deepEqual(
    captureHealthReport({
      env: {
        COREDOC_RELAY_CONFIG_PATH: configPath,
        COREDOC_RELAY_BINDING_ID: BINDING_ONE_ID,
      },
    }),
    {
      schemaVersion: 1,
      pendingCount: 1,
      errorCode: "OUTBOX_PENDING",
      ...EMPTY_ATTRIBUTION,
    },
  );
});

test("health report CLI emits one bounded object and never config secrets or paths", () => {
  const { stateHome, configPath } = managedFixture();
  const result = spawnSync(
    process.execPath,
    [new URL("./capture-health-report.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COREDOC_CAPTURE_ENDPOINT: "",
        COREDOC_CAPTURE_HEADERS: "",
        COREDOC_RELAY_CONFIG_PATH: configPath,
        COREDOC_RELAY_BINDING_ID: BINDING_ONE_ID,
      },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    '{"schemaVersion":1,"pendingCount":0,"errorCode":null,"attributionPendingCount":0,"attributionRejectedCount":0,"attributionLastClaimAt":null}\n',
  );
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /PRIVATE|Bearer|capture\.invalid|capture-report-state|relay\.json/,
  );

  const partial = spawnSync(
    process.execPath,
    [new URL("./capture-health-report.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COREDOC_CAPTURE_ENDPOINT: "",
        COREDOC_RELAY_CONFIG_PATH: `${configPath}-PRIVATE_MISSING`,
        COREDOC_RELAY_BINDING_ID: "",
      },
    },
  );
  assert.equal(partial.status, 0);
  assert.equal(partial.stderr, "");
  assert.equal(
    partial.stdout,
    '{"schemaVersion":1,"pendingCount":0,"errorCode":"CONFIG_CONFLICT","attributionPendingCount":0,"attributionRejectedCount":0,"attributionLastClaimAt":null}\n',
  );
  assert.doesNotMatch(partial.stdout, /PRIVATE|MISSING|relay\.json/);
});

test("package exposes the dependency-free capture health report command", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.scripts["capture-health:report"],
    "./bin/coredoc-workflows capture-health",
  );
});

test("managed health folds binding-scoped artifact pending and overflow into the bounded triplet", () => {
  const { configPath, first } = managedFixture();
  const directory = artifactCheckpointDirectory(
    dirname(configPath),
    first.bindingNonceHash,
  );
  const store = createArtifactCheckpointStore({ directory });
  const markdown = "# pending";
  store.enqueue({
    artifactId: "cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    digest: createHash("sha256").update(markdown).digest("hex"),
    body: {
      taskId: "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      repositoryKey: "acme/api",
      kind: "spec",
      checkpoint: "run-finish",
      markdown,
    },
  });
  const env = {
    COREDOC_RELAY_CONFIG_PATH: configPath,
    COREDOC_RELAY_BINDING_ID: BINDING_ONE_ID,
  };
  assert.deepEqual(captureHealthReport({ env }), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "OUTBOX_PENDING",
    ...EMPTY_ATTRIBUTION,
  });
  store.markError("OUTBOX_OVERFLOW");
  assert.deepEqual(captureHealthReport({ env }), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "OUTBOX_OVERFLOW",
    ...EMPTY_ATTRIBUTION,
  });
  store.markError("REPOSITORY_UNAVAILABLE");
  assert.deepEqual(captureHealthReport({ env }), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "REPOSITORY_UNAVAILABLE",
    ...EMPTY_ATTRIBUTION,
  });
});
