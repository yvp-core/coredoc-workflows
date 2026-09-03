import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { createCaptureRecorder } from "../runtime/capture/index.mjs";
import {
  createConfiguredCaptureRecorder,
  deliverCaptureEvent,
  preflightCaptureSchemaVersion,
  resolveWorkflowRuntime,
  selectManagedCaptureBinding,
  workflowSessionId,
} from "./capture-client.mjs";
import {
  sha256BindingNonce,
  writeManagedRelayConfig,
} from "./managed-otel-relay.mjs";
import {
  resolveRepositoryIdentity,
  resolveRepositoryRoot,
  resolveRepositoryScopeKey,
} from "./project-key.mjs";

const ENV = {
  COREDOC_CAPTURE_ENDPOINT:
    "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events",
  COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
  COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/capture-client-test",
  COREDOC_WORKFLOWS_REPO_KEY: "coredoc/coredoc-parser",
};
const MANAGED_ENV = {
  ...ENV,
  COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture/v1/events",
  COREDOC_CAPTURE_HEADERS:
    "X-Coredoc-Relay-Binding=local_binding_abcdefghijklmnopqrstuvwxyz012345",
  COREDOC_CAPTURE_WORKSPACE_ID: "ws-1",
};

const CODEX_SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CODEX_BINDING_NONCE =
  "local_binding_codex_abcdefghijklmnopqrstuvwxyz012345";

function gitInit(dir) {
  execFileSync("git", ["init", "-q"], {
    cwd: dir,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return dir;
}

function workspaceBinding({
  bindingId = "22222222-2222-4222-8222-222222222222",
  host = "codex",
  enabled,
} = {}) {
  // The relay schema persists workspaceMode, not enabled. `enabled: false` is
  // used only to exercise the selector's tolerance for stale/injected values.
  return {
    schemaVersion: 1,
    bindingId,
    bindingNonceHash: sha256BindingNonce(CODEX_BINDING_NONCE),
    host,
    ...(enabled === undefined ? {} : { enabled }),
    workspaceMode: true,
    workspaceId: "ws-1",
    nativeForwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/ws-1/otel/v1/logs",
    captureForwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events",
    cloudAuthorization: "Bearer must-not-escape",
  };
}

function writeCodexIngress({ codexHome, stateHome }) {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    codexManagedConfig(CODEX_BINDING_NONCE),
    "utf8",
  );
  mkdirSync(join(stateHome, "capture-agent", "capture-relay"), {
    recursive: true,
  });
  writeFileSync(
    join(stateHome, "capture-agent", "capture-relay", "codex-ingress.json"),
    `${JSON.stringify({ schemaVersion: 1, token: CODEX_BINDING_NONCE })}\n`,
    { mode: 0o600 },
  );
}

function codexManagedConfig(bindingNonce) {
  return [
    "# >>> coredoc managed otel v1 eof-newline=1",
    "[otel]",
    "log_user_prompt = false",
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:43181/v1/logs", protocol = "json", headers = { "X-Coredoc-Relay-Ingress" = "' +
      bindingNonce +
      '" } } }',
    "# <<< coredoc managed otel v1",
    "",
  ].join("\n");
}

function writeCodexRelayFixture({
  codexHome,
  stateHome,
  bindingNonce = CODEX_BINDING_NONCE,
  configName = "config.toml",
  cwd = process.cwd(),
}) {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, configName),
    codexManagedConfig(bindingNonce),
    "utf8",
  );
  mkdirSync(join(stateHome, "capture-agent", "capture-relay"), { recursive: true });
  writeFileSync(
    join(stateHome, "capture-agent", "capture-relay", "codex-ingress.json"),
    `${JSON.stringify({ schemaVersion: 1, token: bindingNonce })}\n`,
    { mode: 0o600 },
  );
  writeManagedRelayConfig(
    join(stateHome, "capture-agent", "capture-relay", "relay.json"),
    {
      schemaVersion: 1,
      bindings: [
        {
          schemaVersion: 1,
          bindingId: "22222222-2222-4222-8222-222222222222",
          bindingNonceHash: sha256BindingNonce(bindingNonce),
          host: "codex",
          workspaceId: "ws-1",
          repositoryKey: "coredoc/coredoc-parser",
          repositoryScopeKey: resolveRepositoryScopeKey(cwd),
          profileName: null,
          nativeForwardEndpoint:
            "https://capture.invalid/api/v1/workspaces/ws-1/otel/v1/logs",
          captureForwardEndpoint:
            "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events",
          cloudAuthorization: "Bearer test-token",
        },
      ],
    },
  );
}

test("uses Codex's stable session identity when the workflow hook variable is absent", () => {
  assert.equal(
    workflowSessionId({ CODEX_SESSION_ID, CODEX_THREAD_ID: CODEX_SESSION_ID }),
    CODEX_SESSION_ID,
  );
  assert.equal(
    workflowSessionId({
      COREDOC_WORKFLOWS_SESSION_ID: "explicit-session",
      CODEX_SESSION_ID,
    }),
    "explicit-session",
  );
  assert.equal(
    workflowSessionId({ CODEX_THREAD_ID: CODEX_SESSION_ID }),
    CODEX_SESSION_ID,
  );
});

test("does not reinterpret an explicitly attributed host as native Codex", () => {
  const runtime = resolveWorkflowRuntime({
    env: {
      COREDOC_WORKFLOWS_SESSION_ID: "explicit-session",
      CODEX_SESSION_ID,
      CODEX_HOME: "relative-path-must-not-be-read",
    },
  });

  assert.equal(runtime.sessionId, "explicit-session");
  assert.equal(runtime.env.COREDOC_CAPTURE_ENDPOINT, undefined);
});

