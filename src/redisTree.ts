// Redis 鍵樹的純資料結構（仿 Another Redis Desktop Manager 的可設定 separator）。
// 從元件抽出來，才能單測不同分隔符、空片段、同名字首等情況。

export interface RedisTreeNode {
  seg: string;
  path: string;
  children: Map<string, RedisTreeNode>;
  /** 此節點本身也是一個完整 key 時的鍵名。 */
  leafKey?: string;
  /** 子樹內的鍵數（含自身）。 */
  count: number;
}

/** 依 separator 把 key 切成資料夾樹；空 separator 退回 ":"（ARDM 的 --separator 語意）。 */
export function buildRedisTree(keys: readonly string[], separator: string = ":"): RedisTreeNode {
  const sep = separator || ":";
  const root: RedisTreeNode = { seg: "", path: "", children: new Map(), count: 0 };
  for (const key of keys) {
    const parts = key.split(sep);
    let node = root;
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      acc = i === 0 ? parts[i] : `${acc}${sep}${parts[i]}`;
      let child = node.children.get(parts[i]);
      if (!child) {
        child = { seg: parts[i], path: acc, children: new Map(), count: 0 };
        node.children.set(parts[i], child);
      }
      node = child;
    }
    node.leafKey = key;
  }
  const count = (n: RedisTreeNode): number => {
    let c = n.leafKey != null ? 1 : 0;
    for (const ch of n.children.values()) c += count(ch);
    n.count = c;
    return c;
  };
  count(root);
  return root;
}

/** 空片段（user::profile、a:）要有可見標籤，不然樹上出現看不見的資料夾 / 鍵。 */
export function segmentLabel(seg: string): string {
  return seg === "" ? "‹空›" : seg;
}

/** 某個前綴（資料夾路徑）底下的所有鍵：前綴比對走原字串，不經 glob。 */
export function keysUnderPrefix(keys: readonly string[], prefix: string, separator: string = ":"): string[] {
  const sep = separator || ":";
  return keys.filter((k) => k === prefix || k.startsWith(prefix + sep));
}

/** 鍵樹多選：同一鍵再點一次取消，回傳新 Set（不改動傳入的集合）。 */
export function toggleKeySelection(selected: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export const REDIS_SEPARATOR_KEY = "dbkit:redisKeySeparator";
export const redisSeparatorKey = (connId: string, db?: string) => `${REDIS_SEPARATOR_KEY}:${connId}:${db ?? ""}`;

/** 讀取使用者選的分隔符（空值退回冒號）；供鍵樹外部的右鍵選單共用。 */
export function loadRedisSeparator(connId?: string, db?: string): string {
  try {
    return (localStorage.getItem(connId ? redisSeparatorKey(connId, db) : REDIS_SEPARATOR_KEY)
      ?? localStorage.getItem(REDIS_SEPARATOR_KEY)) || ":";
  } catch { return ":"; }
}

/** 由資料夾路徑產生前綴 / SCAN MATCH 樣式，跟著分隔符走。 */
export function redisNamespacePrefix(prefix: string, separator: string): string {
  return `${prefix}${separator || ":"}`;
}
export function redisNamespacePattern(prefix: string, separator: string): string {
  // 前綴是實際鍵名的一部份，裡面的 glob 字元要當字面處理（與後端 redis_prefix_glob 一致）。
  const literal = prefix.replace(/[\\*?\[\]]/g, "\\$&");
  return `${literal}${separator || ":"}*`;
}
