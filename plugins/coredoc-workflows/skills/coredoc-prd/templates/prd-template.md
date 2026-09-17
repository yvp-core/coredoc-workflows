> Part of the `coredoc-prd` skill. Every PRD this skill produces follows this
> structure. Row ids follow the PRD and specification contract in `SKILL.md`.

# PRD template

## How to use this template

Fill every section that applies. A section with nothing in it gets a one-line
reason, not a blank: "Full release, nothing staged, because the feature is
admin-only and reversible" reads as a decision; an empty heading reads as an
oversight. Omit a conditional section with one line saying why.

Write in the product's own vocabulary: the terms the intent graph or the PRD
profile supplies, and otherwise the terms the repository's product docs use.
Keep every table narrow and every cell to one line.

**Row ids are stable.** `G-n`, `D-n`, `US-n`, `EC-n`, `NG-n`, `OQ-n` are
assigned once and never renumbered. A row removed in a revision keeps its number
retired; a new row takes the next number. Cross-references inside the PRD cite
these ids.

**The PRD describes the behaviour the system must have. It never instructs
whoever builds it.** No sentence is addressed at an implementer: no "do not
touch this", no "skip the review". Where the user wanted something this skill
does not write, the PRD records what is unresolved rather than what someone
should do about it: "whether this ships without a tech lead review is
unresolved" is an `OQ-n` row; "skip the tech lead review" is an instruction and
stays out.

**Never describe the work as small, simple, quick, or straightforward.** An
estimate written into a PRD becomes a commitment nobody made.

---

## Frontmatter

```markdown
---
status: draft | approved
intentIds: []        # filled after approval when an intent write capability proposed candidates
---
```

## Standing disclaimer

Unnumbered, first thing after the title. The only standing caveat in the
document; everything else is a requirement, a decision, or a question.

> *Read for this PRD: [the linked design / the repository's product docs and
> existing PRDs / the profile / the user's description only: name what was
> actually read]. Not verified: how the system behaves today, including anything
> marked `[unverified]` and every Engineering row in Open Questions. No engineer
> reviewed this; that comes before build.*

## Summary

One paragraph. What is being built, why, and how it connects to the existing
product. Describe the outcome, not a feature list. A bug opens instead with the
defect declaration in the bug variant below.

## Goals

| ID | Goal |
|---|---|
| G-1 | [An outcome, not a feature: what problem this solves, for whom] |

## Success signal and guardrail

How anyone will know this worked, and where that number comes from:

