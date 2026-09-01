import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as realFileSystem from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DesktopMigrationError,
  prepareDesktopQueueImport,
  prepareDesktopRelayMigration,
} from "./capture-agent-desktop-migration.mjs";
import { createArtifactCheckpointStore } from "./artifact-checkpoints.mjs";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SERVER_ORIGIN = "https://coredoc.example.com";
const DESKTOP_MARKER = "<!-- Coredoc managed relay LaunchAgent v1 -->";

function oldRelayConfig() {
  return {
    schemaVersion: 1,
    bindings: [
      {
        schemaVersion: 1,
        bindingId: "11111111-1111-4111-8111-111111111111",
        bindingNonceHash: "a".repeat(64),
        host: "claude-code",
        workspaceId: WORKSPACE_ID,
        repositoryKey: "owner/repository",
        nativeForwardEndpoint: `${SERVER_ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/otel/v1/logs`,
        captureForwardEndpoint: `${SERVER_ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/events`,
        cloudAuthorization: `Bearer cdt_${"b".repeat(64)}`,
      },
    ],
  };
}

function desktopPlist(
  label,
  configPath,
  {
    marker = DESKTOP_MARKER,
    programPath = "/Applications/Coredoc.app/Contents/MacOS/Coredoc",
    scriptPath = "/Applications/Coredoc.app/Contents/Resources/relay.mjs",
  } = {},
) {
  return `<?xml version="1.0"?><plist><dict>
  ${marker}
  <key>Label</key><string>${label}</string>
  <key>Program</key><string>${programPath}</string>
  <key>ProgramArguments</key><array>
    <string>${programPath}</string>
    <string>${scriptPath}</string><string>--config</string><string>${configPath}</string>
  </array>
  </dict></plist>
`;
}

async function restartTargets(root) {
  const directory = join(root, "desktop-runtime");
  const programPath = join(directory, "Coredoc");
  const scriptPath = join(directory, "relay.mjs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(programPath, "#!/bin/sh\n", { mode: 0o700 });
  await writeFile(scriptPath, "export {};\n", { mode: 0o600 });
  return { programPath, scriptPath };
}

async function suffixFixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "desktop-migration-"));
  const coredocHome = join(homeDir, ".coredoc-dev");
  const label = `ai.coredoc.capture-relay.${createHash("sha256")
    .update(coredocHome)
    .digest("hex")
    .slice(0, 8)}`;
  const plistPath = join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const configPath = join(coredocHome, "capture-relay", "relay.json");
  await mkdir(join(homeDir, "Library", "LaunchAgents"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(coredocHome, "capture-relay"), {
    recursive: true,
    mode: 0o700,
  });
  const targets = await restartTargets(homeDir);
  const plist = desktopPlist(label, configPath, targets);
  const config = `${JSON.stringify(oldRelayConfig())}\n`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  await writeFile(configPath, config, { mode: 0o600 });
  return { homeDir, label, plistPath, configPath, plist, config, ...targets };
}

async function standardFixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "desktop-migration-standard-"));
  const label = "ai.coredoc.capture-relay";
  const plistPath = join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const configPath = join(homeDir, ".coredoc", "capture-relay", "relay.json");
  await mkdir(join(homeDir, "Library", "LaunchAgents"), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(homeDir, ".coredoc", "capture-relay"), {
    recursive: true,
    mode: 0o700,
  });
  const targets = await restartTargets(homeDir);
  const plist = desktopPlist(label, configPath, targets);
  const config = `${JSON.stringify(oldRelayConfig())}\n`;
  await writeFile(plistPath, plist, { mode: 0o600 });
  await writeFile(configPath, config, { mode: 0o600 });
  return { homeDir, label, plistPath, configPath, plist, config, ...targets };
}

