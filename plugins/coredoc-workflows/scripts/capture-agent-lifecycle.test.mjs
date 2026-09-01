import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "../test/test-api.mjs";

import {
  CAPTURE_AGENT_LABEL,
  DESKTOP_LAUNCH_AGENT_MARKER,
  PLUGIN_LAUNCH_AGENT_MARKER,
  CaptureAgentLifecycleError,
  acquireCaptureAgentFileLock,
  captureAgentPaths,
  createCaptureAgentLifecycle,
  loadRuntimeBundle,
  runCaptureAgentCli,
  runtimeDigestForManifest,
  validateCaptureAgentHealthV2,
} from "./capture-agent-lifecycle.mjs";

const run = promisify(execFile);
const systemNode = process.versions.bun
  ? execFileSync("/usr/bin/which", ["node"], { encoding: "utf8" }).trim()
  : process.execPath;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(pluginRoot, "bin", "coredoc-workflows");
const FIXTURE_UID =
  typeof process.getuid === "function" ? process.getuid() : 501;
const RUNTIME_FILES = [
  "scripts/managed-otel-relay.mjs",
  "scripts/native-otel-sanitizer.mjs",
  "scripts/capture-health-report.mjs",
  "scripts/codex-attribution-state.mjs",
  "scripts/codex-session-claim.mjs",
  "scripts/artifact-checkpoints.mjs",
  "scripts/capture-client.mjs",
  "scripts/project-key.mjs",
  "runtime/artifacts/contract.mjs",
  "runtime/capture/contract.mjs",
  "runtime/capture/file-outbox.mjs",
  "runtime/capture/health.mjs",
  "runtime/capture/index.mjs",
].sort();

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeFixture(version, salt) {
  const sourceRoot = mkdtempSync(join(tmpdir(), "coredoc-agent-bundle-"));
  const files = RUNTIME_FILES.map((path) => {
    const content = `export const fixture = ${JSON.stringify(`${salt}:${path}`)};\n`;
    const target = join(sourceRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return { path, sha256: digest(content) };
  });
  const manifest = {
    schemaVersion: 1,
    entry: "scripts/managed-otel-relay.mjs",
    files,
  };
  return {
    sourceRoot,
    version,
    manifest,
    runtimeDigest: runtimeDigestForManifest(manifest),
  };
}

function lifecycleHarness({
  bundle = runtimeFixture("1.0.0", "one"),
  probeListener = async () => false,
  probeHealth = async () => undefined,
  importSmoke = async () => undefined,
  renameRuntime = renameSync,
  runCommand = async () => undefined,
} = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "coredoc-agent-home-"));
  const coredocHome = join(homeDir, ".coredoc-test");
  const calls = [];
  let activeBundle = bundle;
  const dependencies = {
    env: { COREDOC_HOME: coredocHome },
    homeDir,
    pluginRoot,
    platform: "darwin",
    nodePath: systemNode,
    nodeVersion: "22.14.0",
    runtimeName: "node",
    uid: FIXTURE_UID,
    loadRuntimeBundle: () => activeBundle,
    runCommand: async (executable, args) => {
      calls.push([executable, args]);
      return runCommand(executable, args);
    },
    probeListener,
    probeHealth,
    renameRuntime,
    randomToken: () => "health_token_abcdefghijklmnopqrstuvwxyz0123456789",
    wait: async () => undefined,
  };
  if (importSmoke !== null) dependencies.importSmoke = importSmoke;
  const lifecycle = createCaptureAgentLifecycle(dependencies);
  return {
    homeDir,
    coredocHome,
    paths: captureAgentPaths({ env: { COREDOC_HOME: coredocHome }, homeDir }),
    calls,
    lifecycle,
    setBundle(next) {
      activeBundle = next;
    },
  };
}

function expectCode(code) {
  return (error) =>
    error instanceof CaptureAgentLifecycleError && error.code === code;
}

