import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DESTINATION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const V1_FIELDS = new Set(["schemaVersion", "serverOrigin", "workspaceId"]);
const V2_FIELDS = new Set(["schemaVersion", "destinations"]);
const NORMALIZED_FIELDS = new Set([...V1_FIELDS, "destinations"]);
const DESTINATION_FIELDS = new Set([
  "id",
  "serverOrigin",
  "workspaceId",
  "default",
  "repositories",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const MAX_DESTINATIONS = 8;
const MAX_REPOSITORIES = 64;
const MAX_POLICY_BYTES = 16 * 1024;

export const CAPTURE_AGENT_POLICY_FILENAME = "capture-agent-policy.json";

export class CaptureAgentPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "CaptureAgentPolicyError";
    this.code = code;
  }
}

function fail(code) {
  throw new CaptureAgentPolicyError(code);
}

export function captureAgentPolicyPath({
  env = process.env,
  homeDir = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(),
} = {}) {
  if (typeof homeDir !== "string" || !isAbsolute(homeDir) || resolve(homeDir) !== homeDir) {
    fail("POLICY_UNSAFE");
  }
  const configuredRoot = env.COREDOC_HOME?.trim();
  if (configuredRoot && (!isAbsolute(configuredRoot) || resolve(configuredRoot) !== configuredRoot)) {
    fail("POLICY_UNSAFE");
  }
  const stateRoot = configuredRoot || join(homeDir, ".coredoc");
  return join(stateRoot, CAPTURE_AGENT_POLICY_FILENAME);
}

function exactObject(value, fields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("POLICY_INVALID");
  }
  const keys = Object.keys(value);
  if (keys.some((field) => !fields.has(field))) fail("POLICY_INVALID");
  return value;
}

// A canonical HTTPS origin anywhere, or HTTP on the loopback address only
// (`localhost` is not accepted: it may resolve off-host).
function canonicalOrigin(value) {
  if (typeof value !== "string") fail("POLICY_INVALID");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("POLICY_INVALID");
  }
  const loopbackHttp =
    parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== value
  ) {
    fail("POLICY_INVALID");
  }
  return parsed.origin;
}

function workspaceId(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail("POLICY_INVALID");
  return value.toLowerCase();
}

function repositoryPath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail("POLICY_INVALID");
  }
  return value;
}

function destination(value) {
  const candidate = exactObject(value, DESTINATION_FIELDS);
  if (typeof candidate.id !== "string" || !DESTINATION_ID.test(candidate.id)) {
    fail("POLICY_INVALID");
  }
  if (candidate.default !== undefined && candidate.default !== true) {
    fail("POLICY_INVALID");
  }
  const isDefault = candidate.default === true;
  if (isDefault && candidate.repositories !== undefined) fail("POLICY_INVALID");
  let repositories = [];
  if (!isDefault) {
    if (
      !Array.isArray(candidate.repositories) ||
      candidate.repositories.length === 0 ||
      candidate.repositories.length > MAX_REPOSITORIES
    ) {
      fail("POLICY_INVALID");
    }
    repositories = candidate.repositories.map(repositoryPath);
  }
  return Object.freeze({
    id: candidate.id,
    serverOrigin: canonicalOrigin(candidate.serverOrigin),
    workspaceId: workspaceId(candidate.workspaceId),
    default: isDefault,
    repositories: Object.freeze(repositories),
  });
}

function normalizedDestinations(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_DESTINATIONS) {
    fail("POLICY_INVALID");
  }
  const destinations = values.map(destination);
  const defaults = destinations.filter(({ default: isDefault }) => isDefault);
  if (defaults.length !== 1) fail("POLICY_INVALID");
  if (new Set(destinations.map(({ id }) => id)).size !== destinations.length) {
    fail("POLICY_INVALID");
  }
  if (new Set(destinations.map(destinationKey)).size !== destinations.length) {
    fail("POLICY_INVALID");
  }
  const repositories = destinations.flatMap(({ repositories: paths }) => paths);
  if (new Set(repositories).size !== repositories.length) fail("POLICY_INVALID");
  return Object.freeze([
    defaults[0],
    ...destinations.filter(({ default: isDefault }) => !isDefault),
  ]);
}

function normalizedPolicy(schemaVersion, destinations) {
  const primary = destinations[0];
  return Object.freeze({
    schemaVersion,
    serverOrigin: primary.serverOrigin,
    workspaceId: primary.workspaceId,
    destinations,
  });
}