test("migrates the exact coredoc-dev Desktop suffix and restores it on rollback", async () => {
  const fixture = await suffixFixture();
  const calls = [];
  const runCommand = async (executable, args) => {
    calls.push([executable, args]);
  };
  const migration = await prepareDesktopRelayMigration({
    homeDir: fixture.homeDir,
    uid: 501,
    runCommand,
  });
  assert.equal(migration.status, "desktop-v1");
  assert.equal(migration.label, fixture.label);
  assert.equal(migration.configPath, fixture.configPath);
  assert.deepEqual(migration.relayConfig, oldRelayConfig());

  await migration.stop();
  assert.deepEqual(calls.at(-1), [
    "/bin/launchctl",
    ["bootout", `gui/501/${fixture.label}`],
  ]);

  await writeFile(
    fixture.plistPath,
    "<!-- Coredoc Workflows plugin capture agent LaunchAgent v1 -->\n",
    { mode: 0o600 },
  );
  await migration.restore();
  assert.equal(await readFile(fixture.plistPath, "utf8"), fixture.plist);
  assert.deepEqual(calls.at(-1), [
    "/bin/launchctl",
    ["bootstrap", "gui/501", fixture.plistPath],
  ]);

  await migration.stop();
  await migration.retire({
    pluginLaunchAgentPath: join(
      fixture.homeDir,
      "Library",
      "LaunchAgents",
      "ai.coredoc.capture-relay.plist",
    ),
  });
  await assert.rejects(readFile(fixture.plistPath), { code: "ENOENT" });
  assert.equal(await readFile(fixture.configPath, "utf8"), fixture.config);
});

test("refuses foreign, ambiguous, and unsafe Desktop migration state", async () => {
  const foreign = await suffixFixture();
  await writeFile(
    foreign.plistPath,
    desktopPlist(foreign.label, foreign.configPath, { marker: "<!-- foreign -->" }),
  );
  await assert.rejects(
    prepareDesktopRelayMigration({
      homeDir: foreign.homeDir,
      uid: 501,
      runCommand: async () => undefined,
    }),
    (error) => error instanceof DesktopMigrationError && error.code === "DESKTOP_CONFLICT",
  );

  const ambiguous = await suffixFixture();
  const baseLabel = "ai.coredoc.capture-relay";
  const basePath = join(
    ambiguous.homeDir,
    "Library",
    "LaunchAgents",
    `${baseLabel}.plist`,
  );
  await writeFile(
    basePath,
    desktopPlist(
      baseLabel,
      join(ambiguous.homeDir, ".coredoc", "capture-relay", "relay.json"),
    ),
    { mode: 0o600 },
  );
  await assert.rejects(
    prepareDesktopRelayMigration({
      homeDir: ambiguous.homeDir,
      uid: 501,
      runCommand: async () => undefined,
    }),
    (error) => error instanceof DesktopMigrationError && error.code === "DESKTOP_AMBIGUOUS",
  );

  const unsafe = await suffixFixture();
  await chmod(unsafe.plistPath, 0o666);
  await assert.rejects(
    prepareDesktopRelayMigration({
      homeDir: unsafe.homeDir,
      uid: 501,
      runCommand: async () => undefined,
    }),
    (error) => error instanceof DesktopMigrationError && error.code === "UNSAFE_DESKTOP_STATE",
  );
});

test("refuses a loaded Desktop relay whose exact restart target disappeared before mutation", async () => {
  const fixture = await suffixFixture();
  await unlink(fixture.scriptPath);
  const calls = [];

  await assert.rejects(
    prepareDesktopRelayMigration({
      homeDir: fixture.homeDir,
      uid: 501,
      runCommand: async (executable, args) => calls.push([executable, args]),
    }),
    (error) =>
      error instanceof DesktopMigrationError &&
      error.code === "DESKTOP_RESTART_UNAVAILABLE",
  );
  assert.deepEqual(calls, []);
  assert.equal(await readFile(fixture.plistPath, "utf8"), fixture.plist);
});

for (const initiallyLoaded of [true, false]) {
  test(`vacates and exactly restores the ${initiallyLoaded ? "loaded" : "dormant"} standard Desktop plist`, async () => {
    const fixture = await standardFixture();
    const calls = [];
    const runCommand = async (executable, args) => {
      calls.push([executable, args]);
      if (args[0] === "print" && !initiallyLoaded) {
        throw Object.assign(new Error("not loaded"), { code: 113 });
      }
    };
    const migration = await prepareDesktopRelayMigration({
      homeDir: fixture.homeDir,
      uid: 501,
      runCommand,
    });

    await migration.stop();
    await assert.rejects(readFile(fixture.plistPath), { code: "ENOENT" });
    assert.equal(
      calls.some(([, args]) => args[0] === "bootout"),
      initiallyLoaded,
    );

    await migration.restore();
    assert.equal(await readFile(fixture.plistPath, "utf8"), fixture.plist);
    assert.equal(await readFile(fixture.configPath, "utf8"), fixture.config);
    assert.equal(
      calls.some(([, args]) => args[0] === "bootstrap"),
      initiallyLoaded,
    );
  });
}

