// SSH 終端機分頁的純邏輯：鍵的形狀、分頁列鍵序、關閉後的落點。
// 抽出 store 之外是為了能在 node 下單元測試，也讓 App.tsx 的鍵盤切換（Ctrl+Tab / Ctrl+1..9）
// 與 store 的落點計算共用同一份順序定義，不會一邊算「表 → 查詢 → SSH」、另一邊算成別的。
import type { SshTargetRef } from "./sshTypes";

/** SSH 分頁鍵前綴；後面接 uuid（分頁可重複開同一台主機，不能拿 session id 當鍵）。 */
export const SSH_TAB_PREFIX = "__ssh__:";

/** 一個開啟中的 SSH 終端機分頁（只放「要連去哪」與標題；xterm 實例與連線狀態在 sshTerminals.ts）。 */
export interface SshTab {
  key: string;
  target: SshTargetRef;
  /** 分頁列顯示：session 名稱或 user@host；可由使用者重新命名或由 OSC 標題更新。 */
  title: string;
  /** target 為 `connection` 時的資料庫連線 id（AI 上下文用來決定要不要附 DB 資訊）。 */
  connId?: string;
  /** target 為 `session` 時的主機 id（側欄高亮 / 重連時重讀設定）。 */
  sessionId?: string;
}

export function isSshTabKey(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(SSH_TAB_PREFIX) && v.length > SSH_TAB_PREFIX.length;
}

export function newSshTabKey(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return SSH_TAB_PREFIX + id;
}

/** 分頁列的完整鍵序：表分頁 → 查詢分頁 → SSH 分頁（與 MainArea 的渲染順序一致）。 */
export function tabOrder(tabs: readonly { key: string }[], queryTabs: readonly string[], sshTabs: readonly { key: string }[]): string[] {
  return [...tabs.map((t) => t.key), ...queryTabs, ...sshTabs.map((t) => t.key)];
}

/**
 * 關閉分頁後的落點：preferred 仍存在就留在原地，否則優先最後一個表分頁，再來第一個查詢分頁，
 * 最後才是最後一個 SSH 分頁。三種分頁可同時歸零（分頁列只剩「+」，主區顯示空狀態），此時回 null。
 * SSH 排最後：它是獨立於資料庫的工作區，關掉表 / 查詢時使用者通常還在資料庫脈絡裡。
 */
export function landingKey(
  tabs: readonly { key: string }[],
  queryTabs: readonly string[],
  sshTabs: readonly { key: string }[],
  preferred: string | null,
): string | null {
  if (
    preferred &&
    (tabs.some((t) => t.key === preferred) || queryTabs.includes(preferred) || sshTabs.some((t) => t.key === preferred))
  ) {
    return preferred;
  }
  if (tabs.length) return tabs[tabs.length - 1].key;
  if (queryTabs.length) return queryTabs[0];
  return sshTabs.length ? sshTabs[sshTabs.length - 1].key : null;
}

/**
 * 關掉某個 SSH 分頁後，該落到哪個鄰居：優先原位置（右邊那個滑進來），沒有就左邊那個。
 * 回 null 代表沒有其他 SSH 分頁了（交給 landingKey 退回表 / 查詢分頁）。
 */
export function neighborSshKey(sshTabs: readonly { key: string }[], closing: string): string | null {
  const i = sshTabs.findIndex((t) => t.key === closing);
  if (i < 0) return null;
  const rest = sshTabs.filter((t) => t.key !== closing);
  if (!rest.length) return null;
  return rest[Math.min(i, rest.length - 1)].key;
}
