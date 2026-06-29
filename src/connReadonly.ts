// 連線唯讀模式（致敬 Navicat / DataGrip 的「read-only connection」）：把連線標為唯讀，
// 擋掉查詢編輯器的寫入 / DDL 語句與資料格編輯，避免在正式環境誤改資料。純前端、localStorage 持久化。

export const READONLY_KEY = "db-kit:readonlyConns";
export type ReadonlyMap = Record<string, boolean>;

export function isReadonly(map: ReadonlyMap, id: string | null | undefined): boolean {
  return !!id && map[id] === true;
}

// 純函式：設定 / 清除唯讀（false 移除鍵），回傳新 map。
export function setReadonlyFlag(map: ReadonlyMap, id: string, ro: boolean): ReadonlyMap {
  const next = { ...map };
  if (ro) next[id] = true;
  else delete next[id];
  return next;
}

export function loadReadonly(): ReadonlyMap {
  try {
    const obj = JSON.parse(localStorage.getItem(READONLY_KEY) || "{}");
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: ReadonlyMap = {};
      for (const [k, v] of Object.entries(obj)) if (v === true) out[k] = true;
      return out;
    }
  } catch {
    /* 忽略損毀的存檔 */
  }
  return {};
}

export function persistReadonly(map: ReadonlyMap) {
  try {
    localStorage.setItem(READONLY_KEY, JSON.stringify(map));
  } catch {
    /* 忽略寫入失敗 */
  }
}
