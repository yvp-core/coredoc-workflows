import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import {
  basename,
  dirname,
  join,
  resolve,
  sep,
} from "node:path";

import {
  captureHeaders,
  createCaptureRecorder,
} from "../runtime/capture/index.mjs";

import {
  managedRelayHealth,
  readManagedRelayConfig,
  relayBindingNonceFromCaptureHeaders,
  sha256BindingNonce,
} from "./managed-otel-relay.mjs";
import {
  persistentDirs,
  resolveRepositoryScopeKey,
  stateRoot,
} from "./project-key.mjs";

const MANAGED_CAPTURE_ENDPOINT =
  "http://127.0.0.1:43181/capture/v1/events";
const BINDING_HASH_RE = /^[0-9a-f]{64}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const CODEX_BINDING_NONCE_RE = /^[A-Za-z0-9_-]{32,256}$/;

function validSessionId(value) {
  return SESSION_ID_RE.test(String(value ?? ""));
}

export function workflowSessionId(env = process.env) {
  if (Object.hasOwn(env, "COREDOC_WORKFLOWS_SESSION_ID")) {
    return validSessionId(env.COREDOC_WORKFLOWS_SESSION_ID)
      ? env.COREDOC_WORKFLOWS_SESSION_ID
      : undefined;
  }
  for (const candidate of [env.CODEX_SESSION_ID, env.CODEX_THREAD_ID]) {
    if (candidate === undefined || candidate === "") continue;
    return validSessionId(candidate) ? candidate : undefined;
  }
  return undefined;
}

function codexSessionId(env) {
  for (const candidate of [env.CODEX_SESSION_ID, env.CODEX_THREAD_ID]) {
    if (candidate === undefined || candidate === "") continue;
    return validSessionId(candidate) ? candidate : undefined;
  }
  return undefined;
}

/**
 * The capture host for one hook payload. Codex executes the Claude-compatible plugin hooks
 * with its own thread id in the environment, so a payload whose session IS that thread belongs
 * to Codex — an inherited Claude capture env must not relabel it (observed live: capability
 * events for a Codex thread stamped claude-code permanently contradict the codex-provider
 * session the telemetry path establishes). A payload with a DIFFERENT session id (a Claude
 * session nested inside a Codex run) keeps the env-resolved host.
 */
export function captureHostForHookSession(env, sessionId) {
  if (sessionId !== undefined && codexSessionId(env) === sessionId) return "codex";
  return env.COREDOC_CAPTURE_HOST ?? "claude-code";
}

function codexIngressToken(path) {
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.size > 4_096
    ) {
      throw new Error("invalid ingress settings");
    }
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      value.schemaVersion !== 1 ||
      !CODEX_BINDING_NONCE_RE.test(value.token)
    ) {
      throw new Error("invalid ingress settings");
    }
    return value.token;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error("managed Codex relay binding is unavailable");
  }
}

function managedCodexBinding(env, cwd) {
  const relayRoot = join(resolve(stateRoot(env)), "capture-relay");
  const bindingNonce = codexIngressToken(join(relayRoot, "codex-ingress.json"));
  if (bindingNonce === undefined) return undefined;
  let relayConfig;
  try {
    relayConfig = readManagedRelayConfig(join(relayRoot, "relay.json"));
  } catch {
    throw new Error("managed Codex relay binding is unavailable");
  }
  const bindingNonceHash = sha256BindingNonce(bindingNonce);
  const repositoryScopeKey = resolveRepositoryScopeKey(cwd);
  const matches = relayConfig.bindings.filter(
    (candidate) =>
      candidate.host === "codex" &&
      candidate.bindingNonceHash === bindingNonceHash &&
      candidate.repositoryScopeKey === repositoryScopeKey,
  );
  if (matches.length !== 1) {
    throw new Error("managed Codex relay binding is unavailable");
  }
  return { bindingNonce, binding: matches[0], repositoryScopeKey };
}

