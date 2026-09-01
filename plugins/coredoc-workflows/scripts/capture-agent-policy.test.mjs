import assert from "node:assert/strict";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CAPTURE_AGENT_POLICY_FILENAME,
  captureAgentPolicyPath,
  loadCaptureAgentPolicy,
  validateCaptureAgentPolicy,
} from "./capture-agent-policy.mjs";

const POLICY = Object.freeze({
  schemaVersion: 1,
  serverOrigin: "https://coredoc.example.com",
  workspaceId: "11111111-1111-4111-8111-111111111111",
});

test("resolves one user-level policy path outside repositories", () => {
  assert.equal(
    captureAgentPolicyPath({ env: {}, homeDir: "/Users/example" }),
    `/Users/example/.coredoc/${CAPTURE_AGENT_POLICY_FILENAME}`,
  );
  assert.throws(
    () => captureAgentPolicyPath({ env: {}, homeDir: "relative-home" }),
    { code: "POLICY_UNSAFE" },
  );
  assert.throws(
    () =>
      captureAgentPolicyPath({
        env: { COREDOC_HOME: ".coredoc" },
        homeDir: "/Users/example",
      }),
    { code: "POLICY_UNSAFE" },
  );
  assert.equal(
    captureAgentPolicyPath({
      env: { COREDOC_HOME: "/private/state/coredoc" },
      homeDir: "/Users/example",
    }),
    `/private/state/coredoc/${CAPTURE_AGENT_POLICY_FILENAME}`,
  );
});

test("loads an exact owner-only policy without tenant defaults", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "capture-agent-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, CAPTURE_AGENT_POLICY_FILENAME);
  await writeFile(path, `${JSON.stringify(POLICY)}\n`, { mode: 0o600 });

  assert.deepEqual(await loadCaptureAgentPolicy({ path }), POLICY);
});

test("normalizes a valid workspace UUID", () => {
  assert.deepEqual(
    validateCaptureAgentPolicy({
      ...POLICY,
      workspaceId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    }),
    {
      ...POLICY,
      workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  );
});

for (const [name, value] of [
  ["unknown field", { ...POLICY, tenant: "example" }],
  ["missing field", { schemaVersion: 1, serverOrigin: POLICY.serverOrigin }],
  ["HTTP origin", { ...POLICY, serverOrigin: "http://coredoc.example.com" }],
  ["origin path", { ...POLICY, serverOrigin: "https://coredoc.example.com/api" }],
  ["origin credentials", { ...POLICY, serverOrigin: "https://user@coredoc.example.com" }],
  ["invalid UUID", { ...POLICY, workspaceId: "workspace" }],
  ["non-v4 UUID", { ...POLICY, workspaceId: "11111111-1111-1111-8111-111111111111" }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateCaptureAgentPolicy(value), { code: "POLICY_INVALID" });
  });
}

test("rejects missing, permissive, symlinked, hard-linked, and oversized policy files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "capture-agent-policy-unsafe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = join(root, "valid.json");
  await writeFile(valid, `${JSON.stringify(POLICY)}\n`, { mode: 0o600 });

  await assert.rejects(loadCaptureAgentPolicy({ path: join(root, "missing.json") }), {
    code: "POLICY_UNAVAILABLE",
  });
  await assert.rejects(
    loadCaptureAgentPolicy({
      path: join(root, "missing-parent", CAPTURE_AGENT_POLICY_FILENAME),
    }),
    { code: "POLICY_UNAVAILABLE" },
  );

  await chmod(valid, 0o644);
  await assert.rejects(loadCaptureAgentPolicy({ path: valid }), {
    code: "POLICY_UNSAFE",
  });
  await chmod(valid, 0o600);

  await chmod(valid, 0o400);
  await assert.rejects(loadCaptureAgentPolicy({ path: valid }), {
    code: "POLICY_UNSAFE",
  });
  await chmod(valid, 0o600);

  const alias = join(root, "alias.json");
  await symlink(valid, alias);
  await assert.rejects(loadCaptureAgentPolicy({ path: alias }), {
    code: "POLICY_UNSAFE",
  });

  const hardLink = join(root, "hard-link.json");
  await link(valid, hardLink);
  await assert.rejects(loadCaptureAgentPolicy({ path: valid }), {
    code: "POLICY_UNSAFE",
  });

  const oversized = join(root, "oversized.json");
  await writeFile(oversized, "x".repeat(4097), { mode: 0o600 });
  await assert.rejects(loadCaptureAgentPolicy({ path: oversized }), {
    code: "POLICY_UNSAFE",
  });
});

test("rejects relative policy paths before opening them", async () => {
  await assert.rejects(loadCaptureAgentPolicy({ path: "capture-agent-policy.json" }), {
    code: "POLICY_UNSAFE",
  });
});
