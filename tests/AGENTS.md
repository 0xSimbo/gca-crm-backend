# Tests Safety Guidelines (Non-Destructive Fixtures Only)

These tests may be executed with **production environment variables**. Treat the database as **real** unless a test explicitly provisions an isolated test DB.

## Hard Rules
- Never `DELETE`/`TRUNCATE` an entire table in tests.
- Never run unscoped deletes like `db.delete(table)` without a `where(...)`.
- Always clean up **only** the rows you inserted as fixtures.

## Fixture Strategy
- Prefer fixtures with unique, obviously-test-only identifiers:
  - Regions like `__test_region__`
  - Dates far in the future like `2999-01-01`
  - Week numbers far in the future like `9999`
- When possible, use primary keys that cannot collide with real data.

## Cleanup Strategy
- Delete by **primary key(s)** for the fixtures you inserted.
- If the table doesn’t have a single-column primary key:
  - Delete by the composite PK columns.
- Avoid deleting by broad predicates (e.g. “older than now”, “all rows for a week range”).

## Assertions
- Avoid assertions that require global emptiness (e.g. lifetime totals across the whole table).
- Prefer assertions that target your fixture keys (e.g. “find the row with region `__test_region__`”).

## Review Checklist
- Does this test mutate the DB?
- If yes: is every delete scoped to fixture keys only?
- Are the fixture keys clearly separated from production-like values?