function waitForChildLine(child, expected) {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectPromise(new Error(`timed out waiting for child output: ${expected}`));
    }, 5_000);
    const onData = (chunk) => {
      output += chunk;
      if (!output.includes(expected)) return;
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      rejectPromise(
        new Error(`lock holder exited before readiness: ${code ?? signal}`),
      );
    };
    function cleanup() {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

test("the committed manifest is an exact verified 13-file importable runtime closure", async () => {
  const bundle = loadRuntimeBundle({ pluginRoot });
  assert.deepEqual(
    bundle.manifest.files.map(({ path }) => path).sort(),
    RUNTIME_FILES,
  );
  assert.equal(bundle.manifest.files.length, 13);
  const harness = lifecycleHarness({
    bundle,
    importSmoke: null,
  });
  const result = await harness.lifecycle.setupRuntime();
  const installed = join(
    harness.paths.runtimeVersionsDirectory,
    result.current.directoryName,
  );
  for (const file of bundle.manifest.files) {
    assert.equal(
      digest(readFileSync(join(installed, file.path))),
      file.sha256,
    );
    assert.equal(statSync(join(installed, file.path)).mode & 0o777, 0o444);
  }
  assert.equal(statSync(installed).mode & 0o777, 0o555);
});

test("runtime identity covers the manifest entry as well as file contents", () => {
  const bundle = runtimeFixture("1.0.0", "identity");
  const alternateEntry = {
    ...bundle.manifest,
    entry: "scripts/project-key.mjs",
  };
  assert.notEqual(
    runtimeDigestForManifest(bundle.manifest),
    runtimeDigestForManifest(alternateEntry),
  );
});

test("setup-runtime atomically installs one immutable runtime and plugin-owned LaunchAgent", async () => {
  const harness = lifecycleHarness();
  const result = await harness.lifecycle.setupRuntime();

  assert.equal(result.status, "ready");
  assert.equal(result.action, "setup-runtime");
  assert.equal(result.previous, null);
  assert.equal(lstatSync(harness.paths.statePath).mode & 0o777, 0o600);
  assert.equal(
    readlinkSync(harness.paths.currentPath),
    join("runtime", "versions", result.current.directoryName),
  );
  const state = JSON.parse(readFileSync(harness.paths.statePath, "utf8"));
  assert.equal(state.current.digest, result.current.digest);
  assert.equal(state.healthToken.startsWith("health_token_"), true);
  const plist = readFileSync(harness.paths.launchAgentPath, "utf8");
  assert.match(plist, new RegExp(PLUGIN_LAUNCH_AGENT_MARKER));
  assert.match(plist, new RegExp(`<string>${CAPTURE_AGENT_LABEL}</string>`));
  assert.match(plist, new RegExp(systemNode.replaceAll("/", "\\/")));
  assert.match(plist, new RegExp(result.current.directoryName));
  assert.match(plist, /capture-relay\/relay\.json/);
  assert.equal(plist.match(/<key>Program<\/key>/g)?.length, 1);
  assert.equal(plist.match(/<key>ProgramArguments<\/key>/g)?.length, 1);
  if (process.platform === "darwin") {
    await run("/usr/bin/plutil", ["-lint", harness.paths.launchAgentPath]);
  }
  assert.doesNotMatch(plist, /health_token_|Bearer/);
  assert.doesNotMatch(JSON.stringify(result), /health_token_|Users|capture-agent/);
  assert.equal(harness.calls.some(([, args]) => args[0] === "bootstrap"), true);
});

test("runtime staging keeps its root writable until the macOS-safe rename completes", async () => {
  let observedSourceMode = null;
  const harness = lifecycleHarness({
    renameRuntime: (source, destination) => {
      observedSourceMode = statSync(source).mode & 0o777;
      if ((observedSourceMode & 0o200) === 0) {
        const error = new Error(
          "macOS rejects renaming a write-disabled directory",
        );
        error.code = "EACCES";
        throw error;
      }
      renameSync(source, destination);
    },
  });

  const result = await harness.lifecycle.setupRuntime();
  const installed = join(
    harness.paths.runtimeVersionsDirectory,
    result.current.directoryName,
  );
  assert.equal(observedSourceMode, 0o700);
  assert.equal(statSync(installed).mode & 0o777, 0o555);
});

test("setup finalizes an exact writable runtime root left by a staging crash", async () => {
  const harness = lifecycleHarness();
  const first = await harness.lifecycle.setupRuntime();
  const installed = join(
    harness.paths.runtimeVersionsDirectory,
    first.current.directoryName,
  );

  chmodSync(installed, 0o700);
  unlinkSync(harness.paths.currentPath);
  unlinkSync(harness.paths.statePath);
  unlinkSync(harness.paths.launchAgentPath);

  const recovered = await harness.lifecycle.setupRuntime();
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.current.directoryName, first.current.directoryName);
  assert.equal(statSync(installed).mode & 0o777, 0o555);
});

test("upgrade health failure restores the previous runtime, state, plist, and process", async () => {
  let rejectedVersion = null;
  const harness = lifecycleHarness({
    probeHealth: async ({ runtimeVersion }) => {
      if (runtimeVersion === rejectedVersion) throw new Error("synthetic unhealthy");
    },
  });
  const installed = await harness.lifecycle.setupRuntime();
  const oldPlist = readFileSync(harness.paths.launchAgentPath, "utf8");
  const oldState = readFileSync(harness.paths.statePath, "utf8");
  const next = runtimeFixture("2.0.0", "two");
  harness.setBundle(next);
  rejectedVersion = "2.0.0";

  await assert.rejects(
    harness.lifecycle.upgrade(),
    (error) => {
      assert.equal(error.code, "HEALTH_MISMATCH");
      assert.equal(error.rollback, "restored");
      return true;
    },
  );

  assert.equal(readFileSync(harness.paths.statePath, "utf8"), oldState);
  assert.equal(readFileSync(harness.paths.launchAgentPath, "utf8"), oldPlist);
  assert.equal(
    readlinkSync(harness.paths.currentPath),
    join("runtime", "versions", installed.current.directoryName),
  );
  assert.equal(
    existsSync(join(harness.paths.runtimeVersionsDirectory, `${next.version}-${next.runtimeDigest}`)),
    false,
  );
});

test("explicit rollback swaps current and previous runtimes after authenticated health", async () => {
  const harness = lifecycleHarness();
  const first = await harness.lifecycle.setupRuntime();
  harness.setBundle(runtimeFixture("2.0.0", "two"));
  const second = await harness.lifecycle.upgrade();
  const rolledBack = await harness.lifecycle.rollback();

  assert.equal(rolledBack.current.digest, first.current.digest);
  assert.equal(rolledBack.previous.digest, second.current.digest);
  assert.equal(
    readlinkSync(harness.paths.currentPath),
    join("runtime", "versions", first.current.directoryName),
  );
});

test("retired-runtime cleanup failure does not roll back a healthy upgrade", async () => {
  let retiredDirectory;
  const harness = lifecycleHarness({
    probeHealth: async ({ runtimeVersion }) => {
      if (runtimeVersion === "3.0.0") chmodSync(retiredDirectory, 0o700);
    },
  });
  const first = await harness.lifecycle.setupRuntime();
  harness.setBundle(runtimeFixture("2.0.0", "two"));
  await harness.lifecycle.upgrade();
  retiredDirectory = join(
    harness.paths.runtimeVersionsDirectory,
    first.current.directoryName,
  );
  harness.setBundle(runtimeFixture("3.0.0", "three"));

  const result = await harness.lifecycle.upgrade();

  assert.equal(result.status, "ready");
  assert.equal(result.current.version, "3.0.0");
  assert.equal(existsSync(retiredDirectory), true);
  assert.equal(
    JSON.parse(readFileSync(harness.paths.statePath, "utf8")).current.version,
    "3.0.0",
  );
});

