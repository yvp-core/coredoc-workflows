## Product-intent context

Apply this only when a Coredoc intent capability is present in this session: the
workspace (cloud) `get_intent_context` MCP tool, the local `get_intent_context`
MCP tool, or the `coredoc intent context` CLI. Its absence is the normal case.
Intent context is optional evidence — it never blocks, gates, or degrades the
workflow, and a missing capability is never a finding, a stop, or a reason to
soften any other conclusion. Do not install, configure, or initialize anything to
obtain it. When no intent capability is present, proceed from repository evidence
alone and do not mention intent context in the output.

A missing capability is not the same as a `not_configured` overlay: the first
means this session has no intent surface at all, the second means the capability
answered and this project or workspace has no intent content yet. Both are
ordinary states, and neither is a finding. A workspace whose intent feature is
off exposes no intent tools at all; treat that as no capability.

### Which surface, and how to call it

Three surfaces expose overlapping selections with different argument sets.
Unknown arguments are refused, not silently ignored, so send only what the
surface you are on declares. The cloud tool is the primary surface whenever the
workspace MCP exposes intent tools; the local MCP tool or the CLI is the surface
otherwise. Use whichever exists; never try a second surface after a successful
answer.

**Cloud MCP — `get_intent_context`** (workspace MCP endpoint). Default
`mode: "context"`; `mode: "list"` is the payload-free index. It accepts
`intentIds` (exact ids, and the only way to retrieve a rejected or superseded
item), `query` (short bounded lexical search over intent text), `nodeIds`
(stable code node ids), `domain`, `feature`, `kind`, `includeCandidates`
(default false), `effectivity`, `observed` (`"<repoKey>@<commit>"`, optionally
with a `:dirty` suffix), `limit`, and `cursor` in list mode. **The cloud tool
refuses `detailLevel` and `format`.** A context answer carries each match with
its `authority`, `version`, `domainId`, `featureId`, `proposedSuccessorOfId`,
`supersededById`, `sources`, `anchors`, and `matchReason`, plus `truncated`,
`totalMatched`, `unknownIntentIds`, `unresolvedNodeIds`, `graph` (per-repo
snapshot freshness, limits, and an optional `scopeSuggestion`), `anchorWarning`,
and `pendingReview`.

**Local MCP — `get_intent_context`** (repo-local overlay). It accepts `mode`,
`format` (`index|ids`, list mode only), `kind`, `intentIds`, `query`, `nodeIds`,
`domain`, `includeCandidates`, `limit` (1..20), and `detailLevel`
(`basic|full`) for the full typed payload. It refuses `feature`, `observed`,
`effectivity`, and `cursor`. It answers `status` (`ready`, `not_configured`,
`invalid`), `items` (no per-item `version`), `relations`, `truncated`,
`unknownIntentIds`, `repos` snapshot freshness, `evidence`, and `warning`. There
is no `pendingReview` and no effectivity here.

No surface carries an overlay-wide revision. The freshness token is the per-item
`version` the CLOUD surface returns with each item; the local MCP and the CLI
return none, so on those surfaces the handoff records `intentIds` alone and a
refresh compares `authority` and `statement` by exact id instead.

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
frozen snapshot). The subcommands are `validate`, `status`, `context`, `list`,
`capture`, `import`, `export`, and `bootstrap-check`, and every one of them
requires `--project <projectId>`:

```bash
coredoc intent list --project <projectId>
coredoc intent list --project <projectId> --domain payments --ids
coredoc intent context --project <projectId> --id br-refund-window --id cap-widget-ordering
coredoc intent context --project <projectId> --query "retention window"
coredoc intent context --project <projectId> --query "retention window" --domain payments
coredoc intent context --project <projectId> --node-id <stableNodeId>
coredoc intent context --project <projectId> --query "export limits" --include-candidates --limit 5
coredoc intent status --project <projectId>
```

Resolve `<projectId>` by reading the `projects[]` entries in
`coredoc.config.json` at the workspace root and taking the `id` of the project
that owns the repository you are working in. If that file is unreadable or
ambiguous, ask the user when the host allows interaction; in an autonomous run
that forbids questions, state the assumption inline and proceed WITHOUT intent
context. Never guess a project id — a wrong one reads another project's intent,
and no context at all beats another project's rules. `--id` and `--node-id`
repeat; `-c <path>` points at a config outside the workspace root.

### Fetch protocol — exact-ID-first

1. **Reuse what was routed.** If the handoff, specification, plan, or task text
   already names intent IDs, they are the working set. Do not re-derive it. A
   handoff produced with intent context carries both fields together:
   `intentIds: string[]` and `intentVersions: Record<id, number>`, the `version`
   each item had when it was read (cloud surface; absent when the surface
   returned no version).
