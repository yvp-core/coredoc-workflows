import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as nodeFileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CaptureAgentSetupError,
  captureAgentSetupPaths,
  createCaptureAgentSetup,
  runCaptureAgentSetupCli,
} from "./capture-agent-setup.mjs";
import { resolveWorkflowRuntime } from "./capture-client.mjs";
import { claimCodexSession } from "./codex-session-claim.mjs";

const POLICY = {
  schemaVersion: 1,
  serverOrigin: "https://coredoc.example.com",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const INSTALLATION_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_BINDING_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_BINDING_ID = "33333333-3333-4333-8333-333333333333";
const INSTALLATION_TOKEN_ID = "44444444-4444-4444-8444-444444444444";
const CLOUD_TOKEN = `cdt_${"a".repeat(64)}`;
const CLAUDE_TOKEN = "c".repeat(48);
const CODEX_TOKEN = "d".repeat(48);

test("setup paths reject relative homes so capture never writes into a repository", () => {
  assert.throws(
    () => captureAgentSetupPaths({ homeDir: "relative-home", env: {} }),
    (error) =>
      error instanceof CaptureAgentSetupError && error.code === "UNSAFE_STATE",
  );
  assert.throws(
    () =>
      captureAgentSetupPaths({
        homeDir: "/tmp/coredoc-home",
        env: { COREDOC_HOME: ".coredoc" },
      }),
    (error) =>
      error instanceof CaptureAgentSetupError && error.code === "UNSAFE_STATE",
  );
  assert.throws(
    () =>
      captureAgentSetupPaths({
        homeDir: "/tmp/coredoc-home",
        env: { CODEX_HOME: ".codex" },
      }),
    (error) =>
      error instanceof CaptureAgentSetupError && error.code === "UNSAFE_STATE",
  );
});

test("setup paths use CODEX_HOME consistently for every Codex user file", () => {
  const configured = captureAgentSetupPaths({
    homeDir: "/tmp/coredoc-home",
    env: { CODEX_HOME: "/tmp/custom-codex-home" },
  });
  assert.equal(configured.codexProfilesHome, "/tmp/custom-codex-home");
  assert.equal(configured.codexBaseConfigPath, "/tmp/custom-codex-home/config.toml");
  assert.equal(configured.codexHooksPath, "/tmp/custom-codex-home/hooks.json");

  const fallback = captureAgentSetupPaths({
    homeDir: "/tmp/coredoc-home",
    env: {},
  });
  assert.equal(fallback.codexProfilesHome, "/tmp/coredoc-home/.codex");
  assert.equal(fallback.codexBaseConfigPath, "/tmp/coredoc-home/.codex/config.toml");
  assert.equal(fallback.codexHooksPath, "/tmp/coredoc-home/.codex/hooks.json");
});

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeLifecycle(events, { pendingCount = 0, health = "ready" } = {}) {
  let installed = false;
  let active = false;
  const lifecyclePurgeProof = {
    schemaVersion: 1,
    stateSha256: "a".repeat(64),
    launchAgentSha256: "b".repeat(64),
  };
  const runtime = {
    version: "1.2.3",
    digest: "f".repeat(64),
    directoryName: `1.2.3-${"f".repeat(64)}`,
  };
  return {
    async setupRuntime() {
      events.push("lifecycle:setup");
      installed = true;
      active = true;
      return {
        schemaVersion: 1,
        status: "ready",
        action: "setup-runtime",
        current: runtime,
        previous: null,
      };
    },
    async startInstalledRuntime() {
      events.push("lifecycle:start-installed");
      if (!installed) {
        throw Object.assign(new Error("not installed"), {
          code: "OWNERSHIP_CONFLICT",
        });
      }
      active = true;
      return {
        schemaVersion: 1,
        status: "ready",
        action: "start-installed-runtime",
        current: runtime,
        previous: null,
      };
    },
    async status() {
      events.push("lifecycle:status");
      return installed
        ? {
            schemaVersion: 1,
            status:
              active && pendingCount === 0 && health === "ready"
                ? "ready"
                : "degraded",
            runtime,
            previousRuntime: null,
            launchAgent: "plugin-v1",
            listener: active ? "occupied" : "free",
            health: active ? health : "unavailable",
            pendingCount,
            queueState: pendingCount === 0 ? "empty" : "pending",
          }
        : {
            schemaVersion: 1,
            status: "not-installed",
            runtime: null,
            previousRuntime: null,
            launchAgent: "absent",
            listener: "free",
            health: "not-installed",
            pendingCount: 0,
            queueState: "empty",
          };
    },
    async upgrade() {
      events.push("lifecycle:upgrade");
      return { status: "ready", current: runtime, previous: runtime };
    },
    async rollback() {
      events.push("lifecycle:rollback");
      return { status: "ready", current: runtime, previous: runtime };
    },
    async disable() {
      events.push("lifecycle:disable");
      active = false;
      return {
        schemaVersion: 1,
        status: "disabled",
        preservedPending: pendingCount,
      };
    },
    async preflightDisable() {
      events.push("lifecycle:preflight-disable");
      if (!installed) {
        throw Object.assign(new Error("not installed"), {
          code: "OWNERSHIP_CONFLICT",
        });
      }
      return { schemaVersion: 1, status: "ready", loaded: active };
    },
    async preflightUninstall({ discardPending, purgeProof }) {
      events.push(`lifecycle:preflight-uninstall:${discardPending}`);
      return {
        schemaVersion: 1,
        status: "ready",
        installed,
        loaded: active,
        pendingCount,
        disposition: discardPending ? "discard" : "preserve",
        purgeProof: discardPending
          ? purgeProof ?? (installed ? lifecyclePurgeProof : null)
          : null,
      };
    },
    async uninstall({ discardPending }) {
      events.push(`lifecycle:uninstall:${discardPending}`);
      installed = false;
      active = false;
      return {
        schemaVersion: 1,
        status: "uninstalled",
        discardedPending: 0,
        preservedPending: 0,
      };
    },
    _setActive(value) {
      active = value;
    },
  };
}

function noDesktopMigration(events, relayConfig = null) {
  return {
    status: relayConfig === null ? "none" : "desktop-v1",
    relayConfig,
    configPath: null,
    async stop() {
      events.push("desktop:stop");
    },
    async restore() {
      events.push("desktop:restore");
    },
    async retire() {
      events.push("desktop:retire");
    },
  };
}

async function harness({
  migrationConfig = null,
  owned = [],
  cloudTokens = [CLOUD_TOKEN],
  observeLoadedRelay = false,
  enrollmentErrors = [],
  revokeInstallationFailures = 0,
  queueSummary = {
    importedPending: 0,
    skippedOtherWorkspacePending: 0,
    skippedUnsupportedPending: 0,
  },
  enrollmentGate = async () => undefined,
  onDesktopStop = async () => undefined,
  onQueuePrepare = async () => undefined,
  lifecyclePendingCount = 0,
  lifecycleHealth = "ready",
  fileSystem = nodeFileSystem,
} = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), "capture-agent-setup-"));
  const events = [];
  const paths = captureAgentSetupPaths({ homeDir, env: {} });
  let activePolicy = POLICY;
  let policyFailure = null;
  let loadedCloudAuthorization = null;
  const lifecycle = fakeLifecycle(events, {
    pendingCount: lifecyclePendingCount,
    health: lifecycleHealth,
  });
  if (observeLoadedRelay) {
    const originalSetup = lifecycle.setupRuntime;
    lifecycle.setupRuntime = async () => {
      const result = await originalSetup();
      const relay = JSON.parse(await readFile(paths.relayConfigPath, "utf8"));
      loadedCloudAuthorization = relay.bindings[0].cloudAuthorization;
      events.push(`lifecycle:loaded:${loadedCloudAuthorization.slice(-1)}`);
      return result;
    };
  }
  let enrollmentCount = 0;
  let installationPresent = false;
  let installationOwnedByPrincipal = true;
  let ownedListFailures = 0;
  let failOwnedListAfterRevoke = false;
  const revoked = [];
  const enrollment = async ({
    installationId,
    mintInstallationToken = true,
    completeEnrollment,
  }) => {
    enrollmentCount += 1;
    events.push(
      mintInstallationToken ? "enrollment:mint" : "enrollment:authorize",
    );
    assert.equal(installationId, INSTALLATION_ID);
    await enrollmentGate();
    const enrollmentError = enrollmentErrors.shift();
    if (enrollmentError) throw enrollmentError;
    if (mintInstallationToken) installationPresent = true;
    const installationToken = {
      id: INSTALLATION_TOKEN_ID,
      name: `capture-agent:${INSTALLATION_ID}`,
      token: cloudTokens[Math.min(enrollmentCount - 1, cloudTokens.length - 1)],
      createdAt: "2026-09-01T10:00:00.000Z",
      expiresAt: null,
    };
    return completeEnrollment({
      installationToken: mintInstallationToken ? installationToken : null,
      async listOwnedTelemetryTokens() {
        events.push("tokens:list-owned");
        if (ownedListFailures > 0) {
          ownedListFailures -= 1;
          throw Object.assign(new Error("injected owned-list failure"), {
            code: "OWNED_LIST_FAILED",
          });
        }
        return [
          ...(installationPresent && installationOwnedByPrincipal
            ? [
                {
                  id: INSTALLATION_TOKEN_ID,
                  name: `capture-agent:${INSTALLATION_ID}`,
                  tokenPrefix: CLOUD_TOKEN.slice(0, 12),
                  createdAt: "2026-09-01T10:00:00.000Z",
                  expiresAt: null,
                  lastUsedAt: null,
                },
              ]
            : []),
          ...owned,
        ];
      },
      async revokeOwnedTelemetryToken(id) {
        events.push("tokens:revoke-owned");
        revoked.push(id);
      },
      async revokeInstallationToken() {
        events.push("tokens:revoke-installation");
        if (revokeInstallationFailures > 0) {
          revokeInstallationFailures -= 1;
          if (failOwnedListAfterRevoke) ownedListFailures += 1;
          throw Object.assign(new Error("injected revoke failure"), {
            code: "INSTALLATION_REVOKE_FAILED",
          });
        }
        installationPresent = false;
      },
    });
  };
  const requests = [];
  let probeResponses = [];
  let abortRequests = false;
  const requestTimeouts = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    events.push("cloud:probe");
    if (init.signal?.aborted) throw init.signal.reason;
    return (
      probeResponses.shift() ??
      (installationPresent
        ? json({ status: "ready" })
        : json({ status: "unauthorized" }, 401))
    );
  };
  const uuids = [INSTALLATION_ID, CLAUDE_BINDING_ID, CODEX_BINDING_ID];
  const tokens = [CLAUDE_TOKEN, CODEX_TOKEN];
  const setup = createCaptureAgentSetup({
    homeDir,
    env: {},
    uid: typeof process.getuid === "function" ? process.getuid() : 501,
    fileSystem,
    loadPolicy: async () => {
      if (policyFailure) throw policyFailure;
      return activePolicy;
    },
    lifecycle,
    enrollment,
    fetchImpl,
    requestTimeoutMs: 43,
    createRequestSignal(timeoutMs) {
      requestTimeouts.push(timeoutMs);
      return abortRequests
        ? AbortSignal.abort(new Error("bounded timeout"))
        : new AbortController().signal;
    },
    prepareDesktopMigration: async () => {
      const migration = noDesktopMigration(events, migrationConfig);
      const stop = migration.stop;
      return {
        ...migration,
        async stop() {
          await stop();
          await onDesktopStop();
        },
      };
    },
    prepareQueueImport: async () => {
      events.push("queues:prepare");
      await onQueuePrepare();
      return {
        summary: queueSummary,
        async apply() {
          events.push("queues:apply");
        },
        async rollback() {
          events.push("queues:rollback");
        },
      };
    },
    randomUUID: () => uuids.shift(),
    randomLocalToken: () => tokens.shift(),
    runCommand: async (executable, args) => {
      events.push(`${executable}:${args.join(":")}`);
      if (executable === "/bin/launchctl" && args[0] === "bootout") {
        lifecycle._setActive(false);
      }
    },
  });
  return {
    homeDir,
    events,
    lifecycle,
    setup,
    requests,
    revoked,
    enrollmentCount: () => enrollmentCount,
    installationPresent: () => installationPresent,
    loadedCloudAuthorization: () => loadedCloudAuthorization,
    setProbeResponses(values) {
      probeResponses = [...values];
    },
    setOwnedListFailures(value) {
      ownedListFailures = value;
    },
    setFailOwnedListAfterRevoke(value) {
      failOwnedListAfterRevoke = value;
    },
    setInstallationOwnedByPrincipal(value) {
      installationOwnedByPrincipal = value;
    },
    setInstallationPresent(value) {
      installationPresent = value;
    },
    setRequestsAborted(value) {
      abortRequests = value;
    },
    requestTimeouts,
    setPolicy(value) {
      activePolicy = value;
      policyFailure = null;
    },
    setPolicyFailure(code) {
      policyFailure = Object.assign(new Error(code), { code });
    },
  };
}