test("recovers semantic capture from the exact managed Codex relay binding", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-codex-runtime-"));
  const codexHome = join(root, "codex");
  const stateHome = join(root, "state");
  const desktopRelayRoot = join(stateHome, "capture-relay");
  const desktopIngress = '{"desktop":"must-not-be-read"}\n';
  const desktopConfig = '{"desktop":"must-not-be-read"}\n';
  mkdirSync(desktopRelayRoot, { recursive: true });
  writeFileSync(join(desktopRelayRoot, "codex-ingress.json"), desktopIngress, {
    mode: 0o600,
  });
  writeFileSync(join(desktopRelayRoot, "relay.json"), desktopConfig, {
    mode: 0o600,
  });
  writeCodexRelayFixture({ codexHome, stateHome });

  const runtime = resolveWorkflowRuntime({
    env: {
      CODEX_HOME: codexHome,
      CODEX_SESSION_ID,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    cwd: process.cwd(),
  });

  assert.equal(runtime.sessionId, CODEX_SESSION_ID);
  assert.equal(runtime.env.COREDOC_WORKFLOWS_SESSION_ID, CODEX_SESSION_ID);
  assert.equal(
    runtime.env.COREDOC_CAPTURE_ENDPOINT,
    "http://127.0.0.1:43181/capture/v1/events",
  );
  assert.equal(runtime.env.COREDOC_CAPTURE_HOST, "codex");
  assert.equal(runtime.env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-1");
  assert.equal(
    runtime.env.COREDOC_CAPTURE_HEADERS,
    `X-Coredoc-Relay-Ingress=${CODEX_BINDING_NONCE},X-Coredoc-Relay-Binding-Id=22222222-2222-4222-8222-222222222222`,
  );
  assert.equal(
    runtime.env.COREDOC_WORKFLOWS_REPO_KEY,
    "coredoc/coredoc-parser",
  );
  assert.equal(
    readFileSync(join(desktopRelayRoot, "codex-ingress.json"), "utf8"),
    desktopIngress,
  );
  assert.equal(
    readFileSync(join(desktopRelayRoot, "relay.json"), "utf8"),
    desktopConfig,
  );
});

test("does not trust unmanaged Codex OTLP settings for semantic capture", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-codex-unmanaged-"));
  const codexHome = join(root, "codex");
  const stateHome = join(root, "state");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    join(codexHome, "config.toml"),
    '[otel]\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:43181/v1/logs" } }\n',
    "utf8",
  );

  const runtime = resolveWorkflowRuntime({
    env: {
      CODEX_HOME: codexHome,
      CODEX_SESSION_ID,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
  });

  assert.equal(runtime.sessionId, CODEX_SESSION_ID);
  assert.equal(runtime.env.COREDOC_CAPTURE_ENDPOINT, undefined);
  assert.equal(runtime.env.COREDOC_CAPTURE_HEADERS, undefined);
});

test("ignores profile files and routes only from the machine-local repository map", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-codex-ambiguous-"));
  const codexHome = join(root, "codex");
  const stateHome = join(root, "state");
  writeCodexRelayFixture({ codexHome, stateHome });
  writeFileSync(
    join(codexHome, "pilot.config.toml"),
    codexManagedConfig(
      "local_binding_other_abcdefghijklmnopqrstuvwxyz012345",
    ),
    "utf8",
  );

  const runtime = resolveWorkflowRuntime({
    cwd: process.cwd(),
    env: {
      CODEX_HOME: codexHome,
      CODEX_SESSION_ID,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
  });
  assert.equal(runtime.env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-1");
});

test("routes managed Codex workflow capture by cwd across two repository bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-codex-multi-repo-"));
  const codexHome = join(root, "codex");
  const stateHome = join(root, "state");
  const repoOne = join(root, "repo-one");
  const repoTwo = join(root, "repo-two");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(repoOne, { recursive: true });
  mkdirSync(repoTwo, { recursive: true });
  gitInit(repoOne);
  gitInit(repoTwo);
  writeFileSync(
    join(codexHome, "config.toml"),
    codexManagedConfig(CODEX_BINDING_NONCE),
    "utf8",
  );
  mkdirSync(join(stateHome, "capture-agent", "capture-relay"), {
    recursive: true,
  });
  writeFileSync(
    join(stateHome, "capture-agent", "capture-relay", "codex-ingress.json"),
    `${JSON.stringify({ schemaVersion: 1, token: CODEX_BINDING_NONCE })}\n`,
    { mode: 0o600 },
  );
  writeManagedRelayConfig(
    join(stateHome, "capture-agent", "capture-relay", "relay.json"),
    {
      schemaVersion: 1,
      bindings: [
        {
          schemaVersion: 1,
          bindingId: "22222222-2222-4222-8222-222222222222",
          bindingNonceHash: sha256BindingNonce(CODEX_BINDING_NONCE),
          host: "codex",
          workspaceId: "ws-1",
          repositoryKey: "acme/repo-one",
          repositoryScopeKey: resolveRepositoryScopeKey(repoOne),
          profileName: null,
          nativeForwardEndpoint:
            "https://capture.invalid/api/v1/workspaces/ws-1/otel/v1/logs",
          captureForwardEndpoint:
            "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events",
          cloudAuthorization: "Bearer test-token-one",
        },
        {
          schemaVersion: 1,
          bindingId: "33333333-3333-4333-8333-333333333333",
          bindingNonceHash: sha256BindingNonce(CODEX_BINDING_NONCE),
          host: "codex",
          workspaceId: "ws-2",
          repositoryKey: "acme/repo-two",
          repositoryScopeKey: resolveRepositoryScopeKey(repoTwo),
          profileName: "pilot",
          nativeForwardEndpoint:
            "https://capture.invalid/api/v1/workspaces/ws-2/otel/v1/logs",
          captureForwardEndpoint:
            "https://capture.invalid/api/v1/workspaces/ws-2/capture/v1/events",
          cloudAuthorization: "Bearer test-token-two",
        },
      ],
    },
  );

  const first = resolveWorkflowRuntime({
    cwd: repoOne,
    env: {
      CODEX_HOME: codexHome,
      CODEX_SESSION_ID,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
      COREDOC_CAPTURE_WORKSPACE_MODE: "1",
      COREDOC_CAPTURE_REPOSITORY_STATE: "none",
    },
  });
  const second = resolveWorkflowRuntime({
    cwd: repoTwo,
    env: { CODEX_HOME: codexHome, CODEX_SESSION_ID, COREDOC_WORKFLOWS_STATE_HOME: stateHome },
  });

  assert.equal(first.env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-1");
  assert.equal(first.env.COREDOC_WORKFLOWS_REPO_KEY, "acme/repo-one");
  assert.equal(first.env.COREDOC_CAPTURE_WORKSPACE_MODE, undefined);
  assert.equal(first.env.COREDOC_CAPTURE_REPOSITORY_STATE, undefined);
  assert.equal(second.env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-2");
  assert.equal(second.env.COREDOC_WORKFLOWS_REPO_KEY, "acme/repo-two");
  assert.equal(
    first.env.COREDOC_CAPTURE_HEADERS,
    `X-Coredoc-Relay-Ingress=${CODEX_BINDING_NONCE},X-Coredoc-Relay-Binding-Id=22222222-2222-4222-8222-222222222222`,
  );
  assert.equal(
    second.env.COREDOC_CAPTURE_HEADERS,
    `X-Coredoc-Relay-Ingress=${CODEX_BINDING_NONCE},X-Coredoc-Relay-Binding-Id=33333333-3333-4333-8333-333333333333`,
  );
});

