## Product-intent context

Apply this only when a Coredoc intent capability is present: the workspace
(cloud) `get_intent_context` MCP tool, the local one, or the `coredoc intent
context` CLI. Its absence is the normal case: proceed from repository evidence
and do not mention intent context. Never install, configure, or initialize
anything to obtain it.

### Which surface, and how to call it

Three surfaces expose overlapping selections with different argument sets.
Unknown arguments are refused, not silently ignored, so send only what the
surface you are on declares. The cloud tool is the primary surface whenever the
workspace MCP exposes intent tools; the local MCP tool or the CLI is the surface
otherwise. Use whichever exists; never try a second surface after a successful
answer.

**Cloud MCP — `get_intent_context`** (workspace MCP endpoint). **It refuses
`detailLevel` and `format`.** When `handoffFreshness.needsAttention` is above
zero, re-read with `includeDiagnostics: true` for the operation ids, then
inspect and repair them with `intent_handoff get`.

**Local MCP — `get_intent_context`** (repo-local overlay). It accepts `mode`,
`format` (`index|ids`, list mode only), `kind`, `intentIds`, `query`, `nodeIds`,
`domain`, `includeCandidates`, `limit` (1..20), and `detailLevel`
(`basic|full`) for the full typed payload. It refuses `feature`, `observed`,
`effectivity`, and `cursor`. It answers `overlayStatus` (`ready`,
`not_configured`, `invalid`), `items` (no per-item `version`; anchors under
`items[].codeAnchors`), `relations`, `truncated`, `unknownIntentIds`,
`repoSnapshots` (per-repo snapshot freshness), `evidence`, and `warning`. There
is no `pendingReview` and no effectivity here.

**Intent ids are kind-prefixed slugs** — `br-refund-window`,
`cap-widget-ordering` — where the prefix names the kind (`cap`, `uc`, `flow`,
`br`, `lim`, `dec`). Numeric ids like `BR-3` are a pre-v2 shape and resolve to
nothing.

**A `nodeIds` value is a stable code node id, not a path.** It looks like
`40080b8c38fc:function:src/formatting/money.ts:roundCurrency`, and a file node
drops the trailing name: `40080b8c38fc:file:src/formatting/money.ts`. Take those
ids only from a coredoc tool response — `search_symbols`, `explain`,
`list_file_symbols` — and never construct, assemble, or guess one. A bare file
path is not a node id and matches nothing.

**CLI — `coredoc intent`** (local overlay; after a cloud cutover its reads are a
frozen snapshot). Its reads (`list`, `context`, `status`, `validate`) require
`--project <projectId>`:

```bash
coredoc intent list --project <projectId> --domain payments
coredoc intent context --project <projectId> --id br-refund-window --id cap-widget-ordering
coredoc intent context --project <projectId> --query "retention window" --domain payments
coredoc intent context --project <projectId> --node-id <stableNodeId>
```

Resolve `<projectId>` by reading the `projects[]` entries in
`coredoc.config.json` at the workspace root and taking the `id` of the project
that owns the repository you are working in. If that file is unreadable or
ambiguous, ask the user when the host allows interaction; in an autonomous run
that forbids questions, state the assumption inline and proceed WITHOUT intent
context. Never guess a project id — a wrong one reads another project's intent,
and no context at all beats another project's rules. `--id` and `--node-id`
repeat; `-c <path>` points at a config outside the workspace root.

### Cloud task context

When the cloud tool declares `task`, use this protocol; the exact-ID-first
protocol below is for the local tool and CLI.

- Before planning or editing, make one task call per stage with `limit: 10`.
  Keep the routed IDs alongside newly discovered constraints and compare their
  versions. Versions are advisory: never pin an old projection or block merely
  because one moved.
- Fetch a missing payload or a named successor by exact id, without repeating
  discovery. Before editing outside the requested scope, repeat the task call
  with the newly touched files and the retained IDs.