test("setup from a non-repository cwd writes one safe workspace agent and redacted host config", async () => {
  const context = await harness();
  const result = await context.setup.setup();
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.claims, "configured");
  assert.doesNotMatch(JSON.stringify(result), /cdt_|Users|capture-agent|11111111/);

  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  assert.equal((await stat(paths.identityPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.relayConfigPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.codexIngressPath)).mode & 0o777, 0o600);
  const identity = JSON.parse(await readFile(paths.identityPath, "utf8"));
  assert.equal(identity.installationId, INSTALLATION_ID);
  assert.equal(identity.claude.bindingId, CLAUDE_BINDING_ID);
  assert.equal(identity.codex.bindingId, CODEX_BINDING_ID);

  const relay = JSON.parse(await readFile(paths.relayConfigPath, "utf8"));
  assert.equal(relay.bindings.length, 2);
  assert.deepEqual(
    relay.bindings.map(({ host }) => host).sort(),
    ["claude-code", "codex"],
  );
  assert.equal(relay.bindings.every(({ workspaceMode }) => workspaceMode === true), true);
  assert.equal(
    new Set(relay.bindings.map(({ cloudAuthorization }) => cloudAuthorization)).size,
    1,
  );
  assert.equal(relay.bindings[0].cloudAuthorization, `Bearer ${CLOUD_TOKEN}`);
  assert.equal(relay.bindings.some(({ enabled }) => enabled !== undefined), false);
  assert.equal(relay.bindings.some(({ repositoryKey }) => repositoryKey !== undefined), false);

  const claude = JSON.parse(await readFile(paths.claudeSettingsPath, "utf8"));
  assert.equal(
    claude.env.OTEL_EXPORTER_OTLP_HEADERS,
    `X-Coredoc-Relay-Binding=${CLAUDE_TOKEN}`,
  );
  assert.equal(claude.env.COREDOC_CAPTURE_BINDING_ID, CLAUDE_BINDING_ID);
  assert.equal(claude.env.COREDOC_CAPTURE_WORKSPACE_ID, POLICY.workspaceId);
  assert.match(await readFile(paths.codexBaseConfigPath, "utf8"), /\[otel\]/);
  const hooks = await readFile(paths.codexHooksPath, "utf8");
  assert.equal(hooks.includes(paths.runtimeExecutablePath), true);
  assert.equal(hooks.includes(paths.claimProgramPath), true);
  assert.equal(hooks.includes(process.execPath), false);

  assert.deepEqual(
    JSON.parse(await readFile(paths.codexIngressPath, "utf8")),
    { schemaVersion: 1, token: CODEX_TOKEN },
  );
  const runtime = resolveWorkflowRuntime({
    env: {
      COREDOC_HOME: paths.coredocHome,
      CODEX_SESSION_ID: "fresh-workspace-session",
    },
    cwd: context.homeDir,
  });
  assert.equal(runtime.env.COREDOC_CAPTURE_WORKSPACE_MODE, "1");
  assert.equal(runtime.env.COREDOC_CAPTURE_BINDING_ID, CODEX_BINDING_ID);
  assert.equal(runtime.env.COREDOC_CAPTURE_WORKSPACE_ID, POLICY.workspaceId);
  assert.match(
    runtime.env.COREDOC_CAPTURE_HEADERS,
    new RegExp(`X-Coredoc-Relay-Ingress=${CODEX_TOKEN}`),
  );
  const claims = [];
  assert.deepEqual(
    await claimCodexSession({
      input: { session_id: "fresh-workspace-session", cwd: context.homeDir },
      env: { COREDOC_HOME: paths.coredocHome },
      fetchImpl: async (url, init) => {
        claims.push({ url, init });
        return new Response("{}", { status: 200 });
      },
    }),
    { status: "sent" },
  );
  assert.equal(
    claims[0].init.headers["X-Coredoc-Relay-Ingress"],
    CODEX_TOKEN,
  );

  assert.equal(context.requests.length, 1);
  assert.deepEqual(context.requests[0], {
    url: `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/capture/v1/probe`,
    init: {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${CLOUD_TOKEN}`,
        "content-type": "application/json",
      },
      redirect: "error",
      body: "{}",
      signal: context.requests[0].init.signal,
    },
  });
  assert.equal(context.requests[0].init.signal instanceof AbortSignal, true);
  assert.deepEqual(context.requestTimeouts, [43]);
});

test("setup rerun reuses installation and binding IDs so a queued record still resolves", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const identityBefore = await readFile(paths.identityPath, "utf8");
  const relayBefore = JSON.parse(await readFile(paths.relayConfigPath, "utf8"));
  const queued = {
    schemaVersion: 1,
    bindingId: relayBefore.bindings.find(({ host }) => host === "claude-code")
      .bindingId,
    payload: { sanitized: true },
  };
  const queuePath = join(paths.agentRoot, "outbox", "queued.native.json");
  await mkdir(join(paths.agentRoot, "outbox"), { recursive: true, mode: 0o700 });
  await writeFile(queuePath, `${JSON.stringify(queued)}\n`, { mode: 0o600 });

  await context.setup.setup();
  const relayAfter = JSON.parse(await readFile(paths.relayConfigPath, "utf8"));
  const persistedQueue = JSON.parse(await readFile(queuePath, "utf8"));
  assert.equal(await readFile(paths.identityPath, "utf8"), identityBefore);
  assert.deepEqual(
    relayAfter.bindings.map(({ bindingId }) => bindingId),
    relayBefore.bindings.map(({ bindingId }) => bindingId),
  );
  assert.equal(
    relayAfter.bindings.some(
      ({ bindingId }) => bindingId === persistedQueue.bindingId,
    ),
    true,
  );
  assert.equal(context.enrollmentCount(), 1);
});

test("Desktop migration carries fixed-workspace Claude bindings and revokes every matched old credential after health", async () => {
  const otherWorkspace = "99999999-9999-4999-8999-999999999999";
  const legacyClaudeId = "55555555-5555-4555-8555-555555555555";
  const oldOne = `cdt_${"b".repeat(64)}`;
  const oldTwo = `cdt_${"c".repeat(64)}`;
  const migrationConfig = {
    schemaVersion: 1,
    bindings: [
      {
        schemaVersion: 1,
        bindingId: legacyClaudeId,
        bindingNonceHash: "1".repeat(64),
        host: "claude-code",
        workspaceId: POLICY.workspaceId,
        repositoryKey: "owner/repository",
        nativeForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/otel/v1/logs`,
        captureForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/capture/v1/events`,
        cloudAuthorization: `Bearer ${oldOne}`,
      },
      {
        schemaVersion: 1,
        bindingId: "66666666-6666-4666-8666-666666666666",
        bindingNonceHash: "2".repeat(64),
        host: "codex",
        workspaceId: POLICY.workspaceId,
        repositoryKey: "owner/old-codex",
        repositoryScopeKey: `repo-${"2".repeat(24)}`,
        profileName: null,
        nativeForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/otel/v1/logs`,
        captureForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/capture/v1/events`,
        cloudAuthorization: `Bearer ${oldTwo}`,
      },
      {
        schemaVersion: 1,
        bindingId: "77777777-7777-4777-8777-777777777777",
        bindingNonceHash: "3".repeat(64),
        host: "claude-code",
        workspaceId: otherWorkspace,
        repositoryKey: "other/repository",
        nativeForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${otherWorkspace}/otel/v1/logs`,
        captureForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${otherWorkspace}/capture/v1/events`,
        cloudAuthorization: `Bearer cdt_${"d".repeat(64)}`,
      },
    ],
  };
  const oldOneId = "88888888-8888-4888-8888-888888888888";
  const oldTwoId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const context = await harness({
    migrationConfig,
    owned: [
      {
        id: oldOneId,
        name: "otel:legacy-one",
        tokenPrefix: oldOne.slice(0, 12),
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
      },
      {
        id: oldTwoId,
        name: "otel:legacy-two",
        tokenPrefix: oldTwo.slice(0, 12),
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
      },
      {
        id: INSTALLATION_TOKEN_ID,
        name: `capture-agent:${INSTALLATION_ID}`,
        tokenPrefix: CLOUD_TOKEN.slice(0, 12),
        createdAt: "2026-09-01T10:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
      },
    ],
  });

  const result = await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const relay = JSON.parse(await readFile(paths.relayConfigPath, "utf8"));
  assert.equal(relay.bindings.length, 3);
  const carried = relay.bindings.find(({ bindingId }) => bindingId === legacyClaudeId);
  assert.equal(carried.repositoryKey, "owner/repository");
  assert.equal(carried.cloudAuthorization, `Bearer ${CLOUD_TOKEN}`);
  assert.equal(relay.bindings.some(({ host, workspaceMode }) => host === "codex" && !workspaceMode), false);
  assert.equal(relay.bindings.some(({ workspaceId }) => workspaceId === otherWorkspace), false);
  assert.deepEqual(context.revoked.sort(), [oldOneId, oldTwoId].sort());
  assert.equal(
    context.events.indexOf("cloud:probe") <
      context.events.indexOf("tokens:list-owned"),
    true,
  );
  assert.equal(result.cleanup.revokedCount, 2);
  assert.doesNotMatch(JSON.stringify(result), /cdt_|bbbbbbbb|cccccccc/);
  assert.equal(
    context.events.indexOf("desktop:stop") <
      context.events.indexOf("queues:prepare"),
    true,
  );
});

test("fixed-workspace unsupported Desktop queues restore Desktop and block retirement and token cleanup", async () => {
  const oldToken = `cdt_${"b".repeat(64)}`;
  const oldTokenId = "88888888-8888-4888-8888-888888888888";
  const context = await harness({
    migrationConfig: {
      schemaVersion: 1,
      bindings: [
        {
          schemaVersion: 1,
          bindingId: "66666666-6666-4666-8666-666666666666",
          bindingNonceHash: "2".repeat(64),
          host: "codex",
          workspaceId: POLICY.workspaceId,
          repositoryKey: "owner/old-codex",
          repositoryScopeKey: `repo-${"2".repeat(24)}`,
          profileName: null,
          nativeForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/otel/v1/logs`,
          captureForwardEndpoint: `${POLICY.serverOrigin}/api/v1/workspaces/${POLICY.workspaceId}/capture/v1/events`,
          cloudAuthorization: `Bearer ${oldToken}`,
        },
      ],
    },
    owned: [
      {
        id: oldTokenId,
        name: "otel:legacy-codex",
        tokenPrefix: oldToken.slice(0, 12),
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: null,
        lastUsedAt: null,
      },
    ],
    queueSummary: {
      importedPending: 0,
      skippedOtherWorkspacePending: 0,
      skippedUnsupportedPending: 2,
    },
  });

  await assert.rejects(
    context.setup.setup(),
    (error) =>
      error instanceof CaptureAgentSetupError &&
      error.code === "MIGRATION_PENDING_UNSUPPORTED" &&
      error.rollback === "restored",
  );
  assert.equal(
    context.events.indexOf("desktop:stop") <
      context.events.indexOf("queues:prepare"),
    true,
  );
  assert.equal(context.events.includes("desktop:restore"), true);
  assert.equal(context.events.includes("desktop:retire"), false);
  assert.equal(context.events.includes("tokens:list-owned"), false);
  assert.deepEqual(context.revoked, []);
});

