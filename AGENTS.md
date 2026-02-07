# Agent Guidelines (Repo-Level)

## Database Safety
- Never run `db:push`, `drizzle-kit push`, `drizzle-kit generate`, or any command that applies schema changes to a database.
- Never run migrations against any database.
- Assume the database configured in env vars may be production.

**Exception:** Only run DB schema/apply commands if Julien explicitly requests it in the current conversation.

