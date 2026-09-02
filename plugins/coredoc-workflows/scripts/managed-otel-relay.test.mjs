import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  checkManagedRelay,
  createManagedRelay,
  ensureManagedRelay,
  readCaptureAgentHealthContext,
  readManagedRelayConfig,
  relayBindingNonceFromCaptureHeaders,
  removeManagedRelayBinding,
  sha256BindingNonce,
  upsertManagedRelayBinding,
  writeManagedRelayConfig,
} from "./managed-otel-relay.mjs";
import { sanitizeCodexOtlp } from "./native-otel-sanitizer.mjs";
import { resolveRepositoryScopeKey } from "./project-key.mjs";
import {
  artifactCheckpointDirectory,
  createArtifactCheckpointStore,
} from "./artifact-checkpoints.mjs";

const CODEX_FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "./hosts/fixtures/codex-0.146.0-otlp.redacted.json",
      import.meta.url
    ),
    "utf8"
  )
).payload;

const BINDING_ONE_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_TWO_ID = "22222222-2222-4222-8222-222222222222";

function codexFixtureSessionId() {
  for (const resourceLog of CODEX_FIXTURE.resourceLogs) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const value = record.attributes?.find(
          ({ key }) => key === "conversation.id"
        )?.value?.stringValue;
        if (value) return value;
      }
    }
  }
  throw new Error("Codex fixture has no conversation id");
}

function codexFixtureForSession(sessionId) {
  return JSON.parse(
    JSON.stringify(CODEX_FIXTURE).replaceAll(codexFixtureSessionId(), sessionId)
  );
}

function readCodexRelayJournal(directory) {
  const path = join(directory, "codex-relay-events.jsonl");
  return {
    path,
    entries: readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  };
}

function binding({
  bindingId = BINDING_ONE_ID,
  nonce = "local-binding-one",
  host = "claude-code",
  workspaceId = "ws-one",
  repositoryKey = "acme/api",
  withoutRepository = false,
  cloudAuthorization = "Bearer cloud-token-one",
  nativeForwardEndpoint,
  captureForwardEndpoint,
} = {}) {
  return {
    schemaVersion: 1,
    bindingId,
    bindingNonceHash: sha256BindingNonce(nonce),
    host,
    workspaceId,
    ...(withoutRepository ? {} : { repositoryKey }),
    ...(host === "codex"
      ? {
          repositoryScopeKey: `repo-${bindingId
            .replace(/-/g, "")
            .slice(0, 24)}`,
          profileName: null,
        }
      : {}),
    nativeForwardEndpoint:
      nativeForwardEndpoint ??
      `https://capture.invalid/api/v1/workspaces/${workspaceId}/otel/v1/logs`,
    captureForwardEndpoint:
      captureForwardEndpoint ??
      `https://capture.invalid/api/v1/workspaces/${workspaceId}/capture/v1/events`,
    cloudAuthorization,
  };
}

function workspaceBinding(options = {}) {
  const configured = binding({ ...options, withoutRepository: true });
  delete configured.repositoryScopeKey;
  delete configured.profileName;
  return { ...configured, workspaceMode: true };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for relay state");
}

function nativeQueueRecordPaths(directory, bindingId) {
  const bindingDirectory = join(directory, "native-outbox", bindingId);
  if (!existsSync(bindingDirectory)) return [];
  return readdirSync(bindingDirectory)
    .filter((name) => name.endsWith(".native.json"))
    .sort()
    .map((name) => join(bindingDirectory, name));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function claudeFixture() {
  const attr = (key, value) => ({ key, value: { stringValue: value } });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr("service.version", "2.1.232"),
            attr("host.name", "PRIVATE_PATH_SENTINEL"),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1786870800000000000",
                observedTimeUnixNano: "1786870800001000000",
                body: { stringValue: "claude_code.api_request" },
                attributes: [
                  attr("session.id", "claude-session-fixture"),
                  attr("app.version", "2.1.232"),
                  attr("model", "claude-sonnet-4-6"),
                  attr("input_tokens", "120"),
                  attr("output_tokens", "30"),
                  attr("cache_read_tokens", "40"),
                  attr("cache_creation_tokens", "5"),
                  attr("prompt", "PRIVATE_PROMPT_SENTINEL"),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function startedEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "33333333-3333-4333-8333-333333333333",
    occurredAt: "2026-08-16T12:00:00.000Z",
    host: "claude-code",
    sessionId: "session-42",
    runId: "cdr-20260816-a1b2c3",
    repositoryKey: "acme/api",
    type: "workflow.run.started",
    data: {
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      scale: "normal",
    },
    ...overrides,
  };
}

test("authenticated relay health advertises the exact accepted capture schemas", async () => {
  const channel = {
    state: "ready",
    lastSeenAt: null,
    lastForwardedAt: null,
    lastErrorCode: null,
  };
  const checked = await checkManagedRelay({
    bindingNonce: "local-binding-one",
    expectedBinding: binding(),
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          bindingId: BINDING_ONE_ID,
          host: "claude-code",
          workspaceId: "ws-one",
          state: "ready",
          native: channel,
          capture: { ...channel, acceptedSchemaVersions: [1, 2, 3] },
          attribution: { pendingCount: 0, rejectedCount: 0, lastClaimAt: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      ),
  });

  assert.deepEqual(checked.capture.acceptedSchemaVersions, [1, 2, 3]);
});

test("serves authenticated agent health v2 without changing exact binding health v1", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-health-v2-"));
  const path = join(directory, "capture-agent", "capture-relay", "relay.json");
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [binding()] });
  const agentOutbox = join(directory, "capture-agent", "outbox");
  mkdirSync(agentOutbox, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentOutbox, "pending.json"), "{}\n", { mode: 0o600 });
  const relay = createManagedRelay({
    configPath: path,
    agentHealth: {
      token: "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
      runtimeVersion: "0.11.3",
      runtimeDigest: "a".repeat(64),
      protocolVersion: 1,
      configSchemaVersion: 1,
    },
  });
  const port = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${port}`;
  const bindingHeaders = { "X-Coredoc-Relay-Binding": "local-binding-one" };

  const unauthorized = await fetch(`${endpoint}/health/v2`);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "AUTH_REJECTED" });

  const v2 = await fetch(`${endpoint}/health/v2`, {
    headers: {
      "X-Coredoc-Agent-Health":
        "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
    },
  });
  assert.equal(v2.status, 200);
  assert.deepEqual(await v2.json(), {
    schemaVersion: 2,
    state: "degraded",
    runtimeVersion: "0.11.3",
    runtimeDigest: "a".repeat(64),
    protocolVersion: 1,
    configSchemaVersion: 1,
    fixedWorkspaceHash: createHash("sha256").update("ws-one").digest("hex"),
    hostIngress: {
      claudeCode: "ready",
      codex: "unconfigured",
    },
    queueCounts: {
      native: 0,
      semantic: 0,
      artifact: 0,
      agent: 1,
      total: 1,
    },
    lastSuccessfulDeliveryAt: null,
    repositoryAttribution: "ready",
    degradedReasons: ["CODEX_INGRESS_UNCONFIGURED", "QUEUE_PENDING"],
  });

  const legacy = await (await fetch(`${endpoint}/health`, { headers: bindingHeaders })).json();
  const versionedV1 = await (
    await fetch(`${endpoint}/health/v1`, { headers: bindingHeaders })
  ).json();
  assert.deepEqual(versionedV1, legacy);
  assert.deepEqual(Object.keys(legacy), [
    "schemaVersion",
    "bindingId",
    "host",
    "workspaceId",
    "state",
    "native",
    "capture",
    "attribution",
  ]);
});

test("authenticated health v2 surfaces artifact-only repository attribution failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-artifact-health-v2-"));
  const path = join(directory, "capture-agent", "capture-relay", "relay.json");
  const configured = binding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const artifactStore = createArtifactCheckpointStore({
    directory: artifactCheckpointDirectory(
      join(directory, "capture-agent", "capture-relay"),
      configured.bindingNonceHash,
    ),
  });
  artifactStore.markError("REPOSITORY_UNAVAILABLE");
  const relay = createManagedRelay({
    configPath: path,
    agentHealth: {
      token: "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
      runtimeVersion: "0.11.3",
      runtimeDigest: "a".repeat(64),
      protocolVersion: 1,
      configSchemaVersion: 1,
    },
  });
  const port = await listen(relay);
  t.after(() => close(relay));

  const health = await (
    await fetch(`http://127.0.0.1:${port}/health/v2`, {
      headers: {
        "X-Coredoc-Agent-Health":
          "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    })
  ).json();
  assert.equal(health.state, "degraded");
  assert.equal(health.repositoryAttribution, "unavailable");
  assert.equal(health.queueCounts.artifact, 0);
  assert.deepEqual(health.degradedReasons, [
    "CODEX_INGRESS_UNCONFIGURED",
    "REPOSITORY_UNAVAILABLE",
  ]);
  assert.doesNotMatch(JSON.stringify(health), /acme|Bearer|artifact-outbox/);
});

test("loads agent health identity only from a matching mode-0600 lifecycle state", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-agent-health-state-"));
  const statePath = join(directory, "state.json");
  writeFileSync(
    statePath,
    `${JSON.stringify({
      schemaVersion: 1,
      marker: "coredoc-workflows.capture-agent.v1",
      healthToken: "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
      current: {
        version: "0.11.3",
        digest: "a".repeat(64),
      },
      previous: null,
    })}\n`,
    { mode: 0o600 }
  );
  assert.deepEqual(
    readCaptureAgentHealthContext({
      statePath,
      runtimeVersion: "0.11.3",
      runtimeDigest: "a".repeat(64),
    }),
    {
      token: "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
      runtimeVersion: "0.11.3",
      runtimeDigest: "a".repeat(64),
      protocolVersion: 1,
      configSchemaVersion: 1,
    }
  );
  chmodSync(statePath, 0o644);
  assert.throws(
    () =>
      readCaptureAgentHealthContext({
        statePath,
        runtimeVersion: "0.11.3",
        runtimeDigest: "a".repeat(64),
      }),
    (error) => error?.code === "INVALID_CONFIG"
  );
});

test("writes and atomically replaces a versioned mode-0600 multi-binding relay config", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-config-")
  );
  const path = join(directory, "relay.json");
  const first = binding();
  const second = binding({
    bindingId: BINDING_TWO_ID,
    nonce: "local-binding-two",
    host: "codex",
    workspaceId: "ws-two",
    cloudAuthorization: "Bearer cloud-token-two",
  });

  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [first] });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readManagedRelayConfig(path), {
    schemaVersion: 1,
    bindings: [first],
  });

  upsertManagedRelayBinding(path, {
    ...first,
    cloudAuthorization: "Bearer replacement-cloud-token",
  });
  upsertManagedRelayBinding(path, second);
  assert.deepEqual(readManagedRelayConfig(path), {
    schemaVersion: 1,
    bindings: [
      { ...first, cloudAuthorization: "Bearer replacement-cloud-token" },
      second,
    ],
  });
  assert.deepEqual(readdirSync(directory), ["relay.json"]);

  assert.equal(removeManagedRelayBinding(path, BINDING_ONE_ID), true);
  assert.deepEqual(readManagedRelayConfig(path), {
    schemaVersion: 1,
    bindings: [second],
  });
  assert.equal(removeManagedRelayBinding(path, BINDING_ONE_ID), false);

  chmodSync(path, 0o644);
  assert.throws(
    () => readManagedRelayConfig(path),
    (error) => error?.code === "CONFIG_UNAVAILABLE"
  );
});