test("Desktop is quiesced before queue enumeration so a final append is included", async () => {
  let sourceDirectory;
  let finalQueuePath;
  const context = await harness({
    migrationConfig: {
      schemaVersion: 1,
      bindings: [],
    },
    onDesktopStop: async () => {
      await writeFile(finalQueuePath, "final Desktop queue record", {
        mode: 0o600,
      });
    },
    onQueuePrepare: async () => {
      assert.equal(await readFile(finalQueuePath, "utf8"), "final Desktop queue record");
    },
  });
  sourceDirectory = join(context.homeDir, "desktop-source-queue");
  finalQueuePath = join(sourceDirectory, "final.event.json");
  await mkdir(sourceDirectory, { mode: 0o700 });

  await context.setup.setup();
  assert.equal(
    context.events.indexOf("desktop:stop") <
      context.events.indexOf("queues:prepare"),
    true,
  );
});

test("setup lock spans provisional identity and browser enrollment", async () => {
  let releaseEnrollment;
  let enrollmentStarted;
  const enrollmentStartedPromise = new Promise((resolve) => {
    enrollmentStarted = resolve;
  });
  const enrollmentGatePromise = new Promise((resolve) => {
    releaseEnrollment = resolve;
  });
  const context = await harness({
    enrollmentGate: async () => {
      enrollmentStarted();
      await enrollmentGatePromise;
    },
  });

  const firstSetup = context.setup.setup();
  await enrollmentStartedPromise;
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  assert.equal((await stat(paths.setupLockPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.identityPath)).mode & 0o777, 0o600);
  await assert.rejects(
    context.setup.setup(),
    (error) =>
      error instanceof CaptureAgentSetupError && error.code === "LOCKED",
  );

  releaseEnrollment();
  await firstSetup;
  assert.equal(context.enrollmentCount(), 1);
});

