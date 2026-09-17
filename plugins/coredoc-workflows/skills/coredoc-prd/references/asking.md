> Part of the `coredoc-prd` skill. Read on demand.

# How to ask

## The tool, and what to do if it is absent

Use the host's structured input tool, `AskUserQuestion`, as the skill's host
interaction contract resolves it. With no such tool, present the same options as
numbered text, "reply 1, 2, or 3, or tell me something else", then stop and
wait; a typed reply is the answer. The fallback is not a failure mode to avoid;
it is the same interview with a plainer surface. Never auto-decide because the
structured tool was missing.

Use it for every question with a knowable answer set, because a user tapping
through choices stays sharper than one typing paragraphs, and a tired user
answers carelessly.

## The envelope

The portable contract is the narrower of the hosts' limits: **one decision per
call, at most three options**, each a short label of a few words. Put the
reasoning and the evidence in the line before the call, not inside the option.
Where more than one answer can be true at once, say so in that line and ask for
several. Stop after the call: the selection comes back as the user's next
message; do not keep drafting past it.

A batched coverage round is therefore a short sequence of single-question
calls, not one form. Where a recommendation belongs with a decision, it goes in
the line before the call and the options carry only the choices:

> Mid-period policy change. I'd suggest recomputing the whole period, since a
> manager seeing two rules inside one period is the harder thing to explain,
> but it can move totals someone already approved, so it is your call.
>
> *[Recompute the period · Forward-only · Not sure]*

## Three kinds of question

**Fixed options**: the answer set is already known. Yes/no, either/or, which
work type, which roles, which rollout shape.

**Generated options**: the answer set is not fixed anywhere, but two or three
plausible answers follow from what was just read. The likely values of a
dropdown seen in the design, the probable default of a toggle, candidate edge
cases for this feature, the teams that plausibly need to know.

**Text**: no option set can hold the answer honestly. The problem itself, a
rule nothing read suggests, a number, a date, a correction to the summary. Ask
for prose and mean it.

## Generating options from evidence

Options come from something read or something the user already said, never
from invention. Say where they came from in the line before the call, because
an option the user cannot trace is one they cannot correct:

> The design shows a "Period" dropdown with no values listed. From the screens
> around it these look like the candidates:

If nothing read suggests candidates, the question is a text question;
producing plausible-looking values from nowhere is worse than asking, because a
wrong option set gets tapped.

Two guardrails. Never generate options for how the system behaves today; that
is the guessing this skill exists to prevent, and it belongs in Open Questions.
And never generate options for a rule the user has not stated; a tapped guess
reads exactly like a confirmed rule.

## The escape

Every question carries a way out: **Other**, **None of these**, or **Not sure**,
chosen to fit the question. Where the host adds its own free-text escape, the
options still name "Not sure" explicitly when a non-answer is a plausible
outcome, because a tapped "Not sure" is a recorded answer the PRD can carry as
an `OQ-n` row.

**"None of these apply" is an answer.** The user considered the set and ruled it
out. Record it as what it is: the concern is `N/A` with that as its reason, the
edge case is out of scope. Say so in the line before the call whenever that
reading is the intended one.

**"No preference", "Not sure", and an empty return whose intent is unknown are
non-answers.** Nothing was decided, so nothing can be written. A non-answer
triggers **one re-ask**, narrower than the first, with concrete candidates
drawn from the design, the docs, or something the user already said. If the
re-ask also comes back empty, the item goes to Open Questions with what it
affects and who can settle it, and nothing goes into the body.

## What a tapped option is and is not

A tapped option is an answer the user gave. It is not a fact this skill
verified. Anything selected that concerns how the system behaves today keeps
the treatment it always has: an inline `[unverified]` marker with an `OQ-n` row
for Engineering, or it stays out of the acceptance criteria. Tapping is a
faster way to say something, not a stronger one.

## Question-by-question

| Question | How |
|---|---|
| Which work type (feature, bug, rule change, spike) | Fixed |
| Single PRD or epic with child issues | Fixed; a single PRD means one story |
| Summary correct | Fixed, with a text follow-up when something is wrong |
| Approve the draft | Fixed, and only a fresh explicit reply counts |
| What problem, for whom | Text |
| Which roles are the primary users | Fixed, several allowed |
| Who is this explicitly not for | Generated from the roles chosen |
| A control's exact values, default, unconfigured state | Generated from the design |
| What it does today, where this changes something shipping | Text, carrying `[unverified]` |
| What it does instead | Text, asked in the same breath; the pair is the delta |
| The rule itself, with nothing read suggesting it | Text |
| Which candidate edge cases to keep | Generated, several allowed, plus "None of these" |
| Profile-listed concerns | Fixed, several allowed, one call per group with its own context line |
| Why a concern is N/A | Text, about the feature, not about the interview |
| Rollout dimensions | Fixed, one yes/no per dimension |
| Which risks apply | Generated, plus "None of these"; an empty return gets one re-ask |
| A target number, baseline, or date | Text |
| Anything about how the system behaves today | Text, then Open Questions; options here would be guessing |

## Worked calls

**Work type.** One line, then the options:

> Before anything else, what kind of work is this? It changes what else I need.
>
> *[Feature · Bug · Spike]* (plus: Something else)

**A profile concern group.** Each call carries its own context line, what that
group covers and what ticking an item produces, so the user can tell the rounds
apart. The first call says how many are coming.

> **Call 1 of 2: where the data goes.** Ticking a row here produces one line in
> the concerns table.
>
> *[Reports · Exports · Integrations]* (plus: None of these · Not sure)

**A generated-options question.** What was read comes first, then the options:

> The list has a "Status" filter but the dropdown is collapsed in every screen,
> and the ticket mentions "supervisors clearing exceptions". From the states the
> product already uses, these look like the candidates:
>
> *[Pending · Invalid · Missing]* (plus: Not sure, I'll ask engineering)