test("selects exactly one persisted workspace binding and tolerates a stale disabled candidate", () => {
  const selected = selectManagedCaptureBinding({
    bindings: [
      workspaceBinding({
        bindingId: "11111111-1111-4111-8111-111111111111",
        enabled: false,
      }),
      workspaceBinding(),
      workspaceBinding({
        bindingId: "33333333-3333-4333-8333-333333333333",
        host: "claude-code",
      }),
    ],
    host: "codex",
    bindingNonceHash: sha256BindingNonce(CODEX_BINDING_NONCE),
    repositoryIdentity: null,
  });

  assert.equal(selected.mode, "workspace");
  assert.equal(
    selected.binding.bindingId,
    "22222222-2222-4222-8222-222222222222",
  );
});

test("workspace binding resolution fails closed on ambiguity or no binding", () => {
  const options = {
    host: "codex",
    bindingNonceHash: sha256BindingNonce(CODEX_BINDING_NONCE),
    repositoryIdentity: null,
  };

  for (const bindings of [
    [],
    [
      workspaceBinding(),
      workspaceBinding({
        bindingId: "33333333-3333-4333-8333-333333333333",
      }),
    ],
  ]) {
    assert.throws(
      () => selectManagedCaptureBinding({ ...options, bindings }),
      (error) => {
        assert.equal(error.message, "managed Codex relay binding is unavailable");
        assert.doesNotMatch(error.message, /must-not-escape|capture-client-workspace/);
        return true;
      },
    );
  }

  assert.throws(
    () =>
      selectManagedCaptureBinding({
        bindings: [
          {
            ...workspaceBinding(),
            workspaceMode: false,
            repositoryScopeKey: "repo-111111111111111111111111",
          },
        ],
        host: options.host,
        bindingNonceHash: options.bindingNonceHash,
      }),
    /managed Codex relay binding is unavailable/,
  );
});

test("legacy repository binding remains selected by repository scope", () => {
  const repo = gitInit(mkdtempSync(join(tmpdir(), "capture-client-legacy-repo-")));
  const identity = resolveRepositoryIdentity(repo);
  const binding = {
    ...workspaceBinding(),
    workspaceMode: false,
    repositoryKey: "acme/legacy",
    repositoryScopeKey: identity.repositoryScopeKey,
  };

  const selected = selectManagedCaptureBinding({
    bindings: [binding],
    host: "codex",
    bindingNonceHash: binding.bindingNonceHash,
    repositoryIdentity: identity,
  });

  assert.equal(selected.mode, "repository");
  assert.equal(selected.binding, binding);
});

test("workflow runtime stays fail-open when the managed binding is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-client-failopen-"));
  const cwd = join(root, "plain-directory");
  const codexHome = join(root, "codex");
  const stateHome = join(root, "state");
  mkdirSync(cwd);
  writeCodexIngress({ codexHome, stateHome });
  const env = {
    CODEX_HOME: codexHome,
    CODEX_SESSION_ID,
    COREDOC_WORKFLOWS_STATE_HOME: stateHome,
  };

  // An unreadable relay config must not break ordinary workflow execution.
  const unreadable = resolveWorkflowRuntime({
    cwd,
    env,
    readRelayConfig: () => {
      throw new Error("boom");
    },
  });
  assert.equal(unreadable.env.COREDOC_CAPTURE_ENDPOINT, undefined);

  // A binding set matching neither workspace nor repository scope likewise
  // resolves without capture instead of throwing.
  const unmatched = resolveWorkflowRuntime({
    cwd,
    env,
    readRelayConfig: () => ({ schemaVersion: 1, bindings: [] }),
  });
  assert.equal(unmatched.env.COREDOC_CAPTURE_ENDPOINT, undefined);
});