test("authenticated degraded lifecycle health with pending imported queues does not roll back setup", async () => {
  const context = await harness({
    queueSummary: {
      importedPending: 1,
      skippedOtherWorkspacePending: 0,
      skippedUnsupportedPending: 0,
    },
    lifecyclePendingCount: 1,
    lifecycleHealth: "degraded",
  });

  const result = await context.setup.setup();
  assert.equal(result.status, "degraded");
  assert.equal(result.migrationQueues.importedPending, 1);
  assert.equal(context.events.includes("desktop:restore"), false);
  assert.equal(context.events.includes("lifecycle:rollback"), false);
});

test("a temporary existing-token probe failure does not rotate credentials", async () => {
  const context = await harness();
  await context.setup.setup();
  context.setProbeResponses([json({ status: "temporarily-unavailable" }, 503)]);

  await assert.rejects(
    context.setup.setup(),
    (error) =>
      error instanceof CaptureAgentSetupError &&
      error.code === "CLOUD_HEALTH_MISMATCH",
  );
  assert.equal(context.enrollmentCount(), 1);
});

test("same-runtime rollback restores disk before reloading the prior cloud credential", async () => {
  const replacementToken = `cdt_${"e".repeat(64)}`;
  const context = await harness({
    cloudTokens: [CLOUD_TOKEN, replacementToken],
    observeLoadedRelay: true,
  });
  await context.setup.setup();
  assert.equal(context.loadedCloudAuthorization(), `Bearer ${CLOUD_TOKEN}`);

  context.setProbeResponses([
    json({ status: "unauthorized" }, 401),
    json({ status: "temporarily-unavailable" }, 503),
  ]);
  await assert.rejects(
    context.setup.setup(),
    (error) =>
      error instanceof CaptureAgentSetupError &&
      error.code === "CLOUD_HEALTH_MISMATCH" &&
      error.rollback === "restored",
  );

  assert.equal(context.enrollmentCount(), 2);
  assert.equal(context.loadedCloudAuthorization(), `Bearer ${CLOUD_TOKEN}`);
  assert.equal(
    context.events.filter((event) => event === "lifecycle:setup").length,
    3,
  );
});

