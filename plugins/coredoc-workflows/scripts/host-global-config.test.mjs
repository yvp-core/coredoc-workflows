import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HostConfigError,
  inspectHostGlobalConfig,
  prepareCodexHooksTransaction,
  prepareHostGlobalConfigTransaction,
  renderClaudeGlobalSettings,
  renderCodexHooks,
  renderCodexOtelConfig,
} from "./host-global-config.mjs";
import {
  createManagedRelay,
  sha256BindingNonce,
} from "./managed-otel-relay.mjs";

const CLAUDE_TOKEN = "c".repeat(48);
const CODEX_TOKEN = "d".repeat(48);
const CLOUD_TOKEN = `cdt_${"e".repeat(64)}`;
const CLAUDE_BINDING_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const POLICY_ORIGIN = "https://coredoc.example.com";

function configPaths(root) {
  return {
    claudeSettingsPath: join(root, ".claude", "settings.json"),
    codexConfigPaths: [
      join(root, ".codex", "config.toml"),
      join(root, ".codex", "review.config.toml"),
    ],
    codexHooksPath: join(root, ".codex", "hooks.json"),
  };
}

function installInput(root) {
  return {
    operation: "install",
    ...configPaths(root),
    claudeIngressToken: CLAUDE_TOKEN,
    claudeBindingId: CLAUDE_BINDING_ID,
    workspaceId: WORKSPACE_ID,
    codexIngressToken: CODEX_TOKEN,
    runtimeExecutablePath: "/opt/coredoc/runtime/node",
    claimProgramPath: "/opt/coredoc/capture-agent/session-claim.mjs",
  };
}

test("Claude install/uninstall preserves unrelated settings and rejects unmanaged OTEL", () => {
  const before = `${JSON.stringify({ theme: "dark", env: { KEEP: "yes" } }, null, 2)}\n`;
  const installed = renderClaudeGlobalSettings(before, {
    operation: "install",
    ingressToken: CLAUDE_TOKEN,
    bindingId: CLAUDE_BINDING_ID,
    workspaceId: WORKSPACE_ID,
  });
  const parsed = JSON.parse(installed);
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.env.KEEP, "yes");
  assert.equal(parsed.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(parsed.env.OTEL_METRICS_EXPORTER, "none");
  assert.equal(parsed.env.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(parsed.env.OTEL_EXPORTER_OTLP_ENDPOINT, "http://127.0.0.1:43181");
  assert.equal(
    parsed.env.OTEL_EXPORTER_OTLP_HEADERS,
    `X-Coredoc-Relay-Binding=${CLAUDE_TOKEN}`,
  );
  assert.equal(
    parsed.env.COREDOC_CAPTURE_ENDPOINT,
    "http://127.0.0.1:43181/capture/v1/events",
  );
  assert.equal(
    parsed.env.COREDOC_CAPTURE_HEADERS,
    `X-Coredoc-Relay-Binding=${CLAUDE_TOKEN}`,
  );
  assert.equal(parsed.env.COREDOC_CAPTURE_BINDING_ID, CLAUDE_BINDING_ID);
  assert.equal(parsed.env.COREDOC_CAPTURE_WORKSPACE_ID, WORKSPACE_ID);
  assert.equal(parsed.env.COREDOC_CAPTURE_HOST, "claude-code");
  assert.equal(parsed.env.COREDOC_CAPTURE_WORKSPACE_MODE, "1");
  assert.deepEqual(
    JSON.parse(renderClaudeGlobalSettings(installed, { operation: "uninstall" })),
    JSON.parse(before),
  );
  assert.throws(
    () =>
      renderClaudeGlobalSettings(
        JSON.stringify({ env: { OTEL_LOGS_EXPORTER: "otlp" } }),
        {
          operation: "install",
          ingressToken: CLAUDE_TOKEN,
          bindingId: CLAUDE_BINDING_ID,
          workspaceId: WORKSPACE_ID,
        },
      ),
    (error) => error instanceof HostConfigError && error.code === "CONFIG_CONFLICT",
  );
  assert.throws(
    () =>
      renderClaudeGlobalSettings(
        JSON.stringify({
          env: {
            OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://collector.example/logs",
          },
        }),
        {
          operation: "install",
          ingressToken: CLAUDE_TOKEN,
          bindingId: CLAUDE_BINDING_ID,
          workspaceId: WORKSPACE_ID,
        },
      ),
    (error) => error instanceof HostConfigError && error.code === "CONFIG_CONFLICT",
  );
});

test("Codex OTEL block round-trips exact unrelated bytes and detects unmanaged configuration", () => {
  const before = 'model = "gpt-5.6-sol"\n';
  const installed = renderCodexOtelConfig(before, {
    operation: "install",
    ingressToken: CODEX_TOKEN,
  });
  assert.match(installed, /\[otel\]/);
  assert.match(installed, /log_user_prompt = false/);
  assert.match(installed, /metrics_exporter = "none"/);
  assert.match(installed, /http:\/\/127\.0\.0\.1:43181\/v1\/logs/);
  assert.equal(
    renderCodexOtelConfig(installed, { operation: "uninstall" }),
    before,
  );
  assert.throws(
    () =>
      renderCodexOtelConfig("[otel]\nlog_user_prompt = false\n", {
        operation: "install",
        ingressToken: CODEX_TOKEN,
      }),
    (error) => error instanceof HostConfigError && error.code === "CONFIG_CONFLICT",
  );
});

test("Codex status does not hide unmanaged OTEL appended beside an owned block", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-codex-conflict-"));
  const paths = configPaths(root);
  await mkdir(join(root, ".codex"), { recursive: true, mode: 0o700 });
  const managed = renderCodexOtelConfig("", {
    operation: "install",
    ingressToken: CODEX_TOKEN,
  });
  await writeFile(
    paths.codexConfigPaths[0],
    `${managed}[otel]\nlog_user_prompt = true\n`,
    { mode: 0o600 },
  );

  const status = await inspectHostGlobalConfig({
    claudeSettingsPath: paths.claudeSettingsPath,
    codexConfigPaths: [paths.codexConfigPaths[0]],
    codexHooksPath: paths.codexHooksPath,
  });
  assert.deepEqual(status.codex, ["partial"]);
});

