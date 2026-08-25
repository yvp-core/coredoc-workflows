import assert from "node:assert/strict";
import test from "../test/test-api.mjs";

import {
  parseCommitLog,
  parseNumstat,
  parseWindow,
  summarizeEvidence,
} from "./retro-evidence.mjs";

test("accepts bounded relative windows and rejects ambiguous input", () => {
  assert.deepEqual(parseWindow("1h"), {
    label: "1h",
    gitSince: "1 hour ago",
  });
  assert.deepEqual(parseWindow("7d"), {
    label: "7d",
    gitSince: "7 days ago",
  });
  assert.deepEqual(parseWindow("4w"), {
    label: "4w",
    gitSince: "4 weeks ago",
  });
  assert.throws(() => parseWindow("yesterday"), /Invalid --since value/);
  assert.throws(() => parseWindow("0d"), /Invalid --since value/);
});

test("parses bounded commit metadata without reading commit bodies", () => {
  const output = [
    "abc123\x1f2026-07-31T08:00:00+03:00\x1fAda\x1ffeat(core): add route\x1e",
    "def456\x1f2026-07-30T09:00:00+03:00\x1fLin\x1ffix: repair timeout\x1e",
  ].join("\n");

  assert.deepEqual(parseCommitLog(output), [
    {
      sha: "abc123",
      authoredAt: "2026-07-31T08:00:00+03:00",
      author: "Ada",
      subject: "feat(core): add route",
    },
    {
      sha: "def456",
      authoredAt: "2026-07-30T09:00:00+03:00",
      author: "Lin",
      subject: "fix: repair timeout",
    },
  ]);
});

test("summarizes change evidence without treating line counts as productivity", () => {
  const commits = parseCommitLog(
    [
      "abc123\x1f2026-07-31T08:00:00+03:00\x1fAda\x1ffeat(core): add route\x1e",
      "def456\x1f2026-07-30T09:00:00+03:00\x1fLin\x1ffix: repair timeout\x1e",
      "ghi789\x1f2026-07-30T10:00:00+03:00\x1fAda\x1fplain subject\x1e",
    ].join("\n"),
  );
  const changes = parseNumstat(
    [
      "10\t2\tpackages/core/src/route.ts",
      "7\t1\tpackages/core/src/route.test.ts",
      "-\t-\tassets/example.bin",
      "2\t0\tREADME.md",
    ].join("\n"),
  );

  assert.deepEqual(summarizeEvidence(commits, changes), {
    commitCount: 3,
    contributors: ["Ada", "Lin"],
    activeDays: ["2026-07-30", "2026-07-31"],
    filesChanged: 4,
    testFilesChanged: 1,
    insertions: 19,
    deletions: 3,
    binaryChanges: 1,
    commitTypes: [
      { name: "feat", count: 1 },
      { name: "fix", count: 1 },
      { name: "other", count: 1 },
    ],
    topAreas: [
      { name: "packages", count: 2 },
      { name: "(root)", count: 1 },
      { name: "assets", count: 1 },
    ],
  });
});

test("rejects malformed git records instead of silently dropping evidence", () => {
  assert.throws(() => parseCommitLog("broken"), /unexpected commit record/);
  assert.throws(() => parseNumstat("10\tmissing-path"), /unexpected numstat record/);
});