test("persists a provisional installation identity before enrollment and reuses it after a lost response", async () => {
  const context = await harness({
    enrollmentErrors: [
      Object.assign(new Error("simulated response loss"), {
        code: "INSTALLATION_RESPONSE_INVALID",
      }),
    ],
  });
  await assert.rejects(context.setup.setup());
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const provisional = JSON.parse(await readFile(paths.identityPath, "utf8"));
  assert.equal(provisional.installationId, INSTALLATION_ID);
  assert.equal((await stat(paths.identityPath)).mode & 0o777, 0o600);

  const result = await context.setup.setup();
  assert.equal(result.status, "ready");
  assert.equal(context.enrollmentCount(), 2);
  assert.equal(
    JSON.parse(await readFile(paths.identityPath, "utf8")).installationId,
    INSTALLATION_ID,
  );
});

test("retains provisional identity when rollback cannot confirm remote revoke", async () => {
  const context = await harness({ revokeInstallationFailures: 1 });
  context.setProbeResponses([
    json({ status: "temporarily-unavailable" }, 503),
  ]);
  await assert.rejects(
    context.setup.setup(),
    (error) =>
      error instanceof CaptureAgentSetupError && error.code === "ROLLBACK_FAILED",
  );
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  assert.equal(
    JSON.parse(await readFile(paths.identityPath, "utf8")).installationId,
    INSTALLATION_ID,
  );
  await assert.rejects(readFile(paths.relayConfigPath), { code: "ENOENT" });

  const recovered = await context.setup.setup();
  assert.equal(recovered.status, "ready");
  assert.equal(context.enrollmentCount(), 2);
});

test("status and doctor distinguish bounded cloud auth from temporary transport failure", async () => {
  const context = await harness();
  await context.setup.setup();
  assert.equal((await context.setup.status()).status, "ready");
  assert.equal((await context.setup.doctor()).checks.cloud, "ready");

  context.setProbeResponses([json({ status: "unauthorized" }, 401)]);
  const rejected = await context.setup.doctor();
  assert.equal(rejected.checks.cloud, "auth-rejected");
  assert.equal(context.enrollmentCount(), 1);

  context.setProbeResponses([
    json({ status: "temporarily-unavailable" }, 503),
  ]);
  const unavailable = await context.setup.doctor();
  assert.equal(unavailable.checks.cloud, "unavailable");
  assert.doesNotMatch(JSON.stringify(unavailable), /cdt_|Users|11111111/);
});

test("cloud probes are bounded during setup and doctor", async () => {
  const context = await harness();
  await context.setup.setup();
  context.setRequestsAborted(true);

  const doctor = await context.setup.doctor();
  assert.equal(doctor.checks.cloud, "unavailable");
  assert.deepEqual(context.requestTimeouts, [43, 43]);
});

test("disable removes only host markers, stops the service, and setup re-enables it", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });

  const disabled = await context.setup.disable();
  assert.equal(disabled.status, "disabled");
  assert.equal(context.events.includes("lifecycle:disable"), true);
  assert.equal(JSON.parse(await readFile(paths.claudeSettingsPath, "utf8")).env, undefined);
  assert.doesNotMatch(
    await readFile(paths.codexBaseConfigPath, "utf8"),
    /coredoc capture-agent managed otel/,
  );
  for (const path of [paths.identityPath, paths.relayConfigPath, paths.codexIngressPath]) {
    assert.equal((await stat(path)).isFile(), true);
  }
  assert.equal((await context.setup.status()).status, "disabled");

  const enabled = await context.setup.setup();
  assert.equal(enabled.status, "ready");
  assert.match(
    await readFile(paths.codexBaseConfigPath, "utf8"),
    /coredoc capture-agent managed otel/,
  );
  assert.equal(context.enrollmentCount(), 1);
});

test("disable unregisters a loaded LaunchAgent even while its listener is temporarily down", async () => {
  const context = await harness();
  await context.setup.setup();
  context.lifecycle._setActive(false);

  const disabled = await context.setup.disable();

  assert.equal(disabled.status, "disabled");
  assert.equal(context.events.includes("lifecycle:disable"), true);
  assert.equal((await context.setup.status()).status, "disabled");
});

