---
name: run-feedback
description: 助手對話裡「執行」之後回送給模型的結果。
dbkit-title: SQL 執行回饋
dbkit-mode: chat
dbkit-vars: [sql, failed, error, result, elapsed]
dbkit-required: [sql]
---
以下是剛才在 MAGIDB CONNECT 直接執行這段 SQL 的結果，請接續分析。

【已執行的 SQL】
{{sql}}

{{#failed}}
【錯誤訊息】
{{error}}
{{/failed}}
{{^failed}}
【執行結果】
{{result}}
{{/failed}}

耗時：{{elapsed}}

【接下來】
{{#failed}}
請先說明這段 SQL 為什麼失敗（指出是語法、物件不存在、型別、權限還是資料問題），再給一段修正後、可直接執行的 SQL，放進單一 ```sql 區塊：保持原本意圖，不要留佔位符或省略號。
{{/failed}}
{{^failed}}
請根據這份結果接續分析：資料代表什麼、有沒有異常或值得注意的趨勢。若需要更多資料才能下結論，請直接給出下一段可執行的 SQL，放進單一 ```sql 區塊，並說明那段查詢要驗證什麼。
{{/failed}}
