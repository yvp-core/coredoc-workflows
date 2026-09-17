# coredoc-prd — a guide for product owners

*This page is for people. Claude follows `SKILL.md`; this explains what to
expect.*

## What it does

You talk. It asks. You get a draft PRD written to your repository's documented
PRD location, and your fresh explicit reply is what marks it approved.

The skill interviews you about a feature, a bug, a rule change, or a spike;
writes the draft where you can read and correct it; and only on your explicit
approval marks it approved or sends it anywhere external. It records what it
could not verify instead of
guessing: anything you tell it about how the system behaves today is marked
`[unverified]` and becomes a question for engineering. The engineering
specification that follows (`coredoc-spec`) cites the PRD's rows by id, checks
those claims against the code, and answers those questions.

## What it will not do

Estimate, size, prioritise, sequence, or assign; decide a calculation rule;
answer an engineering question; state current behaviour as fact; mark a PRD
approved or send it externally before you say so. Ask for one of these and it
says so once, offers the alternative, and moves on.

## Starting

```
Write a PRD for bulk approval of pending items. Supervisors lose an hour at
period close approving them one at a time. Not changing which items need
approval, just doing them in bulk.
```

The problem in your own words, who it is for, one sentence about what is out,
and a link to the design or ticket are the four highest-value things to
include. Everything you give up front is something it does not have to ask.

## PRD profile (optional)

A repository can tailor the interview by naming a profile under a
`## PRD profile` heading in its agent instructions. No profile is the normal
case. A profile is a Markdown file made of these sections and no others, each
under its fixed heading; any section may be left out.

| Heading | What it supplies |
|---|---|
| `## Vocabulary` | The product's terms, and the generic words they replace. The PRD is written in them. |
| `## Question groups` | Interview groups added to the batched round, asked and dropped like the built-in groups; each a `### ` heading with its questions. |
| `## Cross-cutting concerns` | One row per concern: its label and the question it asks. The PRD's concerns table carries exactly these rows. |
| `## Sign-off zones` | Zones the user rules on rather than getting a filled-in guess. The guardrail (what must not move) is always one of them. |
| `## Destination` | The adapter's name, what it does before the interview (what it reads), and what it does after approval (where it writes). The adapter is the downstream plugin's, not this skill's, and waits for the fresh explicit reply. |
| `## Template additions` | Extra PRD sections with their rules, appended after Open questions in the profile's order. An addition covering release or communication stands in for the template's Release and communication notes. |

A profile never changes the row ids, the claim provenance (`[unverified]` with
an `OQ-n` for Engineering), the approval gate, or the mapping of rows to intent
kinds: those are the PRD and specification contract, and the profile sits
beside it. A downstream plugin may inline a profile into its generated skill at
build time instead of naming a file; the sections and their meaning are the
same.

```markdown
<!-- resources/prd-profiles/example.md — every section is optional -->
# PRD profile: example product

## Vocabulary
Use "punch", "pay policy", "worked hours"; never "record" or "settings".

## Question groups
### C. Domain specifics
- Whose timezone decides the day an event belongs to?
- Which period does it operate on, and what happens after close?

## Cross-cutting concerns
| Concern | The question it asks |
|---|---|
| Reports & dashboards | Which report or dashboard shows a value this changes? |
| Exports | Does an export carry a field whose meaning changes? |
| Permissions | Which roles see the entry point, and what do the others see? |

## Sign-off zones
Computed hours · Pay-policy behaviour · The guardrail: what must not move

## Destination
adapter: jira
Before the interview: read the ticket, its links and comments.
After approval: write the PRD into the issue description; read it back.

## Template additions
### Entry point
Where the user reaches this, and which role sees it.
```
