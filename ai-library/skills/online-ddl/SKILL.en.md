---
name: online-ddl
description: Online techniques for schema changes on large tables (INSTANT / INPLACE, gh-ost, pt-osc, CONCURRENTLY, ONLINE).
dbkit-title: Online DDL
---
Always evaluate an online approach for schema changes on large tables:
- MySQL 8: first check whether ALGORITHM=INSTANT (adding a column at the end, changing a default) or ALGORITHM=INPLACE, LOCK=NONE is possible; otherwise use gh-ost or pt-online-schema-change.
- PostgreSQL: build indexes with CREATE INDEX CONCURRENTLY; to add NOT NULL, first ADD CONSTRAINT … CHECK … NOT VALID and then VALIDATE CONSTRAINT; before PG 11, ADD COLUMN with a default rewrites the whole table.
- SQL Server: add ONLINE = ON where available, or build in batches.
- Oracle: the ONLINE option or DBMS_REDEFINITION.
State the expected duration, the kind of lock and how long it is held, the impact on replication lag, and how to recover if it fails halfway.
