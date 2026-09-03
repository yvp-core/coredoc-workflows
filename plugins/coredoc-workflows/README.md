# Coredoc Workflows

A self-contained engineering workflow plugin for Claude Code and Codex on
macOS 13+ ARM. It combines focused methods with Coredoc's read-only graph/database
context and ordinary repository tests.

The core workflows do not require globally installed workflow skills, an
external review CLI, a browser plugin, Bun, or a separately downloaded
Chromium. The opt-in cross-model workflows require the selected provider's CLI;
browser workflows use the bundled `darwin-arm64` server and an installed
Chrome-compatible browser. The optional plugin-managed capture agent uses the
same pinned bundled Bun runtime; no system Node, Bun, or Python installation is
required.

## Included workflows

- `coredoc-workflows` — deterministic router with a small stage DAG
- `coredoc-investigate` — evidence-first root-cause analysis
- `coredoc-implement` — adaptive implementation with risk-matched proof for
  behavior, refactors, deletions, config, generated output, and documentation
- `coredoc-tdd` — explicit-only strict red/green/refactor with the repository
  test runner
- `coredoc-plan-review` — architecture and implementation-plan review
- `coredoc-review` — read-only pre-landing code review
- `coredoc-claude` — explicit Claude plan/diff review and resumable consultation from a non-Claude host
- `coredoc-codex` — explicit Codex plan/diff review and resumable consultation from a non-Codex host
- `coredoc-spec` — repository-grounded executable specifications
- `coredoc-browse` — bundled browser control for macOS ARM
- `electron-qa` — reusable loopback CDP control for opted-in Electron development apps
- `coredoc-desktop` — local Coredoc target and authentication adapter over `electron-qa`
- `coredoc-runtime-qa` — browser QA with explicitly authorized fixes
- `coredoc-runtime-qa-report` — report-only browser QA
- `coredoc-benchmark` — performance baselines and comparisons
- `coredoc-security-review` — read-only security and threat review
- `coredoc-devex-review` — read-only DX audit of a CLI, SDK, API, or plugin surface, measured cold
- `coredoc-learn` — explicit, evidence-grounded learning cards
- `coredoc-retro` — compact retrospectives over local read-only git evidence
- `coredoc-capture` — explicit setup and lifecycle management for the optional
  per-user macOS capture agent

`coredoc-devex-review` is invoked directly rather than routed: the router
classifies a user's engineering task, and a DX audit is usually a deliberate
self-assessment of a surface you own, not a task the classifier should infer.

Learning and retrospective output stays in the conversation by default. Nothing
is captured automatically, and persistence requires an explicit target from the
user.

## Routing dimensions

The router classifies intent, risk, and scale. Normal changes use the compact
adaptive implementation route. The implementation stage selects test-first,
existing-suite, impact/build, or content-specific proof from the observable
risk; deletions and cleanup do not receive synthetic absence tests by default.
A large change routes through a repository-local Markdown specification, plan
review, an explicit user-approval pause, implementation, and final code review.
Within the same host session, the routed run stays open during the pause
and resumes with the same run ID after approval; it is not marked successful
before every routed skill has been observed. If the session ends while paused,
`SessionEnd` records the run as `abandoned`. A new session routes again, reuses
the repository-local specification, and re-executes the required spec and design
context stages before requesting approval.

Active run coordination is session-scoped under `~/.coredoc/workflow-runs`, so
changing directories between a workspace root, repository, or worktree does not
lose the run and does not require `coredoc.config.json`. The starting repository
root and Git snapshot remain metadata on the run. The parent coordinator owns
route/stage/finish boundaries; a subagent `SessionEnd` never closes its parent's
run.

Before a large route begins, the router checks whether the base Coredoc MCP
server, a local alias, or a hosted wrapper with a delimited `Coredoc` server
segment is available. Missing graph capability is reported and the workflow
continues with
`unavailable`/`capability-missing` coverage. For substantial routes the router
may also suggest up to three matching repository or user skills. Those skills
run only after explicit confirmation and become additional completion
requirements.