test("Codex install replaces only an exact Desktop-owned OTEL block", () => {
  const legacyToken = "l".repeat(48);
  const before = [
    'model = "gpt-5.6-sol"',
    "# >>> coredoc managed otel v1 eof-newline=1",
    "[otel]",
    "log_user_prompt = false",
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:43181/v1/logs", protocol = "json", headers = { "X-Coredoc-Relay-Ingress" = "' +
      legacyToken +
      '" } } }',
    "# <<< coredoc managed otel v1",
    "",
  ].join("\n");

  const installed = renderCodexOtelConfig(before, {
    operation: "install",
    ingressToken: CODEX_TOKEN,
  });
  assert.match(installed, /coredoc capture-agent managed otel v1/);
  assert.doesNotMatch(installed, /coredoc managed otel v1/);
  assert.doesNotMatch(installed, new RegExp(legacyToken));
  assert.equal(
    renderCodexOtelConfig(installed, { operation: "uninstall" }),
    'model = "gpt-5.6-sol"\n',
  );

  assert.throws(
    () =>
      renderCodexOtelConfig(
        "# >>> coredoc managed otel v1 eof-newline=1\n[otel]\n# <<< coredoc managed otel v1\n",
        { operation: "install", ingressToken: CODEX_TOKEN },
      ),
    (error) => error instanceof HostConfigError && error.code === "CONFIG_CONFLICT",
  );
});

