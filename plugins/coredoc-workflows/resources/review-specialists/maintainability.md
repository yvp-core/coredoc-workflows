# Maintainability Specialist Review Checklist

Selection: only for an accepted refactor or demonstrated synchronized-edit risk.
Output: use the canonical JSON schema supplied by dispatch, with
`category` and `specialist` set to `maintainability`.
If no findings: output `NO FINDINGS` and nothing else.

Apply the shared finding contract and resolved Review policy. A pure refactor or
preference is P3; demonstrated current divergence takes the severity of its
observable impact. Apply the repository's Rule of Three and search for an
existing implementation before proposing a helper or abstraction. Small local
duplication is preferable when it preserves clarity.

---

## Categories

### Dead Code & Unused Imports
- Variables assigned but never read in the changed files
- Functions/methods defined but never called (check with Grep across the repo)
- Imports/requires that are no longer referenced after the change
- Commented-out code blocks (either remove or explain why they exist)

### Magic Numbers & String Coupling
- Domain values repeated across current consumers that require synchronized edits
- Error message strings used as query filters or conditionals elsewhere
- Hardcoded URLs, ports, or hostnames that should be config
- Duplicated literal values across multiple files

### Stale Comments & Docstrings
- Comments that describe old behavior after the code was changed in this diff
- TODO/FIXME comments that reference completed work
- Docstrings with parameter lists that don't match the current function signature
- ASCII diagrams in comments that no longer match the code flow

### DRY Violations
- Three or more stable production implementations of the same invariant where the
  current change must edit multiple copies or evidence shows they already diverged
- A new fourth implementation when an existing authoritative implementation can be reused
- Do not extract test setup or short local branches solely to reduce line count

### Conditional Side Effects
- Code paths that branch on a condition but forget a side effect on one branch
- Log messages that claim an action happened but the action was conditionally skipped
- State transitions where one branch updates related records but the other doesn't
- Event emissions that only fire on the happy path, missing error/edge paths

### Module Boundary Violations
- Reaching into another module's internal implementation (accessing private-by-convention methods)
- Direct database queries in controllers/views that should go through a service/model
- Tight coupling between components that should communicate through interfaces