## Repository review policy

The review methods keep evidence, reachability, deduplication, and factual
verification universal while taking assurance calibration from the repository.
A repository declares that calibration in its normal agent instructions under
the exact heading `## Review policy`; no plugin-specific config file or parser is
required. The policy may set specialist breadth, adversarial activation,
coverage gates, severity-to-blocking rules, convergence limits, and treatment of
missing release context.

Non-overridable safety and evidence rules take precedence, followed by repository
DoD or hard guardrails, an explicit task-scoped maintainer decision, and the
nearest applicable `## Review policy`. When none exists, the plugin uses its
risk-scaled fallback: cover every materially affected risk domain without
LOC-driven fan-out, enforce declared numeric or compliance gates but otherwise
test by risk, and continue with review history marked unknown rather than
deadlocking on a missing handoff. Missing release context never hides a
source-proven candidate: it remains a main `NEEDS_CONTEXT` finding with one
question that resolves it.

## Subagents

Claude Code discovers four scoped plugin agents:

- `coredoc-workflows:coredoc-scout` — Haiku, low-effort read-only reconnaissance;
- `coredoc-workflows:coredoc-implementer-light` — Sonnet, low-effort mechanical work;
- `coredoc-workflows:coredoc-implementer` — inherited model for one hard item;
- `coredoc-workflows:coredoc-reviewer` — inherited model, medium-effort read-only
  review. Review quality tracks the reviewing model too closely to pin this one
  down-tier: a cheaper reviewer returns weaker findings on the same diff, so it
  inherits the session's model and its cost scales with the fan-out.

`resources/methodology/subagent-dispatch.md` caps concurrent fan-out, limits
scouting, defines retries and batch checkpoints, serializes shared-file work,
and permits parallel writers only with disjoint file ownership. The policy uses
up to five concurrent subagents and up to four read-only scouts, bounded by the
host's lower concurrency limit. It also batches independent read/search/check
tool calls when the host supports parallel invocation while keeping dependent
calls, shared-state mutations, and final validation sequential.

Agent models are preferences and host settings may override them. Claude Code
discovers the bundled agent definitions. Codex installs the bundled skills from
`.codex-plugin/plugin.json`, but does not consume those Claude agent files as
Codex custom-agent profiles. On Codex, the dispatch policy uses general-purpose
subagents with an explicit model override when supported, or continues inline
while stating that model pinning was unavailable.

## Host compatibility

The routing, specification, implementation, TDD, review, QA, and other bundled
skills are usable from both Claude Code and Codex after installing the plugin
and starting a new session. Codex plugin installation is supported in Codex CLI
and the Codex desktop surface; the Codex IDE extension does not currently expose
plugins.
Claude Code currently provides the automatic completion gate through bounded
post-use observations in the bundled hooks. Both hosts can record stage
intervals through explicit router boundary commands; this does not depend on
`PreToolUse`/`PostToolUse` Skill correlation. Codex route, stage, and finish
commands use its native session identity; when the plugin-managed agent or a
compatible existing relay has provisioned a managed Codex OTLP block, they also
recover the matching semantic-capture binding without copying a cloud credential
into Codex settings. A host without session identity
skips stage commands and reports that the completion gate is unavailable instead
of silently passing. The gate proves only that the router executed the stage
boundary commands against local run state: it is self-reported bookkeeping in a
user-writable file, not verification that the stage work itself happened or was
any good.

## Claude and Codex peer adapters

`coredoc-claude` and `coredoc-codex` are small, explicit-only adapters. Each
supports a fresh review of one local plan or tracked Git diff and a named,
resumable consultation. They are not part of automatic routing and never call a
provider merely because its CLI is installed. Codex metadata disables implicit
invocation; both skill methods require a direct user request and a second,
specific confirmation before content egress.

