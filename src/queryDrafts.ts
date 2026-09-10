// 查詢分頁草稿（編輯器內容）的 localStorage 鍵與清理。
//
// 草稿 per-連線 × per-分頁 存：`db-kit:querySql:<connId>`（home 分頁，沿用舊鍵向後相容）與
// `db-kit:querySql:<connId>:__query__:N`（其餘分頁）。分頁 id 由 store 的 nextQueryTabId 回收號碼
// （關掉「查詢 2」再開，拿到的又是 __query__:2），所以分頁一關就得把它在**所有連線**下的草稿一併
// 清掉——否則下一個開到同號的新分頁一掛上就是上一個分頁留下的舊內容，Ctrl+N「新查詢」看起來像沒清。
//
// 清掉前把內容交還給呼叫端（store 會存進查詢歷史），誤關的分頁仍救得回來。
import { isQueryTabId } from "./session";

export const QUERY_SQL_PREFIX = "db-kit:querySql:";

/** 草稿鍵：home 分頁不帶後綴（既有草稿不遺失），其餘分頁接 `:<tabId>`。 */
export const sqlStoreKey = (connId: string, tabId = "__query__") =>
  tabId === "__query__" ? `${QUERY_SQL_PREFIX}${connId}` : `${QUERY_SQL_PREFIX}${connId}:${tabId}`;

/** 反解草稿鍵；非草稿鍵（或形狀對不上的）回 null，呼叫端不得動它。 */
export function parseSqlStoreKey(key: string): { connId: string; tabId: string } | null {
  if (!key.startsWith(QUERY_SQL_PREFIX)) return null;
  const rest = key.slice(QUERY_SQL_PREFIX.length);
  if (!rest) return null;
  // 分頁 id 恆以 `__query__` 起頭，故從最後一個 `:__query__` 切開；切不到就是 home 分頁的舊鍵。
  const idx = rest.lastIndexOf(":__query__");
  if (idx < 0) return { connId: rest, tabId: "__query__" };
  const connId = rest.slice(0, idx);
  const tabId = rest.slice(idx + 1);
  // home 從不帶後綴、`:0` / `:1` / 前導零也不是 nextQueryTabId 產得出來的：都不是我們寫的鍵，放著別動。
  if (!connId || tabId === "__query__" || !isQueryTabId(tabId)) return null;
  return { connId, tabId };
}

export interface RemovedDraft { connId: string; tabId: string; sql: string }

/**
 * 刪掉不在 liveTabIds 裡的分頁草稿（掃全部連線），回傳刪掉的內容供呼叫端存入歷史。
 * 以「不在開啟清單裡」為準而非「剛關掉哪一個」：一次涵蓋單關 / 關其他 / 全部關閉，
 * 也順帶把改版前累積的孤兒草稿清乾淨。
 */
export function pruneQueryDrafts(liveTabIds: readonly string[], storage: Storage = localStorage): RemovedDraft[] {
  const removed: RemovedDraft[] = [];
  try {
    // 先收集鍵再刪：邊迭代邊 removeItem 會讓 key(i) 的索引位移而漏掉。
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k) keys.push(k);
    }
    for (const k of keys) {
      const p = parseSqlStoreKey(k);
      if (!p || liveTabIds.includes(p.tabId)) continue;
      const sql = storage.getItem(k) ?? "";
      storage.removeItem(k);
      removed.push({ ...p, sql });
    }
  } catch {
    /* 忽略讀寫失敗 */
  }
  return removed;
}
