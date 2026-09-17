> Part of the `coredoc-prd` skill. Read on demand; `asking.md` says how each
> question below is delivered.

# The interview

## Why the interview is the whole job

PRD quality is downstream of interview quality. A PRD assembled from a thin
interview looks complete and fails in build, because the gaps sit where nobody
asked. The template and the write are bookkeeping on top of what the interview
surfaced.

## Find the goal, not the task

The user arrives with a task ("add a filter to the list"). The goal is the
decision that task serves, and only they can set it.

- Establish the core problem, who it is for, and **who it is explicitly not
  for**.
- Ask the questions the user would not know to ask. That is the value added.
- Work key decisions one at a time. "Use your best judgment" is a valid answer:
  proceed, and record the assumption where it can be seen.
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
round**: a short sequence of single-question calls, empty groups dropped and
anything already answered left out. Drip-feeding turns a five-minute answer into
a forty-minute interrogation, and the answers get careless.

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
request, "we decided X" or "we rejected Y", is the first kind: record it as a
`D-n` row with the decider as `PM` or the requester's role, and never ask who
decided.

**The marker goes on claims and never on requirements.** A statement of
behaviour being built is a decision; the only thing that would make it uncertain
is nobody having taken it, which is a different problem with a different home.
Where a requirement leans on an unverified fact, mark the fact and leave the
requirement clean.

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

Ask only the ones that apply. This skill asks these and records answers. It
does not answer them and does not offer a theory about what the answer probably
is: a guess gets built, a blank gets answered.

## A non-answer is not an answer

"None of these apply" is a decision and gets recorded as one. "No preference",
"not sure", and an empty selection whose intent is unclear decide nothing, so
nothing gets written: re-ask once with concrete options drawn from what was
read, and if that comes back empty too the item goes to Open Questions rather
than into the body. A non-answer written in as though it were a decision
produces a row that asserts nothing while reading as though somebody considered
it.

## Verification realism

**State the conditions.** A criterion about a computed or derived value names
the conditions it holds under, which configuration, which inputs, which state,
or it does not get written. "Shows the right number" will be marked passed
against whatever the system produces.

**Never rest on the absence of an error.** "Runs without errors" asserts that
nothing visible went wrong, not that the right thing happened. Name the
observable result. A stated non-effect is different and often the one that
matters: "totals for users outside the change are unchanged" is observable.

**Send configuration-dependent answers to Open Questions.** Where the expected
value depends on configuration, ask which configuration governs it rather than
picking one.

**Write a worked example for a computed rule** when the profile requires one
or the user can supply the values: given stated inputs and configuration, the
output reads a stated value. Where the values are not confirmed, keep a
placeholder with an `OQ-n` row rather than dropping it.

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
anything already answered. `asking.md` says how each is asked.

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

Supplied by the active PRD profile. Ask the subset that applies to this work
and skip the rest. Without a profile there is no group C.

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

## Worked example

> **User:** I need a PRD for bulk approval of pending items.

1. Read the repository's product docs, existing PRDs, and the profile, then
   report what already holds up and what is missing.
2. Check the goal in one line: "Reading this as: supervisors lose time
   approving items one at a time at period close, and the goal is closing
   faster, not changing which items need approval. Right?"
3. Inferences stated as inferences: which roles reach the screen, the default
   period, whether closed periods are editable.
4. One batch of coverage questions: which states are eligible, which roles can
   bulk-approve, whether the export changes.
5. Decisions one at a time: does bulk approval run the same validation as
   single approval? What happens to items that fail validation mid-batch?
6. Summary with the decisions and their alternatives. User confirms.
7. Draft from the template. Revise on request. Ask for approval, then write.