test("lifecycle refuses foreign and Desktop-v1 ownership before mutation", async () => {
  const unknown = lifecycleHarness();
  mkdirSync(dirname(unknown.paths.launchAgentPath), { recursive: true });
  writeFileSync(unknown.paths.launchAgentPath, "<plist><dict>foreign</dict></plist>\n");
  await assert.rejects(unknown.lifecycle.setupRuntime(), expectCode("OWNERSHIP_CONFLICT"));

  const occupied = lifecycleHarness({ probeListener: async () => true });
  await assert.rejects(occupied.lifecycle.setupRuntime(), expectCode("FOREIGN_LISTENER"));
  assert.equal(existsSync(occupied.paths.statePath), false);

  const desktop = lifecycleHarness({
    probeListener: async () => true,
  });
  const original = `<?xml version="1.0"?><plist><dict>${DESKTOP_LAUNCH_AGENT_MARKER}<key>Label</key><string>${CAPTURE_AGENT_LABEL}</string></dict></plist>\n`;
  mkdirSync(dirname(desktop.paths.launchAgentPath), { recursive: true });
  writeFileSync(desktop.paths.launchAgentPath, original, { mode: 0o600 });
  await assert.rejects(
    desktop.lifecycle.setupRuntime(),
    expectCode("OWNERSHIP_CONFLICT"),
  );
  assert.equal(readFileSync(desktop.paths.launchAgentPath, "utf8"), original);
  assert.equal(existsSync(desktop.paths.statePath), false);
  assert.equal(existsSync(desktop.paths.runtimeRoot), false);
  assert.deepEqual(desktop.calls, []);
});

test("kernel lifecycle lock serializes contenders and ignores orphaned takeover state", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-agent-lock-"));
  const lockPath = join(root, ".capture-agent-lifecycle.lock");
  const takeoverPath = `${lockPath}.takeover`;
  writeFileSync(takeoverPath, "orphaned legacy takeover\n", { mode: 0o600 });

  const release = acquireCaptureAgentFileLock(lockPath, { uid: FIXTURE_UID });
  const metadata = lstatSync(lockPath);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
  assert.equal(metadata.nlink, 1);
  assert.equal(metadata.uid, FIXTURE_UID);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.throws(
    () => acquireCaptureAgentFileLock(lockPath, { uid: FIXTURE_UID }),
    expectCode("LOCKED"),
  );

  release();
  release();
  const reacquired = acquireCaptureAgentFileLock(lockPath, {
    uid: FIXTURE_UID,
  });
  reacquired();

  assert.equal(lstatSync(lockPath).isFile(), true);
  assert.equal(
    readFileSync(takeoverPath, "utf8"),
    "orphaned legacy takeover\n",
  );
});

test(
  "kernel lifecycle lock is released automatically when its owner crashes",
  { skip: !new Set(["darwin", "linux"]).has(process.platform) },
  async (context) => {
    const root = mkdtempSync(join(tmpdir(), "coredoc-agent-lock-crash-"));
    const lockPath = join(root, ".capture-agent-lifecycle.lock");
    const lifecycleUrl = pathToFileURL(
      join(pluginRoot, "scripts", "capture-agent-lifecycle.mjs"),
    ).href;
    const child = spawn(
      systemNode,
      [
        "--input-type=module",
        "-e",
        `import { acquireCaptureAgentFileLock } from ${JSON.stringify(lifecycleUrl)};
const release = acquireCaptureAgentFileLock(${JSON.stringify(lockPath)}, { uid: ${FIXTURE_UID} });
process.stdout.write("locked\\n");
setInterval(() => {}, 1_000);
void release;`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    context.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    });
    await waitForChildLine(child, "locked\n");

    assert.throws(
      () => acquireCaptureAgentFileLock(lockPath, { uid: FIXTURE_UID }),
      expectCode("LOCKED"),
    );
    child.kill("SIGKILL");
    await once(child, "exit");

    const release = acquireCaptureAgentFileLock(lockPath, {
      uid: FIXTURE_UID,
    });
    release();
    assert.equal(lstatSync(lockPath).isFile(), true);
  },
);

test("kernel lifecycle lock fails closed for unsafe filesystem entries", () => {
  const symlinkRoot = mkdtempSync(join(tmpdir(), "coredoc-agent-lock-link-"));
  const symlinkTarget = join(symlinkRoot, "target");
  const symlinkPath = join(symlinkRoot, "lock");
  writeFileSync(symlinkTarget, "foreign\n", { mode: 0o600 });
  symlinkSync(symlinkTarget, symlinkPath);
  assert.throws(
    () => acquireCaptureAgentFileLock(symlinkPath, { uid: FIXTURE_UID }),
    expectCode("LOCKED"),
  );
  assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.equal(readFileSync(symlinkTarget, "utf8"), "foreign\n");

  const hardlinkRoot = mkdtempSync(join(tmpdir(), "coredoc-agent-lock-hardlink-"));
  const hardlinkTarget = join(hardlinkRoot, "target");
  const hardlinkPath = join(hardlinkRoot, "lock");
  writeFileSync(hardlinkTarget, "foreign\n", { mode: 0o600 });
  linkSync(hardlinkTarget, hardlinkPath);
  assert.throws(
    () => acquireCaptureAgentFileLock(hardlinkPath, { uid: FIXTURE_UID }),
    expectCode("LOCKED"),
  );
  assert.equal(lstatSync(hardlinkTarget).nlink, 2);
  assert.equal(readFileSync(hardlinkTarget, "utf8"), "foreign\n");

  const modeRoot = mkdtempSync(join(tmpdir(), "coredoc-agent-lock-mode-"));
  const modePath = join(modeRoot, "lock");
  writeFileSync(modePath, "foreign\n", { mode: 0o644 });
  assert.throws(
    () => acquireCaptureAgentFileLock(modePath, { uid: FIXTURE_UID }),
    expectCode("LOCKED"),
  );
  assert.equal(lstatSync(modePath).mode & 0o777, 0o644);
  assert.equal(readFileSync(modePath, "utf8"), "foreign\n");
});

