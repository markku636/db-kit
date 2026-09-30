// 遠端桌面分頁的純邏輯：鍵的形狀。分頁列順序與關閉落點沿用 sshTabs.ts（遠端桌面分頁排在 SSH 分頁之後，
// store 把兩組合起來當成同一段「工作區分頁」傳給 landingKey / tabOrder）。
import type { RdProtocol, RdTargetRef } from "./rdTypes";

/** 遠端桌面分頁鍵前綴；後面接 uuid（同一台可以開多個分頁）。 */
export const RD_TAB_PREFIX = "__rd__:";

/** 一個開啟中的遠端桌面分頁（只放「要連去哪」與標題；canvas / noVNC 實例與連線狀態在 RdPane 裡）。 */
export interface RdTab {
  key: string;
  target: RdTargetRef;
  protocol: RdProtocol;
  title: string;
  /** target 為 `session` 時的主機 id（側欄高亮、重連時重讀設定）。 */
  sessionId?: string;
  /** 連上就進全螢幕（側欄「全螢幕連線」、.rdp 的 screen mode id:i:2）。放在分頁上的理由同 SshTab.openSftp。 */
  fullscreen?: boolean;
}

export function isRdTabKey(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(RD_TAB_PREFIX) && v.length > RD_TAB_PREFIX.length;
}

export function newRdTabKey(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return RD_TAB_PREFIX + id;
}
