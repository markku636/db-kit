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

/** 某個前綴（資料夾路徑）底下的所有鍵：前綴比對走原字串，不經 glob。 */
export function keysUnderPrefix(keys: readonly string[], prefix: string, separator: string = ":"): string[] {
  const sep = separator || ":";
  return keys.filter((k) => k === prefix || k.startsWith(prefix + sep));
}
