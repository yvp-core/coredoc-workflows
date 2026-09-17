---
type: regex
target: {source: file, path: docs/prd/export-scheduling.md}
match: contains
flags: im
---
^\|\s*EC-\d+\s*\|[^\n]*timezone[^\n]*\|[^\n]*(unresolved|open question|OQ-\d+)
