## Plan review completion gate

Before declaring an engineering plan ready, re-read the final plan after the most
recent change and confirm:

1. Premises were checked against current code and release context.
2. Scope, non-goals and existing reusable mechanisms are explicit.
3. Every accepted outcome maps to implementation and validation.
4. Reachable failure modes and public consumers are covered, plus rollout and
   rollback where release or data context requires them.
5. Every material finding was presented to the user and every decision records
   the accepted option. Writing findings into the plan is not a substitute for
   asking about unresolved choices.
6. Unresolved user decisions are visible rather than defaulted: the plan lists
   them or the exact statement `NO UNRESOLVED DECISIONS`.
7. Unverifiable external or cross-repository assumptions are classified as such,
   never marked complete from related local code.
8. Findings follow policy and no nonblocking observation silently expanded
   scope; only the resolved review policy's blocking set withholds readiness.

End with the accepted decisions, residual risks, non-goals, validation commands,
and readiness verdict.

Do not start implementation merely because the review is complete. For a gated
large change, present the reviewed direction and material deltas first, then
ask one explicit **Accept and implement / Revise** decision; only an
unambiguous acceptance of it counts. Routed plan review never marks the
specification accepted.