test("round-trips exact workspace-mode bindings without weakening legacy binding schemas", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-workspace-config-")
  );
  const path = join(directory, "relay.json");
  const claude = workspaceBinding();
  const codex = workspaceBinding({
    bindingId: BINDING_TWO_ID,
    nonce: "workspace-codex-ingress",
    host: "codex",
    workspaceId: "ws-two",
    cloudAuthorization: "Bearer workspace-codex-token",
  });

  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [claude, codex],
  });
  assert.deepEqual(readManagedRelayConfig(path), {
    schemaVersion: 1,
    bindings: [claude, codex],
  });

  const legacy = binding();
  assert.deepEqual(
    readManagedRelayConfig(
      (() => {
        const legacyPath = join(directory, "legacy.json");
        writeManagedRelayConfig(legacyPath, {
          schemaVersion: 1,
          bindings: [legacy],
        });
        return legacyPath;
      })()
    ),
    { schemaVersion: 1, bindings: [legacy] }
  );

  for (const invalid of [
    { ...claude, repositoryKey: "acme/api" },
    { ...claude, repositoryScopeKey: "repo-111111111111111111111111" },
    { ...claude, profileName: null },
    { ...claude, workspaceMode: false },
    { ...claude, enabled: true },
  ]) {
    assert.throws(
      () => writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [invalid] }),
      (error) => error?.code === "INVALID_CONFIG"
    );
  }

  assert.throws(
    () =>
      writeManagedRelayConfig(path, {
        schemaVersion: 1,
        bindings: [
          claude,
          workspaceBinding({
            bindingId: BINDING_TWO_ID,
            nonce: "second-claude-workspace",
            workspaceId: "ws-two",
          }),
        ],
      }),
    (error) => error?.code === "INVALID_CONFIG"
  );
  assert.throws(
    () =>
      writeManagedRelayConfig(path, {
        schemaVersion: 1,
        bindings: [
          codex,
          binding({
            host: "codex",
            nonce: "workspace-codex-ingress",
            workspaceId: "ws-three",
          }),
        ],
      }),
    (error) => error?.code === "INVALID_CONFIG"
  );
  assert.throws(
    () =>
      writeManagedRelayConfig(path, {
        schemaVersion: 1,
        bindings: [
          claude,
          workspaceBinding({
            bindingId: BINDING_TWO_ID,
            nonce: "local-binding-one",
            host: "codex",
            workspaceId: "ws-two",
          }),
        ],
      }),
    (error) => error?.code === "INVALID_CONFIG"
  );
});

test("accepts one machine ingress token for distinct Codex repository scopes and rejects ambiguous scopes", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-codex-scopes-")
  );
  const path = join(directory, "relay.json");
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const first = {
    ...binding({
      host: "codex",
      nonce: ingress,
      workspaceId: "ws-one",
      repositoryKey: "acme/api",
    }),
    repositoryScopeKey: "repo-111111111111111111111111",
    profileName: null,
  };
  const second = {
    ...binding({
      bindingId: BINDING_TWO_ID,
      host: "codex",
      nonce: ingress,
      workspaceId: "ws-two",
      repositoryKey: "other/web",
      cloudAuthorization: "Bearer cloud-token-two",
    }),
    repositoryScopeKey: "repo-222222222222222222222222",
    profileName: "pilot",
  };

  assert.doesNotThrow(() =>
    writeManagedRelayConfig(path, {
      schemaVersion: 1,
      bindings: [first, second],
    })
  );
  assert.throws(
    () =>
      writeManagedRelayConfig(path, {
        schemaVersion: 1,
        bindings: [
          first,
          { ...second, repositoryScopeKey: first.repositoryScopeKey },
        ],
      }),
    (error) => error?.code === "INVALID_CONFIG"
  );
});

test("routes one machine ingress to two Codex repositories only after exact session claims", async (t) => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    requests.push({ url: request.url, body: await readJson(request) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-two-repos-")
  );
  const firstCwd = join(directory, "repo-one");
  const secondCwd = join(directory, "repo-two");
  mkdirSync(join(firstCwd, ".git"), { recursive: true });
  mkdirSync(join(secondCwd, ".git"), { recursive: true });
  const path = join(directory, "relay.json");
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const first = {
    ...binding({
      host: "codex",
      nonce: ingress,
      workspaceId: "ws-one",
      repositoryKey: "acme/api",
      nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/otel/v1/logs`,
    }),
    repositoryScopeKey: resolveRepositoryScopeKey(firstCwd),
  };
  const second = {
    ...binding({
      bindingId: BINDING_TWO_ID,
      host: "codex",
      nonce: ingress,
      workspaceId: "ws-two",
      repositoryKey: "other/web",
      nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-two/otel/v1/logs`,
      captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-two/capture/v1/events`,
      cloudAuthorization: "Bearer cloud-token-two",
    }),
    repositoryScopeKey: resolveRepositoryScopeKey(secondCwd),
  };
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [first, second],
  });
  const relay = createManagedRelay({ configPath: path });
  const relayPort = await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const claim = (sessionId, cwd) =>
    fetch(`${endpoint}/codex/v1/session-claims`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Coredoc-Relay-Ingress": ingress,
      },
      body: JSON.stringify({ sessionId, cwd }),
    });
  assert.equal(
    (await claim("session-one", firstCwd)).status,
    200
  );
  assert.equal(
    (await claim("session-two", secondCwd)).status,
    200
  );
  for (const sessionId of ["session-one", "session-two"]) {
    const response = await fetch(`${endpoint}/v1/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Coredoc-Relay-Ingress": ingress,
      },
      body: JSON.stringify(codexFixtureForSession(sessionId)),
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "/api/v1/workspaces/ws-one/otel/v1/logs",
      "/api/v1/workspaces/ws-two/otel/v1/logs",
    ]
  );
  const unmapped = await claim("session-unmapped", join(directory, "unmapped"));
  assert.equal(unmapped.status, 202);
  assert.equal(requests.length, 2);
  const journal = readCodexRelayJournal(directory);
  assert.equal(statSync(journal.path).mode & 0o777, 0o600);
  assert.deepEqual(
    journal.entries
      .filter(({ event }) => event === "claim.accepted")
      .map(({ bindingId }) => bindingId),
    [first.bindingId, second.bindingId]
  );
  assert.equal(
    journal.entries.some(
      ({ event, reason }) =>
        event === "claim.unmapped" && reason === "repository_unmapped"
    ),
    true
  );
  assert.deepEqual(
    journal.entries
      .filter(({ event }) => event === "native.forwarded")
      .map(({ payload }) => payload),
    requests.map(({ body }) => body)
  );
  assert.equal(readFileSync(journal.path, "utf8").includes(ingress), false);
  assert.equal(
    readFileSync(journal.path, "utf8").includes(first.cloudAuthorization),
    false
  );
  for (const secret of [
    "PROMPT_SECRET_SENTINEL",
    "COMMAND_ARGUMENT_SECRET_SENTINEL",
    "TOOL_OUTPUT_SECRET_SENTINEL",
  ]) {
    assert.equal(readFileSync(journal.path, "utf8").includes(secret), false);
  }
  const bodySuppliedScope = await fetch(`${endpoint}/codex/v1/session-claims`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": ingress,
    },
    body: JSON.stringify({
      sessionId: "body-supplied-scope",
      repositoryScopeKey: first.repositoryScopeKey,
    }),
  });
  assert.equal(bodySuppliedScope.status, 422);
  await close(relay);
  const restarted = createManagedRelay({ configPath: path });
  const restartedPort = await listen(restarted);
  t.after(() => close(restarted));
  const afterRestart = await fetch(
    `http://127.0.0.1:${restartedPort}/v1/logs`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Coredoc-Relay-Ingress": ingress,
      },
      body: JSON.stringify(codexFixtureForSession("session-one")),
    }
  );
  assert.equal(afterRestart.status, 200);
  assert.equal(requests.at(-1).url, "/api/v1/workspaces/ws-one/otel/v1/logs");
  assert.equal(requests.length, 3);
});

test("forwards a unique workspace-mode Codex binding immediately while claims stay diagnostic", async (t) => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    requests.push({ url: request.url, body: await readJson(request) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-workspace-codex-native-")
  );
  const path = join(directory, "relay.json");
  const configured = workspaceBinding({
    host: "codex",
    nonce: "workspace-codex-ingress",
    nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/otel/v1/logs`,
    captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/capture/v1/events`,
  });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const relay = createManagedRelay({ configPath: path });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const ingressHeaders = {
    "content-type": "application/json",
    "X-Coredoc-Relay-Ingress": "workspace-codex-ingress",
  };

  const first = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: ingressHeaders,
    body: JSON.stringify(CODEX_FIXTURE),
  });
  assert.equal(first.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "/api/v1/workspaces/ws-one/otel/v1/logs"
  );

  const claim = await fetch(`${endpoint}/codex/v1/session-claims`, {
    method: "POST",
    headers: ingressHeaders,
    body: JSON.stringify({
      sessionId: codexFixtureSessionId(),
      cwd: join(directory, "unregistered-repository"),
    }),
  });
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), {
    status: "claimed",
    bindingId: configured.bindingId,
  });

  const second = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: ingressHeaders,
    body: JSON.stringify(CODEX_FIXTURE),
  });
  assert.equal(second.status, 200);
  assert.equal(requests.length, 2);
  const health = await (
    await fetch(`${endpoint}/health`, {
      headers: {
        "X-Coredoc-Relay-Ingress": "workspace-codex-ingress",
        "X-Coredoc-Relay-Binding-Id": configured.bindingId,
      },
    })
  ).json();
  assert.equal(health.attribution.pendingCount, 0);
  assert.equal(health.attribution.rejectedCount, 0);
  assert.equal(typeof health.attribution.lastClaimAt, "string");
});

