---
type: regex
target: {source: file, path: docs/prd/export-scheduling.md}
match: contains
flags: im
---
(CSV[^\n]*\[unverified\]|\[unverified\][^\n]*CSV)[\s\S]*^\|\s*OQ-\d+\s*\|[^\n]*CSV[^\n]*\|\s*Engineering\s*\|
