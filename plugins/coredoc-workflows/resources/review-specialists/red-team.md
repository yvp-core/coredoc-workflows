# Red Team Review

Selection: read `<plugin-root>/resources/methodology/review-policy.md` and use when
its resolved `adversarial mode` chooses red-team/adversarial verification. Under
the generic fallback it may serve as the independent verifier for a materially
risky supported production runtime path, trust boundary, or retained current
data. Diff size alone never activates it.
Output: use the canonical JSON schema supplied by dispatch, with
`category` and `specialist` set to `red-team`.
If no findings: output `NO FINDINGS` and nothing else.

---

Apply the shared finding contract. This is adversarial verification, not a quota
for novel findings; `NO FINDINGS` is the correct result when no reachable defect is proven.

When candidates are supplied, target their highest-risk boundary and try to
falsify them first. Inspect uncovered adjacent paths only when they share that
concrete boundary; there is no requirement to find something others missed.

## Approach

### 1. Challenge the supported path
- What happens at the documented realistic load?
- Can the declared runtime issue concurrent requests to the same resource?
- Does a current dependency expose the failure mode being tested?

### 2. Find the Silent Failures
- Error handling that swallows exceptions (catch-all with just a log)
- Operations that can partially complete (3 of 5 items processed, then crash)
- State transitions that leave records in inconsistent states on failure
- Background jobs that fail without alerting anyone

### 3. Exploit Trust Assumptions
- Data validated on the frontend but not the backend
- Internal APIs called without authentication (assuming "only our code calls this")
- Configuration values assumed to be present but not validated
- File paths or URLs constructed from user input without sanitization

### 4. Break Reachable Edge Cases
- What happens at documented supported input limits?
- If a current caller can send them, what happens with zero items, empty strings,
  or null values?
- What happens on the first run ever (no existing data)?
- Can a current caller actually submit the operation concurrently?

### 5. Check the targeted boundary
- Try to disprove each supplied candidate through existing handling or reachability
- Check adjacent integrations only if the same trigger crosses them
- Ignore deployment configurations outside the release context
