import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../../test/test-api.mjs";

import {
  assertLoopbackWebSocketUrl,
  captureScreenshot,
  help,
  parseElectronEndpoint,
  parseElementReference,
  parseScreenshotArgs,
  redactSensitiveText,
  SCREENSHOT_REDACTION_EXPRESSION,
  selectElectronTarget,
} from "./desktop.mjs";

test("Electron endpoint defaults to loopback and validates overrides", () => {
  assert.equal(parseElectronEndpoint({}), "http://127.0.0.1:9333");
  assert.equal(
    parseElectronEndpoint({ ELECTRON_QA_URL: "http://localhost:9444" }),
    "http://localhost:9444",
  );
  assert.throws(
    () => parseElectronEndpoint({ ELECTRON_QA_URL: "http://192.168.1.10:9333" }),
    /loopback host/,
  );
  assert.throws(() => parseElectronEndpoint({ ELECTRON_QA_PORT: "80" }), /between 1024 and 65535/);
});

test("debugger WebSocket and emitted text remain loopback-only and redacted", () => {
  assert.equal(
    assertLoopbackWebSocketUrl("ws://127.0.0.1:9333/devtools/page/1"),
    "ws://127.0.0.1:9333/devtools/page/1",
  );
  assert.throws(
    () => assertLoopbackWebSocketUrl("ws://192.168.1.10:9333/devtools/page/1"),
    /loopback ws/,
  );
  assert.equal(
    redactSensitiveText("user@example.com access_token=abc Bearer xyz"),
    "[REDACTED] access_token=[REDACTED] Bearer [REDACTED]",
  );
});

test("Electron target selection uses configured title and URL filters", () => {
  const targets = [
    { id: "devtools", type: "page", title: "DevTools", url: "devtools://x", webSocketDebuggerUrl: "ws://d" },
    { id: "other", type: "page", title: "Other", url: "http://localhost:4000", webSocketDebuggerUrl: "ws://o" },
    { id: "app", type: "page", title: "Coredoc", url: "http://localhost:5173", webSocketDebuggerUrl: "ws://a" },
  ];
  const selected = selectElectronTarget(targets, { titleContains: "coredoc" });
  assert.equal(selected.id, "app");
  assert.equal(selectElectronTarget(targets, { urlContains: "localhost:4000" }).id, "other");
});

test("element references are strict", () => {
  assert.equal(parseElementReference("@e12"), "e12");
  assert.throws(() => parseElementReference("button.primary"), /must look like/);
});

test("help documents opt-in startup and secret-free commands", () => {
  assert.match(help(), /ELECTRON_QA_PORT=9333/);
  assert.doesNotMatch(help(), /auth-status/);
  assert.doesNotMatch(help(), /token|credential|cookie/i);
});

test("screenshots redact auth-adjacent values and restore the renderer", () => {
  assert.match(SCREENSHOT_REDACTION_EXPRESSION, /type === 'password'/);
  assert.match(SCREENSHOT_REDACTION_EXPRESSION, /maskedSecret/);
  assert.match(SCREENSHOT_REDACTION_EXPRESSION, /__electronQaRestoreScreenshot/);
});

function createFakeSession(handlers) {
  const calls = [];
  return {
    calls,
    send: async (method, params) => {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`Unexpected CDP call: ${method}`);
      return handler(params, calls.length);
    },
  };
}

function fakePng() {
  return Buffer.from("fake-png").toString("base64");
}

async function withTempFile(run) {
  const dir = mkdtempSync(join(tmpdir(), "electron-qa-"));
  const destination = join(dir, "shot.png");
  try {
    return await run(destination);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("captureScreenshot runs redaction, waits a settle frame, and restores on the happy path", async () => {
  await withTempFile(async (destination) => {
    const session = createFakeSession({
      "Page.bringToFront": () => ({}),
      "Runtime.evaluate": () => ({ result: { value: true } }),
      "Page.captureScreenshot": () => ({ data: fakePng() }),
    });
    await captureScreenshot(session, destination);
    const methods = session.calls.map((call) => call.method);
    assert.deepEqual(methods, [
      "Page.bringToFront",
      "Runtime.evaluate",
      "Runtime.evaluate",
      "Page.captureScreenshot",
      "Runtime.evaluate",
    ]);
    assert.match(session.calls[1].params.expression, /__electronQaRestoreScreenshot/);
    assert.match(session.calls[2].params.expression, /requestAnimationFrame/);
    assert.match(session.calls[4].params.expression, /__electronQaRestoreScreenshot/);
    assert.equal(readFileSync(destination).toString(), "fake-png");
  });
});

test("captureScreenshot falls back to an unredacted capture when redaction times out", async () => {
  await withTempFile(async (destination) => {
    let redactionAttempted = false;
    const session = createFakeSession({
      "Page.bringToFront": () => ({}),
      "Runtime.evaluate": () => {
        redactionAttempted = true;
        throw new Error("Timed out waiting for Runtime.evaluate");
      },
      "Page.captureScreenshot": () => ({ data: fakePng() }),
    });
    const originalWrite = process.stderr.write;
    const warnings = [];
    process.stderr.write = (chunk) => {
      warnings.push(String(chunk));
      return true;
    };
    try {
      await captureScreenshot(session, destination);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(redactionAttempted, true);
    const methods = session.calls.map((call) => call.method);
    assert.deepEqual(methods, ["Page.bringToFront", "Runtime.evaluate", "Page.captureScreenshot"]);
    assert.match(warnings.join(""), /screenshot redaction skipped/);
    assert.equal(readFileSync(destination).toString(), "fake-png");
  });
});

test("captureScreenshot skips redaction entirely with --no-redact semantics", async () => {
  await withTempFile(async (destination) => {
    const session = createFakeSession({
      "Page.bringToFront": () => ({}),
      "Runtime.evaluate": () => {
        throw new Error("redaction must not run");
      },
      "Page.captureScreenshot": () => ({ data: fakePng() }),
    });
    await captureScreenshot(session, destination, { noRedact: true });
    const methods = session.calls.map((call) => call.method);
    assert.deepEqual(methods, ["Page.bringToFront", "Page.captureScreenshot"]);
  });
});

test("captureScreenshot still runs the bounded restore evaluate when capture itself fails", async () => {
  await withTempFile(async (destination) => {
    const session = createFakeSession({
      "Page.bringToFront": () => ({}),
      "Runtime.evaluate": () => ({ result: { value: true } }),
      "Page.captureScreenshot": () => {
        throw new Error("Timed out waiting for Page.captureScreenshot");
      },
    });
    await assert.rejects(captureScreenshot(session, destination), /Timed out waiting for Page.captureScreenshot/);
    const methods = session.calls.map((call) => call.method);
    assert.deepEqual(methods, [
      "Page.bringToFront",
      "Runtime.evaluate",
      "Runtime.evaluate",
      "Page.captureScreenshot",
      "Runtime.evaluate",
    ]);
  });
});

test("parseScreenshotArgs scopes --no-redact to the screenshot command in any position", () => {
  assert.deepEqual(parseScreenshotArgs(["/tmp/shot.png"]), { destination: "/tmp/shot.png", noRedact: false });
  assert.deepEqual(parseScreenshotArgs(["/tmp/shot.png", "--no-redact"]), {
    destination: "/tmp/shot.png",
    noRedact: true,
  });
  assert.deepEqual(parseScreenshotArgs(["--no-redact", "/tmp/shot.png"]), {
    destination: "/tmp/shot.png",
    noRedact: true,
  });
  assert.deepEqual(parseScreenshotArgs([]), { destination: undefined, noRedact: false });
});
