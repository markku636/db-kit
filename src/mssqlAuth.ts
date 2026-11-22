// SQL Server 驗證方式的純函式判斷（前端表單、連線前帳密檢查共用）。
// 與後端 mssql.rs::mssql_auth 的規則對齊：Windows 驗證下只有 `網域\帳號` 是真正的帳號；
// 留空或表單預設的 root / sa 都該走 AuthMethod::Integrated（目前登入這台電腦的使用者）。

export type MssqlAuthMode = "sql" | "windows";

/**
 * Windows 驗證時要存進 / 送給驅動的帳號。
 * 只有內含反斜線的網域帳號要保留；root / sa 這種 SQL 帳號不能拿去當 NTLM 使用者。
 */
export function mssqlEffectiveUsername(mode: MssqlAuthMode, username: string): string {
  if (mode !== "windows") return username;
  const u = username.trim();
  return u.includes("\\") ? u : "";
}

/**
 * 這條 MSSQL 連線在送出前是否還需要補帳密。
 * Integrated（目前登入使用者）什麼都不需要；網域帳號與 SQL 帳號都要密碼。
 */
export function mssqlNeedsCredentials(options: Record<string, string> | null | undefined, username: string): boolean {
  const mode: MssqlAuthMode = options?.mssql_auth === "windows" ? "windows" : "sql";
  return mode !== "windows" || mssqlEffectiveUsername(mode, username).length > 0;
}