test("pins the first Codex repository claim and serializes its buffered drain", async (t) => {
  const forwarded = [];
  const releases = [];
  let firstForwarded;
  const sawFirstForward = new Promise((resolve) => {
    firstForwarded = resolve;
  });
  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-claim-pin-"));
  const firstCwd = join(directory, "repo-one");
  const secondCwd = join(directory, "repo-two");
  mkdirSync(join(firstCwd, ".git"), { recursive: true });
  mkdirSync(join(secondCwd, ".git"), { recursive: true });
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const first = {
    ...binding({ host: "codex", nonce: ingress, workspaceId: "ws-one", repositoryKey: "acme/api" }),
    repositoryScopeKey: resolveRepositoryScopeKey(firstCwd),
  };
  const second = {
    ...binding({
      bindingId: BINDING_TWO_ID,
      host: "codex",
      nonce: ingress,
      workspaceId: "ws-two",
      repositoryKey: "other/web",
      cloudAuthorization: "Bearer cloud-token-two",
    }),
    repositoryScopeKey: resolveRepositoryScopeKey(secondCwd),
  };
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [first, second] });
  const relay = createManagedRelay({
    configPath: path,
    fetchImpl: (url, options) =>
      new Promise((resolve) => {
        forwarded.push({ url: String(url), authorization: options.headers.Authorization });
        releases.push(() => resolve(new Response(null, { status: 200 })));
        firstForwarded();
      }),
  });
  const relayPort = await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const headers = {
    "content-type": "application/json",
    "X-Coredoc-Relay-Ingress": ingress,
  };
  const native = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers,
    body: JSON.stringify(codexFixtureForSession("shared-session")),
  });
  assert.equal(native.status, 200);
  const claim = (cwd) =>
    fetch(`${endpoint}/codex/v1/session-claims`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sessionId: "shared-session", cwd }),
    });

  const firstClaim = claim(firstCwd);
  await sawFirstForward;
  const conflictingClaim = claim(secondCwd);
  await new Promise((resolve) => setImmediate(resolve));
  for (const release of releases) release();
  const [firstResponse, conflictingResponse] = await Promise.all([firstClaim, conflictingClaim]);

  assert.equal(firstResponse.status, 200);
  assert.equal(conflictingResponse.status, 409);
  assert.deepEqual(forwarded, [
    {
      url: first.nativeForwardEndpoint,
      authorization: first.cloudAuthorization,
    },
  ]);
});

test("turns an in-memory pre-claim buffer into visible rejections after relay restart", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-restart-buffer-")
  );
  const path = join(directory, "relay.json");
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const configured = binding({ host: "codex", nonce: ingress });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });

  const relay = createManagedRelay({ configPath: path });
  const relayPort = await listen(relay);
  const native = await fetch(`http://127.0.0.1:${relayPort}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": ingress,
    },
    body: JSON.stringify(codexFixtureForSession("session-without-claim")),
  });
  assert.equal(native.status, 200);
  const headers = {
    "X-Coredoc-Relay-Ingress": ingress,
    "X-Coredoc-Relay-Binding-Id": configured.bindingId,
  };
  const beforeRestart = await (
    await fetch(`http://127.0.0.1:${relayPort}/health`, { headers })
  ).json();
  assert.ok(beforeRestart.attribution.pendingCount > 0);
  assert.equal(beforeRestart.attribution.rejectedCount, 0);
  await close(relay);

  const restarted = createManagedRelay({ configPath: path });
  const restartedPort = await listen(restarted);
  t.after(() => close(restarted));
  const afterRestart = await (
    await fetch(`http://127.0.0.1:${restartedPort}/health`, { headers })
  ).json();
  assert.equal(afterRestart.attribution.pendingCount, 0);
  assert.equal(
    afterRestart.attribution.rejectedCount,
    beforeRestart.attribution.pendingCount
  );
  const journal = readCodexRelayJournal(directory);
  const buffered = journal.entries.find(
    ({ event }) => event === "native.buffered"
  );
  assert.equal(buffered.reason, "missing_claim");
  assert.deepEqual(
    buffered.payload,
    sanitizeCodexOtlp(codexFixtureForSession("session-without-claim")).payload
  );
  assert.equal(
    journal.entries.some(
      ({ event, reason, recordCount }) =>
        event === "native.rejected" &&
        reason === "relay_restart" &&
        recordCount === beforeRestart.attribution.pendingCount
    ),
    true
  );
});

test("keeps a pre-claim Codex buffer visible and retryable when its first flush fails", async (t) => {
  let rejectUpstream = true;
  const requests = [];
  const upstream = createServer(async (request, response) => {
    requests.push({ url: request.url, body: await readJson(request) });
    response.writeHead(rejectUpstream ? 503 : 200, {
      "content-type": "application/json",
    });
    response.end("{}\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-buffer-retry-")
  );
  const cwd = join(directory, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const path = join(directory, "relay.json");
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const configured = {
    ...binding({
      host: "codex",
      nonce: ingress,
      nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/otel/v1/logs`,
    }),
    repositoryScopeKey: resolveRepositoryScopeKey(cwd),
  };
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const relay = createManagedRelay({ configPath: path });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const ingressHeaders = {
    "content-type": "application/json",
    "X-Coredoc-Relay-Ingress": ingress,
  };
  const native = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: ingressHeaders,
    body: JSON.stringify(codexFixtureForSession("retry-buffer-session")),
  });
  assert.equal(native.status, 200);
  const claimBody = JSON.stringify({
    sessionId: "retry-buffer-session",
    cwd,
  });
  const firstClaim = await fetch(`${endpoint}/codex/v1/session-claims`, {
    method: "POST",
    headers: ingressHeaders,
    body: claimBody,
  });
  assert.equal(firstClaim.status, 502);
  const healthHeaders = {
    "X-Coredoc-Relay-Ingress": ingress,
    "X-Coredoc-Relay-Binding-Id": configured.bindingId,
  };
  const failedHealth = await (
    await fetch(`${endpoint}/health`, { headers: healthHeaders })
  ).json();
  assert.ok(failedHealth.attribution.pendingCount > 0);
  assert.equal(failedHealth.native.state, "error");

  rejectUpstream = false;
  const retryClaim = await fetch(`${endpoint}/codex/v1/session-claims`, {
    method: "POST",
    headers: ingressHeaders,
    body: claimBody,
  });
  assert.equal(retryClaim.status, 200);
  const recoveredHealth = await (
    await fetch(`${endpoint}/health`, { headers: healthHeaders })
  ).json();
  assert.equal(recoveredHealth.attribution.pendingCount, 0);
  assert.equal(recoveredHealth.native.state, "observed");
  assert.equal(requests.length, 2);
});

test("stops routing a persisted Codex session claim after its TTL", async (t) => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    requests.push({ url: request.url, body: await readJson(request) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}\n");
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-claim-ttl-")
  );
  const cwd = join(directory, "repo");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const path = join(directory, "relay.json");
  const ingress = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  const configured = {
    ...binding({
      host: "codex",
      nonce: ingress,
      nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/otel/v1/logs`,
    }),
    repositoryScopeKey: resolveRepositoryScopeKey(cwd),
  };
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  let clock = "2026-08-18T10:00:00.000Z";
  const relay = createManagedRelay({ configPath: path, now: () => clock });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const claim = await fetch(`${endpoint}/codex/v1/session-claims`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": ingress,
    },
    body: JSON.stringify({
      sessionId: "expired-session",
      cwd,
    }),
  });
  assert.equal(claim.status, 200);

  clock = "2026-08-26T10:00:00.000Z";
  const native = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": ingress,
    },
    body: JSON.stringify(codexFixtureForSession("expired-session")),
  });
  assert.equal(native.status, 200);
  assert.equal(requests.length, 0);

  const health = await (
    await fetch(`${endpoint}/health`, {
      headers: {
        "X-Coredoc-Relay-Ingress": ingress,
        "X-Coredoc-Relay-Binding-Id": configured.bindingId,
      },
    })
  ).json();
  assert.ok(health.attribution.pendingCount > 0);
  assert.equal(health.attribution.rejectedCount, 0);

  clock = "2026-08-26T10:00:31.000Z";
  const expiredHealth = await (
    await fetch(`${endpoint}/health`, {
      headers: {
        "X-Coredoc-Relay-Ingress": ingress,
        "X-Coredoc-Relay-Binding-Id": configured.bindingId,
      },
    })
  ).json();
  assert.equal(expiredHealth.attribution.pendingCount, 0);
  assert.ok(expiredHealth.attribution.rejectedCount > 0);
});

test("rejects cloud authorization containing header whitespace", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-auth-"));
  const path = join(directory, "relay.json");

  assert.throws(
    () =>
      writeManagedRelayConfig(path, {
        schemaVersion: 1,
        bindings: [binding({ cloudAuthorization: "Bearer\ncloud-token" })],
      }),
    (error) => error?.code === "INVALID_CONFIG"
  );
});

test("derives the check/ensure nonce from the managed host environment only", () => {
  assert.equal(
    relayBindingNonceFromCaptureHeaders(
      "X-Coredoc-Relay-Binding=local-binding-from-host-settings"
    ),
    "local-binding-from-host-settings"
  );
  for (const headers of [
    "Authorization=Bearer cloud-token",
    "X-Coredoc-Relay-Binding=local,Authorization=Bearer cloud-token",
    "X-Coredoc-Relay-Binding=contains whitespace",
  ]) {
    assert.throws(
      () => relayBindingNonceFromCaptureHeaders(headers),
      (error) => error?.code === "INVALID_BINDING_NONCE"
    );
  }
});

test("bounds concurrent connections and slow request lifetimes", () => {
  const relay = createManagedRelay({ configPath: "/synthetic/relay.json" });

  assert.equal(relay.maxConnections, 32);
  assert.equal(relay.requestTimeout, 30_000);
  assert.equal(relay.headersTimeout, 5_000);
  assert.equal(relay.connectionsCheckingInterval, 1_000);
  assert.equal(relay.keepAliveTimeout, 1_000);
  assert.equal(relay.maxRequestsPerSocket, 100);
  assert.equal(relay.maxHeadersCount, 64);
});

