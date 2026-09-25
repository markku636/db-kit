// SFTP 面板的純邏輯：編輯器的換行 / 語言判斷 / 存檔衝突，以及權限（chmod）位元的換算。
// 不碰 DOM、不 import React，vitest 在 node 下就能測。

/** 編輯器只開這個大小以內的檔（與後端 read_small 的上限一致）；更大的只提供下載。 */
export const EDITABLE_MAX = 1024 * 1024;

export type Eol = "\n" | "\r\n";

/**
 * 原檔的換行慣例。CodeMirror 讀進來一律拆成行、`toString()` 一律用 `\n` 接回去，
 * 不記下來的話，改一個字就把整個 Windows 檔（CRLF）默默轉成 LF——diff 會是整份檔案。
 * 以多數決判斷：混用的檔案照原本占多數的那一種存回去。
 */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= lf ? "\r\n" : "\n";
}

/** 把編輯器內容（`\n`）換回原檔的換行。先正規化，避免使用者貼上的 `\r\n` 變成 `\r\r\n`。 */
export function applyEol(text: string, eol: Eol): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  return eol === "\n" ? normalized : normalized.replace(/\n/g, "\r\n");
}

/** CodeMirror 語言：只列專案裡已經有的語言包，其餘當純文字。 */
export type EditorLang = "json" | "javascript" | "sql" | null;

export function languageForFile(name: string): EditorLang {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  if (["json", "jsonc", "json5", "geojson"].includes(ext) || lower === ".babelrc" || lower === ".eslintrc") return "json";
  if (["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"].includes(ext)) return "javascript";
  if (ext === "sql") return "sql";
  return null;
}

/** 能不能在 App 內開：夠小（雙擊檔案時，大檔改成下載，不要把幾百 MB 的 log 塞進編輯器）。 */
export function canOpenInEditor(size: number): boolean {
  return size <= EDITABLE_MAX;
}

/** 存檔前的衝突判斷：開啟之後遠端的 mtime 或大小變了，代表有人（或程式）改過。 */
export function remoteChanged(
  base: { mtime: number | null; size: number },
  now: { mtime: number | null; size: number },
): boolean {
  if (base.mtime != null && now.mtime != null && base.mtime !== now.mtime) return true;
  return base.size !== now.size;
}

// ---- 權限（chmod）----

export type PermWho = "owner" | "group" | "other";
export type PermWhat = "r" | "w" | "x";

const SHIFT: Record<PermWho, number> = { owner: 6, group: 3, other: 0 };
const BIT: Record<PermWhat, number> = { r: 0o4, w: 0o2, x: 0o1 };

export function hasPerm(mode: number, who: PermWho, what: PermWhat): boolean {
  return (mode & (BIT[what] << SHIFT[who])) !== 0;
}

export function togglePerm(mode: number, who: PermWho, what: PermWhat): number {
  return mode ^ (BIT[what] << SHIFT[who]);
}

/** 權限位元（含 setuid / setgid / sticky）→ `0644` / `4755` 這種八進位字串；型別位元丟掉。 */
export function toOctal(mode: number): string {
  const m = mode & 0o7777;
  const s = m.toString(8);
  return m > 0o777 ? s.padStart(4, "0") : s.padStart(3, "0").padStart(4, "0");
}

/**
 * 使用者輸入的八進位（`644`、`0644`、`4755`）→ 數值；不合法回 null。
 * 只收 3～4 位、每位 0～7：`8`、`9`、`12345`、空字串都擋掉，免得一個打錯的數字變成 000。
 */
export function parseOctal(input: string): number | null {
  const s = input.trim();
  if (!/^[0-7]{3,4}$/.test(s)) return null;
  return parseInt(s, 8);
}

/** 對話框的預設值：沒有權限資訊（伺服器沒給）時，檔案給 0644、目錄給 0755。 */
export function defaultMode(permissions: number | null, isDir: boolean): number {
  if (permissions != null) return permissions & 0o7777;
  return isDir ? 0o755 : 0o644;
}
