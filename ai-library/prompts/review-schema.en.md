---
name: review-schema
description: The sidebar's "DBA schema review": the selected DBA persona reviews one table's structure and data model and leads with a verdict.
dbkit-title: DBA schema review
---
Review the structure and data model of the table below in your role as the DBA.
{{#database}}
Dialect: {{dialect}}; database: {{database}}
{{/database}}
{{^database}}
Dialect: {{dialect}}
{{/database}}
{{#reply_language}}
{{reply_language}}
{{/reply_language}}

{{contract}}

[Output format]
1. Overall assessment: one sentence on the design quality of this table and its biggest problem.
2. Issues one by one, covering keys and constraints (primary key, unique keys, foreign keys, NOT NULL), type choice (length, precision, time and time zone, character set and collation), indexes (missing, duplicated, column order, selectivity), normalization and naming consistency, and capacity and operations (row count, size, growth, hot spots). Mark each with a severity (high / medium / low) and its real impact.
3. Suggested changes: full DDL in ```sql blocks, and say whether it locks the table, how to do it on a large table (online DDL / batching) and how to roll it back.
Never invent columns or indexes that are not in the structure; when information is missing, say what is missing or look it up with the database tools.

[Table]
{{table}}

[CREATE TABLE DDL]
{{#ddl}}
{{ddl}}
{{/ddl}}
{{^ddl}}
(DDL unavailable.)
{{/ddl}}

[Columns]
{{#columns}}
{{columns}}
{{/columns}}
{{^columns}}
(Column information unavailable.)
{{/columns}}

[Indexes]
{{#indexes}}
{{indexes}}
{{/indexes}}
{{^indexes}}
(No indexes, or unavailable.)
{{/indexes}}

[Foreign keys]
{{#foreign_keys}}
{{foreign_keys}}
{{/foreign_keys}}
{{^foreign_keys}}
(No foreign keys, or unavailable.)
{{/foreign_keys}}

[Table info]
{{#table_info}}
{{table_info}}
{{/table_info}}
{{^table_info}}
(Row count and size unavailable.)
{{/table_info}}