2. **Refresh the exact routed IDs by exact id.** When `intentVersions` is
   present, refresh those exact ids once (`--id` / `intentIds`) and compare each
   returned `version` against the recorded one; when the surface returns no
   `version`, compare `authority` and `statement` instead. Versions are advisory: never pin
   an old projection or block merely because one moved. Unchanged for every
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
4. **No IDs routed? Orient with the index first.** `mode: "list"` — CLI
   `coredoc intent list --project <projectId>`, optionally `--domain` — returns
   the declared domain registry and one payload-free line per item. It is the
   ORIENTATION call and it does NOT spend the broad-lookup budget below, so it
   is the right first move whenever nothing was routed to you: list, optionally
   narrowed to the domain you are working in, then fetch the few ids that matter
   by exact id.
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
6. **Never read `.coredoc/intent.json` directly.** The tools and `coredoc intent
   context` are the ONLY read surfaces: the raw file carries no anchor status
   and no snapshot freshness, so a direct read hands you authority claims with
   the evidence dimensions stripped — and it blows the bounded-context budget
   the surfaces exist to enforce. This holds during repository EXPLORATION too:
   `.coredoc/` is configuration for these surfaces, not source code — leave it
   out of your file listings, greps, and read sweeps the way you would leave
   out `.git/`. Opening it "just to look while investigating" is the same
   violation as citing it. If no surface is available, intent context is
   unavailable; say so and move on.
7. Ask for candidates only when you deliberately want unreviewed proposals
   (`--include-candidates` / `includeCandidates`), and label them as such
   wherever they appear.

### Cloud reading rules

`domain` and `feature` narrowing is cheaper and more complete than a text query;
prefer it whenever the working set already told you where you are. When a
`nodeIds` read comes back `truncated` with a `graph.scopeSuggestion`, re-running
that same read with the narrowing it names is the ONE permitted follow-up shape;
no other second call is licensed by a truncation.

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
is queued and leave it to them; never review it yourself. Never pass
`effectivity`, `observed`, or `feature` to the local tool — it refuses them and
the whole call fails.

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

### Stage contracts

Use the same working set across the delivery lifecycle. A stage may add exact IDs
returned by an intent response, but it must not silently replace routed IDs or
turn a candidate, anchor, graph path, test, or runtime observation into accepted
product intent.

| Stage | Intent and graph use | Required artifact or handoff | Degraded path |
| --- | --- | --- | --- |
| PRD | With no routed IDs, orient with the index and spend at most one bounded lookup. Separate accepted constraints from candidate ideas; graph evidence describes current touchpoints only. | Cite applicable exact IDs with their `intentVersions`, accepted decisions/non-goals, and unresolved questions. | Name `not_configured`, `invalid`, or unavailable capability and continue from owner/repository evidence. |
| Specification | Refresh routed exact IDs. Trace each material outcome and acceptance criterion to accepted intent; use graph/source evidence to verify current contracts and consumers. | Executable acceptance criteria plus `intentIds`, `intentVersions`, any `proposedIntentIds`, and unresolved missing/changed context. | A missing ID or source becomes an unresolved decision, never an invented requirement. |
| Plan | Reuse the exact working set. Use graph impact to scope symbols and critical manual consumers; use broad discovery only when the set is absent or explicitly incomplete. | Ordered steps trace acceptance criteria and intent IDs and name impact, validation, rollback, freshness, and coverage gaps. | Replace unavailable graph impact with manual repository analysis and say coverage is unknown. |
| Implementation | Fetch only missing exact payload. Inspect impacted symbols/callers and keep code-derived observations as questions, not intent changes. | Scoped diff and tests plus the unchanged exact-ID handoff, anchor suggestions when a write capability exists, and any new product questions. | Continue under the accepted spec and repository rules when optional intent/graph context is unavailable. |
| Validation | Use executed test/runtime/browser evidence per acceptance criterion. Anchors guide inspection but never substitute for execution. | Per-criterion `passed`, `failed`, `inconclusive`, or `not_assessed`, with evidence and runtime/snapshot freshness kept separate. | An unavailable environment marks only affected criteria; it never fabricates a pass. |
| Review | Refresh exact IDs, then classify diff impact as direct anchor, enclosing scope, graph reachable, no known link, or unknown. Inspect accepted violations separately from candidates and stale anchors. | Findings cite accepted IDs and executed/source evidence; the verdict names mapping coverage and freshness. | Without graph evidence, review the diff/spec manually and report impact as unknown, never unaffected. |
| Merge | Rebuild or publish the code graph only. Recompute anchor status after the rebuild; do not mutate intent unless the reviewed change explicitly edits it. | New graph snapshot and optional anchor-maintenance report. The intent versions stay unchanged for a code-only merge. | Existing CI policy handles graph rebuild failure; durable intent remains readable and unchanged. |
| Investigation | Use exact intent for expected outcomes, graph evidence for static mechanisms, and runtime evidence for observed behavior. | Separate expected, implemented/static, observed/runtime, and unknown conclusions. | Name the missing plane while keeping the other planes usable. |