test("status is read-only and redacted for both absent and installed agents", async () => {
  const harness = lifecycleHarness();
  const absent = await harness.lifecycle.status();
  assert.deepEqual(absent, {
    schemaVersion: 1,
    status: "not-installed",
    runtime: null,
    previousRuntime: null,
    launchAgent: "absent",
    listener: "free",
    health: "not-installed",
    pendingCount: 0,
    queueState: "empty",
    degradedReasons: [],
  });
  assert.equal(existsSync(harness.coredocHome), false);

  await harness.lifecycle.setupRuntime();
  const before = readFileSync(harness.paths.statePath, "utf8");
  const installed = await harness.lifecycle.status();
  assert.equal(installed.status, "ready");
  assert.equal(installed.launchAgent, "plugin-v1");
  assert.equal(installed.health, "ready");
  assert.equal(installed.queueState, "empty");
  assert.deepEqual(installed.degradedReasons, []);
  assert.doesNotMatch(JSON.stringify(installed), /health_token_|Users|capture-agent/);
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), before);
});

test("status propagates authenticated relay degradation while setup accepts its runtime identity", async () => {
  const harness = lifecycleHarness({
    probeHealth: async () => ({
      state: "degraded",
      degradedReasons: ["AUTH_REJECTED"],
    }),
  });
  const installed = await harness.lifecycle.setupRuntime();
  assert.equal(installed.status, "ready");

  const status = await harness.lifecycle.status();
  assert.equal(status.status, "degraded");
  assert.equal(status.health, "degraded");
  assert.equal(status.queueState, "empty");
  assert.equal(status.pendingCount, 0);
  assert.deepEqual(status.degradedReasons, ["AUTH_REJECTED"]);
  assert.doesNotMatch(JSON.stringify(status), /Bearer|Users|health_token_/);
});

test("disable unregisters the marker-owned LaunchAgent even when the listener is already down", async () => {
  const harness = lifecycleHarness({ probeListener: async () => false });
  await harness.lifecycle.setupRuntime();
  const state = readFileSync(harness.paths.statePath, "utf8");
  const plist = readFileSync(harness.paths.launchAgentPath, "utf8");

  const result = await harness.lifecycle.disable();

  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "disabled",
    preservedPending: 0,
  });
  assert.equal(
    harness.calls.some(([, args]) => args[0] === "bootout"),
    true,
  );
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), state);
  assert.equal(readFileSync(harness.paths.launchAgentPath, "utf8"), plist);
  assert.equal(existsSync(harness.paths.runtimeRoot), true);
});

test("authenticated health v2 accepts bounded diagnostics while enforcing runtime identity", () => {
  const expected = {
    runtimeVersion: "1.0.0",
    runtimeDigest: "a".repeat(64),
  };
  const health = {
    schemaVersion: 2,
    state: "degraded",
    runtimeVersion: expected.runtimeVersion,
    runtimeDigest: expected.runtimeDigest,
    protocolVersion: 1,
    configSchemaVersion: 1,
    fixedWorkspaceHash: "b".repeat(64),
    hostIngress: { claudeCode: "ready", codex: "unconfigured" },
    queueCounts: {
      native: 1,
      semantic: 2,
      artifact: 3,
      agent: 4,
      total: 10,
    },
    lastSuccessfulDeliveryAt: "2026-09-01T12:00:00.000Z",
    repositoryAttribution: "degraded",
    degradedReasons: [
      "CODEX_INGRESS_UNCONFIGURED",
      "REPOSITORY_ATTRIBUTION_DEGRADED",
    ],
  };
  assert.deepEqual(validateCaptureAgentHealthV2(health, expected), health);
  assert.throws(
    () =>
      validateCaptureAgentHealthV2(
        { ...health, degradedReasons: ["PRIVATE_PATH_/Users/example"] },
        expected,
      ),
    expectCode("HEALTH_MISMATCH"),
  );
  assert.throws(
    () =>
      validateCaptureAgentHealthV2(
        { ...health, runtimeDigest: "c".repeat(64) },
        expected,
      ),
    expectCode("HEALTH_MISMATCH"),
  );
});

test("status surfaces an unsafe queue scan instead of reporting zero pending", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const nativeRoot = join(harness.paths.relayRoot, "native-outbox");
  const bindingDirectory = join(
    nativeRoot,
    "44444444-4444-4444-8444-444444444444",
  );
  mkdirSync(bindingDirectory, { recursive: true, mode: 0o700 });
  chmodSync(nativeRoot, 0o700);
  chmodSync(bindingDirectory, 0o700);
  writeFileSync(join(bindingDirectory, "foreign.txt"), "keep\n", {
    mode: 0o600,
  });

  const status = await harness.lifecycle.status();
  assert.equal(status.status, "degraded");
  assert.equal(status.queueState, "unsafe");
  assert.equal(status.pendingCount, null);
  assert.deepEqual(status.degradedReasons, ["QUEUE_UNSAFE"]);
  assert.doesNotMatch(JSON.stringify(status), /foreign|Users|capture-agent/);
});

