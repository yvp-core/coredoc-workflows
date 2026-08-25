import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  BINDING_MISMATCH_NOTICE,
  ensureManagedRelayAtSessionStart,
  managedRelayConfigPath,
  runSessionStartEnsure,
} from "./ensure-managed-relay.mjs";
import {
  sha256BindingNonce,
  writeManagedRelayConfig,
} from "./managed-otel-relay.mjs";

const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const LOCAL_NONCE = "local_binding_abcdefghijklmnopqrstuvwxyz012345";
const MANAGED_ENDPOINT = "http://127.0.0.1:43181/capture/v1/events";

function binding() {
  return {
    schemaVersion: 1,
    bindingId: BINDING_ID,
    bindingNonceHash: sha256BindingNonce(LOCAL_NONCE),
    host: "claude-code",
    workspaceId: "workspace-one",
    repositoryKey: "acme/api",
    nativeForwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/workspace-one/otel/v1/logs",
    captureForwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/workspace-one/capture/v1/events",
    cloudAuthorization: "Bearer PRIVATE_CLOUD_TOKEN",
  };
}

function env(nonce = LOCAL_NONCE) {
  return {
    COREDOC_CAPTURE_ENDPOINT: MANAGED_ENDPOINT,
    COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Binding=${nonce}`,
    COREDOC_CAPTURE_WORKSPACE_ID: "workspace-one",
  };
}

function health() {
  const channel = {
    state: "waiting",
    lastSeenAt: null,
    lastForwardedAt: null,
    lastErrorCode: null,
  };
  return {
    schemaVersion: 1,
    bindingId: BINDING_ID,
    host: "claude-code",
    workspaceId: "workspace-one",
    state: "ready",
    native: channel,
    capture: { ...channel, acceptedSchemaVersions: [1, 2, 3] },
  };
}

function configuredHome() {
  const home = mkdtempSync(join(tmpdir(), "coredoc-relay-ensure-home-"));
  writeManagedRelayConfig(managedRelayConfigPath(home), {
    schemaVersion: 1,
    bindings: [binding()],
  });
  return home;
}

test("polls authenticated health without loading the cloud-bearing managed config", async () => {
  const home = configuredHome();
  const calls = [];
  const waits = [];
  let attempt = 0;
  const result = await ensureManagedRelayAtSessionStart({
    home,
    env: env(),
    readConfig: () => {
      throw new Error("SessionStart must not load the cloud bearer");
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async (target, init) => {
      calls.push({ target, init });
      attempt += 1;
      if (attempt === 1) throw new Error("PRIVATE_RAW_TRANSPORT_ERROR");
      return new Response(JSON.stringify(health()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.deepEqual(result, { status: "ready" });
  assert.deepEqual(waits, [50]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].target, "http://127.0.0.1:43181/health");
  assert.equal(
    calls[1].init.headers["X-Coredoc-Relay-Binding"],
    LOCAL_NONCE,
  );
  assert.equal(calls[1].init.headers.Authorization, undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|Bearer|capture\.invalid/);
});

test("is a silent no-op when managed capture or its fixed config is absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "coredoc-relay-ensure-empty-"));
  const never = () => {
    throw new Error("unconfigured ensure must not read or fetch");
  };

  assert.deepEqual(
    await ensureManagedRelayAtSessionStart({
      home,
      env: {},
      exists: never,
      readConfig: never,
      fetchImpl: never,
    }),
    { status: "unconfigured" },
  );
  assert.deepEqual(
    await ensureManagedRelayAtSessionStart({
      home,
      env: env(),
      readConfig: never,
      fetchImpl: never,
    }),
    { status: "unconfigured" },
  );
  assert.deepEqual(
    await ensureManagedRelayAtSessionStart({
      home,
      env: {
        COREDOC_CAPTURE_ENDPOINT: MANAGED_ENDPOINT,
        COREDOC_RELAY_BINDING: LOCAL_NONCE,
      },
      exists: never,
      readConfig: never,
      fetchImpl: never,
    }),
    { status: "unconfigured" },
  );
});

test("fails open with bounded status for foreign bindings and raw transport errors", async () => {
  const home = configuredHome();
  let fetched = false;
  const foreign = await ensureManagedRelayAtSessionStart({
    home,
    env: env("foreign_binding_abcdefghijklmnopqrstuvwxyz012345"),
    fetchImpl: async () => {
      fetched = true;
      return new Response(JSON.stringify({ error: "BINDING_MISMATCH" }), {
        status: 401,
      });
    },
  });
  assert.deepEqual(foreign, {
    status: "unavailable",
    code: "BINDING_MISMATCH",
  });
  assert.equal(fetched, true);

  const unavailable = await ensureManagedRelayAtSessionStart({
    home,
    env: env(),
    wait: async () => {},
    fetchImpl: async () => {
      throw new Error(
        "PRIVATE_RAW_ERROR Bearer cloud-secret /Users/private/config",
      );
    },
  });
  assert.deepEqual(unavailable, {
    status: "unavailable",
    code: "TRANSPORT_UNAVAILABLE",
  });
  assert.doesNotMatch(
    JSON.stringify(unavailable),
    /PRIVATE|Bearer|cloud-secret|\/Users\/private/,
  );

  const healthMismatch = await ensureManagedRelayAtSessionStart({
    home,
    env: env(),
    wait: async () => {},
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ...health(),
          native: { ...health().native, state: "PRIVATE_INVALID_STATE" },
        }),
        { status: 200 },
      ),
  });
  assert.deepEqual(healthMismatch, {
    status: "unavailable",
    code: "HEALTH_MISMATCH",
  });
});

test("requires the exact Claude host and managed workspace from the secret-free environment", async () => {
  const home = configuredHome();
  for (const override of [
    { host: "codex" },
    { workspaceId: "workspace-two" },
  ]) {
    const result = await ensureManagedRelayAtSessionStart({
      home,
      env: env(),
      wait: async () => {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ ...health(), ...override }), {
          status: 200,
        }),
    });
    assert.deepEqual(result, {
      status: "unavailable",
      code: "HEALTH_MISMATCH",
    });
  }
});

test("surfaces exactly one bounded notice when the relay port answers with a foreign identity", async () => {
  const home = configuredHome();
  const written = [];
  const result = await runSessionStartEnsure({
    home,
    env: env("foreign_binding_abcdefghijklmnopqrstuvwxyz012345"),
    write: (line) => written.push(line),
    wait: async () => {},
    fetchImpl: async () =>
      new Response(JSON.stringify({ error: "BINDING_MISMATCH" }), {
        status: 401,
      }),
  });

  assert.deepEqual(result, { status: "unavailable", code: "BINDING_MISMATCH" });
  assert.deepEqual(written, [`${BINDING_MISMATCH_NOTICE}\n`]);
  assert.doesNotMatch(written[0], /Bearer|nonce|\/Users\/|43181/i);
});

test("stays silent for transport failures and unconfigured sessions", async () => {
  const written = [];
  const write = (line) => written.push(line);

  const transport = await runSessionStartEnsure({
    home: configuredHome(),
    env: env(),
    write,
    wait: async () => {},
    fetchImpl: async () => {
      throw new Error("PRIVATE_RAW_TRANSPORT_ERROR");
    },
  });
  assert.deepEqual(transport, {
    status: "unavailable",
    code: "TRANSPORT_UNAVAILABLE",
  });

  const unconfigured = await runSessionStartEnsure({
    home: mkdtempSync(join(tmpdir(), "coredoc-relay-ensure-silent-")),
    env: {},
    write,
    fetchImpl: () => {
      throw new Error("unconfigured ensure must not fetch");
    },
  });
  assert.deepEqual(unconfigured, { status: "unconfigured" });
  assert.deepEqual(written, []);
});

test("SessionStart registers ensure between environment setup and pending flush", () => {
  const hooks = JSON.parse(
    readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
  ).hooks.SessionStart[0].hooks;
  assert.deepEqual(
    hooks.map(({ command }) => command),
    [
      '"${CLAUDE_PLUGIN_ROOT}/bin/coredoc-workflows" session-env',
      '"${CLAUDE_PLUGIN_ROOT}/bin/coredoc-workflows" ensure-managed-relay',
      '"${CLAUDE_PLUGIN_ROOT}/bin/coredoc-workflows" retry-pending',
    ],
  );
});

test("SessionStart ensure CLI is silent and fail-open without managed config", () => {
  const home = mkdtempSync(join(tmpdir(), "coredoc-relay-ensure-cli-"));
  const result = spawnSync(
    process.execPath,
    [new URL("./ensure-managed-relay.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env: { ...process.env, ...env(), HOME: home },
      timeout: 2_500,
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
