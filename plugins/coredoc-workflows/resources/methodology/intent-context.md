## Product-intent context

Apply this only when a Coredoc intent capability is present in this session: the
local `get_intent_context` MCP tool, or the `coredoc intent context` CLI. Its
absence is the normal case. Intent context is optional evidence — it never
blocks, gates, or degrades the workflow, and a missing capability is never a
finding, a stop, or a reason to soften any other conclusion. Do not install,
configure, or initialize anything to obtain it. When no intent capability is
present, proceed from repository evidence alone and do not mention intent
context in the output.

A missing capability is not the same as a `not_configured` overlay: the first
means this session has no intent surface at all, the second means the capability
answered and this project has no intent file yet. Both are ordinary states, and
neither is a finding.

### Which surface, and how to call it

The MCP tool and the CLI expose the same selection. Use whichever exists; do not
try the other one after a successful answer.

**MCP — `get_intent_context`.** One tool, two modes. The default
`mode: "context"` fetches items and takes `intentIds` (exact ids, and the only
way to retrieve a rejected or superseded item), `query` (bounded lexical search
over intent text), `nodeIds` (stable code node ids), `domain` (restrict the
answer to one declared domain), `includeCandidates` (default false), `limit`
(1..20, small default), and `detailLevel` for the full typed payload.
`mode: "list"` is the payload-free index — the declared domain registry plus one
line per item (id, title, kind, domain, authority) — and takes `domain`, `kind`,
and `format: "ids"` instead of the context selectors. Mixing the two argument
sets is refused, not silently ignored.

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

**CLI — `coredoc intent`.** Every subcommand requires `--project <projectId>`:

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
   already names intent IDs, they are the working set. Do not re-derive it.
2. **Fetch only absent payload.** Request exactly the IDs whose statement or
   payload you do not already have (`--id` / `intentIds`). Never reload the whole
   overlay, and never repeat broad discovery for IDs you were handed. Following
   an id a PREVIOUS response returned (a relation endpoint, a returned item) by
   exact id is fine — that is still exact-ID navigation. Fetching an id that
   neither the handoff nor an earlier response named is not.
3. **No IDs routed? Orient with the index first.** `mode: "list"` — CLI
   `coredoc intent list --project <projectId>`, optionally `--domain` — returns
   the declared domain registry and one payload-free line per item. It is the
   ORIENTATION call and it does NOT spend the broad-lookup budget below, so it
   is the right first move whenever nothing was routed to you: list, optionally
   narrowed to the domain you are working in, then fetch the few ids that matter
   by exact id.
4. **One broad lookup, and only one.** Run at most one broad lookup per stage —
   any context-mode call that is not an exact-ID fetch: a `query`, code
   `nodeIds`, or a bare `domain` filter — at the default limit, then work with
   what came back and with exact-id follow-ups of what it returned. ONE means
   one for the whole stage, regardless of which selector shape you spend it on;
   the shapes are not separate budgets. **An empty or disappointing result is
   not a license for a second lookup with a different selector**: do not
   rephrase the query and search again, and do not follow a `query` with a
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
   text query will miss every time. It is still your single broad lookup, not a
   second one.
5. **Never read `.coredoc/intent.json` directly.** The tool and `coredoc intent
   context` are the ONLY read surfaces: the raw file carries no anchor status
   and no snapshot freshness, so a direct read hands you authority claims with
   the evidence dimensions stripped — and it blows the bounded-context budget
   the surfaces exist to enforce. This holds during repository EXPLORATION too:
   `.coredoc/` is configuration for these surfaces, not source code — leave it
   out of your file listings, greps, and read sweeps the way you would leave
   out `.git/`. Opening it "just to look while investigating" is the same
   violation as citing it. If the tool and the CLI are both unavailable, intent
   context is unavailable; say so and move on.
6. Ask for candidates only when you deliberately want unreviewed proposals
   (`--include-candidates` / `includeCandidates`), and label them as such
   wherever they appear.

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

### Cite it like evidence

Cite applicable intent IDs in the artifact you produce — plan, specification,
review finding, diagnosis — the way you cite `file:line` evidence, next to the
claim they support. An ID with no traceable claim, or a claim asserting product
intent with no ID, is not grounded. Carry the IDs you used into the handoff so
the next stage reuses them instead of searching again.

Write an anchor as an implementation touchpoint, never as behavior: "`br-…` is
anchored to `roundCurrency`" is what the surface supports; "`br-…` is satisfied,
its anchor matched" is not. A `matched` anchor says the captured node is still
in the graph — it is never proof that the behavior currently holds at runtime,
and phrasing it that way turns a location into a verdict you did not verify.