test("disable never restores host routes when the stopped runtime cannot restart", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  context.lifecycle.disable = async () => {
    context.lifecycle._setActive(false);
    throw Object.assign(new Error("injected supervisor failure"), {
      code: "SUPERVISOR_UNAVAILABLE",
    });
  };
  context.lifecycle.startInstalledRuntime = async () => {
    throw Object.assign(new Error("injected restart failure"), {
      code: "SUPERVISOR_UNAVAILABLE",
    });
  };

  await assert.rejects(context.setup.disable(), { code: "ROLLBACK_FAILED" });

  assert.doesNotMatch(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
  assert.equal((await context.lifecycle.status()).listener, "free");
});

test("a failed repeated disable never starts an installation that was already disabled", async () => {
  const context = await harness();
  await context.setup.setup();
  await context.setup.disable();
  const startsBefore = context.events.filter(
    (event) => event === "lifecycle:start-installed",
  ).length;
  context.lifecycle.disable = async () => {
    context.lifecycle._setActive(false);
    throw Object.assign(new Error("injected post-stop failure"), {
      code: "UNSAFE_STATE",
    });
  };

  await assert.rejects(context.setup.disable(), {
    code: "SUPERVISOR_UNAVAILABLE",
    rollback: "restored",
  });

  assert.equal((await context.lifecycle.status()).listener, "free");
  assert.equal(
    context.events.filter((event) => event === "lifecycle:start-installed")
      .length,
    startsBefore,
  );
});

test("upgrade rechecks local and cloud health without browser enrollment", async () => {
  const context = await harness();
  await context.setup.setup();
  const result = await context.setup.upgrade();
  assert.equal(result.status, "ready");
  assert.equal(result.command, "upgrade");
  assert.equal(context.events.includes("lifecycle:upgrade"), true);
  assert.equal(context.enrollmentCount(), 1);
});

test("upgrade accepts authenticated degraded lifecycle health and reports it honestly", async () => {
  const context = await harness({ lifecycleHealth: "degraded" });
  assert.equal((await context.setup.setup()).status, "degraded");

  const result = await context.setup.upgrade();
  assert.equal(result.status, "degraded");
  assert.equal(result.command, "upgrade");
  assert.equal(context.events.includes("lifecycle:upgrade"), true);
  assert.equal(context.enrollmentCount(), 1);
});

test("default uninstall preserves local identity, credential config, and queues", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const result = await context.setup.uninstall({ purge: false });
  assert.equal(result.status, "uninstalled");
  assert.equal(result.preservedConfig, true);
  assert.equal(context.events.includes("lifecycle:uninstall:false"), true);
  for (const path of [paths.identityPath, paths.relayConfigPath, paths.codexIngressPath]) {
    assert.equal((await stat(path)).isFile(), true);
  }
  assert.doesNotMatch(
    await readFile(paths.codexBaseConfigPath, "utf8"),
    /coredoc capture-agent managed otel/,
  );
  assert.equal(context.enrollmentCount(), 1);
});

test("default uninstall restores the exact stopped runtime before restoring host integration", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  context.lifecycle.uninstall = async () => {
    await context.lifecycle.disable();
    throw Object.assign(new Error("injected cleanup failure"), {
      code: "UNSAFE_STATE",
    });
  };

  await assert.rejects(context.setup.uninstall({ purge: false }), {
    code: "UNSAFE_STATE",
    rollback: "restored",
  });

  assert.equal((await context.lifecycle.status()).listener, "occupied");
  assert.equal(
    context.events.includes("lifecycle:start-installed"),
    true,
  );
  assert.match(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
});

test("default uninstall leaves host integration removed when lifecycle cleanup cannot be proven reversible", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const preflight = context.lifecycle.preflightUninstall;
  let preflightCalls = 0;
  context.lifecycle.preflightUninstall = async (options) => {
    preflightCalls += 1;
    if (preflightCalls > 1) {
      throw Object.assign(new Error("partial lifecycle cleanup"), {
        code: "OWNERSHIP_CONFLICT",
      });
    }
    return preflight(options);
  };
  context.lifecycle.uninstall = async () => {
    context.lifecycle._setActive(false);
    throw Object.assign(new Error("partial lifecycle cleanup"), {
      code: "OWNERSHIP_CONFLICT",
    });
  };

  await assert.rejects(context.setup.uninstall({ purge: false }), {
    code: "UNINSTALL_INCOMPLETE",
  });

  assert.doesNotMatch(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
});

test("status, disable, and default uninstall remain local when the operator policy is unavailable", async () => {
  const disabledContext = await harness();
  await disabledContext.setup.setup();
  const requestCount = disabledContext.requests.length;
  disabledContext.setPolicyFailure("POLICY_UNAVAILABLE");

  assert.equal((await disabledContext.setup.status()).status, "ready");
  const doctor = await disabledContext.setup.doctor();
  assert.equal(doctor.checks.policy, "unavailable");
  assert.equal(doctor.checks.cloud, "unavailable");
  assert.equal(disabledContext.requests.length, requestCount);
  assert.equal((await disabledContext.setup.disable()).status, "disabled");

  const uninstallContext = await harness();
  await uninstallContext.setup.setup();
  uninstallContext.setPolicyFailure("POLICY_UNAVAILABLE");
  assert.equal(
    (await uninstallContext.setup.uninstall({ purge: false })).status,
    "uninstalled",
  );
});

test("network-capable lifecycle commands fail closed on missing policy or policy drift", async () => {
  const context = await harness();
  await context.setup.setup();
  context.setPolicyFailure("POLICY_UNAVAILABLE");

  await assert.rejects(context.setup.upgrade(), { code: "POLICY_UNAVAILABLE" });
  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "POLICY_UNAVAILABLE",
  });

  context.setPolicy({
    ...POLICY,
    workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  await assert.rejects(context.setup.repair(), { code: "POLICY_DRIFT" });
  await assert.rejects(context.setup.upgrade(), { code: "POLICY_DRIFT" });
  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "POLICY_DRIFT",
  });
});

test("purge confirms cloud revoke before deleting exact local credentials", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const result = await context.setup.uninstall({ purge: true });
  assert.equal(result.status, "uninstalled");
  assert.equal(result.preservedConfig, false);
  assert.equal(
    context.events.filter((event) => event === "enrollment:mint").length,
    1,
  );
  assert.equal(
    context.events.filter((event) => event === "enrollment:authorize").length,
    1,
  );
  assert.equal(
    context.events.indexOf("tokens:revoke-installation") <
      context.events.indexOf("lifecycle:uninstall:true"),
    true,
  );
  for (const path of [paths.identityPath, paths.relayConfigPath, paths.codexIngressPath]) {
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  assert.equal(context.enrollmentCount(), 2);
});

