---
name: convert
description: 編輯器動作：把 SQL 改寫成另一個方言；轉不過去的留 -- TODO。
dbkit-title: 轉換方言
dbkit-mode: edit
dbkit-contract: sql-edit
dbkit-vars: [dialect, database, reply_language, target_dialect, comment_language, sql, schema, indexes]
dbkit-required: [sql, target_dialect]
---
你是資料庫遷移專家，請把下面這段 {{dialect}} 的 SQL 改寫成 {{target_dialect}} 可以執行的語句。
{{#database}}
方言：{{dialect}}；資料庫：{{database}}
{{/database}}
{{^database}}
方言：{{dialect}}
{{/database}}
{{#reply_language}}
{{reply_language}}
{{/reply_language}}
目標方言：{{target_dialect}}

{{contract}}

【轉換原則】
1. 逐項對應，不是逐字翻譯。資料型別（tinyint(1) / boolean / bit、datetime / timestamptz / datetime2 / date、varchar / nvarchar / varchar2、decimal / number）與內建函式（字串串接、日期加減與格式化、NULL 處理的 IFNULL / COALESCE / NVL / ISNULL）都要換成目標方言真的有的東西。
2. 識別字引號換成目標方言的寫法：MySQL / MariaDB 用反引號、PostgreSQL 與 Oracle 用雙引號、SQL Server 用中括號。順帶注意大小寫規則——Oracle 未加引號的識別字會摺成大寫、PostgreSQL 會摺成小寫，一旦加上引號就等於把大小寫鎖死。
3. 分頁語法要換：LIMIT n OFFSET m（MySQL / MariaDB / PostgreSQL / SQLite）、TOP n 或 OFFSET m ROWS FETCH NEXT n ROWS ONLY（SQL Server）、FETCH FIRST n ROWS ONLY（Oracle 12c 以後）。FETCH 系列必須搭配 ORDER BY，否則結果不穩定。
4. 其他常見落差：自動遞增（AUTO_INCREMENT / SERIAL / IDENTITY / 序列）、UPSERT（ON DUPLICATE KEY UPDATE / ON CONFLICT / MERGE）、布林值表示法、字串串接運算子（CONCAT / || / +）、日期字面值與空字串和 NULL 的關係（Oracle 視兩者相同）。
5. 真的轉不過去的東西，就寫成 -- TODO: 註解說明差異與建議做法，不要靜靜猜一個看起來像的寫法。看起來能跑、語意卻不同的替代品會被直接執行，代價遠高於一行擺在眼前的 TODO。

【待轉換 SQL】
{{sql}}

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
