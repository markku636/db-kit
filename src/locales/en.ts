import type { Catalog } from "../i18n";

// 英文譯文表。key = 程式碼裡的繁中原文；查無 key 時 t() 回傳 key 本身（identity fallback），
// 所以「尚未翻譯」與「尚未遷移」都只會退回中文，不會出現空字串或 [missing] 佔位符。
//
// 插值佔位符 `{name}` 必須與 key 中的完全一致。
// 需要單複數的條目寫成 { one, other }，由 t() 依 params.n === 1 選擇。
//
// 本檔由 vite 動態 import 切成獨立 chunk —— 繁中使用者永遠不會下載它。
// 覆蓋率以 `node scripts/i18n-scan.mjs` 檢查（軟性棘輪，不進 build gate）。
const en: Catalog = {
  // ---- 語言 / 主題 ----
  語言: "Language",
  介面語言: "Interface language",
  "介面語言，變更立即生效、不需重啟；後端錯誤訊息與 dbk 命令列輸出也會跟著切換。上方工具列亦可快速切換。":
    "Interface language. Takes effect immediately, no restart needed; backend error messages and dbk CLI output follow it too. The toolbar above also has a quick switch.",
  主題: "Theme",
  "整個 app 的配色與深淺（側欄 / 工具列 / 表格 / 對話框 / 編輯器 / AI 助手），變更立即生效。「光亮」為唯一的淺色配色，其餘皆為深色；上方工具列亦可快速切換。":
    "The palette and light/dark mode for the whole app (sidebar, toolbar, grid, dialogs, editor, AI assistant). Takes effect immediately. “Light” is the only light palette; all others are dark. The toolbar above also has a quick switch.",
  配色主題: "Color theme",
  "主題（配色 + 深淺）": "Theme (palette + light/dark)",
  光亮: "Light",
  暗黑: "Dark",
  "Amethyst 紫水晶": "Amethyst",
  "Moonstone 月光石": "Moonstone",
  "Jade 翡翠": "Jade",
  "Garnet 石榴石": "Garnet",
  "Amber 琥珀": "Amber",
  "Ruby 紅寶石": "Ruby",
  "Obsidian 黑曜石": "Obsidian",

  // ---- 共用元件（ui.tsx / ui/*）----
  關閉: "Close",
  取消: "Cancel",
  確定: "OK",
  確認: "Confirm",
  輸入: "Input",
  通知: "Notifications",
  載入中: "Loading",
  已複製: "Copied",
  複製失敗: "Copy failed",

  // ---- 全域錯誤邊界（main.tsx）----
  發生未預期的錯誤: "An unexpected error occurred",
  嘗試繼續: "Try to continue",
  重新載入: "Reload",

  // ---- 工具列 ----
  連線: "Connect",
  "ER 圖": "ER diagram",
  進階搜尋: "Advanced search",
  備份: "Backup",
  收藏查詢: "Saved queries",
  匯出連線: "Export connections",
  匯入連線: "Import connections",
  "AI 助手": "AI assistant",
  "快捷鍵 (F1)": "Shortcuts (F1)",
  設定: "Settings",
  關於: "About",
  "需先連線到 MySQL / PostgreSQL / SQLite":
    "Requires an active MySQL / PostgreSQL / SQLite connection",
  "需先選取並連線一個連線（Ctrl+Shift+G）":
    "Select and open a connection first (Ctrl+Shift+G)",
  需先選取並連線一個連線: "Select and open a connection first",
  "版本 {version} · 點擊開啟「關於 {app}」": "Version {version} · Click to open “About {app}”",
  "點擊前往下載 v{version}": "Click to download v{version}",
  "有新版 v{version}": "v{version} available",

  // ---- 設定對話框 ----
  更新密碼: "Update password",
  啟用: "Enable",

  // ---- 命令面板 ----
  資料庫: "Databases",
  資料表: "Tables",
  視圖: "Views",
  動作: "Actions",
  常用: "Pinned",
  開啟查詢編輯器: "Open query editor",
  "進階物件搜尋…": "Advanced object search…",
  切換深淺色主題: "Toggle light/dark theme",
  "跳到連線 / 資料庫 / 資料表，或執行動作…":
    "Jump to a connection / database / table, or run an action…",
  無相符項目: "No matches",
  請先選取並連線一個連線: "Select and open a connection first",

  // ---- 關於對話框 ----
  "關於 {app}": "About {app}",
  版本: "Version",
  已複製版本資訊: "Version info copied",
  "複製版本資訊（回報問題時附上）": "Copy version info (attach it when reporting an issue)",
  "跨資料庫管理工具：{dbs}": "Cross-database management tool: {dbs}",
  "有新版 v{version}，點擊前往下載": "v{version} available — click to download",
  已是最新版本: "Already up to date",
  "檢查失敗（離線或已達 GitHub API 上限），稍後再試":
    "Check failed (offline, or GitHub API rate limit reached). Try again later.",
  "檢查中…": "Checking…",
  檢查更新: "Check for updates",
  "GitHub 專案": "GitHub repository",
  變更紀錄: "Changelog",
  回報問題: "Report an issue",
  "MIT 授權 · Tauri + React 打造": "MIT licensed · Built with Tauri + React",
};

export default en;
