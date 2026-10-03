---
name: coredoc-git-delivery
description: Commit, push, publish a branch, or open a pull request behind secret scanning and branch-state checks. Use when the user asks to commit, push, publish, or open a PR.
---

# Git delivery

Resolve `<plugin-root>` as two directories above this file.

Commit, push, and pull-request creation are separate operations; each needs an
explicit request in the current conversation (one request may name the whole
chain). A commit request does not authorize a push. A push request does not
authorize a pull request (PR), and a PR request does not authorize merge.
Preview the exact outbound operation even when it is already authorized, but do
not ask for a redundant confirmation of that same operation.

Never automatically stage files. Do not fetch automatically, stash, reset,
switch branches, rewrite commits, or alter remotes. Never force-push or suggest
it.

## Preflight

Run the matching read-only preflight from the repository root:

```text
<plugin-root>/bin/coredoc-workflows git-delivery-preflight --operation commit
  --message-file <temporary-message-file>
<plugin-root>/bin/coredoc-workflows git-delivery-preflight --operation <push|pr>
  [--base <branch>]
```

Pass `--base` only when the user or repository names the intended PR base. For
commit, write the exact proposed message with a final LF to a mode-0600
temporary file outside the repository and retain it through post-commit
verification.

Act on its `verdict`:

- `ready`: the observed state and secret scan permit the operation; it proves
  only those preconditions and never authorizes the mutation.
- `needs-action`: show the `reason` and stop for the named action or decision.
- `blocked`: do not mutate. Report the `reason` and the recovery needed.

Secret findings carry only bounded identifiers; never print or copy the matched
value. A finding in a test, fixture, example, or generated path still blocks.

## Commit

Use only the currently staged set. If nothing is staged, report the unstaged or
untracked state and ask which paths the user wants staged; do not choose or run
`git add` yourself. Concurrent writers use separate worktrees; a shared checkout
can switch branches between checks. Before committing, preview the staged paths, summary,
proposed message, and relevant validation already run. Run any missing
repository-required check that applies to the staged behavior.

Record `repo.branch` as the intended branch, `repo.head` as the expected parent,
`commit.indexFingerprint` as the scanned tree, and `commit.messageFingerprint`
as the exact proposed message. Immediately before committing, rerun the commit
preflight against the same message file with `--expected-branch <scanned-branch>`
and require the branch, parent, tree and message to be unchanged. A branch
switch is drift even when both branches point to the same SHA. After a `ready`
result and explicit commit authorization, create one non-interactive commit
using `git commit --cleanup=verbatim --file <temporary-message-file>`. Do not
bypass repository hooks.

Read the created commit ID, then verify the actual commit before reporting
success:

```text
<plugin-root>/bin/coredoc-workflows git-delivery-preflight
  --verify-created <created-commit-sha>
  --expected-branch <scanned-branch>
  --expected-parent <scanned-parent-sha>
  --expected-index <scanned-index-fingerprint>
  --expected-message <scanned-message-fingerprint>
```

Only a `ready` verification completes the operation. Otherwise report that the
local commit exists but failed bounded verification, do not push it, and ask
before any amend, reset, or history rewrite. Remove the temporary message file
after verification.

## Push

Preview the branch, destination, outbound commit count, and scan result. After a
`ready` result and explicit push authorization, run this command, passing every
displayed token as a separate argument and `push.source` as
`<scanned-commit-sha>`:

```text
git -c remote.origin.mirror=false push --no-follow-tags --recurse-submodules=no origin <scanned-commit-sha>:refs/heads/<branch>
```

Immediately before the mutation, verify that current HEAD still equals the
scanned commit and that the live destination still equals the preflight's
observed remote SHA (or is still absent); if either changed, rerun preflight.
Never use a bare push.

For a successful first publication where `push.configureUpstream` is true,
verify the remote ref first and then configure the already-published branch:

```text
git branch --set-upstream-to=origin/<branch> <branch>
```

If this local setup fails, report the remote push as successful and upstream
setup as failed; do not repeat the push. If the push result itself is
uncertain, read the live destination ref before considering a retry; never
blindly retry a remote mutation.

## Pull request

Run the `pr` preflight against the intended base.

When an authorized implementation carries reviewed intent, save its hosted
`intent_handoff` from the prepared data, or update the existing handoff with its
id, current `expectedVersion`, and a new idempotencyKey for each changed
request. Use the current reviewed commit SHA; refresh it after any code change.
Save without prNumber before PR creation. After creating or finding the PR,
attach its number, read the handoff back, compare it with what you submitted,
and repair a lost or stale update within the authorized implementation. Commit
or push requests without an implementation handoff do not invent one.

Before creation, query the available forge provider or official CLI for an
existing open pull request with this repository and head branch:

- `found`: return the existing URL; do not create a duplicate.
- `none`: continue only with explicit PR authorization.
- `unknown`: a missing provider or failed query is unknown, never evidence that
  no PR exists. Stop rather than risking a duplicate.

Preview base, head, title, body, validation, and any Jira handoff link already
observed. Use the supported forge provider or official CLI, with the body passed
through a temporary file rather than shell interpolation. Do not publish source,
diffs, local paths, prompts, tokens, or provider errors in the body. If creation
is uncertain, repeat the existing-PR query before any retry.