test("Codex preserves trust tables inserted inside exact Desktop markers across install, rollback, and uninstall", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-codex-trust-"));
  const paths = configPaths(root);
  await mkdir(join(root, ".codex"), { recursive: true, mode: 0o700 });
  const legacyToken = "l".repeat(48);
  const trustState = [
    "[hooks.state]",
    '"/private/workspace" = "trusted"',
    "[hooks.state.metadata]",
    'source = "codex"',
    "",
  ].join("\n");
  const before = [
    'model = "gpt-5.6-sol"',
    "# >>> coredoc managed otel v1 eof-newline=1",
    "[otel]",
    "log_user_prompt = false",
    'exporter = { otlp-http = { endpoint = "http://127.0.0.1:43181/v1/logs", protocol = "json", headers = { "X-Coredoc-Relay-Ingress" = "' +
      legacyToken +
      '" } } }',
    trustState.trimEnd(),
    "# <<< coredoc managed otel v1",
    "",
  ].join("\n");
  await writeFile(paths.codexConfigPaths[0], before, { mode: 0o600 });

  const transaction = await prepareHostGlobalConfigTransaction({
    ...installInput(root),
    includeCodexHooks: false,
  });
  await transaction.apply();
  const installed = await readFile(paths.codexConfigPaths[0], "utf8");
  assert.equal(installed.startsWith("# >>> coredoc capture-agent managed otel v1"), true);
  assert.match(installed, /\[hooks\.state\]/);
  assert.match(installed, /"\/private\/workspace" = "trusted"/);
  assert.doesNotMatch(installed, /coredoc managed otel v1/);

  const withoutPlugin = renderCodexOtelConfig(installed, {
    operation: "uninstall",
  });
  assert.equal(withoutPlugin, `model = "gpt-5.6-sol"\n${trustState}`);

  await transaction.rollback();
  assert.equal(await readFile(paths.codexConfigPaths[0], "utf8"), before);
});

test("Codex hook install is idempotent and removal keeps unrelated handlers", () => {
  const before = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{ type: "command", command: "/usr/bin/existing-hook" }],
        },
      ],
      Stop: [{ hooks: [{ type: "command", command: "/usr/bin/stop-hook" }] }],
    },
    keep: true,
  });
  const options = {
    operation: "install",
    runtimeExecutablePath: "/opt/coredoc/runtime/node",
    claimProgramPath: "/opt/coredoc/capture-agent/session-claim.mjs",
  };
  const installed = renderCodexHooks(before, options);
  assert.equal(renderCodexHooks(installed, options), installed);
  const parsed = JSON.parse(installed);
  for (const name of ["SessionStart", "UserPromptSubmit"]) {
    const managed = parsed.hooks[name].at(-1).hooks[0];
    assert.equal(managed.async, true);
    assert.equal(managed.timeout, 3);
    assert.match(managed.command, /^COREDOC_CAPTURE_AGENT_SESSION_CLAIM=1 /);
  }
  assert.deepEqual(
    JSON.parse(renderCodexHooks(installed, { operation: "uninstall" })),
    JSON.parse(before),
  );
});

test("Codex hook install replaces exact Desktop claim commands and preserves user hooks", () => {
  const desktopCommand =
    "COREDOC_CODEX_SESSION_CLAIM=1 ELECTRON_RUN_AS_NODE=1 '/Applications/Coredoc.app/Contents/MacOS/Coredoc' '/Users/test/.coredoc/capture-relay/codex-session-claim.mjs'";
  const before = JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [
            { type: "command", command: desktopCommand, async: true },
            { type: "command", command: "/usr/bin/user-hook" },
          ],
        },
      ],
    },
  });
  const installed = renderCodexHooks(before, {
    operation: "install",
    runtimeExecutablePath: "/opt/coredoc/runtime/node",
    claimProgramPath: "/opt/coredoc/capture-agent/session-claim.mjs",
  });
  assert.doesNotMatch(installed, /COREDOC_CODEX_SESSION_CLAIM/);
  assert.match(installed, /COREDOC_CAPTURE_AGENT_SESSION_CLAIM/);
  assert.match(installed, /\/usr\/bin\/user-hook/);
  const removed = renderCodexHooks(before, { operation: "uninstall" });
  assert.doesNotMatch(removed, /COREDOC_CODEX_SESSION_CLAIM/);
  assert.match(removed, /\/usr\/bin\/user-hook/);
});

