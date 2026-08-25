## Subagent dispatch policy

Apply this policy before delegating reconnaissance, implementation, or review.

| Policy | Value |
| --- | --- |
| fan-out cap | At most 5 concurrent non-review subagents in one batch |
| review concurrency | Lower of the host/tool limit and any repository reviewer-parallelism instruction; when the repository is silent, use the host/tool limit |
| scout budget | At most 4 read-only scouts during design or reconnaissance |
| retry budget | One re-dispatch after a provider failure |
| batch checkpoint | The parent updates the tracked spec or task list after each batch |
| inline batch threshold | Mechanical items touching at most 2 files each in one area are grouped into one subagent or handled inline |

Classify each delegated item and use the scoped plugin agent name:

| Class | Agent |
| --- | --- |
| recon | `coredoc-workflows:coredoc-scout` |
| mechanical | `coredoc-workflows:coredoc-implementer-light` |
| hard | `coredoc-workflows:coredoc-implementer` |
| specialist, red-team, or adversarial review | `coredoc-workflows:coredoc-reviewer` |

Keep user decisions and authorization in the parent conversation. Never delegate
them. Do not permit nested delegation.

Use the lower of the applicable policy cap and the host's lower concurrency
limit. Apply the non-review fan-out cap by dispatching one batch in one message
and waiting for the whole batch before starting another. Dispatch hard items one
at a time. Run parallel writers only with explicit, disjoint file ownership
listed in every dispatch prompt. Serialize work on shared files, shared
contracts, generated outputs, formatters, and workspace-wide commands. Only the
parent updates a shared spec or task checklist and runs full validation after a
writer batch.

For review, first apply
`<plugin-root>/resources/methodology/review-policy.md`. Derive total assignments
from the resolved Review policy's `specialist breadth`, `adversarial mode`, and
`convergence budget`, then schedule as many batches as that coverage requires. Review
concurrency limits only how many agents run at once; it never reduces total
required coverage. Diff size alone never adds reviewers. An explicitly approved
cross-model pass counts toward the resolved `convergence budget`, but it replaces
a local verifier only when the resolved `adversarial mode` allows it.

Batch independent tool calls in parallel when the host supports it. Good
candidates are unrelated searches, file reads, metadata inspection, and
read-only checks whose results do not affect one another. Keep result-dependent
calls, approval-sensitive actions, shared-state mutations, formatters, and final
validation sequential. Do not simulate parallel tool use by chaining unrelated
shell commands into one command.

Apply the retry budget according to task necessity:

- Retry a mandatory implementation item once. After a second failure, complete
  it inline in the parent conversation and state that fallback.
- Retry an optional reviewer once. After a second failure, name the uncovered
  review dimension; do not copy the whole checklist into the parent context.
- Do not retry a scout. State that reconnaissance coverage is partial and
  continue from repository evidence gathered by the parent.
- If an entire batch fails because of provider errors, do not fan it out again.
  Complete mandatory work inline or sequentially and state optional gaps.

The agent frontmatter model and effort are preferences. Host settings or a
per-invocation override may take precedence. If a host does not expose plugin
agents, use its general-purpose equivalent with an explicitly cheaper model when
supported. Otherwise work inline and state that model pinning was unavailable.
