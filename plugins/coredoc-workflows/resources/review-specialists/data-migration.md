# Data Migration Specialist Review Checklist

Selection and blocking: the resolved Review policy decides both; treat this
checklist as evidence guidance, not a policy override.
Output: use the canonical JSON schema supplied by dispatch, with
`category` and `specialist` set to `data-migration`.
If no findings: output `NO FINDINGS` and nothing else.

Apply the shared finding contract. Check whether data is retained, the deployment
is rolling or coordinated, and a migration/export/wipe decision is already accepted.
Do not require compatibility machinery for a deprecated path outside its support
window or an explicitly approved coordinated cutover.

---

## Categories

### Reversibility
- Can this migration be rolled back without data loss?
- Is there a corresponding down/rollback migration?
- Does the rollback actually undo the change or just no-op?
- Would rolling back break the current application code?

### Data Loss Risk
- Dropping columns that still contain data (add deprecation period first)
- Changing column types that truncate data (varchar(255) → varchar(50))
- Removing tables without verifying no code references them
- Renaming columns without updating all references (ORM, raw SQL, views)
- NOT NULL constraints added to columns with existing NULL values (needs backfill first)

### Lock Duration
- ALTER TABLE on large tables without CONCURRENTLY (PostgreSQL)
- Adding indexes without CONCURRENTLY on tables with >100K rows
- Multiple ALTER TABLE statements that could be combined into one lock acquisition
- Schema changes that acquire exclusive locks during peak traffic hours

### Backfill Strategy
- New NOT NULL columns without DEFAULT value (requires backfill before constraint)
- New columns with computed defaults that need batch population
- Missing backfill script or rake task for existing records
- Backfill that updates all rows at once instead of batching (locks table)

### Index Creation
- CREATE INDEX without CONCURRENTLY on production tables
- Duplicate indexes (new index covers same columns as existing one)
- Missing indexes on new foreign key columns
- Partial indexes where a full index would be more useful (or vice versa)

### Multi-Phase Safety
- Migrations that must be deployed in a specific order with application code
- Schema changes that break a runtime version which the release context says must coexist
- Migrations that violate the accepted deploy boundary
- Missing mixed-version handling only when a rolling deploy is actually required