test("routes exact bindings, replaces authorization, sanitizes native logs, and reloads config", async (t) => {
  const requests = [];
  const upstreams = [
    createServer(async (request, response) => {
      requests.push({
        upstream: "one",
        url: request.url,
        headers: request.headers,
        body: await readJson(request),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}\n");
    }),
    createServer(async (request, response) => {
      requests.push({
        upstream: "two",
        url: request.url,
        headers: request.headers,
        body: await readJson(request),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}\n");
    }),
  ];
  const ports = await Promise.all(upstreams.map(listen));
  t.after(() => Promise.all(upstreams.map(close)));

  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-http-"));
  const secondCwd = join(directory, "repo-two");
  mkdirSync(join(secondCwd, ".git"), { recursive: true });
  const path = join(directory, "relay.json");
  const first = binding({
    nativeForwardEndpoint: `http://127.0.0.1:${ports[0]}/api/v1/workspaces/ws-one/otel/v1/logs`,
    captureForwardEndpoint: `http://127.0.0.1:${ports[0]}/api/v1/workspaces/ws-one/capture/v1/events`,
  });
  const second = {
    ...binding({
      bindingId: BINDING_TWO_ID,
      nonce: "local-binding-two",
      host: "codex",
      workspaceId: "ws-two",
      cloudAuthorization: "Bearer cloud-token-two",
      nativeForwardEndpoint: `http://127.0.0.1:${ports[1]}/api/v1/workspaces/ws-two/otel/v1/logs`,
      captureForwardEndpoint: `http://127.0.0.1:${ports[1]}/api/v1/workspaces/ws-two/capture/v1/events`,
    }),
    repositoryScopeKey: resolveRepositoryScopeKey(secondCwd),
  };
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [first, second],
  });

  const relay = createManagedRelay({ configPath: path });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;

  const firstResponse = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer hostile-incoming-token",
      "X-Coredoc-Relay-Binding": "local-binding-one",
    },
    body: JSON.stringify(claudeFixture()),
  });
  assert.equal(firstResponse.status, 200);

  const secondResponse = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": "local-binding-two",
    },
    body: JSON.stringify(CODEX_FIXTURE),
  });
  assert.equal(secondResponse.status, 200);

  assert.equal(requests.length, 1);
  const claim = await fetch(`${endpoint}/codex/v1/session-claims`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": "local-binding-two",
    },
    body: JSON.stringify({
      sessionId: codexFixtureSessionId(),
      cwd: secondCwd,
    }),
  });
  assert.equal(claim.status, 200);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].upstream, "one");
  assert.equal(requests[0].headers.authorization, "Bearer cloud-token-one");
  assert.equal(requests[0].headers["x-coredoc-relay-binding"], undefined);
  assert.doesNotMatch(JSON.stringify(requests[0].body), /PRIVATE_/);
  assert.equal(requests[1].upstream, "two");
  assert.equal(requests[1].headers.authorization, "Bearer cloud-token-two");

  upsertManagedRelayBinding(path, {
    ...first,
    cloudAuthorization: "Bearer replacement-cloud-token",
  });
  const replacement = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
    body: JSON.stringify(claudeFixture()),
  });
  assert.equal(replacement.status, 200);
  assert.equal(
    requests.at(-1).headers.authorization,
    "Bearer replacement-cloud-token"
  );

  const beforeUnknown = requests.length;
  const unknown = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers: { "X-Coredoc-Relay-Binding": "foreign-binding" },
    body: JSON.stringify(claudeFixture()),
  });
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { error: "BINDING_MISMATCH" });
  assert.equal(requests.length, beforeUnknown);
});

test("cancels ignored native and rejected upstream response bodies", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-response-bodies-")
  );
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [binding()],
  });
  const ignoredResponses = [
    new Response("PRIVATE_NATIVE_RESPONSE", { status: 200 }),
    new Response("PRIVATE_CAPTURE_ERROR", { status: 500 }),
    new Response("PRIVATE_DELIVERY_CONFLICT", { status: 409 }),
  ];
  const upstreamResponses = [...ignoredResponses];
  const relay = createManagedRelay({
    configPath: path,
    fetchImpl: async () => upstreamResponses.shift(),
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const headers = { "X-Coredoc-Relay-Binding": "local-binding-one" };

  const native = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers,
    body: JSON.stringify(claudeFixture()),
  });
  assert.equal(native.status, 200);

  const capture = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ events: [startedEvent()] }),
  });
  assert.equal(capture.status, 502);
  assert.deepEqual(await capture.json(), { error: "UPSTREAM_REJECTED" });

  const task = await fetch(
    `${endpoint}/delivery/v2/tasks/cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({ repositoryKey: "acme/api" }),
    }
  );
  assert.equal(task.status, 409);
  assert.deepEqual(await task.json(), { error: "CONFIG_CONFLICT" });

  assert.equal(upstreamResponses.length, 0);
  for (const response of ignoredResponses)
    assert.equal(response.bodyUsed, true);
});

test("buffers native OTLP as bytes through the server's exact 25 MiB boundary", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-native-limit-")
  );
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [binding()],
  });

  const relay = createManagedRelay({ configPath: path });
  let decodedWhileAccumulating = false;
  relay.prependListener("request", (request) => {
    const setEncoding = request.setEncoding.bind(request);
    request.setEncoding = (...args) => {
      decodedWhileAccumulating = true;
      return setEncoding(...args);
    };
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const headers = { "X-Coredoc-Relay-Binding": "local-binding-one" };
  const nativeLimit = 25 * 1024 * 1024;
  const emptyEnvelope = JSON.stringify({ padding: "" });
  const bodyAtLimit = JSON.stringify({
    padding: "x".repeat(nativeLimit - Buffer.byteLength(emptyEnvelope)),
  });
  assert.equal(Buffer.byteLength(bodyAtLimit), nativeLimit);

  const acceptedByIngress = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers,
    body: bodyAtLimit,
  });
  assert.equal(acceptedByIngress.status, 422);
  assert.equal(
    (await acceptedByIngress.json()).partialSuccess.errorMessage,
    "UNKNOWN_PAYLOAD_SHAPE"
  );

  const overLimit = await fetch(`${endpoint}/v1/logs`, {
    method: "POST",
    headers,
    body: `${bodyAtLimit} `,
  });
  assert.equal(overLimit.status, 413);
  assert.equal(
    (await overLimit.json()).partialSuccess.errorMessage,
    "PAYLOAD_TOO_LARGE"
  );

  const semanticOverLimit = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ padding: "x".repeat(1_000_000) }),
  });
  assert.equal(semanticOverLimit.status, 413);
  assert.equal(decodedWhileAccumulating, false);
});

test("rejects an oversized body without waiting to drain an unfinished request", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-undrained-")
  );
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [binding()],
  });
  const relay = createManagedRelay({ configPath: path });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    let responseStarted = false;
    const client = httpRequest(
      {
        hostname: "127.0.0.1",
        port: relayPort,
        path: "/v1/logs",
        method: "POST",
        headers: {
          "Content-Length": 25 * 1024 * 1024 + 1_024,
          "X-Coredoc-Relay-Binding": "local-binding-one",
        },
      },
      (response) => {
        responseStarted = true;
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", finishReject);
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          client.destroy();
          resolve({
            status: response.statusCode,
            connection: response.headers.connection,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
        });
      }
    );
    const timer = setTimeout(() => {
      finishReject(new Error("relay waited for the oversized body to drain"));
      client.destroy();
    }, 3_000);
    function finishReject(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
    client.on("error", (error) => {
      if (!responseStarted) finishReject(error);
    });
    client.write(Buffer.alloc(25 * 1024 * 1024 + 1, 0x20));
  });

  assert.equal(result.status, 413);
  assert.equal(result.connection, "close");
  assert.deepEqual(result.body, {
    partialSuccess: {
      rejectedLogRecords: 1,
      errorMessage: "PAYLOAD_TOO_LARGE",
    },
  });
});

test("isolates invalid and binding-mismatched events while forwarding valid neighbors", async (t) => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      `${JSON.stringify({
        acceptedEventIds: body.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      })}\n`
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-batch-"));
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [
      binding({
        captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/capture/v1/events`,
      }),
    ],
  });
  const seenAt = "2026-08-17T12:00:00.000Z";
  const relay = createManagedRelay({ configPath: path, now: () => seenAt });
  const relayPort = await listen(relay);
  t.after(() => close(relay));

  const unattributed = startedEvent({
    eventId: "44444444-4444-4444-8444-444444444444",
  });
  delete unattributed.repositoryKey;
  const mismatched = startedEvent({
    eventId: "55555555-5555-4555-8555-555555555555",
    repositoryKey: "another/repository",
  });
  const wrongHost = startedEvent({
    eventId: "77777777-7777-4777-8777-777777777777",
    host: "codex",
  });
  const invalid = startedEvent({
    eventId: "88888888-8888-4888-8888-888888888888",
    prompt: "PRIVATE_PROMPT_SENTINEL",
  });
  const unidentifiedInvalid = startedEvent({
    eventId: "not-a-uuid",
    prompt: "PRIVATE_UNIDENTIFIED_PROMPT",
  });
  const attributed = startedEvent({
    eventId: "66666666-6666-4666-8666-666666666666",
  });
  const isolated = await fetch(
    `http://127.0.0.1:${relayPort}/capture/v1/events`,
    {
      method: "POST",
      headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
      body: JSON.stringify({ events: [invalid, mismatched, wrongHost] }),
    }
  );
  assert.equal(isolated.status, 200);
  assert.deepEqual(await isolated.json(), {
    acceptedEventIds: [],
    duplicateEventIds: [],
    rejected: [
      { eventId: invalid.eventId, code: "INVALID_EVENT" },
      {
        eventId: mismatched.eventId,
        code: "OUT_OF_WORKSPACE_REPOSITORY",
      },
      { eventId: wrongHost.eventId, code: "INVALID_EVENT" },
    ],
  });
  assert.deepEqual(requests, []);
  const isolatedHealth = await (
    await fetch(`http://127.0.0.1:${relayPort}/health`, {
      headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
    })
  ).json();
  assert.deepEqual(isolatedHealth.capture, {
    state: "ready",
    lastSeenAt: seenAt,
    lastForwardedAt: null,
    lastErrorCode: null,
    acceptedSchemaVersions: [1, 2, 3],
  });

  const response = await fetch(
    `http://127.0.0.1:${relayPort}/capture/v1/events`,
    {
      method: "POST",
      headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
      body: JSON.stringify({
        events: [
          unattributed,
          unidentifiedInvalid,
          invalid,
          mismatched,
          wrongHost,
          attributed,
        ],
      }),
    }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    acceptedEventIds: [unattributed.eventId, attributed.eventId],
    duplicateEventIds: [],
    rejected: [
      { eventId: null, code: "INVALID_EVENT" },
      { eventId: invalid.eventId, code: "INVALID_EVENT" },
      {
        eventId: mismatched.eventId,
        code: "OUT_OF_WORKSPACE_REPOSITORY",
      },
      { eventId: wrongHost.eventId, code: "INVALID_EVENT" },
    ],
  });
  assert.deepEqual(requests, [{ events: [unattributed, attributed] }]);
  assert.doesNotMatch(
    JSON.stringify(requests),
    /PRIVATE_(?:PROMPT_SENTINEL|UNIDENTIFIED_PROMPT)/
  );
});

