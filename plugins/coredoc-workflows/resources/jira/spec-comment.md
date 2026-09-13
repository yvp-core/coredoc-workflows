# Jira specification comment

Use this only as the body of an explicitly authorized Jira specification
comment. Accepting the specification does not authorize this comment. It is a bounded summary for the reporter and the
next reader of the issue, not a copy of the specification: the specification
stays in the repository, and this comment tells Jira what was decided and where
to read the rest. Do not copy the issue description back into it.

## Outcome

State the accepted outcome in one or two sentences, in the words of the
specification's title and outcome section.

## Scope and non-goals

Name the affected repository surfaces and the explicit non-goals. Keep each as
one line; the specification carries the detail.

## Acceptance criteria

List the acceptance criteria as they stand in the accepted specification, one
per line, without renumbering or paraphrasing them.

## Risks and open questions

State the residual risks and any question the specification left open. Write
`None` only when the specification says so.

## Where the spec lives

Give the repository-relative path of the specification file and the observed
branch name. Never give an absolute local path, a diff, or the file body. When
an updated acceptance replaces an earlier specification comment, say so in one
line so the reader knows which comment is current.
