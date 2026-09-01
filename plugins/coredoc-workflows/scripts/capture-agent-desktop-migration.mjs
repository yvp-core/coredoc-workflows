import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import * as defaultFileSystem from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { captureEvent } from "../runtime/capture/contract.mjs";
import { captureBinding } from "../runtime/capture/file-outbox.mjs";
import {
  artifactRevisionRequest,
  canonicalArtifactId,
} from "../runtime/artifacts/contract.mjs";
import {
  DESKTOP_LAUNCH_AGENT_MARKER,
  PLUGIN_LAUNCH_AGENT_MARKER,
} from "./capture-agent-lifecycle.mjs";
import { managedRelayConfig } from "./managed-otel-relay.mjs";

const runFile = promisify(execFile);
const BASE_LABEL = "ai.coredoc.capture-relay";
const LABEL = /^ai\.coredoc\.capture-relay(?:\.[0-9a-f]{8})?$/;
const MAX_PLIST_BYTES = 128 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_QUEUE_ENTRIES = 1_000;
const MAX_EVENT_BYTES = 65_536;
const HASH_DIRECTORY = /^[0-9a-f]{64}$/;
const EVENT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.event\.json$/i;
const ARTIFACT_FILE = /^(revision|quarantine)-(\d{6})-(cda_[0-9a-f-]+)-([0-9a-f]{64})\.json$/;
const ARTIFACT_DIGEST = /^[0-9a-f]{64}$/;
const ARTIFACT_ERRORS = new Set([
  "AUTH_REJECTED",
  "OUTBOX_OVERFLOW",
  "REPOSITORY_UNAVAILABLE",
  "TRANSPORT_UNAVAILABLE",
  "CONFIG_CONFLICT",
]);

export class DesktopMigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = "DesktopMigrationError";
    this.code = code;
  }
}

function fail(code) {
  throw new DesktopMigrationError(code);
}

function exactHome(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) {
    fail("UNSAFE_DESKTOP_STATE");
  }
  return value;
}

function expectedDesktopTargets(homeDir) {
  const standardHome = join(homeDir, ".coredoc");
  const developmentHome = join(homeDir, ".coredoc-dev");
  const developmentSuffix = createHash("sha256")
    .update(developmentHome)
    .digest("hex")
    .slice(0, 8);
  return new Map([
    [BASE_LABEL, join(standardHome, "capture-relay", "relay.json")],
    [
      `${BASE_LABEL}.${developmentSuffix}`,
      join(developmentHome, "capture-relay", "relay.json"),
    ],
  ]);
}

async function safeRegularFile(path, { fs, uid, maxBytes }) {
  let metadata;
  try {
    metadata = await fs.lstat(path);
  } catch {
    fail("UNSAFE_DESKTOP_STATE");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > maxBytes ||
    (metadata.mode & 0o777) !== 0o600 ||
    (Number.isInteger(uid) && uid >= 0 && metadata.uid !== uid)
  ) {
    fail("UNSAFE_DESKTOP_STATE");
  }
  let content;
  try {
    content = await fs.readFile(path, "utf8");
  } catch {
    fail("UNSAFE_DESKTOP_STATE");
  }
  return { content, mode: metadata.mode & 0o777 };
}

function xmlDecode(value) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function singleMatch(content, expression) {
  const matches = [...content.matchAll(expression)];
  if (matches.length !== 1) fail("DESKTOP_CONFLICT");
  return xmlDecode(matches[0][1]);
}

function validateDesktopPlist(content, path, expectedTargets) {
  if (
    content.split(DESKTOP_LAUNCH_AGENT_MARKER).length !== 2 ||
    content.includes(PLUGIN_LAUNCH_AGENT_MARKER)
  ) {
    fail("DESKTOP_CONFLICT");
  }
  const label = singleMatch(
    content,
    /<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/g,
  );
  if (!LABEL.test(label) || basename(path) !== `${label}.plist`) {
    fail("DESKTOP_CONFLICT");
  }
  const argumentsBlock = singleMatch(
    content,
    /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/g,
  );
  const argumentsList = [...argumentsBlock.matchAll(/<string>([^<]+)<\/string>/g)].map(
    (match) => xmlDecode(match[1]),
  );
  if (
    argumentsList.length !== 4 ||
    argumentsList[2] !== "--config" ||
    argumentsList.some((value) => value.length === 0)
  ) {
    fail("DESKTOP_CONFLICT");
  }
  const [programPath, scriptPath, , configPath] = argumentsList;
  const programMatches = [
    ...content.matchAll(/<key>\s*Program\s*<\/key>\s*<string>([^<]+)<\/string>/g),
  ];
  if (
    programMatches.length > 1 ||
    (programMatches.length === 1 && xmlDecode(programMatches[0][1]) !== programPath)
  ) {
    fail("DESKTOP_CONFLICT");
  }
  if (expectedTargets.get(label) !== configPath) fail("DESKTOP_CONFLICT");
  return { label, configPath, programPath, scriptPath };
}

