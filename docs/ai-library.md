# AI 資源庫使用指南

**繁體中文** · [English](./ai-library.en.md)

db-kit 裡所有 AI 行為——助手的人設、DBA 審查者、技能、每一個動作送出的提示——都來自 **AI 資源庫**：一組 Markdown 檔。你可以直接改、用 git 在團隊間共用，也能一鍵同步給 Claude Code 與 Codex 使用。

從哪裡開：**設定 →「開啟 AI 資源庫…」**，或 AI 設定、DBA 審查面板上的資源庫按鈕。命令列用 `dbk ai …`（見文末）。

---

## 四種資源

| 資料夾 | 是什麼 | 格式 |
|---|---|---|
| `agents/<名>.md` | **人設**：審查者 / 助手是誰、看重什麼、結論分寸 | Claude Code subagent 格式（本文 = 系統提示） |
| `skills/<名>/SKILL.md` | **技能**：可重複套用的工作方式（線上 DDL、鎖風險、個資檢查…） | Agent Skills 標準（Claude Code 與 Codex 共用） |
| `prompts/<任務>.md` | **任務範本**：每個 AI 動作實際送出的提示，用 `{{變數}}` 代入上下文 | db-kit 專屬 |
| `contracts/<名>.md` | **輸出契約**：解析器依賴的格式（結論行、只回一個 SQL 區塊…） | 只有內建、**不可覆蓋** |

一次送出的提示是這樣組起來的：

```
系統提示 ＝ 人設本文 ＋ 人設預載的技能 ＋ 資料庫工具指引（DBA agent 模式才有）
使用者訊息 ＝ 任務範本（以 {{變數}} 代入 SQL、結構、索引、規則引擎發現、執行計畫…）＋ 輸出契約
```

變數由程式碼產生（截斷、圍籬、逐條格式都在程式碼裡），範本只決定措辭與段落。

---

## 三層：內建 < 個人 < 團隊

| 層 | 位置 | 說明 |
|---|---|---|
| 內建 | 隨 App 安裝 | 檔案本身不動，升級時更新 |
| 個人 | `<設定目錄>/ai-library/` | 對話框「來源與同步」有開啟按鈕；`dbk ai path` 印出位置 |
| 團隊 | 自己加的資料夾（可多個，依序） | 例如 git clone 下來的 `dba-rules/`；可設為唯讀 |

**同一種資源、同一個 `name` 時，後面的層覆蓋前面的層。** 內建的東西在資源庫裡**直接改、按「儲存為自訂版本」**：

- 存下來的是個人層的同名檔＝覆蓋內建版本，其他語言變體（en / zh-CN）一起複製過去，之後 App 升級也不會蓋掉你的版本。列表上會標「已修改」。
- 按「**還原預設**」刪掉這份覆蓋檔（所有語言變體一起），就回到內建版本、也重新跟著升級更新。
- 想保留內建、另外做一份：人設與技能用「另存新項目」換個名稱。提示範本的名稱固定對應功能，只能改不能另存。
- 有沒存的修改時，換項目、換分頁或關掉資源庫會先問一聲；**Ctrl+S** 存檔。

團隊資料夾可以用 db-kit 的結構（`agents/`、`skills/`、`prompts/`），也可以直接用 Claude Code / Codex 的結構（`.claude/agents/`、`.claude/skills/`、`.agents/skills/`）——同一個 repo 可以同時給 db-kit、Claude Code、Codex 用。

在團隊 repo 的 CI 裡檢查格式：

```bash
dbk ai lint --dir .        # 有錯誤時結束碼非零
```

---

## 人設（agents/）

```markdown
---
name: dba-prod-gatekeeper
description: 負責正式環境變更核准的 DBA，寧可擋錯也不放過。
dbkit-title: 正式環境守門員
dbkit-role: dba            # dba = DBA 審查者；assistant = 助手
dbkit-db-tools: true       # DBA agent 模式可以自己查資料庫
maxTurns: 10               # 最多查幾輪再下結論（Claude Code 同名欄位）
tools: [mcp__dbkit__describe_table, mcp__dbkit__explain_query]   # 允許的資料庫工具；省略 = 全部唯讀工具
skills: [lock-risk, online-ddl]                                   # 預載技能
---
你是負責正式環境變更核准的 DBA 守門員……（這段就是系統提示）
```

- `name` 請用小寫英數與連字號（Claude Code / Agent Skills 的慣例），`description` 必填（Claude Code / Codex 用它決定何時使用）。
- `tools` 同時決定 db-kit 裡這位 DBA 能用哪些工具，以及同步到 Claude Code 後的工具白名單。清單外的工具連呼叫都會被擋下，不只是「沒列出來」。
- **結論分寸寫在本文裡**：什麼情況 STOP、什麼情況 CAUTION。內建的四位 DBA 各有不同的分寸，可以參考。
- 檔案裡其他 Claude Code 欄位（`model`、`hooks`、`permissionMode`…）db-kit 不會動，存檔時原樣保留。

內建人設：

| 名稱 | 用途 |
|---|---|
| `assistant` | 助手對話、NL→SQL、編輯器 AI 動作的預設人設 |
| `dba-senior` | 資深 DBA：一般連線的預設審查者 |
| `dba-prod-gatekeeper` | 正式環境守門員：標記為正式環境的連線預設用它；只看結構與計畫，不撈資料 |
| `dba-performance` | 效能調校：以執行計畫為依據 |
| `dba-security` | 資安稽核：權限、注入、個資 |