test("restores a loaded standard Desktop service when plist vacating fails after bootout", async () => {
  const fixture = await standardFixture();
  const calls = [];
  let failUnlink = true;
  const fileSystem = {
    ...realFileSystem,
    async unlink(path) {
      if (path === fixture.plistPath && failUnlink) {
        failUnlink = false;
        throw Object.assign(new Error("injected unlink failure"), { code: "EIO" });
      }
      return unlink(path);
    },
  };
  const migration = await prepareDesktopRelayMigration({
    homeDir: fixture.homeDir,
    uid: 501,
    fileSystem,
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
    },
  });

  await assert.rejects(
    migration.stop(),
    (error) =>
      error instanceof DesktopMigrationError && error.code === "DESKTOP_STOP_FAILED",
  );
  await migration.restore();

  assert.equal(await readFile(fixture.plistPath, "utf8"), fixture.plist);
  assert.deepEqual(
    calls.filter(([, args]) => args[0] === "bootout").at(-1),
    ["/bin/launchctl", ["bootout", `gui/501/${fixture.label}`]],
  );
  assert.deepEqual(calls.at(-1), [
    "/bin/launchctl",
    ["bootstrap", "gui/501", fixture.plistPath],
  ]);
});

function queuedEvent(
  eventId,
  workspaceId = WORKSPACE_ID,
  host = "claude-code",
) {
  return `${JSON.stringify({
    binding: {
      endpoint: "http://127.0.0.1:43181/capture/v1/events",
      workspaceId,
      credentialFingerprint: "f".repeat(64),
    },
    event: {
      schemaVersion: 1,
      eventId,
      occurredAt: "2026-09-01T10:00:00.000Z",
      host,
      sessionId: "desktop-session",
      runId: "cdr-20260901-a1b2c3",
      repositoryKey: "owner/repository",
      taskId: "legacy-task",
      type: "workflow.run.started",
      data: {
        workflowId: "change:normal",
        intent: "change",
        risk: "normal",
        scale: "normal",
      },
    },
  })}\n`;
}

test("classifies fixed-workspace legacy Codex semantic and artifact queues as unsupported", async () => {
  const fixture = await suffixFixture();
  const codexBindingId = "99999999-9999-4999-8999-999999999999";
  const codexHash = createHash("sha256").update(codexBindingId).digest("hex");
  const relayConfig = {
    ...oldRelayConfig(),
    bindings: [
      ...oldRelayConfig().bindings,
      {
        schemaVersion: 1,
        bindingId: codexBindingId,
        bindingNonceHash: "c".repeat(64),
        host: "codex",
        workspaceId: WORKSPACE_ID,
        repositoryKey: "owner/codex-repository",
        repositoryScopeKey: `repo-${"d".repeat(24)}`,
        profileName: null,
        nativeForwardEndpoint: `${SERVER_ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/otel/v1/logs`,
        captureForwardEndpoint: `${SERVER_ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/events`,
        cloudAuthorization: `Bearer cdt_${"e".repeat(64)}`,
      },
    ],
  };
  const eventName = "33333333-3333-4333-8333-333333333333.event.json";
  const sourceSemantic = join(
    fixture.homeDir,
    ".coredoc-dev",
    "capture-relay",
    "outbox",
    codexHash,
  );
  await mkdir(sourceSemantic, { recursive: true, mode: 0o700 });
  await writeFile(
    join(sourceSemantic, eventName),
    queuedEvent(eventName.slice(0, 36), WORKSPACE_ID, "codex"),
    { mode: 0o600 },
  );
  const sourceArtifacts = join(
    fixture.homeDir,
    ".coredoc-dev",
    "capture-relay",
    "artifact-outbox",
    codexHash,
  );
  const artifactStore = createArtifactCheckpointStore({
    directory: sourceArtifacts,
  });
  const markdown = "# Pending Codex artifact\n";
  artifactStore.enqueue({
    artifactId: "cda_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    digest: createHash("sha256").update(markdown).digest("hex"),
    body: {
      taskId: "cdt_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      repositoryKey: "owner/codex-repository",
      kind: "spec",
      checkpoint: "run-finish",
      markdown,
    },
  });
  const targetRelayRoot = join(fixture.homeDir, ".coredoc", "capture-relay");
  await mkdir(targetRelayRoot, { recursive: true, mode: 0o700 });

  const transaction = await prepareDesktopQueueImport({
    migration: {
      status: "desktop-v1",
      configPath: fixture.configPath,
      relayConfig,
    },
    targetRelayRoot,
    workspaceId: WORKSPACE_ID,
    uid: typeof process.getuid === "function" ? process.getuid() : 501,
  });

  assert.deepEqual(transaction.summary, {
    importedPending: 0,
    skippedOtherWorkspacePending: 0,
    skippedUnsupportedPending: 2,
  });
  await transaction.apply();
  await assert.rejects(readdir(join(targetRelayRoot, "outbox", codexHash)), {
    code: "ENOENT",
  });
  await assert.rejects(
    readdir(join(targetRelayRoot, "artifact-outbox", codexHash)),
    { code: "ENOENT" },
  );
  await transaction.rollback();
});

