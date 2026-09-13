import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
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
  CAPTURE_AGENT_UNIT,
  DESKTOP_CAPTURE_AGENT_LABEL,
  DESKTOP_LAUNCH_AGENT_MARKER,
  PLUGIN_LAUNCH_AGENT_MARKER,
  PLUGIN_SYSTEMD_UNIT_MARKER,
  CaptureAgentLifecycleError,
  acquireCaptureAgentFileLock,
  buildCaptureAgentSystemdUnit,
  captureAgentPaths,
  captureAgentPlatformKey,
  createCaptureAgentLifecycle,
  loadRuntimeBundle,
  runCaptureAgentCli,
  runtimeDigestForManifest,
  supervisorEnvironment,
  validateCaptureAgentHealthV2,
} from "./capture-agent-lifecycle.mjs";

const run = promisify(execFile);
const testRuntime = process.execPath;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(pluginRoot, "bin", "coredoc-workflows");
const FIXTURE_UID =
  typeof process.getuid === "function" ? process.getuid() : 501;
const SHARED_RUNTIME_FILES = [
  "scripts/managed-otel-relay.mjs",
  "scripts/native-otel-sanitizer.mjs",
  "scripts/capture-health-report.mjs",
  "scripts/codex-attribution-state.mjs",
  "scripts/codex-session-claim.mjs",
  "scripts/artifact-checkpoints.mjs",
  "scripts/capture-client.mjs",
  "scripts/project-key.mjs",
  "runtime/artifacts/contract.mjs",
  "runtime/bun/bunfig.toml",
  "runtime/bun/runner",
  "runtime/capture/contract.mjs",
  "runtime/capture/file-outbox.mjs",
  "runtime/capture/health.mjs",
  "runtime/capture/index.mjs",
];
const PLATFORM_RUNTIME_EXECUTABLES = {
  "darwin-arm64": "runtime/bun/darwin-arm64/bun",
  "linux-x64": "runtime/bun/linux-x64/bun",
};

function runtimeFilesFor(platformKey) {
  return [
    ...SHARED_RUNTIME_FILES,
    PLATFORM_RUNTIME_EXECUTABLES[platformKey],
  ].sort();
}