test("workspace-mode omits repository and cwd payloads outside Git or without a remote", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-client-workspace-"));
  const cwd = join(root, "plain-directory");
  const codexHome = join(root, "codex");
  const stateHome = join(root, "state");
  mkdirSync(cwd);
  writeCodexIngress({ codexHome, stateHome });

  const runtime = resolveWorkflowRuntime({
    cwd,
    env: {
      CODEX_HOME: codexHome,
      CODEX_SESSION_ID,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
      COREDOC_WORKFLOWS_REPO_KEY: "guessed/from-origin",
      COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY: "stale/candidate",
      COREDOC_CAPTURE_REPOSITORY_SCOPE_KEY: "repo-ffffffffffffffffffffffff",
    },
    readRelayConfig: () => ({
      schemaVersion: 1,
      bindings: [workspaceBinding()],
    }),
  });

  assert.equal(runtime.env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-1");
  assert.equal(runtime.env.COREDOC_CAPTURE_WORKSPACE_MODE, "1");
  assert.equal(runtime.env.COREDOC_CAPTURE_REPOSITORY_STATE, "none");
  assert.equal(
    runtime.env.COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY,
    undefined,
  );
  assert.equal(runtime.env.COREDOC_WORKFLOWS_REPO_KEY, undefined);
  assert.equal(runtime.env.COREDOC_CAPTURE_REPOSITORY_SCOPE_KEY, undefined);

  let recorderOptions;
  let claims = 0;
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-18T10:00:00.000Z",
      type: "capability.used",
      data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
    },
    {
      env: runtime.env,
      cwd,
      sessionId: CODEX_SESSION_ID,
      fetchImpl: async () => {
        claims += 1;
        throw new Error("workspace mode must not send a cwd claim");
      },
      createRecorder: (options) => {
        recorderOptions = options;
        return {
          record: () => ({ status: "queued", eventId: "current-event", pending: 1 }),
          flush: async () => ({
            pending: 0,
            bindingRefused: 0,
            unreadable: 0,
            receipt: {
              acceptedEventIds: ["current-event"],
              duplicateEventIds: [],
              rejected: [],
            },
          }),
        };
      },
    },
  );

  assert.equal(result.status, "sent");
  assert.equal(claims, 0);
  assert.deepEqual(recorderOptions.context, {
    host: "codex",
    sessionId: CODEX_SESSION_ID,
  });
  const serialized = JSON.stringify(recorderOptions);
  assert.doesNotMatch(serialized, /repositoryKey|origin/);
  assert.doesNotMatch(serialized, new RegExp(cwd));

  const noRemote = join(root, "git-without-remote");
  mkdirSync(noRemote);
  gitInit(noRemote);
  const unmappedRuntime = resolveWorkflowRuntime({
    cwd: noRemote,
    env: {
      CODEX_HOME: codexHome,
      CODEX_SESSION_ID,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    readRelayConfig: () => ({
      schemaVersion: 1,
      bindings: [workspaceBinding()],
    }),
  });
  assert.equal(unmappedRuntime.env.COREDOC_CAPTURE_REPOSITORY_STATE, "unmapped");
  assert.equal(
    unmappedRuntime.env.COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY,
    undefined,
  );
});

test("workspace-mode keeps a normalized Git candidate local for relay-side resolution", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-client-workspace-candidate-"));
  const repo = join(root, "repository");
  const codexHome = join(root, "codex");
  const stateHome = join(root, "state");
  mkdirSync(repo, { recursive: true });
  gitInit(repo);
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/payments.git"],
    { cwd: repo, stdio: ["ignore", "ignore", "ignore"] },
  );
  writeCodexIngress({ codexHome, stateHome });

  const runtime = resolveWorkflowRuntime({
    cwd: repo,
    env: {
      CODEX_HOME: codexHome,
      CODEX_SESSION_ID,
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    readRelayConfig: () => ({
      schemaVersion: 1,
      bindings: [workspaceBinding()],
    }),
  });

  assert.equal(runtime.env.COREDOC_CAPTURE_REPOSITORY_STATE, "unmapped");
  assert.equal(
    runtime.env.COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY,
    "acme/payments",
  );
  assert.equal(runtime.env.COREDOC_WORKFLOWS_REPO_KEY, undefined);

  const recorder = createConfiguredCaptureRecorder({
    env: runtime.env,
    cwd: repo,
    sessionId: CODEX_SESSION_ID,
    idFactory: () => "44444444-4444-4444-8444-444444444444",
  });
  recorder.record({
    occurredAt: "2026-08-18T10:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
  });

  const [event] = recorder.pending();
  assert.equal(event.repositoryKey, "acme/payments");
  assert.equal(Object.hasOwn(event, "repositoryCandidate"), false);
  assert.doesNotMatch(JSON.stringify(event), /github\.com|origin/);
  assert.doesNotMatch(JSON.stringify(event), new RegExp(repo));
});

