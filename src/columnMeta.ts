// 由後端 ColumnInfo.extra 判斷欄位是否不可寫入（SQL Server 的 identity / computed）。
// 抽成純函式：表格就地編輯、複製為 INSERT/UPDATE、Duplicate row 共用同一套規則。

export function isReadOnlyColumnExtra(extra: string | null | undefined): boolean {
  const e = (extra ?? "").toLowerCase();
  return e.includes("identity") || e.includes("computed");
}
