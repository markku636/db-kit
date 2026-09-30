// 比對分頁的純邏輯：鍵的形狀、兩邊來源的型別與顯示名稱。分頁列順序與關閉落點沿用 sshTabs.ts
// （比對分頁排在遠端桌面之後，store 的 wsTabs 把 SSH / 遠端桌面 / 比對合成同一段「工作區分頁」）。
import type { SshTargetRef } from "./sshTypes";

/** 比對分頁鍵前綴；後面接 uuid。 */
export const CMP_TAB_PREFIX = "__cmp__:";

export type CompareMode = "text" | "folder" | "binary";

/**
 * 比對的一邊。
 * - `local`：本機檔案 / 資料夾。
 * - `remote`：已存的 SSH / SFTP / FTP 主機上的路徑（分頁自己開一條連線，不借用終端機分頁的）。
 * - `paste`：直接貼上的文字（只有文字比對用得到，也不能存檔）。
 */
export type Endpoint =
  | { side: "local"; path: string }
  | { side: "remote"; target: SshTargetRef; sessionId?: string; label: string; path: string }
  | { side: "paste"; text: string };

export interface CompareTab {
  key: string;
  mode: CompareMode;
  /** 兩邊都有才開始比；缺任一邊時分頁顯示啟動畫面（選來源）。 */
  left: Endpoint | null;
  right: Endpoint | null;
  title: string;
  /** 從「已存的比對」開的：「儲存」時更新那一筆，而不是另存一筆。 */
  savedId?: string;
  /** 資料夾比對的規則（排除、準則、同步規則）；沒有 = 用上次的設定。 */
  folder?: import("./compareSessions").FolderSettings;
}

export function isCompareTabKey(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(CMP_TAB_PREFIX) && v.length > CMP_TAB_PREFIX.length;
}

export function newCompareTabKey(): string {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return CMP_TAB_PREFIX + id;
}

/** 路徑最後一段（本機的 `\` 與遠端的 `/` 都認）。根目錄回原字串。 */
export function pathBase(p: string): string {
  const t = p.replace(/[\\/]+$/, "");
  if (!t) return p;
  const i = Math.max(t.lastIndexOf("/"), t.lastIndexOf("\\"));
  return i >= 0 ? t.slice(i + 1) || t : t;
}

/** 一邊的簡短名稱（分頁標題用）。`pasteLabel` 由呼叫端給譯好的「貼上的文字」。 */
export function endpointShort(ep: Endpoint | null, pasteLabel: string): string {
  if (!ep) return "?";
  if (ep.side === "paste") return pasteLabel;
  return pathBase(ep.path) || (ep.side === "remote" ? ep.label : ep.path);
}

/** 一邊的完整描述（工具列 / 提示用）：遠端加上主機名。 */
export function endpointLong(ep: Endpoint | null, pasteLabel: string): string {
  if (!ep) return "";
  if (ep.side === "paste") return pasteLabel;
  if (ep.side === "remote") return `${ep.label}:${ep.path}`;
  return ep.path;
}

/** 分頁標題：兩邊同名就只寫一次（最常見：同一個檔在兩台機器上）。 */
export function compareTitle(left: Endpoint | null, right: Endpoint | null, pasteLabel: string): string {
  const a = endpointShort(left, pasteLabel);
  const b = endpointShort(right, pasteLabel);
  return a === b ? a : `${a} ↔ ${b}`;
}

/** 兩個來源是否同一個（避免「自己跟自己比」）。 */
export function sameEndpoint(a: Endpoint | null, b: Endpoint | null): boolean {
  if (!a || !b || a.side !== b.side) return false;
  if (a.side === "paste" || b.side === "paste") return false;
  if (a.side === "local" && b.side === "local") return a.path.replace(/[\\/]+$/, "").toLowerCase() === b.path.replace(/[\\/]+$/, "").toLowerCase();
  if (a.side === "remote" && b.side === "remote") return JSON.stringify(a.target) === JSON.stringify(b.target) && a.path === b.path;
  return false;
}

/** 資料夾比對裡某個子項目的來源（根 + 以 `/` 分段的相對路徑）。本機用根路徑本來的分隔字元。 */
export function childEndpoint(ep: Endpoint, rel: string): Endpoint {
  if (ep.side === "paste" || !rel) return ep;
  if (ep.side === "remote") {
    const base = ep.path.trim() === "" ? "~" : ep.path.replace(/\/+$/, "");
    return { ...ep, path: `${base || "/"}/${rel}`.replace(/^\/\//, "/") };
  }
  const sep = ep.path.includes("\\") || /^[A-Za-z]:$/.test(ep.path) ? "\\" : "/";
  const base = ep.path.replace(/[\\/]+$/, "");
  return { ...ep, path: `${base}${sep}${rel.split("/").join(sep)}` };
}

/** 對調左右（啟動畫面的「⇄」與比對視圖的「交換兩邊」）。 */
export function swapSides(tab: Pick<CompareTab, "left" | "right">): Pick<CompareTab, "left" | "right"> {
  return { left: tab.right, right: tab.left };
}
