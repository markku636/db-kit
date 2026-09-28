---
name: nl-sql
description: 查詢列的自然語言 → SQL：注入方言、表名清單與最相關表的欄位。
dbkit-title: 自然語言轉 SQL
dbkit-mode: generate
dbkit-contract: sql-only
dbkit-vars: [dialect, database, cross_dbs, comment_language, table_count, table_list, schema, request]
dbkit-required: [request]
---
{{contract}}
規則：方言為 {{dialect}}；優先使用下方結構中存在的表與欄位；
{{#cross_dbs}}
可跨資料庫查詢：清單中帶 `庫.表` 的項目要原樣以限定名參照（可用的庫：{{cross_dbs}}）；
{{/cross_dbs}}
SELECT 無明確筆數需求時加 LIMIT 200；除非使用者明確要求，不產生 DDL。
{{#comment_language}}
{{comment_language}}
{{/comment_language}}

【資料庫環境】
類型：{{dialect}}
資料庫：{{database}}{{^database}}(預設){{/database}}
全部資料表（{{table_count}} 張）：{{table_list}}{{^table_list}}(無法取得，請依需求推斷){{/table_list}}

【最相關資料表結構】
{{schema}}{{^schema}}(無法取得欄位，請依表名與需求推斷){{/schema}}

【使用者需求】
{{request}}
