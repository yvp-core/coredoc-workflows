import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POLICY_FIELDS = new Set(["schemaVersion", "serverOrigin", "workspaceId"]);
const MAX_POLICY_BYTES = 4096;

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

function exactObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("POLICY_INVALID");
  }
  const fields = Object.keys(value);
  if (fields.length !== POLICY_FIELDS.size || fields.some((field) => !POLICY_FIELDS.has(field))) {
    fail("POLICY_INVALID");
  }
  return value;
}

function httpsOrigin(value) {
  if (typeof value !== "string") fail("POLICY_INVALID");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("POLICY_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
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

export function validateCaptureAgentPolicy(value) {
  const candidate = exactObject(value);
  if (candidate.schemaVersion !== 1) fail("POLICY_INVALID");
  const serverOrigin = httpsOrigin(candidate.serverOrigin);
  if (typeof candidate.workspaceId !== "string" || !UUID.test(candidate.workspaceId)) {
    fail("POLICY_INVALID");
  }
  return Object.freeze({
    schemaVersion: 1,
    serverOrigin,
    workspaceId: candidate.workspaceId.toLowerCase(),
  });
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