test("validates semantic capture before forwarding and authenticates bounded health", async (t) => {
  const requests = [];
  let upstreamStatus = 200;
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({ url: request.url, headers: request.headers, body });
    if (upstreamStatus !== 200) {
      response.writeHead(upstreamStatus, { "content-type": "text/plain" });
      response.end("PRIVATE_RAW_UPSTREAM_ERROR /Users/private/payload.json\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      `${JSON.stringify({
        acceptedEventIds: body.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      })}\n`
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-capture-")
  );
  const path = join(directory, "relay.json");
  const configured = binding({
    nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/otel/v1/logs`,
    captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/capture/v1/events`,
    cloudAuthorization: "Bearer PRIVATE_CLOUD_TOKEN",
  });
  const unscopedCodex = binding({
    bindingId: BINDING_TWO_ID,
    nonce: "local-binding-two",
    host: "codex",
    workspaceId: "ws-two",
    nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-two/otel/v1/logs`,
    captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-two/capture/v1/events`,
    cloudAuthorization: "Bearer codex-cloud-token",
  });
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [configured, unscopedCodex],
  });

  const relay = createManagedRelay({ configPath: path });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const localHeaders = { "X-Coredoc-Relay-Binding": "local-binding-one" };

  for (const headers of [
    {},
    { "X-Coredoc-Relay-Binding": "foreign-binding" },
  ]) {
    const response = await fetch(`${endpoint}/health`, { headers });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "BINDING_MISMATCH" });
  }

  const event = startedEvent({
    schemaVersion: 3,
    data: {
      ...startedEvent().data,
      stages: [],
      workItems: [
        { provider: "jira", externalId: "10042", externalKey: "CORE-123" },
      ],
    },
  });
  const capture = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers: { ...localHeaders, "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
  });
  assert.equal(capture.status, 200);
  assert.deepEqual(await capture.json(), {
    acceptedEventIds: [event.eventId],
    duplicateEventIds: [],
    rejected: [],
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.authorization, "Bearer PRIVATE_CLOUD_TOKEN");
  assert.equal(requests[0].headers["x-coredoc-relay-binding"], undefined);
  assert.deepEqual(requests[0].body, { events: [event] });

  const invalidEvent = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers: { ...localHeaders, "content-type": "application/json" },
    body: JSON.stringify({
      events: [{ ...event, prompt: "PRIVATE_PROMPT_SENTINEL" }],
    }),
  });
  assert.equal(invalidEvent.status, 200);
  assert.deepEqual(await invalidEvent.json(), {
    acceptedEventIds: [],
    duplicateEventIds: [],
    rejected: [{ eventId: event.eventId, code: "INVALID_EVENT" }],
  });

  const invalidEnvelope = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers: { ...localHeaders, "content-type": "application/json" },
    body: JSON.stringify({ events: [event], extra: true }),
  });
  assert.equal(invalidEnvelope.status, 422);
  assert.deepEqual(await invalidEnvelope.json(), { error: "INVALID_CAPTURE" });
  assert.equal(requests.length, 1);

  const claimedRepository = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": "local-binding-two",
      "X-Coredoc-Relay-Binding-Id": BINDING_TWO_ID,
    },
    body: JSON.stringify({
      events: [
        startedEvent({
          host: "codex",
          repositoryKey: "claimed/repository",
        }),
      ],
    }),
  });
  assert.equal(claimedRepository.status, 200);
  assert.deepEqual(await claimedRepository.json(), {
    acceptedEventIds: [],
    duplicateEventIds: [],
    rejected: [
      {
        eventId: event.eventId,
        code: "OUT_OF_WORKSPACE_REPOSITORY",
      },
    ],
  });
  assert.equal(requests.length, 1);

  const unattributed = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": "local-binding-two",
      "X-Coredoc-Relay-Binding-Id": BINDING_TWO_ID,
    },
    body: JSON.stringify({
      events: [startedEvent({ host: "codex", repositoryKey: undefined })],
    }),
  });
  assert.equal(unattributed.status, 200);
  assert.deepEqual(await unattributed.json(), {
    acceptedEventIds: [],
    duplicateEventIds: [],
    rejected: [{ eventId: event.eventId, code: "OUT_OF_WORKSPACE_REPOSITORY" }],
  });
  assert.equal(requests.length, 1);

  const healthResponse = await fetch(`${endpoint}/health`, {
    headers: localHeaders,
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.schemaVersion, 1);
  assert.equal(health.bindingId, BINDING_ONE_ID);
  assert.equal(health.host, "claude-code");
  assert.equal(health.workspaceId, "ws-one");
  assert.deepEqual(health.capture.acceptedSchemaVersions, [1, 2, 3]);
  assert.equal(health.capture.state, "error");
  assert.equal(health.capture.lastErrorCode, "INVALID_CAPTURE");
  for (const privateValue of [
    "PRIVATE_CLOUD_TOKEN",
    "PRIVATE_PROMPT_SENTINEL",
    "capture/v1/events",
    "X-Coredoc-Relay-Binding",
  ]) {
    assert.doesNotMatch(JSON.stringify(health), new RegExp(privateValue));
  }

  upstreamStatus = 500;
  const rejected = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers: { ...localHeaders, "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
  });
  assert.equal(rejected.status, 502);
  assert.deepEqual(await rejected.json(), { error: "UPSTREAM_REJECTED" });
  const failedHealth = await (
    await fetch(`${endpoint}/health`, { headers: localHeaders })
  ).json();
  assert.equal(failedHealth.capture.lastErrorCode, "UPSTREAM_REJECTED");
  assert.doesNotMatch(
    JSON.stringify(failedHealth),
    /PRIVATE_RAW_UPSTREAM_ERROR|\/Users\/private/
  );

  for (const status of [401, 403]) {
    upstreamStatus = status;
    const authRejected = await fetch(`${endpoint}/capture/v1/events`, {
      method: "POST",
      headers: { ...localHeaders, "content-type": "application/json" },
      body: JSON.stringify({ events: [event] }),
    });
    assert.equal(authRejected.status, 403);
    assert.deepEqual(await authRejected.json(), { error: "AUTH_REJECTED" });
    const authHealth = await (
      await fetch(`${endpoint}/health`, { headers: localHeaders })
    ).json();
    assert.equal(authHealth.capture.lastErrorCode, "AUTH_REJECTED");
    assert.doesNotMatch(
      JSON.stringify(authHealth),
      /PRIVATE_RAW_UPSTREAM_ERROR|\/Users\/private/
    );
  }

  const checked = await checkManagedRelay({
    endpoint,
    bindingNonce: "local-binding-one",
    expectedBinding: configured,
  });
  assert.equal(checked.bindingId, BINDING_ONE_ID);
  const ensured = await ensureManagedRelay({
    endpoint,
    bindingNonce: "local-binding-one",
    expectedBinding: configured,
    attempts: 2,
    wait: async () => {},
  });
  assert.equal(ensured.bindingId, BINDING_ONE_ID);

  await assert.rejects(
    checkManagedRelay({
      endpoint,
      bindingNonce: "local-binding-one",
      expectedBinding: { ...configured, bindingId: BINDING_TWO_ID },
    }),
    (error) => error?.code === "HEALTH_MISMATCH"
  );
  await assert.rejects(
    checkManagedRelay({
      endpoint,
      bindingNonce: "local-binding-one",
      expectedBinding: configured,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            ...health,
            native: {
              ...health.native,
              lastSeenAt: "PRIVATE_RAW_DIAGNOSTIC /Users/private/file",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
    }),
    (error) => error?.code === "HEALTH_MISMATCH"
  );
});

test("authenticates and isolates canonical task/artifact PUTs with a route-specific JSON cap", async (t) => {
  const requests = [];
  let upstreamStatus = 200;
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({ url: request.url, headers: request.headers, body });
    if (upstreamStatus !== 200) {
      response.writeHead(upstreamStatus, {
        "content-type": "application/json",
      });
      response.end(
        '{"code":"ARTIFACT_IDENTITY_CONFLICT","message":"PRIVATE /Users/alice/file.md"}\n'
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url.includes("/tasks/")) {
      response.end(
        `${JSON.stringify({
          id: "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          repositoryKey: "acme/api",
          lifecycle: "active",
          authority: "coredoc",
          externalRefs: [],
        })}\n`
      );
      return;
    }
    response.end(
      `${JSON.stringify({
        status: "accepted",
        artifact: {
          id: "cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          taskId: body.taskId,
          repositoryKey: body.repositoryKey,
          kind: body.kind,
        },
        revision: {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          sha256: createHash("sha256").update(body.markdown).digest("hex"),
          byteCount: Buffer.byteLength(body.markdown),
          checkpoint: body.checkpoint,
          runId: body.runId ?? null,
          createdAt: "2026-08-16T20:00:00.000Z",
        },
      })}\n`
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-managed-relay-artifacts-")
  );
  const configPath = join(directory, "relay.json");
  writeManagedRelayConfig(configPath, {
    schemaVersion: 1,
    bindings: [
      binding({
        cloudAuthorization: "Bearer PRIVATE_CLOUD_TOKEN",
        nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/otel/v1/logs`,
        captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/capture/v1/events`,
      }),
      binding({
        bindingId: BINDING_TWO_ID,
        nonce: "local-binding-two",
        host: "codex",
        workspaceId: "ws-two",
        cloudAuthorization: "Bearer PRIVATE_CODEX_TOKEN",
        nativeForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-two/otel/v1/logs`,
        captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-two/capture/v1/events`,
      }),
    ],
  });
  const relay = createManagedRelay({ configPath });
  const port = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${port}`;
  const headers = {
    "content-type": "application/json",
    "X-Coredoc-Relay-Binding": "local-binding-one",
  };
  const taskId = "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const artifactId = "cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const task = await fetch(`${endpoint}/delivery/v2/tasks/${taskId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ repositoryKey: "acme/api" }),
  });
  assert.equal(task.status, 200);
  assert.equal(
    requests[0].url,
    `/api/v1/workspaces/ws-one/delivery/v2/tasks/${taskId}`
  );
  assert.equal(requests[0].headers.authorization, "Bearer PRIVATE_CLOUD_TOKEN");
  assert.equal(requests[0].headers["x-coredoc-relay-binding"], undefined);
  assert.deepEqual(requests[0].body, { repositoryKey: "acme/api" });

  // JSON escaping exceeds the 1 MiB semantic/OTLP parser cap while the Markdown
  // itself remains within the exact 1 MiB artifact limit.
  const markdown = '"'.repeat(600_000);
  const artifact = await fetch(
    `${endpoint}/delivery/v2/artifacts/${artifactId}/revisions`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        taskId,
        repositoryKey: "acme/api",
        kind: "spec",
        checkpoint: "run-finish",
        markdown,
      }),
    }
  );
  assert.equal(artifact.status, 200);
  assert.equal(
    requests[1].url,
    `/api/v1/workspaces/ws-one/delivery/v2/artifacts/${artifactId}/revisions`
  );
  assert.equal(requests[1].headers.authorization, "Bearer PRIVATE_CLOUD_TOKEN");
  assert.deepEqual(Object.keys(requests[1].body).sort(), [
    "checkpoint",
    "kind",
    "markdown",
    "repositoryKey",
    "taskId",
  ]);

  const before = requests.length;
  for (const [requestHeaders, body] of [
    [
      { "X-Coredoc-Relay-Binding": "local-binding-one" },
      { repositoryKey: "foreign/repository" },
    ],
    [
      {
        "X-Coredoc-Relay-Ingress": "local-binding-two",
        "X-Coredoc-Relay-Binding-Id": BINDING_TWO_ID,
      },
      { repositoryKey: "foreign/repository" },
    ],
  ]) {
    const refused = await fetch(`${endpoint}/delivery/v2/tasks/${taskId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...requestHeaders,
      },
      body: JSON.stringify(body),
    });
    assert.equal(refused.status, 422);
    assert.deepEqual(await refused.json(), { error: "INVALID_DELIVERY" });
  }
  assert.equal(requests.length, before);

  const mismatchedArtifact = await fetch(
    `${endpoint}/delivery/v2/artifacts/${artifactId}/revisions`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        taskId,
        repositoryKey: "foreign/repository",
        kind: "spec",
        checkpoint: "run-finish",
        markdown: "# foreign",
      }),
    }
  );
  assert.equal(mismatchedArtifact.status, 422);
  assert.deepEqual(await mismatchedArtifact.json(), {
    error: "INVALID_DELIVERY",
  });
  assert.equal(requests.length, before);

  const oversizedTask = await fetch(`${endpoint}/delivery/v2/tasks/${taskId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      repositoryKey: "acme/api",
      padding: "x".repeat(1_000_000),
    }),
  });
  assert.equal(oversizedTask.status, 413);
  assert.deepEqual(await oversizedTask.json(), { error: "PAYLOAD_TOO_LARGE" });
  assert.equal(requests.length, before);

  const mixed = await fetch(`${endpoint}/delivery/v2/tasks/${taskId}`, {
    method: "PUT",
    headers: {
      ...headers,
      Authorization: "Bearer HOSTILE_LOCAL_BEARER",
    },
    body: JSON.stringify({ repositoryKey: "acme/api" }),
  });
  assert.equal(mixed.status, 422);
  assert.deepEqual(await mixed.json(), { error: "INVALID_DELIVERY" });
  assert.equal(requests.length, before);

  upstreamStatus = 409;
  const conflicted = await fetch(
    `${endpoint}/delivery/v2/artifacts/${artifactId}/revisions`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        taskId,
        repositoryKey: "acme/api",
        kind: "spec",
        checkpoint: "run-finish",
        markdown: "# v2",
      }),
    }
  );
  assert.equal(conflicted.status, 409);
  assert.deepEqual(await conflicted.json(), { error: "CONFIG_CONFLICT" });
  assert.doesNotMatch(
    JSON.stringify(
      await (await fetch(`${endpoint}/health`, { headers })).json()
    ),
    /PRIVATE|Bearer|Users|file\.md|HOSTILE/
  );

  upstreamStatus = 403;
  const authRejected = await fetch(
    `${endpoint}/delivery/v2/artifacts/${artifactId}/revisions`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        taskId,
        repositoryKey: "acme/api",
        kind: "spec",
        checkpoint: "run-finish",
        markdown: "# retry",
      }),
    }
  );
  assert.equal(authRejected.status, 403);
  assert.deepEqual(await authRejected.json(), { error: "AUTH_REJECTED" });

  upstreamStatus = 200;
  const recovered = await fetch(`${endpoint}/delivery/v2/tasks/${taskId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ repositoryKey: "acme/api" }),
  });
  assert.equal(recovered.status, 200);
  const recoveredHealth = await (
    await fetch(`${endpoint}/health`, { headers })
  ).json();
  assert.equal(recoveredHealth.capture.lastErrorCode, null);
});

