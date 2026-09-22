## Evidence applicability

Use graph reads for structural questions in the repositories they cover. Check
the reported revision and coverage before applying results to a branch or fork.
For unindexed repositories, denied/unavailable tools, nonstructural edits, or
missing host observations, use source and executed checks and record a truthful
`--skip-mcp "<reason>"` at stage close when the read gate applies. Keep the reason
specific to the missing evidence and replacement check. Do not call an unrelated
repository merely to satisfy the gate or label a denied read as successful.
Intent applicability is separate: refresh applicable accepted rules, or record
`--skip-intent "<reason>"` when that required evidence is unavailable.

Across repositories, verify the producer, proxy and consumer contracts in each
checkout, recording their revisions. A stale ticket or graph snapshot cannot
overrule the current source. Distinguish implemented behavior from deployed
behavior; name any runtime or integration access still missing.