test("native host configuration can commit independently from optional Codex claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-optional-hooks-"));
  const paths = configPaths(root);
  await mkdir(join(root, ".codex"), { recursive: true, mode: 0o700 });
  await writeFile(paths.codexHooksPath, "not-json\n", { mode: 0o600 });

  const native = await prepareHostGlobalConfigTransaction({
    ...installInput(root),
    includeCodexHooks: false,
  });
  assert.equal(native.summary.some(({ kind }) => kind === "codex-hooks"), false);
  await native.apply();
  assert.equal(
    (await inspectHostGlobalConfig(paths)).codex.every((status) => status === "managed"),
    true,
  );

  await assert.rejects(
    prepareCodexHooksTransaction({
      operation: "install",
      codexHooksPath: paths.codexHooksPath,
      runtimeExecutablePath: "/opt/coredoc/runtime/node",
      claimProgramPath: "/opt/coredoc/capture-agent/session-claim.mjs",
    }),
    (error) => error instanceof HostConfigError && error.code === "CONFIG_INVALID",
  );
});

test("unsafe optional Codex hooks degrade claims inspection without hiding native readiness", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-unsafe-hooks-"));
  const paths = configPaths(root);
  const native = await prepareHostGlobalConfigTransaction({
    ...installInput(root),
    includeCodexHooks: false,
  });
  await native.apply();
  await symlink(join(root, "missing-user-hooks.json"), paths.codexHooksPath);

  const status = await inspectHostGlobalConfig(paths);
  assert.equal(status.claude, "managed");
  assert.equal(status.codex.every((value) => value === "managed"), true);
  assert.equal(status.codexHooks, "invalid");
});

test("transaction applies both hosts with 0600 files, reports status, and rolls back", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-config-"));
  const paths = configPaths(root);
  await mkdir(join(root, ".claude"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".codex"), { recursive: true, mode: 0o700 });
  const claudeBefore = `${JSON.stringify({ env: { KEEP: "yes" } }, null, 2)}\n`;
  const codexBefore = 'model = "gpt-5.6-sol"\n';
  const hooksBefore = `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`;
  await writeFile(paths.claudeSettingsPath, claudeBefore, { mode: 0o644 });
  await writeFile(paths.codexConfigPaths[0], codexBefore, { mode: 0o644 });
  await writeFile(paths.codexHooksPath, hooksBefore, { mode: 0o644 });

  const transaction = await prepareHostGlobalConfigTransaction({
    ...installInput(root),
    cloudToken: CLOUD_TOKEN,
    jwt: "must-not-be-consumed",
    untrustedWorkspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(transaction.summary.every(({ changed }) => changed), true);
  await transaction.apply();

  for (const path of [paths.claudeSettingsPath, ...paths.codexConfigPaths, paths.codexHooksPath]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    const configured = await readFile(path, "utf8");
    assert.equal(configured.includes(CLOUD_TOKEN), false);
    assert.equal(configured.includes("must-not-be-consumed"), false);
    assert.equal(configured.includes("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), false);
    assert.equal(configured.includes("https://"), false);
  }
  assert.deepEqual(await inspectHostGlobalConfig(paths), {
    claude: "managed",
    codex: ["managed", "managed"],
    codexHooks: "managed",
  });

  await transaction.rollback();
  assert.equal(await readFile(paths.claudeSettingsPath, "utf8"), claudeBefore);
  assert.equal(await readFile(paths.codexConfigPaths[0], "utf8"), codexBefore);
  await assert.rejects(readFile(paths.codexConfigPaths[1]), { code: "ENOENT" });
  assert.equal(await readFile(paths.codexHooksPath, "utf8"), hooksBefore);
  assert.equal((await lstat(paths.claudeSettingsPath)).mode & 0o777, 0o644);
});

test("a second prepared install is an idempotent no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-idempotent-"));
  const first = await prepareHostGlobalConfigTransaction(installInput(root));
  await first.apply();
  const second = await prepareHostGlobalConfigTransaction(installInput(root));
  assert.equal(second.summary.every(({ changed }) => !changed), true);
  await second.apply();
});

test("an uninstall over absent files is a no-op and creates nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-uninstall-"));
  const paths = configPaths(root);
  const transaction = await prepareHostGlobalConfigTransaction({
    operation: "uninstall",
    ...paths,
  });
  assert.equal(transaction.summary.every(({ changed }) => !changed), true);
  await transaction.apply();
  for (const path of [paths.claudeSettingsPath, ...paths.codexConfigPaths, paths.codexHooksPath]) {
    await assert.rejects(lstat(path), { code: "ENOENT" });
  }
});