const RUNTIME_FILES = runtimeFilesFor("darwin-arm64");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeFixture(version, salt, platformKey = "darwin-arm64") {
  const sourceRoot = mkdtempSync(join(tmpdir(), "coredoc-agent-bundle-"));
  const files = runtimeFilesFor(platformKey).map((path) => {
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

function systemdRunCommand({ activeState = "inactive" } = {}) {
  const states = Array.isArray(activeState) ? [...activeState] : null;
  return async (executable, args) => {
    if (args.includes("show")) {
      return `${states === null ? activeState : (states.shift() ?? "inactive")}\n`;
    }
    return undefined;
  };
}

function lifecycleHarness({
  platform = "darwin",
  arch = platform === "linux" ? "x64" : "arm64",
  bundle = runtimeFixture(
    "1.0.0",
    "one",
    platform === "linux" ? "linux-x64" : "darwin-arm64",
  ),
  probeListener = async () => false,
  probeHealth = async () => undefined,
  importSmoke = async () => undefined,
  onLoadRuntimeBundle = () => undefined,
  renameRuntime = renameSync,
  runCommand = platform === "linux" ? systemdRunCommand() : async () => undefined,
} = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "coredoc-agent-home-"));
  const coredocHome = join(homeDir, ".coredoc-test");
  const calls = [];
  let activeBundle = bundle;
  const dependencies = {
    env: { COREDOC_HOME: coredocHome },
    homeDir,
    pluginRoot,
    platform,
    arch,
    uid: FIXTURE_UID,
    loadRuntimeBundle: () => {
      onLoadRuntimeBundle();
      return activeBundle;
    },
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
    paths: captureAgentPaths({
      env: { COREDOC_HOME: coredocHome },
      homeDir,
      platform,
    }),
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

test("plugin-managed relay paths are disjoint from legacy Desktop ownership", () => {
  const homeDir = "/Users/test";
  const coredocHome = join(homeDir, ".coredoc");
  const paths = captureAgentPaths({
    env: { COREDOC_HOME: coredocHome },
    homeDir,
    platform: "darwin",
  });

  assert.equal(CAPTURE_AGENT_LABEL, "ai.coredoc.workflows.capture-relay");
  assert.equal(
    paths.servicePath,
    join(homeDir, "Library", "LaunchAgents", `${CAPTURE_AGENT_LABEL}.plist`),
  );
  assert.equal(
    paths.legacyServicePath,
    join(
      homeDir,
      "Library",
      "LaunchAgents",
      `${DESKTOP_CAPTURE_AGENT_LABEL}.plist`,
    ),
  );
  assert.equal(paths.relayRoot, join(coredocHome, "capture-agent", "capture-relay"));
  assert.equal(paths.desktopRelayRoot, join(coredocHome, "capture-relay"));
  assert.notEqual(paths.servicePath, paths.legacyServicePath);
  assert.notEqual(paths.relayRoot, paths.desktopRelayRoot);
  assert.notEqual(CAPTURE_AGENT_LABEL, DESKTOP_CAPTURE_AGENT_LABEL);
});

test("Linux installs a systemd user unit and has no legacy Desktop namespace", () => {
  const homeDir = "/home/test";
  const coredocHome = join(homeDir, ".coredoc");
  const paths = captureAgentPaths({
    env: { COREDOC_HOME: coredocHome },
    homeDir,
    platform: "linux",
  });

  assert.equal(
    paths.servicePath,
    join(homeDir, ".config", "systemd", "user", CAPTURE_AGENT_UNIT),
  );
  assert.equal(CAPTURE_AGENT_UNIT, `${CAPTURE_AGENT_LABEL}.service`);
  assert.equal(paths.legacyServicePath, null);
  assert.equal(
    paths.relayRoot,
    join(coredocHome, "capture-agent", "capture-relay"),
  );
  assert.equal(
    paths.statePath,
    join(coredocHome, "capture-agent", "state.json"),
  );
});

test("every vendored Bun matches its recorded provenance and the manifest", () => {
  const provenance = JSON.parse(
    readFileSync(join(pluginRoot, "runtime", "bun", "provenance.json"), "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(
      join(pluginRoot, "runtime", "capture-agent-manifest.json"),
      "utf8",
    ),
  );

  assert.deepEqual(
    Object.keys(provenance.platforms).sort(),
    Object.keys(PLATFORM_RUNTIME_EXECUTABLES).sort(),
  );
  assert.deepEqual(
    Object.keys(manifest.platforms).sort(),
    Object.keys(PLATFORM_RUNTIME_EXECUTABLES).sort(),
  );
  for (const [platformKey, recorded] of Object.entries(provenance.platforms)) {
    const binary = join(pluginRoot, "runtime", "bun", recorded.binary);
    assert.equal(
      join("runtime", "bun", recorded.binary),
      PLATFORM_RUNTIME_EXECUTABLES[platformKey],
    );
    assert.equal(digest(readFileSync(binary)), recorded.sha256);
    assert.equal(statSync(binary).size, recorded.sizeBytes);
    // The manifest is what installation verifies; provenance is what an
    // auditor verifies. They have to name the same bytes.
    assert.equal(manifest.platforms[platformKey].sha256, recorded.sha256);
  }
});

test("only vendored host builds resolve to a platform key", () => {
  assert.equal(
    captureAgentPlatformKey({ platform: "darwin", arch: "arm64" }),
    "darwin-arm64",
  );
  assert.equal(
    captureAgentPlatformKey({ platform: "linux", arch: "x64" }),
    "linux-x64",
  );
  for (const unsupported of [
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "arm64" },
    { platform: "win32", arch: "x64" },
  ]) {
    assert.throws(
      () => captureAgentPlatformKey(unsupported),
      expectCode("UNSUPPORTED_PLATFORM"),
    );
  }
  assert.throws(
    () => captureAgentPaths({ env: {}, homeDir: "/home/test", platform: "win32" }),
    expectCode("UNSUPPORTED_PLATFORM"),
  );
});

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

test("the committed manifest is an exact verified self-contained runtime closure", async () => {
  const bundle = loadRuntimeBundle({
    pluginRoot,
    platformKey: "darwin-arm64",
  });
  const canRunBundledRuntime =
    process.platform === "darwin" && process.arch === "arm64";
  assert.deepEqual(
    bundle.manifest.files.map(({ path }) => path).sort(),
    RUNTIME_FILES,
  );
  assert.equal(bundle.manifest.files.length, 16);
  const linuxBundle = loadRuntimeBundle({
    pluginRoot,
    platformKey: "linux-x64",
  });
  assert.deepEqual(
    linuxBundle.manifest.files.map(({ path }) => path).sort(),
    runtimeFilesFor("linux-x64"),
  );
  // Each host stages its own Bun, so the two closures cannot share a digest.
  assert.notEqual(linuxBundle.runtimeDigest, bundle.runtimeDigest);
  assert.throws(
    () => loadRuntimeBundle({ pluginRoot, platformKey: "linux-arm64" }),
    expectCode("UNSUPPORTED_PLATFORM"),
  );
  const harness = lifecycleHarness({
    bundle,
    importSmoke: canRunBundledRuntime ? null : async () => undefined,
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
    assert.equal(
      statSync(join(installed, file.path)).mode & 0o777,
      new Set([
        "runtime/bun/darwin-arm64/bun",
        "runtime/bun/runner",
      ]).has(file.path)
        ? 0o555
        : 0o444,
    );
  }
  assert.equal(statSync(installed).mode & 0o777, 0o555);

  if (canRunBundledRuntime) {
    const runtimeHome = mkdtempSync(join(tmpdir(), "coredoc-installed-bun-home-"));
    writeFileSync(
      join(runtimeHome, ".env"),
      "COREDOC_WORKFLOWS_REPO_KEY=must-not-load\n",
    );
    const { stdout } = await run(
      join(installed, "runtime/bun/runner"),
      [
        "--eval",
        'process.stdout.write(JSON.stringify(["COREDOC_WORKFLOWS_REPO_KEY", "BUN_INSPECT", "BUN_INSPECT_CONNECT_TO", "BUN_INSPECT_NOTIFY", "BUN_JS_DEBUG"].map((name) => process.env[name] ?? "unset")))',
      ],
      {
        cwd: runtimeHome,
        env: {
          HOME: runtimeHome,
          PATH: mkdtempSync(join(tmpdir(), "coredoc-installed-bun-path-")),
          BUN_OPTIONS: "--preload=/definitely/not/present.mjs",
          BUN_INSPECT: "1",
          BUN_INSPECT_CONNECT_TO: "http://127.0.0.1:1",
          BUN_INSPECT_NOTIFY: "1",
          BUN_INSPECT_PRELOAD: "/definitely/not/present.mjs",
          BUN_JS_DEBUG: "1",
          NODE_OPTIONS: "--require=/definitely/not/present.cjs",
        },
      },
    );
    assert.deepEqual(JSON.parse(stdout), Array(5).fill("unset"));
    assert.equal(existsSync(join(runtimeHome, "Library", "Caches", "bun")), false);
  }
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

test("a tampered bundled Bun is rejected before runtime activation", async () => {
  const bundle = runtimeFixture("1.0.0", "tampered-bun");
  writeFileSync(
    join(bundle.sourceRoot, "runtime/bun/darwin-arm64/bun"),
    "tampered\n",
  );
  const harness = lifecycleHarness({ bundle });

  await assert.rejects(
    harness.lifecycle.setupRuntime(),
    expectCode("INVALID_RUNTIME_MANIFEST"),
  );
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.servicePath), false);
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
  const definition = readFileSync(harness.paths.servicePath, "utf8");
  assert.match(definition, new RegExp(PLUGIN_LAUNCH_AGENT_MARKER));
  assert.match(definition, new RegExp(`<string>${CAPTURE_AGENT_LABEL}</string>`));
  assert.equal(
    definition.includes(
      join(
        harness.paths.runtimeVersionsDirectory,
        result.current.directoryName,
        "runtime/bun/runner",
      ),
    ),
    true,
  );
  assert.equal(definition.includes(pluginRoot), false);
  assert.match(definition, new RegExp(result.current.directoryName));
  assert.match(definition, /capture-relay\/relay\.json/);
  assert.equal(definition.match(/<key>Program<\/key>/g)?.length, 1);
  assert.equal(definition.match(/<key>ProgramArguments<\/key>/g)?.length, 1);
  if (process.platform === "darwin") {
    await run("/usr/bin/plutil", ["-lint", harness.paths.servicePath]);
  }
  assert.doesNotMatch(definition, /health_token_|Bearer/);
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
  unlinkSync(harness.paths.servicePath);

  const recovered = await harness.lifecycle.setupRuntime();
  assert.equal(recovered.status, "ready");
  assert.equal(recovered.current.directoryName, first.current.directoryName);
  assert.equal(statSync(installed).mode & 0o777, 0o555);
});

test("upgrade health failure restores the previous runtime, state, definition, and process", async () => {
  let rejectedVersion = null;
  const harness = lifecycleHarness({
    probeHealth: async ({ runtimeVersion }) => {
      if (runtimeVersion === rejectedVersion) throw new Error("synthetic unhealthy");
    },
  });
  const installed = await harness.lifecycle.setupRuntime();
  const oldDefinition = readFileSync(harness.paths.servicePath, "utf8");
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
  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), oldDefinition);
  assert.equal(
    readlinkSync(harness.paths.currentPath),
    join("runtime", "versions", installed.current.directoryName),
  );
  assert.equal(
    existsSync(join(harness.paths.runtimeVersionsDirectory, `${next.version}-${next.runtimeDigest}`)),
    false,
  );
});

test("upgrade health failure preserves a previously disabled LaunchAgent", async () => {
  let pluginLoaded = false;
  let desktopLoaded = false;
  let rejectedVersion = null;
  const legacyDefinition = `<?xml version="1.0"?><plist><dict>${DESKTOP_LAUNCH_AGENT_MARKER}<key>Label</key><string>${DESKTOP_CAPTURE_AGENT_LABEL}</string></dict></plist>\n`;
  const serviceNotFound = (label) => {
    const error = new Error("launchd service is not loaded");
    error.code = 113;
    error.stderr = `Could not find service "${label}" in domain for user gui: ${FIXTURE_UID}`;
    return error;
  };
  const harness = lifecycleHarness({
    runCommand: async (_executable, args) => {
      if (args[0] === "bootstrap") {
        pluginLoaded = true;
        return;
      }
      if (args[0] === "bootout") {
        pluginLoaded = false;
        return;
      }
      if (args[0] === "print") {
        const label = args[1].slice(args[1].lastIndexOf("/") + 1);
        const loaded =
          label === CAPTURE_AGENT_LABEL
            ? pluginLoaded
            : label === DESKTOP_CAPTURE_AGENT_LABEL && desktopLoaded;
        if (loaded) return;
        throw serviceNotFound(label);
      }
    },
    probeListener: async () => pluginLoaded || desktopLoaded,
    probeHealth: async ({ runtimeVersion }) => {
      if (runtimeVersion === rejectedVersion) {
        writeFileSync(harness.paths.legacyServicePath, legacyDefinition, {
          mode: 0o600,
        });
        desktopLoaded = true;
        throw new Error("synthetic unhealthy");
      }
    },
  });
  const installed = await harness.lifecycle.setupRuntime();
  await harness.lifecycle.disable();
  assert.equal(pluginLoaded, false);
  const oldDefinition = readFileSync(harness.paths.servicePath, "utf8");
  const oldState = readFileSync(harness.paths.statePath, "utf8");
  harness.setBundle(runtimeFixture("2.0.0", "disabled-upgrade"));
  rejectedVersion = "2.0.0";

  await assert.rejects(harness.lifecycle.upgrade(), (error) => {
    assert.equal(error.code, "HEALTH_MISMATCH");
    assert.equal(error.rollback, "restored");
    return true;
  });

  assert.equal(pluginLoaded, false);
  assert.equal(desktopLoaded, true);
  assert.equal(
    readFileSync(harness.paths.legacyServicePath, "utf8"),
    legacyDefinition,
  );
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), oldState);
  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), oldDefinition);
  assert.equal(
    readlinkSync(harness.paths.currentPath),
    join("runtime", "versions", installed.current.directoryName),
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

test("disabled rollback restores an unhealthy prior runtime without starting it", async () => {
  let pluginLoaded = false;
  let rejectedVersion = null;
  const healthVersions = [];
  const serviceNotFound = (label) => {
    const error = new Error("launchd service is not loaded");
    error.code = 113;
    error.stderr = `Could not find service "${label}" in domain for user gui: ${FIXTURE_UID}`;
    return error;
  };
  const harness = lifecycleHarness({
    runCommand: async (_executable, args) => {
      if (args[0] === "bootstrap") {
        pluginLoaded = true;
        return;
      }
      if (args[0] === "bootout") {
        pluginLoaded = false;
        return;
      }
      if (args[0] === "print") {
        if (pluginLoaded) return;
        throw serviceNotFound(args[1].slice(args[1].lastIndexOf("/") + 1));
      }
    },
    probeListener: async () => pluginLoaded,
    probeHealth: async ({ runtimeVersion }) => {
      healthVersions.push(runtimeVersion);
      if (runtimeVersion === rejectedVersion) {
        throw new Error("dormant prior runtime is unhealthy");
      }
    },
  });
  const first = await harness.lifecycle.setupRuntime();
  harness.setBundle(runtimeFixture("2.0.0", "two"));
  const second = await harness.lifecycle.upgrade();
  assert.equal(pluginLoaded, true);
  rejectedVersion = first.current.version;
  healthVersions.length = 0;
  const commandCountBeforeRollback = harness.calls.length;

  const rolledBack = await harness.lifecycle.rollback({ start: false });

  assert.equal(rolledBack.status, "disabled");
  assert.equal(rolledBack.current.digest, first.current.digest);
  assert.equal(rolledBack.previous.digest, second.current.digest);
  assert.equal(pluginLoaded, false);
  assert.deepEqual(healthVersions, []);
  assert.equal(
    harness.calls
      .slice(commandCountBeforeRollback)
      .some(([, args]) => args[0] === "bootstrap"),
    false,
  );
  assert.equal(
    harness.calls
      .slice(commandCountBeforeRollback)
      .some(([, args]) => args[0] === "bootout"),
    true,
  );
  assert.equal(
    readlinkSync(harness.paths.currentPath),
    join("runtime", "versions", first.current.directoryName),
  );
  assert.equal(
    readFileSync(harness.paths.servicePath, "utf8").includes(
      first.current.digest,
    ),
    true,
  );
  assert.equal((await harness.lifecycle.preflightDisable()).loaded, false);
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
  mkdirSync(dirname(unknown.paths.servicePath), { recursive: true });
  writeFileSync(unknown.paths.servicePath, "<plist><dict>foreign</dict></plist>\n");
  await assert.rejects(unknown.lifecycle.setupRuntime(), expectCode("OWNERSHIP_CONFLICT"));

  const occupied = lifecycleHarness({ probeListener: async () => true });
  await assert.rejects(occupied.lifecycle.setupRuntime(), expectCode("FOREIGN_LISTENER"));
  assert.equal(existsSync(occupied.paths.statePath), false);

  const desktop = lifecycleHarness({
    probeListener: async () => true,
  });
  const original = `<?xml version="1.0"?><plist><dict>${DESKTOP_LAUNCH_AGENT_MARKER}<key>Label</key><string>${DESKTOP_CAPTURE_AGENT_LABEL}</string></dict></plist>\n`;
  mkdirSync(dirname(desktop.paths.legacyServicePath), { recursive: true });
  writeFileSync(desktop.paths.legacyServicePath, original, { mode: 0o600 });
  const desktopStatus = await desktop.lifecycle.status();
  assert.equal(desktopStatus.launchAgent, "absent");
  assert.equal(desktopStatus.desktopLaunchAgent, "desktop-v1");
  await assert.rejects(
    desktop.lifecycle.setupRuntime(),
    expectCode("OWNERSHIP_CONFLICT"),
  );
  assert.equal(
    readFileSync(desktop.paths.legacyServicePath, "utf8"),
    original,
  );
  assert.equal(existsSync(desktop.paths.servicePath), false);
  assert.equal(existsSync(desktop.paths.statePath), false);
  assert.equal(existsSync(desktop.paths.runtimeRoot), false);
  assert.deepEqual(desktop.calls, []);
});

test("setup preserves a Desktop definition created while the runtime bundle loads", async () => {
  let harness;
  const legacyDefinition = `<?xml version="1.0"?><plist><dict>${DESKTOP_LAUNCH_AGENT_MARKER}<key>Label</key><string>${DESKTOP_CAPTURE_AGENT_LABEL}</string></dict></plist>\n`;
  harness = lifecycleHarness({
    onLoadRuntimeBundle: () => {
      mkdirSync(dirname(harness.paths.legacyServicePath), {
        recursive: true,
      });
      writeFileSync(harness.paths.legacyServicePath, legacyDefinition, {
        mode: 0o600,
      });
    },
    probeHealth: async () => {
      throw new Error("synthetic unhealthy");
    },
  });

  let failure;
  try {
    await harness.lifecycle.setupRuntime();
  } catch (error) {
    failure = error;
  }

  assert.equal(existsSync(harness.paths.servicePath), false);
  assert.equal(
    readFileSync(harness.paths.legacyServicePath, "utf8"),
    legacyDefinition,
  );
  assert.equal(failure?.code, "OWNERSHIP_CONFLICT");
  assert.equal(failure?.rollback, undefined);
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.runtimeRoot), false);
  assert.deepEqual(harness.calls, []);
});

