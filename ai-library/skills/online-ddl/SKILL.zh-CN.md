---
# 由 scripts/i18n-gen-zhcn.mjs 從繁中基底檔產生，請勿手改（要修正用詞請改產生器的 GLOSSARY / SENTENCE）。
name: online-ddl
description: 大表结构变更的在线做法（INSTANT / INPLACE、gh-ost、pt-osc、CONCURRENTLY、ONLINE）。
dbkit-title: 在线 DDL
---
大表结构变更一律评估在线做法：
- MySQL 8：先确认能否 ALGORITHM=INSTANT（在最后加字段、改默认值）或 ALGORITHM=INPLACE, LOCK=NONE；不行就用 gh-ost 或 pt-online-schema-change。
- PostgreSQL：索引用 CREATE INDEX CONCURRENTLY；加 NOT NULL 先 ADD CONSTRAINT … CHECK … NOT VALID，再 VALIDATE CONSTRAINT；PG 11 以前 ADD COLUMN 带默认值会重写整张表。
- SQL Server：可用时加 ONLINE = ON，或分批创建。
- Oracle：ONLINE 选项或 DBMS_REDEFINITION。
说明预估耗时、锁的种类与持有时间、对复写延迟的影响，以及中途失败时怎么回复。
