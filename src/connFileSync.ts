// 連線清單「磁碟 → 記憶體」合併（純函式；hook 在 useConnFileSync.ts，拆開是因為 store 模組載入時會碰 localStorage）。
import type { ConnectionConfig } from "./api";

/** 以磁碟清單為準（順序、增刪、非機密欄位），記憶體中同 id 的連線保留磁碟沒有的欄位（secret）。 */
export function mergeSavedConnections(mem: ConnectionConfig[], saved: ConnectionConfig[]): ConnectionConfig[] {
  const byId = new Map(mem.map((c) => [c.id, c]));
  return saved.map((c) => {
    const old = byId.get(c.id);
    // group_id 磁碟沒有這個鍵 = 未分組（後端 skip_serializing_if），不能讓記憶體的舊值殘留下來。
    return old
      ? { ...old, ...c, group_id: c.group_id ?? null, password: old.password ?? "" }
      : { ...c, password: c.password ?? "" };
  });
}
