## Specification lifecycle

Read this only inside a routed `coredoc-workflows` run, or when the user asks
for acceptance of a delivered draft. A standalone specification written in an
ordinary session needs none of it: the draft is the handoff.

### Status

Keep `status: draft` through plan review. In a gated routed workflow, the fresh
affirmative post-review reply both accepts the reviewed
specification and authorizes implementation; for a PRD-less specification that
same reply is the acceptance of its intent (single approval, see below). After its read-only preflight and
proof-plan announcement, the implementation stage changes a draft frontmatter to
`status: accepted` as its first repository write, before any code or test edit;
it preserves an unchanged accepted status from a prior session. A requested
revision returns to specification and review instead. For standalone
specification delivery, deliver the draft as the handoff and set
`status: accepted` only when the user explicitly approves the completed draft;
do not add a confirmation round to obtain it. Alignment approval or a review
verdict alone never accepts the specification.

### Coordinator commands

Tell the coordinator which artifact you wrote so the run records it. It closes
the specification stage with `stage-run finish --stage-id spec --outcome
success --spec-path <repo-relative path>`, or a standalone delivery with
`finish-run --outcome delivered-draft --spec-path <repo-relative path>`. Those
two are the coordinator's commands; never run them yourself.

`delivered-draft` parks the run for up to 14 days awaiting approval, and the
draft carries `run: <runId>` back to it. When approval arrives, usually in a
later session, do not edit `status:` by hand: reopen the parked run, accept the
specification's own intent as below, and let the acceptance command make the transition.
These two are yours to run:

```text
<plugin-root>/bin/coredoc-workflows spec accept --path <repo-relative spec path>
<plugin-root>/bin/coredoc-workflows spec accept --finish
```

`spec accept --path` returns the intent instruction; `--finish` then writes
`status: accepted` itself. It checks for no candidates and blocks nothing: the
approval is the acceptance, so propose and accept the verbatim items before
running it. `--skip-intent "<reason>"` records a signed waiver of the intent
step. If the user drops the draft, run `spec abandon --reason "<text>"`.

### Intent acceptance at approval

When the person approves the specification, it introduces or changes product
intent of its own (no PRD owns it), and this session has a cloud Coredoc intent
write capability — `intent_propose` is visible — run the "At document approval"
write stage of `<plugin-root>/resources/methodology/intent-context.md` at that
approval: propose that intent as one batch, sourced at the repo-qualified spec
path and stable section id, then accept the verbatim items under its
single-approval clause without asking again, and report each `itemId`,
`outcome`, and `version` as `proposedIntentIds` beside `intentIds` and
`intentVersions`. Every paraphrased item, and every autonomous or service-token
run, stays a candidate; anchoring or recording is never yours. A draft
specification proposes nothing. A specification written from a PRD proposes
and accepts nothing: the PRD's approval accepted its intent, and the
specification carries the PRD's `intentIds` through unchanged. Implementation
never accepts intent. When no intent capability is present, proceed from repository
evidence alone and do not mention intent context in the output.

### Privacy gate

When a Bash tool is available, run the privacy gate over the exact final file
before it is committed or filed anywhere:

```text
<plugin-root>/bin/coredoc-workflows redact-scan <spec-path>
```

Do not write on a HIGH finding. Never echo an unmasked finding. Without a Bash
tool, read the file once for credentials, tokens, connection strings, and
personal data, and say that the scan did not run.
