## Product-intent context

Apply this only when the workspace MCP exposes the intent tools
(`get_intent_context`, `intent_read`). Their absence is the normal case: proceed
from repository evidence and do not mention intent context. Never install,
configure, or initialize anything to obtain them.

### Calling it

The tools refuse unknown arguments rather than ignoring them, so send only the
parameters each declares.

**`get_intent_context`** (workspace MCP endpoint). When
`handoffFreshness.needsAttention` is above zero, re-read with
`includeDiagnostics: true` for the operation ids, then inspect and repair them
with `intent_handoff get`.

**Intent ids are kind-prefixed slugs** — `br-refund-window`,
`cap-widget-ordering` — where the prefix names the kind (`cap`, `uc`, `flow`,
`br`, `lim`, `dec`). Numeric ids like `BR-3` resolve to nothing.

**A `nodeIds` value is a stable code node id, not a path.** It looks like
`40080b8c38fc:function:src/formatting/money.ts:roundCurrency`, and a file node
drops the trailing name: `40080b8c38fc:file:src/formatting/money.ts`. Take those
ids only from a coredoc tool response — `search_symbols`, `explain`,
`list_file_symbols` — and never construct, assemble, or guess one. A bare file
path is not a node id and matches nothing.

### Fetch protocol

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
- Never call `get_intent_context` with no selector (that returns every accepted
  item up to the limit), and an empty or disappointing answer is not a license
  for a second lookup with another selector or with `intent_read search`.

### Reading rules

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

`authority`, `anchors[].status`, and `snapshotFreshness` are three independent
dimensions. Report each one; never fuse them into a single verdict.

| Signal | What it licenses | What it never licenses |
| --- | --- | --- |
| `accepted` | Citing the item as reviewed product intent | — |
| `candidate` | Context, a question, a hypothesis | A blocking finding or an authority claim |
| `rejected` / `superseded` | Provenance, and only when fetched by exact ID | Applying it as current intent |
| `anchors[].status: matched` | The stable node still carries the captured version | Conformance — anchors are implementation touchpoints, not conformance proof |
| `anchors[].status: changed` / `missing` | Flagging the anchor as unverified | Concluding the rule is broken |
| `snapshotFreshness: stale` / `unknown` | Naming the code dimension as unverified | Any statement about current code |

A candidate item is context and is never a blocking finding; raise it as a
question to the user instead. A `matched` anchor on a `stale` or `unknown`
snapshot is not "unaffected" — the anchor matched an old graph. State both
dimensions in that exact form.

### Unavailable states

`not_configured` (the workspace holds no intent yet), a configured workspace
whose read matched nothing, and `evidence.available: false` (the graph could not
be read; text and exact-ID matches still return, graph-derived matches drop out,
and anchors carry no `status`/`snapshotFreshness` — unverified, not empty;
`graph.degradation` says why) are different results. Name which one occurred. A
missing capability (no intent tools at all, as when the workspace's intent
feature is off) is not `not_configured`. Both are ordinary states, and neither
is a finding.

### Stage contracts

Use the same working set across the delivery lifecycle. A stage may add exact IDs
returned by an intent response, but it must not silently replace routed IDs or
turn a candidate, anchor, graph path, test, or runtime observation into accepted
product intent.

| Stage | Intent and graph use | Required artifact or handoff | Degraded path |
| --- | --- | --- | --- |
| PRD | Read product intent with `intent_read`: `tree`, then `node` for the request's domain or feature (`includeCandidates: true` to see candidates); cite ids from that document and take their versions from one exact-id `get_intent_context` read. Separate accepted constraints from candidate ideas; graph evidence describes current touchpoints only. | Cite applicable exact IDs with their `intentVersions`, accepted decisions/non-goals, and unresolved questions. | Name the unavailable state and continue from owner/repository evidence. |
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
fits, and otherwise create it with `intent_tree`, naming what you placed there;
a service-token session drafts the layout, places each item at the closest
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
item carries `kind`, a `title` that is a short noun phrase still stating the
rule (`Refund window is 30 days`, not a full sentence and not a bare topic like
`Refund windows`), a self-contained one-sentence `statement`, optional `body`
Markdown lines for everything else the item says, and
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
session, follow its drafting rules; the `intent_propose` description owns the
field contract. Report `itemId`, `outcome`, and `version` per item and carry
them into the handoff as `proposedIntentIds` with their versions. Never propose
from a draft document, from code, or from your own inference.

**Single approval, including an authorized resumption.** When the acting
person approves the document IN THEIR OWN SESSION, or authorizes continuation
of that unchanged, previously approved document, the acceptance step proposes
missing items and then calls `intent_review accept` for every item whose WHOLE
content is verbatim from the approved section — statement, `body`,
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
