# API Contract Specialist Review Checklist

Selection and blocking: the resolved Review policy decides both; treat this
checklist as evidence guidance, not a policy override.
Output: use the canonical JSON schema supplied by dispatch, with
`category` and `specialist` set to `api-contract`.
If no findings: output `NO FINDINGS` and nothing else.

Apply the shared finding contract. Verify a current consumer and compatibility
window; do not invent mobile, webhook, or versioned clients absent release context.

---

## Categories

### Breaking Changes
- Removed fields from response bodies (clients may depend on them)
- Changed field types (string → number, object → array)
- New required parameters added to existing endpoints
- Changed HTTP methods (GET → POST) or status codes (200 → 201)
- Renamed endpoints without maintaining the old path as a redirect/alias
- Changed authentication requirements (public → authenticated)

### Versioning Strategy
- Breaking changes made without a version bump (v1 → v2)
- Multiple versioning strategies mixed in the same API (URL vs header vs query param)
- Deprecated endpoints without a sunset timeline or migration guide
- Version-specific logic scattered across controllers instead of centralized

### Error Response Consistency
- New endpoints returning different error formats than existing ones
- Error responses missing standard fields (error code, message, details)
- HTTP status codes that don't match the error type (200 for errors, 500 for validation)
- Error messages that leak internal implementation details (stack traces, SQL)

### Rate Limiting & Pagination
- New endpoints missing rate limiting when similar endpoints have it
- Pagination changes (offset → cursor) without backwards compatibility
- Changed page sizes or default limits without documentation
- Missing total count or next-page indicators in paginated responses

### Documentation Drift
- OpenAPI/Swagger spec not updated to match new endpoints or changed params
- README or API docs describing old behavior after changes
- Example requests/responses that no longer work
- Missing documentation for new endpoints or changed parameters

### Backwards Compatibility
- Current clients inside the declared compatibility window: will they break?
- Mobile, webhook, SDK, or older-version compatibility only when release context
  proves that consumer exists and remains supported