async function validateRestartTarget(path, fs, { executable }) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    fail("DESKTOP_RESTART_UNAVAILABLE");
  }
  try {
    const metadata = await fs.lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o022) !== 0
    ) {
      fail("DESKTOP_RESTART_UNAVAILABLE");
    }
    await fs.access(path, executable ? 0o1 : 0o4);
  } catch (error) {
    if (error instanceof DesktopMigrationError) throw error;
    fail("DESKTOP_RESTART_UNAVAILABLE");
  }
}

async function atomicWrite(path, content, mode, fs) {
  const directory = dirname(path);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, {
      encoding: "utf8",
      mode,
      flag: "wx",
    });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, path);
  } catch {
    await fs.unlink(temporary).catch(() => undefined);
    fail("DESKTOP_RESTORE_FAILED");
  }
}

function defaultRunCommand(executable, args) {
  return runFile(executable, args, {
    timeout: 10_000,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  }).then(() => undefined);
}

async function optionalRead(path, fs) {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    fail("DESKTOP_RESTORE_FAILED");
  }
}

async function safeQueueDirectory(path, fs, uid, { optional = false } = {}) {
  let metadata;
  try {
    metadata = await fs.lstat(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return false;
    fail("DESKTOP_CONFLICT");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (Number.isInteger(uid) && uid >= 0 && metadata.uid !== uid)
  ) {
    fail("DESKTOP_CONFLICT");
  }
  return true;
}

async function safeQueueFile(path, fs, uid, maximum, { optional = false } = {}) {
  let metadata;
  try {
    metadata = await fs.lstat(path);
  } catch (error) {
    if (optional && error?.code === "ENOENT") return null;
    fail("DESKTOP_CONFLICT");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > maximum ||
    (metadata.mode & 0o777) !== 0o600 ||
    (Number.isInteger(uid) && uid >= 0 && metadata.uid !== uid)
  ) {
    fail("DESKTOP_CONFLICT");
  }
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    fail("DESKTOP_CONFLICT");
  }
}

function queueRecord(content, name) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "binding") ||
    !Object.hasOwn(value, "event")
  ) {
    fail("DESKTOP_CONFLICT");
  }
  let binding;
  let event;
  try {
    binding = captureBinding(value.binding);
    event = captureEvent(value.event);
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  if (`${event.eventId}.event.json` !== name.toLowerCase()) {
    fail("DESKTOP_CONFLICT");
  }
  return { binding, event };
}

function artifactState(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  const fields = new Set([
    "schemaVersion",
    "nextSequence",
    "artifacts",
    "quarantined",
    "errorCode",
  ]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((field) => !fields.has(field)) ||
    value.schemaVersion !== 1 ||
    !Number.isInteger(value.nextSequence) ||
    value.nextSequence < 1 ||
    value.nextSequence > 999_999 ||
    !value.artifacts ||
    typeof value.artifacts !== "object" ||
    Array.isArray(value.artifacts) ||
    Object.keys(value.artifacts).length > 16 ||
    !Array.isArray(value.quarantined) ||
    value.quarantined.length > 16 ||
    (value.errorCode !== null && !ARTIFACT_ERRORS.has(value.errorCode))
  ) {
    fail("DESKTOP_CONFLICT");
  }
  try {
    for (const [artifactId, digest] of Object.entries(value.artifacts)) {
      canonicalArtifactId(artifactId);
      if (!ARTIFACT_DIGEST.test(digest)) fail("DESKTOP_CONFLICT");
    }
    const sequences = new Set();
    for (const item of value.quarantined) {
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).length !== 4 ||
        !Number.isInteger(item.sequence) ||
        item.sequence < 1 ||
        item.sequence > 999_999 ||
        sequences.has(item.sequence) ||
        !ARTIFACT_DIGEST.test(item.digest) ||
        item.errorCode !== "CONFIG_CONFLICT"
      ) {
        fail("DESKTOP_CONFLICT");
      }
      canonicalArtifactId(item.artifactId);
      sequences.add(item.sequence);
    }
  } catch (error) {
    if (error instanceof DesktopMigrationError) throw error;
    fail("DESKTOP_CONFLICT");
  }
}