function seedPendingQueues(harness) {
  const bindingHash = "a".repeat(64);
  const semanticDirectory = join(
    harness.paths.relayRoot,
    "outbox",
    bindingHash,
  );
  mkdirSync(semanticDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(harness.paths.relayRoot, "outbox"), 0o700);
  chmodSync(semanticDirectory, 0o700);
  const eventPath = join(
    semanticDirectory,
    "11111111-1111-4111-8111-111111111111.event.json",
  );
  writeFileSync(eventPath, "{}\n", { mode: 0o600 });
  const captureHealthPath = join(semanticDirectory, "capture-health.json");
  writeFileSync(captureHealthPath, "{}\n", { mode: 0o600 });
  const artifactDirectory = join(
    harness.paths.relayRoot,
    "artifact-outbox",
    bindingHash,
  );
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(harness.paths.relayRoot, "artifact-outbox"), 0o700);
  chmodSync(artifactDirectory, 0o700);
  const artifactPath = join(
    artifactDirectory,
    `revision-000001-cda_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-${"a".repeat(64)}.json`,
  );
  writeFileSync(artifactPath, "{}\n", { mode: 0o600 });
  const artifactStatePath = join(artifactDirectory, "state.json");
  writeFileSync(artifactStatePath, "{}\n", { mode: 0o600 });
  const artifactQuarantinePath = join(
    artifactDirectory,
    `quarantine-000002-cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-${"b".repeat(64)}.json`,
  );
  writeFileSync(artifactQuarantinePath, "{}\n", { mode: 0o600 });
  const agentOutbox = join(harness.paths.agentRoot, "outbox");
  mkdirSync(agentOutbox, { recursive: true, mode: 0o700 });
  chmodSync(agentOutbox, 0o700);
  const agentPath = join(agentOutbox, "pending.json");
  writeFileSync(agentPath, "{}\n", { mode: 0o600 });
  const nativeBindingId = "22222222-2222-4222-8222-222222222222";
  const nativeRecordId = "33333333-3333-4333-8333-333333333333";
  const nativeRoot = join(harness.paths.relayRoot, "native-outbox");
  const nativeBindingDirectory = join(nativeRoot, nativeBindingId);
  mkdirSync(nativeRoot, { mode: 0o700 });
  mkdirSync(nativeBindingDirectory, { mode: 0o700 });
  chmodSync(nativeRoot, 0o700);
  chmodSync(nativeBindingDirectory, 0o700);
  const nativeRecordPath = join(
    nativeBindingDirectory,
    `${nativeRecordId}.native.json`,
  );
  writeFileSync(nativeRecordPath, "{}\n", { mode: 0o600 });
  const nativeStatePath = join(nativeBindingDirectory, "state.json");
  writeFileSync(nativeStatePath, "{}\n", { mode: 0o600 });
  const codexAttributionPath = join(
    harness.paths.relayRoot,
    "codex-attribution-state.json",
  );
  const codexJournalPath = join(
    harness.paths.relayRoot,
    "codex-relay-events.jsonl",
  );
  const rotatedCodexJournalPath = `${codexJournalPath}.1`;
  for (const path of [
    codexAttributionPath,
    codexJournalPath,
    rotatedCodexJournalPath,
  ]) {
    writeFileSync(path, "{}\n", { mode: 0o600 });
  }
  writeFileSync(harness.paths.relayConfigPath, "preserve-config\n", { mode: 0o600 });
  return {
    records: [eventPath, artifactPath, agentPath, nativeRecordPath],
    retainedState: [
      captureHealthPath,
      artifactStatePath,
      artifactQuarantinePath,
      nativeStatePath,
      codexAttributionPath,
      codexJournalPath,
      rotatedCodexJournalPath,
    ],
    agentOutbox,
    nativeStatePath,
  };
}

test("status and uninstall fail closed on unknown semantic queue entries", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const semanticRoot = join(harness.paths.relayRoot, "outbox");
  const bindingDirectory = join(semanticRoot, "b".repeat(64));
  mkdirSync(bindingDirectory, { recursive: true, mode: 0o700 });
  chmodSync(semanticRoot, 0o700);
  chmodSync(bindingDirectory, 0o700);
  const foreign = join(bindingDirectory, "foreign.txt");
  writeFileSync(foreign, "keep\n", { mode: 0o600 });

  const status = await harness.lifecycle.status();
  assert.equal(status.status, "degraded");
  assert.equal(status.queueState, "unsafe");
  assert.equal(status.pendingCount, null);
  assert.deepEqual(status.degradedReasons, ["QUEUE_UNSAFE"]);
  await assert.rejects(
    harness.lifecycle.preflightUninstall({ discardPending: true }),
    expectCode("UNSAFE_STATE"),
  );
  await assert.rejects(harness.lifecycle.uninstall(), expectCode("UNSAFE_STATE"));
  assert.equal(existsSync(foreign), true);
  assert.equal(existsSync(harness.paths.statePath), true);
});

test("uninstall preflight validates ownership and queues without mutation", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const pending = seedPendingQueues(harness);
  const stateBefore = readFileSync(harness.paths.statePath, "utf8");
  const plistBefore = readFileSync(harness.paths.launchAgentPath, "utf8");

  const preflight = await harness.lifecycle.preflightUninstall({
    discardPending: true,
  });
  assert.deepEqual(
    {
      ...preflight,
      purgeProof: undefined,
    },
    {
      schemaVersion: 1,
      status: "ready",
      installed: true,
      loaded: true,
      pendingCount: 4,
      disposition: "discard",
      purgeProof: undefined,
    },
  );
  assert.match(preflight.purgeProof.stateSha256, /^[0-9a-f]{64}$/);
  assert.match(preflight.purgeProof.launchAgentSha256, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), stateBefore);
  assert.equal(readFileSync(harness.paths.launchAgentPath, "utf8"), plistBefore);
  for (const path of [...pending.records, ...pending.retainedState]) {
    assert.equal(existsSync(path), true);
  }
});

