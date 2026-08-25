import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";

import {
  createNativeOtlpSanitizer,
  NativeOtlpSanitizerError,
  sanitizeClaudeOtlp,
  sanitizeCodexOtlp,
} from "./native-otel-sanitizer.mjs";

const FIXTURE = JSON.parse(
  readFileSync(
    new URL(
      "./hosts/fixtures/codex-0.146.0-otlp.redacted.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const PRIVATE_SENTINELS = [
  "PROMPT_SECRET_SENTINEL",
  "COMMAND_ARGUMENT_SECRET_SENTINEL",
  "TOOL_OUTPUT_SECRET_SENTINEL",
  "LOG_BODY_SECRET_SENTINEL",
  "ACCOUNT_SECRET_SENTINEL",
  "EMAIL_SECRET_SENTINEL",
];

const CLAUDE_PRIVATE_SENTINELS = [
  "CLAUDE_PROMPT_SECRET_SENTINEL",
  "CLAUDE_TOOL_INPUT_SECRET_SENTINEL",
  "CLAUDE_TOOL_OUTPUT_SECRET_SENTINEL",
  "CLAUDE_ACCOUNT_SECRET_SENTINEL",
  "CLAUDE_PATH_SECRET_SENTINEL",
];

function claudeFixture(version = "2.1.232") {
  const attr = (key, value) => ({ key, value: { stringValue: value } });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attr("service.version", version),
            attr("user.email", CLAUDE_PRIVATE_SENTINELS[3]),
            attr("host.name", CLAUDE_PRIVATE_SENTINELS[4]),
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1786870800000000000",
                observedTimeUnixNano: "1786870800001000000",
                body: { stringValue: "claude_code.api_request" },
                attributes: [
                  attr("session.id", "claude-session-fixture"),
                  attr("app.version", version),
                  attr("model", "claude-sonnet-4-6"),
                  attr("input_tokens", "120"),
                  attr("output_tokens", "30"),
                  attr("cache_read_tokens", "40"),
                  attr("cache_creation_tokens", "5"),
                  attr("cost_usd", "99.99"),
                  attr("prompt", CLAUDE_PRIVATE_SENTINELS[0]),
                ],
              },
              {
                timeUnixNano: "1786870801000000000",
                observedTimeUnixNano: "1786870801001000000",
                body: { stringValue: "claude_code.tool_result" },
                attributes: [
                  attr("session.id", "claude-session-fixture"),
                  attr("app.version", version),
                  attr("tool_name", "mcp__coredoc__search"),
                  attr("success", "true"),
                  attr("duration_ms", "17"),
                  attr("tool_input", CLAUDE_PRIVATE_SENTINELS[1]),
                  attr("tool_output", CLAUDE_PRIVATE_SENTINELS[2]),
                ],
              },
              {
                timeUnixNano: "1786870802000000000",
                observedTimeUnixNano: "1786870802001000000",
                body: { stringValue: "claude_code.user_prompt" },
                attributes: [
                  attr("session.id", "claude-session-fixture"),
                  attr("app.version", version),
                  attr("prompt", CLAUDE_PRIVATE_SENTINELS[0]),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

test("sanitizes the genuine Codex 0.146.0 OTLP shape through a safe field allowlist", () => {
  const result = sanitizeCodexOtlp(FIXTURE.payload);

  assert.equal(result.host, "codex");
  assert.equal(result.version, "0.146.0");
  assert.equal(result.coverage.nativeUsage, "observed");
  assert.equal(result.coverage.capabilities, "unavailable");

  const records = result.payload.resourceLogs[0].scopeLogs[0].logRecords;
  assert.deepEqual(
    records.map((record) => record.body.stringValue),
    [
      "codex.conversation_starts",
      "codex.sse_event",
      "codex.tool_decision",
      "codex.tool_result",
      "codex.sse_event",
    ],
  );

  const serialized = JSON.stringify(result.payload);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  for (const forbiddenKey of [
    "prompt",
    "arguments",
    "output",
    "user.email",
    "user.account_id",
    "call_id",
    "host.name",
    "eventName",
  ]) {
    assert.equal(serialized.includes(`\"${forbiddenKey}\"`), false, forbiddenKey);
  }
});

test("sanitizes a newer Codex version through the same safe field allowlist", () => {
  const payload = structuredClone(FIXTURE.payload);
  for (const resourceLog of payload.resourceLogs) {
    for (const attribute of resourceLog.resource.attributes) {
      if (attribute.key === "service.version") {
        attribute.value.stringValue = "0.148.0-alpha.9";
      }
    }
    for (const scopeLog of resourceLog.scopeLogs) {
      for (const record of scopeLog.logRecords) {
        for (const attribute of record.attributes) {
          if (attribute.key === "app.version") {
            attribute.value.stringValue = "0.148.0-alpha.9";
          }
        }
      }
    }
  }

  const result = sanitizeCodexOtlp(payload);

  assert.equal(result.version, "0.148.0-alpha.9");
  const serialized = JSON.stringify(result.payload);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

test("fails closed when resource and record versions disagree", () => {
  const payload = structuredClone(FIXTURE.payload);
  for (const resourceLog of payload.resourceLogs) {
    for (const attribute of resourceLog.resource.attributes) {
      if (attribute.key === "service.version") {
        attribute.value.stringValue = "0.147.0";
      }
    }
  }

  assert.throws(
    () => sanitizeCodexOtlp(payload),
    (error) =>
      error instanceof NativeOtlpSanitizerError &&
      error.code === "MIXED_VERSIONS",
  );
});

test("fails closed when a telemetry version is missing", () => {
  const payload = structuredClone(FIXTURE.payload);
  for (const resourceLog of payload.resourceLogs) {
    resourceLog.resource.attributes = resourceLog.resource.attributes.filter(
      (attribute) => attribute.key !== "service.version",
    );
    for (const scopeLog of resourceLog.scopeLogs) {
      for (const record of scopeLog.logRecords) {
        record.attributes = record.attributes.filter(
          (attribute) => attribute.key !== "app.version",
        );
      }
    }
  }

  assert.throws(
    () => sanitizeCodexOtlp(payload),
    (error) =>
      error instanceof NativeOtlpSanitizerError &&
      error.code === "INVALID_RECORD",
  );
});

test("sanitizes the supported Claude native shape without forwarding cost or content", () => {
  const result = sanitizeClaudeOtlp(claudeFixture());

  assert.equal(result.host, "claude-code");
  assert.equal(result.version, "2.1.232");
  assert.equal(result.coverage.nativeUsage, "observed");
  const records = result.payload.resourceLogs[0].scopeLogs[0].logRecords;
  assert.deepEqual(records.map((record) => record.body.stringValue), [
    "claude_code.api_request",
    "claude_code.tool_result",
  ]);
  const serialized = JSON.stringify(result.payload);
  for (const sentinel of CLAUDE_PRIVATE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
  assert.equal(serialized.includes("cost_usd"), false);
});

test("sanitizes a newer Claude version through the same safe field allowlist", () => {
  const result = sanitizeClaudeOtlp(claudeFixture("2.1.233"));

  assert.equal(result.version, "2.1.233");
  const serialized = JSON.stringify(result.payload);
  for (const sentinel of CLAUDE_PRIVATE_SENTINELS) {
    assert.equal(serialized.includes(sentinel), false, sentinel);
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runSanitizerCli(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./native-otel-sanitizer.mjs", import.meta.url))],
      { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("sanitizer CLI did not exit after the occupied-port error"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test("reports a bounded error when the dedicated loopback port is occupied", async (t) => {
  // On a dev machine the real relay may already own the managed port; that
  // satisfies the "occupied" precondition just as well as our blocker does.
  const blocker = createServer((_request, response) => response.end("foreign"));
  const blockerOwnsPort = await new Promise((resolve, reject) => {
    blocker.once("error", (error) =>
      error.code === "EADDRINUSE" ? resolve(false) : reject(error),
    );
    blocker.listen(43_181, "127.0.0.1", () => resolve(true));
  });
  if (blockerOwnsPort) t.after(() => close(blocker));

  const result = await runSanitizerCli({
    COREDOC_NATIVE_OTLP_HOST: "codex",
    COREDOC_NATIVE_OTLP_FORWARD_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws-fixture/otel/v1/logs",
    // A stray legacy override must not move the fixed managed endpoint.
    COREDOC_NATIVE_OTLP_PORT: "43180",
  });

  assert.deepEqual(result, {
    code: 1,
    signal: null,
    stdout: "",
    stderr: "EADDRINUSE\n",
  });
});

test("forwards only the sanitized allowlist to the configured loopback remote", async (t) => {
  const forwarded = [];
  const remote = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      forwarded.push({
        url: request.url,
        authorization: request.headers.authorization,
        extraHeader: request.headers["x-private-config"],
        body,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{\"partialSuccess\":{}}");
    });
  });
  const remotePort = await listen(remote);
  t.after(() => close(remote));

  const sanitizer = createNativeOtlpSanitizer({
    forwardEndpoint: `http://127.0.0.1:${remotePort}/api/v1/workspaces/ws-fixture/otel/v1/logs`,
    now: () => "2026-08-16T11:00:00.000Z",
  });
  const sanitizerPort = await listen(sanitizer);
  t.after(() => close(sanitizer));

  const response = await fetch(`http://127.0.0.1:${sanitizerPort}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer remote-fixture-token",
      "X-Private-Config": "CONFIG_SECRET_SENTINEL",
    },
    body: JSON.stringify(FIXTURE.payload),
  });
  assert.equal(response.status, 200);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, "/api/v1/workspaces/ws-fixture/otel/v1/logs");
  assert.equal(forwarded[0].authorization, "Bearer remote-fixture-token");
  assert.equal(forwarded[0].extraHeader, undefined);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(forwarded[0].body.includes(sentinel), false, sentinel);
  }

  const healthResponse = await fetch(
    `http://127.0.0.1:${sanitizerPort}/health`,
  );
  assert.deepEqual(await healthResponse.json(), {
    schemaVersion: 1,
    host: "codex",
    configured: true,
    state: "observed",
    lastSeenAt: "2026-08-16T11:00:00.000Z",
    lastForwardedAt: "2026-08-16T11:00:00.000Z",
    lastError: null,
    coverage: { nativeUsage: "observed", capabilities: "unavailable" },
  });
});

test("never falls back to a direct exporter when forwarding fails", async (t) => {
  const attempts = [];
  const sanitizer = createNativeOtlpSanitizer({
    forwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/ws-fixture/otel/v1/logs",
    fetchImpl: async (endpoint, init) => {
      attempts.push({ endpoint, body: init.body, redirect: init.redirect });
      throw new Error("synthetic downstream failure");
    },
    now: () => "2026-08-16T11:00:00.000Z",
  });
  const sanitizerPort = await listen(sanitizer);
  t.after(() => close(sanitizer));

  const response = await fetch(`http://127.0.0.1:${sanitizerPort}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer remote-fixture-token",
    },
    body: JSON.stringify(FIXTURE.payload),
  });
  assert.equal(response.status, 502);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].endpoint, "https://capture.invalid/api/v1/workspaces/ws-fixture/otel/v1/logs");
  assert.equal(attempts[0].redirect, "error");
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(attempts[0].body.includes(sentinel), false, sentinel);
  }

  const healthResponse = await fetch(
    `http://127.0.0.1:${sanitizerPort}/health`,
  );
  const health = await healthResponse.json();
  assert.equal(health.state, "error");
  assert.equal(health.lastError, "FORWARD_FAILED");
  assert.equal(health.coverage.nativeUsage, "unavailable");
  assert.equal(JSON.stringify(health).includes("synthetic downstream failure"), false);
});

test("newer versions forward only the sanitized allowlist", async (t) => {
  let calls = 0;
  let forwardedBody = "";
  const sanitizer = createNativeOtlpSanitizer({
    host: "codex",
    forwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/ws-fixture/otel/v1/logs",
    fetchImpl: async (_endpoint, init) => {
      calls += 1;
      forwardedBody = init.body;
      return new Response(null, { status: 200 });
    },
  });
  const sanitizerPort = await listen(sanitizer);
  t.after(() => close(sanitizer));
  const payload = structuredClone(FIXTURE.payload);
  for (const resourceLog of payload.resourceLogs) {
    for (const attribute of resourceLog.resource.attributes) {
      if (attribute.key === "service.version") {
        attribute.value.stringValue = "0.148.0-alpha.9";
      }
    }
    for (const scopeLog of resourceLog.scopeLogs) {
      for (const record of scopeLog.logRecords) {
        for (const attribute of record.attributes) {
          if (attribute.key === "app.version") {
            attribute.value.stringValue = "0.148.0-alpha.9";
          }
        }
      }
    }
  }

  const response = await fetch(`http://127.0.0.1:${sanitizerPort}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer remote-fixture-token",
    },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(forwardedBody.includes(sentinel), false, sentinel);
  }
});

test("refuses an unauthenticated loopback request without forwarding", async (t) => {
  let calls = 0;
  const sanitizer = createNativeOtlpSanitizer({
    forwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/ws-fixture/otel/v1/logs",
    fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status: 200 });
    },
  });
  const sanitizerPort = await listen(sanitizer);
  t.after(() => close(sanitizer));

  const response = await fetch(`http://127.0.0.1:${sanitizerPort}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(FIXTURE.payload),
  });
  assert.equal(response.status, 422);
  assert.equal(calls, 0);
  const health = await fetch(`http://127.0.0.1:${sanitizerPort}/health`).then((result) => result.json());
  assert.equal(health.lastError, "INVALID_AUTHORIZATION");
});

test("accepts only the exact logs route and enforces the request body bound", async (t) => {
  const sanitizer = createNativeOtlpSanitizer({
    forwardEndpoint:
      "https://capture.invalid/api/v1/workspaces/ws-fixture/otel/v1/logs",
  });
  const sanitizerPort = await listen(sanitizer);
  t.after(() => close(sanitizer));

  const wrongRoute = await fetch(`http://127.0.0.1:${sanitizerPort}/v1/logs?unsafe=1`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(wrongRoute.status, 404);

  const oversized = await fetch(`http://127.0.0.1:${sanitizerPort}/v1/logs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: "Bearer remote-fixture-token",
    },
    body: JSON.stringify({ ignored: "x".repeat(1_000_001) }),
  });
  assert.equal(oversized.status, 413);
});
