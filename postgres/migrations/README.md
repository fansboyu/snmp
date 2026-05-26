# Database migrations

This directory stores incremental SQL migrations that run after the baseline schema.

File naming:

```text
002_short_description.sql
003_next_change.sql
```

Version `001` is reserved for the current `postgres/schema.sql` baseline.

Guidelines:

- Keep each migration focused on one schema or seed-data change.
- Prefer additive changes such as `create table if not exists`, `alter table ... add column if not exists`, and `create index if not exists`.
- Avoid deleting or overwriting customer data.
- Use conflict-safe inserts for built-in templates, metrics, and rules.
