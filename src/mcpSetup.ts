// 「MCP 設定」對話框的型別與純邏輯（可測，不碰 React / Tauri）。
// 後端：src-tauri/src/commands/mcp.rs（命令）、src-tauri/src/mcp_setup.rs（設定片段與合併寫入，與 `dbk mcp config|install` 共用）。

import { create } from "zustand";
import type { ConnectionConfig, DbKind } from "./api";

/** 對話框開關（設定頁、連線右鍵都能開；從右鍵開時預選該連線）。 */
export const useMcpDialog = create<{ open: boolean; connId: string | null; show: (connId?: string | null) => void; close: () => void }>(
  (set) => ({
    open: false,
    connId: null,
    show: (connId) => set({ open: true, connId: connId ?? null }),
    close: () => set({ open: false }),
  }),
);

export type McpClientId = "claude-code" | "codex" | "cursor" | "vscode" | "claude-desktop" | "windsurf" | "json";

export interface McpClientInfo {
  id: McpClientId;
  label: string;
  supportsProject: boolean;
  supportsHttp: boolean;
  format: "json" | "toml";
}

/** `dbk mcp` 的伺服器選項（對應 Rust `mcp_setup::ServerArgs`，camelCase）。 */
export interface McpServerArgs {
  /** 單一連線（已存連線 id）；null = 多連線模式。 */
  conn?: string | null;
  database?: string | null;
  /** 多連線模式只開放這些連線（id）；空 = 全部。 */
  connections?: string[];
  tools?: string[];
  allowWrite?: boolean;
  allowDestructive?: boolean;
  allowProd?: boolean;
  out?: string | null;
  lang?: string | null;
}

export interface McpHttpStatus {
  running: boolean;
  url: string;
  port: number;
  token: string;
  server: McpServerArgs | null;
  log: string[];
  error: string | null;
}

export interface McpSetupInfo {
  dbkPath: string | null;
  clients: McpClientInfo[];
  http: McpHttpStatus;
}

export interface McpSetupReq {
  client: McpClientId;
  name?: string | null;
  project?: string | null;
  server: McpServerArgs;
  http: boolean;
}

export interface McpSnippet {
  client: McpClientId;
  language: "json" | "toml";
  text: string;
  path: string | null;
  cli: string | null;
  notes: string[];
}

export interface McpPreview {
  name: string;
  snippet: McpSnippet;
  installed: boolean;
  dbkMissing: boolean;
}

export interface McpInstallOutcome {
  path: string;
  backup: string | null;
  replaced: boolean;
  content: string;
}

/** dbk（slim CLI）支援的連線種類；訊息佇列 / 搜尋引擎 / 容器類只有 GUI 能開。 */
const CLI_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "mongo", "redis", "mssql", "oracle"];
/** 寫入工具（審查並執行）支援的種類。 */
const WRITE_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "mssql", "oracle"];

export function isMcpKind(kind: DbKind): boolean {
  return CLI_KINDS.includes(kind);
}

export function isWritableKind(kind: DbKind): boolean {
  return WRITE_KINDS.includes(kind);
}

export function isProd(c: Pick<ConnectionConfig, "options">): boolean {
  return c.options?.prod === "1";
}

/** 對話框的選項狀態 → 伺服器選項。寫入子旗標只在開寫入時帶。 */
export interface McpFormState {
  scope: "all" | "one";
  connId: string | null;
  database: string;
  /** scope = all 時的白名單（空 = 全部）。 */
  only: string[];
  allowWrite: boolean;
  allowDestructive: boolean;
  allowProd: boolean;
}

export function serverArgsOf(f: McpFormState): McpServerArgs {
  const one = f.scope === "one" && !!f.connId;
  return {
    conn: one ? f.connId : null,
    database: one && f.database.trim() ? f.database.trim() : null,
    connections: one ? [] : f.only,
    tools: [],
    allowWrite: f.allowWrite,
    allowDestructive: f.allowWrite && f.allowDestructive,
    allowProd: f.allowWrite && f.allowProd,
  };
}

/** 兩組伺服器選項是否等價（忽略語言與空值寫法）：HTTP 伺服器執行中、選項卻改了 → 要提示重啟。 */
export function sameServerArgs(a: McpServerArgs | null | undefined, b: McpServerArgs | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: McpServerArgs) => ({
    conn: s.conn || null,
    database: (s.conn && s.database) || null,
    connections: s.conn ? [] : [...(s.connections ?? [])].sort(),
    tools: [...(s.tools ?? [])].sort(),
    allowWrite: !!s.allowWrite,
    allowDestructive: !!s.allowWrite && !!s.allowDestructive,
    allowProd: !!s.allowWrite && !!s.allowProd,
  });
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** 這組選項實際能寫入的連線數（給摘要用）。 */
export function writableCount(conns: Pick<ConnectionConfig, "id" | "kind" | "options">[], f: McpFormState): number {
  if (!f.allowWrite) return 0;
  const pool = f.scope === "one" ? conns.filter((c) => c.id === f.connId) : f.only.length ? conns.filter((c) => f.only.includes(c.id)) : conns;
  return pool.filter((c) => isMcpKind(c.kind) && isWritableKind(c.kind) && (!isProd(c) || f.allowProd)).length;
}
