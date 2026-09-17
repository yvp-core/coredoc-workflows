# Evals: `coredoc-spec`

Eight cases for the `coredoc-spec` skill, run with the Claude Code plugin eval runner. Six
cases expect the skill to fire (a PRD-grounded spec, a small flag removal, two vague
requests that must come back as questions for the PRD, a spec written to a named file, a
confirmed bug ticket); two expect it not to fire (a vocabulary question, a direct code fix).

## Run

From `plugins/coredoc-workflows`:

```
claude plugin eval . --ablation with-without --judge-model sonnet --allow-tools Write -j 3 --no-publish
```

Every case runs three times with the plugin and three times without. The headline number is
Δ: the with-plugin score minus the without-plugin score. A run costs about $13 and takes
15–20 minutes. Results land in `results/<timestamp>/` (ignored by git).

- Do not grant `Bash`: the runner refuses a Bash-granting eval on a machine whose Docker
  credential store contains symlinks, and no grader needs it.
- `--case '<prefix>-*'` runs one case; the flag takes a single plain glob.
- The judge must not be the agent model. Sonnet is the default judge here because the agent
  runs on Opus.

## Reading the result

- Regex graders carry the verifiable checks (ids, sections, counts, files). LLM graders judge
  only what a regex cannot. If a case scores 0 in both arms, read the trace before blaming
  the skill: an under-set tool grant or timeout reads the same way.
- The `trigger-check` grader is display-only. It shows whether the skill was invoked. On an
  unchanged description the pooled trigger rate across all fire cases varied between 8 and
  13 of 18 over six full runs, so a per-case trigger difference at three runs is noise.
- The prompts are synthetic: the sandbox has no repository, so each prompt carries its own
  "current state" facts and the skill's grounding step finds nothing. Real repositories will
  show richer behaviour, not less.

## History

Baseline on 0.12.1: mean Δ 0.07, skill fired 6 of 18 runs. After the description and body
revisions on this branch (commits 35d1fe4, 7ca3ad5, 7e8b979): with-plugin scores of 0.82–1.00
on fired runs for the explicit cases and Δ between +0.13 and +0.70. Case 05 (webhook retries)
remains the weakest because the skill fires there least often.

Edit graders and skills in separate commits; a grader change invalidates comparison with
earlier results for that case.
