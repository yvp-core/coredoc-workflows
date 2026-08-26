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

**MCP — `get_intent_context`.** Parameters: `intentIds` (exact ids, and the only
way to retrieve a rejected or superseded item), `query` (bounded lexical search
over intent text), `nodeIds` (stable code node ids), `includeCandidates`
(default false), `limit` (1..20, small default), and `detailLevel` for the full
typed payload.

**CLI — `coredoc intent`.** Every subcommand requires `--project <projectId>`:

```bash
coredoc intent context --project <projectId> --id BR-3 --id CAP-1
coredoc intent context --project <projectId> --query "retention window"
coredoc intent context --project <projectId> --node-id <stableNodeId>
coredoc intent context --project <projectId> --query "export limits" --include-candidates --limit 5
coredoc intent status --project <projectId>
```

Resolve `<projectId>` by reading the `projects[]` entries in
`coredoc.config.json` at the workspace root and taking the `id` of the project
that owns the repository you are working in; if that file is unreadable or
ambiguous, ask the user. Never guess a project id — a wrong one reads another
project's intent. `--id` and `--node-id` repeat; `-c <path>` points at a config
outside the workspace root.

### Fetch protocol — exact-ID-first

1. **Reuse what was routed.** If the handoff, specification, plan, or task text
   already names intent IDs, they are the working set. Do not re-derive it.
2. **Fetch only absent payload.** Request exactly the IDs whose statement or
   payload you do not already have (`--id` / `intentIds`). Never reload the whole
   overlay, and never repeat broad discovery for IDs you were handed.
3. **No IDs routed?** Run at most one broad lookup per stage — one call with a
   `query` or with code `nodeIds`, at the default limit — then work with what
   came back. If it returns `truncated`, say so; do not page through the overlay.
4. Ask for candidates only when you deliberately want unreviewed proposals
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
