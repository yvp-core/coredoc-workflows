---
name: coredoc-git-delivery
description: Prepare and perform an explicitly requested Git commit, push, branch publication, or pull request with staged/range secret scanning and branch-state checks. Use when the user asks to commit, push, publish, or open a PR; ordinary implementation work does not imply delivery.
---

# Git delivery

Resolve `<plugin-root>` as two directories above this file. This skill owns a
small delivery boundary; it is not another workflow router or state machine.

The preflight is read-only. It inspects local Git state and, for push or pull
request checks, reads live `origin` refs with `git ls-remote`. It never stages,
commits, fetches, pushes, creates a pull request, or writes Git configuration.
A `ready` result proves only the observed preconditions; it does not authorize
the named mutation.

Commit, push, and pull-request creation are separate operations. Each requires
an explicit request or authorization in the current conversation. A commit
request does not authorize a push. A push request does not authorize a pull
request (PR), and a PR request does not authorize merge. Preview the exact
outbound operation even when it is already authorized, but do not ask for a
redundant confirmation of that same operation.

Never automatically stage files. Do not fetch automatically, stash, reset,
switch branches, rewrite commits, or alter remotes. Never force-push. Do not
chain commit, push, and PR creation unless the user explicitly requested that
whole chain.

## Preflight

Run the matching preflight from the repository root:

```text
<plugin-root>/bin/coredoc-workflows git-delivery-preflight --operation commit
  --message-file <temporary-message-file>
<plugin-root>/bin/coredoc-workflows git-delivery-preflight --operation <push|pr>
  [--base <branch>]
```

Pass `--base` only when the user or repository names the intended PR base. The
preflight otherwise uses a valid recorded branch base, `origin/HEAD`, then
existing `main` or `master` refs. For commit, write the exact proposed message
with a final LF to a mode-0600 temporary file outside the repository and retain
it through post-commit verification. It performs no implicit fetch.

Interpret its closed result:

- `ready`: the observed state and secret scan permit the operation; authority
  is still checked separately.
- `needs-action`: state is incomplete or a medium-confidence credential/binary
  change needs review. Show the bounded reason and stop for the named action or
  decision.
- `blocked`: do not mutate. Report the bounded reason and recovery needed.

Secret findings contain only bounded identifiers such as rule, tier, scope,
path, line, source, and offending commit ID. Never print or copy the matched
value. The scanner examines staged added lines plus the exact proposed commit
message, and scans both metadata and patches for every outbound commit on push
or PR, including values added and removed before the final aggregate diff. It
does not exempt generated, test, fixture, or example paths. Total and
generated-file PR measurements are facts; repository policy decides any size
threshold.

## Commit

Use only the currently staged set. If nothing is staged, report the unstaged or
untracked state and ask which paths the user wants staged; do not choose or run
`git add` yourself. Concurrent writers use separate worktrees; a shared checkout
can switch branches between checks. Before committing, preview the staged paths, summary,
proposed message, and relevant validation already run. Run any missing
repository-required check that applies to the staged behavior. An unresolved
index is blocking even when Git reports staged entries.

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

The comparison catches a hook or concurrent process that changed the index,
parent, resulting commit tree, or exact message after preflight; verification
also scans the actual commit message, headers, and patch for secrets. Only a
`ready` verification completes the operation. Otherwise report that the local
commit exists but failed bounded verification, do not push it, and ask before
any amend, reset, or history rewrite. Remove the temporary message file after
verification. Do not amend an existing commit unless the user explicitly
requested an amend.

## Push

The preflight resolves the single effective push URL behind `origin` without
printing it, compares its live `refs/heads/<branch>` with local `HEAD`, and scans
exactly the commits planned for that destination. A different configured
upstream never changes the destination or narrows the scan. Multiple push URLs,
remote-ahead, diverged, unavailable, or locally unresolved remote state are
blocking; do not guess and do not suggest force.

Preview the branch, destination, outbound commit count, and scan result. After a
`ready` result and explicit push authorization, use the preflight's structured
target as separate command arguments:

```text
git -c remote.origin.mirror=false push --no-follow-tags --recurse-submodules=no origin <scanned-commit-sha>:refs/heads/<branch>
```

Pass every displayed token as a separate argument and use `push.source` as
`<scanned-commit-sha>`. Immediately before the mutation, verify that current
HEAD still equals the scanned commit and that the live destination still equals
the preflight's observed remote SHA (or is still absent); if either changed,
rerun preflight. Push the immutable SHA even after those checks so a concurrent
branch movement cannot add unscanned commits. `--no-follow-tags` prevents
ambient `push.followTags` from publishing unreviewed tags, and
`--recurse-submodules=no` keeps submodule publication outside this operation.
The one-command `remote.origin.mirror=false` override prevents a remote-local
mirror setting from broadening or invalidating the explicit refspec; it does not
write Git configuration. Never use a bare push, because its configured upstream
may not match the range that was scanned.

For a successful first publication where `push.configureUpstream` is true,
verify the remote ref first and then configure the already-published branch:

```text
git branch --set-upstream-to=origin/<branch> <branch>
```

Verify that local upstream separately. If this local setup fails, report the
remote push as successful and upstream setup as failed; do not repeat the push.
If the push result itself is uncertain, read the live destination ref before
considering a retry; never blindly retry a remote mutation.

## Pull request

Run the `pr` preflight against the intended base. It requires a non-trunk branch
with commits relative to the live base and a published branch exactly equal to
local `HEAD`. Its size facts always retain the total surface even when generated
files are classified separately. Generated-file classification must come from
the committed attribute snapshot; staged attribute drift or repository-local
attribute overrides block the measurement instead of silently changing it.

When reviewed intent accompanies an authorized implementation, use hosted
`intent_handoff` to save its structured bindings and strict delivers/retires in the
user's workspace session. Use the current reviewed commit SHA; refresh after any
code change. Reuse the existing handoff id and expectedVersion, with a new
idempotencyKey for each changed request. Before PR creation save without prNumber.
After creating or finding the PR, attach its number and read the handoff back.
Compare head, PR identity and declarations with the submitted data; repair a lost
or stale update within the authorized implementation. No PR-body metadata is read
by the server and no copy/paste ceremony is required. Pure commit/push requests
without an implementation handoff do not invent one.

Before creation, query the available forge provider or official CLI for an open
pull request with this repository and head branch. Classify the lookup as
`found`, `none`, or `unknown`:

- `found`: return the existing URL; do not create a duplicate.
- `none`: continue only with explicit PR authorization.
- `unknown`: a missing provider or failed query is unknown, never evidence that
  no PR exists. Stop rather than risking a duplicate.

Preview base, head, title, body, validation, and any Jira handoff link already
observed. Use the supported forge provider or official CLI, with the body passed
through a temporary file rather than shell interpolation. Do not publish source,
diffs, local paths, prompts, tokens, or provider errors in the body. If creation
is uncertain, repeat the existing-PR query before any retry.

## Completion

Verify only the operation performed: read the commit ID after commit, the live
destination ref after push, or the created/existing PR identity after PR
creation. Report skipped, blocked, failed, and uncertain states honestly. A
later operation remains unauthorized until the user requests it.