test("workspace semantic capture resolves optional repository keys without losing workspace events", async (t) => {
  const calls = [];
  let resolverMode = "resolved";
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ pathname, headers: options.headers, body });
    if (pathname.endsWith("/capture/v1/repositories/resolve")) {
      if (resolverMode === "transport") throw new Error("PRIVATE transport");
      if (resolverMode === "server-error") {
        return new Response("PRIVATE /Users/alice/repository", { status: 503 });
      }
      if (resolverMode === "conflict") {
        return new Response("PRIVATE conflict", { status: 409 });
      }
      if (resolverMode === "unregistered") {
        return Response.json({ status: "unregistered" });
      }
      if (resolverMode === "mismatch") {
        return Response.json({
          status: "resolved",
          repositoryKey: "other/repository",
        });
      }
      if (resolverMode === "malformed") {
        return Response.json({ status: "resolved" });
      }
      return Response.json({
        status: "resolved",
        repositoryKey: body.repositoryKey,
      });
    }
    return Response.json({
      acceptedEventIds: body.events.map(({ eventId }) => eventId),
      duplicateEventIds: [],
      rejected: [],
    });
  };

  const directory = mkdtempSync(join(tmpdir(), "coredoc-workspace-semantic-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const relay = createManagedRelay({
    configPath: path,
    fetchImpl,
    agentHealth: {
      token: "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
      runtimeVersion: "0.11.3",
      runtimeDigest: "a".repeat(64),
      protocolVersion: 1,
      configSchemaVersion: 1,
    },
  });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const headers = {
    "content-type": "application/json",
    "X-Coredoc-Relay-Binding": "local-binding-one",
  };
  const submit = (event) =>
    fetch(`${endpoint}/capture/v1/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [event] }),
    });

  const repositoryless = startedEvent({ repositoryKey: undefined });
  const repositorylessForwarded = { ...repositoryless };
  delete repositorylessForwarded.repositoryKey;
  let response = await submit(repositoryless);
  assert.equal(response.status, 200);
  assert.deepEqual(calls.at(-1).body.events, [repositorylessForwarded]);
  assert.equal(
    calls.filter(({ pathname }) => pathname.endsWith("repositories/resolve"))
      .length,
    0
  );

  resolverMode = "resolved";
  response = await submit(startedEvent());
  assert.equal(response.status, 200);
  assert.equal(calls.at(-1).body.events[0].repositoryKey, "acme/api");

  resolverMode = "unregistered";
  response = await submit(startedEvent());
  assert.equal(response.status, 200);
  assert.equal(Object.hasOwn(calls.at(-1).body.events[0], "repositoryKey"), false);

  for (const degradedMode of ["transport", "server-error"]) {
    resolverMode = degradedMode;
    response = await submit(startedEvent());
    assert.equal(response.status, 200);
    assert.equal(
      Object.hasOwn(calls.at(-1).body.events[0], "repositoryKey"),
      false
    );
    const health = await (
      await fetch(`${endpoint}/health`, {
        headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
      })
    ).json();
    assert.equal(
      health.capture.lastErrorCode,
      "REPOSITORY_ATTRIBUTION_DEGRADED"
    );
    assert.doesNotMatch(
      JSON.stringify(health),
      /PRIVATE|Users|repositories\/resolve/
    );
  }

  const agentHealth = await (
    await fetch(`${endpoint}/health/v2`, {
      headers: {
        "X-Coredoc-Agent-Health":
          "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
      },
    })
  ).json();
  assert.equal(agentHealth.state, "degraded");
  assert.equal(agentHealth.repositoryAttribution, "degraded");
  assert.equal(agentHealth.hostIngress.claudeCode, "ready");
  assert.equal(agentHealth.hostIngress.codex, "unconfigured");
  assert.match(agentHealth.lastSuccessfulDeliveryAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(agentHealth.queueCounts, {
    native: 0,
    semantic: 0,
    artifact: 0,
    agent: 0,
    total: 0,
  });
  assert.equal(
    agentHealth.degradedReasons.includes("REPOSITORY_ATTRIBUTION_DEGRADED"),
    true,
  );
  assert.doesNotMatch(
    JSON.stringify(agentHealth),
    new RegExp(
      `PRIVATE|Users|repositories/resolve|local-binding-one|${BINDING_ONE_ID}`,
    ),
  );

  for (const unavailableMode of ["conflict", "mismatch", "malformed"]) {
    resolverMode = unavailableMode;
    const beforeForwards = calls.filter(({ pathname }) =>
      pathname.endsWith("/capture/v1/events")
    ).length;
    response = await submit(startedEvent());
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "REPOSITORY_UNAVAILABLE",
    });
    assert.equal(
      calls.filter(({ pathname }) => pathname.endsWith("/capture/v1/events"))
        .length,
      beforeForwards
    );
  }
});

test("keeps a queued workspace event across resolver auth failure and delivers it after recovery", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-workspace-resolver-auth-retry-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const event = startedEvent();
  const outboxDirectory = join(
    directory,
    "outbox",
    sha256BindingNonce(configured.bindingId),
  );
  mkdirSync(outboxDirectory, { recursive: true, mode: 0o700 });
  const entryPath = join(outboxDirectory, `${event.eventId}.event.json`);
  writeFileSync(
    entryPath,
    `${JSON.stringify({
      binding: {
        endpoint: "http://127.0.0.1:43181/capture/v1/events",
        workspaceId: configured.workspaceId,
        credentialFingerprint: "a".repeat(64),
      },
      event,
    })}\n`,
    { mode: 0o600 },
  );
  let authorized = false;
  let resolverAttempts = 0;
  let forwarded = 0;
  const relay = createManagedRelay({
    configPath: path,
    outboxFlushIntervalMs: 25,
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      const body = JSON.parse(options.body);
      if (pathname.endsWith("/capture/v1/repositories/resolve")) {
        resolverAttempts += 1;
        if (!authorized) {
          return Response.json({ error: "AUTH_REJECTED" }, { status: 401 });
        }
        return Response.json({
          status: "resolved",
          repositoryKey: body.repositoryKey,
        });
      }
      forwarded += 1;
      return Response.json({
        acceptedEventIds: body.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      });
    },
  });
  const port = await listen(relay);
  t.after(() => close(relay));

  await waitFor(() => resolverAttempts > 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(existsSync(entryPath), true);
  assert.equal(forwarded, 0);
  const failedHealth = await (
    await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
    })
  ).json();
  assert.equal(failedHealth.capture.lastErrorCode, "AUTH_REJECTED");

  authorized = true;
  await waitFor(() => !existsSync(entryPath), 2_000);
  assert.equal(forwarded, 1);
  assert.ok(resolverAttempts >= 2);
});

test("workspace task and artifact delivery require an exact resolved repository", async (t) => {
  const calls = [];
  let resolverMode = "resolved";
  const taskId = "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const artifactId = "cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    const body = JSON.parse(options.body);
    calls.push({ pathname, headers: options.headers, body });
    if (pathname.endsWith("/capture/v1/repositories/resolve")) {
      if (resolverMode === "transport") throw new Error("PRIVATE transport");
      if (resolverMode === "server-error") return new Response("PRIVATE", { status: 503 });
      if (resolverMode === "conflict") return new Response("PRIVATE", { status: 409 });
      if (resolverMode === "unregistered") {
        return Response.json({ status: "unregistered" });
      }
      if (resolverMode === "mismatch") {
        return Response.json({ status: "resolved", repositoryKey: "other/repo" });
      }
      return Response.json({ status: "resolved", repositoryKey: body.repositoryKey });
    }
    if (pathname.includes("/tasks/")) {
      return Response.json({
        id: taskId,
        repositoryKey: body.repositoryKey,
        lifecycle: "active",
        authority: "coredoc",
        externalRefs: [],
      });
    }
    return Response.json({
      status: "accepted",
      artifact: {
        id: artifactId,
        taskId: body.taskId,
        repositoryKey: body.repositoryKey,
        kind: body.kind,
      },
      revision: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        sha256: createHash("sha256").update(body.markdown).digest("hex"),
        byteCount: Buffer.byteLength(body.markdown),
        checkpoint: body.checkpoint,
        runId: body.runId ?? null,
        createdAt: "2026-08-16T20:00:00.000Z",
      },
    });
  };

  const directory = mkdtempSync(join(tmpdir(), "coredoc-workspace-delivery-"));
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [workspaceBinding()],
  });
  const relay = createManagedRelay({ configPath: path, fetchImpl });
  const relayPort = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const headers = {
    "content-type": "application/json",
    "X-Coredoc-Relay-Binding": "local-binding-one",
  };
  const taskBody = { repositoryKey: "acme/api" };
  const artifactBody = {
    taskId,
    repositoryKey: "acme/api",
    kind: "spec",
    checkpoint: "run-finish",
    markdown: "# Accepted specification\n",
  };

  for (const unavailableMode of [
    "unregistered",
    "conflict",
    "mismatch",
    "transport",
    "server-error",
  ]) {
    resolverMode = unavailableMode;
    const beforeDelivery = calls.filter(
      ({ pathname }) => !pathname.endsWith("repositories/resolve")
    ).length;
    const response = await fetch(`${endpoint}/delivery/v2/tasks/${taskId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify(taskBody),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "REPOSITORY_UNAVAILABLE" });
    assert.equal(
      calls.filter(({ pathname }) => !pathname.endsWith("repositories/resolve"))
        .length,
      beforeDelivery
    );
  }

  resolverMode = "unregistered";
  const refusedArtifact = await fetch(
    `${endpoint}/delivery/v2/artifacts/${artifactId}/revisions`,
    { method: "PUT", headers, body: JSON.stringify(artifactBody) }
  );
  assert.equal(refusedArtifact.status, 503);
  assert.deepEqual(await refusedArtifact.json(), {
    error: "REPOSITORY_UNAVAILABLE",
  });

  resolverMode = "resolved";
  const task = await fetch(`${endpoint}/delivery/v2/tasks/${taskId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(taskBody),
  });
  assert.equal(task.status, 200);
  const artifact = await fetch(
    `${endpoint}/delivery/v2/artifacts/${artifactId}/revisions`,
    { method: "PUT", headers, body: JSON.stringify(artifactBody) }
  );
  assert.equal(artifact.status, 200);
  const deliveryCalls = calls.filter(
    ({ pathname }) => !pathname.endsWith("repositories/resolve")
  );
  assert.equal(deliveryCalls.length, 2);
  assert.equal(deliveryCalls[0].headers.Authorization, "Bearer cloud-token-one");
  assert.equal(deliveryCalls[1].headers.Authorization, "Bearer cloud-token-one");
});

test("durably queues only sanitized Claude native OTLP and replays it with rotated config", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-native-outbox-replay-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding({
    cloudAuthorization: "Bearer PRIVATE_NATIVE_CLOUD_TOKEN",
  });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  let attempts = 0;
  const failingRelay = createManagedRelay({
    configPath: path,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("PRIVATE /Users/alice/source.ts");
    },
    nativeOutboxFlushIntervalMs: 60_000,
    nativeOutboxRetryDelayMs: () => 0,
  });
  const failingPort = await listen(failingRelay);
  const poison = claudeFixture();
  poison.resourceLogs[0].resource.attributes.push({
    key: "process.command_line",
    value: { stringValue: "PRIVATE_TOOL --secret /Users/alice/project" },
  });
  poison.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.push({
    key: "tool_input",
    value: { stringValue: "PRIVATE_TOOL_INPUT" },
  });
  const queued = await fetch(`http://127.0.0.1:${failingPort}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer PRIVATE_HOSTILE_LOCAL_TOKEN",
      "X-Coredoc-Relay-Binding": "local-binding-one",
    },
    body: JSON.stringify(poison),
  });
  assert.equal(queued.status, 200);
  assert.deepEqual(await queued.json(), { partialSuccess: {} });
  assert.equal(attempts, 1);

  const records = nativeQueueRecordPaths(directory, configured.bindingId);
  assert.equal(records.length, 1);
  assert.equal(statSync(join(directory, "native-outbox")).mode & 0o777, 0o700);
  assert.equal(
    statSync(join(directory, "native-outbox", configured.bindingId)).mode & 0o777,
    0o700
  );
  assert.equal(statSync(records[0]).mode & 0o777, 0o600);
  const persisted = readFileSync(records[0], "utf8");
  assert.match(persisted, /claude_code\.api_request/);
  for (const secret of [
    "PRIVATE_",
    "/Users/",
    "cloud-token",
    "local-binding-one",
    "Authorization",
  ]) {
    assert.doesNotMatch(persisted, new RegExp(secret));
  }

  const diagnostic = await fetch(
    `http://127.0.0.1:${failingPort}/native-outbox/v1`,
    { headers: { "X-Coredoc-Relay-Binding": "local-binding-one" } }
  );
  assert.equal(diagnostic.status, 200);
  const queuedHealth = await diagnostic.json();
  assert.equal(queuedHealth.schemaVersion, 1);
  assert.equal(queuedHealth.bindingId, configured.bindingId);
  assert.equal(queuedHealth.pendingCount, 1);
  assert.equal(queuedHealth.evictedCount, 0);
  assert.equal(queuedHealth.lastEvictionReason, null);
  assert.doesNotMatch(JSON.stringify(queuedHealth), /PRIVATE|Users|token|path/i);
  const unauthenticatedDiagnostic = await fetch(
    `http://127.0.0.1:${failingPort}/native-outbox/v1`
  );
  assert.equal(unauthenticatedDiagnostic.status, 401);
  assert.deepEqual(await unauthenticatedDiagnostic.json(), {
    error: "BINDING_MISMATCH",
  });
  await close(failingRelay);

  const rotated = {
    ...configured,
    cloudAuthorization: "Bearer replacement-native-cloud-token",
  };
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [rotated] });
  const replayed = [];
  const healthyRelay = createManagedRelay({
    configPath: path,
    fetchImpl: async (url, options) => {
      replayed.push({ url, options, body: JSON.parse(options.body) });
      return new Response("{}", { status: 200 });
    },
    nativeOutboxFlushIntervalMs: 20,
    nativeOutboxRetryDelayMs: () => 0,
  });
  await listen(healthyRelay);
  t.after(() => close(healthyRelay));
  await waitFor(
    () => nativeQueueRecordPaths(directory, configured.bindingId).length === 0
  );
  assert.equal(replayed.length, 1);
  assert.equal(
    replayed[0].options.headers.Authorization,
    "Bearer replacement-native-cloud-token"
  );
  assert.doesNotMatch(JSON.stringify(replayed[0].body), /PRIVATE|Users/);
});

