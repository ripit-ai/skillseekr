---
name: postgres-migration-review
description: Review a PostgreSQL schema migration for locking, downtime and rollback risk before it ships. Use for ALTER TABLE, index creation and backfill changes on large tables.
---
# Review Postgres migrations

Check for ACCESS EXCLUSIVE locks, use CONCURRENTLY for indexes, split backfills into batches, and require a tested down migration.