test("preconfigured workspace capture recomputes repository identity for runtime and direct recorder callers", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-client-claude-workspace-candidate-"));
  const repo = join(root, "repository");
  const noRemote = join(root, "no-remote");
  const nonGit = join(root, "non-git");
  for (const directory of [repo, noRemote, nonGit]) {
    mkdirSync(directory, { recursive: true });
  }
  gitInit(repo);
  gitInit(noRemote);
  execFileSync(
    "git",
    ["remote", "add", "origin", "https://github.com/acme/payments.git"],
    { cwd: repo, stdio: ["ignore", "ignore", "ignore"] },
  );
  const env = {
    COREDOC_CAPTURE_ENDPOINT: MANAGED_ENV.COREDOC_CAPTURE_ENDPOINT,
    COREDOC_CAPTURE_HEADERS: MANAGED_ENV.COREDOC_CAPTURE_HEADERS,
    COREDOC_CAPTURE_BINDING_ID: "22222222-2222-4222-8222-222222222222",
    COREDOC_CAPTURE_WORKSPACE_ID: "ws-1",
    COREDOC_CAPTURE_HOST: "claude-code",
    COREDOC_CAPTURE_WORKSPACE_MODE: "1",
    COREDOC_CAPTURE_REPOSITORY_STATE: "known",
    COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY: "stale/injected",
    COREDOC_CAPTURE_REPOSITORY_KEY: "stale/authority",
    COREDOC_CAPTURE_REPOSITORY_SCOPE_KEY: "repo-stale",
    COREDOC_WORKFLOWS_REPO_KEY: "stale/legacy",
    COREDOC_WORKFLOWS_STATE_HOME: join(root, "state"),
  };

  const runtime = resolveWorkflowRuntime({ env, cwd: repo });
  assert.equal(runtime.env.COREDOC_CAPTURE_REPOSITORY_STATE, "unmapped");
  assert.equal(
    runtime.env.COREDOC_CAPTURE_REPOSITORY_CANDIDATE_KEY,
    "acme/payments",
  );
  assert.equal(runtime.env.COREDOC_WORKFLOWS_REPO_KEY, undefined);
  assert.equal(runtime.env.COREDOC_CAPTURE_REPOSITORY_KEY, undefined);
  assert.equal(runtime.env.COREDOC_CAPTURE_REPOSITORY_SCOPE_KEY, undefined);

  const contexts = [];
  for (const [cwd, expectedRepositoryKey] of [
    [repo, "acme/payments"],
    [noRemote, undefined],
    [nonGit, undefined],
  ]) {
    createConfiguredCaptureRecorder({
      env,
      cwd,
      sessionId: "claude-session",
      createRecorder: (options) => {
        contexts.push(options.context);
        return { record() {}, flush() {} };
      },
    });
    assert.equal(contexts.at(-1).repositoryKey, expectedRepositoryKey);
  }
});

test("builds the configured recorder from capture-only identity", () => {
  let options;
  const recorder = { record() {}, flush() {} };
  assert.equal(
    createConfiguredCaptureRecorder({
      env: ENV,
      sessionId: "session-42",
      createRecorder: (value) => {
        options = value;
        return recorder;
      },
    }),
    recorder,
  );
  assert.deepEqual(options, {
    directory: "/tmp/capture-client-test",
    target: ENV.COREDOC_CAPTURE_ENDPOINT,
    headers: { Authorization: "Bearer capture-token" },
    context: {
      host: "claude-code",
      sessionId: "session-42",
      repositoryKey: "coredoc/coredoc-parser",
    },
  });
  assert.doesNotMatch(JSON.stringify(options), /OTEL_EXPORTER/);
});

test("passes the managed relay workspace identity into the capture runtime", () => {
  let options;
  const recorder = { record() {}, flush() {} };
  assert.equal(
    createConfiguredCaptureRecorder({
      env: MANAGED_ENV,
      sessionId: "session-42",
      createRecorder: (value) => {
        options = value;
        return recorder;
      },
    }),
    recorder,
  );
  assert.equal(options.target, MANAGED_ENV.COREDOC_CAPTURE_ENDPOINT);
  assert.equal(options.workspaceId, "ws-1");
});

test("preflights managed schema 3 through authenticated relay health only", async () => {
  const channel = {
    state: "ready",
    lastSeenAt: null,
    lastForwardedAt: null,
    lastErrorCode: null,
  };
  const calls = [];
  const health = {
    schemaVersion: 1,
    bindingId: "11111111-1111-4111-8111-111111111111",
    host: "claude-code",
    workspaceId: "ws-1",
    state: "ready",
    native: channel,
    capture: { ...channel, acceptedSchemaVersions: [1, 2, 3] },
    attribution: { pendingCount: 0, rejectedCount: 0, lastClaimAt: null },
  };

  assert.deepEqual(
    await preflightCaptureSchemaVersion(3, {
      env: MANAGED_ENV,
      fetchImpl: async (target, options) => {
        calls.push({ target, options });
        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    }),
    { status: "ready", acceptedSchemaVersions: [1, 2, 3] },
  );
  assert.equal(calls[0].target, "http://127.0.0.1:43181/health");
  assert.deepEqual(calls[0].options.headers, {
    "X-Coredoc-Relay-Binding":
      "local_binding_abcdefghijklmnopqrstuvwxyz012345",
  });

  await assert.rejects(
    preflightCaptureSchemaVersion(3, {
      env: MANAGED_ENV,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ ...health, capture: channel }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    }),
    /does not accept capture schema 3/,
  );
});

test("reports sandbox-denied managed relay access without calling it a schema mismatch", async () => {
  const permissionError = Object.assign(new Error("connect denied"), {
    code: "EPERM",
  });
  const fetchError = Object.assign(new Error("fetch failed"), {
    cause: permissionError,
  });

  await assert.rejects(
    preflightCaptureSchemaVersion(3, {
      env: MANAGED_ENV,
      fetchImpl: async () => {
        throw fetchError;
      },
    }),
    (error) => {
      assert.match(error.message, /cannot reach the managed capture relay/i);
      assert.match(error.message, /outside the sandbox/i);
      assert.doesNotMatch(error.message, /does not accept capture schema 3/i);
      return true;
    },
  );
});

