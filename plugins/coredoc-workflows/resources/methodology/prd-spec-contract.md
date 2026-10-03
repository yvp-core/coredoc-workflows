## PRD and specification contract

The PRD owns product intent; the engineering specification consumes it.

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
4. **Handoff to the specification.** The specification cites PRD rows by id and
   does not restate or re-derive product content; its own ids stay technical
   (`AC-n`, `LIM-n` for technical limits, plan steps).
5. **Approval gates three things only:** `status: approved` (the
   specification's `accepted`), proposing and accepting its intent, and an external
   destination such as Jira. A `status: draft` file may be written at once to
   the path the user named or the documented location.