test("uninstall preflight preserves the actual loaded state across disable", async () => {
  let loaded = false;
  const harness = lifecycleHarness({
    runCommand: async (_executable, args) => {
      if (args[0] === "bootstrap") {
        loaded = true;
        return;
      }
      if (args[0] === "bootout") {
        loaded = false;
        return;
      }
      if (args[0] === "print" && !loaded) {
        const error = new Error("not loaded");
        error.code = 113;
        error.stderr = `Could not find service "${CAPTURE_AGENT_LABEL}" in domain for user gui: ${FIXTURE_UID}`;
        throw error;
      }
    },
  });
  await harness.lifecycle.setupRuntime();
  assert.equal((await harness.lifecycle.preflightDisable()).loaded, true);
  assert.equal(
    (await harness.lifecycle.preflightUninstall()).loaded,
    true,
  );
  await harness.lifecycle.disable();
  assert.equal((await harness.lifecycle.preflightDisable()).loaded, false);
  assert.equal(
    (await harness.lifecycle.preflightUninstall()).loaded,
    false,
  );
});

test("start-installed-runtime never activates a newer plugin bundle", async () => {
  let loaded = false;
  const harness = lifecycleHarness({
    bundle: runtimeFixture("1.0.0", "installed"),
    runCommand: async (_executable, args) => {
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "print" && !loaded) {
        const error = new Error("not loaded");
        error.code = 113;
        error.stderr = `Could not find service "${CAPTURE_AGENT_LABEL}" in domain for user gui: ${FIXTURE_UID}`;
        throw error;
      }
    },
  });
  const installed = await harness.lifecycle.setupRuntime();
  harness.setBundle(runtimeFixture("2.0.0", "available"));
  await harness.lifecycle.disable();

  const restarted = await harness.lifecycle.startInstalledRuntime();

  assert.equal(restarted.current.version, "1.0.0");
  assert.equal(restarted.current.digest, installed.current.digest);
  assert.equal(
    readdirSync(harness.paths.runtimeVersionsDirectory).some((name) =>
      name.startsWith("2.0.0-"),
    ),
    false,
  );
});

test("purge receipt resumes after plist, link, and runtime-file deletion", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const preflight = await harness.lifecycle.preflightUninstall({
    discardPending: true,
  });
  const state = JSON.parse(readFileSync(harness.paths.statePath, "utf8"));
  const runtime = join(
    harness.paths.runtimeVersionsDirectory,
    state.current.directoryName,
  );
  const removedFile = join(runtime, state.current.files[0].path);
  unlinkSync(harness.paths.launchAgentPath);
  unlinkSync(harness.paths.currentPath);
  chmodSync(dirname(removedFile), 0o700);
  unlinkSync(removedFile);

  const result = await harness.lifecycle.uninstall({
    discardPending: true,
    purgeProof: preflight.purgeProof,
  });

  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.runtimeRoot), false);
});

test("purge receipt rejects unexpected content before continuing partial cleanup", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const preflight = await harness.lifecycle.preflightUninstall({
    discardPending: true,
  });
  const stateBefore = readFileSync(harness.paths.statePath, "utf8");
  const state = JSON.parse(stateBefore);
  const runtime = join(
    harness.paths.runtimeVersionsDirectory,
    state.current.directoryName,
  );
  unlinkSync(harness.paths.launchAgentPath);
  unlinkSync(harness.paths.currentPath);
  chmodSync(runtime, 0o700);
  const unexpected = join(runtime, "unexpected.txt");
  writeFileSync(unexpected, "do not delete\n", { mode: 0o600 });

  await assert.rejects(
    harness.lifecycle.uninstall({
      discardPending: true,
      purgeProof: preflight.purgeProof,
    }),
    expectCode("UNSAFE_STATE"),
  );

  assert.equal(readFileSync(harness.paths.statePath, "utf8"), stateBefore);
  assert.equal(readFileSync(unexpected, "utf8"), "do not delete\n");
});

test("default uninstall removes the agent while preserving recognized pending queues for recovery", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const pending = seedPendingQueues(harness);

  assert.equal((await harness.lifecycle.status()).pendingCount, 4);

  const result = await harness.lifecycle.uninstall();
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "uninstalled",
    preservedPending: 4,
    discardedPending: 0,
  });
  for (const path of pending.records) assert.equal(existsSync(path), true);
  for (const path of pending.retainedState) assert.equal(existsSync(path), true);
  assert.equal(existsSync(pending.agentOutbox), true);
  assert.equal(existsSync(pending.nativeStatePath), true);
  assert.equal(readFileSync(harness.paths.relayConfigPath, "utf8"), "preserve-config\n");
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.launchAgentPath), false);
  assert.equal(existsSync(harness.paths.runtimeRoot), false);
  assert.equal(existsSync(harness.paths.agentRoot), true);
  assert.equal((await harness.lifecycle.status()).pendingCount, 4);

  assert.deepEqual(await harness.lifecycle.uninstall(), result);
  assert.deepEqual(
    await harness.lifecycle.uninstall({ discardPending: true }),
    {
      schemaVersion: 1,
      status: "uninstalled",
      preservedPending: 0,
      discardedPending: 4,
    },
  );
  for (const path of pending.records) assert.equal(existsSync(path), false);
  for (const path of pending.retainedState) assert.equal(existsSync(path), false);
  assert.equal(existsSync(pending.agentOutbox), false);
});