Every artifact that used intent carries `intentIds` and `intentVersions`; the
next stage follows the exact-ID refresh protocol above. Validation and merge do
not establish or change authority. If a stage has no intent capability, it emits
no synthetic empty handoff and continues normally.

### Write stages — propose, never decide

This section applies only when a cloud intent WRITE capability is present —
`intent_propose` visible in this session. Everything it produces is a candidate
by construction. The agent NEVER calls `intent_review`, never records or rolls
back a release through `intent_release`, and never edits the tree with
`intent_tree`; those are the maintainer's own actions in their own session. Read
release state only through `effectivity: true` and report what it says. Call
`intent_anchor add`, `refresh`, or `remove` only on an explicit maintainer
instruction naming the item and the node; `intent_anchor preview` is a read and
is always allowed.

**After specification acceptance.** When an accepted specification introduces or
changes product intent — a capability, use case, flow, business rule, limitation,
or decision the accepted intent does not already state — propose it in ONE
`intent_propose` batch (at most ten items, fresh `idempotencyKey`). Each item
carries `kind`, `title` — a short noun phrase that still states the rule (`Refund
window is 30 days`, not a full sentence and not a bare topic like `Refund
windows`), because the server derives the immutable id from it and cuts it at
the id length cap — a self-contained `statement`, optional `rationale` and
kind-validated `payload`, at most one of `domainId`/`featureId`, and
`sources: [{ kind: "spec", ref: "<repoKey>:<spec path relative to the repository
root>", localId: <the spec's stable section id, e.g. "AC-3" or "BR-2"> }]`.
Source identity is the exact `(ref, localId)` pair, scoped to the WORKSPACE,
and propose upserts on it — so `ref` carries the repository key, because two
repositories in one workspace can both hold `docs/spec.md` with a `BR-1`, and
an unqualified path would overwrite the other repository's candidate. Keep the
pair stable across runs and precise per statement. Place each item in the domain or
feature the working set already showed; when nothing declared honestly fits, park
it at the closest node and say so — never create tree nodes. Set
`proposedSuccessorOfId` only when the specification explicitly replaces a named
accepted item. If the `intent-capture` skill is available in this session, follow
its drafting rules; otherwise the field list above is the contract. Report
`itemId`, `outcome`, and `version` per item and carry them into the handoff as
`proposedIntentIds` with their versions. Never propose from a draft
specification, from code, or from your own inference.

**After implementation, before or at review.** Map the touched symbols to stable
node ids taken from coredoc tool responses (`search_symbols`,
`list_file_symbols`, `explain`). New code is anchorable only once the workspace
graph contains it: when `graph.repos[].pushedAt` predates the change or the
snapshot freshness reads `stale`, say the anchors cannot be placed yet and name
the publish step — `coredoc push --project <projectId> --cloud`, or the CI sync.
Otherwise list, per intent id in the working set, the `(repoKey, nodeId)` pairs
this change makes an implementation touchpoint, each verified with
`intent_anchor preview` (a read that resolves the node for any item), and hand
the list to the maintainer as "Anchor suggestions", split by the item's
authority because the write differs: for an ACCEPTED item, `intent_anchor add`
only for the pairs the maintainer explicitly ticks or names; for a CANDIDATE
(including one you just proposed), never `intent_anchor add` — the server refuses
it with `item_not_accepted` — but re-send `intent_propose` for that item with
`anchorSuggestions` and the same source identity, which upserts, so its anchors
are settled at review.

**Release.** Never record availability yourself: merge, pull request, graph
publication, and ticket transitions are not triggers the agent acts on. In the
review or merge handoff render the PR trailer block instead of a free-text
delivery line — a fenced `text` block whose `Coredoc-Intent-Delivers:` line lists
the ACCEPTED items the change implements and whose `Coredoc-Intent-Retires:` line
lists the accepted items the accepted specification explicitly retires, each as
comma-separated `<itemId>@<version>` pairs with the versions from the exact-id
refresh. Candidates are never listed, because a candidate cannot be released. The
maintainer pastes the block into the PR body; Coredoc records the plan and the
delivery from those lines when the workspace runs in `merge` or `deploy` mode,
and otherwise recording availability stays the maintainer's own `intent_release`
action after the production deploy.

### Cite it like evidence

Cite applicable intent IDs in the artifact you produce — plan, specification,
review finding, diagnosis — the way you cite `file:line` evidence, next to the
claim they support. An ID with no traceable claim, or a claim asserting product
intent with no ID, is not grounded. Carry the exact IDs you used and the
`version` each one returned into the handoff as `intentIds` and
`intentVersions`, so the next stage refreshes that working set instead of
searching again.

Write an anchor as an implementation touchpoint, never as behavior: "`br-…` is
anchored to `roundCurrency`" is what the surface supports; "`br-…` is satisfied,
its anchor matched" is not. A `matched` anchor says the captured node is still
in the graph — it is never proof that the behavior currently holds at runtime,
and phrasing it that way turns a location into a verdict you did not verify.