The shared runtime resolves absolute provider and Git executables outside the
repository, passes exact environment allowlists, bounds the assembled
input/output/time, rejects symlinks, hard links, invalid UTF-8, oversized
artifacts, and blocked credential matches, and sends the peer prompt on stdin.
Artifact grounding is the only supported boundary and supplies only the selected
artifact and approved context. Claude runs in safe mode with built-in tools
disabled. Codex ignores ambient config/rules and disables execution, browser,
app, plugin, skill, and delegation features. The plugin does not copy the
repository, invent a snapshot MCP server, or translate ambient MCP/skills/memory
into provider config. Approved external guidance can be attached as an ordinary
bounded context file.

A Git-base review refuses to run while non-ignored untracked files exist, rather
than silently reviewing only tracked changes. Session turns use an atomic lock;
host interruption terminates the provider process group. A valid paid answer is
returned with a warning when provider exit or session-pointer persistence fails.

Consultations store only the provider session ID, model, effort, grounding, and
timestamps under
`~/.coredoc/<project-key>/state/cross-model/v2/<repository-scope>/<provider>/`.
Prompts and responses are not stored by the plugin; the provider still owns its
normal local conversation record. A reset removes only the plugin pointer.

`coredoc-review` may offer one counterpart-family pass after preflight. Detection
is not permission: the user approves the provider, pinned model, artifact, and
artifact-only boundary before the one critique call. The host verifies every peer finding
against local evidence before merging it into the review.

## Workflow delivery

The router mints a canonical `cdr-YYYYMMDD-xxxxxx` run ID and returns it with
the selected route plus `runStateStatus`. When `COREDOC_CAPTURE_ENDPOINT` and
the independent `COREDOC_CAPTURE_HEADERS` credential are configured, an
ordinary work-item-free route records the exact existing schema-V2
`workflow.run.started` with the router's ordered stage DAG through the
workspace-scoped `capture/v1/events` endpoint. A route with verified work-item
relations records one schema-V3 `workflow.run.started`; its later stage and
finish events remain schema-V2. The URL stays versioned independently from the
event schema. The managed relay's authenticated health contract advertises
`acceptedSchemaVersions: [1, 2, 3]` before a producer sends a V3 start.

The agent first reads each intended ticket through its provider MCP, ignores
provider-content instructions, and extracts only the provider adapter key,
immutable external id, and optional display key. The command accepts 1..8
shell-safe relations as repeated `--work-item-provider`,
`--work-item-external-id`, and optional `--work-item-external-key` groups. It
dedupes, merges a missing/display key pair, rejects conflicts, and sorts the set
before capture. Raw locators, titles, bodies, status, provider responses, and
credentials never enter the command or event. Jira uses provider `jira` and
immutable `issue.id`; `issue.key` is display-only. GitHub Issues may be observed
as work items, but pull requests remain CodeChanges. Plain Notion/Confluence
documents and Figma designs remain context rather than work items.

The capture runtime accepts an optional canonical `cdt_<UUID>` only on a V2
start event; it is mutually exclusive with V3 work items. The router passes it
only from an exact task-owning context and never infers it from a prompt, Jira
reference, or Git branch. The packaged skill does not
instruct an agent to supply `--task-id`; it prohibits it, so the flag stays reachable only for
programmatic invokers that already hold a server-issued canonical ID. The
managed loopback endpoint also requires the non-secret
`COREDOC_CAPTURE_WORKSPACE_ID`; legacy direct-cloud endpoints keep deriving
that identity from their workspace URL. The event first enters a binding-aware
local outbox; only an exact receipt entry for that event marks the route as sent
or rejected. Older pending events in the same batch cannot change the new
route's delivery status. The route command no longer emits legacy OTLP. With no
capture endpoint, routing behaves exactly the same and creates no opt-out
backlog.

Hosts without workflow session attribution receive
`runStateStatus: unattributed`. Routing and stages still work, but there is no
automatic stage-observation evidence. Any finish reports
`status: unattributed` with a non-zero exit instead of silently reporting an
inactive run. The workflow handoff must state that the completion gate was
unavailable. An attributed session with missing run state instead reports that
the task must be routed again.