test("imports only fixed-workspace carried Claude semantic queues and rolls back new copies", async () => {
  const fixture = await suffixFixture();
  const eligibleHash = "a".repeat(64);
  const otherHash = "b".repeat(64);
  const sourceRoot = join(fixture.homeDir, ".coredoc-dev", "capture-relay", "outbox");
  const targetRelayRoot = join(fixture.homeDir, ".coredoc", "capture-relay");
  const fixedName = "11111111-1111-4111-8111-111111111111.event.json";
  const otherName = "22222222-2222-4222-8222-222222222222.event.json";
  await mkdir(join(sourceRoot, eligibleHash), { recursive: true, mode: 0o700 });
  await mkdir(join(sourceRoot, otherHash), { recursive: true, mode: 0o700 });
  await mkdir(targetRelayRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(sourceRoot, ".DS_Store"), "benign metadata", { mode: 0o644 });
  await writeFile(join(sourceRoot, eligibleHash, fixedName), queuedEvent(fixedName.slice(0, 36)), { mode: 0o600 });
  await writeFile(
    join(sourceRoot, otherHash, otherName),
    queuedEvent(otherName.slice(0, 36), "392b1111-1111-4111-8111-111111111111"),
    { mode: 0o600 },
  );
  const sourceArtifactDirectory = join(
    fixture.homeDir,
    ".coredoc-dev",
    "capture-relay",
    "artifact-outbox",
    eligibleHash,
  );
  const artifactStore = createArtifactCheckpointStore({
    directory: sourceArtifactDirectory,
  });
  const markdown = "# Migrated artifact\n";
  const artifactDigest = createHash("sha256").update(markdown).digest("hex");
  artifactStore.enqueue({
    artifactId: "cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    digest: artifactDigest,
    body: {
      taskId: "cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      repositoryKey: "owner/repository",
      kind: "spec",
      checkpoint: "run-finish",
      markdown,
    },
  });

  const transaction = await prepareDesktopQueueImport({
    migration: {
      status: "desktop-v1",
      configPath: fixture.configPath,
      relayConfig: oldRelayConfig(),
    },
    targetRelayRoot,
    workspaceId: WORKSPACE_ID,
    uid: typeof process.getuid === "function" ? process.getuid() : 501,
  });
  assert.deepEqual(transaction.summary, {
    importedPending: 2,
    skippedOtherWorkspacePending: 1,
    skippedUnsupportedPending: 0,
  });
  await transaction.apply();
  const copied = join(targetRelayRoot, "outbox", eligibleHash, fixedName);
  assert.equal(await readFile(copied, "utf8"), queuedEvent(fixedName.slice(0, 36)));
  const copiedArtifactDirectory = join(
    targetRelayRoot,
    "artifact-outbox",
    eligibleHash,
  );
  const copiedArtifactNames = await readdir(copiedArtifactDirectory);
  assert.equal(copiedArtifactNames.includes("state.json"), true);
  assert.equal(
    copiedArtifactNames.some((name) => name.startsWith("revision-")),
    true,
  );
  await assert.rejects(
    readFile(join(targetRelayRoot, "outbox", otherHash, otherName)),
    { code: "ENOENT" },
  );

  await transaction.rollback();
  await assert.rejects(readFile(copied), { code: "ENOENT" });
  await assert.rejects(readdir(copiedArtifactDirectory), { code: "ENOENT" });
  assert.equal(
    await readFile(join(sourceRoot, eligibleHash, fixedName), "utf8"),
    queuedEvent(fixedName.slice(0, 36)),
  );
});