test("uninstall leaves unowned configuration bytes and modes untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-unowned-"));
  const paths = configPaths(root);
  await mkdir(join(root, ".claude"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, ".codex"), { recursive: true, mode: 0o700 });
  const claude = `${JSON.stringify({
    env: { OTEL_LOGS_EXPORTER: "console" },
    keep: true,
  })}\n`;
  const codex = "[otel]\nlog_user_prompt = false\n";
  await writeFile(paths.claudeSettingsPath, claude, { mode: 0o644 });
  await writeFile(paths.codexConfigPaths[0], codex, { mode: 0o644 });

  const transaction = await prepareHostGlobalConfigTransaction({
    operation: "uninstall",
    ...paths,
  });
  await transaction.apply();

  assert.equal(await readFile(paths.claudeSettingsPath, "utf8"), claude);
  assert.equal(await readFile(paths.codexConfigPaths[0], "utf8"), codex);
  assert.equal((await lstat(paths.claudeSettingsPath)).mode & 0o777, 0o644);
  assert.equal((await lstat(paths.codexConfigPaths[0])).mode & 0o777, 0o644);
});

test("rejects same ingress token, symlink targets, unsafe parents, and prepare/apply races", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-global-safety-"));
  await assert.rejects(
    prepareHostGlobalConfigTransaction({
      ...installInput(root),
      codexIngressToken: CLAUDE_TOKEN,
    }),
    (error) => error instanceof HostConfigError && error.code === "INVALID_INPUT",
  );

  const symlinkRoot = await mkdtemp(join(tmpdir(), "host-global-symlink-"));
  const symlinkPaths = configPaths(symlinkRoot);
  await mkdir(join(symlinkRoot, ".claude"), { mode: 0o700 });
  const target = join(symlinkRoot, "target.json");
  await writeFile(target, "{}\n");
  await symlink(target, symlinkPaths.claudeSettingsPath);
  await assert.rejects(
    prepareHostGlobalConfigTransaction(installInput(symlinkRoot)),
    (error) => error instanceof HostConfigError && error.code === "UNSAFE_PATH",
  );

  const unsafeRoot = await mkdtemp(join(tmpdir(), "host-global-parent-"));
  await mkdir(join(unsafeRoot, ".claude"), { mode: 0o700 });
  await chmod(join(unsafeRoot, ".claude"), 0o777);
  await assert.rejects(
    prepareHostGlobalConfigTransaction(installInput(unsafeRoot)),
    (error) => error instanceof HostConfigError && error.code === "UNSAFE_PATH",
  );

  const raceRoot = await mkdtemp(join(tmpdir(), "host-global-race-"));
  const racePaths = configPaths(raceRoot);
  const race = await prepareHostGlobalConfigTransaction(installInput(raceRoot));
  await mkdir(join(raceRoot, ".claude"), { mode: 0o700 });
  await writeFile(racePaths.claudeSettingsPath, '{"user":"change"}\n');
  await assert.rejects(
    race.apply(),
    (error) => error instanceof HostConfigError && error.code === "CONFIG_CHANGED",
  );
  assert.equal(await readFile(racePaths.claudeSettingsPath, "utf8"), '{"user":"change"}\n');
});

