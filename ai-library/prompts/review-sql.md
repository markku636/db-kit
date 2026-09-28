---
name: review-sql
description: 查詢編輯器的「DBA 審查」：以選定的 DBA 人設審查一段 SQL，第一行給結論。
dbkit-title: DBA 審查 SQL
dbkit-mode: dba
dbkit-contract: verdict
dbkit-vars: [dialect, database, reply_language, sql, lint_findings, schema, indexes, plan]
dbkit-required: [sql]
---
請以你的 DBA 身分審查下面這段 SQL。
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
1. 逐條點評，分成兩段：
   a.「規則引擎已標出的問題」：逐條回應。同意就補上實際風險與會踩到的情境；不同意就講清楚為什麼在這段 SQL 裡是安全的。
   b.「規則引擎看不出來的問題」：語意錯誤、索引用不上（欄位加工、隱式型別轉換、前綴萬用字元）、NULL 與三值邏輯、JOIN 造成的列數放大、交易與鎖的範圍、深分頁、字元集與定序不一致等。
2. 最後給一段改寫後、可直接執行的 SQL，放進單一 ```sql 區塊：保持原本語意，不要留佔位符或省略號。若沒有需要改的地方，就附上原樣並說明理由。

【待審 SQL】
{{sql}}

【規則引擎發現】
{{#lint_findings}}
{{lint_findings}}
{{/lint_findings}}
{{^lint_findings}}
規則引擎已檢查，沒有發現問題（不是沒有執行）。請把重點放在規則涵蓋不到的問題。
{{/lint_findings}}

【相關資料表結構】
{{#schema}}
{{schema}}
{{/schema}}
{{^schema}}
(無法取得欄位資訊，請依查詢內容推斷。)
{{/schema}}

【現有索引】
{{#indexes}}
{{indexes}}
{{/indexes}}
{{^indexes}}
(無法取得索引資訊。請勿假設任何索引存在。)
{{/indexes}}

【執行計畫】
{{#plan}}
{{plan}}
{{/plan}}
{{^plan}}
(未取得執行計畫。需要計畫才能判斷時，請直接說還缺什麼，不要杜撰節點與成本。)
{{/plan}}
