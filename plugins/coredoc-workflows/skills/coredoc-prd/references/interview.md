> Part of the `coredoc-prd` skill. Read on demand.

# The interview

## Find the goal, not the task

The user arrives with a task ("add a filter to the list"). The goal is the
decision that task serves, and only they can set it.

- Establish the core problem, who it is for, and **who it is explicitly not
  for**.
- Ask the questions the user would not know to ask. That is the value added.
- Summarize back before drafting, and show the decisions so the user can
  override before anything commits.
- Keep scope tight. When direction changes, say what moved.

Openers that reach the goal rather than the task:

- "What decision does this let someone make that they cannot make today?"
- "Which role feels the pain now, and what do they do instead?"
- "Who will ask for this next, and are we deliberately not serving them?"

## Batch coverage, single-thread decisions

**Coverage questions** are factual gaps with no trade-off: which fields, which
roles, which surfaces, whether an export changes. They go out as **one batched
round**, as the host interaction contract allows, with empty groups dropped and
anything already answered left out.

**Decisions** are where two readings produce materially different builds. They
are surfaced **one at a time**, with the options and the trade-off spelled out,
so the user rules before anything is written on a guess. Keep each one with the
alternative it beat and who ruled; every decision taken here lands in the PRD's
Decisions table as a `D-n` row, because the outcome alone, which is all an
acceptance criterion carries, leaves the next reader to re-decide the same
question the first time the build meets a case no criterion covers.

Telling them apart: ask what a wrong answer costs. A wrong coverage answer
costs an edit; a wrong decision costs a rebuild.

**At least one full clarifying round runs before drafting**, even when the
request arrives detailed. A user who has written a lot of context has usually
written it about the part they already understand.

**Never re-ask something already answered.** Before each round, check what is
already answered, including answers that arrived incidentally, in prose, while
the user was talking about something else.

**Give the user a way out from the second round on.** Say it plainly: they can
answer these to improve completeness, or say draft it now and the draft goes
ahead. If they proceed, name the items left open: the ones that block a story
or a criterion become `OQ-n` rows, the rest become Assumption rows with a
one-line reason.

## How to ask

### The tool

Without the host's question tool, present the same options as numbered text in
the same order, "reply 1, 2, or 3, or tell me something else", then stop and
wait.

### The envelope

Each option is a short label of a few words. Put the reasoning and the evidence
in the line before the call, not inside the option. Where more than one answer
can be true at once, say so in that line and ask for several. Stop after the
call; do not keep drafting past it.

Where a recommendation belongs with a decision, it goes in the line before the
call and the options carry only the choices:

> Mid-period policy change. I'd suggest recomputing the whole period, since a
> manager seeing two rules inside one period is the harder thing to explain,
> but it can move totals someone already approved, so it is your call.
>
> *[Recompute the period · Forward-only · Not sure]*

### Three kinds of question

**Fixed options**: the answer set is already known. Yes/no, either/or, which
work type, which roles, which rollout shape.

**Generated options**: the answer set is not fixed anywhere, but two or three
plausible answers follow from what was just read. The likely values of a
dropdown seen in the design, the probable default of a toggle, candidate edge
cases for this feature, the teams that plausibly need to know.

**Text**: no option set can hold the answer honestly. The problem itself, a
rule nothing read suggests, a number, a date, a correction to the summary. Ask
for prose and mean it.

### Generating options from evidence

Options come from something read or something the user already said, never
from invention. Say where they came from in the line before the call, because
an option the user cannot trace is one they cannot correct:

> The design shows a "Period" dropdown with no values listed. From the screens
> around it these look like the candidates:

If nothing read suggests candidates, the question is a text question;
producing plausible-looking values from nowhere is worse than asking, because a
wrong option set gets tapped.

Ask in prose about how the system behaves today, which belongs in Open
Questions, and about any rule the user has not stated: a tapped guess reads
exactly like a confirmed rule.

A tapped option is the user's answer, not a fact this skill verified: one about
how the system behaves today still carries `[unverified]` and an `OQ-n` row for
Engineering, or stays out of the acceptance criteria.

### The escape

Every question carries a way out: **Other**, **None of these**, or **Not sure**,
chosen to fit the question. Where the host adds its own free-text escape, the
options still name "Not sure" explicitly when a non-answer is a plausible
outcome, because a tapped "Not sure" is a recorded answer the PRD can carry as
an `OQ-n` row. When "None of these" would make a concern `N/A` or an edge case
out of scope, say so in the line before the call.

### Profile concern groups

Each call carries its own context line, what that group covers and what ticking
an item produces, so the user can tell the rounds apart. The first call says
how many are coming.

> **Call 1 of 2: where the data goes.** Ticking a row here produces one line in
> the concerns table.
>
> *[Reports · Exports · Integrations]* (plus: None of these · Not sure)

## Who can settle which claim

A PRD mixes two kinds of statement that look identical on the page.

**The user has authority over intent**: the problem, who it is for, scope,
which behaviour we want, when it ships. A statement here is a decision, not a
claim that could be checked. Build on it.

**The user has no authority over how the system behaves today**: what a stored
value means, which system holds the authoritative copy, whether a number is
already correct, what else writes the same data, whether a screen is still in
use. Here they are relaying, and a relayed answer written in the declarative
voice becomes a requirement nobody checked.

