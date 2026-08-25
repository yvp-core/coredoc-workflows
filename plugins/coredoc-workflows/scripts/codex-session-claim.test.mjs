import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { claimCodexSession } from "./codex-session-claim.mjs";

test("posts only session id and cwd with the machine-local ingress token", async () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-codex-claim-"));
  const relayRoot = join(root, "capture-relay");
  mkdirSync(relayRoot, { recursive: true });
  const token = "machine_ingress_abcdefghijklmnopqrstuvwxyz012345";
  writeFileSync(
    join(relayRoot, "codex-ingress.json"),
    `${JSON.stringify({ schemaVersion: 1, token })}\n`,
    { mode: 0o600 },
  );
  const calls = [];
  const result = await claimCodexSession({
    input: {
      session_id: "11111111-1111-4111-8111-111111111111",
      cwd: "/private/repository",
      model: "PRIVATE_MODEL",
      source: "startup",
    },
    env: { COREDOC_HOME: root },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response("{}", { status: 200 });
    },
  });
  assert.deepEqual(result, { status: "sent" });
  assert.equal(calls[0].url, "http://127.0.0.1:43181/codex/v1/session-claims");
  assert.equal(calls[0].options.headers["X-Coredoc-Relay-Ingress"], token);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    sessionId: "11111111-1111-4111-8111-111111111111",
    cwd: "/private/repository",
  });
  assert.doesNotMatch(calls[0].options.body, /PRIVATE_MODEL|source/);
});

test("ignores malformed hook payloads without reading local credentials", async () => {
  let calls = 0;
  assert.deepEqual(
    await claimCodexSession({
      input: { session_id: "bad id", cwd: "/private/repository" },
      env: { COREDOC_HOME: "/missing" },
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    }),
    { status: "ignored" },
  );
  assert.equal(calls, 0);
});