test("does not preflight direct-cloud or work-item-free capture", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("must not fetch");
  };

  assert.deepEqual(
    await preflightCaptureSchemaVersion(3, { env: ENV, fetchImpl }),
    { status: "not-managed" },
  );
  assert.deepEqual(
    await preflightCaptureSchemaVersion(2, { env: MANAGED_ENV, fetchImpl }),
    { status: "not-required" },
  );
  assert.equal(calls, 0);
});

test("managed capture uses a global mode-0700 outbox keyed by relay binding hash", () => {
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-managed-capture-home-"));
  const nonce = "local_binding_abcdefghijklmnopqrstuvwxyz012345";
  const recorder = createConfiguredCaptureRecorder({
    env: {
      COREDOC_CAPTURE_ENDPOINT:
        "http://127.0.0.1:43181/capture/v1/events",
      COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Binding=${nonce}`,
      COREDOC_CAPTURE_WORKSPACE_ID: "ws-1",
      COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    },
    sessionId: "session-42",
    idFactory: () => "11111111-1111-4111-8111-111111111111",
  });
  recorder.record({
    occurredAt: "2026-08-16T15:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
  });

  const bindingHash = createHash("sha256").update(nonce).digest("hex");
  const expected = join(
    stateHome,
    "capture-agent",
    "capture-relay",
    "outbox",
    bindingHash,
  );
  assert.equal(statSync(expected).isDirectory(), true);
  assert.equal(statSync(expected).mode & 0o777, 0o700);
  assert.equal(recorder.pending().length, 1);
});

test("registers the managed Codex workflow fallback claim from cwd only", async () => {
  const requests = [];
  const ingress = "local_binding_codex_abcdefghijklmnopqrstuvwxyz012345";
  const bindingId = "22222222-2222-4222-8222-222222222222";
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-18T10:00:00.000Z",
      type: "capability.used",
      data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
    },
    {
      env: {
        COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture/v1/events",
        COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Ingress=${ingress},X-Coredoc-Relay-Binding-Id=${bindingId}`,
        COREDOC_CAPTURE_WORKSPACE_ID: "ws-one",
        COREDOC_CAPTURE_HOST: "codex",
        COREDOC_CAPTURE_BINDING_ID: bindingId,
        COREDOC_CAPTURE_REPOSITORY_SCOPE_KEY: "repo-111111111111111111111111",
      },
      cwd: "/work/repo-one",
      sessionId: "codex-session",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(null, { status: 200 });
      },
      createRecorder: () => ({
        record: () => ({ status: "queued", eventId: "current-event", pending: 1 }),
        flush: async () => ({
          pending: 0,
          bindingRefused: 0,
          unreadable: 0,
          receipt: {
            acceptedEventIds: ["current-event"],
            duplicateEventIds: [],
            rejected: [],
          },
        }),
      }),
    },
  );

  assert.equal(result.status, "sent");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:43181/codex/v1/session-claims");
  assert.equal(requests[0].options.headers["X-Coredoc-Relay-Ingress"], ingress);
  assert.equal(requests[0].options.headers["X-Coredoc-Relay-Binding-Id"], undefined);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    sessionId: "codex-session",
    cwd: "/work/repo-one",
  });
});

test("delivers and classifies only the newly queued capture event", async () => {
  const recorded = [];
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:00:00.000Z",
      type: "capability.used",
      data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
    },
    {
      env: ENV,
      sessionId: "session-42",
      timeoutMs: 750,
      createRecorder: () => ({
        record: (event) => {
          recorded.push(event);
          return { status: "queued", eventId: "current-event", pending: 2 };
        },
        flush: async (options) => {
          assert.deepEqual(options, { timeoutMs: 750 });
          return {
            pending: 0,
            bindingRefused: 1,
            unreadable: 2,
            receipt: {
              acceptedEventIds: ["older-event"],
              duplicateEventIds: ["current-event"],
              rejected: [],
            },
          };
        },
      }),
    },
  );

  assert.equal(recorded.length, 1);
  assert.deepEqual(result, {
    status: "sent",
    durable: true,
    eventId: "current-event",
    pending: 0,
    bindingRefused: 1,
    unreadable: 2,
  });
});

test("keeps unmatched and transport-failed events durably pending", async () => {
  const baseRecorder = {
    record: () => ({ status: "queued", eventId: "current-event", pending: 1 }),
    pending: () => [{ eventId: "current-event" }],
  };
  const unmatched = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:00:00.000Z",
      type: "capability.used",
      data: { kind: "agent", capabilityId: "Explore", outcome: "unknown" },
    },
    {
      env: ENV,
      sessionId: "session-42",
      createRecorder: () => ({
        ...baseRecorder,
        flush: async () => ({
          pending: 1,
          bindingRefused: 0,
          unreadable: 0,
          receipt: {
            acceptedEventIds: [],
            duplicateEventIds: [],
            rejected: [{ eventId: null, code: "REQUEST_INVALID" }],
          },
        }),
      }),
    },
  );
  assert.deepEqual(unmatched, {
    status: "pending",
    durable: true,
    eventId: "current-event",
    pending: 1,
    bindingRefused: 0,
    unreadable: 0,
  });

  const failed = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:00:00.000Z",
      type: "capability.used",
      data: { kind: "agent", capabilityId: "Explore", outcome: "unknown" },
    },
    {
      env: ENV,
      sessionId: "session-42",
      createRecorder: () => ({
        ...baseRecorder,
        record: () => ({
          status: "queued",
          eventId: "current-event",
          pending: 1,
          bindingRefused: 2,
          unreadable: 1,
        }),
        flush: async () => {
          throw new Error("offline");
        },
      }),
    },
  );
  assert.deepEqual(failed, {
    status: "pending",
    durable: true,
    eventId: "current-event",
    pending: 1,
    bindingRefused: 2,
    unreadable: 1,
  });
});