- Do not rephrase an unchanged task to fill context. When a read comes back
  `truncated` with a `graph.scopeSuggestion`, re-running that same read with the
  narrowing it names is the ONE permitted follow-up; no other second call is
  licensed by a truncation. Report unresolved paths and unknown IDs.

### Fetch protocol — exact-ID-first (local tool and CLI)

1. **Reuse what was routed.** If the handoff, specification, plan, or task text
   already names intent IDs, they are the working set. Do not re-derive it. A
   handoff produced with intent context carries both fields together:
   `intentIds: string[]` and `intentVersions: Record<id, number>`, the `version`
   each item had when it was read (cloud surface; absent when the surface
   returned no version).
2. **Refresh the exact routed IDs by exact id.** When `intentVersions` is
   present, refresh those exact ids once (`--id` / `intentIds`) and compare each
   returned `version` against the recorded one; when the surface returns no
   `version`, compare `authority` and `statement` instead. Unchanged for every
   routed id → record `no_relevant_change` and continue. Changed → surface that
   id's authority, payload, relation, and anchor deltas. An id the response
   reports as unknown is missing; say so. When an item carries `supersededById`,
   name the successor id and fetch it by exact id — never fuzzy-replace a
   missing or superseded one. Do not run broad lookup or discovery in either
   case, and do not turn an anchor result into the comparison. If the prior
   projection is unavailable or either response is truncated, say the routed set
   was refreshed but do not claim `no_relevant_change`.
3. **Otherwise fetch only absent payload.** Without recorded versions, request
   exactly the IDs whose statement or payload you do not already have. Never
   reload the whole overlay, and never repeat broad discovery for IDs you were
   handed. Following an id a PREVIOUS response returned (a relation endpoint, a
   returned item, a named successor) by exact id is fine — that is still
   exact-ID navigation. Fetching an id that neither the handoff nor an earlier
   response named is not.
4. **No IDs routed? Orient with the index first.** `mode: "list"` (CLI
   `coredoc intent list`) returns one payload-free line per item and does NOT
   spend the broad-lookup budget below. List, optionally narrowed with
   `--domain`, then fetch the few ids that matter by exact id.
5. **One broad lookup, and only one.** Run at most one broad lookup per stage —
   any context-mode call that is not an exact-ID fetch: a `query`, code
   `nodeIds`, or a bare `domain`/`feature` filter — at the default limit, then
   work with what came back and with exact-id follow-ups of what it returned.
   ONE means one for the whole stage, regardless of which selector shape you
   spend it on; the shapes are not separate budgets. **An empty or disappointing
   result is not a license for a second lookup with a different selector**: do
   not rephrase the query and search again, and do not follow a `query` with a
   `nodeIds` call or the reverse. When the one lookup comes back empty, either
   reorient with `mode: "list"`, which is budget-exempt, or say plainly that no
   anchored or matching intent was found and move on. If it returns `truncated`,
   say so; do not page through the overlay. **Never call context mode with no
   selector at all** — an empty call returns every accepted item up to the
   limit, the broadest read there is.
   **Reviewing or changing specific code? Spend the one lookup on `nodeIds` of
   the touched symbols/files INSTEAD of a text query — never in addition to
   one.** The node lookup returns the rules ANCHORED to the code in front of
   you — including rules whose wording shares no words with the diff, which a
   text query will miss every time. On the cloud surface it also returns rules
   whose enclosing scope or graph-derived feature applies. It is still your
   single broad lookup, not a second one.
6. **Never read `.coredoc/intent.json` directly**, not even while exploring:
   the raw file lacks anchor status and snapshot freshness and bypasses the
   bounded read. Leave `.coredoc/` out of listings, greps and read sweeps as you
   would `.git/`. With no surface available, intent context is unavailable; say
   so and move on.

### Cloud reading rules

