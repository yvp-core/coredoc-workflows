### 3. Align the domain and solution before elaborating

Do not start the detailed use-case, rule, limitation, acceptance, ADR, or
file-by-file implementation plan until the user and agent have the same material
picture. Run two lenses over one shared working model:

- **Decision dependencies:** separate repository facts from user-owned choices,
  record which choices depend on others, and expose only choices that can be
  answered from the evidence and decisions already settled.
- **Domain model:** sharpen ambiguous terms, identify relevant actors/entities,
  ownership, relationships, invariants, and lifecycle, and probe them with
  concrete scenarios. Cross-check every claimed current behavior against code
  and repository documentation.

These are concurrent lenses, not separate interviews or competing artifacts.
Resolve repository-verifiable facts yourself. Ask the user only for decisions
that materially change the outcome, boundary, public contract, data ownership/lifecycle,
migration, consistency or performance posture, security/retention, compatibility,
rollout, or acceptance. If repository constraints leave one viable path, explain
the constraint and proceed; do not invent alternatives merely to ask a question.

#### Decide whether interaction is needed

A user-provided mature PRD, specification, or equally concrete description may
pass this checkpoint without a question when all applicable material points are
already resolved: observable outcome, smallest in-scope slice, non-goals,
domain terminology and ownership, affected consumers/contracts, important data
and lifecycle behavior, operational constraints, and rollout/rollback. Repository
grounding must reveal no material contradiction or stale premise, and the agent
must not be introducing a new user-owned trade-off. Length and formatting alone
do not make input mature.

When those conditions hold, show a compact extracted understanding and continue
without a ceremonial approval question. If evidence changes the proposed
boundary or leaves a material choice open, interaction is required even for a
long PRD.

For an interactive checkpoint, map decision dependencies internally and ask only
the choices that are answerable now. Ask the smallest useful round, with no more
than three independent decisions. If one answer changes another question's
options, ask the prerequisite alone, wait, then recompute the answerable set. Use
concrete scenarios to make fuzzy domain boundaries observable. For each known
choice, use the host's structured input tool with one decision, 2–3 real options,
one recommended option with a concrete reason, and the trade-off that could
change the answer. This compact contract overrides any generic decision-brief
format elsewhere in the plugin for pre-spec alignment. Do not add ELI10 sections,
completeness scores, effort estimates, or separate stakes/pros/cons blocks; put
the relevant consequence directly in each option. Use prose only when the answer
is open-ended or the structured input tool is unavailable.

#### Show the shared picture

Before any required question, present a concise alignment brief containing only
applicable fields:

- desired observable outcome and what means done;
- verified current behavior and relevant repository evidence;
- smallest scope and explicit non-goals;
- canonical terms, actors/entities, ownership, relationships, and invariants;
- proposed system/data flow, public contracts, storage or lifecycle changes at
  the detail needed to expose material choices;
- affected consumers and important operational constraints;
- accepted assumptions/decisions and unresolved user-owned decisions.

This is not the specification or a file-by-file implementation plan. Keep it
compact enough that the user can correct the overall direction. After an answer,
update the shared model and re-show only material changes before the next
dependent question. If a required decision remains unanswered, stop and wait:
do not write the spec artifact, manufacture UC/BR/LIM/AC/ADR rows, start plan
review, or begin implementation. When the host cannot collect the answer in the
current turn, a standalone invocation returns `NEEDS_CONTEXT`. A routed workflow
always returns `NEEDS_CONTEXT` before asking, closes the current spec attempt as
blocked, and restarts the same stage after the answer, including when a
structured input tool resumes the host turn. Each question—including every
decision in a round and the final confirmation below—is its own blocked attempt:
close the attempt as `blocked`, ask exactly one question, stop, and restart the
same stage after the answer before exposing another question.

When no interactive decisions remain, present the complete updated brief
and ask one final **Proceed with this understanding / Revise it** decision, with
the recommended answer. Stop and wait for that confirmation; in a routed
workflow it follows the same `NEEDS_CONTEXT` blocked-attempt lifecycle as a
design question. Answering the last
design question does not implicitly approve the assembled picture. A revision
reopens the affected dependent choices. This final confirmation is not required
for the mature-input path above because the user already supplied the complete
authoritative picture and no material reinterpretation was introduced.

Read existing repository-native glossaries and decision records when present.
Do not create a new documentation convention or update domain/ADR files during
alignment unless the user explicitly requested those writes. Carry accepted
terminology and decisions into the specification instead.

Approval at this checkpoint authorizes only elaborating the aligned picture into
a specification. It does not mark that future specification accepted, satisfy a
post-review implementation gate, or authorize code changes.