test("graceful close performs one bounded native replay and leaves no retry timer", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-native-outbox-close-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  let available = false;
  let attempts = 0;
  const relay = createManagedRelay({
    configPath: path,
    fetchImpl: async () => {
      attempts += 1;
      if (!available) throw new Error("offline");
      return new Response("{}", { status: 200 });
    },
    nativeOutboxFlushIntervalMs: 60_000,
    nativeOutboxRetryDelayMs: () => 0,
  });
  t.after(() => (relay.listening ? close(relay) : undefined));
  const port = await listen(relay);
  const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
    body: JSON.stringify(claudeFixture()),
  });
  assert.equal(response.status, 200);
  assert.equal(nativeQueueRecordPaths(directory, configured.bindingId).length, 1);
  assert.equal(attempts, 1);

  available = true;
  await close(relay);
  assert.equal(attempts, 2);
  assert.equal(nativeQueueRecordPaths(directory, configured.bindingId).length, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(attempts, 2);
});

test("immediate Codex native failures are admitted durably and remain fail-open", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-native-outbox-codex-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding({
    host: "codex",
    nonce: "workspace-codex-ingress",
  });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const relay = createManagedRelay({
    configPath: path,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    nativeOutboxRetryDelayMs: () => 60_000,
  });
  const port = await listen(relay);
  t.after(() => close(relay));
  const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "X-Coredoc-Relay-Ingress": "workspace-codex-ingress" },
    body: JSON.stringify(CODEX_FIXTURE),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { partialSuccess: {} });
  assert.equal(nativeQueueRecordPaths(directory, configured.bindingId).length, 1);
});

test("repeated native admissions do not reread bodies already indexed in memory", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-native-outbox-index-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const reads = new Map();
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const relay = createManagedRelay({
    configPath: path,
    fetchImpl: async () => {
      throw new Error("offline");
    },
    nativeOutboxFlushIntervalMs: 60_000,
    nativeOutboxRecordId: () => ids.shift(),
    nativeOutboxRetryDelayMs: () => 60_000,
    nativeOutboxReadFileSync: (recordPath, ...args) => {
      if (recordPath.endsWith(".native.json")) {
        reads.set(recordPath, (reads.get(recordPath) ?? 0) + 1);
      }
      return readFileSync(recordPath, ...args);
    },
  });
  const port = await listen(relay);
  t.after(() => close(relay));
  const endpoint = `http://127.0.0.1:${port}/v1/logs`;
  const headers = { "X-Coredoc-Relay-Binding": "local-binding-one" };

  for (let admitted = 1; admitted <= 3; admitted += 1) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(claudeFixture()),
    });
    assert.equal(response.status, 200);
    const records = nativeQueueRecordPaths(directory, configured.bindingId);
    assert.equal(records.length, admitted);
    assert.deepEqual(
      records.map((recordPath) => reads.get(recordPath)),
      Array.from({ length: admitted }, () => 1),
    );
  }
});

test("native outbox startup indexing still rejects unknown on-disk entries", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-native-outbox-unsafe-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const root = join(directory, "native-outbox");
  const bindingDirectory = join(root, configured.bindingId);
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(bindingDirectory, { mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(bindingDirectory, 0o700);
  writeFileSync(join(bindingDirectory, "foreign.txt"), "keep\n", {
    mode: 0o600,
  });

  assert.throws(
    () => createManagedRelay({ configPath: path }),
    (error) => error?.code === "NATIVE_OUTBOX_UNAVAILABLE",
  );
});

test("native outbox enforces deterministic bounds, owner-only modes, age, and retry backoff", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-native-outbox-bounds-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  let clock = Date.parse("2026-08-16T12:00:00.000Z");
  let attempts = 0;
  const retryAttempts = [];
  const ids = [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  ];
  const relay = createManagedRelay({
    configPath: path,
    now: () => new Date(clock).toISOString(),
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("offline");
    },
    nativeOutboxFlushIntervalMs: 20,
    nativeOutboxMaxRecords: 2,
    nativeOutboxMaxBytes: 4 * 1024 * 1024,
    nativeOutboxMaxAgeMs: 1_000,
    nativeOutboxRecordId: () => ids.shift(),
    nativeOutboxRetryDelayMs: (attempt) => {
      retryAttempts.push(attempt);
      return 60_000;
    },
  });
  const port = await listen(relay);
  t.after(() => close(relay));
  for (let index = 0; index < 3; index += 1) {
    clock += 1;
    const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: "POST",
      headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
      body: JSON.stringify(claudeFixture()),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(attempts, 3);
  assert.deepEqual(retryAttempts, [1, 1, 1]);
  const records = nativeQueueRecordPaths(directory, configured.bindingId);
  assert.equal(records.length, 2);
  assert.equal(records.some((record) => record.includes("aaaaaaaa-")), false);
  for (const record of records) assert.equal(statSync(record).mode & 0o777, 0o600);

  const headers = { "X-Coredoc-Relay-Binding": "local-binding-one" };
  let diagnostic = await (
    await fetch(`http://127.0.0.1:${port}/native-outbox/v1`, { headers })
  ).json();
  assert.equal(diagnostic.pendingCount, 2);
  assert.equal(diagnostic.evictedCount, 1);
  assert.equal(diagnostic.lastEvictionReason, "count");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(attempts, 3);

  clock += 2_000;
  await waitFor(
    () => nativeQueueRecordPaths(directory, configured.bindingId).length === 0
  );
  diagnostic = await (
    await fetch(`http://127.0.0.1:${port}/native-outbox/v1`, { headers })
  ).json();
  assert.equal(diagnostic.pendingCount, 0);
  assert.equal(diagnostic.evictedCount, 3);
  assert.equal(diagnostic.lastEvictionReason, "age");
});