test("failed activation rolls back only plugin ownership when Desktop appears", async () => {
  let harness;
  const legacyDefinition = `<?xml version="1.0"?><plist><dict>${DESKTOP_LAUNCH_AGENT_MARKER}<key>Label</key><string>${DESKTOP_CAPTURE_AGENT_LABEL}</string></dict></plist>\n`;
  harness = lifecycleHarness({
    probeHealth: async ({ runtimeVersion }) => {
      if (runtimeVersion !== "2.0.0") return;
      writeFileSync(harness.paths.legacyServicePath, legacyDefinition, {
        mode: 0o600,
      });
      throw new Error("synthetic unhealthy");
    },
  });
  await harness.lifecycle.setupRuntime();
  const oldDefinition = readFileSync(harness.paths.servicePath, "utf8");
  harness.setBundle(runtimeFixture("2.0.0", "two"));

  await assert.rejects(harness.lifecycle.upgrade(), (error) => {
    assert.equal(error.code, "HEALTH_MISMATCH");
    assert.equal(error.rollback, "restored");
    return true;
  });

  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), oldDefinition);
  assert.equal(
    readFileSync(harness.paths.legacyServicePath, "utf8"),
    legacyDefinition,
  );
  const bootouts = harness.calls.filter(([, args]) => args[0] === "bootout");
  assert.equal(bootouts.length > 0, true);
  assert.equal(
    bootouts.every(([, args]) =>
      args.includes(`gui/${FIXTURE_UID}/${CAPTURE_AGENT_LABEL}`),
    ),
    true,
  );
  assert.equal(
    harness.calls.some(([, args]) =>
      args.some((value) => value.includes(DESKTOP_CAPTURE_AGENT_LABEL)),
    ),
    false,
  );
});