test("purge fsyncs host configuration and parents before deleting its receipt", async () => {
  const operations = [];
  const fileSystem = {
    ...nodeFileSystem,
    async open(path, flags, ...rest) {
      const handle = await nodeFileSystem.open(path, flags, ...rest);
      return {
        async sync() {
          operations.push(`sync:${path}`);
          return handle.sync();
        },
        close: () => handle.close(),
      };
    },
    async unlink(path) {
      operations.push(`unlink:${path}`);
      return nodeFileSystem.unlink(path);
    },
  };
  const context = await harness({ fileSystem });
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  operations.length = 0;

  await context.setup.uninstall({ purge: true });

  const markerDelete = operations.indexOf(`unlink:${paths.purgePath}`);
  assert.notEqual(markerDelete, -1);
  for (const parent of new Set([
    join(context.homeDir, ".claude"),
    join(context.homeDir, ".codex"),
  ])) {
    const parentSync = operations.lastIndexOf(`sync:${parent}`);
    assert.notEqual(parentSync, -1);
    assert.equal(parentSync < markerDelete, true);
  }
});

test("purge lifecycle preflight fails before host mutation or cloud authorization", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  context.lifecycle.preflightUninstall = async () => {
    throw Object.assign(new Error("unsafe lifecycle fixture"), {
      code: "UNSAFE_STATE",
    });
  };

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "UNSAFE_STATE",
  });
  assert.equal(context.enrollmentCount(), 1);
  assert.equal(context.events.includes("tokens:revoke-installation"), false);
  assert.match(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
});

test("purge validates local host removal before enrollment or cloud revoke", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  await writeFile(paths.claudeSettingsPath, "{invalid-json\n", { mode: 0o600 });

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "CONFIG_INVALID",
  });
  assert.equal(context.enrollmentCount(), 1);
  assert.equal(context.events.includes("tokens:revoke-installation"), false);
  assert.equal(context.events.includes("lifecycle:uninstall:true"), false);
  for (const path of [
    paths.identityPath,
    paths.relayConfigPath,
    paths.codexIngressPath,
  ]) {
    assert.equal((await stat(path)).isFile(), true);
  }
});

test("confirmed-present revoke failure restores host integration and runtime", async () => {
  const context = await harness({ revokeInstallationFailures: 1 });
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "INSTALLATION_REVOKE_FAILED",
    rollback: "restored",
  });
  for (const path of [paths.identityPath, paths.relayConfigPath, paths.codexIngressPath]) {
    assert.equal((await stat(path)).isFile(), true);
  }
  assert.equal(context.events.includes("lifecycle:uninstall:true"), false);
  assert.equal(context.installationPresent(), true);
  assert.equal((await context.lifecycle.status()).status, "ready");
  assert.match(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
});

test("revoke failure preserves a previously disabled installation", async () => {
  const context = await harness({ revokeInstallationFailures: 1 });
  await context.setup.setup();
  await context.setup.disable();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const startsBefore = context.events.filter(
    (event) => event === "lifecycle:start-installed",
  ).length;

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "INSTALLATION_REVOKE_FAILED",
    rollback: "restored",
  });

  assert.equal((await context.lifecycle.status()).listener, "free");
  assert.equal(
    context.events.filter((event) => event === "lifecycle:start-installed")
      .length,
    startsBefore,
  );
  assert.doesNotMatch(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
});

test("an OAuth principal that cannot list a still-valid installation token cannot purge it", async () => {
  const context = await harness();
  await context.setup.setup();
  context.setInstallationOwnedByPrincipal(false);

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "INSTALLATION_REVOKE_UNCONFIRMED",
  });

  assert.equal(context.installationPresent(), true);
  assert.equal((await context.lifecycle.status()).listener, "free");
  assert.equal(
    context.events.includes("tokens:revoke-installation"),
    false,
  );
});

test("HTTP 403 never proves an unlisted retained installation token was revoked", async () => {
  const context = await harness();
  await context.setup.setup();
  context.setInstallationOwnedByPrincipal(false);
  context.setProbeResponses([json({ status: "forbidden" }, 403)]);

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "INSTALLATION_REVOKE_UNCONFIRMED",
  });
  assert.equal(context.installationPresent(), true);
});

test("a transport failure while probing an unlisted token stays disabled and unconfirmed", async () => {
  const context = await harness();
  await context.setup.setup();
  context.setInstallationOwnedByPrincipal(false);
  context.setRequestsAborted(true);
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });

  await assert.rejects(
    context.setup.uninstall({ purge: true }),
    (error) =>
      error.code === "INSTALLATION_REVOKE_UNCONFIRMED" &&
      error.rollback === undefined,
  );

  assert.equal((await context.lifecycle.status()).listener, "free");
  assert.doesNotMatch(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
});

test("HTTP 401 for a stale local bearer cannot prove an unlisted installation token is absent", async () => {
  const context = await harness();
  await context.setup.setup();
  context.setInstallationOwnedByPrincipal(false);
  context.setInstallationPresent(false);

  await assert.rejects(
    context.setup.uninstall({ purge: true }),
    (error) =>
      error.code === "INSTALLATION_REVOKE_UNCONFIRMED" &&
      error.rollback === undefined,
  );

  assert.equal(
    context.events.includes("tokens:revoke-installation"),
    false,
  );
});

test("ambiguous revoke keeps local recovery state disabled without a false rollback", async () => {
  const context = await harness({ revokeInstallationFailures: 1 });
  await context.setup.setup();
  context.setFailOwnedListAfterRevoke(true);
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });

  await assert.rejects(
    context.setup.uninstall({ purge: true }),
    (error) =>
      error.code === "INSTALLATION_REVOKE_UNCONFIRMED" &&
      error.rollback === undefined,
  );
  for (const path of [
    paths.identityPath,
    paths.relayConfigPath,
    paths.codexIngressPath,
  ]) {
    assert.equal((await stat(path)).isFile(), true);
  }
  assert.equal((await context.lifecycle.status()).listener, "free");
  assert.doesNotMatch(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
});

