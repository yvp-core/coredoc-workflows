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
case. A profile is a Markdown file such as:

```markdown
<!-- resources/prd-profiles/example.md — everything below is optional -->
# PRD profile: example product

## Vocabulary
Use "punch", "pay policy", "worked hours"; never "record" or "settings".

## Question groups
### C. Domain specifics
- Whose timezone decides the day an event belongs to?
- Which period does it operate on, and what happens after close?

## Cross-cutting concerns
Reports & dashboards · Exports · Mobile · Permissions · Performance

## Sign-off zones
Anything touching computed hours or pay-policy behaviour.

## Destination
adapter: jira   # handled by a downstream plugin, not by coredoc-prd
```
