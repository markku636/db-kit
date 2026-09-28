---
name: review-schema
description: 側欄資料表右鍵「DBA 審查結構」：以選定的 DBA 人設審查一張表的結構與資料模型，第一行給結論。
dbkit-title: DBA 審查結構
dbkit-mode: dba
dbkit-contract: verdict
dbkit-vars: [dialect, database, reply_language, table, ddl, columns, indexes, foreign_keys, table_info]
dbkit-required: [table]
---
請以你的 DBA 身分審查下面這張資料表的結構與資料模型。
{{#database}}
方言：{{dialect}}；資料庫：{{database}}
{{/database}}
{{^database}}
方言：{{dialect}}
{{/database}}
{{#reply_language}}
{{reply_language}}
{{/reply_language}}

{{contract}}

【輸出格式】
1. 總評：一句話說明這張表的設計品質與最大的問題。
2. 逐項問題：從鍵與約束（主鍵、唯一鍵、外鍵、NOT NULL）、型別選用（長度、精度、時間與時區、字元集與定序）、索引（缺少、重複、欄位順序、選擇度）、正規化與命名一致性、容量與維運（列數、大小、成長、熱點）這幾個面向逐條列出，每條標明嚴重度（高 / 中 / 低）與實際影響。
3. 建議的修改：完整 DDL 放進 ```sql 區塊，並說明會不會鎖表、大表上的做法（線上 DDL / 分批）與回滾方式。
不要杜撰結構裡沒有的欄位或索引；資訊不夠時直接說缺什麼，或用資料庫工具查。

【資料表】
{{table}}

【建表 DDL】
{{#ddl}}
{{ddl}}
{{/ddl}}
{{^ddl}}
(無法取得 DDL。)
{{/ddl}}

【欄位】
{{#columns}}
{{columns}}
{{/columns}}
{{^columns}}
(無法取得欄位資訊。)
{{/columns}}

【索引】
{{#indexes}}
{{indexes}}
{{/indexes}}
{{^indexes}}
(沒有索引，或無法取得。)
{{/indexes}}

【外鍵】
{{#foreign_keys}}
{{foreign_keys}}
{{/foreign_keys}}
{{^foreign_keys}}
(沒有外鍵，或無法取得。)
{{/foreign_keys}}

【表資訊】
{{#table_info}}
{{table_info}}
{{/table_info}}
{{^table_info}}
(無法取得列數與大小。)
{{/table_info}}