`observed` is how code freshness becomes `current` or `stale` instead of
`unverified`: pass `"<repoKey>@<commit>"` from `git rev-parse HEAD` for a
`repoKey` an earlier response already named, adding the `:dirty` suffix when the
tree is dirty. Never invent a `repoKey`.

Pass `effectivity: true` only when the task actually reasons about delivery. Then
implement a `planned` item only when the task's own specification or work item is
among that item's `sources`, or the maintainer said so; never implement a
`withdrawn` one; `unknown` is not effective; and `not_effective` never authorises
re-implementing behavior on its own. Report the value and `currentRelease` as
read, never derived from merges or tickets.

When `pendingReview.waiting` is above zero, tell the maintainer in one line what
is queued and leave it to them; never review it yourself.

### Read the answer honestly

`authority`, `anchorStatus`, and `snapshotFreshness` are three independent
dimensions. Report each one; never fuse them into a single verdict.

| Signal | What it licenses | What it never licenses |
| --- | --- | --- |
| `accepted` | Citing the item as reviewed product intent | — |
| `candidate` | Context, a question, a hypothesis | A blocking finding or an authority claim |
| `rejected` / `superseded` | Provenance, and only when fetched by exact ID | Applying it as current intent |
| `anchorStatus: matched` | The stable node still carries the captured version | Conformance — anchors are implementation touchpoints, not conformance proof |
| `anchorStatus: changed` / `missing` | Flagging the anchor as unverified | Concluding the rule is broken |
| `snapshotFreshness: stale` / `unknown` | Naming the code dimension as unverified | Any statement about current code |

A candidate item is context and is never a blocking finding; raise it as a
question to the user instead. A `matched` anchor on a `stale` or `unknown`
snapshot is not "unaffected" — the anchor matched an old graph. State both
dimensions in that exact form.

### Four distinct unavailable states

Absent file (`not_configured`), invalid file (`invalid`), a valid overlay with no
match, and an unavailable local graph are four different results. Name which one
occurred. None of them means "no applicable rule" — that claim requires a valid,
current overlay that was searched and returned nothing. When the graph is
unavailable, the intent may still be readable; the code dimension is `unknown`,
not empty.

