// 由後端 ColumnInfo.extra 判斷欄位是否不可寫入（SQL Server 的 identity / computed）。
// 抽成純函式：表格就地編輯、複製為 INSERT/UPDATE、Duplicate row 共用同一套規則。

export function isReadOnlyColumnExtra(extra: string | null | undefined): boolean {
  const e = (extra ?? "").toLowerCase();
  return e.includes("identity") || e.includes("computed");
}

/**
 * 二進位欄位（varbinary / binary / image）目前以 `0x...` 預覽字串顯示，寫回會把這串
 * 十六進位「文字」存進去而毀掉原值（且超過 64 bytes 只剩預覽）。在改用型別化參數之前，
 * 先當成唯讀，避免編輯 / 新增 / 腳本把二進位資料改壞。
 */
export function isBinaryColumnType(dataType: string | null | undefined): boolean {
  const t = (dataType ?? "").trim().toLowerCase();
  return /^(varbinary|binary|image)\b/.test(t);
}
