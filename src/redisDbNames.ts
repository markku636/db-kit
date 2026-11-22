// Redis DB 的自訂顯示名稱（ARDM 的 DB custom name）：只改側欄標籤，不影響實際 DB 索引。
// 以 `${connId}:${db}` 為 key 存在 localStorage，純函式便於單測。

export const REDIS_DB_NAMES_KEY = "dbkit:redisDbNames";
export type RedisDbNames = Record<string, string>;

const keyOf = (connId: string, db: string) => `${connId}:${db}`;

export function loadRedisDbNames(raw: string | null): RedisDbNames {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: RedisDbNames = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string" && val.trim()) out[k] = val.trim().slice(0, 40);
    }
    return out;
  } catch {
    return {};
  }
}

/** 空名稱＝移除自訂標籤，回到「DB 0」。 */
export function setRedisDbName(map: RedisDbNames, connId: string, db: string, name: string): RedisDbNames {
  const next = { ...map };
  const label = name.trim().slice(0, 40);
  if (label) next[keyOf(connId, db)] = label;
  else delete next[keyOf(connId, db)];
  return next;
}

export function redisDbLabel(map: RedisDbNames, connId: string, db: string): string | null {
  return map[keyOf(connId, db)] ?? null;
}

export function serializeRedisDbNames(map: RedisDbNames): string {
  return JSON.stringify(map);
}
