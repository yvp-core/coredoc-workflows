---
name: coredoc-devex-review
description: Audit the live developer experience of a CLI, SDK, API, plugin, or config surface — install cold, measure time to hello world, and score getting started, ergonomics, errors, docs, and upgrade path against evidence. Use for a DX audit or when asked how a developer-facing surface feels to adopt.
---

# Live developer-experience audit

Apply repository rules and stay inside the user's authorization boundary. This
audit is **read-only**: it installs, runs, and reads, but it does not fix what it
finds. Fixing is a separate, separately authorized request.

Resolve the plugin root as two directories above this file and read
`<plugin-root>/resources/methodology/dx-framework.md`. That is the lens — first
principles, the seven characteristics, the 0-10 scoring calibration, and the time
to hello world tiers. This file is the procedure.

## The one rule that decides whether the audit is worth anything

**Judge from cold.** The failure mode of a DX audit is grading a surface you
already know how to use. Every pass below is scored on what someone arriving
without your context experiences — not on what you know is possible.

Work in a scratch directory, not the user's configured repository, whenever the
surface can be installed. If you cannot get cold — the tool is already installed
and cannot be isolated — say so and mark the affected passes as estimated rather
than measured.

## Step 0 — Scope the target

Name exactly what is under audit: which CLI, which package, which endpoints,
which config file. State the version and where it came from. If more than one
surface is in scope, audit them separately; a blended score hides which one is
the problem.

## Step 1 — Getting started, measured

Do it. Start a timer, follow the documented path from nothing to a first working
result, and record each step as you take it:

```
Step  What the developer does          Time    Friction   Evidence
1     [action]                         [mm:ss] low/med/hi [command output / screenshot / file:line]
...
TOTAL [N steps, M minutes]
```

Report the measured time to hello world against the framework's tiers. A time
you estimated from reading the README is not a measurement — label it as an
estimate if that is what it is.

## Step 2 — Ergonomics of the surface

Use the API, CLI, or SDK for a realistic task, not the hello world. Judge naming,
argument shape, defaults, discoverability (`--help`, completion, type hints), and
whether the simple case stays simple while the complex case remains reachable
through the same surface.

## Step 3 — Errors

Trigger real failures on purpose: missing arguments, invalid flags, bad input,
wrong credentials, a missing prerequisite. For each, judge the three things an
error owes the reader — the problem, the cause, and the fix. An error that
reports only the problem is the most common and most expensive failure here.

## Step 4 — Documentation

Check whether the docs answer the questions in the order a developer hits them,
whether examples are runnable in real context rather than toy snippets, and
whether search or navigation gets someone from a symptom to an answer. Note every
place the docs and the actual behavior disagree — that is a defect, not a doc gap.

## Step 5 — Upgrade path

Look for changelogs, migration notes, deprecation warnings, and whether breaking
changes are visible before they break something. Upgrades should be boring.

## Step 6 — Environment and ecosystem

Installation prerequisites, platform coverage, what happens on a machine without
the usual toolchain, and whether help exists where a stuck developer would look.

## Step 7 — Compare against a baseline, when one exists

A single scorecard is a snapshot. The question worth answering is whether the
experience got better, so if the user has a baseline from an earlier audit, load
it and report the delta per pass before the scorecard itself.

```
Pass                    Baseline   Now    Delta
Getting started         6          8      +2
Time to hello world     8m10s      1m30s  -6m40s
Errors                  4          4      —
```

Two honest-reporting rules:

- **State the baseline's age and what it measured.** A comparison against a
  six-month-old run of a different version is not a trend, and a delta printed
  without its date invites the wrong conclusion.
- **A pass that was estimated rather than measured cannot be compared to one that
  was measured.** Mark it and leave the delta empty rather than producing a
  number that looks real.

When the user asks to start tracking, write the baseline as JSON to the path they
name. Two placements are sensible, and the choice is theirs:

- **A repository path, committed** — usually right. It makes a regression visible
  in review the way a performance baseline does, and it survives a new machine.
- **`~/.coredoc/state/`** — when the measurement is personal rather than a
  project fact. Machine-local, and it does not travel.

Key it to the surface audited and stamp it with the date and version:

```json
{
  "surface": "coredoc CLI",
  "version": "1.1.0",
  "measuredAt": "YYYY-MM-DD",
  "timeToHelloWorldSeconds": 90,
  "passes": { "gettingStarted": 8, "ergonomics": 7, "errors": 4 }
}
```

Do not write this on your own initiative, and never put it in the workflow cache.
That directory is disposable by design and the operating system may clear it,
which is precisely wrong for the one artifact whose entire value is longitudinal.

## Step 8 — Scorecard

One row per pass, each with a score, the evidence behind it, and — per the
framework's gap method — one sentence on what a 10 would look like *for this
surface specifically*. A score without that sentence is a number nobody can act
on.

| Pass | Score | Evidence | What a 10 looks like here |
|---|---|---|---|

Close with the two or three changes that would move the most, ranked by the
friction they remove rather than by how easy they are.

## Boundaries

- Read-only. Do not fix, commit, push, open issues, or publish findings anywhere.
- Report findings in the conversation by default. If the user requested an
  artifact, save it to their path or `$COREDOC_WORKFLOW_CACHE/devex-reports/`,
  matching the convention the QA workflows use. Never write a report into a
  repository-local history tree.
- Do not write a baseline or a run log on your own initiative. A scorecard is
  most useful as a trend, so when the user asks to track one, say plainly that
  the comparison needs a saved artifact and let them decide — an audit that
  quietly starts accumulating state is the thing this plugin does not do.
- Use `coredoc-browse` or a host browser controller for a docs site or web
  console, and `coredoc-desktop` for the Electron surface. A CLI audit needs no
  browser.
- Anything you install to get cold belongs in a scratch directory and gets
  cleaned up.