Sorting a statement takes one question: **could the user be factually wrong
about this, as opposed to changing their mind?** If yes, it is the second kind,
however confidently it arrived. It carries an inline `[unverified]` marker
where it appears and one `OQ-n` row addressed to Engineering. A marker with no
question is a shrug; the question is what gets it answered. A ruling in the
request is the first kind. Where a requirement leans on an unverified fact, mark
the fact and leave the requirement clean.

## One destination for anything unsettled

Everything unsettled goes to **Open Questions**, one table, each `OQ-n` row
naming what it affects and who can settle it: `PM`, `Design`, or `Engineering`.
There is no second list. Recurring questions for Engineering, phrased so the
user can carry them into a conversation without this skill in the room:

- Which system is the source of truth for this value, and does that vary by
  customer or configuration?
- What else reads or writes this data, and what changes downstream?
- Is the current value wrong, or is something further along correcting for it?
- Is the screen, report, or table we are building on still in use?
- Should this be configuration rather than another one-off?
- What signal would tell us this worked, and what would tell us it silently
  did not?

Ask only the ones that apply.

## A non-answer is not an answer

"None of these apply" is a decision and gets recorded as one. "No preference",
"not sure", and an empty selection whose intent is unclear decide nothing, so
nothing gets written: re-ask once with concrete options drawn from what was
read, and if that comes back empty too the item goes to Open Questions rather
than into the body. A non-answer written in as though it were a decision
produces a row that asserts nothing while reading as though somebody considered
it.

## Verification realism

Ask for what the template's acceptance-criteria rules need: the conditions a
computed value holds under, an observable result rather than "no errors", and
the values for a worked example where the profile requires one. Where the
expected value depends on configuration, ask which configuration governs it
rather than picking one.

## Show inferences as inferences

State what was concluded and from where, then let the user override before it
commits. An inference presented as fact is the most expensive error here,
because it survives review; it reads like something the user said.

```
From the design I'm concluding:
  - only Owner and Admin reach this screen (the nav item isn't in the Manager mockup)
  - the list defaults to the current period
Correct any of these, or say "looks right" and I'll carry them forward.
```

When the user says "use your best judgment": proceed, and write the assumption
into the PRD's Assumptions section as a claim, never buried in an acceptance
criterion.

## Sign-off zones

The user rules on these rather than getting a filled-in guess, because a
plausible guess passes review and a visible blank does not: any cross-cutting
concern still open, any design gap that blocks the work, and every zone the
active PRD profile lists. Without a profile, the guardrail question below is the
one sign-off zone.

## The clarity check

Before drafting, check the summary against these silently. The user is told it
runs.

- Every rule the stories depend on is defined, not gestured at.
- Every cross-cutting concern the profile lists is answered or `N/A` with a
  reason about the feature; without a profile, the one open cross-cutting
  question has an answer or an `OQ-n` row.
- Nothing that arrived as "no preference" or "not sure" is in the body.
- Every edge case the requester named, or a supplied decision resolves, has a
  resolution, not just a name; none is speculative.
- No contradiction and no vagueness that would block a testable criterion.
- No design gap that needs a design decision before the work can be specified.

Clear on all → draft. Anything failing → one more grouped round covering exactly
those, then check again.

## Question groups

Work through the groups as one batched round, dropping empty groups and
anything already answered.

### A. Scope and goals

- What problem does this solve, and for whom?
- Which roles are the primary users?
- Who is this explicitly not for? Any non-goals already decided?

### B. Rules and logic

With a design: for every control visible, what are the exact options, the
default, and what happens if it is never configured?

Without a design: walk the rule itself. Inputs, output, which configuration
selects between behaviours, what happens at the boundaries.

Either way, two distinct questions whenever the work touches something that
already ships: **what must not change** (the regression scope, which becomes an
`NG-n` guardrail row), and **what does it do today and what does it do instead**
(the Current vs Desired block; anything relayed about today carries
`[unverified]`). Where nothing ships in this path yet, say so and the block is
omitted with a line rather than filled with "N/A".

Can the configuration change after it is in use, and what happens to existing
records? If this is another variant of something that exists, should it be
configuration instead, and who decides?

### C. Domain-specific questions

Supplied by the active PRD profile's `## Question groups`, batched with the
groups here. Ask the subset that applies to this work and skip the rest.
Without a profile there is no group C.

### D. Edge cases

Offer candidates drawn from what was read; the user cuts. On "draft it now",
offer them in the reply, outside the PRD. Typical candidates:
deleting something with active dependencies, a change mid-cycle, an event
arriving after a boundary closed, zero records, the maximum selection, two
people acting on the same record at once, a timezone or daylight-saving
boundary.

### E. Cross-cutting effects

With a profile: its concern list, each answered in scope, `N/A` with a reason
about the feature, or open with the question. Without a profile: one open
question, "What else does this touch: other surfaces, reports, exports,
integrations, permissions, notifications, performance at scale?", and record
the answer as the Cross-cutting concerns rows.

### F. Release and communication

Only when the profile asks or the user raises it. Rollout shape (a combination,
asked as several yes/no questions), the risks that are real (no minimum count;
an empty answer comes back once with named candidates, then stands), rollback
and who decides, dependencies, dates; which teams need to know, whether a demo
or documentation is needed.
