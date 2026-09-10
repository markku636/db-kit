import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "./store";
import { api, CachedSchema, DbKind, TableColumns } from "./api";
import { connDatabaseIsNamespace, isSystemDatabase } from "./sql";
import {
  isStale,
  mergeCachedSchema,
  sameTables,
  sanitizeCachedSchema,
  shouldCacheKind,
  toMultiDbSqlNamespace,
  type DbTables,
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

/**
 * 載入單一資料庫的結構（L1 → L2 →（本階段第一次才）L3），供「跨庫」的額外庫使用。
 *
 * 與主庫路徑的差別只有一處：磁碟已有可用快取時**先回舊的、重抓丟到背景**。
 * 這條路徑是使用者打完 `other_db.` 當下觸發的，等一趟整庫查詢跑完才跳提示就太慢了；
 * 背景重抓完成再 notify 一次，下一次補全就是新的。
 */
async function loadDatabase(connId: string, db: string): Promise<CachedSchema | null> {
  const key = cacheKey(connId, db);
  let current = memory.get(key) ?? null;
  if (!current) current = await readCache(connId, db);
  if (refreshed.has(key)) return current;
  if (current) {
    void fetchFresh(connId, db).then((fresh) => {
      if (fresh) notify();
    });
    return current;
  }
  return await fetchFresh(connId, db);
}

/**
 * 「沒有額外庫」的共用空陣列。
 *
 * 每次都回一個新的 `[]` 會讓下游的 schema memo 跟著重算、namespace 換成新物件，
 * 於是 CodeMirror 整組擴充套件重建——那正是 sameTables 當初要避免的事。
 * 沒開跨庫的人是絕大多數，這條路徑必須完全維持舊有的物件識別。
 */
const NO_EXTRAS: DbTables[] = [];

/** 併入不重複的項目；沒有新東西時回原陣列（避免無謂的 setState 觸發重渲染）。 */
function mergeUnique(prev: string[], add: string[]): string[] {
  const missing = add.filter((d) => d && !prev.includes(d));
  return missing.length ? [...prev, ...missing] : prev;
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
  /** 手動重抓（只重抓主庫；額外庫走 ensureDatabase）。 */
  refresh: () => Promise<void>;
  /** 目前已載入結構的資料庫（主庫在最前，其後為跨庫的額外庫）。 */
  databases: string[];
  /**
   * 按需載入某個資料庫的結構（跨庫補全用），回傳該庫的表與欄位。
   * 已載入者不重抓；載不到（未連線 / 權限不足）回空陣列。
   *
   * 回欄位而不只是表名：補全在「載回來的當下」就要提示得出欄位（見 sqlContextCompletion），
   * 等這裡 setExtraDbs 觸發的下一次 render 才有結構的話，那個補全視窗早就過去了。
   */
  ensureDatabase: (db: string) => Promise<TableColumns[]>;
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
  extraDatabases?: string[],
): SqlSchemaState {
  const storeDb = useStore((s) => s.connections.find((c) => c.id === connId)?.database ?? null);
  // 呼叫端沒指定時的退路。**只有在連線設定的 database 與 list_databases 同義時才能用**——
  // PostgreSQL / Oracle 的 list_databases 回的是 schema，拿連線設定的資料庫名 / 服務名去查
  // 只會得到零張表（而且沒有任何錯誤，整個編輯器就是安靜地補不到東西）。
  // 這些 kind 改回 null，讓下面的 list_databases 去挑第一個非系統 schema。
  const fallbackDb = connDatabaseIsNamespace(kind) ? storeDb : null;
  // Oracle 專用：schema 即帳號，解析預設庫時優先挑登入帳號自己的 schema（見下方效果）。
  const storeUser = useStore((s) => s.connections.find((c) => c.id === connId)?.username ?? null);
  const requested = databaseOverride !== undefined ? databaseOverride : fallbackDb;
  const supported = shouldCacheKind(kind);

  const [database, setDatabase] = useState<string | null>(null);
  const [entry, setEntry] = useState<CachedSchema | null>(null);
  const [loading, setLoading] = useState(false);
  // 跨庫：已請求載入結構的額外資料庫（來自「跨庫」多選，或使用者打 `other_db.` 的按需載入）。
  // 只記名字——內容一律回 memory 拿，才不會在 hook 裡養出第二份會走味的快取。
  const [extraDbs, setExtraDbs] = useState<string[]>([]);
  // props 陣列每次 render 都是新物件，用內容當相依鍵才不會讓效果每次都重跑。
  const extraKey = (extraDatabases ?? []).filter(Boolean).join("\0");
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
          // Oracle 的 schema 就是使用者帳號，所以「預設」該是登入帳號自己的 schema，
          // 而不是 all_users 依字母排序的第一個（那多半是別人的表）。
          // 不分大小寫比對：all_users 存的是大寫，連線設定未必。
          const own =
            kind === "oracle" && storeUser
              ? (dbs.find((d) => d.toLowerCase() === storeUser.toLowerCase()) ?? null)
              : null;
          db = own ?? userDbs[0] ?? dbs[0] ?? null;
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
  }, [connId, kind, requested, storeUser, supported, tick]);

  // 換連線 / 換種類就把跨庫清單歸零：庫名只在單一連線內有意義，留著會拿 A 連線的庫去查 B。
  useEffect(() => {
    setExtraDbs([]);
  }, [connId, supported]);

  /** 按需載入單一庫（打 `other_db.` 或寫了 `other_db.表` 時觸發）。已載入者直接回，不重抓。 */
  const ensureDatabase = useCallback(
    async (db: string): Promise<TableColumns[]> => {
      if (!connId || !supported || !db) return [];
      const got = memory.get(cacheKey(connId, db)) ?? (await loadDatabase(connId, db));
      if (!got) return [];
      setExtraDbs((prev) => mergeUnique(prev, [db]));
      notify(); // 同一連線的其他編輯器也一起拿到這個庫
      return got.tables;
    },
    [connId, supported],
  );

  // 「跨庫」多選指定的庫：逐一載入（各自失敗只影響自己），一有結果就併進清單讓提示立刻可用。
  useEffect(() => {
    if (!connId || !supported || !extraKey) return;
    const wanted = extraKey.split("\0");
    let cancelled = false;
    void (async () => {
      for (const db of wanted) {
        const got = await loadDatabase(connId, db);
        if (cancelled) return;
        if (got) setExtraDbs((prev) => mergeUnique(prev, [db]));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId, supported, extraKey]);

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

  // 額外庫的內容一律回 memory 取（tick 讓背景重抓完成後這裡跟著更新）。
  // 與主庫同名者略過——它已經在頂層以裸名出現了。
  const extras = useMemo<DbTables[]>(() => {
    if (!connId || extraDbs.length === 0) return NO_EXTRAS;
    const out: DbTables[] = [];
    for (const db of extraDbs) {
      if (db === database) continue;
      const got = memory.get(cacheKey(connId, db));
      if (got && got.tables.length) out.push({ database: db, tables: got.tables });
    }
    return out.length ? out : NO_EXTRAS;
    // tick 不出現在函式本體，但它正是「memory 內容變了」的訊號（背景重抓完成會 notify）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, database, extraDbs, tick]);

  // entry 的物件識別穩定時（fetchFresh 的 sameTables 保證了這點），namespace 也不會重建。
  const schema = useMemo(() => {
    const primary = entry?.tables ?? [];
    if (!primary.length && extras.length === 0) return undefined;
    return toMultiDbSqlNamespace(primary, extras);
  }, [entry, extras]);

  const databases = useMemo(
    () => (database ? [database, ...extras.map((e) => e.database)] : extras.map((e) => e.database)),
    [database, extras],
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
    databases,
    ensureDatabase,
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
