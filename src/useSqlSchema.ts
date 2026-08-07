import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "./store";
import { api, CachedSchema, DbKind } from "./api";
import { isSystemDatabase } from "./sql";
import {
  isStale,
  mergeCachedSchema,
  sameTables,
  sanitizeCachedSchema,
  shouldCacheKind,
  toSqlNamespace,
} from "./schemaCache";
import type { SQLNamespace } from "@codemirror/lang-sql";

// SQL 自動完成的結構來源，三層：
//
//   L1 memory   本行程的 Map，跨分頁 / 跨對話框共用，切分頁不用重解析
//   L2 磁碟     後端 schema-cache/<conn>.json，開檔即用、未連線也有、離線也有
//   L3 資料庫   refresh_schema_cache 一次批次查詢（各 driver 已覆寫 schema_columns）
//
// 舊版的做法是每次都打 L3，而且為了避免逐表往返而寫死「只補前 80 張表」——第 81 張之後
// 完全沒有欄位提示，且行程內快取永不失效，在 app 裡跑完 DDL 也不會更新。現在 L3 是單一
// 批次查詢，所以上限拿掉了；失效則由 invalidateSchemaCache 從「重新整理」與 DDL 路徑驅動。

const memory = new Map<string, CachedSchema>();
/** 同一把鑰匙的併發載入只跑一次（四個編輯器同時掛載是常態）。 */
const inflight = new Map<string, Promise<CachedSchema | null>>();
/** 本次工作階段已經向資料庫重抓過的鑰匙——背景重抓每個 (連線, 庫) 只做一次。 */
const refreshed = new Set<string>();
const listeners = new Set<() => void>();

function cacheKey(connId: string, database: string): string {
  return `${connId}:${database}`;
}

function notify(): void {
  for (const l of listeners) l();
}

/**
 * 讓結構快取失效並通知所有掛載中的編輯器重載。
 *
 * - `invalidateSchemaCache()`：全部（登出 / 清除快取）
 * - `invalidateSchemaCache(connId)`：整個連線（斷線 / 側欄對連線按重新整理）
 * - `invalidateSchemaCache(connId, database)`：單一資料庫（跑完 DDL、對資料庫節點重新整理）
 *
 * 只清行程內的 L1 並觸發重載；磁碟上的 L2 會在重抓成功後被覆蓋。刻意不去砍 L2——
 * 重抓失敗時舊資料仍該留著，沒有提示比舊提示更糟。
 */
export function invalidateSchemaCache(connId?: string, database?: string): void {
  const drop = (k: string) => {
    memory.delete(k);
    inflight.delete(k);
    refreshed.delete(k);
  };
  if (!connId) {
    for (const k of [...memory.keys(), ...inflight.keys(), ...refreshed]) drop(k);
  } else if (database) {
    drop(cacheKey(connId, database));
  } else {
    const prefix = `${connId}:`;
    for (const k of [...memory.keys(), ...inflight.keys(), ...refreshed]) {
      if (k.startsWith(prefix)) drop(k);
    }
  }
  notify();
}

/** 讀 L2（磁碟）。純讀檔不連線，所以連線還沒建立也拿得到。 */
async function readCache(connId: string, database: string): Promise<CachedSchema | null> {
  try {
    const got = sanitizeCachedSchema(await api.getSchemaCache(connId, database));
    if (got) memory.set(cacheKey(connId, database), got);
    return got;
  } catch {
    return null;
  }
}