test("post-revoke local failure stays disabled and an absent-token retry completes purge", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const uninstall = context.lifecycle.uninstall;
  context.lifecycle.uninstall = async ({ discardPending }) => {
    context.events.push(`lifecycle:uninstall:${discardPending}`);
    throw Object.assign(new Error("injected local cleanup failure"), {
      code: "UNSAFE_STATE",
    });
  };

  await assert.rejects(
    context.setup.uninstall({ purge: true }),
    (error) => error.code === "PURGE_INCOMPLETE" && error.rollback === undefined,
  );
  assert.equal(context.installationPresent(), false);
  assert.equal((await context.lifecycle.status()).listener, "free");
  assert.doesNotMatch(
    await readFile(paths.claudeSettingsPath, "utf8"),
    /OTEL_EXPORTER_OTLP_ENDPOINT/,
  );
  for (const path of [
    paths.identityPath,
    paths.relayConfigPath,
    paths.codexIngressPath,
  ]) {
    assert.equal((await stat(path)).isFile(), true);
  }
  const marker = await readFile(paths.purgePath, "utf8");
  assert.equal((await stat(paths.purgePath)).mode & 0o777, 0o600);
  assert.doesNotMatch(marker, /cdt_|Bearer|health_token_|c{32}|d{32}/);
  assert.equal((await context.setup.status()).purge, "pending");
  const enrollmentBeforeRetry = context.enrollmentCount();
  await assert.rejects(context.setup.setup(), { code: "PURGE_INCOMPLETE" });
  await assert.rejects(context.setup.upgrade(), { code: "PURGE_INCOMPLETE" });
  await unlink(paths.relayConfigPath);
  await unlink(paths.codexIngressPath);

  context.lifecycle.uninstall = uninstall;
  const retry = await context.setup.uninstall({ purge: true });
  assert.equal(retry.status, "uninstalled");
  assert.equal(context.enrollmentCount(), enrollmentBeforeRetry);
  assert.equal(
    context.events.filter((event) => event === "tokens:revoke-installation")
      .length,
    1,
  );
  for (const path of [
    paths.identityPath,
    paths.relayConfigPath,
    paths.codexIngressPath,
  ]) {
    await assert.rejects(readFile(path), { code: "ENOENT" });
  }
  await assert.rejects(readFile(paths.purgePath), { code: "ENOENT" });
});

test("purge retry validates every surviving credential before lifecycle deletion", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const uninstall = context.lifecycle.uninstall;
  context.lifecycle.uninstall = async () => {
    throw Object.assign(new Error("injected local cleanup failure"), {
      code: "UNSAFE_STATE",
    });
  };
  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "PURGE_INCOMPLETE",
  });
  context.lifecycle.uninstall = uninstall;
  const identity = JSON.parse(await readFile(paths.identityPath, "utf8"));
  await writeFile(paths.identityPath, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o600,
  });
  const lifecycleDeletesBefore = context.events.filter(
    (event) => event === "lifecycle:uninstall:true",
  ).length;

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "PURGE_INCOMPLETE",
  });

  assert.equal((await stat(paths.relayConfigPath)).isFile(), true);
  assert.equal((await stat(paths.codexIngressPath)).isFile(), true);
  assert.equal((await stat(paths.purgePath)).isFile(), true);
  assert.equal(
    context.events.filter((event) => event === "lifecycle:uninstall:true")
      .length,
    lifecycleDeletesBefore,
  );
});

test("purge cannot complete when managed host state reappears during authorization", async () => {
  let context;
  context = await harness({
    enrollmentGate: async () => {
      if (!context || context.enrollmentCount() < 2) return;
      const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
      await writeFile(
        paths.claudeSettingsPath,
        `${JSON.stringify({
          env: {
            COREDOC_CAPTURE_AGENT_MANAGED:
              "coredoc-workflows/v1:env-absent",
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:43181",
          },
        })}\n`,
        { mode: 0o600 },
      );
    },
  });
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "PURGE_INCOMPLETE",
  });

  assert.equal((await stat(paths.identityPath)).isFile(), true);
  assert.equal((await stat(paths.relayConfigPath)).isFile(), true);
  assert.equal((await stat(paths.purgePath)).isFile(), true);
  assert.equal((await context.lifecycle.status()).listener, "free");
});

test("disable remains available when an optional Codex hook file is malformed", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  await writeFile(paths.codexHooksPath, "{invalid-json\n", { mode: 0o600 });

  const result = await context.setup.disable();

  assert.equal(result.status, "disabled");
  assert.equal(result.claims, "degraded");
  assert.equal((await context.lifecycle.status()).listener, "free");
});

test("purge fails before authorization when the managed hook cannot be removed safely", async () => {
  const context = await harness();
  await context.setup.setup();
  const paths = captureAgentSetupPaths({ homeDir: context.homeDir, env: {} });
  const enrollmentBefore = context.enrollmentCount();
  await writeFile(paths.codexHooksPath, "{invalid-json\n", { mode: 0o600 });

  await assert.rejects(context.setup.uninstall({ purge: true }), {
    code: "CONFIG_INVALID",
  });

  assert.equal(context.enrollmentCount(), enrollmentBefore);
  assert.equal((await context.lifecycle.status()).listener, "occupied");
});

test("setup CLI emits bounded actionable error codes without messages or secrets", async () => {
  for (const fixture of [
    { code: "DISCOVERY_FAILED", command: "setup" },
    { code: "OAUTH_TIMEOUT", command: "setup" },
    { code: "CONFIG_CONFLICT", command: "setup" },
    { code: "CLOUD_AUTH_REJECTED", command: "upgrade" },
    { code: "INSTALLATION_REVOKE_UNCONFIRMED", command: "uninstall" },
    { code: "PURGE_INCOMPLETE", command: "uninstall" },
    { code: "UNINSTALL_INCOMPLETE", command: "uninstall" },
    { code: "ROLLBACK_FAILED", command: "setup", rollback: "failed" },
  ]) {
    let stdout = "";
    let stderr = "";
    const failure = Object.assign(
      new Error(`PRIVATE ${CLOUD_TOKEN} /Users/private`),
      {
        code: fixture.code,
        ...(fixture.rollback ? { rollback: fixture.rollback } : {}),
      },
    );
    const active = {
      async [fixture.command]() {
        throw failure;
      },
    };
    const exitCode = await runCaptureAgentSetupCli({
      args: [fixture.command],
      setup: active,
      write: (value) => {
        stdout += value;
      },
      writeError: (value) => {
        stderr += value;
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(stdout, "");
    assert.deepEqual(JSON.parse(stderr), {
      schemaVersion: 1,
      status: "failed",
      code: fixture.code,
      ...(fixture.rollback ? { rollback: fixture.rollback } : {}),
    });
    assert.doesNotMatch(stderr, /PRIVATE|cdt_|Users/);
  }
});