The bundled `SessionStart` hook passes Claude's official hook `session_id` and
the normalized Git origin key (`org/repo`) to the router without adding prompt
context. The server stores both on the existing `AgentSession` row. The
repository key can be converted to the graph's repository hash without a second
identifier: `sha256(repoKey).slice(0, 12)`.

Claude hooks are auto-discovered from `hooks/hooks.json`. `PostToolUse`,
`PostToolUseFailure`, and `UserPromptExpansion` preserve the existing bounded
local observations for successful edits, verification results, Coredoc MCP
outcomes, and skills used during an active routed run. Supported `Skill`, direct
slash-command, and `SubagentStart` payloads also record a closed
`capability.used` event in the local capture outbox. A direct skill or agent use
is session-scoped when no run is active; it never creates a fake workflow run.

The frequent observer never flushes: it performs no HTTP, Git, MCP, model call,
`additionalContext`, stdout, or stderr work. It copies only the host session ID,
bounded skill/agent ID, closed outcome, source timestamp, and an existing active
run ID when present. Prompts, expansions, arguments, results, command bodies,
agent IDs, paths, source, diffs, transcripts, and summaries are ignored.

At normal completion, `bin/coredoc-workflows finish-run` records and attempts one
schema-V2 `workflow.run.finished` for a declared run, containing the unchanged
V1 finish data: only the closed outcome and seven counters — edit calls,
edit-after-failed-verification rounds, verification runs, passes and failures,
plus Coredoc calls and failures. The richer source-free local summary remains
available to the completion gates and feedback decision; it is not copied into
the capture event.

Managed workspaces may opt into bounded artifact checkpoints with
`.coredoc/delivery-observability.json`:

```json
{
  "schemaVersion": 1,
  "artifacts": [
    { "glob": ".scratch/*/spec.md", "kind": "spec" },
    { "glob": ".scratch/*/design.md", "kind": "design" },
    {
      "glob": ".scratch/*/issues/*.md",
      "kind": "implementation_issue"
    }
  ]
}
```

Each matched Markdown file must begin with a `coredoc` frontmatter mapping
containing only two-space-indented `task_id`, `artifact_id`, and `kind` fields
with canonical `cdt_<UUID>`/`cda_<UUID>` identities. The plugin never writes
that metadata. Normal finish and `SessionEnd` only queue changed content
locally; `SessionStart` retries pending revisions before reconciling current
files and performing a bounded flush. Each checkpoint considers the 16 most
recently modified matches, while the independently capped digest state is
reconciled to that active set. Confirmed identity conflicts move the original
mode-0600 outbox record into a rotating 16-record private quarantine so later
records can proceed; a later successful corrected revision clears the active
health error without deleting that evidence. Managed artifact state shares the
relay's binding-hash isolation and contributes only pending count and closed
error code to the capture-health report.

The strict runtime also accepts schema-V2 `workflow.stage.started` and
`workflow.stage.finished` fragments with a stable occurrence UUID and bounded
attempt. For an attributed run, the router emits them through explicit
`bin/coredoc-workflows stage-run` start/finish boundaries immediately around
each routed stage.
It keeps only one occurrence open, maps the stage handoff to a closed outcome,
and records a later retry as the next attempt. Individual stage prompts and
`PreToolUse`/`PostToolUse` hooks never infer these boundaries. An unattributed
run still executes its stages but skips explicit capture and reports the gate
unavailable.

MCP observation matches the base `mcp__coredoc__` namespace, configured aliases,
and hosted wrappers such as `mcp__claude_ai_Coredoc__*` without matching the
`mcp__coredocument__` namespace. On a successful finish, the command checks the
routed skills stored in local run state against those bounded observations. A
missing stage leaves the run active so it can be completed and retried. Explicit
repeatable `--require-skill` gates also apply to failed, blocked, and abandoned
outcomes.

The preceding `workflow.run.started` event identifies use of the router itself;
capability events cover observable skill and agent adoption after the run starts
and direct supported use outside a run.

