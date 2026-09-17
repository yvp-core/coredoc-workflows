---
type: regex
target: {source: file, path: docs/prd/export-scheduling.md}
match: contains
flags: im
---
^\|\s*EC-\d+\s*\|[^\n]*zero rows[^\n]*\|[^\n]*(skip|not sent|nothing is sent|send nothing|nothing to|no export|no send)[^\n]*notif[^\n]*\|[\s\S]*^\|\s*EC-\d+\s*\|[^\n]*(empty|no recipient)[^\n]*\|[^\n]*(skip|not sent|nothing is sent|send nothing|nothing to|no export|no send)[^\n]*notif[^\n]*\||^\|\s*EC-\d+\s*\|[^\n]*(empty|no recipient)[^\n]*\|[^\n]*(skip|not sent|nothing is sent|send nothing|nothing to|no export|no send)[^\n]*notif[^\n]*\|[\s\S]*^\|\s*EC-\d+\s*\|[^\n]*zero rows[^\n]*\|[^\n]*(skip|not sent|nothing is sent|send nothing|nothing to|no export|no send)[^\n]*notif[^\n]*\|
