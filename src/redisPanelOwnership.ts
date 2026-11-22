// Redis 背景面板（Pub/Sub / MONITOR）的活實例登記：後端任務按 connId 只有一份，
// 從側欄與分頁工具列各開一個面板時，關閉其中一個不該把另一個的任務一起停掉。

const owners = new Map<string, Set<string>>();

/** 回傳此連線目前有幾個面板在用。 */
export function acquireRedisPanel(connId: string, ownerId: string): number {
  let set = owners.get(connId);
  if (!set) { set = new Set(); owners.set(connId, set); }
  set.add(ownerId);
  return set.size;
}

/** 除了自己以外還有別的面板在用嗎？ explicit stop 時用來避免誤停共用任務。 */
export function hasOtherRedisPanel(connId: string, ownerId: string): boolean {
  const set = owners.get(connId);
  return !!set && set.size > (set.has(ownerId) ? 1 : 0);
}

/** 回傳釋放後還剩幾個面板；為 0 時呼叫端才可以真的停止後端任務。 */
export function releaseRedisPanel(connId: string, ownerId: string): number {
  const set = owners.get(connId);
  if (!set) return 0;
  set.delete(ownerId);
  if (set.size === 0) owners.delete(connId);
  return set.size;
}
