// 常見資料庫錯誤 → 繁中友善提示（一行說明 + 建議動作）。
// 查無對應時回 null，呼叫端照舊只顯示原始錯誤字串（原文永遠保留在畫面上，這裡只是加註）。
// 純函式：比對各家族錯誤碼 / 慣用片語，不依賴任何 runtime。

import type { DbKind } from "./api";

interface ErrorRule {
  /** 適用的連線類型；空陣列 = 全部 */
  kinds: DbKind[];
  pattern: RegExp;
  hint: string;
}

// 順序即優先序：各家族專屬規則在前、跨類型泛用規則最後（避免「statement timeout」等
// 專屬訊息被泛用 timeout 規則搶先命中）。
const RULES: ErrorRule[] = [
  // ---- MySQL / MariaDB ----
  { kinds: ["mysql", "mariadb"], pattern: /\b1045\b|access denied for user/i, hint: "帳號或密碼錯誤（MySQL 1045）：檢查連線設定的使用者與密碼，以及該帳號是否允許自此主機連入。" },
  { kinds: ["mysql", "mariadb"], pattern: /\b1049\b|unknown database/i, hint: "資料庫不存在（MySQL 1049）：確認資料庫名稱拼寫，或先建立該資料庫。" },
  { kinds: ["mysql", "mariadb"], pattern: /\b1064\b/, hint: "SQL 語法錯誤（MySQL 1064）：檢查錯誤訊息指出的位置附近；保留字需以反引號包裹。" },
  { kinds: ["mysql", "mariadb"], pattern: /\b1146\b|doesn't exist/i, hint: "資料表不存在（MySQL 1146）：確認表名與目前資料庫；可用側欄樹或「USE 資料庫」切換。" },
  { kinds: ["mysql", "mariadb"], pattern: /\b1062\b|duplicate entry/i, hint: "唯一鍵衝突（MySQL 1062）：插入 / 更新的值與既有資料重複。" },
  { kinds: ["mysql", "mariadb"], pattern: /\b1142\b|command denied/i, hint: "權限不足（MySQL 1142）：目前帳號沒有此操作的權限，請調整授權或改用其他帳號。" },
  { kinds: ["mysql", "mariadb"], pattern: /\b1205\b|lock wait timeout/i, hint: "等鎖逾時（MySQL 1205）：有其他交易鎖住目標列，稍後重試或檢查長交易。" },
  { kinds: ["mysql", "mariadb"], pattern: /\b3024\b|max_execution_time|max_statement_time/i, hint: "查詢已達伺服器端逾時上限而被中止（設定 → 查詢逾時可調整）。" },

  // ---- PostgreSQL ----
  { kinds: ["postgres"], pattern: /28P01|password authentication failed/i, hint: "帳號或密碼錯誤（PG 28P01）：檢查使用者與密碼；亦確認 pg_hba.conf 允許此來源。" },
  { kinds: ["postgres"], pattern: /3D000|database .* does not exist/i, hint: "資料庫不存在（PG 3D000）：確認連線設定的 database 名稱。" },
  { kinds: ["postgres"], pattern: /42P01|relation .* does not exist/i, hint: "資料表（relation）不存在（PG 42P01）：確認表名與 search_path；未加引號的識別字會被轉小寫。" },
  { kinds: ["postgres"], pattern: /42601/, hint: "SQL 語法錯誤（PG 42601）：檢查錯誤指出的位置附近。" },
  { kinds: ["postgres"], pattern: /23505|duplicate key value/i, hint: "唯一鍵衝突（PG 23505）：插入 / 更新的值與既有資料重複。" },
  { kinds: ["postgres"], pattern: /42501|permission denied/i, hint: "權限不足（PG 42501）：目前帳號沒有此物件的操作權限。" },
  { kinds: ["postgres"], pattern: /57014|canceling statement due to statement timeout/i, hint: "查詢已達伺服器端逾時上限而被取消（設定 → 查詢逾時可調整）；連線可繼續使用。" },

  // ---- SQL Server ----
  { kinds: ["mssql"], pattern: /login failed/i, hint: "登入失敗：檢查帳密與驗證模式（SQL 驗證需在伺服器啟用）。" },
  { kinds: ["mssql"], pattern: /invalid object name/i, hint: "物件不存在：確認表名的 schema 前綴（非 dbo 需寫成 schema.table）與目前資料庫。" },

  // ---- Oracle ----
  { kinds: ["oracle"], pattern: /ORA-01017/i, hint: "帳號或密碼錯誤（ORA-01017）：Oracle 密碼預設區分大小寫。" },
  { kinds: ["oracle"], pattern: /ORA-00942/i, hint: "資料表或視圖不存在（ORA-00942）：確認名稱與擁有者（schema）；亦可能是無權限。" },
  { kinds: ["oracle"], pattern: /ORA-12154|ORA-12514/i, hint: "無法解析連線目標（ORA-12154/12514）：確認 service name / SID 與監聽器設定。" },
  { kinds: ["oracle"], pattern: /DPI-1047|instant client/i, hint: "找不到 Oracle Instant Client：請安裝並確認 DLL 位於 PATH（見 README 前置需求）。" },

  // ---- MongoDB ----
  { kinds: ["mongo"], pattern: /authentication failed/i, hint: "認證失敗：檢查帳密與 authSource（帳號建立在哪個資料庫就填哪個）。" },
  { kinds: ["mongo"], pattern: /operation exceeded time limit|MaxTimeMSExpired/i, hint: "查詢已達 maxTimeMS 逾時上限（設定 → 查詢逾時可調整）。" },

  // ---- Redis ----
  { kinds: ["redis"], pattern: /NOAUTH|WRONGPASS/i, hint: "Redis 密碼錯誤或未提供：檢查連線設定的密碼（requirepass / ACL）。" },

  // ---- 連線層（跨類型，最後比對）----
  { kinds: [], pattern: /connection refused|10061/i, hint: "無法連上伺服器：確認主機 / 連接埠正確、服務已啟動、防火牆未擋。" },
  { kinds: [], pattern: /pool timed out|pool exhausted/i, hint: "連線池已滿：有查詢長期佔用連線，可從行程清單終止，或調高連線數上限。" },
  { kinds: [], pattern: /ssh/i, hint: "SSH 通道問題：確認跳板機帳密 / 金鑰與 known_hosts 指紋。" },
  { kinds: [], pattern: /timed? ?out|timeout/i, hint: "連線或查詢逾時：檢查網路 / VPN，或於設定調高查詢逾時；伺服器端查詢可能仍在執行。" },
];

/**
 * 依連線類型與原始錯誤字串比對常見錯誤，回傳繁中提示；查無對應回 null。
 * kind 為 undefined 時只比對跨類型規則。
 */
export function friendlyDbError(kind: DbKind | undefined, raw: string): string | null {
  if (!raw) return null;
  for (const r of RULES) {
    if (r.kinds.length > 0 && (!kind || !r.kinds.includes(kind))) continue;
    if (r.pattern.test(raw)) return r.hint;
  }
  return null;
}
