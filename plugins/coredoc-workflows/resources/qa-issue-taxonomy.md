# QA issue taxonomy

## Severity levels

| Severity | Definition | Examples |
|----------|------------|----------|
| **critical** | Blocks a core workflow, causes data loss, or crashes the app | Form submit causes error page, checkout flow broken, data deleted without confirmation |
| **high** | Major feature broken or unusable, no workaround | Search returns wrong results, file upload silently fails, auth redirect loop |
| **medium** | Feature works but with noticeable problems, workaround exists | Slow page load (>5s), form validation missing but submit still works, layout broken on mobile only |
| **low** | Minor cosmetic or polish issue | Typo in footer, 1px alignment issue, hover state inconsistent |

## Categories

1. **Visual/UI:** layout breaks, broken images, z-index, font or color inconsistency, animation glitches, misalignment, theme issues.
2. **Functional:** broken links, dead buttons, missing or bypassed validation, wrong redirects, state lost on refresh or back, double-submit or stale data, wrong search results.
3. **UX:** confusing navigation or dead ends, missing loading indicators, interactions over 500 ms without feedback, errors with no recovery path, no confirmation before destructive actions, inconsistent patterns.
4. **Content:** typos, outdated or wrong text, placeholder text, truncation, wrong labels, unhelpful empty states.
5. **Performance:** page loads over three seconds, jank, layout shifts, over 50 requests on a page, large unoptimized images, blocking JavaScript.
6. **Console/errors:** uncaught exceptions, failed 4xx/5xx requests, deprecation warnings, CORS errors, mixed content, CSP violations.
7. **Accessibility:** missing alt text, unlabeled inputs, broken keyboard navigation, focus traps, wrong ARIA, low contrast, content unreachable by screen reader.

## Per-page exploration checklist

For each page visited during a QA session:

1. **Visual scan** — Take an annotated screenshot. Look for layout issues,
   broken images, and alignment problems.
2. **Interactive elements** — Click every relevant button, link, and control.
   Verify each does what its label promises.
3. **Forms** — Fill and submit. Test empty submission, invalid data, long text,
   and representative special characters.
4. **Navigation** — Check paths in and out, breadcrumbs, back navigation, deep
   links, and the mobile menu.
5. **States** — Check empty, loading, error, full, and overflow states.
6. **Console** — Check errors after interactions and correlate failed requests
   with visible behavior.
7. **Responsiveness** — When relevant, check mobile and tablet viewports.
8. **Auth boundaries** — Verify logged-out behavior and relevant role
   differences without crossing the user's authorization boundary.

## Evidence and privacy

For each issue record the exact starting URL and preconditions, minimal
reproduction, expected and actual behavior, severity, category, smallest useful
screenshot, relevant console or network evidence, and re-verification after an
authorized fix.

Do not include credentials, full page dumps, prompts, unrelated source, or
workflow-history fields.