function artifactRecord(content, name) {
  const match = ARTIFACT_FILE.exec(name);
  if (!match) fail("DESKTOP_CONFLICT");
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    value.schemaVersion !== 1 ||
    !Number.isInteger(value.sequence) ||
    value.sequence !== Number(match[2]) ||
    value.artifactId !== match[3] ||
    value.digest !== match[4] ||
    !ARTIFACT_DIGEST.test(value.digest)
  ) {
    fail("DESKTOP_CONFLICT");
  }
  try {
    canonicalArtifactId(value.artifactId);
    const body = artifactRevisionRequest(value.body);
    if (
      createHash("sha256").update(body.markdown).digest("hex") !== value.digest
    ) {
      fail("DESKTOP_CONFLICT");
    }
  } catch (error) {
    if (error instanceof DesktopMigrationError) throw error;
    fail("DESKTOP_CONFLICT");
  }
}

async function safeMetadataFile(path, fs, uid) {
  let metadata;
  try {
    metadata = await fs.lstat(path);
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size > MAX_CONFIG_BYTES ||
    (Number.isInteger(uid) && uid >= 0 && metadata.uid !== uid)
  ) {
    fail("DESKTOP_CONFLICT");
  }
}

async function ensureQueueDirectory(path, fs, uid, createdDirectories) {
  if (await safeQueueDirectory(path, fs, uid, { optional: true })) return;
  try {
    await fs.mkdir(path, { mode: 0o700 });
    await fs.chmod(path, 0o700);
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  await safeQueueDirectory(path, fs, uid);
  createdDirectories.push(path);
}

async function atomicQueueCopy(path, content, fs) {
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
    await fs.rename(temporary, path);
  } catch {
    await fs.unlink(temporary).catch(() => undefined);
    fail("DESKTOP_CONFLICT");
  }
}

