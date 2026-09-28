//! AI 資源庫：人設（agents/）、技能（skills/）、任務範本（prompts/）、輸出契約（contracts/）全部是
//! Markdown + frontmatter 的靜態檔，格式相容 Claude Code 的 subagent 與 Agent Skills 標準（Codex 也用）。
//!
//! 分層：內建（repo 的 `ai-library/`，嵌入二進位）< 個人（`<設定目錄>/ai-library/`）< 團隊資料夾。
//! GUI（Tauri 命令）與 `dbk`（`run --persona`、`ai …`）共用本模組；不依賴 Tauri，也不依賴 reqwest。
//!
//! 提示 = 人設 + 預載技能 + 範本（`{{變數}}`）+ 鎖定的輸出契約；變數由呼叫端的「上下文提供者」產生。
//! 前端 `src/promptTemplate.ts` / `src/aiLibrary.ts` 是同一份規格的另一個實作（前端 builder 必須同步），
//! 兩邊由 `tests/fixtures/ai-render-cases.json` 釘住。

mod builtin;
pub mod edit;
pub mod frontmatter;
pub mod library;
pub mod render;
pub mod settings;
pub mod sync;

pub use library::Library;