test("default uninstall resumes after a prior attempt removed the plist but left state", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const state = JSON.parse(readFileSync(harness.paths.statePath, "utf8"));
  const runtimeDirectory = join(
    harness.paths.runtimeVersionsDirectory,
    state.current.directoryName,
  );
  const removedFile = join(runtimeDirectory, state.current.files[0].path);
  // A prior uninstall failed after deleting the LaunchAgent but before
  // deleting state.json, after a runtime file was already removed.
  unlinkSync(harness.paths.launchAgentPath);
  unlinkSync(harness.paths.currentPath);
  chmodSync(dirname(removedFile), 0o700);
  unlinkSync(removedFile);

  const result = await harness.lifecycle.uninstall();
  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.runtimeRoot), false);
});

test("discarding pending data from partially uninstalled state still requires a proof", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  unlinkSync(harness.paths.launchAgentPath);

  await assert.rejects(
    harness.lifecycle.uninstall({ discardPending: true }),
    expectCode("OWNERSHIP_CONFLICT"),
  );
});

test("purge validates auxiliary state before deleting any queued record", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const pending = seedPendingQueues(harness);
  const journal = pending.retainedState.find((path) =>
    path.endsWith("codex-relay-events.jsonl"),
  );
  chmodSync(journal, 0o644);

  await assert.rejects(
    harness.lifecycle.uninstall({ discardPending: true }),
    expectCode("UNSAFE_STATE"),
  );
  for (const path of [...pending.records, ...pending.retainedState]) {
    assert.equal(existsSync(path), true);
  }
  assert.equal(existsSync(harness.paths.statePath), true);
});

test("purge rejects a dangling auxiliary-state symlink", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const journal = join(harness.paths.relayRoot, "codex-relay-events.jsonl");
  mkdirSync(harness.paths.relayRoot, { recursive: true, mode: 0o700 });
  chmodSync(harness.paths.relayRoot, 0o700);
  symlinkSync(join(harness.homeDir, "missing-journal"), journal);

  await assert.rejects(
    harness.lifecycle.preflightUninstall({ discardPending: true }),
    expectCode("UNSAFE_STATE"),
  );
  assert.equal(lstatSync(journal).isSymbolicLink(), true);
  assert.equal(existsSync(harness.paths.statePath), true);
});

test("uninstall fails before filesystem mutation when launchd still owns the service", async () => {
  const harness = lifecycleHarness({
    runCommand: async (_executable, args) => {
      if (args[0] === "bootout") {
        const error = new Error("PRIVATE supervisor failure");
        error.code = 5;
        throw error;
      }
      if (args[0] === "print") return undefined;
    },
  });
  await harness.lifecycle.setupRuntime();
  const state = readFileSync(harness.paths.statePath, "utf8");
  const plist = readFileSync(harness.paths.launchAgentPath, "utf8");

  await assert.rejects(
    harness.lifecycle.uninstall(),
    expectCode("SUPERVISOR_UNAVAILABLE"),
  );
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), state);
  assert.equal(readFileSync(harness.paths.launchAgentPath, "utf8"), plist);
  assert.equal(existsSync(harness.paths.runtimeRoot), true);
  assert.equal(
    harness.calls.some(([, args]) => args[0] === "print"),
    true,
  );
});

test("uninstall tolerates bootout failure only when launchd proves the service is absent", async () => {
  const harness = lifecycleHarness({
    runCommand: async (_executable, args) => {
      if (args[0] === "bootout") throw new Error("PRIVATE bootout failure");
      if (args[0] === "print") {
        const error = new Error("PRIVATE not loaded");
        error.code = 113;
        error.stderr = `Bad request.\nCould not find service "${CAPTURE_AGENT_LABEL}" in domain for user gui: ${FIXTURE_UID}\n`;
        throw error;
      }
    },
  });
  await harness.lifecycle.setupRuntime();

  const result = await harness.lifecycle.uninstall();
  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.launchAgentPath), false);
});

test("uninstall refuses mutation while the relay listener remains occupied after bootout", async () => {
  let listenerOccupied = false;
  const harness = lifecycleHarness({
    probeListener: async () => listenerOccupied,
  });
  await harness.lifecycle.setupRuntime();
  listenerOccupied = true;
  const state = readFileSync(harness.paths.statePath, "utf8");

  await assert.rejects(
    harness.lifecycle.uninstall(),
    expectCode("SUPERVISOR_UNAVAILABLE"),
  );
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), state);
  assert.equal(existsSync(harness.paths.launchAgentPath), true);
  assert.equal(existsSync(harness.paths.runtimeRoot), true);
});

test("uninstall rescans and preserves a final semantic event written during shutdown", async () => {
  let harness;
  let listenerOccupied = false;
  let finalEntryPath;
  harness = lifecycleHarness({
    probeListener: async () => listenerOccupied,
    runCommand: async (_executable, args) => {
      if (args[0] !== "bootout") return;
      const directory = join(
        harness.paths.relayRoot,
        "outbox",
        "c".repeat(64),
      );
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(join(harness.paths.relayRoot, "outbox"), 0o700);
      chmodSync(directory, 0o700);
      finalEntryPath = join(
        directory,
        "77777777-7777-4777-8777-777777777777.event.json",
      );
      writeFileSync(finalEntryPath, "{}\n", { mode: 0o600 });
      listenerOccupied = false;
    },
  });
  await harness.lifecycle.setupRuntime();
  listenerOccupied = true;

  const result = await harness.lifecycle.uninstall();
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "uninstalled",
    preservedPending: 1,
    discardedPending: 0,
  });
  assert.equal(existsSync(finalEntryPath), true);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("explicit discard deletes all recognized pending and retained capture state", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  const pending = seedPendingQueues(harness);

  const result = await harness.lifecycle.uninstall({ discardPending: true });
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: "uninstalled",
    preservedPending: 0,
    discardedPending: 4,
  });
  for (const path of pending.records) assert.equal(existsSync(path), false);
  for (const path of pending.retainedState) assert.equal(existsSync(path), false);
  assert.equal(existsSync(pending.agentOutbox), false);
  assert.equal(readFileSync(harness.paths.relayConfigPath, "utf8"), "preserve-config\n");
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.launchAgentPath), false);
});

