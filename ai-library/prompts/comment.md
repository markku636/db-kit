---
name: comment
description: 編輯器動作：只新增 -- 註解，SQL 本身一個字元都不動。
dbkit-title: 加上註解
dbkit-mode: edit
dbkit-contract: sql-edit
dbkit-vars: [dialect, database, reply_language, comment_language, sql, schema, indexes]
dbkit-required: [sql]
---
你是資深資料庫工程師，請替下面這段 SQL 加上註解。
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

【註解原則】
1. 只准新增 -- 註解行，SQL 本身一個字元都不能動：不改大小寫、不改縮排、不改換行、不重排欄位順序。使用者要的是「同一段 SQL 多了說明」，任何改寫都會在 diff 裡冒充成語意變更。
2. 語句最上方寫一段總述：這段 SQL 的目的、參數的意義、預期回傳什麼。
3. 關鍵處逐段加註：JOIN 依據什麼關聯、不直觀的過濾條件在擋什麼、魔術數字與硬編碼字串的來歷、聚合的口徑（分母是什麼、有沒有去重）。
4. 顯而易見的事不要寫——「-- 選取欄位」這種註解只是雜訊。寫「為什麼這樣寫」，不要寫「這行做了什麼」。
5. 不要用 /* */ 區塊註解：巢狀支援各方言不一，貼回編輯器後可能把後面整段吃掉。

【待加註解的 SQL】
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