test("native outbox rejects only local admissions that cannot fit its byte bound", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-native-outbox-full-"));
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, {
    schemaVersion: 1,
    bindings: [workspaceBinding()],
  });
  let forwarded = 0;
  const relay = createManagedRelay({
    configPath: path,
    fetchImpl: async () => {
      forwarded += 1;
      return new Response("{}", { status: 200 });
    },
    nativeOutboxMaxBytes: 128,
  });
  const port = await listen(relay);
  t.after(() => close(relay));
  const response = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
    method: "POST",
    headers: { "X-Coredoc-Relay-Binding": "local-binding-one" },
    body: JSON.stringify(claudeFixture()),
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    partialSuccess: {
      rejectedLogRecords: 1,
      errorMessage: "NATIVE_OUTBOX_ADMISSION_FAILED",
    },
  });
  assert.equal(forwarded, 0);
});

test("drains pending outbox events to upstream without waiting for a session start", async (t) => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      `${JSON.stringify({
        acceptedEventIds: body.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      })}\n`
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-drain-"));
  const path = join(directory, "relay.json");
  const configured = binding({
    captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/capture/v1/events`,
  });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });

  // A hook-enqueued outbox entry left by a failed forward, exactly as capture-client writes it.
  const event = startedEvent();
  const outboxDirectory = join(directory, "outbox", configured.bindingNonceHash);
  mkdirSync(outboxDirectory, { recursive: true });
  const entryPath = join(outboxDirectory, `${event.eventId}.event.json`);
  writeFileSync(
    entryPath,
    `${JSON.stringify({
      binding: {
        endpoint: "http://127.0.0.1:43181/capture/v1/events",
        workspaceId: "ws-one",
        credentialFingerprint: "a".repeat(64),
      },
      event,
    })}\n`
  );

  const relay = createManagedRelay({ configPath: path });
  await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));

  // The startup drain runs asynchronously after "listening"; poll for the acknowledgement.
  for (let attempt = 0; attempt < 100 && existsSync(entryPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(entryPath), false);
  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0].events.map(({ eventId }) => eventId),
    [event.eventId]
  );
});

test("drains Codex outbox events from the binding-ID-hash directory", async (t) => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      `${JSON.stringify({
        acceptedEventIds: body.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      })}\n`
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-codex-drain-"));
  const path = join(directory, "relay.json");
  const configured = binding({
    host: "codex",
    captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/capture/v1/events`,
  });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });

  const event = startedEvent({ host: "codex" });
  const outboxDirectory = join(
    directory,
    "outbox",
    sha256BindingNonce(configured.bindingId)
  );
  mkdirSync(outboxDirectory, { recursive: true });
  const entryPath = join(outboxDirectory, `${event.eventId}.event.json`);
  writeFileSync(
    entryPath,
    `${JSON.stringify({
      binding: {
        endpoint: "http://127.0.0.1:43181/capture/v1/events",
        workspaceId: "ws-one",
        credentialFingerprint: "a".repeat(64),
      },
      event,
    })}\n`
  );

  const relay = createManagedRelay({
    configPath: path,
    outboxFlushIntervalMs: 25,
  });
  await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));

  for (let attempt = 0; attempt < 25 && existsSync(entryPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(entryPath), false);
  assert.deepEqual(
    requests.flatMap(({ events }) => events.map(({ eventId }) => eventId)),
    [event.eventId]
  );
});

test("drains workspace Claude outbox events from the stable binding-ID-hash directory", async (t) => {
  const requests = [];
  const upstream = createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      `${JSON.stringify({
        acceptedEventIds: body.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      })}\n`
    );
  });
  const upstreamPort = await listen(upstream);
  t.after(() => close(upstream));

  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-claude-workspace-drain-"));
  const path = join(directory, "relay.json");
  const configured = workspaceBinding({
    captureForwardEndpoint: `http://127.0.0.1:${upstreamPort}/api/v1/workspaces/ws-one/capture/v1/events`,
  });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });

  const event = startedEvent({ repositoryKey: undefined });
  const outboxDirectory = join(
    directory,
    "outbox",
    sha256BindingNonce(configured.bindingId)
  );
  mkdirSync(outboxDirectory, { recursive: true });
  const entryPath = join(outboxDirectory, `${event.eventId}.event.json`);
  writeFileSync(
    entryPath,
    `${JSON.stringify({
      binding: {
        endpoint: "http://127.0.0.1:43181/capture/v1/events",
        workspaceId: "ws-one",
        credentialFingerprint: "a".repeat(64),
      },
      event,
    })}\n`
  );

  const relay = createManagedRelay({
    configPath: path,
    outboxFlushIntervalMs: 25,
  });
  await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));

  for (let attempt = 0; attempt < 25 && existsSync(entryPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(entryPath), false);
  assert.deepEqual(
    requests.flatMap(({ events }) => events.map(({ eventId }) => eventId)),
    [event.eventId]
  );
});

test("leaves outbox events untouched when the upstream is unavailable", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-drain-"));
  const path = join(directory, "relay.json");
  const configured = binding({
    captureForwardEndpoint: "http://127.0.0.1:9/api/v1/workspaces/ws-one/capture/v1/events",
  });
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const event = startedEvent();
  const outboxDirectory = join(directory, "outbox", configured.bindingNonceHash);
  mkdirSync(outboxDirectory, { recursive: true });
  const entryPath = join(outboxDirectory, `${event.eventId}.event.json`);
  writeFileSync(
    entryPath,
    `${JSON.stringify({
      binding: {
        endpoint: "http://127.0.0.1:43181/capture/v1/events",
        workspaceId: "ws-one",
        credentialFingerprint: "a".repeat(64),
      },
      event,
    })}\n`
  );

  const relay = createManagedRelay({
    configPath: path,
    fetchImpl: async () => {
      throw new Error("connection refused");
    },
  });
  await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(existsSync(entryPath), true);
});

test("empty-outbox probes stay degraded on auth or invalid upstream responses and heal only on the capture contract", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-heal-"));
  const path = join(directory, "relay.json");
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [binding()] });
  let upstreamMode = "down";
  const relay = createManagedRelay({
    configPath: path,
    outboxFlushIntervalMs: 25,
    fetchImpl: async () => {
      if (upstreamMode === "down") throw new Error("connection refused");
      if (upstreamMode === "auth") {
        return Response.json({ error: "AUTH_REJECTED" }, { status: 401 });
      }
      if (upstreamMode === "invalid-contract") {
        return Response.json({ status: "PRIVATE" }, { status: 200 });
      }
      return Response.json({ status: "ready" });
    },
  });
  const relayPort = await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));
  const endpoint = `http://127.0.0.1:${relayPort}`;
  const headers = {
    "content-type": "application/json",
    "X-Coredoc-Relay-Binding": "local-binding-one",
  };

  // A live forward during an upstream outage latches TRANSPORT_UNAVAILABLE on the binding.
  const failed = await fetch(`${endpoint}/capture/v1/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({ events: [startedEvent()] }),
  });
  assert.equal(failed.status, 502);
  const latched = await (await fetch(`${endpoint}/health`, { headers })).json();
  assert.equal(latched.capture.lastErrorCode, "TRANSPORT_UNAVAILABLE");

  upstreamMode = "auth";
  let authRejected;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    authRejected = await (await fetch(`${endpoint}/health`, { headers })).json();
    if (authRejected.capture.lastErrorCode === "AUTH_REJECTED") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(authRejected.capture.lastErrorCode, "AUTH_REJECTED");
  assert.equal(authRejected.capture.state, "error");

  upstreamMode = "invalid-contract";
  await new Promise((resolve) => setTimeout(resolve, 60));
  const stillDegraded = await (await fetch(`${endpoint}/health`, { headers })).json();
  assert.notEqual(stillDegraded.capture.lastErrorCode, null);

  // Only the exact side-effect-free probe contract proves the authenticated route.
  upstreamMode = "recovered";
  let healed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    healed = await (await fetch(`${endpoint}/health`, { headers })).json();
    if (healed.capture.lastErrorCode === null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(healed.capture.lastErrorCode, null);
  assert.equal(healed.capture.state, "ready");
});

test("heals a stale persisted transport error after a relay restart", async (t) => {
  // The user-visible case: the relay restarts (fresh in-memory state), the outbox is empty,
  // but the binding's capture-health.json still carries the transport error a failed client
  // flush latched — and the capture health reporter reads exactly that file.
  const directory = mkdtempSync(join(tmpdir(), "coredoc-managed-relay-heal-file-"));
  const path = join(directory, "relay.json");
  const configured = binding();
  writeManagedRelayConfig(path, { schemaVersion: 1, bindings: [configured] });
  const outboxDirectory = join(directory, "outbox", configured.bindingNonceHash);
  mkdirSync(outboxDirectory, { recursive: true, mode: 0o700 });
  const healthPath = join(outboxDirectory, "capture-health.json");
  writeFileSync(
    healthPath,
    `${JSON.stringify({
      schemaVersion: 1,
      pendingCount: 3,
      errorCode: "TRANSPORT_UNAVAILABLE",
      updatedAt: "2026-08-19T19:50:18.387Z",
      counters: { overflow: 0, transportFailures: 4, unsupportedSchemaVersions: 0 },
    })}\n`,
    { mode: 0o600 }
  );

  const relay = createManagedRelay({
    configPath: path,
    outboxFlushIntervalMs: 25,
    fetchImpl: async (url, options) => {
      assert.equal(
        new URL(url).pathname,
        "/api/v1/workspaces/ws-one/capture/v1/probe",
      );
      assert.equal(options.body, "{}");
      return Response.json({ status: "ready" });
    },
  });
  await listen(relay);
  t.after(() => (relay.listening ? close(relay) : undefined));

  let persisted;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    persisted = JSON.parse(readFileSync(healthPath, "utf8"));
    if (persisted.errorCode === null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(persisted.errorCode, null);
  assert.equal(persisted.pendingCount, 0);
});