export async function prepareDesktopQueueImport({
  migration,
  targetRelayRoot,
  workspaceId,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  fileSystem: fs = defaultFileSystem,
} = {}) {
  if (
    !migration ||
    (migration.status !== "none" && migration.status !== "desktop-v1") ||
    typeof targetRelayRoot !== "string" ||
    !isAbsolute(targetRelayRoot) ||
    resolve(targetRelayRoot) !== targetRelayRoot ||
    typeof workspaceId !== "string" ||
    workspaceId.length === 0 ||
    !Number.isInteger(uid) ||
    uid < 0
  ) {
    fail("DESKTOP_CONFLICT");
  }
  const emptySummary = Object.freeze({
    importedPending: 0,
    skippedOtherWorkspacePending: 0,
    skippedUnsupportedPending: 0,
  });
  if (migration.status === "none") {
    return Object.freeze({
      summary: emptySummary,
      async apply() {},
      async rollback() {},
    });
  }
  if (
    typeof migration.configPath !== "string" ||
    !isAbsolute(migration.configPath)
  ) {
    fail("DESKTOP_CONFLICT");
  }
  let relayConfig;
  try {
    relayConfig = managedRelayConfig(migration.relayConfig);
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  const eligibleHashes = new Set(
    relayConfig.bindings
      .filter(
        ({ host, workspaceId: candidateWorkspace, workspaceMode }) =>
          host === "claude-code" &&
          candidateWorkspace === workspaceId &&
          workspaceMode !== true,
      )
      .map(({ bindingNonceHash }) => bindingNonceHash),
  );
  const sourceRoot = join(dirname(migration.configPath), "outbox");
  let directories = [];
  if (await safeQueueDirectory(sourceRoot, fs, uid, { optional: true })) {
    try {
      directories = await fs.readdir(sourceRoot, { withFileTypes: true });
    } catch {
      fail("DESKTOP_CONFLICT");
    }
  }
  if (directories.length > MAX_QUEUE_ENTRIES) fail("DESKTOP_CONFLICT");
  const copies = [];
  let importedPending = 0;
  let skippedOtherWorkspacePending = 0;
  let skippedUnsupportedPending = 0;
  for (const directoryEntry of directories.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const sourceDirectory = join(sourceRoot, directoryEntry.name);
    if (directoryEntry.name === ".DS_Store") {
      await safeMetadataFile(sourceDirectory, fs, uid);
      continue;
    }
    if (
      !HASH_DIRECTORY.test(directoryEntry.name) ||
      !directoryEntry.isDirectory() ||
      directoryEntry.isSymbolicLink()
    ) {
      fail("DESKTOP_CONFLICT");
    }
    await safeQueueDirectory(sourceDirectory, fs, uid);
    let entries;
    try {
      entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
    } catch {
      fail("DESKTOP_CONFLICT");
    }
    if (entries.length > MAX_QUEUE_ENTRIES) fail("DESKTOP_CONFLICT");
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const sourcePath = join(sourceDirectory, entry.name);
      if (entry.name === "capture-health.json") {
        await safeQueueFile(sourcePath, fs, uid, 4_096);
        continue;
      }
      if (
        !EVENT_FILE.test(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        fail("DESKTOP_CONFLICT");
      }
      const content = await safeQueueFile(
        sourcePath,
        fs,
        uid,
        MAX_EVENT_BYTES,
      );
      const record = queueRecord(content, entry.name);
      if (!eligibleHashes.has(directoryEntry.name)) {
        if (record.binding.workspaceId === workspaceId) {
          skippedUnsupportedPending += 1;
        } else {
          skippedOtherWorkspacePending += 1;
        }
        continue;
      }
      if (
        record.binding.workspaceId !== workspaceId ||
        record.event.host !== "claude-code"
      ) {
        fail("DESKTOP_CONFLICT");
      }
      const targetPath = join(
        targetRelayRoot,
        "outbox",
        directoryEntry.name,
        entry.name,
      );
      const targetContent = await safeQueueFile(
        targetPath,
        fs,
        uid,
        MAX_EVENT_BYTES,
        { optional: true },
      );
      if (targetContent !== null && targetContent !== content) {
        fail("DESKTOP_CONFLICT");
      }
      copies.push({
        sourcePath,
        targetPath,
        content,
        maximum: MAX_EVENT_BYTES,
        preexisting: targetContent !== null,
      });
      importedPending += 1;
    }
  }

  const artifactRoot = join(dirname(migration.configPath), "artifact-outbox");
  if (await safeQueueDirectory(artifactRoot, fs, uid, { optional: true })) {
    let artifactDirectories;
    try {
      artifactDirectories = await fs.readdir(artifactRoot, {
        withFileTypes: true,
      });
    } catch {
      fail("DESKTOP_CONFLICT");
    }
    if (artifactDirectories.length > MAX_QUEUE_ENTRIES) {
      fail("DESKTOP_CONFLICT");
    }
    const workspaceByHash = new Map();
    for (const binding of relayConfig.bindings) {
      workspaceByHash.set(
        binding.host === "codex"
          ? createHash("sha256").update(binding.bindingId).digest("hex")
          : binding.bindingNonceHash,
        { workspaceId: binding.workspaceId, host: binding.host },
      );
    }
    for (const directoryEntry of artifactDirectories.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const sourceDirectory = join(artifactRoot, directoryEntry.name);
      if (directoryEntry.name === ".DS_Store") {
        await safeMetadataFile(sourceDirectory, fs, uid);
        continue;
      }
      if (
        !HASH_DIRECTORY.test(directoryEntry.name) ||
        !directoryEntry.isDirectory() ||
        directoryEntry.isSymbolicLink()
      ) {
        fail("DESKTOP_CONFLICT");
      }
      await safeQueueDirectory(sourceDirectory, fs, uid);
      let entries;
      try {
        entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
      } catch {
        fail("DESKTOP_CONFLICT");
      }
      if (entries.length > 64) fail("DESKTOP_CONFLICT");
      const binding = workspaceByHash.get(directoryEntry.name);
      const eligible = eligibleHashes.has(directoryEntry.name);
      const revisionCount = entries.filter(({ name }) =>
        name.startsWith("revision-"),
      ).length;
      if (!eligible) {
        if (binding && binding.workspaceId !== workspaceId) {
          skippedOtherWorkspacePending += revisionCount;
        } else {
          skippedUnsupportedPending += revisionCount;
        }
      }
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          fail("DESKTOP_CONFLICT");
        }
        const sourcePath = join(sourceDirectory, entry.name);
        const maximum = entry.name === "state.json" ? 64 * 1024 : 3 * 1024 * 1024;
        const content = await safeQueueFile(sourcePath, fs, uid, maximum);
        if (entry.name === "state.json") artifactState(content);
        else artifactRecord(content, entry.name);
        if (!eligible) continue;
        const targetPath = join(
          targetRelayRoot,
          "artifact-outbox",
          directoryEntry.name,
          entry.name,
        );
        const targetContent = await safeQueueFile(
          targetPath,
          fs,
          uid,
          maximum,
          { optional: true },
        );
        if (targetContent !== null && targetContent !== content) {
          fail("DESKTOP_CONFLICT");
        }
        copies.push({
          sourcePath,
          targetPath,
          content,
          maximum,
          preexisting: targetContent !== null,
        });
        if (entry.name.startsWith("revision-")) importedPending += 1;
      }
      if (eligible && revisionCount > 0 && !entries.some(({ name }) => name === "state.json")) {
        fail("DESKTOP_CONFLICT");
      }
    }
  }

  let state = "prepared";
  const createdFiles = [];
  const createdDirectories = [];
  const summary = Object.freeze({
    importedPending,
    skippedOtherWorkspacePending,
    skippedUnsupportedPending,
  });
  return Object.freeze({
    summary,
    async apply() {
      if (state !== "prepared") fail("DESKTOP_CONFLICT");
      try {
        await ensureQueueDirectory(targetRelayRoot, fs, uid, createdDirectories);
        const outboxRoot = join(targetRelayRoot, "outbox");
        await ensureQueueDirectory(outboxRoot, fs, uid, createdDirectories);
        for (const copy of copies) {
          const currentSource = await safeQueueFile(
            copy.sourcePath,
            fs,
            uid,
            copy.maximum,
          );
          if (currentSource !== copy.content) fail("DESKTOP_CONFLICT");
          const targetDirectory = dirname(copy.targetPath);
          await ensureQueueDirectory(
            dirname(targetDirectory),
            fs,
            uid,
            createdDirectories,
          );
          await ensureQueueDirectory(
            targetDirectory,
            fs,
            uid,
            createdDirectories,
          );
          const currentTarget = await safeQueueFile(
            copy.targetPath,
            fs,
            uid,
            copy.maximum,
            { optional: true },
          );
          if (copy.preexisting) {
            if (currentTarget !== copy.content) fail("DESKTOP_CONFLICT");
            continue;
          }
          if (currentTarget !== null) fail("DESKTOP_CONFLICT");
          await atomicQueueCopy(copy.targetPath, copy.content, fs);
          createdFiles.push(copy);
        }
        state = "applied";
      } catch (error) {
        for (const copy of createdFiles.reverse()) {
          const current = await safeQueueFile(
            copy.targetPath,
            fs,
            uid,
            copy.maximum,
            { optional: true },
          ).catch(() => undefined);
          if (current === copy.content) {
            await fs.unlink(copy.targetPath).catch(() => undefined);
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
      if (state !== "applied") fail("DESKTOP_RESTORE_FAILED");
      for (const copy of [...createdFiles].reverse()) {
        const current = await safeQueueFile(
          copy.targetPath,
          fs,
          uid,
          copy.maximum,
          { optional: true },
        );
        if (current === null) continue;
        if (current !== copy.content) fail("DESKTOP_RESTORE_FAILED");
        await fs.unlink(copy.targetPath).catch(() =>
          fail("DESKTOP_RESTORE_FAILED"),
        );
      }
      for (const path of [...createdDirectories].reverse()) {
        await fs.rmdir(path).catch((error) => {
          if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) {
            fail("DESKTOP_RESTORE_FAILED");
          }
        });
      }
      state = "rolled-back";
    },
  });
}

export async function prepareDesktopRelayMigration({
  homeDir,
  uid = typeof process.getuid === "function" ? process.getuid() : -1,
  fileSystem: fs = defaultFileSystem,
  runCommand = defaultRunCommand,
} = {}) {
  const home = exactHome(homeDir);
  if (!Number.isInteger(uid) || uid < 0) fail("UNSAFE_DESKTOP_STATE");
  const launchAgents = join(home, "Library", "LaunchAgents");
  let entries;
  try {
    entries = await fs.readdir(launchAgents, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        status: "none",
        relayConfig: null,
        configPath: null,
        async stop() {},
        async restore() {},
        async retire() {},
      });
    }
    fail("UNSAFE_DESKTOP_STATE");
  }
  const candidates = entries.filter(({ name }) =>
    /^ai\.coredoc\.capture-relay(?:\.[0-9a-f]{8})?\.plist$/.test(name),
  );
  if (candidates.length > 1) fail("DESKTOP_AMBIGUOUS");
  if (candidates.length === 0) {
    return Object.freeze({
      status: "none",
      relayConfig: null,
      configPath: null,
      async stop() {},
      async restore() {},
      async retire() {},
    });
  }
  const candidate = candidates[0];
  if (!candidate.isFile() || candidate.isSymbolicLink()) {
    fail("UNSAFE_DESKTOP_STATE");
  }
  const plistPath = join(launchAgents, candidate.name);
  const plistSnapshot = await safeRegularFile(plistPath, {
    fs,
    uid,
    maxBytes: MAX_PLIST_BYTES,
  });
  const expectedTargets = expectedDesktopTargets(home);
  const { label, configPath, programPath, scriptPath } = validateDesktopPlist(
    plistSnapshot.content,
    plistPath,
    expectedTargets,
  );
  await validateRestartTarget(programPath, fs, { executable: true });
  await validateRestartTarget(scriptPath, fs, { executable: false });
  const configSnapshot = await safeRegularFile(configPath, {
    fs,
    uid,
    maxBytes: MAX_CONFIG_BYTES,
  });
  let relayConfig;
  try {
    relayConfig = managedRelayConfig(JSON.parse(configSnapshot.content));
  } catch {
    fail("DESKTOP_CONFLICT");
  }
  const domain = `gui/${uid}`;
  const service = `${domain}/${label}`;
  const standardLabel = label === BASE_LABEL;
  let wasLoaded = false;
  try {
    await runCommand("/bin/launchctl", ["print", service]);
    wasLoaded = true;
  } catch {
    wasLoaded = false;
  }
  let stopCompleted = false;
  let restoreNeeded = false;

  return Object.freeze({
    status: "desktop-v1",
    label,
    plistPath,
    configPath,
    relayConfig,
    relayConfigRaw: configSnapshot.content,
    async stop() {
      if (stopCompleted) return;
      if (wasLoaded) {
        await runCommand("/bin/launchctl", ["bootout", service]).catch(() => {
          fail("DESKTOP_STOP_FAILED");
        });
        restoreNeeded = true;
      }
      if (standardLabel) {
        const current = await optionalRead(plistPath, fs);
        if (current !== plistSnapshot.content) fail("DESKTOP_CONFLICT");
        restoreNeeded = true;
        await fs.unlink(plistPath).catch(() => fail("DESKTOP_STOP_FAILED"));
      }
      stopCompleted = true;
    },
    async restore() {
      if (!restoreNeeded) return;
      if (wasLoaded) {
        await runCommand("/bin/launchctl", ["bootout", service]).catch(
          () => undefined,
        );
      }
      const current = await optionalRead(plistPath, fs);
      if (
        current !== undefined &&
        current !== plistSnapshot.content &&
        !current.includes(PLUGIN_LAUNCH_AGENT_MARKER)
      ) {
        fail("DESKTOP_RESTORE_FAILED");
      }
      if (current !== plistSnapshot.content) {
        await atomicWrite(
          plistPath,
          plistSnapshot.content,
          plistSnapshot.mode,
          fs,
        );
      }
      if (wasLoaded) {
        await runCommand("/bin/launchctl", ["bootstrap", domain, plistPath]).catch(
          () => fail("DESKTOP_RESTORE_FAILED"),
        );
      }
      stopCompleted = false;
      restoreNeeded = false;
    },
    async retire({ pluginLaunchAgentPath } = {}) {
      if (typeof pluginLaunchAgentPath !== "string" || !isAbsolute(pluginLaunchAgentPath)) {
        fail("DESKTOP_CONFLICT");
      }
      if (resolve(pluginLaunchAgentPath) === plistPath) return;
      const current = await optionalRead(plistPath, fs);
      if (current !== plistSnapshot.content) fail("DESKTOP_CONFLICT");
      await fs.unlink(plistPath).catch(() => fail("DESKTOP_RETIRE_FAILED"));
    },
  });
}