test("uninstall removes only plugin state when Desktop owns the shared listener", async () => {
  let listenerOccupied = false;
  let pluginLoaded = false;
  let desktopLoaded = false;
  const harness = lifecycleHarness({
    probeListener: async () => listenerOccupied,
    runCommand: async (_executable, args) => {
      if (args[0] === "bootstrap") {
        if (args[2] === harness.paths.servicePath) pluginLoaded = true;
        return;
      }
      if (args[0] === "bootout") {
        pluginLoaded = false;
        return;
      }
      if (args[0] !== "print") return;
      const service = args[1];
      const loaded = service.endsWith(`/${CAPTURE_AGENT_LABEL}`)
        ? pluginLoaded
        : service.endsWith(`/${DESKTOP_CAPTURE_AGENT_LABEL}`)
          ? desktopLoaded
          : false;
      if (loaded) return;
      const label = service.slice(service.lastIndexOf("/") + 1);
      const error = new Error("synthetic service not found");
      error.code = 113;
      error.stderr = `Could not find service "${label}" in domain for user gui: ${FIXTURE_UID}\n`;
      throw error;
    },
  });
  await harness.lifecycle.setupRuntime();
  const legacyDefinition = `<?xml version="1.0"?><plist><dict>${DESKTOP_LAUNCH_AGENT_MARKER}<key>Label</key><string>${DESKTOP_CAPTURE_AGENT_LABEL}</string></dict></plist>\n`;
  mkdirSync(dirname(harness.paths.legacyServicePath), { recursive: true });
  writeFileSync(harness.paths.legacyServicePath, legacyDefinition, {
    mode: 0o600,
  });
  desktopLoaded = true;
  listenerOccupied = true;

  const result = await harness.lifecycle.uninstall();

  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(harness.paths.servicePath), false);
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.runtimeRoot), false);
  assert.equal(
    readFileSync(harness.paths.legacyServicePath, "utf8"),
    legacyDefinition,
  );
  assert.equal(
    harness.calls.some(([, args]) =>
      args.includes(`gui/${FIXTURE_UID}/${DESKTOP_CAPTURE_AGENT_LABEL}`),
    ),
    true,
  );
  assert.equal(
    harness.calls.some(
      ([, args]) =>
        args[0] === "bootout" &&
        args.includes(`gui/${FIXTURE_UID}/${DESKTOP_CAPTURE_AGENT_LABEL}`),
    ),
    false,
  );
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
      testRuntime,
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
    desktopLaunchAgent: "absent",
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
  assert.equal(installed.desktopLaunchAgent, "absent");
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
  const definition = readFileSync(harness.paths.servicePath, "utf8");

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
  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), definition);
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
  const plistBefore = readFileSync(harness.paths.servicePath, "utf8");

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
      partial: false,
      loaded: true,
      pendingCount: 4,
      disposition: "discard",
      purgeProof: undefined,
    },
  );
  assert.match(preflight.purgeProof.stateSha256, /^[0-9a-f]{64}$/);
  assert.match(preflight.purgeProof.launchAgentSha256, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), stateBefore);
  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), plistBefore);
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
  unlinkSync(harness.paths.servicePath);
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
  unlinkSync(harness.paths.servicePath);
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
  assert.equal(existsSync(harness.paths.servicePath), false);
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
  unlinkSync(harness.paths.servicePath);
  unlinkSync(harness.paths.currentPath);
  chmodSync(dirname(removedFile), 0o700);
  unlinkSync(removedFile);

  const preflight = await harness.lifecycle.preflightUninstall();
  assert.equal(preflight.installed, true);
  assert.equal(preflight.partial, true);

  const result = await harness.lifecycle.uninstall();
  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(harness.paths.statePath), false);
  assert.equal(existsSync(harness.paths.runtimeRoot), false);
});