`SessionEnd` records the same bounded finish event as `abandoned` when a routed
run did not finish normally, preserving its original Claude session and
repository identity. It marks only an actually open stage occurrence abandoned;
it does not invent one when the run is between stages. It then makes a 750 ms
delivery attempt. A transport failure leaves
the exact UUID and payload in the capture outbox. The next `SessionStart` flushes
that binding once within the same 750 ms budget, without re-recording the event
or attributing it to the new session. Accepted and duplicate receipt IDs are the
only retry-success removals. Disabled capture creates no files or warning.

The binding-aware outbox caps only current-binding pending events. Entries from
old credentials/endpoints and unreadable entries remain intact and are reported
as `bindingRefused`/`unreadable`; they do not consume the current binding's cap.
Capture configuration is independent of native OTLP configuration and never
reuses an OTLP credential.

Rollback stops the V3 producer first and drains pending V3 outbox files before
downgrading the relay or server reader. If a relay is nevertheless downgraded
after preflight while a V3 file is pending, the existing terminal receipt
contract removes an event-scoped `INVALID_EVENT`: an immediate route reports
`capture.status="rejected"`, while a later SessionStart backlog flush is silent
and writes no durable invalid-event diagnostic. No retry or quarantine subsystem
is added for that narrow deployment race.

That bound applies to capture events, and only to them. A finished run
that used the Coredoc graph reports `feedbackOwed`, and the router then submits
one qualitative record — free-form prose about which graph tools were noisy,
incomplete, wrong, slow, or misleadingly described — through the host's
`submit_session_feedback` tool, tagged with the run ID so it joins the run's
bounded summary. That is a different channel with a different envelope: it goes
to the Coredoc MCP server the host is already connected to, not to the capture
endpoint, and the prose is authored for it deliberately rather than copied out
of the run. The router still never sends source, diffs, prompts, or paths. If
the host lists no such tool the step is skipped; this plugin does not depend on
it, and nothing else in a run is allowed to carry free-form text.

Dedicated capture ingestion stores immutable events and projects the start- and
finish-owned fields into `WorkflowRun`; provider-scoped `AgentSession` rows
remain the session identity. One Claude or Codex session may therefore contain
sequential routed runs without last-write-wins loss. The plugin no longer emits
semantic workflow events through legacy OTLP and does not create a repository
ledger.

## Delivery telemetry and privacy

Managed capture is disabled until an operator creates a mode-0600
`~/.coredoc/capture-agent-policy.json` and explicitly runs
`coredoc-workflows capture setup`. The policy has exactly three fields: schema
version 1, one canonical HTTPS server origin, and one workspace UUID. Neither a
repository, current working directory, host payload, Coredoc MCP, nor Coredoc
Desktop can select another destination. Coredoc Desktop is not required.

Setup requires supported macOS. It may open a browser for PKCE enrollment,
mints one installation-scoped telemetry credential, copies the hash-verified
relay and pinned Bun runtime into the stable per-user `~/.coredoc/capture-agent`
directory, installs a per-user LaunchAgent, and merge-writes marker-owned global
Claude Code and Codex configuration. Marketplace installation alone performs
none of those actions. The LaunchAgent runs the digest-addressed installed Bun
through a small environment-sanitizing runner, while the Codex claim hook follows
the stable `current` runtime link. Plugin cache rotation therefore cannot strand
the agent. Plugin ownership uses the distinct
`ai.coredoc.workflows.capture-relay` label and
`~/.coredoc/capture-agent/capture-relay` state root; the legacy Desktop label,
plist, and `~/.coredoc/capture-relay` root are separate and are never mutation
targets.

Claude Code and Codex receive different random loopback capabilities. Both
semantic capture and native OTLP point to `http://127.0.0.1:43181`; host settings
never contain the cloud bearer. A Codex `SessionStart` hook may provide optional
repository attribution, but native and workspace-level delivery does not wait
for that claim. A missing repository or unmapped remote remains workspace-scoped
instead of being guessed. No repository-local capture file is created or
required.