A missing capability is not a `not_configured` overlay: the first means no
intent surface at all (as when a workspace's intent feature is off), the second
that the capability answered and the project or workspace has no intent yet.
Both are ordinary states, and neither is a finding.

### Stage contracts

Use the same working set across the delivery lifecycle. A stage may add exact IDs
returned by an intent response, but it must not silently replace routed IDs or
turn a candidate, anchor, graph path, test, or runtime observation into accepted
product intent.

| Stage | Intent and graph use | Required artifact or handoff | Degraded path |
| --- | --- | --- | --- |
| PRD | Use cloud task context; on the local tool or CLI, use the bounded exact-ID-first protocol. Separate accepted constraints from candidate ideas; graph evidence describes current touchpoints only. | Cite applicable exact IDs with their `intentVersions`, accepted decisions/non-goals, and unresolved questions. | Name the unavailable state and continue from owner/repository evidence. |
| Specification | Use task context with routed IDs; compare their versions. Trace each material outcome and acceptance criterion to accepted intent; use graph/source evidence to verify current contracts and consumers. | Executable acceptance criteria plus `intentIds`, `intentVersions`, any `proposedIntentIds` (accepted at the specification's approval when no PRD exists), and unresolved missing/changed context. | A missing ID or source becomes an unresolved decision, never an invented requirement. |
| Plan | Reuse the exact working set. Use graph impact to scope symbols and critical manual consumers; use broad discovery only when the set is absent or explicitly incomplete. | Ordered steps trace acceptance criteria and intent IDs and name impact, validation, rollback, freshness, and coverage gaps. | Replace unavailable graph impact with manual repository analysis and say coverage is unknown. |
| Implementation | Use task context with the routed set and refresh before editing outside the requested scope. Inspect impacted symbols/callers and keep code-derived observations as questions, not intent changes. | Scoped diff and tests plus the unchanged exact-ID handoff, a saved `intent_handoff` when a write capability exists, a successor candidate only when the change must contradict accepted intent, and any new product questions. | Continue under the accepted spec and repository rules when optional intent/graph context is unavailable. |
| Validation | Use executed test/runtime/browser evidence per acceptance criterion. Anchors guide inspection but never substitute for execution. | Per-criterion `passed`, `failed`, `inconclusive`, or `not_assessed`, with evidence and runtime/snapshot freshness kept separate. | An unavailable environment marks only affected criteria; it never fabricates a pass. |
| Review | Use task context for the actual diff, retain and refresh routed IDs, then classify diff impact as direct anchor, enclosing scope, graph reachable, no known link, or unknown. Inspect accepted violations separately from candidates and stale anchors. | Findings cite accepted IDs and executed/source evidence; the verdict names mapping coverage and freshness. | Without graph evidence, review the diff/spec manually and report impact as unknown, never unaffected. |
| Merge | Rebuild or publish the code graph only. Recompute anchor status after the rebuild; do not mutate intent unless the reviewed change explicitly edits it. | New graph snapshot and optional anchor-maintenance report. The intent versions stay unchanged for a code-only merge. | Existing CI policy handles graph rebuild failure; durable intent remains readable and unchanged. |
| Investigation | Use exact intent for expected outcomes, graph evidence for static mechanisms, and runtime evidence for observed behavior. | Separate expected, implemented/static, observed/runtime, and unknown conclusions. | Name the missing plane while keeping the other planes usable. |

### Write stages — accept at approval, never at implementation

This section applies only when `intent_propose` is visible in this session.
Intent is accepted when a person explicitly approves its SOURCE DOCUMENT: the
approved PRD, the specification the person accepts when no PRD exists, or the
ADR the person approves. That approval is the acceptance; nobody is asked a
second time. Everything else the agent proposes is a candidate. The agent calls
`intent_review` only at that approval or its authorized resumption, for
verbatim items, as the acting person's own decision, and never records or rolls
back a release through `intent_release`. When a document needs a domain or
feature the tree does not declare, read the tree, reuse a node that honestly
fits, and otherwise create it with `intent_tree` in the acting user's session
before proposing into it, naming what you created and placed there; a
service-token session drafts the layout, places each item at the closest
existing node, and says so. Archive and delete follow an explicit maintainer
instruction naming the node. Read release state only through
`effectivity: true`. Call `intent_anchor add`, `refresh`, or `remove` only on an
explicit maintainer instruction naming the item and the node; `preview` is a
read and is always allowed.

**At document approval.** When the approved document introduces or changes
product intent — a capability, use case, flow, business rule, limitation, or
decision the accepted intent does not already state — propose it in ONE
`intent_propose` batch (at most ten items). A specification derived from an
approved PRD proposes and accepts nothing of its own: the PRD's approval already
accepted its intent, and the specification carries the PRD's `intentIds`
through unchanged. Apply the granularity test: a row is intent only if a product
owner would recognise it without reading code; flags, paths, types, function
names, release-scoping and adoption-phase notes stay in the document. Before
sending the batch, retain it and its `idempotencyKey` in the existing
specification handoff so an interrupted request can be replayed unchanged. Each
item carries `kind`, `title` — a short noun phrase that still states the rule
(`Refund window is 30 days`, not a full sentence and not a bare topic like
`Refund windows`), because the server derives the immutable id from it and
refuses a title too long for the id cap — a self-contained `statement`,
optional `rationale` and kind-validated `payload`, at most one of
`domainId`/`featureId`, and
`sources: [{ kind: "spec", ref: "<repoKey>:<spec path relative to the repository
root>", localId: <the spec's stable section id, e.g. "AC-3" or "BR-2">, revision: <approved commit or content digest> }]`.
Source identity is the exact `(ref, localId)` pair, scoped to the WORKSPACE,
and propose upserts on it — so `ref` carries the repository key, because two
repositories in one workspace can both hold `docs/spec.md` with a `BR-1`, and
an unqualified path would overwrite the other repository's candidate. Keep the
pair stable across runs and precise per statement. Place each item in the
domain or feature the working set already showed, or as the tree rule above
says. Set `proposedSuccessorOfId` only when the document explicitly replaces a
named accepted item. If the `intent-capture` skill is available in this
session, follow its drafting rules; otherwise the field list above is the
contract. Report
`itemId`, `outcome`, and `version` per item and carry them into the handoff as
`proposedIntentIds` with their versions. Never propose from a draft
document, from code, or from your own inference.

**Single approval, including an authorized resumption.** When the acting
person approves the document IN THEIR OWN SESSION, or authorizes continuation
of that unchanged, previously approved document, the acceptance step proposes
missing items and then calls `intent_review accept` for every item whose WHOLE
content is verbatim from the approved section — statement,
condition/exceptions/affects, and `sources.revision` equal to the
approved commit or content digest — passing `authorizingSource` with that
document's `(ref, localId, revision)` and `reason` "accepted with <path>@<revision>".
Before accepting, read back the exact proposed IDs, compare their whole content
to the approved section and use the returned current versions. Record each
returned `itemId` and version in the handoff immediately; report which items
were accepted and which stayed candidates. An item you paraphrased, reworded, or
inferred stays a candidate, and a service token or an autonomous run never
accepts at all — there the whole batch waits for a person.

**Implementation never accepts.** The implementation stage records what the
change delivers with `intent_handoff` and makes no `intent_propose` or
`intent_review` call. The one exception: when the change must contradict
accepted intent, propose a successor candidate (`proposedSuccessorOfId` naming
the accepted item) and say so; it takes effect only after a person's explicit
acceptance, and the accepted item stays in force at its current version until
then.

**Resume after an interruption.** Read back known `proposedIntentIds` with exact
IDs before mutating anything. An already accepted matching item needs no write;
a matching candidate can complete the authorized accept with its current version.
If the proposal response was lost, replay the retained exact batch with its
original idempotency key, then read the returned IDs. Do not re-propose accepted
items with a new key: source matching can create a new candidate beside them.
If the approved source revision or whole item content changed, or the original
approval/request cannot be recovered from the handoff or session history, report
that specific gap rather than fabricate approval. Recovery does not require
another approval for an unchanged request whose original authorization is
available.

Never record availability during review; the merge/deploy actor records delivery.
Manual anchors remain separate and require an explicit instruction.

### Implementation handoff and delivery

Coredoc, not the PR body, owns implementation links. An authorized
implementation saves the hosted `intent_handoff` (`action: save`) in the user's
workspace session and reads it back. The tool's schema lists the fields; these
choices are yours:

- bind only implementation touchpoints, never the whole context working set;
  paths and symbol locators may name new code the cloud graph lacks, and a
  binding may name a candidate, which applies only after acceptance;
- take delivers/retires versions from the exact-ID refresh: delivery requires
  exact accepted versions, and existing effective rules need no repeat delivery;
- name `supersedesMappingIds` only when this change replaces a known unfinished
  mapping operation, never merely because item IDs happen to match;
- start at `expectedVersion: 0`; the PR writer later attaches `prNumber` and
  refreshes `headSha` after code changes against the current version.

### Cite it like evidence

Cite applicable intent IDs in the artifact you produce — plan, specification,
review finding, diagnosis — the way you cite `file:line` evidence, next to the
claim they support. An ID with no traceable claim, or a claim asserting product
intent with no ID, is not grounded. Carry the exact IDs you used and the
`version` each one returned into the handoff as `intentIds` and
`intentVersions`, so the next stage refreshes that working set instead of
searching again.

Write an anchor as an implementation touchpoint, never as behavior: "`br-…` is
anchored to `roundCurrency`", not "`br-…` is satisfied, its anchor matched".
