## Plan review completion gate

Before declaring an engineering plan ready, re-read the final plan after the most
recent change and confirm:

1. Every material finding was presented to the user and every decision records
   the accepted option. Writing findings into the plan is not a substitute for
   asking about unresolved choices.
2. The plan lists unresolved questions or the exact statement `NO UNRESOLVED DECISIONS`.
3. Unverifiable external or cross-repository assumptions are classified as such,
   never marked complete from related local code.
4. Only the resolved review policy's blocking set withholds readiness.

End with the accepted decisions, residual risks, non-goals, validation commands,
and readiness verdict.

Do not start implementation merely because the review is complete. For a gated
large change, present the reviewed direction and material deltas first, then
ask one explicit **Accept and implement / Revise** decision. Only an
unambiguous acceptance of that decision counts: it both accepts the reviewed
specification and authorizes implementation. An acknowledgement, a partial
answer, or an acceptance with a requested change is a revision request. Routed
plan review never marks the specification accepted. After approval, the
implementation stage completes its read-only preflight and proof-plan
announcement. If the reviewed frontmatter is `status: draft`, implementation
sets it to `status: accepted` as its first repository write before any code or
test edit; an unchanged accepted status from a prior session is preserved. A
requested revision returns to specification and review. The original change
request, pre-spec alignment approval, spec existence, or a positive review
verdict is not that approval.
