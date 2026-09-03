#!/usr/bin/env node

import { createHash, randomBytes, randomUUID as nodeRandomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";

import {
  captureAgentPaths,
  createCaptureAgentLifecycle,
} from "./capture-agent-lifecycle.mjs";
import { enrollCaptureAgent } from "./capture-agent-enrollment.mjs";
import {
  captureAgentPolicyPath,
  destinationKey,
  destinationPolicy,
  loadCaptureAgentPolicy,
  validateCaptureAgentPolicy,
} from "./capture-agent-policy.mjs";
import {
  inspectHostGlobalConfig,
  prepareCodexHooksTransaction,
  prepareHostGlobalConfigTransaction,
} from "./host-global-config.mjs";
import { managedRelayConfig } from "./managed-otel-relay.mjs";
import {
  resolveRepositoryIdentity,
  resolveRepositoryScopeKey,
} from "./project-key.mjs";

const IDENTITY_MARKER = "coredoc-workflows.capture-agent-installation.v1";
const IDENTITY_FIELDS = new Set([
  "schemaVersion",
  "marker",
  "serverOrigin",
  "workspaceId",
  "installationId",
  "claude",
  "codex",
]);
// `repositories` is optional so identities written before multi-destination
// routing stay readable; an absent list means no listed repositories.
const IDENTITY_OPTIONAL_FIELDS = new Set(["repositories"]);
const REPOSITORY_IDENTITY_FIELDS = new Set([
  "path",
  "repositoryKey",
  "repositoryScopeKey",
  "serverOrigin",
  "workspaceId",
  "claude",
  "codex",
]);
const REPOSITORY_CODEX_FIELDS = new Set(["bindingId"]);
const REPOSITORY_SCOPE_KEY = /^repo-[a-f0-9]{24}$/;
const BINDING_FIELDS = new Set(["bindingId", "bindingNonce"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const CLOUD_TOKEN = /^cdt_[a-f0-9]{64}$/;
const PROFILE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.config\.toml$/;
const MAX_STATE_BYTES = 1024 * 1024;
const LOCK_MARKER = "coredoc-workflows.capture-agent-setup-lock.v1";
const PURGE_MARKER = "coredoc-workflows.capture-agent-purge.v1";
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;

const SAFE_ERROR_CODES = new Set([
  "BROWSER_OPEN_FAILED",
  "CLOUD_AUTH_REJECTED",
  "CLOUD_HEALTH_MISMATCH",
  "CONFIG_CHANGED",
  "CONFIG_CONFLICT",
  "CONFIG_INVALID",
  "DCR_FAILED",
  "DCR_INVALID",
  "DCR_REQUIRED",
  "DISCOVERY_FAILED",
  "DISCOVERY_INVALID",
  "FOREIGN_LISTENER",
  "HEALTH_MISMATCH",
  "INVALID_ARGUMENTS",
  "INVALID_INPUT",
  "INVALID_RUNTIME_MANIFEST",
  "INVALID_STATE",
  "INSTALLATION_RESPONSE_INVALID",
  "INSTALLATION_REVOKE_FAILED",
  "INSTALLATION_REVOKE_UNCONFIRMED",
  "INSTALLATION_ROTATE_FAILED",
  "LEGACY_DESKTOP_PRESENT",
  "LOCKED",
  "NOT_INSTALLED",
  "NO_PREVIOUS_RUNTIME",
  "OAUTH_CALLBACK_FAILED",
  "OAUTH_CALLBACK_INVALID",
  "OAUTH_DENIED",
  "OAUTH_STATE_MISMATCH",
  "OAUTH_TIMEOUT",
  "OWNED_LIST_FAILED",
  "OWNED_RESPONSE_INVALID",
  "OWNED_REVOKE_FAILED",
  "OWNERSHIP_CONFLICT",
  "PKCE_UNAVAILABLE",
  "POLICY_INVALID",
  "POLICY_UNAVAILABLE",
  "POLICY_UNSAFE",
  "POLICY_DRIFT",
  "REPOSITORY_UNRESOLVED",
  "PURGE_INCOMPLETE",
  "ROLLBACK_FAILED",
  "SUPERVISOR_UNAVAILABLE",
  "TOKEN_EXCHANGE_FAILED",
  "TOKEN_RESPONSE_INVALID",
  "UNINSTALL_INCOMPLETE",
  "UNSAFE_PATH",
  "UNSAFE_STATE",
  "UNSUPPORTED_PLATFORM",
  "WRITE_FAILED",
]);

export class CaptureAgentSetupError extends Error {
  constructor(code, { rollback } = {}) {
    super(SAFE_ERROR_CODES.has(code) ? code : "UNSAFE_STATE");
    this.name = "CaptureAgentSetupError";
    this.code = SAFE_ERROR_CODES.has(code) ? code : "UNSAFE_STATE";
    if (rollback !== undefined) this.rollback = rollback;
  }
}

function fail(code, options) {
  throw new CaptureAgentSetupError(code, options);
}

function mappedError(error, fallback = "UNSAFE_STATE") {
  if (error instanceof CaptureAgentSetupError) return error;
  const code = typeof error?.code === "string" ? error.code : fallback;
  return new CaptureAgentSetupError(
    SAFE_ERROR_CODES.has(code) ? code : fallback,
    error?.rollback === undefined ? {} : { rollback: error.rollback },
  );
}

function exactObject(value, fields, code = "UNSAFE_STATE") {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.size ||
    Object.keys(value).some((field) => !fields.has(field))
  ) {
    fail(code);
  }
  return value;
}

function exactAbsolute(value, code = "UNSAFE_STATE") {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail(code);
  }
  return value;
}

export function captureAgentSetupPaths({
  env = process.env,
  homeDir = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(),
} = {}) {
  const home = exactAbsolute(homeDir);
  const configuredCoredocHome = env.COREDOC_HOME?.trim();
  const coredocHome = configuredCoredocHome
    ? exactAbsolute(configuredCoredocHome)
    : join(home, ".coredoc");
  const configuredCodexHome = env.CODEX_HOME?.trim();
  const codexHome = configuredCodexHome
    ? exactAbsolute(configuredCodexHome)
    : join(home, ".codex");
  const lifecyclePaths = captureAgentPaths({
    env: { ...env, COREDOC_HOME: coredocHome },
    homeDir: home,
  });
  return {
    ...lifecyclePaths,
    identityPath: join(lifecyclePaths.agentRoot, "installation.json"),
    codexIngressPath: join(lifecyclePaths.relayRoot, "codex-ingress.json"),
    purgePath: join(coredocHome, ".capture-agent-purge.json"),
    setupLockPath: join(coredocHome, ".capture-agent-setup.lock"),
    claudeSettingsPath: join(home, ".claude", "settings.json"),
    codexBaseConfigPath: join(codexHome, "config.toml"),
    codexProfilesHome: codexHome,
    codexHooksPath: join(codexHome, "hooks.json"),
    claimProgramPath: join(
      lifecyclePaths.currentPath,
      "scripts",
      "codex-session-claim.mjs",
    ),
  };
}

function identityBinding(value) {
  const candidate = exactObject(value, BINDING_FIELDS);
  if (
    typeof candidate.bindingId !== "string" ||
    !UUID_V4.test(candidate.bindingId) ||
    typeof candidate.bindingNonce !== "string" ||
    !LOCAL_TOKEN.test(candidate.bindingNonce)
  ) {
    fail("UNSAFE_STATE");
  }
  return Object.freeze({
    bindingId: candidate.bindingId.toLowerCase(),
    bindingNonce: candidate.bindingNonce,
  });
}

function repositoryIdentityEntry(value) {
  const candidate = exactObject(value, REPOSITORY_IDENTITY_FIELDS);
  const codex = exactObject(candidate.codex, REPOSITORY_CODEX_FIELDS);
  if (
    typeof candidate.repositoryKey !== "string" ||
    candidate.repositoryKey.length === 0 ||
    candidate.repositoryKey.length > 256 ||
    typeof candidate.repositoryScopeKey !== "string" ||
    !REPOSITORY_SCOPE_KEY.test(candidate.repositoryScopeKey) ||
    typeof candidate.serverOrigin !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    !UUID_V4.test(candidate.workspaceId) ||
    typeof codex.bindingId !== "string" ||
    !UUID_V4.test(codex.bindingId)
  ) {
    fail("UNSAFE_STATE");
  }
  return Object.freeze({
    path: exactAbsolute(candidate.path),
    repositoryKey: candidate.repositoryKey,
    repositoryScopeKey: candidate.repositoryScopeKey,
    serverOrigin: candidate.serverOrigin,
    workspaceId: candidate.workspaceId.toLowerCase(),
    claude: identityBinding(candidate.claude),
    codex: Object.freeze({ bindingId: codex.bindingId.toLowerCase() }),
  });
}

function identityObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("UNSAFE_STATE");
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (field) => !IDENTITY_FIELDS.has(field) && !IDENTITY_OPTIONAL_FIELDS.has(field),
    ) ||
    [...IDENTITY_FIELDS].some((field) => !Object.hasOwn(value, field))
  ) {
    fail("UNSAFE_STATE");
  }
  return value;
}