test("disabled capture is durable opt-out without creating an event", async () => {
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:00:00.000Z",
      type: "capability.used",
      data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
    },
    {
      env: { COREDOC_CAPTURE_ENDPOINT: "" },
      sessionId: "session-42",
      createRecorder: () => ({ record: () => ({ status: "disabled" }) }),
    },
  );
  assert.deepEqual(result, { status: "disabled", durable: true, pending: 0 });
});

test("flushes once on overflow and durably requeues the same event when capacity is freed", async () => {
  const recorded = [];
  let flushes = 0;
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:00:00.000Z",
      type: "capability.used",
      data: { kind: "agent", capabilityId: "Explore", outcome: "unknown" },
    },
    {
      env: ENV,
      sessionId: "session-42",
      timeoutMs: 750,
      createRecorder: ({ idFactory }) => ({
        record: (event) => {
          const eventId = idFactory();
          recorded.push({ event, eventId });
          return recorded.length === 1
            ? {
                status: "overflow",
                eventId,
                pending: 100,
                bindingRefused: 2,
                unreadable: 1,
              }
            : {
                status: "queued",
                eventId,
                pending: 1,
                bindingRefused: 2,
                unreadable: 1,
              };
        },
        flush: async (options) => {
          flushes += 1;
          assert.deepEqual(options, { timeoutMs: 750 });
          return {
            pending: 0,
            bindingRefused: 2,
            unreadable: 1,
            receipt: {
              acceptedEventIds: ["older-event"],
              duplicateEventIds: [],
              rejected: [],
            },
          };
        },
      }),
    },
  );

  assert.equal(flushes, 1);
  assert.equal(recorded.length, 2);
  assert.match(recorded[0].eventId, /^[0-9a-f-]{36}$/);
  assert.equal(recorded[1].eventId, recorded[0].eventId);
  assert.deepEqual(recorded[1].event, recorded[0].event);
  assert.deepEqual(result, {
    status: "pending",
    eventId: recorded[0].eventId,
    pending: 1,
    bindingRefused: 2,
    unreadable: 1,
    durable: true,
  });
});

test("recovers a real full outbox into one durable finish event", async () => {
  const env = {
    ...ENV,
    COREDOC_WORKFLOWS_CAPTURE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-capture-client-overflow-"),
    ),
  };
  const recorder = createConfiguredCaptureRecorder({
    env,
    sessionId: "session-42",
  });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      recorder.record({
        occurredAt: new Date(
          Date.UTC(2026, 7, 16, 10, 0, 0, index),
        ).toISOString(),
        type: "capability.used",
        data: {
          kind: "skill",
          capabilityId: `skill-${index}`,
          outcome: "success",
        },
      }).status,
      "queued",
    );
  }

  let sends = 0;
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:01:00.000Z",
      type: "workflow.run.finished",
      runId: "cdr-20260816-a1b2c3",
      data: { outcome: "success" },
    },
    {
      env,
      sessionId: "session-42",
      timeoutMs: 750,
      createRecorder: (options) => {
        const configured = createCaptureRecorder(options);
        return {
          ...configured,
          flush: (flushOptions) =>
            configured.flush({
              ...flushOptions,
              send: async (_target, batch) => {
                sends += 1;
                return {
                  acceptedEventIds: batch.events.map(({ eventId }) => eventId),
                  duplicateEventIds: [],
                  rejected: [],
                };
              },
            }),
        };
      },
    },
  );

  assert.equal(sends, 1);
  assert.equal(result.status, "pending");
  assert.equal(result.durable, true);
  assert.equal(result.pending, 1);
  assert.equal(recorder.health().counters.overflow, 1);
  assert.deepEqual(
    recorder.pending().map(({ eventId, type, runId }) => ({
      eventId,
      type,
      runId,
    })),
    [
      {
        eventId: result.eventId,
        type: "workflow.run.finished",
        runId: "cdr-20260816-a1b2c3",
      },
    ],
  );
});

test("keeps the original overflow visible when its one drain attempt fails", async () => {
  let records = 0;
  let flushes = 0;
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:00:00.000Z",
      type: "workflow.run.finished",
      runId: "cdr-20260816-a1b2c3",
      data: { outcome: "success" },
    },
    {
      env: ENV,
      sessionId: "session-42",
      timeoutMs: 750,
      createRecorder: () => ({
        record: () => {
          records += 1;
          return {
            status: "overflow",
            eventId: "current-event",
            pending: 100,
            bindingRefused: 2,
            unreadable: 1,
          };
        },
        flush: async (options) => {
          flushes += 1;
          assert.deepEqual(options, { timeoutMs: 750 });
          throw new Error("offline");
        },
      }),
    },
  );

  assert.equal(records, 1);
  assert.equal(flushes, 1);
  assert.deepEqual(result, {
    status: "overflow",
    eventId: "current-event",
    pending: 100,
    bindingRefused: 2,
    unreadable: 1,
    durable: false,
  });
});