test("imports fixed-workspace artifacts even when the Desktop semantic outbox is absent", async () => {
  const fixture = await suffixFixture();
  const eligibleHash = "a".repeat(64);
  const sourceArtifactDirectory = join(
    fixture.homeDir,
    ".coredoc-dev",
    "capture-relay",
    "artifact-outbox",
    eligibleHash,
  );
  const artifactStore = createArtifactCheckpointStore({
    directory: sourceArtifactDirectory,
  });
  const markdown = "# Artifact without semantic outbox\n";
  artifactStore.enqueue({
    artifactId: "cda_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    digest: createHash("sha256").update(markdown).digest("hex"),
    body: {
      taskId: "cdt_ffffffff-ffff-4fff-8fff-ffffffffffff",
      repositoryKey: "owner/repository",
      kind: "spec",
      checkpoint: "run-finish",
      markdown,
    },
  });
  const targetRelayRoot = join(fixture.homeDir, ".coredoc", "capture-relay");
  await mkdir(targetRelayRoot, { recursive: true, mode: 0o700 });

  const transaction = await prepareDesktopQueueImport({
    migration: {
      status: "desktop-v1",
      configPath: fixture.configPath,
      relayConfig: oldRelayConfig(),
    },
    targetRelayRoot,
    workspaceId: WORKSPACE_ID,
    uid: typeof process.getuid === "function" ? process.getuid() : 501,
  });

  assert.deepEqual(transaction.summary, {
    importedPending: 1,
    skippedOtherWorkspacePending: 0,
    skippedUnsupportedPending: 0,
  });
  await transaction.apply();
  assert.equal(
    (await readdir(join(targetRelayRoot, "artifact-outbox", eligibleHash))).some(
      (name) => name.startsWith("revision-"),
    ),
    true,
  );
  await transaction.rollback();
});

test("queue import keeps identical destination files and rejects conflicting collisions", async () => {
  const fixture = await suffixFixture();
  const eligibleHash = "a".repeat(64);
  const name = "11111111-1111-4111-8111-111111111111.event.json";
  const source = join(
    fixture.homeDir,
    ".coredoc-dev",
    "capture-relay",
    "outbox",
    eligibleHash,
  );
  const targetRelayRoot = join(fixture.homeDir, ".coredoc", "capture-relay");
  const target = join(targetRelayRoot, "outbox", eligibleHash);
  await mkdir(source, { recursive: true, mode: 0o700 });
  await mkdir(target, { recursive: true, mode: 0o700 });
  const content = queuedEvent(name.slice(0, 36));
  await writeFile(join(source, name), content, { mode: 0o600 });
  await writeFile(join(target, name), content, { mode: 0o600 });
  const input = {
    migration: {
      status: "desktop-v1",
      configPath: fixture.configPath,
      relayConfig: oldRelayConfig(),
    },
    targetRelayRoot,
    workspaceId: WORKSPACE_ID,
    uid: typeof process.getuid === "function" ? process.getuid() : 501,
  };

  const idempotent = await prepareDesktopQueueImport(input);
  await idempotent.apply();
  await idempotent.rollback();
  assert.equal(await readFile(join(target, name), "utf8"), content);

  await writeFile(join(target, name), `${content}conflict`, { mode: 0o600 });
  await assert.rejects(
    prepareDesktopQueueImport(input),
    (error) =>
      error instanceof DesktopMigrationError && error.code === "DESKTOP_CONFLICT",
  );
});
