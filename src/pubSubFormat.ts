// 後端 redis-pubsub-error / kafka-error 是全域廣播的字串，訊息前面帶 "{connId}: " 供前端分辨。
// 不過濾的話，A 連線的背景任務失敗會顯示在 B 連線打開的面板裡。

/** 屬於這條連線的錯誤回傳去掉前綴後的訊息；別的連線回 null。 */
export function prefixedErrorForConn(msg: string, connId: string): string | null {
  const prefix = `${connId}:`;
  return msg.startsWith(prefix) ? msg.slice(prefix.length).trimStart() : null;
}

/** 舊名稱保留，Redis 相關呼叫點不用改。 */
export const pubSubErrorForConn = prefixedErrorForConn;