/** Stable key that matches relay bindings and cloud tokens to a destination. */
export function destinationKey(value) {
  return `${value.serverOrigin} ${value.workspaceId}`;
}

/** The single-destination policy shape that enrollment and probes consume. */
export function destinationPolicy(value) {
  return Object.freeze({
    schemaVersion: 1,
    serverOrigin: canonicalOrigin(value.serverOrigin),
    workspaceId: workspaceId(value.workspaceId),
  });
}

// Normalized output validates to itself, so callers may re-validate a loaded
// or injected policy without knowing whether it was normalized already.
function denormalizedInput(value) {
  if (!Array.isArray(value.destinations)) return value;
  const normalized =
    Object.hasOwn(value, "serverOrigin") || Object.hasOwn(value, "workspaceId");
  exactObject(value, normalized ? NORMALIZED_FIELDS : V2_FIELDS);
  if (normalized && Object.keys(value).length !== NORMALIZED_FIELDS.size) {
    fail("POLICY_INVALID");
  }
  return {
    schemaVersion: value.schemaVersion,
    destinations: value.destinations.map((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const { default: isDefault, repositories, ...rest } = entry;
      if (
        isDefault === false ||
        (isDefault === true && Array.isArray(repositories) && repositories.length === 0)
      ) {
        return { ...rest, ...(isDefault ? { default: true } : { repositories }) };
      }
      return entry;
    }),
  };
}

/**
 * Schema 1: `{ schemaVersion: 1, serverOrigin, workspaceId }`.
 * Schema 2: `{ schemaVersion: 2, destinations: [{ id, serverOrigin, workspaceId,
 * default?: true, repositories?: [absolutePath] }] }` with exactly one default
 * (no repositories) and every other destination listing the checkouts it owns.
 * Both normalize to `{ schemaVersion, serverOrigin, workspaceId, destinations }`
 * where the top-level fields mirror the default destination.
 */
export function validateCaptureAgentPolicy(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("POLICY_INVALID");
  }
  const value = denormalizedInput(input);
  if (value.schemaVersion === 1 && Array.isArray(value.destinations)) {
    return normalizedPolicy(1, normalizedDestinations(value.destinations));
  }
  if (value.schemaVersion === 1) {
    const candidate = exactObject(value, V1_FIELDS);
    if (Object.keys(candidate).length !== V1_FIELDS.size) fail("POLICY_INVALID");
    return normalizedPolicy(
      1,
      normalizedDestinations([
        {
          id: "default",
          serverOrigin: candidate.serverOrigin,
          workspaceId: candidate.workspaceId,
          default: true,
        },
      ]),
    );
  }
  if (value.schemaVersion === 2) {
    const candidate = exactObject(value, V2_FIELDS);
    if (Object.keys(candidate).length !== V2_FIELDS.size) fail("POLICY_INVALID");
    return normalizedPolicy(2, normalizedDestinations(candidate.destinations));
  }
  fail("POLICY_INVALID");
}

function validatePolicyFile(stat, uid) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 2 ||
    stat.size > MAX_POLICY_BYTES ||
    (Number.isInteger(uid) && uid >= 0 && stat.uid !== uid) ||
    (stat.mode & 0o777) !== 0o600
  ) {
    fail("POLICY_UNSAFE");
  }
}

export async function loadCaptureAgentPolicy({
  path = captureAgentPolicyPath(),
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  openImpl = open,
  lstatImpl = lstat,
} = {}) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    fail("POLICY_UNSAFE");
  }
  let parent;
  try {
    parent = await lstatImpl(dirname(path));
  } catch (error) {
    fail(error?.code === "ENOENT" ? "POLICY_UNAVAILABLE" : "POLICY_UNSAFE");
  }
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (Number.isInteger(uid) && uid >= 0 && parent.uid !== uid) ||
    (parent.mode & 0o022) !== 0
  ) {
    fail("POLICY_UNSAFE");
  }
  let handle;
  try {
    handle = await openImpl(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    fail(error?.code === "ENOENT" ? "POLICY_UNAVAILABLE" : "POLICY_UNSAFE");
  }
  try {
    const stat = await handle.stat();
    validatePolicyFile(stat, uid);
    const content = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(content, "utf8") !== stat.size) fail("POLICY_UNSAFE");
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      fail("POLICY_INVALID");
    }
    return validateCaptureAgentPolicy(parsed);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
