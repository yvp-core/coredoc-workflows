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
  destinationKey,
  destinationPolicy,
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

  assert.deepEqual(await loadCaptureAgentPolicy({ path }), {
    ...POLICY,
    destinations: [
      {
        id: "default",
        serverOrigin: POLICY.serverOrigin,
        workspaceId: POLICY.workspaceId,
        default: true,
        repositories: [],
      },
    ],
  });
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
      destinations: [
        {
          id: "default",
          serverOrigin: POLICY.serverOrigin,
          workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          default: true,
          repositories: [],
        },
      ],
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
  await writeFile(oversized, "x".repeat(16 * 1024 + 1), { mode: 0o600 });
  await assert.rejects(loadCaptureAgentPolicy({ path: oversized }), {
    code: "POLICY_UNSAFE",
  });
});

test("rejects relative policy paths before opening them", async () => {
  await assert.rejects(loadCaptureAgentPolicy({ path: "capture-agent-policy.json" }), {
    code: "POLICY_UNSAFE",
  });
});

const LOCAL_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const LOCAL_DESTINATION = {
  id: "local",
  serverOrigin: "http://127.0.0.1:3000",
  workspaceId: LOCAL_WORKSPACE,
  repositories: ["/Users/maintainer/code/coredoc-parser"],
};
const NORMALIZED_POLICY = {
  ...POLICY,
  destinations: [
    {
      id: "default",
      serverOrigin: POLICY.serverOrigin,
      workspaceId: POLICY.workspaceId,
      default: true,
      repositories: [],
    },
  ],
};

test("schema 1 normalizes to one default destination and validates to itself", () => {
  const normalized = validateCaptureAgentPolicy(POLICY);
  assert.deepEqual(normalized, NORMALIZED_POLICY);
  assert.deepEqual(validateCaptureAgentPolicy(normalized), normalized);
  assert.equal(Object.isFrozen(normalized.destinations), true);
});

test("schema 2 lists the default first, mirrors it at the top level, and validates to itself", () => {
  const policy = validateCaptureAgentPolicy({
    schemaVersion: 2,
    destinations: [
      LOCAL_DESTINATION,
      { id: "cloud", serverOrigin: POLICY.serverOrigin, workspaceId: POLICY.workspaceId, default: true },
    ],
  });
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.serverOrigin, POLICY.serverOrigin);
  assert.equal(policy.workspaceId, POLICY.workspaceId);
  assert.deepEqual(
    policy.destinations.map(({ id, default: isDefault }) => [id, isDefault]),
    [["cloud", true], ["local", false]],
  );
  assert.deepEqual(validateCaptureAgentPolicy(policy), policy);
  assert.deepEqual(destinationPolicy(policy.destinations[1]), {
    schemaVersion: 1,
    serverOrigin: "http://127.0.0.1:3000",
    workspaceId: LOCAL_WORKSPACE,
  });
  assert.equal(destinationKey(policy.destinations[1]), `http://127.0.0.1:3000 ${LOCAL_WORKSPACE}`);
});

const DEFAULT = { id: "cloud", serverOrigin: POLICY.serverOrigin, workspaceId: POLICY.workspaceId, default: true };
for (const [name, destinations] of [
  ["localhost instead of the loopback address", [{ ...DEFAULT, serverOrigin: "http://localhost:3000" }]],
  ["http on a LAN address", [DEFAULT, { ...LOCAL_DESTINATION, serverOrigin: "http://10.0.0.5:3000" }]],
  ["two defaults", [DEFAULT, { ...LOCAL_DESTINATION, default: true, repositories: undefined }]],
  ["no default", [LOCAL_DESTINATION]],
  ["non-default without repositories", [DEFAULT, { ...LOCAL_DESTINATION, repositories: undefined }]],
  ["default with repositories", [{ ...DEFAULT, repositories: ["/x"] }]],
  ["repository listed twice", [DEFAULT, LOCAL_DESTINATION, { ...LOCAL_DESTINATION, id: "other", workspaceId: "33333333-3333-4333-8333-333333333333" }]],
  ["relative repository path", [DEFAULT, { ...LOCAL_DESTINATION, repositories: ["code/coredoc-parser"] }]],
  ["duplicate id", [DEFAULT, { ...LOCAL_DESTINATION, id: "cloud" }]],
  ["same origin and workspace twice", [DEFAULT, { ...LOCAL_DESTINATION, serverOrigin: POLICY.serverOrigin, workspaceId: POLICY.workspaceId }]],
  ["bad id", [{ ...DEFAULT, id: "Cloud Prod" }]],
  ["unknown destination field", [{ ...DEFAULT, token: "x" }]],
]) {
  test(`rejects schema 2 with ${name}`, () => {
    assert.throws(
      () => validateCaptureAgentPolicy({ schemaVersion: 2, destinations }),
      { code: "POLICY_INVALID" },
    );
  });
}

test("loads a schema 2 policy file with a loopback destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "capture-agent-policy-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, CAPTURE_AGENT_POLICY_FILENAME);
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 2, destinations: [DEFAULT, LOCAL_DESTINATION] })}\n`,
    { mode: 0o600 },
  );
  const loaded = await loadCaptureAgentPolicy({ path });
  assert.equal(loaded.destinations.length, 2);
  assert.equal(loaded.destinations[1].serverOrigin, "http://127.0.0.1:3000");
});
