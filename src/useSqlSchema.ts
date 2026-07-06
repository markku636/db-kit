import { useEffect, useState } from "react";
import { useStore } from "./store";
import { api, DbKind } from "./api";
import { isSystemDatabase } from "./sql";
import type { SQLNamespace } from "@codemirror/lang-sql";

// 僅關聯式資料庫提供結構自動完成。
const SCHEMA_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "oracle"];

// 自動完成用的 schema 快取（key = 連線:資料庫）。背景載入，載好後編輯器即時套用，不阻塞輸入。
const schemaCache = new Map<string, SQLNamespace>();

/**
 * 為連線建立 SQL 自動完成 schema（表名 + 欄名）。
 * 先即時放入所有表名（FROM/JOIN 後可立即補全），再以限量 / 限併發於背景補欄名。
 * databaseOverride 指定目標資料庫（如視圖 / 程序對話框）；省略時取連線預設庫或第一個非系統庫。
 * 供主查詢編輯器、CreateView、ViewDesigner、Routines 等共用，行為一致。
 */
export function useSqlSchema(
  connId: string | null,
  kind: DbKind | undefined,
  databaseOverride?: string | null,
): SQLNamespace | undefined {
  const storeDb = useStore((s) => s.connections.find((c) => c.id === connId)?.database ?? null);
  const database = databaseOverride !== undefined ? databaseOverride : storeDb;
  const [schema, setSchema] = useState<SQLNamespace | undefined>(undefined);
  useEffect(() => {
    if (!connId || !kind || !SCHEMA_KINDS.includes(kind)) {
      setSchema(undefined);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const dbs = await api.listDatabases(connId);
        if (cancelled) return;
        const userDbs = dbs.filter((d) => !isSystemDatabase(kind, d));
        const primary = database && dbs.includes(database) ? database : userDbs[0] ?? dbs[0];
        if (!primary) return;
        const cacheKey = `${connId}:${primary}`;
        const cached = schemaCache.get(cacheKey);
        if (cached) {
          setSchema(cached);
          return;
        }
        const tables = await api.listTables(connId, primary);
        if (cancelled) return;
        const ns: Record<string, string[]> = {};
        for (const t of tables) ns[t.name] = []; // 先放表名，FROM/JOIN 後可立即補全
        setSchema({ ...ns } as SQLNamespace);
        // 背景補欄名：限量 80 張、併發 6，個別失敗略過，不影響整體。
        const targets = tables.slice(0, 80);
        let idx = 0;
        const worker = async () => {
          while (idx < targets.length && !cancelled) {
            const t = targets[idx++];
            try {
              const cols = await api.tableColumns(connId, primary, t.name);
              ns[t.name] = cols.map((c) => c.name);
            } catch {
              /* 略過個別表的欄位載入失敗 */
            }
          }
        };
        await Promise.all(Array.from({ length: 6 }, worker));
        if (cancelled) return;
        const finalNs = { ...ns } as SQLNamespace;
        schemaCache.set(cacheKey, finalNs);
        setSchema(finalNs);
      } catch {
        /* 列舉失敗：無自動完成 schema（不致命） */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId, kind, database]);
  return schema;
}