test("discarding pending data from partially uninstalled state still requires a proof", async () => {
  const harness = lifecycleHarness();
  await harness.lifecycle.setupRuntime();
  unlinkSync(harness.paths.servicePath);

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
  const definition = readFileSync(harness.paths.servicePath, "utf8");

  await assert.rejects(
    harness.lifecycle.uninstall(),
    expectCode("SUPERVISOR_UNAVAILABLE"),
  );
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), state);
  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), definition);
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
  assert.equal(existsSync(harness.paths.servicePath), false);
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
  assert.equal(existsSync(harness.paths.servicePath), true);
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
  assert.equal(existsSync(harness.paths.servicePath), false);
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

test("lifecycle core enforces a vendored host build before mutation", async () => {
  const base = lifecycleHarness();
  assert.throws(
    () =>
      createCaptureAgentLifecycle({
        env: { COREDOC_HOME: join(base.homeDir, "windows") },
        homeDir: base.homeDir,
        pluginRoot,
        platform: "win32",
        arch: "x64",
      }),
    expectCode("UNSUPPORTED_PLATFORM"),
  );
  const wrongArch = createCaptureAgentLifecycle({
    env: { COREDOC_HOME: join(base.homeDir, "linux-arm64") },
    homeDir: base.homeDir,
    pluginRoot,
    platform: "linux",
    arch: "arm64",
  });
  await assert.rejects(
    wrongArch.setupRuntime(),
    expectCode("UNSUPPORTED_PLATFORM"),
  );
  assert.equal(existsSync(join(base.homeDir, "windows")), false);
  assert.equal(existsSync(join(base.homeDir, "linux-arm64")), false);
});

test("Linux activation writes a marker-owned unit and enables it through systemd", async () => {
  const harness = lifecycleHarness({ platform: "linux" });

  const result = await harness.lifecycle.setupRuntime();

  assert.equal(result.status, "ready");
  const unit = readFileSync(harness.paths.servicePath, "utf8");
  assert.equal(unit.startsWith(PLUGIN_SYSTEMD_UNIT_MARKER), true);
  assert.match(unit, new RegExp(`\n# Unit: ${CAPTURE_AGENT_UNIT}\n`));
  assert.match(unit, /\nWantedBy=default\.target\n/);
  assert.match(unit, /\nRestart=always\n/);
  assert.match(unit, /\nStartLimitIntervalSec=0\n/);
  assert.match(unit, /\nRestartSec=10\n/);
  assert.match(unit, /\nTimeoutStopSec=8\n/);
  assert.match(unit, /\nKillMode=mixed\n/);
  assert.equal(unit.includes("<plist"), false);
  const installed = join(
    harness.paths.runtimeVersionsDirectory,
    result.current.directoryName,
  );
  assert.equal(
    unit.includes(
      `ExecStart="${join(installed, "runtime/bun/runner")}" "${join(
        installed,
        "scripts/managed-otel-relay.mjs",
      )}" "serve" "--config" "${harness.paths.relayConfigPath}"`,
    ),
    true,
  );
  assert.equal(unit.includes(pluginRoot), false);
  assert.doesNotMatch(unit, /health_token_|Bearer/);
  assert.equal(lstatSync(harness.paths.servicePath).mode & 0o777, 0o600);

  const systemctl = harness.calls.filter(([executable]) =>
    executable.endsWith("systemctl"),
  );
  assert.equal(
    systemctl.some(([, args]) => args.join(" ") === "--user daemon-reload"),
    true,
  );
  assert.equal(
    systemctl.some(
      ([, args]) =>
        args.join(" ") === `--user enable --now ${CAPTURE_AGENT_UNIT}`,
    ),
    true,
  );
  assert.equal(
    harness.calls.some(([executable]) => executable.includes("launchctl")),
    false,
  );
});

test("Linux uninstall stops the running unit, disables it, and removes it", async () => {
  const harness = lifecycleHarness({
    platform: "linux",
    runCommand: systemdRunCommand({ activeState: "active" }),
  });
  await harness.lifecycle.setupRuntime();
  harness.calls.length = 0;

  const result = await harness.lifecycle.uninstall();

  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(harness.paths.servicePath), false);
  assert.equal(existsSync(harness.paths.statePath), false);
  const sequence = harness.calls.map(([, args]) => args.join(" "));
  const stop = sequence.indexOf(`--user stop ${CAPTURE_AGENT_UNIT}`);
  const disable = sequence.indexOf(`--user disable ${CAPTURE_AGENT_UNIT}`);
  assert.equal(stop >= 0 && disable > stop, true, sequence.join("\n"));
  assert.equal(sequence.some((line) => line.includes("--now")), false);
});

test("a loaded unit whose file is gone is still stopped, never disabled", async () => {
  const harness = lifecycleHarness({
    platform: "linux",
    runCommand: systemdRunCommand({ activeState: "active" }),
  });
  await harness.lifecycle.setupRuntime();
  unlinkSync(harness.paths.servicePath);
  harness.calls.length = 0;

  const result = await harness.lifecycle.uninstall();

  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(harness.paths.statePath), false);
  const sequence = harness.calls.map(([, args]) => args.join(" "));
  assert.equal(sequence.includes(`--user stop ${CAPTURE_AGENT_UNIT}`), true);
  assert.equal(sequence.some((line) => line.includes("disable")), false);
});

test("an inactive unit is neither stopped nor disabled when nothing is installed", async () => {
  const harness = lifecycleHarness({ platform: "linux" });
  await harness.lifecycle.setupRuntime();
  unlinkSync(harness.paths.servicePath);
  harness.calls.length = 0;

  await harness.lifecycle.uninstall();

  const sequence = harness.calls.map(([, args]) => args.join(" "));
  assert.equal(sequence.some((line) => /\b(stop|disable)\b/.test(line)), false);
});

