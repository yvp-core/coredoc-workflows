---
name: coredoc-workflows
description: Route engineering work through the smallest Coredoc workflow for investigation, planning, implementation, review, specification, browser QA, benchmarking, security review, learning, or retrospectives. Use when asked to route, orchestrate, or choose a workflow for a task.
---

# Coredoc workflow router

Resolve `<plugin-root>` as two directories above this file.

## Route once

Classify intent as `direct`, `diagnose`, `design`, `change`, `review`, `spec`,
`qa`, `qa-report`, `benchmark`, `security`, `browse`, `learn`, or `retro`; risk
as `low|normal|high`; and scale as `large` only when creating a component or
subsystem, changing a shared/cross-package contract, or requiring multiple test
surfaces.

If the user supplied a Jira/Notion/GitHub or similar relation intended as a work
item, first read and apply
`<plugin-root>/resources/methodology/work-item-routing.md`.

When Jira is the actual task source, also read
`<plugin-root>/skills/coredoc-jira/SKILL.md` for bounded task context from the
same provider read. A task locator or acceptance of a specification never
authorizes posting a Jira comment or changing issue status.

Run exactly once:

```text
<plugin-root>/bin/coredoc-workflows route-task --intent <intent> --risk <risk> --scale <normal|large>
  [--bug-like] [--data-sensitive] [--runtime-sensitive]
  [verified work-item groups]
```

Pass values as separate process arguments; never interpolate raw user text into
shell source. Never pass `--task-id`: it is only for programmatic task-owning
invokers holding a server-issued canonical ID. Before repeating a skip, read the
previous run's unmet and skipped gates in the returned `previousRunGates`.

On Codex, use `sandbox_permissions: "require_escalated"` for this trusted
`coredoc-workflows route-task` command and for every `stage-run` and
`finish-run` command. Managed capture uses loopback `127.0.0.1:43181`, which the
sandbox denies; do not try them sandboxed first. This elevation applies only to
the plugin commands and never broadens task authority.

A capture failure never blocks the work. If `runStateStatus` is `unattributed`,
state that the host cannot provide the completion gate, execute the stage
methods, and skip all `coredoc-workflows stage-run` and `finish-run` commands.

Tell the user the selected route in one sentence. If the route is `direct`, do
the task directly, then run `finish-run`. Preflight available tools for a
delimited `Coredoc` MCP namespace; if absent, say graph grounding is unavailable
and continue.

For `scale: large` or a multi-stage route, inspect available non-plugin skills,
show up to three relevant candidates, and ask once whether to add them as
context. Invoke and later require only explicitly approved skills.

## Execute the returned DAG

Gather only `contextProviders`, within each one's `access`, then execute stages
in dependency order with the named plugin skills. Before the first stage that
edits the repository, and before a `direct` change, read and apply
`<plugin-root>/resources/methodology/branch-start.md` once. For substantial
routes, apply `<plugin-root>/resources/methodology/subagent-dispatch.md`.

For an attributed run, the following command runs immediately before the actual
routed stage work:

```text
<plugin-root>/bin/coredoc-workflows stage-run start --stage-id <stage-id>
```

When that attempt ends, run:

```text
<plugin-root>/bin/coredoc-workflows stage-run finish --stage-id <stage-id> --outcome <success|failed|blocked>
  [--spec-path <repo-relative path>]
```

On a checkout enrolled to a Coredoc workspace, a `success` close is checked
against what the host observed in that attempt: `spec` needs an observed
intent-context read, and `implement` and `review` need at least one observed
Coredoc read that answered; repository searches and Coredoc writes never count.
A refusal names its remedy and leaves the stage open: satisfy it, or skip with
the flag it names and a true reason, never a fabricated one. `warn` mode, the
default, prints the refusal and still closes (`gatesWarned`). `failed` and
`blocked` closes are never refused.

Run stage boundary commands sequentially: never batch them in parallel. Map
`DONE` and `DONE_WITH_CONCERNS` to `success`, and `BLOCKED` to `blocked`. On
`NEEDS_CONTEXT`, finish the current stage as `blocked`, keep the run open, ask
the one resolving question, then restart the same stage as the next attempt.
The parent coordinator exclusively owns `route-task`, `stage-run`, and
`finish-run`.

After a context compaction, in a resumed session, or whenever the run state is
uncertain, run `<plugin-root>/bin/coredoc-workflows run-status` (read-only)
before any lifecycle command. `status: inactive` from it, `stage-run`, or
`finish-run` means this session has no live run: it already closed the run, or
its suspended run expired while the session was away; capture or relay delivery
cannot cause it, so never blame them. Then stop: do not continue the stage
method or claim recorded progress. Report a run this session already finished
instead of finishing it again; otherwise run `route-task` again and reopen the
stage the new route returns.

A stage with `gate: user-approval` waits for the user. Once the design stage has
presented what `<plugin-root>/resources/methodology/plan-review-gate.md`
requires, close the design stage before pausing, then ask one explicit
**Accept and implement / Revise** decision with the structured input tool when
available; otherwise ask the same concise two-option question in prose and
wait. Only a fresh affirmative user reply to that decision counts: it both
accepts the reviewed specification and authorizes the gated implementation
stage. An acknowledgement, a partial answer, or an acceptance with a requested
change is a revision request. A revision returns to specification and review,
or to the spec's alignment checkpoint when it exposes a new material user-owned
decision; add no generic approval round. For a PRD-less specification, that
reply also accepts its own intent: before opening the implementation stage,
when `intent_propose` is visible, apply the single-approval clause of
`<plugin-root>/resources/methodology/spec-lifecycle.md` without asking again.
Do not run `coredoc-workflows finish-run` while paused.

In the same host session, including one resumed after a plain exit, resume the
same `runId` without routing again. In a new session, route again and reuse the
local spec. For an authorized continuation, verify the recorded post-review
approval and that the approved source and scope are unchanged, then continue
under that approval. The accepted status alone is not enough. Revisit
spec/design and obtain fresh approval only if the approved material changed or
the original approval cannot be recovered.

## Finish and hand off

After the final stage, run:

```text
<plugin-root>/bin/coredoc-workflows finish-run --outcome <success|failed|blocked>
  [--require-skill <approved-id> ...]
```

A standalone specification run that delivered a draft parks instead with
`--outcome delivered-draft --spec-path <repo-relative path>`; later,
`coredoc-workflows spec accept --finish` or `spec abandon --reason "<text>"`
closes it.

For workflows with findings, pass `--findings-measurement measured` and balanced
integer counts (`remaining = initial - resolved + introduced`); otherwise use
`not-applicable` or leave `not-measured`. If graph tools were used, pass
`--coredoc-status complete|partial|unavailable` and any `--coredoc-gap <code>`,
or `--skip-intent "<reason>"`; if the `Coredoc` namespace was absent, pass
`--coredoc-status unavailable --coredoc-gap capability-missing`. When finish
reports `feedbackOwed`, wait until the entire task is delivered, then apply
`<plugin-root>/resources/methodology/workflow-feedback.md`: one silent record per
session, no question. Resolve `submit_session_feedback` by tool contract,
never by a skill name.

Stop at the authorization boundary: diagnosis/review is read-only, and
implementation does not authorize commit, publish, deploy, remote mutation, or
new workflow artifacts. Never persist prompts, command text, source, diffs,
fixtures, paths, or a parallel workflow ledger as evidence.