test("rendered host headers route Claude native and semantic plus Codex native before any claim", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "host-global-relay-e2e-"));
  const configPath = join(root, "capture-relay", "relay.json");
  await mkdir(join(root, "capture-relay"), { recursive: true, mode: 0o700 });
  const codexBindingId = "22222222-2222-4222-8222-222222222222";
  const endpoints = {
    nativeForwardEndpoint: `${POLICY_ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/otel/v1/logs`,
    captureForwardEndpoint: `${POLICY_ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/events`,
  };
  const binding = (host, bindingId, token) => ({
    schemaVersion: 1,
    bindingId,
    bindingNonceHash: sha256BindingNonce(token),
    host,
    workspaceId: WORKSPACE_ID,
    workspaceMode: true,
    ...endpoints,
    cloudAuthorization: `Bearer ${CLOUD_TOKEN}`,
  });
  await writeFile(
    configPath,
    `${JSON.stringify({
      schemaVersion: 1,
      bindings: [
        binding("claude-code", CLAUDE_BINDING_ID, CLAUDE_TOKEN),
        binding("codex", codexBindingId, CODEX_TOKEN),
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const forwarded = [];
  const relay = createManagedRelay({
    configPath,
    outboxFlushIntervalMs: 60_000,
    nativeOutboxFlushIntervalMs: 60_000,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      forwarded.push({ url: String(url), body });
      if (String(url).endsWith("/capture/v1/repositories/resolve")) {
        return new Response(
          JSON.stringify({
            status: "resolved",
            repositoryKey: body.repositoryKey,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).endsWith("/capture/v1/events")) {
        return new Response(
          JSON.stringify({
            acceptedEventIds: body.events.map(({ eventId }) => eventId),
            duplicateEventIds: [],
            rejected: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  let port;
  try {
    port = await new Promise((resolve, reject) => {
      relay.once("error", reject);
      relay.listen(0, "127.0.0.1", () => {
        relay.off("error", reject);
        resolve(relay.address().port);
      });
    });
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("loopback listeners are unavailable in this sandbox");
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => relay.close(resolve)));
  const base = `http://127.0.0.1:${port}`;
  const renderedClaude = JSON.parse(
    renderClaudeGlobalSettings("", {
      operation: "install",
      ingressToken: CLAUDE_TOKEN,
      bindingId: CLAUDE_BINDING_ID,
      workspaceId: WORKSPACE_ID,
    }),
  );
  const claudeHeader = Object.fromEntries(
    renderedClaude.env.OTEL_EXPORTER_OTLP_HEADERS.split(",").map((entry) => {
      const index = entry.indexOf("=");
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  const attr = (key, value) => ({ key, value: { stringValue: value } });
  const claudePayload = {
    resourceLogs: [
      {
        resource: { attributes: [attr("service.version", "2.1.232")] },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1786870800000000000",
                observedTimeUnixNano: "1786870800001000000",
                body: { stringValue: "claude_code.api_request" },
                attributes: [
                  attr("session.id", "claude-session-fixture"),
                  attr("app.version", "2.1.232"),
                  attr("model", "claude-sonnet-4-6"),
                  attr("input_tokens", "12"),
                  attr("output_tokens", "3"),
                  attr("cache_read_tokens", "0"),
                  attr("cache_creation_tokens", "0"),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const claudeNative = await fetch(`${base}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json", ...claudeHeader },
    body: JSON.stringify(claudePayload),
  });
  assert.equal(claudeNative.status, 200);

  const event = {
    schemaVersion: 1,
    eventId: "33333333-3333-4333-8333-333333333333",
    occurredAt: "2026-09-01T10:00:00.000Z",
    host: "claude-code",
    sessionId: "claude-session-fixture",
    runId: "cdr-20260901-a1b2c3",
    repositoryKey: "owner/repository",
    type: "workflow.run.started",
    data: {
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      scale: "normal",
    },
  };
  const semantic = await fetch(`${base}/capture/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Binding": CLAUDE_TOKEN,
    },
    body: JSON.stringify({ events: [event] }),
  });
  assert.equal(semantic.status, 200);

  const codexConfig = renderCodexOtelConfig("", {
    operation: "install",
    ingressToken: CODEX_TOKEN,
  });
  const codexToken = /"X-Coredoc-Relay-Ingress" = "([A-Za-z0-9_-]+)"/.exec(
    codexConfig,
  )[1];
  const codexFixture = JSON.parse(
    await readFile(
      new URL("./hosts/fixtures/codex-0.146.0-otlp.redacted.json", import.meta.url),
      "utf8",
    ),
  ).payload;
  const codexNative = await fetch(`${base}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Coredoc-Relay-Ingress": codexToken,
    },
    body: JSON.stringify(codexFixture),
  });
  assert.equal(codexNative.status, 200);
  assert.equal(forwarded.length, 4);
  assert.deepEqual(
    forwarded.map(({ url }) => url),
    [
      endpoints.nativeForwardEndpoint,
      `${POLICY_ORIGIN}/api/v1/workspaces/${WORKSPACE_ID}/capture/v1/repositories/resolve`,
      endpoints.captureForwardEndpoint,
      endpoints.nativeForwardEndpoint,
    ],
  );
});