test("Linux uninstall fails before mutation when systemctl cannot stop the unit", async () => {
  const harness = lifecycleHarness({
    platform: "linux",
    runCommand: async (_executable, args) => {
      if (args.includes("stop")) throw new Error("PRIVATE systemctl failure");
      if (args.includes("show")) return "active\n";
      return undefined;
    },
  });
  await harness.lifecycle.setupRuntime();
  const state = readFileSync(harness.paths.statePath, "utf8");
  const unit = readFileSync(harness.paths.servicePath, "utf8");

  await assert.rejects(
    harness.lifecycle.uninstall(),
    expectCode("SUPERVISOR_UNAVAILABLE"),
  );
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), state);
  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), unit);
  assert.equal(existsSync(harness.paths.runtimeRoot), true);
});

test("Linux setup retries enable once, then rolls back with SUPERVISOR_UNAVAILABLE", async () => {
  const harness = lifecycleHarness({
    platform: "linux",
    runCommand: async (_executable, args) => {
      if (args.includes("enable")) throw new Error("PRIVATE enable failure");
      if (args.includes("show")) return "inactive\n";
      return undefined;
    },
  });

  await assert.rejects(
    harness.lifecycle.setupRuntime(),
    (error) =>
      error instanceof CaptureAgentLifecycleError &&
      error.code === "SUPERVISOR_UNAVAILABLE" &&
      error.rollback === "restored",
  );

  const enables = harness.calls.filter(([, args]) => args.includes("enable"));
  assert.equal(enables.length, 2);
  assert.equal(existsSync(harness.paths.servicePath), false);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("systemd show failures surface as SUPERVISOR_UNAVAILABLE, never as raw errors", async () => {
  for (const runCommand of [
    async (_executable, args) => {
      if (args.includes("show")) throw new Error("PRIVATE dbus failure");
      return undefined;
    },
    async () => undefined,
  ]) {
    const harness = lifecycleHarness({ platform: "linux", runCommand });
    await harness.lifecycle.setupRuntime();
    await assert.rejects(
      harness.lifecycle.preflightDisable(),
      expectCode("SUPERVISOR_UNAVAILABLE"),
    );
  }
});

test("Linux upgrade health failure restores the previous unit and re-enables it", async () => {
  let rejectedVersion = null;
  const harness = lifecycleHarness({
    platform: "linux",
    runCommand: systemdRunCommand({ activeState: "active" }),
    probeHealth: async ({ runtimeVersion }) => {
      if (runtimeVersion === rejectedVersion) throw new Error("synthetic unhealthy");
    },
  });
  const installed = await harness.lifecycle.setupRuntime();
  const oldUnit = readFileSync(harness.paths.servicePath, "utf8");
  const oldState = readFileSync(harness.paths.statePath, "utf8");
  harness.setBundle(runtimeFixture("2.0.0", "two", "linux-x64"));
  rejectedVersion = "2.0.0";
  harness.calls.length = 0;

  await assert.rejects(
    harness.lifecycle.upgrade(),
    (error) =>
      error instanceof CaptureAgentLifecycleError &&
      error.code === "HEALTH_MISMATCH" &&
      error.rollback === "restored",
  );

  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), oldUnit);
  assert.equal(readFileSync(harness.paths.statePath, "utf8"), oldState);
  assert.equal(
    readlinkSync(harness.paths.currentPath),
    join("runtime", "versions", installed.current.directoryName),
  );
  const sequence = harness.calls.map(([, args]) => args.join(" "));
  const lastStop = sequence.lastIndexOf(`--user stop ${CAPTURE_AGENT_UNIT}`);
  const lastEnable = sequence.lastIndexOf(
    `--user enable --now ${CAPTURE_AGENT_UNIT}`,
  );
  assert.equal(lastStop >= 0 && lastEnable > lastStop, true, sequence.join("\n"));
  assert.equal(
    sequence.lastIndexOf("--user daemon-reload") < lastEnable,
    true,
  );
});

test("systemd unit ownership requires both the marker and the exact unit label", async () => {
  const harness = lifecycleHarness({ platform: "linux" });
  await harness.lifecycle.setupRuntime();
  const owned = readFileSync(harness.paths.servicePath, "utf8");
  for (const [content, expected] of [
    [owned, "plugin-v1"],
    [owned.replace(`${PLUGIN_SYSTEMD_UNIT_MARKER}\n`, ""), "foreign"],
    [owned.replace(`# Unit: ${CAPTURE_AGENT_UNIT}`, "# Unit: other.service"), "foreign"],
  ]) {
    writeFileSync(harness.paths.servicePath, content, { mode: 0o600 });
    const status = await harness.lifecycle.status();
    assert.equal(status.launchAgent, expected, content);
  }
});

test("a runtime manifest must carry exactly one vendored Bun", () => {
  const { manifest } = runtimeFixture("1.0.0", "exec-count");
  const withoutBun = {
    ...manifest,
    files: manifest.files.map((file) =>
      file.path === "runtime/bun/darwin-arm64/bun"
        ? { ...file, path: "scripts/extra-module.mjs" }
        : file,
    ),
  };
  const withTwoBuns = {
    ...manifest,
    files: manifest.files.map((file) =>
      file.path === "scripts/project-key.mjs"
        ? { ...file, path: "runtime/bun/linux-x64/bun" }
        : file,
    ),
  };
  for (const candidate of [withoutBun, withTwoBuns]) {
    assert.throws(
      () => runtimeDigestForManifest(candidate),
      expectCode("INVALID_RUNTIME_MANIFEST"),
    );
  }
});