function installationIdentity(value, policy) {
  const candidate = identityObject(value);
  if (
    candidate.schemaVersion !== 1 ||
    candidate.marker !== IDENTITY_MARKER ||
    typeof candidate.serverOrigin !== "string" ||
    typeof candidate.workspaceId !== "string" ||
    typeof candidate.installationId !== "string" ||
    !UUID_V4.test(candidate.installationId)
  ) {
    fail("UNSAFE_STATE");
  }
  const storedPolicy = validateCaptureAgentPolicy({
    schemaVersion: 1,
    serverOrigin: candidate.serverOrigin,
    workspaceId: candidate.workspaceId,
  });
  if (
    policy &&
    (storedPolicy.serverOrigin !== policy.serverOrigin ||
      storedPolicy.workspaceId !== policy.workspaceId)
  ) {
    fail("POLICY_DRIFT");
  }
  const claude = identityBinding(candidate.claude);
  const codex = identityBinding(candidate.codex);
  if (candidate.repositories !== undefined && !Array.isArray(candidate.repositories)) {
    fail("UNSAFE_STATE");
  }
  const repositories = Object.freeze(
    (candidate.repositories ?? []).map(repositoryIdentityEntry),
  );
  const bindingIds = [
    candidate.installationId.toLowerCase(),
    claude.bindingId,
    codex.bindingId,
    ...repositories.flatMap((entry) => [entry.claude.bindingId, entry.codex.bindingId]),
  ];
  const claudeNonces = [
    claude.bindingNonce,
    ...repositories.map((entry) => entry.claude.bindingNonce),
  ];
  if (
    new Set(bindingIds).size !== bindingIds.length ||
    new Set(claudeNonces).size !== claudeNonces.length ||
    claudeNonces.includes(codex.bindingNonce) ||
    new Set(repositories.map(({ path }) => path)).size !== repositories.length ||
    new Set(repositories.map(({ repositoryScopeKey }) => repositoryScopeKey)).size !==
      repositories.length
  ) {
    fail("UNSAFE_STATE");
  }
  return Object.freeze({
    schemaVersion: 1,
    marker: IDENTITY_MARKER,
    serverOrigin: storedPolicy.serverOrigin,
    workspaceId: storedPolicy.workspaceId,
    installationId: candidate.installationId.toLowerCase(),
    claude,
    codex,
    repositories,
  });
}

function makeIdentity(policy, randomUUID, randomLocalToken) {
  return installationIdentity(
    {
      schemaVersion: 1,
      marker: IDENTITY_MARKER,
      serverOrigin: policy.serverOrigin,
      workspaceId: policy.workspaceId,
      installationId: randomUUID(),
      claude: {
        bindingId: randomUUID(),
        bindingNonce: randomLocalToken(),
      },
      codex: {
        bindingId: randomUUID(),
        bindingNonce: randomLocalToken(),
      },
    },
    policy,
  );
}

function identityDocument(identity) {
  const { repositories, ...rest } = identity;
  return `${JSON.stringify(
    repositories.length === 0 ? rest : { ...rest, repositories },
  )}\n`;
}

/**
 * Align the identity's listed-repository bindings with the active policy.
 * Existing entries keep their binding ids and nonces; a checkout that is no
 * longer listed (or moved to another destination) is dropped and a newly
 * listed one gets fresh bindings.
 */
function reconcileRepositories(identity, policy, randomUUID, randomLocalToken) {
  const repositories = [];
  for (const destination of policy.destinations) {
    if (destination.default) continue;
    for (const path of destination.repositories) {
      const existing = identity.repositories.find(
        (entry) =>
          entry.path === path &&
          entry.serverOrigin === destination.serverOrigin &&
          entry.workspaceId === destination.workspaceId,
      );
      if (existing) {
        repositories.push(existing);
        continue;
      }
      let resolved;
      try {
        resolved = resolveRepositoryIdentity(path);
      } catch {
        fail("REPOSITORY_UNRESOLVED");
      }
      if (resolved?.normalizedRepositoryKey === undefined) {
        fail("REPOSITORY_UNRESOLVED");
      }
      repositories.push({
        path,
        repositoryKey: resolved.normalizedRepositoryKey,
        repositoryScopeKey: resolveRepositoryScopeKey(path),
        serverOrigin: destination.serverOrigin,
        workspaceId: destination.workspaceId,
        claude: { bindingId: randomUUID(), bindingNonce: randomLocalToken() },
        codex: { bindingId: randomUUID() },
      });
    }
  }
  const unchanged =
    repositories.length === identity.repositories.length &&
    repositories.every((entry, index) => entry === identity.repositories[index]);
  if (unchanged) return identity;
  return installationIdentity({ ...identity, repositories }, policy);
}

function repositorySettingsPath(entry) {
  return join(entry.path, ".claude", "settings.local.json");
}

function repositorySettingsInstall(identity) {
  return identity.repositories.map((entry) => ({
    path: repositorySettingsPath(entry),
    ingressToken: entry.claude.bindingNonce,
    bindingId: entry.claude.bindingId,
    workspaceId: entry.workspaceId,
    repositoryKey: entry.repositoryKey,
  }));
}

function repositorySettingsRemoval(identity) {
  return identity.repositories.map((entry) => ({
    path: repositorySettingsPath(entry),
  }));
}

/** Every destination the identity is bound to, default first, deduplicated. */
function identityDestinations(identity) {
  const seen = new Map();
  for (const entry of [identity, ...identity.repositories]) {
    const key = destinationKey(entry);
    if (!seen.has(key)) {
      seen.set(key, { serverOrigin: entry.serverOrigin, workspaceId: entry.workspaceId });
    }
  }
  return seen;
}

async function safeDirectory(path, fs, uid, { create = false } = {}) {
  if (create) await fs.mkdir(path, { recursive: true, mode: 0o700 });
  let metadata;
  try {
    metadata = await fs.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    fail("UNSAFE_STATE");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    (Number.isInteger(uid) && uid >= 0 && metadata.uid !== uid)
  ) {
    fail("UNSAFE_STATE");
  }
  return true;
}

async function safeSnapshot(path, fs, uid, { strictMode = true } = {}) {
  exactAbsolute(path);
  let metadata;
  try {
    metadata = await fs.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, content: "", mode: undefined };
    }
    fail("UNSAFE_STATE");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_STATE_BYTES ||
    (strictMode && (metadata.mode & 0o777) !== 0o600) ||
    (Number.isInteger(uid) && uid >= 0 && metadata.uid !== uid)
  ) {
    fail("UNSAFE_STATE");
  }
  let content;
  try {
    content = await fs.readFile(path, "utf8");
  } catch {
    fail("UNSAFE_STATE");
  }
  return { exists: true, content, mode: metadata.mode & 0o777 };
}

async function diagnosticSnapshot(path, fs, uid) {
  try {
    return { snapshot: await safeSnapshot(path, fs, uid), conflict: false };
  } catch {
    // Status and doctor are read-only diagnostics. Preserve unsafe state and
    // expose only a bounded conflict instead of failing before the report.
    return { snapshot: null, conflict: true };
  }
}

function sameSnapshot(left, right) {
  return (
    left.exists === right.exists &&
    left.content === right.content &&
    left.mode === right.mode
  );
}

async function ensureSnapshot(path, expected, fs, uid) {
  const current = await safeSnapshot(path, fs, uid);
  if (!sameSnapshot(current, expected)) fail("CONFIG_CONFLICT");
}

