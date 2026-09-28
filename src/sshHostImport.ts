// 匯入主機的純函式：候選主機 → SshSession、辨認已經有的主機、來源資料夾對應成主機資料夾名稱。
import { blankSshSession, type SshImportCandidate, type SshSession, type SshStoredKey } from "./sshTypes";
import { keystoreRef } from "./sshKeys";

/** 同一台主機的判準：使用者 + 主機 + 埠（不分大小寫）。 */
export function hostKey(user: string, host: string, port: number): string {
  return `${user.trim().toLowerCase()}@${host.trim().toLowerCase()}:${port || 22}`;
}

/** 哪些候選主機已經在清單裡（回傳它們的索引）。 */
export function existingIndexes(cands: readonly SshImportCandidate[], sessions: readonly SshSession[]): Set<number> {
  const have = new Set(sessions.map((s) => hostKey(s.username, s.host, s.port)));
  const out = new Set<number>();
  cands.forEach((c, i) => { if (have.has(hostKey(c.username, c.host, c.port))) out.add(i); });
  return out;
}

/** 來源的子資料夾（`PROD/web`）→ 主機資料夾名稱（資料夾不巢狀，用 ` / ` 接起來）。 */
export function folderLabel(folder: string | null | undefined): string | null {
  const parts = (folder ?? "").split("/").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts.join(" / ") : null;
}

const TERM_TYPES = new Set(["xterm-256color", "xterm", "vt100", "linux"]);

/**
 * 候選主機 → 新的 SshSession。有私鑰檔 → 私鑰認證並帶上憑證；.xsh 參照的金鑰若在金鑰庫找得到同名的
 * （使用者先匯出再匯入過）就直接接上；其餘先設成密碼認證（連線時詢問）。
 */
export function candidateToSession(
  c: SshImportCandidate,
  id: string,
  folderId: string | null,
  keys: readonly SshStoredKey[] = [],
): SshSession {
  const s = blankSshSession(id, folderId);
  const stored = c.xshell_key
    ? keys.find((k) => k.name.trim().toLowerCase() === c.xshell_key!.trim().toLowerCase())
    : undefined;
  const keyPath = c.identity_file ?? (stored ? keystoreRef(stored.id) : null);
  return {
    ...s,
    name: c.name,
    host: c.host,
    port: c.port || 22,
    username: c.username,
    auth: keyPath ? "key" : "password",
    private_key_path: keyPath ?? "",
    certificate_path: keyPath ? (c.certificate_file ?? "") : "",
    options: { ...s.options, term: c.term && TERM_TYPES.has(c.term) ? c.term : s.options.term },
  };
}
