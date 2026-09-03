## Plan review completion gate

Before declaring an engineering plan ready:

1. Re-read the final plan after the most recent change.
2. Confirm every material finding was presented to the user and every decision
   records the accepted option. Writing findings into the plan is not a
   substitute for asking about unresolved choices.
3. Confirm the plan contains:
   - verified current state and affected contracts;
   - architecture and data-flow decisions;
   - failure modes and operational behavior;
   - explicit scope and non-goals;
   - release context: supported paths, actual users or tenants, deployment mode,
     data-retention or cutover constraints, planned deprecations, realistic load,
     and accepted risks;
   - rollout, compatibility, and rollback only where that context requires them;
   - a risk-based validation map using the smallest meaningful test layer;
   - unresolved questions or the exact statement `NO UNRESOLVED DECISIONS`.
4. Map every acceptance criterion to an implementation step and verification
   method.
5. Classify unverifiable external or cross-repository assumptions explicitly;
   never mark them complete from related local code.
6. Apply the finding contract and resolved review policy before withholding
   readiness. Only the policy's blocking set gates readiness. `NEEDS_CONTEXT`
   requires its one resolving question; hypotheses require verification, not
   implementation tasks.
7. End with the accepted decisions, residual risks, non-goals, validation
   commands, and readiness verdict.

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