test("uninstall fails closed for unknown or symlinked native outbox entries", async () => {
  const unknown = lifecycleHarness();
  await unknown.lifecycle.setupRuntime();
  const unknownBindingDirectory = join(
    unknown.paths.relayRoot,
    "native-outbox",
    "44444444-4444-4444-8444-444444444444",
  );
  mkdirSync(unknownBindingDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(unknown.paths.relayRoot, "native-outbox"), 0o700);
  chmodSync(unknownBindingDirectory, 0o700);
  const unknownPath = join(unknownBindingDirectory, "foreign.txt");
  writeFileSync(unknownPath, "keep\n", { mode: 0o600 });

  await assert.rejects(
    unknown.lifecycle.uninstall(),
    expectCode("UNSAFE_STATE"),
  );
  assert.equal(existsSync(unknownPath), true);
  assert.equal(existsSync(unknown.paths.statePath), true);

  const symlinked = lifecycleHarness();
  await symlinked.lifecycle.setupRuntime();
  const symlinkBindingDirectory = join(
    symlinked.paths.relayRoot,
    "native-outbox",
    "55555555-5555-4555-8555-555555555555",
  );
  mkdirSync(symlinkBindingDirectory, { recursive: true, mode: 0o700 });
  chmodSync(join(symlinked.paths.relayRoot, "native-outbox"), 0o700);
  chmodSync(symlinkBindingDirectory, 0o700);
  const symlinkPath = join(
    symlinkBindingDirectory,
    "66666666-6666-4666-8666-666666666666.native.json",
  );
  symlinkSync(symlinked.paths.relayConfigPath, symlinkPath);

  await assert.rejects(
    symlinked.lifecycle.uninstall({ discardPending: true }),
    expectCode("UNSAFE_STATE"),
  );
  assert.equal(lstatSync(symlinkPath).isSymbolicLink(), true);
  assert.equal(existsSync(symlinked.paths.statePath), true);
});

test("capture-agent CLI passes explicit discard intent and emits queue disposition counts", async () => {
  const calls = [];
  const output = [];
  const lifecycle = {
    uninstall: async (options) => {
      calls.push(options);
      return {
        schemaVersion: 1,
        status: "uninstalled",
        preservedPending: options.discardPending ? 0 : 3,
        discardedPending: options.discardPending ? 3 : 0,
      };
    },
  };
  assert.equal(
    await runCaptureAgentCli({
      args: ["uninstall"],
      lifecycle,
      write: (value) => output.push(value),
    }),
    0,
  );
  assert.equal(
    await runCaptureAgentCli({
      args: ["uninstall", "--discard-pending"],
      lifecycle,
      write: (value) => output.push(value),
    }),
    0,
  );
  assert.deepEqual(calls, [
    { discardPending: false },
    { discardPending: true },
  ]);
  assert.deepEqual(output.map((line) => JSON.parse(line)), [
    {
      schemaVersion: 1,
      status: "uninstalled",
      preservedPending: 3,
      discardedPending: 0,
    },
    {
      schemaVersion: 1,
      status: "uninstalled",
      preservedPending: 0,
      discardedPending: 3,
    },
  ]);
});

test("lifecycle core enforces macOS and Node 22 before mutation", async () => {
  const base = lifecycleHarness();
  const linux = createCaptureAgentLifecycle({
    env: { COREDOC_HOME: join(base.homeDir, "linux") },
    homeDir: base.homeDir,
    pluginRoot,
    platform: "linux",
    nodePath: process.execPath,
    nodeVersion: "22.0.0",
    runtimeName: "node",
  });
  await assert.rejects(linux.setupRuntime(), expectCode("UNSUPPORTED_PLATFORM"));
  const oldNode = createCaptureAgentLifecycle({
    env: { COREDOC_HOME: join(base.homeDir, "old-node") },
    homeDir: base.homeDir,
    pluginRoot,
    platform: "darwin",
    nodePath: process.execPath,
    nodeVersion: "20.0.0",
    runtimeName: "node",
  });
  await assert.rejects(oldNode.setupRuntime(), expectCode("NODE_UNAVAILABLE"));
  const bunRuntime = createCaptureAgentLifecycle({
    env: { COREDOC_HOME: join(base.homeDir, "bun-runtime") },
    homeDir: base.homeDir,
    pluginRoot,
    platform: "darwin",
    nodePath: process.execPath,
    nodeVersion: "24.0.0",
    runtimeName: "bun",
  });
  await assert.rejects(bunRuntime.setupRuntime(), expectCode("NODE_UNAVAILABLE"));
});

test(
  "launcher does not expose raw lifecycle or setup bypass commands",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "coredoc-agent-cli-"));
    for (const command of ["capture-agent", "capture-agent-setup"]) {
      await assert.rejects(
        run(launcher, [command, "status"], {
          env: {
            PATH: dirname(systemNode),
            HOME: root,
            COREDOC_HOME: join(root, ".coredoc"),
          },
        }),
        (error) => {
          assert.equal(error.code, 64);
          assert.match(error.stderr, new RegExp(`unknown command: ${command}`));
          return true;
        },
      );
    }
    assert.equal(existsSync(join(root, ".coredoc")), false);
  },
);