test("does not retry enqueue when a successful drain frees no capacity", async () => {
  let records = 0;
  let flushes = 0;
  const result = await deliverCaptureEvent(
    {
      occurredAt: "2026-08-16T10:00:00.000Z",
      type: "workflow.run.finished",
      runId: "cdr-20260816-a1b2c3",
      data: { outcome: "success" },
    },
    {
      env: ENV,
      sessionId: "session-42",
      createRecorder: () => ({
        record: () => {
          records += 1;
          return {
            status: "overflow",
            eventId: "current-event",
            pending: 100,
          };
        },
        flush: async () => {
          flushes += 1;
          return {
            pending: 100,
            bindingRefused: 0,
            unreadable: 0,
            receipt: {
              acceptedEventIds: [],
              duplicateEventIds: [],
              rejected: [{ eventId: null, code: "REQUEST_INVALID" }],
            },
          };
        },
      }),
    },
  );

  assert.equal(records, 1);
  assert.equal(flushes, 1);
  assert.deepEqual(result, {
    status: "overflow",
    eventId: "current-event",
    pending: 100,
    durable: false,
  });
});

test("a listed repository binding wins over the workspace binding for its checkout only", () => {
  const listed = gitInit(mkdtempSync(join(tmpdir(), "capture-client-listed-repo-")));
  const other = gitInit(mkdtempSync(join(tmpdir(), "capture-client-other-repo-")));
  const listedIdentity = resolveRepositoryIdentity(listed);
  const otherIdentity = resolveRepositoryIdentity(other);
  const workspace = workspaceBinding();
  const repository = {
    ...workspaceBinding({ bindingId: "33333333-3333-4333-8333-333333333333" }),
    workspaceMode: false,
    workspaceId: "ws-local",
    repositoryKey: "acme/listed",
    repositoryScopeKey: listedIdentity.repositoryScopeKey,
  };
  const options = {
    bindings: [workspace, repository],
    host: "codex",
    bindingNonceHash: workspace.bindingNonceHash,
  };

  const inListed = selectManagedCaptureBinding({
    ...options,
    repositoryIdentity: listedIdentity,
  });
  assert.equal(inListed.mode, "repository");
  assert.equal(inListed.binding, repository);

  const elsewhere = selectManagedCaptureBinding({
    ...options,
    repositoryIdentity: otherIdentity,
  });
  assert.equal(elsewhere.mode, "workspace");
  assert.equal(elsewhere.binding, workspace);

  const outsideGit = selectManagedCaptureBinding({
    ...options,
    repositoryIdentity: null,
  });
  assert.equal(outsideGit.mode, "workspace");

  assert.throws(
    () =>
      selectManagedCaptureBinding({
        ...options,
        bindings: [
          workspace,
          repository,
          { ...repository, bindingId: "44444444-4444-4444-8444-444444444444" },
        ],
        repositoryIdentity: listedIdentity,
      }),
    /managed Codex relay binding is unavailable/,
  );
});

test("Claude Code never selects a repository binding by Git origin", () => {
  const repository = {
    ...workspaceBinding({
      bindingId: "33333333-3333-4333-8333-333333333333",
      host: "claude-code",
    }),
    workspaceMode: false,
    workspaceId: "ws-local",
    repositoryKey: "acme/listed",
  };
  const workspace = workspaceBinding({ host: "claude-code" });
  // Another clone of the same repository (same origin, different checkout)
  // must stay on the workspace binding.
  assert.equal(
    selectManagedCaptureBinding({
      bindings: [workspace, repository],
      host: "claude-code",
      bindingNonceHash: workspace.bindingNonceHash,
      repositoryIdentity: {
        state: "unmapped",
        repositoryScopeKey: "repo-111111111111111111111111",
        normalizedRepositoryKey: "acme/listed",
      },
    }).binding,
    workspace,
  );
});

test("a repository binding pinned to a checkout root is not selected from a sibling worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "capture-client-worktree-"));
  const listed = join(root, "listed");
  const sibling = join(root, "sibling");
  mkdirSync(join(listed, ".git", "worktrees", "sibling"), { recursive: true });
  writeFileSync(join(listed, ".git", "worktrees", "sibling", "commondir"), "../..\n");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, ".git"), `gitdir: ${join(listed, ".git", "worktrees", "sibling")}\n`);
  const listedIdentity = resolveRepositoryIdentity(listed);
  const siblingIdentity = resolveRepositoryIdentity(sibling);
  const listedRoot = resolveRepositoryRoot(listed);
  const siblingRoot = resolveRepositoryRoot(sibling);
  assert.equal(siblingIdentity.repositoryScopeKey, listedIdentity.repositoryScopeKey);
  assert.notEqual(siblingRoot, listedRoot);
  assert.equal(Object.hasOwn(listedIdentity, "repositoryRoot"), false);
  const workspace = workspaceBinding();
  const repository = {
    ...workspaceBinding({ bindingId: "33333333-3333-4333-8333-333333333333" }),
    workspaceMode: false,
    workspaceId: "ws-local",
    repositoryKey: "acme/listed",
    repositoryScopeKey: listedIdentity.repositoryScopeKey,
    repositoryRoot: listedRoot,
  };
  const options = {
    bindings: [workspace, repository],
    host: "codex",
    bindingNonceHash: workspace.bindingNonceHash,
  };
  assert.equal(
    selectManagedCaptureBinding({
      ...options,
      repositoryIdentity: listedIdentity,
      repositoryRoot: listedRoot,
    }).binding,
    repository,
  );
  assert.equal(
    selectManagedCaptureBinding({
      ...options,
      repositoryIdentity: siblingIdentity,
      repositoryRoot: siblingRoot,
    }).binding,
    workspace,
  );
});
