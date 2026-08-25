# QA report: {APP_NAME}

| Field | Value |
|-------|-------|
| **Date** | {DATE} |
| **URL** | {URL} |
| **Branch** | {BRANCH} |
| **Commit** | {COMMIT_SHA} |
| **Tier** | Quick / Standard / Exhaustive |
| **Scope** | {SCOPE or "Full app"} |
| **Duration** | {DURATION} |
| **Pages visited** | {COUNT} |
| **Screenshots** | {COUNT} |
| **Framework** | {DETECTED or "Unknown"} |

## Health score: {SCORE}/100

| Category | Score |
|----------|-------|
| Console | {0-100} |
| Links | {0-100} |
| Visual | {0-100} |
| Functional | {0-100} |
| UX | {0-100} |
| Performance | {0-100} |
| Content | {0-100} |
| Accessibility | {0-100} |

## Top three things to fix

1. **{ISSUE-NNN}: {title}** — {one-line description}
2. **{ISSUE-NNN}: {title}** — {one-line description}
3. **{ISSUE-NNN}: {title}** — {one-line description}

## Console health

| Error | Count | First seen |
|-------|-------|------------|
| {redacted error summary} | {N} | {URL} |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

## Issues

### ISSUE-001: {Short title}

| Field | Value |
|-------|-------|
| **Severity** | critical / high / medium / low |
| **Category** | visual / functional / ux / content / performance / console / accessibility |
| **URL** | {page URL} |

**Description:** {Expected behavior, actual behavior, and user impact.}

**Reproduction:**

1. Navigate to {URL}.
   ![Step 1](screenshots/issue-001-step-1.png)
2. {Action}.
   ![Step 2](screenshots/issue-001-step-2.png)
3. **Observe:** {what goes wrong}.
   ![Result](screenshots/issue-001-result.png)

**Evidence:** {Relevant redacted console/network details and snapshot delta.}

## Authorized fixes

| Issue | Status | Files changed | Verification |
|-------|--------|---------------|--------------|
| ISSUE-NNN | verified / regressed / deferred | {files} | {commands and result} |

### Before/after evidence

#### ISSUE-NNN: {title}

**Before:** ![Before](screenshots/issue-NNN-before.png)
**After:** ![After](screenshots/issue-NNN-after.png)

## Regression tests

| Issue | Test file | Status | Description |
|-------|-----------|--------|-------------|
| ISSUE-NNN | path/to/test | passed / failed / deferred | description |

## Readiness

| Metric | Value |
|--------|-------|
| Health score | {before} → {after} ({delta}) |
| Issues found | N |
| Authorized fixes applied | N |
| Unresolved | N |

## Regression comparison

| Metric | Baseline | Current | Delta |
|--------|----------|---------|-------|
| Health score | {N} | {N} | {+/-N} |
| Issues | {N} | {N} | {+/-N} |

**Fixed since baseline:** {list}
**New since baseline:** {list}

Do not include credentials, full page dumps, prompts, unrelated source, or
workflow history.