test("schema-2 manifest rejects malformed shapes and missing host platforms", () => {
  const committed = JSON.parse(
    readFileSync(
      join(pluginRoot, "runtime", "capture-agent-manifest.json"),
      "utf8",
    ),
  );
  const darwin = committed.platforms["darwin-arm64"];
  const cases = [
    [{ ...committed, schemaVersion: 1 }, "INVALID_RUNTIME_MANIFEST"],
    [{ ...committed, shared: "nope" }, "INVALID_RUNTIME_MANIFEST"],
    [{ ...committed, platforms: [] }, "INVALID_RUNTIME_MANIFEST"],
    [{ ...committed, platforms: {} }, "INVALID_RUNTIME_MANIFEST"],
    [
      {
        ...committed,
        platforms: { ...committed.platforms, "win32-x64": { sha256: "a".repeat(64) } },
      },
      "INVALID_RUNTIME_MANIFEST",
    ],
    [
      {
        ...committed,
        platforms: {
          ...committed.platforms,
          "linux-x64": { ...committed.platforms["linux-x64"], extra: 1 },
        },
      },
      "INVALID_RUNTIME_MANIFEST",
    ],
    [{ ...committed, files: committed.shared }, "INVALID_RUNTIME_MANIFEST"],
    [{ ...committed, platforms: { "darwin-arm64": darwin } }, "UNSUPPORTED_PLATFORM"],
  ];
  for (const [manifest, code] of cases) {
    const root = mkdtempSync(join(tmpdir(), "coredoc-manifest-"));
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(
      join(root, "runtime", "capture-agent-manifest.json"),
      JSON.stringify(manifest),
    );
    writeFileSync(
      join(root, "package.json"),
      readFileSync(join(pluginRoot, "package.json")),
    );
    assert.throws(
      () => loadRuntimeBundle({ pluginRoot: root, platformKey: "linux-x64" }),
      expectCode(code),
      JSON.stringify(manifest.platforms),
    );
  }
});

test("the shell launchers and the lifecycle agree on which hosts are vendored", () => {
  const armsOf = (path) =>
    [...readFileSync(join(pluginRoot, path), "utf8").matchAll(
      /^\s*([A-Za-z]+\/[A-Za-z0-9_]+)\) runtime_platform=([a-z0-9-]+) ;;/gm,
    )].map(([, host, key]) => `${host}=${key}`).sort();
  const expected = Object.keys(PLATFORM_RUNTIME_EXECUTABLES)
    .map((key) => {
      const [platform, arch] = key.split("-");
      const uname = `${platform === "darwin" ? "Darwin" : "Linux"}/${arch === "x64" ? "x86_64" : arch}`;
      return `${uname}=${key}`;
    })
    .sort();
  assert.deepEqual(armsOf("bin/coredoc-workflows"), expected);
  assert.deepEqual(armsOf("runtime/bun/runner"), expected);
});

test("a user-private-group unit directory is accepted on Linux and nowhere else", async () => {
  const linux = lifecycleHarness({ platform: "linux" });
  mkdirSync(dirname(linux.paths.servicePath), { recursive: true });
  chmodSync(dirname(linux.paths.servicePath), 0o775);
  assert.equal((await linux.lifecycle.setupRuntime()).status, "ready");

  const worldWritable = lifecycleHarness({ platform: "linux" });
  mkdirSync(dirname(worldWritable.paths.servicePath), { recursive: true });
  chmodSync(dirname(worldWritable.paths.servicePath), 0o777);
  await assert.rejects(
    worldWritable.lifecycle.setupRuntime(),
    expectCode("UNSAFE_STATE"),
  );

  // launchd's directory keeps the strict owner-only rule.
  const darwin = lifecycleHarness();
  mkdirSync(dirname(darwin.paths.servicePath), { recursive: true });
  chmodSync(dirname(darwin.paths.servicePath), 0o775);
  await assert.rejects(darwin.lifecycle.setupRuntime(), expectCode("UNSAFE_STATE"));

  // The plugin's own state root is never group-writable, on any host.
  const stateRoot = lifecycleHarness({ platform: "linux" });
  mkdirSync(stateRoot.paths.agentRoot, { recursive: true });
  chmodSync(stateRoot.paths.agentRoot, 0o775);
  await assert.rejects(stateRoot.lifecycle.setupRuntime(), expectCode("UNSAFE_STATE"));
});

test("a missing XDG_RUNTIME_DIR falls back to the uid's own /run/user directory", () => {
  const owned = mkdtempSync(join(tmpdir(), "coredoc-runtime-dir-"));
  const forwarded = supervisorEnvironment(
    {},
    { uid: FIXTURE_UID, runtimeDirectoryFor: () => owned },
  );
  assert.equal(forwarded.XDG_RUNTIME_DIR, owned);
  const absent = supervisorEnvironment(
    {},
    { uid: FIXTURE_UID, runtimeDirectoryFor: () => join(owned, "missing") },
  );
  assert.equal(absent.XDG_RUNTIME_DIR, undefined);
  const explicit = supervisorEnvironment(
    { XDG_RUNTIME_DIR: "/run/user/42" },
    { uid: FIXTURE_UID, runtimeDirectoryFor: () => owned },
  );
  assert.equal(explicit.XDG_RUNTIME_DIR, "/run/user/42");
});

test("the systemd unit follows XDG_CONFIG_HOME when the user manager would", () => {
  const paths = captureAgentPaths({
    env: { COREDOC_HOME: "/home/test/.coredoc", XDG_CONFIG_HOME: "/home/test/cfg" },
    homeDir: "/home/test",
    platform: "linux",
  });
  assert.equal(
    paths.servicePath,
    join("/home/test/cfg", "systemd", "user", CAPTURE_AGENT_UNIT),
  );
  const relative = captureAgentPaths({
    env: { COREDOC_HOME: "/home/test/.coredoc", XDG_CONFIG_HOME: "cfg" },
    homeDir: "/home/test",
    platform: "linux",
  });
  assert.equal(
    relative.servicePath,
    join("/home/test", ".config", "systemd", "user", CAPTURE_AGENT_UNIT),
  );
});

test("an install staged by another host's runtime is refused, not adopted", async () => {
  const darwin = lifecycleHarness();
  await darwin.lifecycle.setupRuntime();
  const linux = createCaptureAgentLifecycle({
    env: { COREDOC_HOME: darwin.coredocHome },
    homeDir: darwin.homeDir,
    pluginRoot,
    platform: "linux",
    arch: "x64",
    uid: FIXTURE_UID,
    loadRuntimeBundle: () => runtimeFixture("2.0.0", "two", "linux-x64"),
    runCommand: systemdRunCommand(),
    probeListener: async () => false,
    probeHealth: async () => undefined,
    importSmoke: async () => undefined,
    wait: async () => undefined,
  });
  const before = readFileSync(darwin.paths.statePath, "utf8");

  await assert.rejects(linux.upgrade(), expectCode("UNSUPPORTED_PLATFORM"));
  await assert.rejects(linux.rollback(), expectCode("OWNERSHIP_CONFLICT"));

  assert.equal(readFileSync(darwin.paths.statePath, "utf8"), before);
  assert.equal((await linux.status()).status, "degraded");
});

