## PRD and specification contract

The PRD owns product intent; the engineering specification consumes it. Five
rules bind the two documents.

1. **PRD row ids are stable across revisions.** `G-n` goals, `D-n` decisions,
   `US-n` user stories, `EC-n` edge cases, `NG-n` non-goals and guardrails (what
   must not move), and `OQ-n` open questions, each with an addressee (`PM`,
   `Design`, `Engineering`). Ids are never renumbered when a PRD is revised; a
   removed row keeps its number, retired. PRD frontmatter carries
   `status: draft | approved`.
2. **Claim provenance.** A statement about how the system behaves today that
   the PM relays rather than decides carries `[unverified]` inline and one
   `OQ-n` addressed to Engineering. The marker goes on claims, never on
   requirements.
3. **What enters the intent graph, and as which kind.** Intent ids are
   kind-prefixed slugs (see `intent-context.md`): `G` → `cap`; `D` → `dec`,
   carrying the alternative weighed and who decided; `US` → `uc` or `flow`; an
   `EC` resolution → `br`; `NG` → `lim`. `[unverified]` claims and `OQ` rows
   never enter the graph: they are verification debt for the specification.
   After a PRD is `approved`, and only when the session can propose intent
   candidates (the write stage in `intent-context.md`), the PRD skill proposes
   them in one batch, sourced at the repo-qualified PRD path and row id, and
   records each returned slug beside its row and as `intentIds` in the
   frontmatter. A draft proposes nothing.
4. **Handoff to the specification.** The specification cites PRD rows by id and
   does not restate or re-derive product content; its own ids stay technical
   (`AC-n`, `LIM-n` for technical limits, plan steps). On a PRD, the
   specification verifies each `[unverified]` claim against the repository,
   answers each `OQ` addressed to Engineering, and adds the technical contract,
   acceptance, and plan.
5. **Domain vocabulary comes from the graph when present.** Make one
   `get_intent_context` call with `task` (the request text) and, when known,
   `domain`/`feature` before the interview; use the returned
   `matchedFeatureIds`, rules, and their wording. When `matchedFeatureIds` is
   empty, propose the feature in the interview — domain, title, one-sentence
   statement — and, once the PRD is approved, create it with `intent_tree` in
   the user's session before proposing candidates into it, naming in the reply
   what it created; a service-token session drafts it and stops. When no intent
   capability exists, or the
   graph is empty, an optional repository profile supplies the vocabulary, and
   the output says nothing about intent.
6. **Approval gates three things only:** `status: approved` (the
   specification's `accepted`), proposing intent candidates, and an external
   destination such as Jira. A `status: draft` file may be written at once to
   the path the user named or the documented location.
7. **A ruling in the request is the requester's decision.** "We decided X" or
   "we rejected Y" records the decider as `PM` or the requester's role, with
   the alternative named, and never opens an `OQ` asking who decided.
