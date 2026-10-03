# DBA 審查使用指南

**繁體中文** · [English](./dba-review.en.md)

把 SQL 或資料表結構交給一位（或多位）**DBA 人設**審查。DBA 不只看你附上的內容：連線著的時候，它會自己呼叫唯讀資料庫工具——`EXPLAIN` 看實際計畫、看欄位與索引、看列數——驗證之後再下結論。每一次工具呼叫都列在結果裡。

回覆的第一行一定是結論：

| 結論 | 意思 |
|---|---|
| `GO` | 照寫的樣子執行是安全的 |
| `CAUTION` | 可以執行，但請先看過風險 |
| `STOP` | 不應照原樣執行 |

---

## 三個入口

| 入口 | 審查什麼 | 預設人設 |
|---|---|---|
| 查詢分頁 → 更多 →「DBA 審查」，或下方「審查」分頁 | 選取的 SQL（沒選取就是整段），連同規則引擎的發現、相關表的結構與索引、已跑過的執行計畫 | 一般連線：資深 DBA；正式環境：正式環境守門員 |
| 「審查並執行」對話框右側 | 要執行的腳本、逐句分析、目標表結構與估算列數（與 `dbk run` 同一份提示） | 同上 |
| 側欄資料表右鍵 → 問 AI →「DBA 審查結構…」 | DDL、欄位、索引、外鍵、列數與大小 | 同上 |

---

## 面板怎麼用

- **選人設**：點人設 chip 切換。**選多位就是會審**——同一份內容交給這幾位平行審查（最多同時 4 位，其餘排隊），各自一個分頁，上方的「綜合」結論取最嚴格者（STOP > CAUTION > GO；有人沒給結論時以 CAUTION 計）。「會審」按鈕套用設定裡的預設陣容。
- **DBA 查了什麼**：每位審查者的結果上方有「工具呼叫」清單，列出它實際下的每一條查詢、拿回幾列、花多久。
- **套用修正**：回覆裡的 SQL 區塊有「套用到編輯器（差異預覽）」——走與編輯器 AI 動作相同的差異視圖，逐塊可拒絕、可手改，接受後進 undo 歷史。也可以「在查詢分頁開啟」或複製。
- **在助手中追問**：把審查任務與結果帶進右側助手對話，接著問「為什麼這裡會鎖表？」。
- **編輯本次提示**：送出前先看、改這一次的完整提示（人設 + 任務）。只用這一次，不會改到資源庫。
- **調整人設與範本**：面板上的資源庫按鈕直接開 AI 資源庫（見 [AI 資源庫使用指南](./ai-library.md)）。

---

## 審查者能用哪些工具

| 情境 | 可用工具 |
|---|---|
| 人設 `dbkit-db-tools: false` | 不查資料庫（一次性審查） |
| 沒有連線 | 不查資料庫 |
| 人設有 `tools:` 清單 | 只有清單裡的（例：守門員只能看結構與計畫） |
| 審查並執行，且「附前像樣本給 AI」為 0 | 只有 `list_databases` / `list_tables` / `describe_table` / `explain_query`——**不給會撈出實際資料的工具**，與「預設不送任何資料」一致 |
| 其他 | 全部唯讀工具（200 列 / 8 KB / 30 秒上限，寫入在機制上做不到） |

回合數由人設的 `maxTurns` 決定（預設 10）。額度用完時，DBA 會被要求根據已查到的資料直接下結論，不會整段作廢。API 供應商不會把 DBA 審查存成 db-kit 的對話歷史（查到的資料不落地）；Claude Code / Codex CLI 則照它們自己的設定保存工作階段。

四種 AI 供應商都支援：API 供應商在 db-kit 內建工具迴圈；Claude Code 走 `--allowedTools` 只放行 dbkit 工具、`--max-turns` 設回合上限；Codex 由 `dbk mcp --tools` 在伺服器端限制工具。

---

## 命令列

`dbk run` 的 AI 審查也用 DBA 人設：

```bash
# 預設依連線是否為正式環境取人設
dbk --conn prod-mysql -d shop run migrate.sql --out D:/db-backups --review-cmd "claude -p"

# 指定人設；逗號分隔多位 = 會審，結論取最嚴格（STOP 時預設只產生備份）
dbk --conn prod-mysql -d shop run migrate.sql --out D:/db-backups --review-cmd "claude -p" --persona dba-prod-gatekeeper,dba-security

# 看實際送給外部指令的提示（人設 + 任務，外部指令只收得到 stdin）
dbk --conn prod-mysql -d shop run migrate.sql --out D:/db-backups --print-prompt --persona dba-senior
```

---

## 改成你們團隊的 DBA

1. AI 資源庫 → 人設 → 選一位內建 DBA →「複製為自訂」（同名＝覆蓋、換名＝另存）。
2. 在本文寫你們的結論分寸，在「預載技能」勾 `team-conventions`（先複製並寫進團隊規範）。
3. 要給整個團隊用：把個人層的檔案搬進一個 git repo，大家在「來源與同步」加入那個團隊資料夾；CI 跑 `dbk ai lint --dir .`。
4. 想在 Claude Code 裡也用同一位 DBA：「同步到 Claude Code / Codex」。