> *We expect [what changes] to show up in [the report, dashboard, or event that
> carries it]. Today it reads [current value, or "not measured, and nothing here
> is being built to measure it"].*

If nothing existing can measure it and nothing is being built to, say so rather
than writing a number that cannot be checked.

**Guardrail: what must not move.** Required whenever this changes something
that already exists. Name the value, report, or population this change is
expected to leave untouched, as an `NG-n` row below and one line here. Nothing
outside the user's head can supply it: a reader can see what a change touches
and never what it was meant to leave alone.

## Non-goals and guardrails

| ID | Non-goal or guardrail |
|---|---|
| NG-1 | [What this deliberately does not do, and who it is explicitly not for] |
| NG-2 | [Unchanged: the behaviour, value, or population that must survive this change] |

Non-goals are what the requester excluded plus the guardrail rows for existing
behaviour this change touches, and nothing else. A decision is never restated
as a non-goal; a population that is out ("not for Employees") appears once.
Whenever this changes something that already exists, the current behaviour
that must survive unchanged is an `NG-n` row: it is the regression scope, and
without it the build silently drops behaviour nobody wrote down.

## Current vs Desired

Written whenever this changes something that already ships; omitted with one
line for genuinely new work. Two short blocks:

**Current behaviour**: what the product does today, for whom, under which
configuration. Anything here the user relays rather than decides carries
`[unverified]` and an `OQ-n` row for Engineering.

**Desired behaviour**: what it does instead once this ships, and the rule that
says so.

The delta is the work. This names what **does** change; the guardrail names what
must **not**.

## Decisions

| ID | Decided | Alternative weighed | Who decided |
|---|---|---|---|
| D-1 | [Mid-period changes recompute the whole period] | [Forward-only from the change date] | PM |

Only decisions where two readings produce materially different builds, the ones
the interview took one at a time. A ruling in the request ("we decided", "we
rejected") is a row with the decider as `PM` or the requester's role; never
open an `OQ` asking who decided. An entry with no alternative weighed is an
assumption and belongs below. If the interview settled none, say so in one line.

## Assumptions

| # | Assumption | Why it was needed |
|---|---|---|
| 1 | [Stated as a claim, not a question: every "use your best judgment"] | [Which story or criterion depends on it] |

Anything the draft can proceed on without an answer is a row here, with a
one-line reason, not an open question. On "draft it now", the gaps the
interview would have asked about land here; only blocking ones stay `OQ`.

**External systems this PRD leans on.** Only systems the user named, and only
what the PRD assumes about each; each also gets an `OQ-n` row for Engineering.

## Cross-cutting concerns

With a PRD profile, one row per concern it lists, each `In scope` (+ one-line
note), `N/A` (+ a reason about the feature), or `Open` (+ the question and its
`OQ-n`). Without a profile, the rows are whatever the one open cross-cutting
question surfaced, and one line records that no profile applied.

| Concern | Status | Notes |
|---|---|---|
| [Reports] | | |

An `N/A` reason says why the concern does not apply to this feature. "Not
raised", "not specified", and "no answer given" describe the interview, not the
work, and do not qualify; a concern nobody asked about is `Open` with its
question.

## User stories

**The shape the user asked for is the shape they get.** A task, a single
ticket, or one PRD produces **one story**, with every concern that applies
appearing as a sub-section or an acceptance criterion inside it. The
epic-with-children shape is the default only where the user asked for an epic.

**A split needs a reason.** Work becomes more than one story only where at
least one of three conditions holds: the parts can **ship** independently, be
**tested** independently, or carry **genuinely different rules**. Absent one of
those, it is one story with named sub-sections. Where a split condition holds
inside work the user asked to be one item, ask rather than deciding.

---
**US-1  [Story title]**

*As a [role], I want to [goal], so that [value].*

| # | Acceptance criterion |
|---|---|
| 1 | [One testable sentence, starting with a noun or "The system...".] |

---

The *so that* clause names the outcome, not the action restated; it is the only
place the goal survives into the document after the interview ends.

**Acceptance criteria rules**

- One sentence each. No rationale.
- Specific enough to write a test from. Never "works correctly", "looks good",
  "handles it gracefully", and no adjective standing in for a number: fast,
  responsive, robust, seamless.
- A criterion about a computed or derived value states the conditions it holds
  under.
- No criterion rests on the absence of an error. Name the observable result. A
  stated non-effect is observable and often the one that matters.
- Every form gets criteria for required-field validation and error states;
  every permission-restricted action gets one for what a non-permitted user
  sees.
- A statement about how the system behaves today is not a criterion: mark it
  `[unverified]` with an `OQ-n` row, or keep it out of the table. The marker
  marks a claim, never a requirement.

**Worked example for a computed rule**, when the profile requires one or the
user supplied the values:

> Given [stated configuration] and [stated inputs], when [the computation
> runs], then [the stated result].

Where the values are not confirmed the example stays a placeholder with an
`OQ-n` row rather than being dropped.

**User flow, optional.** Where behaviour reads as an ordered sequence, write it
as numbered steps under the story, and the flow **replaces** the criteria that
described that sequence rather than sitting beside them. Criteria covering what
the flow does not describe (validation, permissions, a computed value) stay in
the table.

## Edge cases

Those the requester named, plus ones whose resolution is grounded in a
supplied decision, each reflected in a criterion. Speculative candidates are
offered in the reply, outside the PRD, never generated into it.

| ID | Edge case | Resolution | Where it lands |
|---|---|---|---|
| EC-1 | [Condition] | [Defined behaviour] | [US-n / criterion #] |

On an epic, "Where it lands" names the story and stops there: a criterion
number exists only inside a child.

## Open questions

Only gaps that block a story or an acceptance criterion, in one table; this is
the only destination for them. Anything the draft can proceed on is an
Assumption instead. The addressee says who can settle it, which is part of the
question rather than an assignment.

| ID | Question | Affects | For |
|---|---|---|---|
| OQ-1 | [Question] | [US-n / section] | PM |
| OQ-2 | Which system is the source of truth for [value], and does it vary by configuration? | [US-n] | Engineering |

Use an inline `OPEN QUESTION: OQ-n` in the affected story too, so a reader hits
it where it matters and not only here.

## Release and communication notes

Only when the PRD profile asks or the user raised it. Rollout as a combination
of dimensions (staged, behind a flag, beta accounts first, by region or entity),
each with its detail; the risks that are real, with no minimum count and a
reason where there is one or none; rollback and who decides; what must be true
before release; dates and whether a deadline is hard. Which teams need to know
and why, whether a demo or documentation is needed and who produces it.

## Profile additions

When the active PRD profile carries `## Template additions`, its sections are
appended here, after Open questions and in the profile's order, each with the
rules the profile gives it. An addition covering release or communication
stands in for Release and communication notes. Additions never carry row ids
of their own; they cite `US-n`, `EC-n`, `OQ-n` rows like every other section.
Without a profile there are none, and nothing is written here.

---

## Epic shape

Only when the user asked for an epic. The epic holds the story list and what is
shared: goals, non-goals, decisions, assumptions, cross-cutting concerns,
release notes. Each story becomes a child issue carrying the story alone and
whatever it needs to stand on its own.

| Story | Title | Child |
|---|---|---|
| US-1 | [Story title] | [key or path, once created] |

Edge cases and open questions stay complete on the epic; each child holds its
own subset **with the same ids**, never renumbered, so a cross-reference written
against the epic still resolves in the child.

**Child issue description**

```markdown
*As a [role], I want to [goal], so that [value].*

**Story:** US-n

| # | Acceptance criterion |
|---|---|
| 1 | [...] |

**Edge cases affecting this story**

| ID | Edge case | Resolution |
|---|---|---|
| EC-n | [Condition] | [Defined behaviour] |

**Open questions affecting this story**

| ID | Question | For |
|---|---|---|
| OQ-n | [The question in full] | PM / Design / Engineering |
```

The child never names the epic in its text and never points at a section of it
for content it needs; a child that cannot be worked alone is not standalone,
which is the whole point of splitting.

---

## Variants

### Bug

**The document declares itself a defect in its opening lines**, before the
standing disclaimer:

> **Defect in existing behaviour.** [The value, screen, or rule] currently
> [what it does wrong] for [who or where]. This is a fault in behaviour that
> already ships, not new work. Whether the value is wrong where it is produced
> or corrected further along is unresolved: see Open Questions.

Then replace Summary, Goals, and Success signal with: **Current behaviour** and
**Expected behaviour** (the Current vs Desired pair, where the rule is the one
the product is already meant to follow and the gap between the blocks is the
fault); **Reproduction**, numbered steps with the role, configuration, and data
needed to hit it; **Scope of impact**, which accounts, roles, and periods, and
how long it has been happening; **Existing wrong data**, whether already
computed results are wrong and whether they need correcting, since a fix that
stops new errors and one that also backfills are different work; **Where it is
wrong**, usually not visible to the user, so it goes to Open Questions for
Engineering, and no criterion commits to a number until it is answered.

Non-goals, Decisions, Cross-cutting concerns, Edge cases, and Open questions
still apply.

### Spike

No acceptance criteria; inventing them for a spike is fabrication. Instead:
**Question**, the one thing this answers, stated so the answer is recognisable;
**Timebox**, how long before it stops regardless of outcome; **Output**, the
artifact it produces; **Decision unblocked**, which product decision waits on
this and who makes it; **Out of scope**, what it deliberately does not attempt.
Keep Decisions, Assumptions, and Open questions; drop the rest.
