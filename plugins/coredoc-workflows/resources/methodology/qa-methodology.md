## Modes

### Diff-aware (automatic when on a feature branch with no URL)

1. **Map the change to pages.** From the files and commits changed since the
   merge base with the base branch, and from the PR description, work out what
   the change should do and which pages, routes and API endpoints it reaches.
   Test API endpoints directly with `B js "await fetch('/api/...')"`.

   **If the diff maps to no page,** still test in the browser: backend, config
   and infrastructure changes affect the app, and unit tests or evals are not a
   substitute. Fall back to Quick mode and also test any interactive elements
   found.

2. **Detect the running app** — check common local dev ports, stopping at the first that loads:
   ```bash
   for port in 3000 4000 5173 8080; do
     B goto "http://localhost:$port" 2>/dev/null && { echo "Found app on :$port"; break; }
   done
   ```
   If no local app is found, check for a staging/preview URL in the PR or environment. If nothing works, ask the user for the URL.

3. **Test each affected page:** screenshot it, check the console, and exercise
   any changed interaction end to end, using `snapshot -D` before and after each
   action to confirm the change does what it should.

4. **Report** the pages tested, whether each works with screenshot evidence,
   and any regression on adjacent pages.

**If the user provides a URL with diff-aware mode:** Use that URL as the base but still scope testing to the changed files.

### Full (default when URL is provided)
Systematic exploration. Visit every reachable page. Document 5-10 well-evidenced issues. Produce health score.

### Quick (`--quick`)
Smoke test: only the homepage and the top 5 navigation targets from Orient. Skip the per-page checklist and check only: page loads? Console errors? Broken links? Produce health score. No detailed issue documentation.

### Regression (`--regression <baseline>`)
Run full mode, then load `baseline.json` from a previous run. Diff: which issues are fixed? Which are new? What's the score delta? Append regression section to report.

---

## Workflow

### Phase 1: Initialize

Note the start time. The conversation is the default issue register. Only when
the user requested saved evidence or a durable report, use
`<plugin-root>/resources/qa-report-template.md` and start the command below
with `REPORT_DIR=<dir>`: their path or a new directory under
`$COREDOC_WORKFLOW_CACHE/qa-reports/`, so earlier evidence is never
overwritten. Otherwise it uses a temporary evidence directory:

```bash
QA_EVIDENCE_DIR="${REPORT_DIR:-${TMPDIR:-/tmp}/coredoc-workflows-qa}"
mkdir -p "$QA_EVIDENCE_DIR/screenshots" && echo "$QA_EVIDENCE_DIR"
```

Each tool call starts a fresh shell: write the printed path in place of
`$QA_EVIDENCE_DIR` in later commands.

### Phase 2: Authenticate (if needed)

Reuse the selected surface's existing session. For Electron, run
`D auth-status`; if the app is logged out, activate its login control, hand
OAuth/MFA to the user, and resume with `D auth-status` and `D snapshot` after
the callback returns.

**For web only, if the user explicitly authorized entering credentials:**

```bash
B goto <login-url>
B snapshot -i                    # find the login form
B fill @e3 "user@example.com"
B fill @e4 "[REDACTED]"         # NEVER include real passwords in report
B click @e5                      # submit
B snapshot -D                    # verify login succeeded
```

**For web only, if the user explicitly provided a browser cookie-export file:**

```bash
B cookie-import cookies.json
B goto <target-url>
```

### Phase 3: Orient

Get a map of the application:

```bash
B goto <target-url>
B snapshot -i -a -o "$QA_EVIDENCE_DIR/screenshots/initial.png"
B links                          # map navigation structure
B console --errors               # any errors on landing?
```

**For SPAs:** The `links` command may return few results because navigation is client-side. Use `snapshot -i` to find nav elements (buttons, menu items) instead.

### Phase 4: Explore

Visit pages systematically. At each page:

```bash
B goto <page-url>
B snapshot -i -a -o "$QA_EVIDENCE_DIR/screenshots/page-name.png"
B console --errors
```

Then follow the **per-page exploration checklist** in
`<plugin-root>/resources/qa-issue-taxonomy.md`. For its responsiveness item:

```bash
B viewport 375x812
B screenshot "$QA_EVIDENCE_DIR/screenshots/page-mobile.png"
B viewport 1280x720
```

### Phase 5: Document

Retry each issue once to confirm it reproduces, then record it immediately in
the conversation issue register or, when requested, the saved report. Never
batch issues or reconstruct evidence from memory at the end.

**Interactive bugs** (broken flows, dead buttons, form failures): screenshot
before the action, perform it, screenshot the result, run `snapshot -D` to show
what changed, and write repro steps that reference the screenshots.

```bash
B screenshot "$QA_EVIDENCE_DIR/screenshots/issue-001-step-1.png"
B click @e5
B screenshot "$QA_EVIDENCE_DIR/screenshots/issue-001-result.png"
B snapshot -D
```

**Static bugs** (typos, layout issues, missing images): one annotated
screenshot showing the problem, and a description of what's wrong.

```bash
B snapshot -i -a -o "$QA_EVIDENCE_DIR/screenshots/issue-002.png"
```

### Phase 6: Wrap Up

Compute the health score with the rubric below. Then write the top three
issues to fix, a summary of console errors across pages, the severity counts,
and the report metadata (date, duration, pages visited, screenshot count). Save
`baseline.json`, in the shape at the end of
`<plugin-root>/resources/qa-report-template.md`, only in regression mode or when
the user requests a durable baseline.

---

## Health Score Rubric

Score each category from 0 to 100, then take the weighted average,
`score = Σ (category_score × weight)`:

- **Console (15%):** 0 errors → 100, 1-3 → 70, 4-10 → 40, 11 or more → 10.
- **Links (10%):** 100, minus 15 per broken link, minimum 0.
- **Functional (20%), UX (15%), Accessibility (15%), Visual (10%), Performance
  (10%), Content (5%):** start at 100 and deduct per finding: critical 25,
  high 15, medium 8, low 3. Minimum 0.

---

## Important Rules

- **Preserve the black-box perspective.** Read source only to map a diff to
  affected routes, verify a concrete finding, or implement an authorized fix.
- **Use `snapshot -C` for tricky UIs.** Finds clickable divs that the accessibility tree misses.
- **Show screenshots to the user.** Open every screenshot you capture with the
  host's file/image-viewing tool, and give the user its path.
