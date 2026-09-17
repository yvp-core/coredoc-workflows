---
type: regex
target: {source: file, path: docs/prd/export-scheduling.md}
match: contains
flags: m
---
^\|\s*D-1\s*\|[^|\n]+\|[^|\n]{4,}\|\s*PM\s*\|[\s\S]*^\|\s*D-2\s*\|[^|\n]+\|[^|\n]{4,}\|\s*PM\s*\|[\s\S]*^\|\s*D-3\s*\|[^|\n]+\|[^|\n]{4,}\|\s*PM\s*\|
