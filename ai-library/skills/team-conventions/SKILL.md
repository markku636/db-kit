---
name: team-conventions
description: 團隊自己的 SQL 與結構規範（範本：複製為自訂後改寫，再加到 DBA 人設的 skills）。
dbkit-title: 團隊規範
---
審查時一併檢查下列團隊規範，違反的逐條列出（這是範本，請依團隊實際規範改寫）：
- 資料表與欄位一律 snake_case，表名用複數。
- 每張表都要有主鍵，以及 created_at / updated_at。
- 禁止 SELECT *；禁止在正式環境直接執行沒有 WHERE 的 UPDATE / DELETE。
- 金額一律 DECIMAL(19,4)，時間一律存 UTC。