export function resolveWorkflowRuntime({ env = process.env, cwd = process.cwd() } = {}) {
  const sessionId = workflowSessionId(env);
  const resolvedEnv = {
    ...env,
    ...(sessionId === undefined
      ? {}
      : { COREDOC_WORKFLOWS_SESSION_ID: sessionId }),
  };
  if (
    Object.hasOwn(env, "COREDOC_CAPTURE_ENDPOINT") ||
    Object.hasOwn(env, "COREDOC_WORKFLOWS_SESSION_ID") ||
    codexSessionId(env) === undefined
  ) {
    return { env: resolvedEnv, sessionId };
  }
  const managed = managedCodexBinding(env, cwd);
  if (managed === undefined) return { env: resolvedEnv, sessionId };
  return {
    sessionId,
    env: {
      ...resolvedEnv,
      COREDOC_CAPTURE_ENDPOINT: MANAGED_CAPTURE_ENDPOINT,
      COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Ingress=${managed.bindingNonce},X-Coredoc-Relay-Binding-Id=${managed.binding.bindingId}`,
      COREDOC_CAPTURE_BINDING_ID: managed.binding.bindingId,
      COREDOC_CAPTURE_REPOSITORY_SCOPE_KEY: managed.repositoryScopeKey,
      COREDOC_CAPTURE_WORKSPACE_ID: managed.binding.workspaceId,
      COREDOC_CAPTURE_HOST: "codex",
      ...(resolvedEnv.COREDOC_WORKFLOWS_REPO_KEY !== undefined ||
      managed.binding.repositoryKey === undefined
        ? {}
        : { COREDOC_WORKFLOWS_REPO_KEY: managed.binding.repositoryKey }),
    },
  };
}

export async function preflightCaptureSchemaVersion(
  schemaVersion,
  { env = process.env, fetchImpl = fetch, timeoutMs = 300 } = {},
) {
  if (schemaVersion !== 3) return { status: "not-required" };
  if (env.COREDOC_CAPTURE_ENDPOINT !== MANAGED_CAPTURE_ENDPOINT) {
    return { status: "not-managed" };
  }

  const refuse = () => {
    throw new Error(
      "The managed capture relay does not accept capture schema 3; reprovision or restart Coredoc capture before routing work items",
    );
  };
  const refuseSandbox = () => {
    throw new Error(
      "The workflow cannot reach the managed capture relay from the Codex sandbox; rerun this Coredoc workflow command outside the sandbox with elevated permissions",
    );
  };
  let health;
  try {
    const headers = captureHeaders(env.COREDOC_CAPTURE_HEADERS ?? "");
    const response = await fetchImpl("http://127.0.0.1:43181/health", {
      method: "GET",
      redirect: "error",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      refuse();
    }
    health = managedRelayHealth(await response.json());
  } catch (error) {
    if (
      [error?.code, error?.cause?.code].some(
        (code) => code === "EPERM" || code === "EACCES",
      )
    ) {
      refuseSandbox();
    }
    refuse();
  }
  if (
    health.host !== (env.COREDOC_CAPTURE_HOST ?? "claude-code") ||
    health.workspaceId !== env.COREDOC_CAPTURE_WORKSPACE_ID ||
    !health.capture.acceptedSchemaVersions.includes(3)
  ) {
    refuse();
  }
  return {
    status: "ready",
    acceptedSchemaVersions: [...health.capture.acceptedSchemaVersions],
  };
}

function bindingCaptureDirectory(relayRoot, bindingNonceHash) {
  if (!BINDING_HASH_RE.test(String(bindingNonceHash ?? ""))) {
    throw new Error("managed capture binding hash is invalid");
  }
  const root = resolve(relayRoot);
  const directory = resolve(root, "outbox", bindingNonceHash);
  if (!directory.startsWith(`${root}${sep}`)) {
    throw new Error("managed capture directory is invalid");
  }
  return directory;
}

export function managedCaptureDirectory(bindingNonceHash, env = process.env) {
  return bindingCaptureDirectory(
    join(resolve(stateRoot(env)), "capture-relay"),
    bindingNonceHash,
  );
}

export function managedCaptureDirectoryForConfig(
  bindingNonceHash,
  configPath,
) {
  const resolvedConfig = resolve(configPath);
  const relayRoot = dirname(resolvedConfig);
  if (
    basename(resolvedConfig) !== "relay.json" ||
    basename(relayRoot) !== "capture-relay"
  ) {
    throw new Error("managed relay config path is invalid");
  }
  return bindingCaptureDirectory(relayRoot, bindingNonceHash);
}

export function captureDirectory(cwd, env) {
  if (env.COREDOC_CAPTURE_ENDPOINT === MANAGED_CAPTURE_ENDPOINT) {
    if (env.COREDOC_CAPTURE_BINDING_ID !== undefined) {
      if (!/^[0-9a-f-]{36}$/i.test(env.COREDOC_CAPTURE_BINDING_ID)) {
        throw new Error("managed capture binding id is invalid");
      }
      return managedCaptureDirectory(
        sha256BindingNonce(env.COREDOC_CAPTURE_BINDING_ID),
        env,
      );
    }
    const nonce = relayBindingNonceFromCaptureHeaders(env.COREDOC_CAPTURE_HEADERS);
    return managedCaptureDirectory(sha256BindingNonce(nonce), env);
  }
  if (env.COREDOC_WORKFLOWS_CAPTURE_DIR) {
    return env.COREDOC_WORKFLOWS_CAPTURE_DIR;
  }
  // Keep direct-cloud durable events in the path-derived namespace if config is added later.
  return join(persistentDirs(cwd, env).at(-1), "capture-events");
}

export function createConfiguredCaptureRecorder({
  env = process.env,
  cwd = process.cwd(),
  host = env.COREDOC_CAPTURE_HOST ?? "claude-code",
  sessionId,
  idFactory,
  createRecorder = createCaptureRecorder,
} = {}) {
  const context =
    sessionId === undefined
      ? undefined
      : {
          host,
          sessionId,
          ...(env.COREDOC_WORKFLOWS_REPO_KEY
            ? { repositoryKey: env.COREDOC_WORKFLOWS_REPO_KEY }
            : {}),
        };
  return createRecorder({
    directory: captureDirectory(cwd, env),
    target: env.COREDOC_CAPTURE_ENDPOINT ?? "",
    headers: captureHeaders(env.COREDOC_CAPTURE_HEADERS ?? ""),
    ...(env.COREDOC_CAPTURE_WORKSPACE_ID === undefined
      ? {}
      : { workspaceId: env.COREDOC_CAPTURE_WORKSPACE_ID }),
    ...(context === undefined ? {} : { context }),
    ...(idFactory === undefined ? {} : { idFactory }),
  });
}

function deliveryCounts(result) {
  return {
    pending: result.pending ?? 0,
    bindingRefused: result.bindingRefused ?? 0,
    unreadable: result.unreadable ?? 0,
  };
}

function receiptStatus(receipt, eventId) {
  if (
    receipt.acceptedEventIds.includes(eventId) ||
    receipt.duplicateEventIds.includes(eventId)
  ) {
    return "sent";
  }
  if (receipt.rejected.some((entry) => entry.eventId === eventId)) {
    return "rejected";
  }
  return "pending";
}

export async function deliverCaptureEvent(
  event,
  {
    env = process.env,
    cwd = process.cwd(),
    host = env.COREDOC_CAPTURE_HOST ?? "claude-code",
    sessionId = env.COREDOC_WORKFLOWS_SESSION_ID,
    timeoutMs,
    createRecorder = createCaptureRecorder,
    fetchImpl = fetch,
  } = {},
) {
  const target = env.COREDOC_CAPTURE_ENDPOINT ?? "";
  const eventId = randomUUID();
  const flushOptions = timeoutMs === undefined ? {} : { timeoutMs };
  let recorder;
  let queued;
  try {
    if (
      host === "codex" &&
      sessionId &&
      env.COREDOC_CAPTURE_REPOSITORY_SCOPE_KEY &&
      target === MANAGED_CAPTURE_ENDPOINT
    ) {
      try {
        const headers = captureHeaders(env.COREDOC_CAPTURE_HEADERS ?? "");
        delete headers["X-Coredoc-Relay-Binding-Id"];
        const response = await fetchImpl(
          "http://127.0.0.1:43181/codex/v1/session-claims",
          {
            method: "POST",
            redirect: "error",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
              sessionId,
              cwd,
            }),
            signal: AbortSignal.timeout(300),
          },
        );
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Semantic delivery remains repository-bound even if the fallback claim races the relay.
      }
    }
    recorder = createConfiguredCaptureRecorder({
      env,
      cwd,
      host,
      sessionId,
      idFactory: () => eventId,
      createRecorder,
    });
    queued = recorder.record(event);
    if (queued.status === "disabled") {
      return { status: "disabled", durable: true, pending: 0 };
    }
    if (queued.status === "overflow") {
      const overflow = queued;
      try {
        const drained = await recorder.flush(flushOptions);
        if (drained.pending >= overflow.pending) {
          return { ...overflow, durable: false };
        }
        queued = recorder.record(event);
        if (queued.status !== "queued") {
          return { ...queued, durable: false };
        }
        // The single network budget drained the backlog. SessionStart or the
        // next explicit delivery owns sending this newly durable event.
        return {
          status: "pending",
          durable: true,
          eventId: queued.eventId,
          ...deliveryCounts(queued),
        };
      } catch {
        return { ...overflow, durable: false };
      }
    }
    if (queued.status !== "queued") {
      return { ...queued, durable: false };
    }

    const delivered = await recorder.flush(flushOptions);
    return {
      status: receiptStatus(delivered.receipt, queued.eventId),
      durable: true,
      eventId: queued.eventId,
      ...deliveryCounts(delivered),
    };
  } catch {
    if (!target) return { status: "disabled", durable: true, pending: 0 };
    if (queued?.status === "queued") {
      let pending;
      try {
        pending = recorder?.pending().length;
      } catch {
        // The event was durably staged; diagnostics must not change that outcome.
      }
      return {
        status: "pending",
        durable: true,
        eventId: queued.eventId,
        ...(pending === undefined ? {} : { pending }),
        ...(queued.bindingRefused
          ? { bindingRefused: queued.bindingRefused }
          : {}),
        ...(queued.unreadable ? { unreadable: queued.unreadable } : {}),
      };
    }
    return { status: "failed", durable: false };
  }
}
