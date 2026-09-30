// 比對分頁兩邊的讀寫：本機直接讀寫；遠端先下載到分頁的暫存資料夾（後端 cmp_fetch），
// 存檔時寫回暫存副本再上傳（cmp_put），並用開啟時的 mtime / 大小偵測別人是否改過。
import { api } from "./api";
import type { CmpText, SideSpec } from "./compareTypes";
import type { Endpoint } from "./compareTabs";

/** 連線就緒後的一邊（遠端已有 sftpId、路徑已展開 `~`）。 */
export type ReadySide =
  | { kind: "local"; path: string }
  | { kind: "remote"; sftpId: string; path: string; host: string }
  | { kind: "paste"; text: string };

/** 遠端路徑的 `~` / 空白 → 登入後的家目錄。 */
export function expandHome(path: string, home: string): string {
  const p = path.trim();
  if (!p || p === "~") return home || ".";
  if (p.startsWith("~/")) return `${home.replace(/\/+$/, "")}/${p.slice(2)}`;
  return p;
}

export function readySide(ep: Endpoint, remote: { sftpId: string | null; home: string }): ReadySide | null {
  if (ep.side === "local") return { kind: "local", path: ep.path };
  if (ep.side === "paste") return { kind: "paste", text: ep.text };
  if (!remote.sftpId) return null;
  return { kind: "remote", sftpId: remote.sftpId, path: expandHome(ep.path, remote.home), host: ep.label };
}

export function sideSpec(s: ReadySide): SideSpec {
  if (s.kind === "local") return { kind: "local", path: s.path };
  if (s.kind === "remote") return { kind: "remote", sftp_id: s.sftpId, path: s.path };
  throw new Error("paste side has no file system");
}

/** 一邊某個檔的完整路徑（資料夾比對雙擊子項目時用）：根 + 相對路徑。 */
export function childSide(s: ReadySide, rel: string): ReadySide {
  if (s.kind === "paste" || !rel) return s;
  const sep = s.kind === "local" && s.path.includes("\\") && !s.path.includes("/") ? "\\" : "/";
  const base = s.path.replace(/[\\/]+$/, "");
  const joined = `${base}${sep}${rel.split("/").join(sep)}`;
  return { ...s, path: joined };
}

export const newJobId = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/** 讀進來的文字與存檔需要的基準。 */
export interface LoadedText extends CmpText {
  /** 本機檔路徑（遠端 = 暫存副本；貼上 = null）。 */
  localPath: string | null;
  /** 遠端檔開啟時的屬性（存檔衝突偵測用）。 */
  remoteMtime: number | null;
  remoteSize: number | null;
}

export async function loadText(scope: string, s: ReadySide): Promise<LoadedText> {
  if (s.kind === "paste") {
    return { text: s.text, truncated: false, size: s.text.length, mtime: null, lossy: false, binary: false, localPath: null, remoteMtime: null, remoteSize: null };
  }
  if (s.kind === "local") {
    const r = await api.cmpLocalReadText(s.path);
    return { ...r, localPath: s.path, remoteMtime: null, remoteSize: null };
  }
  const f = await api.cmpFetch(newJobId(), scope, s.sftpId, s.path);
  const r = await api.cmpLocalReadText(f.local);
  return { ...r, localPath: f.local, remoteMtime: f.mtime, remoteSize: f.size };
}

/**
 * 存檔。`force` = 不檢查是否被別人改過（使用者在衝突提示裡選了「照樣覆蓋」）。
 * 回傳更新過的基準（下一次存檔以它為準）。衝突時 reject，code 為 ERR_COMPARE_CONFLICT。
 */
export async function saveText(s: ReadySide, loaded: LoadedText, content: string, force: boolean): Promise<LoadedText> {
  if (s.kind === "paste" || !loaded.localPath) throw new Error("paste side cannot be saved");
  if (s.kind === "local") {
    const st = await api.cmpLocalWriteText(s.path, content, force ? null : loaded.mtime);
    return { ...loaded, text: content, size: st.size, mtime: st.mtime };
  }
  const local = await api.cmpLocalWriteText(loaded.localPath, content, null);
  const st = await api.cmpPut(newJobId(), s.sftpId, loaded.localPath, s.path, force ? null : loaded.remoteMtime, force ? null : loaded.remoteSize);
  return { ...loaded, text: content, size: local.size, mtime: local.mtime, remoteMtime: st.mtime, remoteSize: st.size };
}

/** 一邊的檔案在本機的路徑（二進位比對用；遠端先下載）。 */
export async function localPathOf(scope: string, s: ReadySide): Promise<string> {
  if (s.kind === "local") return s.path;
  if (s.kind === "remote") return (await api.cmpFetch(newJobId(), scope, s.sftpId, s.path)).local;
  throw new Error("paste side has no file");
}