async function atomicWrite(path, content, expected, fs, uid) {
  await ensureSnapshot(path, expected, fs, uid);
  await safeDirectory(dirname(path), fs, uid, { create: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.chmod(temporary, 0o600);
    await ensureSnapshot(path, expected, fs, uid);
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    if (error instanceof CaptureAgentSetupError) throw error;
    fail("UNSAFE_STATE");
  }
}

async function syncPath(path, fs) {
  let handle;
  try {
    handle = await fs.open(path, "r");
    await handle.sync();
  } catch {
    fail("WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function durableAtomicWrite(path, content, expected, fs, uid) {
  await atomicWrite(path, content, expected, fs, uid);
  await syncPath(path, fs);
  await syncPath(dirname(path), fs);
}

function purgeLifecycleProof(value) {
  if (value === null) return null;
  const candidate = exactObject(
    value,
    new Set(["schemaVersion", "stateSha256", "launchAgentSha256"]),
  );
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.stateSha256 !== "string" ||
    !SHA256_RE.test(candidate.stateSha256) ||
    typeof candidate.launchAgentSha256 !== "string" ||
    !SHA256_RE.test(candidate.launchAgentSha256)
  ) {
    fail("UNSAFE_STATE");
  }
  return { ...candidate };
}

function purgeRecord(value) {
  const candidate = exactObject(
    value,
    new Set([
      "schemaVersion",
      "marker",
      "phase",
      "serverOrigin",
      "workspaceId",
      "installationId",
      "identitySha256",
      "relaySha256",
      "codexIngressSha256",
      "lifecycleProof",
    ]),
  );
  const policy = validateCaptureAgentPolicy({
    schemaVersion: 1,
    serverOrigin: candidate.serverOrigin,
    workspaceId: candidate.workspaceId,
  });
  if (
    candidate.schemaVersion !== 1 ||
    candidate.marker !== PURGE_MARKER ||
    candidate.phase !== "revoked" ||
    typeof candidate.installationId !== "string" ||
    !UUID_V4.test(candidate.installationId) ||
    !SHA256_RE.test(candidate.identitySha256) ||
    !SHA256_RE.test(candidate.relaySha256) ||
    !SHA256_RE.test(candidate.codexIngressSha256)
  ) {
    fail("UNSAFE_STATE");
  }
  return Object.freeze({
    schemaVersion: 1,
    marker: PURGE_MARKER,
    phase: "revoked",
    serverOrigin: policy.serverOrigin,
    workspaceId: policy.workspaceId,
    installationId: candidate.installationId.toLowerCase(),
    identitySha256: candidate.identitySha256,
    relaySha256: candidate.relaySha256,
    codexIngressSha256: candidate.codexIngressSha256,
    lifecycleProof: purgeLifecycleProof(candidate.lifecycleProof),
  });
}

async function readPurgeRecord(paths, fs, uid) {
  const snapshot = await safeSnapshot(paths.purgePath, fs, uid);
  if (!snapshot.exists) return null;
  try {
    return purgeRecord(JSON.parse(snapshot.content));
  } catch (error) {
    if (error instanceof CaptureAgentSetupError) throw error;
    fail("UNSAFE_STATE");
  }
}

function stateTransaction(plans, fs, uid) {
  let state = "prepared";
  return {
    async apply() {
      if (state !== "prepared") fail("UNSAFE_STATE");
      const applied = [];
      try {
        for (const plan of plans) {
          if (!plan.changed) continue;
          await atomicWrite(plan.path, plan.after.content, plan.before, fs, uid);
          applied.push(plan);
        }
        state = "applied";
      } catch (error) {
        for (const plan of applied.reverse()) {
          if (plan.before.exists) {
            await atomicWrite(
              plan.path,
              plan.before.content,
              plan.after,
              fs,
              uid,
            );
          } else {
            await ensureSnapshot(plan.path, plan.after, fs, uid);
            await fs.unlink(plan.path);
          }
        }
        state = "rolled-back";
        throw error;
      }
    },
    async rollback() {
      if (state === "prepared") {
        state = "rolled-back";
        return;
      }
      if (state === "rolled-back") return;
      if (state !== "applied") fail("ROLLBACK_FAILED");
      for (const plan of plans.filter(({ changed }) => changed).reverse()) {
        await ensureSnapshot(plan.path, plan.after, fs, uid);
      }
      for (const plan of plans.filter(({ changed }) => changed).reverse()) {
        if (plan.before.exists) {
          await atomicWrite(
            plan.path,
            plan.before.content,
            plan.after,
            fs,
            uid,
          );
        } else {
          await fs.unlink(plan.path).catch(() => fail("ROLLBACK_FAILED"));
        }
      }
      state = "rolled-back";
    },
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function forwardEndpoints(policy) {
  const base = `${policy.serverOrigin}/api/v1/workspaces/${policy.workspaceId}`;
  return {
    nativeForwardEndpoint: `${base}/otel/v1/logs`,
    captureForwardEndpoint: `${base}/capture/v1/events`,
  };
}

function workspaceBinding(host, identity, policy, cloudToken) {
  const local = host === "claude-code" ? identity.claude : identity.codex;
  return {
    schemaVersion: 1,
    bindingId: local.bindingId,
    bindingNonceHash: sha256(local.bindingNonce),
    host,
    workspaceId: policy.workspaceId,
    workspaceMode: true,
    ...forwardEndpoints(policy),
    cloudAuthorization: `Bearer ${cloudToken}`,
  };
}

function repositoryBinding(host, identity, entry, cloudToken) {
  const local = host === "claude-code" ? entry.claude : entry.codex;
  return {
    schemaVersion: 1,
    bindingId: local.bindingId,
    bindingNonceHash: sha256(
      host === "claude-code" ? entry.claude.bindingNonce : identity.codex.bindingNonce,
    ),
    host,
    workspaceId: entry.workspaceId,
    repositoryKey: entry.repositoryKey,
    ...(host === "codex"
      ? { repositoryScopeKey: entry.repositoryScopeKey, profileName: null }
      : {}),
    ...forwardEndpoints(entry),
    cloudAuthorization: `Bearer ${cloudToken}`,
  };
}

function credentialToken(credentials, entry) {
  const token = credentials.get(destinationKey(entry))?.token;
  if (typeof token !== "string" || !CLOUD_TOKEN.test(token)) {
    fail("UNSAFE_STATE");
  }
  return token;
}

function buildRelayConfig({ identity, credentials }) {
  const defaultToken = credentialToken(credentials, identity);
  return managedRelayConfig({
    schemaVersion: 1,
    bindings: [
      workspaceBinding("claude-code", identity, identity, defaultToken),
      workspaceBinding("codex", identity, identity, defaultToken),
      ...identity.repositories.flatMap((entry) => {
        const token = credentialToken(credentials, entry);
        return [
          repositoryBinding("claude-code", identity, entry, token),
          repositoryBinding("codex", identity, entry, token),
        ];
      }),
    ],
  });
}

/**
 * Every binding in the persisted relay config must be one this identity
 * created; the two default workspace bindings must be present. Listed
 * repositories that the identity gained since the config was written are
 * allowed to be absent (setup adds them). Returns one cloud token per
 * destination the config carries.
 */
function ownedRelayConfig(value, identity) {
  let config;
  try {
    config = managedRelayConfig(value);
  } catch {
    fail("OWNERSHIP_CONFLICT");
  }
  // Build the expected bindings through the relay's own normalizer so the
  // comparison below is independent of key order.
  const placeholder = `cdt_${"0".repeat(64)}`;
  const keys = new Map([
    [identity.claude.bindingId, destinationKey(identity)],
    [identity.codex.bindingId, destinationKey(identity)],
    ...identity.repositories.flatMap((entry) => [
      [entry.claude.bindingId, destinationKey(entry)],
      [entry.codex.bindingId, destinationKey(entry)],
    ]),
  ]);
  const expected = new Map(
    managedRelayConfig({
      schemaVersion: 1,
      bindings: [
        workspaceBinding("claude-code", identity, identity, placeholder),
        workspaceBinding("codex", identity, identity, placeholder),
        ...identity.repositories.flatMap((entry) => [
          repositoryBinding("claude-code", identity, entry, placeholder),
          repositoryBinding("codex", identity, entry, placeholder),
        ]),
      ],
    }).bindings.map((binding) => [
      binding.bindingId,
      { binding, key: keys.get(binding.bindingId) },
    ]),
  );
  const authorizations = new Map();
  for (const binding of config.bindings) {
    const match = expected.get(binding.bindingId);
    if (match === undefined) fail("OWNERSHIP_CONFLICT");
    const { cloudAuthorization, ...actual } = binding;
    const { cloudAuthorization: _ignored, ...wanted } = match.binding;
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      fail("OWNERSHIP_CONFLICT");
    }
    const known = authorizations.get(match.key);
    if (known !== undefined && known !== cloudAuthorization) {
      fail("OWNERSHIP_CONFLICT");
    }
    authorizations.set(match.key, cloudAuthorization);
  }
  const present = new Set(config.bindings.map(({ bindingId }) => bindingId));
  if (!present.has(identity.claude.bindingId) || !present.has(identity.codex.bindingId)) {
    fail("OWNERSHIP_CONFLICT");
  }
  const tokens = new Map();
  for (const [key, authorization] of authorizations) {
    const token = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : "";
    if (!CLOUD_TOKEN.test(token)) fail("OWNERSHIP_CONFLICT");
    tokens.set(key, token);
  }
  return { config, token: tokens.get(destinationKey(identity)), tokens };
}

async function profileConfigPaths(paths, fs) {
  let entries;
  try {
    entries = await fs.readdir(paths.codexProfilesHome, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [paths.codexBaseConfigPath];
    fail("UNSAFE_STATE");
  }
  const profiles = entries
    .filter(
      (entry) => PROFILE_FILE.test(entry.name) && (entry.isFile() || entry.isSymbolicLink()),
    )
    .map(({ name }) => join(paths.codexProfilesHome, name))
    .sort();
  return [paths.codexBaseConfigPath, ...profiles];
}

async function probeCloudCredential({
  policy,
  token,
  fetchImpl,
  requestTimeoutMs,
  createRequestSignal,
  distinguishAuthRejection = false,
}) {
  if (!CLOUD_TOKEN.test(token)) fail("CLOUD_HEALTH_MISMATCH");
  let response;
  try {
    const signal = createRequestSignal(requestTimeoutMs);
    if (
      signal === null ||
      typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function"
    ) {
      fail("CLOUD_HEALTH_MISMATCH");
    }
    response = await fetchImpl(
      `${policy.serverOrigin}/api/v1/workspaces/${policy.workspaceId}/capture/v1/probe`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        redirect: "error",
        body: "{}",
        signal,
      },
    );
  } catch {
    fail("CLOUD_HEALTH_MISMATCH");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    if (
      distinguishAuthRejection &&
      (response.status === 401 || response.status === 403)
    ) {
      fail("CLOUD_AUTH_REJECTED");
    }
    fail("CLOUD_HEALTH_MISMATCH");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    fail("CLOUD_HEALTH_MISMATCH");
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    payload.status !== "ready"
  ) {
    fail("CLOUD_HEALTH_MISMATCH");
  }
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function withSetupLock(paths, operation, {
  fs,
  uid,
  processAlive,
  randomLockToken,
}) {
  await safeDirectory(paths.coredocHome, fs, uid, { create: true });
  const token = randomLockToken();
  if (!LOCAL_TOKEN.test(token)) fail("UNSAFE_STATE");
  const content = `${JSON.stringify({
    schemaVersion: 1,
    marker: LOCK_MARKER,
    pid: process.pid,
    token,
  })}\n`;
  let acquired = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.writeFile(paths.setupLockPath, content, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.chmod(paths.setupLockPath, 0o600);
      acquired = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") fail("UNSAFE_STATE");
      const snapshot = await safeSnapshot(paths.setupLockPath, fs, uid);
      let lock;
      try {
        lock = JSON.parse(snapshot.content);
      } catch {
        fail("LOCKED");
      }
      if (
        lock?.schemaVersion !== 1 ||
        lock?.marker !== LOCK_MARKER ||
        !Number.isSafeInteger(lock?.pid) ||
        typeof lock?.token !== "string" ||
        !LOCAL_TOKEN.test(lock.token) ||
        processAlive(lock.pid)
      ) {
        fail("LOCKED");
      }
      await ensureSnapshot(paths.setupLockPath, snapshot, fs, uid);
      await fs.unlink(paths.setupLockPath).catch(() => fail("LOCKED"));
    }
  }
  if (!acquired) fail("LOCKED");
  try {
    return await operation();
  } finally {
    const current = await safeSnapshot(paths.setupLockPath, fs, uid).catch(
      () => undefined,
    );
    if (current?.exists && current.content === content) {
      await fs.unlink(paths.setupLockPath).catch(() => undefined);
    }
  }
}

function transactionPlan(path, before, content) {
  const after = { exists: true, content, mode: 0o600 };
  return {
    path,
    before,
    after,
    changed: !sameSnapshot(before, after),
  };
}

async function readIdentity(snapshot, policy) {
  if (!snapshot.exists) return null;
  let parsed;
  try {
    parsed = JSON.parse(snapshot.content);
  } catch {
    fail("UNSAFE_STATE");
  }
  return installationIdentity(parsed, policy);
}

async function readRelay(snapshot) {
  if (!snapshot.exists) return null;
  try {
    return managedRelayConfig(JSON.parse(snapshot.content));
  } catch {
    fail("OWNERSHIP_CONFLICT");
  }
}

function readCodexIngress(snapshot) {
  if (!snapshot.exists) return null;
  let value;
  try {
    value = JSON.parse(snapshot.content);
  } catch {
    fail("OWNERSHIP_CONFLICT");
  }
  exactObject(value, new Set(["schemaVersion", "token"]), "OWNERSHIP_CONFLICT");
  if (value.schemaVersion !== 1 || !LOCAL_TOKEN.test(value.token)) {
    fail("OWNERSHIP_CONFLICT");
  }
  return value.token;
}

function validateCodexIngressOwnership({ snapshot, identity }) {
  const token = readCodexIngress(snapshot);
  if (token === null) return;
  if (identity === null || token !== identity.codex.bindingNonce) {
    fail("OWNERSHIP_CONFLICT");
  }
}

export function createCaptureAgentSetup({
  env = process.env,
  homeDir = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(),
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  fileSystem: fs = defaultFileSystem,
  loadPolicy,
  lifecycle,
  enrollment = enrollCaptureAgent,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  createRequestSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  prepareHostConfig = prepareHostGlobalConfigTransaction,
  prepareHooksConfig = prepareCodexHooksTransaction,
  inspectHostConfig = inspectHostGlobalConfig,
  randomUUID = nodeRandomUUID,
  randomLocalToken = () => randomBytes(32).toString("base64url"),
  randomLockToken = () => randomBytes(32).toString("base64url"),
  processAlive = defaultProcessAlive,
  runtimeExecutablePath,
} = {}) {
  if (
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > MAX_REQUEST_TIMEOUT_MS ||
    typeof createRequestSignal !== "function"
  ) {
    fail("INVALID_ARGUMENTS");
  }
  const paths = captureAgentSetupPaths({ env, homeDir });
  const activeRuntimeExecutablePath =
    runtimeExecutablePath ?? paths.runtimeExecutablePath;
  const activeLoadPolicy =
    loadPolicy ??
    (() =>
      loadCaptureAgentPolicy({
        path: captureAgentPolicyPath({ env, homeDir: paths.homeDir }),
        uid,
      }));
  const activeLifecycle =
    lifecycle ?? createCaptureAgentLifecycle({ env, homeDir: paths.homeDir });

  // Re-validating the loaded value keeps injected test policies (plain
  // schema-1 objects) on the same normalized shape as a loaded file.
  async function activePolicy() {
    return validateCaptureAgentPolicy(await activeLoadPolicy());
  }

  // Probe every destination that has a token; a destination the persisted
  // relay does not carry a token for yet is skipped (setup adds it).
  async function probeDestinations(policy, tokens, options = {}) {
    for (const destination of policy.destinations) {
      const token = tokens.get(destinationKey(destination));
      if (token === undefined) {
        if (destination.default) fail("UNSAFE_STATE");
        continue;
      }
      await probeCloudCredential({
        policy: destinationPolicy(destination),
        token,
        fetchImpl,
        requestTimeoutMs,
        createRequestSignal,
        ...options,
      });
    }
  }

  function destinationsReport(policy, statuses = new Map()) {
    // Redacted: destination ids and counts only, never origins or workspace ids.
    return policy.destinations.map((destination) => ({
      id: destination.id,
      default: destination.default,
      repositories: destination.repositories.length,
      status: statuses.get(destinationKey(destination)) ?? "configured",
    }));
  }

  function identityDestinationsReport(identity) {
    return [...identityDestinations(identity)].map(([key]) => ({
      default: key === destinationKey(identity),
      repositories: identity.repositories.filter(
        (entry) => destinationKey(entry) === key,
      ).length,
    }));
  }

  async function compensateLifecycle(before, setupResult) {
    if (!setupResult) return;
    if (before.status === "not-installed") {
      await activeLifecycle.uninstall({ discardPending: false });
      return;
    }
    const runtimeChanged = before.runtime?.digest !== setupResult.current?.digest;
    if (runtimeChanged) {
      await activeLifecycle.rollback({ start: before.loaded !== false });
      return;
    }
    if (before.loaded === false) {
      await activeLifecycle.disable();
      return;
    }
    await activeLifecycle.setupRuntime();
  }

  async function performSetup({
    policy,
    identity,
    identityBefore,
    relayBefore,
    codexIngressBefore,
    credentials,
    droppedRepositories = [],
    lifecycleBefore,
    command,
  }) {
    let stateTx;
    let nativeTx;
    let hooksTx;
    let lifecycleResult;
    let hooksApplied = false;
    let nativeApplied = false;
    let stateApplied = false;
    let claims = "configured";
    try {
      const relayConfig = buildRelayConfig({ identity, credentials });
      stateTx = stateTransaction(
        [
          transactionPlan(
            paths.identityPath,
            identityBefore,
            identityDocument(identity),
          ),
          transactionPlan(
            paths.relayConfigPath,
            relayBefore,
            `${JSON.stringify(relayConfig)}\n`,
          ),
          transactionPlan(
            paths.codexIngressPath,
            codexIngressBefore,
            `${JSON.stringify({
              schemaVersion: 1,
              token: identity.codex.bindingNonce,
            })}\n`,
          ),
        ],
        fs,
        uid,
      );
      const codexConfigPaths = await profileConfigPaths(paths, fs);
      nativeTx = await prepareHostConfig({
        operation: "install",
        claudeSettingsPath: paths.claudeSettingsPath,
        codexConfigPaths,
        codexHooksPath: paths.codexHooksPath,
        includeCodexHooks: false,
        claudeIngressToken: identity.claude.bindingNonce,
        claudeBindingId: identity.claude.bindingId,
        workspaceId: policy.workspaceId,
        codexIngressToken: identity.codex.bindingNonce,
        claudeRepositorySettings: repositorySettingsInstall(identity),
        claudeRepositorySettingsRemovals: repositorySettingsRemoval({
          repositories: droppedRepositories,
        }),
      });
      try {
        hooksTx = await prepareHooksConfig({
          operation: "install",
          codexHooksPath: paths.codexHooksPath,
          runtimeExecutablePath: activeRuntimeExecutablePath,
          claimProgramPath: paths.claimProgramPath,
        });
      } catch (error) {
        if (error?.code === "CONFIG_CONFLICT") throw error;
        claims = "degraded";
      }
      await stateTx.apply();
      stateApplied = true;
      lifecycleResult = await activeLifecycle.setupRuntime();
      await nativeTx.apply();
      nativeApplied = true;
      if (hooksTx) {
        try {
          await hooksTx.apply();
          hooksApplied = true;
        } catch {
          claims = "degraded";
        }
      }
      const postStatus = await activeLifecycle.status();
      if (
        !new Set(["ready", "degraded"]).has(postStatus.status) ||
        !new Set(["ready", "degraded"]).has(postStatus.health) ||
        postStatus.listener !== "occupied" ||
        postStatus.launchAgent !== "plugin-v1" ||
        postStatus.desktopLaunchAgent !== "absent"
      ) {
        fail("HEALTH_MISMATCH");
      }
      await probeDestinations(
        policy,
        new Map([...credentials].map(([key, { token }]) => [key, token])),
      );
      return {
        schemaVersion: 1,
        command,
        status: postStatus.status,
        runtime: {
          version: lifecycleResult.current.version,
          digest: lifecycleResult.current.digest,
        },
        native: "ready",
        claims,
        destinations: destinationsReport(policy),
      };
    } catch (error) {
      const rollbackErrors = [];
      if (hooksApplied) {
        await hooksTx.rollback().catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      if (nativeApplied) {
        await nativeTx.rollback().catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      if (stateApplied) {
        await stateTx.rollback().catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      await compensateLifecycle(lifecycleBefore, lifecycleResult).catch((rollbackError) =>
        rollbackErrors.push(rollbackError),
      );
      for (const { session } of credentials.values()) {
        if (!session) continue;
        await session.revokeInstallationToken().catch((rollbackError) =>
          rollbackErrors.push(rollbackError),
        );
      }
      if (rollbackErrors.length > 0) {
        fail("ROLLBACK_FAILED", { rollback: "failed" });
      }
      const mapped = mappedError(error);
      mapped.rollback = "restored";
      throw mapped;
    }
  }

  async function setupCommand(command = "setup") {
    return withSetupLock(
      paths,
      async () => {
        await ensureNoPurgePending();
        const policy = await activePolicy();
        let identityBefore = await safeSnapshot(paths.identityPath, fs, uid);
        const relayBefore = await safeSnapshot(paths.relayConfigPath, fs, uid);
        const codexIngressBefore = await safeSnapshot(
          paths.codexIngressPath,
          fs,
          uid,
        );
        const existingIdentity = await readIdentity(identityBefore, policy);
        const lifecycleStatusBefore = await activeLifecycle.status();
        const desktopLaunchAgent =
          lifecycleStatusBefore.desktopLaunchAgent ??
          (lifecycleStatusBefore.launchAgent === "desktop-v1"
            ? "desktop-v1"
            : "absent");
        if (desktopLaunchAgent === "desktop-v1") {
          fail("LEGACY_DESKTOP_PRESENT");
        }
        if (desktopLaunchAgent !== "absent") fail("OWNERSHIP_CONFLICT");
        if (
          !new Set(["absent", "plugin-v1"]).has(
            lifecycleStatusBefore.launchAgent,
          )
        ) {
          fail("OWNERSHIP_CONFLICT");
        }
        let loaded = false;
        if (lifecycleStatusBefore.launchAgent === "plugin-v1") {
          const preflight = await activeLifecycle.preflightDisable();
          if (typeof preflight?.loaded !== "boolean") {
            fail("SUPERVISOR_UNAVAILABLE");
          }
          loaded = preflight.loaded;
        }
        const lifecycleBefore = { ...lifecycleStatusBefore, loaded };
        const codexConfigPaths = await profileConfigPaths(paths, fs);
        const hostBefore = await inspectHostConfig({
          claudeSettingsPath: paths.claudeSettingsPath,
          codexConfigPaths,
          codexHooksPath: paths.codexHooksPath,
        });
        const installableNativeStatus = new Set([
          "absent",
          "unconfigured",
          "managed",
        ]);
        if (
          !installableNativeStatus.has(hostBefore.claude) ||
          hostBefore.codex.some(
            (status) => !installableNativeStatus.has(status),
          ) ||
          new Set(["legacy", "partial"]).has(hostBefore.codexHooks)
        ) {
          fail("CONFIG_CONFLICT");
        }
        if (
          lifecycleBefore.loaded === false &&
          lifecycleBefore.listener === "occupied"
        ) {
          fail("FOREIGN_LISTENER");
        }
        if (lifecycleBefore.queueState === "unsafe") {
          fail("UNSAFE_STATE");
        }
        if (
          existingIdentity === null &&
          lifecycleBefore.queueState !== "empty"
        ) {
          fail("OWNERSHIP_CONFLICT");
        }
        const provisionalIdentity =
          existingIdentity !== null &&
          lifecycleBefore.launchAgent !== "plugin-v1" &&
          !relayBefore.exists &&
          !codexIngressBefore.exists;
        if (!existingIdentity && lifecycleBefore.launchAgent === "plugin-v1") {
          fail("OWNERSHIP_CONFLICT");
        }
        if (!existingIdentity && relayBefore.exists) {
          fail("OWNERSHIP_CONFLICT");
        }
        validateCodexIngressOwnership({
          snapshot: codexIngressBefore,
          identity: provisionalIdentity ? null : existingIdentity,
        });

        // The persisted relay must be owned by the identity that wrote it
        // (before this run adds or drops listed repositories).
        const ownedBefore =
          existingIdentity && relayBefore.exists
            ? ownedRelayConfig(await readRelay(relayBefore), existingIdentity)
            : null;
        const identity = reconcileRepositories(
          existingIdentity ?? makeIdentity(policy, randomUUID, randomLocalToken),
          policy,
          randomUUID,
          randomLocalToken,
        );
        if (existingIdentity === null) {
          await atomicWrite(
            paths.identityPath,
            identityDocument(identity),
            identityBefore,
            fs,
            uid,
          );
          identityBefore = await safeSnapshot(paths.identityPath, fs, uid);
        }

        // One cloud credential per destination: reuse a persisted token that
        // still authenticates, browser-enroll every other destination in
        // sequence, then commit once with the full set.
        const credentials = new Map();
        if (ownedBefore !== null) {
          for (const destination of policy.destinations) {
            const key = destinationKey(destination);
            const token = ownedBefore.tokens.get(key);
            if (token === undefined) continue;
            try {
              await probeCloudCredential({
                policy: destinationPolicy(destination),
                token,
                fetchImpl,
                requestTimeoutMs,
                createRequestSignal,
                distinguishAuthRejection: true,
              });
              credentials.set(key, { token, session: null });
            } catch (error) {
              if (error?.code !== "CLOUD_AUTH_REJECTED") throw error;
            }
          }
        }
        const pending = policy.destinations.filter(
          (destination) => !credentials.has(destinationKey(destination)),
        );
        const kept = new Set(identity.repositories.map(({ path }) => path));
        const droppedRepositories = (existingIdentity?.repositories ?? []).filter(
          ({ path }) => !kept.has(path),
        );
        const commit = () =>
          performSetup({
            policy,
            identity,
            identityBefore,
            relayBefore,
            codexIngressBefore,
            credentials,
            droppedRepositories,
            lifecycleBefore,
            command,
          });
        const enroll = (index) => {
          if (index === pending.length) return commit();
          const destination = pending[index];
          return enrollment({
            policy: destinationPolicy(destination),
            installationId: identity.installationId,
            requestTimeoutMs,
            createRequestSignal,
            completeEnrollment: async (session) => {
              credentials.set(destinationKey(destination), {
                token: session.installationToken.token,
                session,
              });
              try {
                return await enroll(index + 1);
              } catch (error) {
                // A later destination failed before setup committed. performSetup
                // revokes every minted token itself and reports a rollback state;
                // anything without one never reached performSetup, so this
                // level revokes its own token as the error unwinds.
                if (error?.rollback !== undefined) throw error;
                credentials.delete(destinationKey(destination));
                try {
                  await session.revokeInstallationToken();
                } catch {
                  fail("ROLLBACK_FAILED", { rollback: "failed" });
                }
                const mapped = mappedError(error);
                mapped.rollback = "restored";
                throw mapped;
              }
            },
          });
        };
        return enroll(0);
      },
      { fs, uid, processAlive, randomLockToken },
    );
  }

  async function status() {
    const purgePending = (await readPurgeRecord(paths, fs, uid)) !== null;
    const [identityFile, relayFile, codexIngressFile] = await Promise.all([
      diagnosticSnapshot(paths.identityPath, fs, uid),
      diagnosticSnapshot(paths.relayConfigPath, fs, uid),
      diagnosticSnapshot(paths.codexIngressPath, fs, uid),
    ]);
    let identity = null;
    let storedPolicy = null;
    let installation = identityFile.conflict ? "conflict" : "absent";
    if (identityFile.snapshot?.exists) {
      try {
        identity = await readIdentity(identityFile.snapshot);
        storedPolicy = validateCaptureAgentPolicy({
          schemaVersion: 1,
          serverOrigin: identity.serverOrigin,
          workspaceId: identity.workspaceId,
        });
        installation = "ready";
      } catch {
        identity = null;
        storedPolicy = null;
        installation = "conflict";
      }
    }
    let relay = relayFile.conflict ? "conflict" : "absent";
    if (relayFile.snapshot?.exists) {
      if (identity === null) {
        relay = "conflict";
      } else {
        try {
          ownedRelayConfig(await readRelay(relayFile.snapshot), identity);
          relay = "ready";
        } catch {
          relay = "conflict";
        }
      }
    }
    let codexIngress = codexIngressFile.conflict ? "conflict" : "absent";
    if (codexIngressFile.snapshot?.exists) {
      if (identity === null) {
        codexIngress = "conflict";
      } else {
        try {
          validateCodexIngressOwnership({
            snapshot: codexIngressFile.snapshot,
            identity,
          });
          codexIngress = "ready";
        } catch {
          codexIngress = "conflict";
        }
      }
    }
    const codexConfigPaths = await profileConfigPaths(paths, fs);
    const repositorySettingsPaths =
      identity === null
        ? []
        : identity.repositories.map(repositorySettingsPath);
    const [lifecycleStatus, host] = await Promise.all([
      activeLifecycle.status(),
      inspectHostConfig({
        claudeSettingsPath: paths.claudeSettingsPath,
        codexConfigPaths,
        codexHooksPath: paths.codexHooksPath,
        ...(repositorySettingsPaths.length === 0
          ? {}
          : { claudeRepositorySettingsPaths: repositorySettingsPaths }),
      }),
    ]);
    const claudeRepositories = host.claudeRepositories ?? [];
    const nativeReady =
      host.claude === "managed" &&
      host.codex.every((value) => value === "managed") &&
      claudeRepositories.every((value) => value === "managed");
    const desktopLaunchAgent =
      lifecycleStatus.desktopLaunchAgent ??
      (lifecycleStatus.launchAgent === "desktop-v1"
        ? "desktop-v1"
        : "absent");
    const degradedReasons = new Set(
      Array.isArray(lifecycleStatus.degradedReasons)
        ? lifecycleStatus.degradedReasons
        : [],
    );
    if (installation === "conflict") degradedReasons.add("INSTALLATION_CONFLICT");
    if (relay === "conflict") degradedReasons.add("RELAY_CONFLICT");
    if (codexIngress === "conflict") degradedReasons.add("CODEX_INGRESS_CONFLICT");
    if (desktopLaunchAgent === "desktop-v1") {
      degradedReasons.add("LEGACY_DESKTOP_PRESENT");
    }
    if (
      desktopLaunchAgent === "foreign" ||
      lifecycleStatus.launchAgent === "foreign"
    ) {
      degradedReasons.add("OWNERSHIP_CONFLICT");
    }
    if (
      lifecycleStatus.launchAgent === "absent" &&
      desktopLaunchAgent === "absent" &&
      lifecycleStatus.listener === "occupied"
    ) {
      degradedReasons.add("FOREIGN_LISTENER");
    }
    if (installation !== "ready" && lifecycleStatus.queueState !== "empty") {
      degradedReasons.add("ORPHANED_QUEUE_STATE");
    }
    const hasDiagnosticConflict = degradedReasons.size > 0;
    const hasBlockingDisabledState =
      installation !== "ready" ||
      relay !== "ready" ||
      codexIngress !== "ready" ||
      lifecycleStatus.queueState === "unsafe" ||
      degradedReasons.has("OWNERSHIP_CONFLICT");
    const disabled =
      lifecycleStatus.status !== "not-installed" &&
      lifecycleStatus.launchAgent === "plugin-v1" &&
      desktopLaunchAgent === "absent" &&
      !hasBlockingDisabledState &&
      !nativeReady &&
      lifecycleStatus.listener === "free";
    const ready =
      lifecycleStatus.status === "ready" &&
      lifecycleStatus.launchAgent === "plugin-v1" &&
      desktopLaunchAgent === "absent" &&
      !hasDiagnosticConflict &&
      installation === "ready" &&
      relay === "ready" &&
      codexIngress === "ready" &&
      nativeReady;
    const notInstalled =
      lifecycleStatus.status === "not-installed" &&
      lifecycleStatus.launchAgent === "absent" &&
      desktopLaunchAgent === "absent" &&
      lifecycleStatus.listener === "free" &&
      !hasDiagnosticConflict;
    return {
      schemaVersion: 1,
      command: "status",
      status: ready
        ? purgePending
          ? "degraded"
          : "ready"
        : disabled
          ? "disabled"
          : notInstalled
            ? "not-installed"
            : "degraded",
      runtime:
        lifecycleStatus.runtime === null
          ? null
          : {
              version: lifecycleStatus.runtime.version,
              digest: lifecycleStatus.runtime.digest,
            },
      installation,
      relay,
      codexIngress,
      native: {
        claude: host.claude,
        codex: host.codex,
        claudeRepositories,
      },
      destinations: identity === null ? [] : identityDestinationsReport(identity),
      claims:
        host.codexHooks === "managed"
          ? "configured"
          : host.codexHooks === "legacy"
            ? "legacy"
            : "degraded",
      launchAgent: lifecycleStatus.launchAgent,
      desktopLaunchAgent,
      listener: lifecycleStatus.listener,
      health: lifecycleStatus.health,
      pendingCount: lifecycleStatus.pendingCount,
      queueState: lifecycleStatus.queueState ?? "unknown",
      degradedReasons: [...degradedReasons].sort(),
      purge: purgePending ? "pending" : "none",
    };
  }

  async function doctor() {
    const result = await status();
    let cloud = "not-configured";
    let policyCheck = result.installation === "ready" ? "unavailable" : "not-configured";
    const destinationStatuses = new Map();
    let policy = null;
    if (result.installation === "ready" && result.relay === "ready") {
      let owned = null;
      try {
        policy = await activePolicy();
        const identitySnapshot = await safeSnapshot(paths.identityPath, fs, uid);
        const relaySnapshot = await safeSnapshot(paths.relayConfigPath, fs, uid);
        const identity = await readIdentity(identitySnapshot, policy);
        owned = ownedRelayConfig(await readRelay(relaySnapshot), identity);
        policyCheck = "ready";
      } catch (error) {
        policyCheck = error?.code === "POLICY_DRIFT" ? "drift" : "unavailable";
        cloud = "unavailable";
      }
      if (owned !== null) {
        cloud = "ready";
        for (const destination of policy.destinations) {
          const key = destinationKey(destination);
          const token = owned.tokens.get(key);
          let state = "not-configured";
          if (token !== undefined) {
            try {
              await probeCloudCredential({
                policy: destinationPolicy(destination),
                token,
                fetchImpl,
                requestTimeoutMs,
                createRequestSignal,
                distinguishAuthRejection: true,
              });
              state = "ready";
            } catch (error) {
              state =
                error?.code === "CLOUD_AUTH_REJECTED"
                  ? "auth-rejected"
                  : "unavailable";
            }
          }
          destinationStatuses.set(key, state);
          if (state !== "ready" && cloud === "ready") cloud = state;
        }
      }
    }
    return {
      ...result,
      ...(policy === null
        ? {}
        : { destinations: destinationsReport(policy, destinationStatuses) }),
      command: "doctor",
      checks: {
        policy: policyCheck,
        installation: result.installation,
        relay: result.relay,
        native: result.status === "ready" ? "ready" : "review",
        claims: result.claims,
        cloud,
      },
    };
  }

  async function ownedLocalState({ requirePolicy = true } = {}) {
    const identityBefore = await safeSnapshot(paths.identityPath, fs, uid);
    const relayBefore = await safeSnapshot(paths.relayConfigPath, fs, uid);
    const codexIngressBefore = await safeSnapshot(
      paths.codexIngressPath,
      fs,
      uid,
    );
    const storedIdentity = await readIdentity(identityBefore);
    const policy = requirePolicy
      ? await activePolicy()
      : storedIdentity
        ? validateCaptureAgentPolicy({
            schemaVersion: 1,
            serverOrigin: storedIdentity.serverOrigin,
            workspaceId: storedIdentity.workspaceId,
          })
        : null;
    const identity =
      storedIdentity && requirePolicy
        ? installationIdentity(storedIdentity, policy)
        : storedIdentity;
    if (
      identity === null ||
      !relayBefore.exists ||
      !codexIngressBefore.exists
    ) {
      fail("NOT_INSTALLED");
    }
    const owned = ownedRelayConfig(await readRelay(relayBefore), identity);
    validateCodexIngressOwnership({
      snapshot: codexIngressBefore,
      identity,
    });
    return {
      policy,
      identity,
      token: owned.token,
      tokens: owned.tokens,
      snapshots: { identityBefore, relayBefore, codexIngressBefore },
    };
  }

  async function prepareHostRemoval(identity, { strictHooks = false } = {}) {
    const codexConfigPaths = await profileConfigPaths(paths, fs);
    const native = await prepareHostConfig({
      operation: "uninstall",
      claudeSettingsPath: paths.claudeSettingsPath,
      codexConfigPaths,
      codexHooksPath: paths.codexHooksPath,
      includeCodexHooks: false,
      claudeRepositorySettings: repositorySettingsRemoval(identity),
    });
    let hooks = null;
    try {
      hooks = await prepareHooksConfig({
        operation: "uninstall",
        codexHooksPath: paths.codexHooksPath,
      });
    } catch (error) {
      if (strictHooks) throw error;
    }
    return { native, hooks, strictHooks };
  }

  async function applyHostRemoval(transactions) {
    let nativeApplied = false;
    let hooksApplied = false;
    try {
      await transactions.native.apply();
      nativeApplied = true;
      if (transactions.hooks) {
        try {
          await transactions.hooks.apply();
          hooksApplied = true;
        } catch (error) {
          if (transactions.strictHooks) throw error;
        }
      }
    } catch (error) {
      if (nativeApplied) {
        await transactions.native
          .rollback()
          .catch(() => fail("ROLLBACK_FAILED"));
      }
      throw error;
    }
    return {
      claims: hooksApplied ? "removed" : "degraded",
      async rollback() {
        const errors = [];
        if (hooksApplied) {
          await transactions.hooks
            .rollback()
            .catch((error) => errors.push(error));
        }
        if (nativeApplied) {
          await transactions.native
            .rollback()
            .catch((error) => errors.push(error));
        }
        if (errors.length > 0) fail("ROLLBACK_FAILED");
      },
    };
  }

  async function upgrade() {
    return withSetupLock(
      paths,
      async () => {
        await ensureNoPurgePending();
        const local = await ownedLocalState();
        const before = await activeLifecycle.status();
        if (before.launchAgent !== "plugin-v1") fail("NOT_INSTALLED");
        await probeDestinations(local.policy, local.tokens, {
          distinguishAuthRejection: true,
        });
        const result = await activeLifecycle.upgrade();
        const after = await activeLifecycle.status();
        if (
          !new Set(["ready", "degraded"]).has(after.status) ||
          !new Set(["ready", "degraded"]).has(after.health) ||
          after.listener !== "occupied"
        ) {
          fail("HEALTH_MISMATCH");
        }
        await probeDestinations(local.policy, local.tokens);
        return {
          schemaVersion: 1,
          command: "upgrade",
          status: after.status,
          runtime: {
            version: result.current.version,
            digest: result.current.digest,
          },
          native: "ready",
          claims: "unchanged",
        };
      },
      { fs, uid, processAlive, randomLockToken },
    );
  }

  async function disable() {
    return withSetupLock(
      paths,
      async () => {
        await ensureNoPurgePending();
        const local = await ownedLocalState({ requirePolicy: false });
        const lifecycleStatus = await activeLifecycle.status();
        if (lifecycleStatus.launchAgent !== "plugin-v1") fail("NOT_INSTALLED");
        const lifecycleBefore = await activeLifecycle.preflightDisable();
        const transactions = await prepareHostRemoval(local.identity);
        const host = await applyHostRemoval(transactions);
        let disabled;
        try {
          disabled = await activeLifecycle.disable();
        } catch {
          if (lifecycleBefore.loaded) {
            await activeLifecycle.startInstalledRuntime().catch(() =>
              fail("ROLLBACK_FAILED"),
            );
          }
          await host.rollback().catch(() => fail("ROLLBACK_FAILED"));
          fail("SUPERVISOR_UNAVAILABLE", { rollback: "restored" });
        }
        return {
          schemaVersion: 1,
          command: "disable",
          status: "disabled",
          preservedConfig: true,
          preservedPending: disabled.preservedPending,
          claims: host.claims,
        };
      },
      { fs, uid, processAlive, randomLockToken },
    );
  }

  async function uninstallLocal(identity) {
    const preflight = await activeLifecycle.preflightUninstall({
      discardPending: false,
    });
    const host = await applyHostRemoval(
      await prepareHostRemoval(identity, { strictHooks: true }),
    );
    let lifecycleResult;
    try {
      lifecycleResult = await activeLifecycle.uninstall({
        discardPending: false,
      });
    } catch (error) {
      const rollbackErrors = [];
      try {
        const after = await activeLifecycle.preflightUninstall({
          discardPending: false,
        });
        if (!after.installed || after.partial) fail("UNINSTALL_INCOMPLETE");
        if (preflight.loaded) await activeLifecycle.startInstalledRuntime();
        await host.rollback();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (rollbackErrors.length > 0) fail("UNINSTALL_INCOMPLETE");
      const mapped = mappedError(error);
      mapped.rollback = "restored";
      throw mapped;
    }
    return {
      schemaVersion: 1,
      command: "uninstall",
      status: "uninstalled",
      preservedConfig: true,
      preservedPending: lifecycleResult.preservedPending,
      discardedPending: lifecycleResult.discardedPending,
      claims: host.claims,
    };
  }

  async function ensureNoPurgePending() {
    if ((await readPurgeRecord(paths, fs, uid)) !== null) {
      fail("PURGE_INCOMPLETE");
    }
  }

  async function writeConfirmedPurgeRecord(local, lifecycleProof) {
    const before = await safeSnapshot(paths.purgePath, fs, uid);
    if (before.exists) fail("PURGE_INCOMPLETE");
    const record = purgeRecord({
      schemaVersion: 1,
      marker: PURGE_MARKER,
      phase: "revoked",
      serverOrigin: local.policy.serverOrigin,
      workspaceId: local.policy.workspaceId,
      installationId: local.identity.installationId,
      identitySha256: sha256(local.snapshots.identityBefore.content),
      relaySha256: sha256(local.snapshots.relayBefore.content),
      codexIngressSha256: sha256(local.snapshots.codexIngressBefore.content),
      lifecycleProof,
    });
    await durableAtomicWrite(
      paths.purgePath,
      `${JSON.stringify(record)}\n`,
      before,
      fs,
      uid,
    );
    return record;
  }

  async function validatePurgeCredential(path, expectedHash) {
    const snapshot = await safeSnapshot(path, fs, uid);
    if (snapshot.exists && sha256(snapshot.content) !== expectedHash) {
      fail("OWNERSHIP_CONFLICT");
    }
    return snapshot;
  }

  async function validateAllPurgeCredentials(record) {
    return Promise.all([
      validatePurgeCredential(paths.identityPath, record.identitySha256),
      validatePurgeCredential(paths.relayConfigPath, record.relaySha256),
      validatePurgeCredential(paths.codexIngressPath, record.codexIngressSha256),
    ]);
  }

  async function removePurgeCredentials(record) {
    const entries = [
      [paths.identityPath, record.identitySha256],
      [paths.relayConfigPath, record.relaySha256],
      [paths.codexIngressPath, record.codexIngressSha256],
    ];
    const snapshots = [];
    for (const [path, expectedHash] of entries) {
      snapshots.push([
        path,
        expectedHash,
        await validatePurgeCredential(path, expectedHash),
      ]);
    }
    for (const [path, expectedHash, snapshot] of snapshots) {
      if (!snapshot.exists) continue;
      await validatePurgeCredential(path, expectedHash);
      await fs.unlink(path).catch(() => fail("PURGE_INCOMPLETE"));
    }
  }

  async function assertHostIntegrationAbsent() {
    const codexConfigPaths = await profileConfigPaths(paths, fs);
    const host = await inspectHostConfig({
      claudeSettingsPath: paths.claudeSettingsPath,
      codexConfigPaths,
      codexHooksPath: paths.codexHooksPath,
    });
    const nativeAbsent = new Set(["absent", "unconfigured", "unmanaged"]);
    const hooksAbsent = new Set(["absent", "unconfigured"]);
    if (
      !nativeAbsent.has(host.claude) ||
      host.codex.some((value) => !nativeAbsent.has(value)) ||
      !hooksAbsent.has(host.codexHooks)
    ) {
      fail("PURGE_INCOMPLETE");
    }
  }

  async function syncHostConfiguration() {
    const codexConfigPaths = await profileConfigPaths(paths, fs);
    for (const path of new Set([
      paths.claudeSettingsPath,
      ...codexConfigPaths,
      paths.codexHooksPath,
    ])) {
      const snapshot = await safeSnapshot(path, fs, uid, {
        strictMode: false,
      });
      if (snapshot.exists) await syncPath(path, fs);
      const parent = dirname(path);
      if (await safeDirectory(parent, fs, uid)) await syncPath(parent, fs);
    }
  }

  async function finishConfirmedPurge(record, claims) {
    const lifecycleOptions = {
      discardPending: true,
      ...(record.lifecycleProof === null
        ? {}
        : { purgeProof: record.lifecycleProof }),
    };
    await validateAllPurgeCredentials(record);
    await assertHostIntegrationAbsent();
    await activeLifecycle.preflightUninstall(lifecycleOptions);
    const lifecycleResult = await activeLifecycle.uninstall(lifecycleOptions);
    await removePurgeCredentials(record);
    await assertHostIntegrationAbsent();
    for (const [path, expectedHash] of [
      [paths.identityPath, record.identitySha256],
      [paths.relayConfigPath, record.relaySha256],
      [paths.codexIngressPath, record.codexIngressSha256],
    ]) {
      const snapshot = await validatePurgeCredential(path, expectedHash);
      if (snapshot.exists) fail("PURGE_INCOMPLETE");
    }
    await syncHostConfiguration();
    for (const directory of new Set([
      paths.coredocHome,
      paths.agentRoot,
      paths.relayRoot,
      dirname(paths.launchAgentPath),
    ])) {
      if (await safeDirectory(directory, fs, uid)) {
        await syncPath(directory, fs);
      }
    }
    const currentMarker = await readPurgeRecord(paths, fs, uid);
    if (JSON.stringify(currentMarker) !== JSON.stringify(record)) {
      fail("OWNERSHIP_CONFLICT");
    }
    await fs.unlink(paths.purgePath).catch(() => fail("PURGE_INCOMPLETE"));
    await syncPath(dirname(paths.purgePath), fs);
    return {
      schemaVersion: 1,
      command: "uninstall",
      status: "uninstalled",
      preservedConfig: false,
      preservedPending: lifecycleResult.preservedPending,
      discardedPending: lifecycleResult.discardedPending,
      claims,
    };
  }

  async function resumeConfirmedPurge(record) {
    const policy = await activeLoadPolicy();
    if (
      policy.serverOrigin !== record.serverOrigin ||
      policy.workspaceId !== record.workspaceId
    ) {
      fail("POLICY_DRIFT");
    }
    const identitySnapshot = await safeSnapshot(paths.identityPath, fs, uid);
    const identity = (await readIdentity(identitySnapshot)) ?? { repositories: [] };
    const host = await applyHostRemoval(
      await prepareHostRemoval(identity, { strictHooks: true }),
    );
    try {
      return await finishConfirmedPurge(record, host.claims);
    } catch {
      fail("PURGE_INCOMPLETE");
    }
  }

  async function purgeUninstall(local) {
    const transactions = await prepareHostRemoval(local.identity, { strictHooks: true });
    const preflight = await activeLifecycle.preflightUninstall({
      discardPending: true,
    });
    const host = await applyHostRemoval(transactions);

    const restoreBeforeRevoke = async (error) => {
      const rollbackErrors = [];
      if (preflight.loaded) {
        await activeLifecycle
          .startInstalledRuntime()
          .catch((rollbackError) => rollbackErrors.push(rollbackError));
      }
      await host
        .rollback()
        .catch((rollbackError) => rollbackErrors.push(rollbackError));
      if (rollbackErrors.length > 0) {
        fail("ROLLBACK_FAILED", { rollback: "failed" });
      }
      const mapped = mappedError(error);
      mapped.rollback = "restored";
      throw mapped;
    };

    try {
      if (preflight.installed) await activeLifecycle.disable();
      await activeLifecycle.preflightUninstall({
        discardPending: true,
        ...(preflight.purgeProof === null
          ? {}
          : { purgeProof: preflight.purgeProof }),
      });
    } catch (error) {
      return restoreBeforeRevoke(error);
    }

    let revocationState = "not-attempted";
    try {
      return await enrollment({
        policy: local.policy,
        installationId: local.identity.installationId,
        mintInstallationToken: false,
        requestTimeoutMs,
        createRequestSignal,
        completeEnrollment: async (session) => {
          const installationName = `capture-agent:${local.identity.installationId}`;
          const isPresent = (tokens) =>
            tokens.some((token) => token.name === installationName);
          if (isPresent(await session.listOwnedTelemetryTokens())) {
            revocationState = "attempted";
            try {
              await session.revokeInstallationToken();
              revocationState = "confirmed";
            } catch (error) {
              let stillPresent;
              try {
                stillPresent = isPresent(
                  await session.listOwnedTelemetryTokens(),
                );
              } catch {
                revocationState = "unconfirmed";
                fail("INSTALLATION_REVOKE_UNCONFIRMED");
              }
              if (stillPresent) {
                revocationState = "not-revoked";
                throw error;
              }
              revocationState = "confirmed";
            }
          } else {
            // The OAuth principal's owned-token list cannot prove global
            // absence when another member created the installation token, and
            // rejection of the retained bearer cannot exclude a newer token
            // committed during a lost rotation response. Only a durable local
            // revoked receipt may bypass this authoritative ownership check.
            revocationState = "unconfirmed";
            fail("INSTALLATION_REVOKE_UNCONFIRMED");
          }

          try {
            const record = await writeConfirmedPurgeRecord(
              local,
              preflight.purgeProof,
            );
            return await finishConfirmedPurge(record, host.claims);
          } catch {
            fail("PURGE_INCOMPLETE");
          }
        },
      });
    } catch (error) {
      if (
        revocationState === "confirmed" ||
        revocationState === "unconfirmed"
      ) {
        throw mappedError(error);
      }
      return restoreBeforeRevoke(error);
    }
  }

  async function uninstall({ purge = false } = {}) {
    if (typeof purge !== "boolean") fail("INVALID_ARGUMENTS");
    return withSetupLock(
      paths,
      async () => {
        const pending = await readPurgeRecord(paths, fs, uid);
        if (pending !== null) {
          if (!purge) fail("PURGE_INCOMPLETE");
          return resumeConfirmedPurge(pending);
        }
        const local = await ownedLocalState({ requirePolicy: purge });
        if (!purge) return uninstallLocal(local.identity);
        return purgeUninstall(local);
      },
      { fs, uid, processAlive, randomLockToken },
    );
  }

  return {
    setup: () => setupCommand("setup"),
    repair: () => setupCommand("repair"),
    status,
    doctor,
    upgrade,
    disable,
    uninstall,
  };
}

function cliArguments(args) {
  const command = args[0];
  if (
    !new Set([
      "setup",
      "status",
      "doctor",
      "repair",
      "upgrade",
      "disable",
      "uninstall",
    ]).has(command)
  ) {
    fail("INVALID_ARGUMENTS");
  }
  const flags = args.slice(1);
  if (
    (command !== "uninstall" && flags.length > 0) ||
    (command === "uninstall" &&
      (flags.length > 1 || (flags.length === 1 && flags[0] !== "--purge")))
  ) {
    fail("INVALID_ARGUMENTS");
  }
  return { command, purge: flags[0] === "--purge" };
}

export async function runCaptureAgentSetupCli({
  args = process.argv.slice(2),
  env = process.env,
  write = (value) => process.stdout.write(value),
  writeError = (value) => process.stderr.write(value),
  setup,
} = {}) {
  try {
    const parsed = cliArguments(args);
    const active = setup ?? createCaptureAgentSetup({ env });
    const result = await active[parsed.command](
      parsed.command === "uninstall" ? { purge: parsed.purge } : undefined,
    );
    write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const mapped = mappedError(error, "UNSAFE_STATE");
    writeError(
      `${JSON.stringify({
        schemaVersion: 1,
        status: "failed",
        code: mapped.code,
        ...(mapped.rollback === undefined ? {} : { rollback: mapped.rollback }),
      })}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCaptureAgentSetupCli();
}