/** 打 L3（資料庫）重抓並回寫 L1。同一把鑰匙的併發呼叫共用同一個 promise。 */
function fetchFresh(connId: string, database: string): Promise<CachedSchema | null> {
  const key = cacheKey(connId, database);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    const prev = memory.get(key) ?? null;
    try {
      const next = sanitizeCachedSchema(await api.refreshSchemaCache(connId, database));
      const merged = mergeCachedSchema(prev, next);
      // 內容沒變就沿用舊物件，讓 CodeMirror 不必整組重建擴充套件（見 sameTables）。
      const settled = merged && prev && sameTables(prev.tables, merged.tables) ? prev : merged;
      if (settled) memory.set(key, settled);
      refreshed.add(key);
      return settled;
    } catch {
      // 未連線 / 權限不足 / 逾時：保留既有快取。這條路徑很常走到——側欄還沒連線就開了查詢分頁。
      return prev;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export interface SqlSchemaState {
  /** 給 CodeMirror 的表名 → 欄名對應；沒有可用結構時 undefined。 */
  schema: SQLNamespace | undefined;
  /** 目前實際使用的資料庫（解析預設庫之後的結果）。 */
  database: string | null;
  /** 快取時間（epoch ms）；0 = 尚無快取。 */
  updatedAt: number;
  /** 是否已過期（僅提示，不自動重抓）。 */
  stale: boolean;
  /** 是否正在向資料庫重抓。 */
  loading: boolean;
  /** 此種類是否適用結構快取（不適用時 UI 不該顯示徽章）。 */
  supported: boolean;
  /** 手動重抓。 */
  refresh: () => Promise<void>;
}

/**
 * 結構自動完成的完整狀態（查詢分頁用，需要顯示快取時間與重新整理按鈕）。
 *
 * 載入順序：L1 → L2 →（本階段第一次才）L3 背景重抓。有快取時第一次 render 就有完整結構，
 * 不再像舊版那樣先塞表名、再補欄名而觸發兩次 setState、把編輯器擴充套件重建兩次。
 */
export function useSqlSchemaState(
  connId: string | null,
  kind: DbKind | undefined,
  databaseOverride?: string | null,
): SqlSchemaState {
  const storeDb = useStore((s) => s.connections.find((c) => c.id === connId)?.database ?? null);
  const requested = databaseOverride !== undefined ? databaseOverride : storeDb;
  const supported = shouldCacheKind(kind);

  const [database, setDatabase] = useState<string | null>(null);
  const [entry, setEntry] = useState<CachedSchema | null>(null);
  const [loading, setLoading] = useState(false);
  // 訂閱模組層的失效通知：invalidateSchemaCache 一叫，所有掛載中的 hook 重跑載入。
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  useEffect(() => {
    if (!connId || !supported) {
      setDatabase(null);
      setEntry(null);
      return;
    }
    let cancelled = false;

    (async () => {
      // 1. 決定目標資料庫。指定了就直接用——省一次 list_databases，於是「有快取時完全不連線」
      //    這個性質才成立（對話框與查詢分頁都會指定）。沒指定才去問預設庫。
      let db = requested || null;
      if (!db) {
        try {
          const dbs = await api.listDatabases(connId);
          if (cancelled) return;
          const userDbs = dbs.filter((d) => !isSystemDatabase(kind!, d));
          db = userDbs[0] ?? dbs[0] ?? null;
        } catch {
          return; // 列不出資料庫就沒有自動完成（不致命）
        }
      }
      if (!db || cancelled) return;
      setDatabase(db);

      const key = cacheKey(connId, db);

      // 2. L1 →（沒有才）L2。兩者都命中不到就先讓畫面空著，等 L3。
      let current = memory.get(key) ?? null;
      if (!current) current = await readCache(connId, db);
      if (cancelled) return;
      if (current) setEntry(current);

      // 3. 本階段第一次碰到這個 (連線, 庫) 才向資料庫重抓一次（「連線後背景整庫重抓」）。
      //    之後就靠使用者按重新整理或 app 內 DDL 觸發的失效，不做 TTL 輪詢。
      if (refreshed.has(key)) return;
      if (!current) setLoading(true);
      const fresh = await fetchFresh(connId, db);
      if (cancelled) return;
      setLoading(false);
      if (fresh) setEntry(fresh);
    })();

    return () => {
      cancelled = true;
    };
  }, [connId, kind, requested, supported, tick]);

  const refresh = useCallback(async () => {
    if (!connId || !database) return;
    setLoading(true);
    try {
      const fresh = await fetchFresh(connId, database);
      if (fresh) setEntry(fresh);
    } finally {
      setLoading(false);
    }
  }, [connId, database]);

  // entry 的物件識別穩定時（fetchFresh 的 sameTables 保證了這點），namespace 也不會重建。
  const schema = useMemo(
    () => (entry && entry.tables.length ? toSqlNamespace(entry.tables) : undefined),
    [entry],
  );

  const updatedAt = entry?.updated_at_ms ?? 0;
  return {
    schema,
    database,
    updatedAt,
    stale: isStale(updatedAt),
    loading,
    supported,
    refresh,
  };
}

/**
 * 只要 schema 本身的薄包裝（CreateView / ViewDesigner / Routines 等對話框用）。
 * databaseOverride 指定目標資料庫；省略時取連線預設庫或第一個非系統庫。
 */
export function useSqlSchema(
  connId: string | null,
  kind: DbKind | undefined,
  databaseOverride?: string | null,
): SQLNamespace | undefined {
  return useSqlSchemaState(connId, kind, databaseOverride).schema;
}
