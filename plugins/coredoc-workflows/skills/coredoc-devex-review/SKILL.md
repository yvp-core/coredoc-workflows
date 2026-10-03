---
name: coredoc-devex-review
description: Audit the developer experience of a CLI, SDK, API, plugin, or config surface from a cold install. Use for a DX audit or when asked how a developer-facing surface feels to adopt.
---

# Live developer-experience audit

This audit is **read-only**: it installs, runs, and reads, but it does not fix,
commit, push, open issues, or publish what it finds. Fixing is a separate,
separately authorized request.

Resolve the plugin root as two directories above this file and read
`<plugin-root>/resources/methodology/dx-framework.md` for the principles,
scoring calibration, and time-to-hello-world tiers.

## Judge from cold

Score every pass on what someone arriving without your context experiences, not
on what you know is possible. Install into a scratch directory, not the user's
configured repository, and clean it up afterwards. If the surface is already
installed and cannot be isolated, say so and mark the affected passes estimated.

## Step 0 — Scope the target

Name exactly what is under audit (CLI, package, endpoints, config file), its
version, and where it came from. Audit each surface separately; a blended score
hides which one is the problem.

## Step 1 — Getting started, measured

Start a timer, follow the documented path from nothing to a first working
result, and record each step: what the developer does, elapsed time, friction
(low/med/high), and evidence (command output, screenshot, or file:line). Report
the measured time to hello world against the framework's tiers; label a time
estimated from the README as an estimate.

## Step 2 — Ergonomics of the surface

Use the API, CLI, or SDK for a realistic task, not the hello world. Judge naming,
argument shape, defaults, discoverability (`--help`, completion, type hints), and
progressive disclosure.

## Step 3 — Errors

Trigger real failures on purpose: missing arguments, invalid flags, bad input,
wrong credentials, a missing prerequisite. Judge whether each error names the
problem, the cause, and the fix.

## Step 4 — Documentation

Check whether the docs answer questions in the order a developer hits them,
whether examples run in real context, and whether search or navigation leads
from a symptom to an answer. Every place the docs and actual behavior disagree
is a defect, not a doc gap.

## Step 5 — Upgrade path

Look for changelogs, migration notes, deprecation warnings, and whether breaking
changes are visible before they break something.

## Step 6 — Environment and ecosystem

Installation prerequisites, platform coverage, what happens on a machine without
the usual toolchain, and whether help exists where a stuck developer would look.

## Step 7 — Compare against a baseline, when one exists

If the user has a baseline from an earlier audit, load it and report the delta
per pass before the scorecard, with the baseline's date and version. A pass
estimated on one side and measured on the other gets no delta; mark it.

Write a baseline only when the user asks to start tracking: as JSON at the path
they name (a committed repository path, or `~/.coredoc/state/` for a personal
measurement), keyed to the surface and stamped with date and version, never in
the disposable workflow cache.

## Step 8 — Scorecard

| Pass | Score | Evidence | What a 10 looks like here |
|---|---|---|---|

One row per pass; the last column is the framework's gap sentence for this
surface. Close with the two or three changes that would remove the most
friction, ranked by friction removed rather than by ease.

## Boundaries

- Report findings in the conversation; save a report only when the user asks,
  where they say.
