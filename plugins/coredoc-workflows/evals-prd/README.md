# Evals: `coredoc-prd`

Seven cases for the `coredoc-prd` skill. Five expect it to fire (a vague feature request
that must be interviewed, a decided brief drafted on request, a bug PRD, a PRD written to a
named file, a revision that must keep row ids stable); two expect it not to fire (an
engineering trade-off question, a three-bullet summary of an existing PRD).

## Run

From `plugins/coredoc-workflows`:

```
claude plugin eval . --eval-dir evals-prd --ablation with-without --judge-model sonnet --allow-tools Write -j 3 --no-publish
```

Three runs per case and arm; Δ is the headline. About $11 and 13 minutes per run. Results
land in `results/<timestamp>/` (ignored by git). The same rules as in `../evals/README.md`
apply: no `Bash` grant, one plain glob per `--case`, Sonnet judge.

## What the graders encode

They follow `resources/methodology/prd-spec-contract.md`: stable row ids (`G-n D-n US-n
EC-n NG-n OQ-n`), `[unverified]` on relayed claims with an Engineering `OQ`, decisions with
the alternative weighed and who decided, no engineering answers on engineering's behalf,
and proportionality (at most seven non-goals and eight open questions from a short brief).
Prompts that say "draft it now" exist because the method runs one interview round by
default, which a non-interactive run cannot answer; case 01 tests that round itself.

## History

First pilot on 54c8bd6 produced correct but inflated PRDs (10 non-goals, 15 open questions
from a 12-line brief). After the proportionality rules in 7ca3ad5 and 7e8b979: fired runs
score 0.83–1.00, without-plugin 0.11–0.71, Δ between +0.29 and +0.89; the skill fired in
every run of the last two full suites except one case once.