## 技能（skills/）

```markdown
---
name: team-conventions
description: 團隊自己的 SQL 與結構規範
dbkit-title: 團隊規範
---
審查時一併檢查下列規範……
```

技能有兩種用法：**人設的 `skills:` 預載**（DBA 審查一定會帶），以及**助手對話勾選**（一次性生成不帶）。助手面板工具列的「技能」按鈕顯示目前啟用幾個，點開就是資源庫的技能分頁：列表前的勾選框決定對話要附帶哪些技能，右側直接編輯；AI 設定裡的「助手對話勾選的技能」是同一份選取。內建的 `team-conventions` 是空白範本：直接寫進團隊規則並儲存，再加到 DBA 人設的 `skills` 就會在每次審查被檢查。

## 任務範本（prompts/）

每個 AI 動作一個檔：`review-sql`（編輯器 DBA 審查）、`review-pre-exec`（審查並執行 / `dbk run`）、`review-schema`（結構審查）、`tune-sql`、`explain`、`optimize`、`fix`、`comment`、`convert`、`test-data`、`explain-plan`、`inline-edit`、`nl-sql`、`nl-es`、`nl-shell`、`ssh-*`、`compare-summary`、`run-feedback`、`shell-feedback`，以及系統提示片段 `tool-guidance`、`ssh-terminal-guidance`。

語法（Mustache 子集）：

| 寫法 | 意思 |
|---|---|
| `{{sql}}` | 代入變數（未知變數輸出空字串） |
| `{{#plan}}…{{/plan}}` | 變數非空才輸出 |
| `{{^plan}}…{{/plan}}` | 變數為空才輸出（「沒有執行計畫時要怎麼說」就寫在這裡） |
| `{{contract}}` | 輸出契約放在這裡 |
| `{{! 註解 }}` | 不輸出 |

單獨佔一行的區段標籤整行移除，所以可以一行一個標籤地寫。

保護機制——使用者改範本改不壞功能：

- **輸出契約鎖定**。範本沒放 `{{contract}}` 就自動附在最後。
- **必要變數保底**。範本漏了必要變數（例如 `{{sql}}`）時，送出前自動附在最後，資源庫也會標出警告。
- 覆蓋內建範本只能換本文；任務的變數清單、契約、模式一律取自內建。
- 編輯器的**預覽**用範例資料即時渲染，看得到送出去的樣子。

每個範本可用的變數，編輯器上方列成可點選的 chip（滑過去看說明）。

## 語言變體

同一個檔案旁邊放 `<名>.en.md`、`<名>.zh-CN.md` 就是該語言的版本。解析順序與介面一致：日 / 韓 / 越沒有變體時用英文，再沒有就用基底檔。內建的簡體中文變體由 `node scripts/i18n-gen-zhcn.mjs` 從繁中基底產生。你自己的檔案只寫一份即可——模型看得懂任何語言，回覆語言另外由 `{{reply_language}}` 指定。

---

## 同步到 Claude Code / Codex

資源庫「來源與同步」分頁，或 `dbk ai sync`：

| 目標 | 寫入 |
|---|---|
| Claude Code | `~/.claude/agents/<名>.md`、`~/.claude/skills/<名>/SKILL.md`（`CLAUDE_CONFIG_DIR` 優先） |
| Codex | `~/.agents/skills/<名>/SKILL.md`、`~/.codex/agents/<名>.toml`（`CODEX_HOME` 優先） |
| 專案資料夾（選用） | `<dir>/.claude/…`、`<dir>/.agents/skills/`、`<dir>/.codex/agents/` |

- 預設同步所有 DBA 人設與技能；可用名稱過濾（`dba-*, lock-risk`）。
- **只會覆寫 db-kit 自己寫過、而且之後沒被手動改過的檔案**。你自己的同名檔、或同步後手改過的檔案會列為「衝突」並略過。資源庫刪掉的項目，只刪內容沒被動過的檔。
- 一律先列出計畫（新增 / 更新 / 未變更 / 衝突 / 刪除），確認後才寫入。
- 同步過去的 DBA 人設用 `mcp__dbkit__*` 資料庫工具。要在 Claude Code 裡使用，先註冊 dbk 的 MCP 伺服器：

```bash
claude mcp add dbkit -- dbk --conn prod-mysql mcp
claude --agent dba-prod-gatekeeper -p "審查 migrate.sql"
```

Codex 在 `~/.codex/config.toml` 加上 `[mcp_servers.dbkit]`，`command = "dbk"`、`args = ["--conn", "prod-mysql", "mcp"]`。

---

## 命令列

```bash
dbk ai path                          # 個人層與團隊資料夾位置
dbk ai list [agent|skill|prompt]     # 目前生效的是哪一層的哪一份
dbk ai show agent/dba-senior         # 印出本文（--raw 印整份檔案、--variant en 看英文版）
dbk ai lint [--dir <資料夾>]          # 檢查；有錯誤時結束碼非零
dbk ai sync [--claude] [--codex] [--project <dir>]   # 列出同步計畫；加 --yes 才寫入
```

設定存在 `<設定目錄>/ai-library.json`（團隊資料夾、預設人設、會審陣容、同步目標），GUI 與 `dbk` 共用。