Codex workflow boundary commands (`coredoc-workflows route-task`,
`coredoc-workflows stage-run`, and `coredoc-workflows finish-run`) must run
with the host shell tool's elevated execution. The
Codex sandbox blocks loopback access to the managed relay and may also block the
user-level run-state directory; the packaged router requests elevation only for
those exact trusted plugin commands. A denied loopback preflight reports the
sandbox restriction directly rather than presenting it as a capture-schema
mismatch.

The LaunchAgent runs an immutable, digest-addressed runtime independently of the
plugin cache and host sessions. The relay authenticates each incoming local
capability, sanitizes native logs before persistence, validates semantic events,
and replaces local headers with the installed workspace credential. Sanitized
native, semantic, and artifact queues are separate, bounded, owner-only, and
replay-safe. Authenticated `/health/v2` reports only version, protocol, channel,
queue, and closed degradation state. A foreign listener, unmanaged host OTLP
configuration, policy drift, unsafe state file, or unavailable supervisor fails
closed before setup overwrites anything.

Setup does not migrate a Coredoc Desktop daemon, its queues, or its credentials.
`LEGACY_DESKTOP_PRESENT` identifies the exact Desktop-v1 LaunchAgent;
`OWNERSHIP_CONFLICT` is unrecognized state, and `FOREIGN_LISTENER` is an
unowned process on the relay port. All fail before enrollment or managed-state
mutation. On the exceptional legacy machine, let every binding drain, then use
Desktop's managed-capture **Disable** action for every configured Claude
repository and Codex profile so its higher-precedence repository-local settings
are removed. Confirm every target is disabled and stop and remove the recognized
service. Any remaining Desktop Codex OTEL block or session-claim hook is
reported as legacy state and blocks setup with `CONFIG_CONFLICT`; the plugin
never replaces or deletes that Desktop-owned configuration. Read-only
`status`/`doctor` reports a legacy claim hook as `claims: "legacy"`. The plugin
recognizes the standard unsuffixed Desktop LaunchAgent
itself; also inventory and retire every exact-marker
`ai.coredoc.capture-relay.<hash>.plist` development service because a dormant
suffixed service is not auto-detected and can restart later. Atomically move
each recognized Desktop `capture-relay` root—including the standard
`~/.coredoc/capture-relay` and any configured development root—to a separate
owner-only backup. Verify no old LaunchAgent, listener, or other
service that can reclaim the fixed relay port remains before rerunning setup.
The archived Desktop root is disjoint from plugin-owned state. The plugin never
kills an unknown listener or imports or deletes the backups. If an earlier
pre-release plugin build used the Desktop label or relay root, uninstall it with
that same build before running current setup; the current build intentionally
refuses to adopt it. After the new agent is healthy and the rollback window
closes, revoke the old Desktop telemetry credentials through the
ownership-scoped server or administrator workflow, verify their rejection, and securely
remove the backups.

Only structured identity and usage fields can leave the machine: host/provider,
session or conversation ID, model and supported host version, token/cache/
reasoning counts, bounded tool or capability ID/status, and timestamps. The
sanitizer rebuilds the OTLP request from that allowlist before its first remote
request. Prompts, command/tool arguments, outputs, source, diffs, paths,
transcripts, artifacts, account/email fields, and native cost estimates never
leave through this path. Unsupported versions and unknown payloads are refused.
The native outbox receives only the reconstructed sanitized object; unsanitized
requests are never queued. The older `native-otel:sanitize` command remains a
development diagnostic, not the supported provisioning/lifecycle path.

Accepted data goes only to the configured Coredoc workspace. Workspace admins
can read workspace-wide activity; members receive server-filtered rows for their
own identity. Pending state remains binding-isolated below the mode-0700
`~/.coredoc/capture-agent/capture-relay` directory. Files are mode 0600 and contain only
validated capture envelopes, sanitized native records, or bounded diagnostics.

`pnpm --dir plugins/coredoc-workflows capture-health:report` prints exactly one
bounded JSON object with `pendingCount`, `errorCode`,
`attributionPendingCount`, `attributionRejectedCount`, and
`attributionLastClaimAt`; it never prints config paths, headers, nonces, cloud
authorization, payloads, or raw errors. Without an explicitly configured
managed agent or compatibility endpoint, workflow capture creates no opt-out
backlog and ordinary workflows continue normally.

