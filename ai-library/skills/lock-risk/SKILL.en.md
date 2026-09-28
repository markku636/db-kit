---
name: lock-risk
description: Assess statement by statement which locks are taken, for how long and what they block, and how to reduce contention.
dbkit-title: Lock and concurrency risk
---
Assess locking statement by statement: which lock is taken (row, gap, table, metadata lock), how long it is likely held, and which reads and writes it blocks. Watch in particular for UPDATE / DELETE with no usable index locking a wide range, long transactions, DDL on hot tables, and the extra locks taken by foreign key checks and triggers. Give ways to reduce contention (batching, selecting primary keys first and updating by key, changing the time window).
