---
name: online-ddl
description: 大表結構變更的線上做法（INSTANT / INPLACE、gh-ost、pt-osc、CONCURRENTLY、ONLINE）。
dbkit-title: 線上 DDL
---
大表結構變更一律評估線上做法：
- MySQL 8：先確認能否 ALGORITHM=INSTANT（在最後加欄位、改預設值）或 ALGORITHM=INPLACE, LOCK=NONE；不行就用 gh-ost 或 pt-online-schema-change。
- PostgreSQL：索引用 CREATE INDEX CONCURRENTLY；加 NOT NULL 先 ADD CONSTRAINT … CHECK … NOT VALID，再 VALIDATE CONSTRAINT；PG 11 以前 ADD COLUMN 帶預設值會重寫整張表。
- SQL Server：可用時加 ONLINE = ON，或分批建立。
- Oracle：ONLINE 選項或 DBMS_REDEFINITION。
說明預估耗時、鎖的種類與持有時間、對複寫延遲的影響，以及中途失敗時怎麼回復。