The legacy direct-cloud compatibility path remains separate. It activates only
when an operator explicitly supplies `COREDOC_CAPTURE_ENDPOINT` and an
independent `COREDOC_CAPTURE_HEADERS` credential; plugin installation supplies
neither, and this path never reuses the agent credential. See
[`docs/plugin-managed-capture-agent.md`](../../docs/plugin-managed-capture-agent.md)
for policy setup, lifecycle commands, manual legacy cutover, rollback, and purge
behavior.

## Deliberate constraints

- no specimens or frozen repository copies;
- no second test/check runner;
- no copied prompts or command bodies in run records;
- no automatic capture configuration or token provisioning in this plugin;
- no mandatory ledger or report persistence;
- no database writes while gathering context;
- no automatic commit, stash, fetch, push, issue mutation, or deployment;
- browser runtime supports macOS ARM only.
- generic Electron QA accepts loopback CDP only and requires explicit development
  startup; the local Coredoc adapter reuses app-owned auth without reading
  credential files.

## Local validation

```bash
npm test
npm run test:bun
plugins/coredoc-workflows/bin/coredoc-workflows browse doctor
plugins/coredoc-workflows/bin/coredoc-workflows retro-evidence --since 7d
```

## Generated skills

Eleven skills are generated and committed; the rest are hand-written. A skill is
generated if and only if a `SKILL.md.tmpl` sits beside its `SKILL.md`, so the
filesystem is the registry and there is no list to keep in sync.

```bash
npm run build:skills  # rebuild
npm run check:skills  # fail if stale
```

Edit the template, never the generated `SKILL.md` — the next build overwrites it.
`--check` runs inside `npm test`, so a template edited without a rebuild fails
the normal gate, and `.gitattributes` marks the eleven as generated so they read as
derived output in a diff.

The generated files carry no banner of their own. A "do not edit" comment would
sit in the highest-attention position of every prompt, spending the agent's
attention to warn a human who is not reading the file anyway. The warning lives
here and in `.gitattributes`; the agent gets the method and nothing else.

Text shared across skills lives once in `resources/methodology/` and is pulled
in through `{{PLACEHOLDER}}` tokens. An unresolved token fails the build rather
than shipping into a prompt.

Skill frontmatter is deliberately just `name` and `description` — the only shape
both target hosts agree on. A tool allowlist is not used: every method here needs
Bash for git, the test runner, the browser runtime, and the redaction scan, so an
allowlist that keeps Bash while dropping Edit and Write would advertise a
read-only guarantee it cannot enforce. Read-only stages state their boundary in
the method text; making one enforced is a job for a `PreToolUse` hook.

## Methodology fidelity

The `.tmpl` files are the full method, not intentionally shortened prompts. The
build expands every placeholder a workflow needs, so an invoked skill carries
its complete methodology and needs no shell command to obtain it. Skills that
are not invoked add no prompt context.

Semantic gates are preserved: confidence scoring and quoted evidence, framework
metadata verification, plan-completion and scope audits, specialist and
adversarial review, codepath and user-flow test mapping, browser reference
semantics, and systematic QA exploration.

Adaptations are limited to delivery boundaries: automatic external-model passes
and global memory stores are omitted from ordinary rendered methods; repository
mutation, report persistence, dependency installation, CI changes, and commits
require explicit authorization. The separate `coredoc-claude` and
`coredoc-codex` skills restore a fresh external perspective only when explicitly
requested and keep only a project-scoped opaque session handle after explicit
consultation. Owned-template build and content tests fail when a shared
expansion disappears or its behavioral landmarks are lost.

## Provenance

Third-party attribution, pinned source revisions, runtime toolchains, release
archive hashes, build commands, platforms, sizes, and binary hashes are isolated
from prompt-facing skills. The existing browser binary is explicitly marked
non-reproducible because its original source closure was not archived.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.
