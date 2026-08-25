import assert from "node:assert/strict";
import test from "../test/test-api.mjs";

import {
  repositoryKeyFromOrigin,
  sessionEnvText,
} from "./session-env.mjs";

test("exports session and normalized repository identity for workflow commands", () => {
  assert.equal(
    sessionEnvText(
      {
        hook_event_name: "SessionStart",
        session_id: "00893aaf-19fa-41d2-8238-13269b9b3ca0",
      },
      "git@github.com:coredoc/coredoc-parser.git",
    ),
    [
      "export COREDOC_WORKFLOWS_SESSION_ID=00893aaf-19fa-41d2-8238-13269b9b3ca0",
      "export COREDOC_WORKFLOWS_REPO_KEY=coredoc/coredoc-parser",
      "",
    ].join("\n"),
  );
});

test("normalizes common Git origin forms without credentials or host names", () => {
  assert.equal(
    repositoryKeyFromOrigin("https://github.com/org/repo.git"),
    "org/repo",
  );
  assert.equal(
    repositoryKeyFromOrigin("ssh://git@host:2222/group/sub/repo.git"),
    "group/sub/repo",
  );
  assert.equal(
    repositoryKeyFromOrigin("git@host:group/sub/repo.git"),
    "group/sub/repo",
  );
  assert.equal(
    repositoryKeyFromOrigin("ssh://git@host/group/sub/repo.git"),
    "group/sub/repo",
  );
  assert.equal(repositoryKeyFromOrigin(""), "");
  assert.equal(repositoryKeyFromOrigin("/Users/alice/private-repo"), "");
});

test("refuses unsafe or unrelated hook input", () => {
  assert.equal(
    sessionEnvText(
      {
        hook_event_name: "SessionStart",
        session_id: "bad; export TOKEN=stolen",
      },
      "org/repo",
    ),
    "",
  );
  assert.equal(
    sessionEnvText(
      { hook_event_name: "PostToolUse", session_id: "session-1" },
      "org/repo",
    ),
    "",
  );
  assert.equal(repositoryKeyFromOrigin("org/repo; export TOKEN=stolen"), "");
  assert.equal(repositoryKeyFromOrigin("../private-repo"), "");
  for (const unsafeOrigin of [
    ["https://user:", "secret@host/org/repo.git"].join(""),
    "https://user@host/org/repo.git",
    "https://host/org/repo.git?private=value",
    "https://host/org/repo.git#private-fragment",
    ["ssh://git:", "secret@host/org/repo.git"].join(""),
    "ssh:///Users/alice/private/repo.git",
    "file:///Users/alice/private/repo.git",
    "ftp://host/org/repo.git",
    "custom://host/org/repo.git",
  ]) {
    assert.equal(repositoryKeyFromOrigin(unsafeOrigin), "", unsafeOrigin);
  }
});