test("uninstall removes a dangling wants link left by enable and reloads the manager", async () => {
  const harness = lifecycleHarness({ platform: "linux" });
  await harness.lifecycle.setupRuntime();
  const wants = join(
    dirname(harness.paths.servicePath),
    "default.target.wants",
    CAPTURE_AGENT_UNIT,
  );
  mkdirSync(dirname(wants), { recursive: true });
  symlinkSync(harness.paths.servicePath, wants);
  unlinkSync(harness.paths.servicePath);
  harness.calls.length = 0;

  const result = await harness.lifecycle.uninstall();

  assert.equal(result.status, "uninstalled");
  assert.equal(existsSync(wants), false);
  assert.equal(
    harness.calls.some(([, args]) => args.includes("disable")),
    false,
  );

  const fresh = lifecycleHarness({ platform: "linux" });
  await fresh.lifecycle.setupRuntime();
  fresh.calls.length = 0;
  await fresh.lifecycle.uninstall();
  const sequence = fresh.calls.map(([, args]) => args.join(" "));
  assert.equal(sequence.at(-1), "--user daemon-reload", sequence.join("\n"));
});

test("a wants link that points somewhere else is an ownership conflict", async () => {
  const harness = lifecycleHarness({ platform: "linux" });
  await harness.lifecycle.setupRuntime();
  const wants = join(
    dirname(harness.paths.servicePath),
    "default.target.wants",
    CAPTURE_AGENT_UNIT,
  );
  mkdirSync(dirname(wants), { recursive: true });
  symlinkSync("/etc/systemd/user/someone-else.service", wants);
  unlinkSync(harness.paths.servicePath);

  await assert.rejects(harness.lifecycle.uninstall(), expectCode("OWNERSHIP_CONFLICT"));
  assert.equal(lstatSync(wants).isSymbolicLink(), true);
  assert.equal(existsSync(harness.paths.statePath), true);
});

test("supervisor commands inherit only PATH plus the user-manager locators", () => {
  assert.deepEqual(
    supervisorEnvironment({
      HOME: "/home/u",
      NODE_OPTIONS: "--require=/x",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    }),
    {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    },
  );
  assert.deepEqual(
    supervisorEnvironment({ XDG_RUNTIME_DIR: "relative/dir", DBUS_SESSION_BUS_ADDRESS: "" }),
    { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  );
});


test("a foreign unit at the plugin path is never adopted or overwritten", async () => {
  const harness = lifecycleHarness({ platform: "linux" });
  mkdirSync(dirname(harness.paths.servicePath), { recursive: true });
  const foreign = "[Unit]\nDescription=someone else\n";
  writeFileSync(harness.paths.servicePath, foreign);

  await assert.rejects(
    harness.lifecycle.setupRuntime(),
    expectCode("OWNERSHIP_CONFLICT"),
  );
  assert.equal(readFileSync(harness.paths.servicePath, "utf8"), foreign);
  assert.equal(existsSync(harness.paths.statePath), false);
});

test("systemd ActiveState decides whether the plugin service is running", async () => {
  for (const [activeState, expected] of [
    ["active", true],
    ["activating", true],
    ["deactivating", true],
    ["inactive", false],
    ["failed", false],
  ]) {
    const harness = lifecycleHarness({
      platform: "linux",
      runCommand: systemdRunCommand({ activeState }),
    });
    await harness.lifecycle.setupRuntime();

    const preflight = await harness.lifecycle.preflightDisable();

    assert.equal(preflight.loaded, expected, activeState);
  }

  const unparsable = lifecycleHarness({
    platform: "linux",
    runCommand: systemdRunCommand({ activeState: "not-a-state" }),
  });
  await unparsable.lifecycle.setupRuntime();
  await assert.rejects(
    unparsable.lifecycle.preflightDisable(),
    expectCode("SUPERVISOR_UNAVAILABLE"),
  );
});

test("a Linux relay port that outlives the stop is a failure, not a legacy handover", async () => {
  let listening = false;
  const harness = lifecycleHarness({
    platform: "linux",
    probeListener: async () => listening,
  });
  await harness.lifecycle.setupRuntime();
  listening = true;

  // macOS tolerates a still-occupied port only when the legacy Desktop agent
  // owns it; Linux has no such owner, so the stop has to fail loudly.
  await assert.rejects(
    harness.lifecycle.disable(),
    expectCode("SUPERVISOR_UNAVAILABLE"),
  );
});

test("systemd unit arguments survive specifier expansion and quoting", () => {
  const unit = buildCaptureAgentSystemdUnit({
    runtimeExecutablePath: "/home/u/100% real/runtime/bun/runner",
    entryPath: "/home/u/100% real/scripts/managed-otel-relay.mjs",
    configPath: '/home/u/wei"rd/relay.json',
    statePath: "/home/u/back\\slash/state.json",
    runtimeVersion: "1.0.0",
    runtimeDigest: "a".repeat(64),
  });

  assert.equal(
    unit.includes('ExecStart="/home/u/100%% real/runtime/bun/runner"'),
    true,
  );
  assert.equal(unit.includes('"/home/u/wei\\"rd/relay.json"'), true);
  assert.equal(unit.includes('"/home/u/back\\\\slash/state.json"'), true);
  const dollars = buildCaptureAgentSystemdUnit({
    runtimeExecutablePath: "/home/u/${HOME}/runtime/bun/runner",
    entryPath: "/home/u/$X/scripts/managed-otel-relay.mjs",
    configPath: "/home/u/relay.json",
    statePath: "/home/u/state.json",
    runtimeVersion: "1.0.0",
    runtimeDigest: "a".repeat(64),
  });
  // systemd substitutes `${VAR}` even inside double quotes; `$$` is its escape.
  assert.equal(dollars.includes('"/home/u/$${HOME}/runtime/bun/runner"'), true);
  assert.equal(dollars.includes('"/home/u/$$X/scripts/managed-otel-relay.mjs"'), true);

  for (const hostile of ["/home/u/new\nline", "/home/u/nul\u0000byte"]) {
    assert.throws(
      () =>
        buildCaptureAgentSystemdUnit({
          runtimeExecutablePath: hostile,
          entryPath: "/home/u/entry.mjs",
          configPath: "/home/u/relay.json",
          statePath: "/home/u/state.json",
          runtimeVersion: "1.0.0",
          runtimeDigest: "a".repeat(64),
        }),
      expectCode("UNSAFE_STATE"),
    );
  }
});

test(
  "launcher does not expose raw lifecycle or setup bypass commands",
  { skip: !["darwin-arm64", "linux-x64"].includes(`${process.platform}-${process.arch}`) },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "coredoc-agent-cli-"));
    for (const command of ["capture-agent", "capture-agent-setup"]) {
      await assert.rejects(
        run(launcher, [command, "status"], {
          env: {
            PATH: mkdtempSync(join(tmpdir(), "coredoc-empty-path-")),
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
