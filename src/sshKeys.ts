// SSH 使用者金鑰的純函式（金鑰庫參照、顯示用標籤、憑證摘要）。後端在 src-tauri/src/ssh/keys.rs。
import { KEYSTORE_PREFIX, type SshCertInfo, type SshSession, type SshStoredKey } from "./sshTypes";

export function isKeystoreRef(p: string | null | undefined): boolean {
  return !!p && p.trim().startsWith(KEYSTORE_PREFIX);
}

/** `keystore:<id>` → id；不是參照回 null。 */
export function keystoreId(p: string | null | undefined): string | null {
  if (!isKeystoreRef(p)) return null;
  const id = p!.trim().slice(KEYSTORE_PREFIX.length);
  return id || null;
}

export function keystoreRef(id: string): string {
  return `${KEYSTORE_PREFIX}${id}`;
}

/** `ssh-ed25519` → `Ed25519`、`ssh-rsa` + 3072 → `RSA 3072`、`ecdsa-sha2-nistp256` → `ECDSA P-256`。 */
export function keyTypeLabel(algorithm: string, bits: number | null | undefined): string {
  const a = algorithm.toLowerCase();
  if (a === "ssh-ed25519") return "Ed25519";
  if (a === "ssh-rsa" || a.startsWith("rsa-sha2")) return bits ? `RSA ${bits}` : "RSA";
  const ec = /^ecdsa-sha2-nistp(\d+)$/.exec(a);
  if (ec) return `ECDSA P-${ec[1]}`;
  if (a.startsWith("sk-")) return a.includes("ed25519") ? "Ed25519-SK (FIDO)" : "ECDSA-SK (FIDO)";
  if (a === "ssh-dss") return "DSA";
  return algorithm;
}

/** `SHA256:abcdef…` 取前段給列表顯示（完整指紋放 title）。 */
export function shortFingerprint(fp: string, keep = 16): string {
  const m = /^(SHA256:|MD5:)?(.*)$/.exec(fp);
  const body = m?.[2] ?? fp;
  return body.length > keep ? `${m?.[1] ?? ""}${body.slice(0, keep)}…` : fp;
}

/** 後端的 u64::MAX 經 JSON 會失真成約 1.8e19：大於 2^53 一律視為永久有效。 */
export function certForever(validBefore: number): boolean {
  return validBefore >= Number.MAX_SAFE_INTEGER;
}

export type CertTone = "ok" | "warn" | "bad";

/** 憑證一行摘要的語意（給狀態列著色）：過期 / 尚未生效 / 不是這把金鑰的 = bad；七天內到期 = warn。 */
export function certTone(c: SshCertInfo, nowSecs: number): CertTone {
  if (c.validity !== "valid" || c.matches_key === false) return "bad";
  if (!certForever(c.valid_before) && c.valid_before - nowSecs < 7 * 24 * 3600) return "warn";
  return "ok";
}

/** 哪些主機用了金鑰庫裡的這把金鑰（刪除前提醒用）。 */
export function sessionsUsingKey(sessions: readonly SshSession[], id: string): SshSession[] {
  const ref = keystoreRef(id);
  return sessions.filter((s) => s.auth === "key" && s.private_key_path.trim() === ref);
}

/** 匯入時的預設名稱：金鑰註解，其次檔名（去掉常見副檔名）。 */
export function defaultKeyName(comment: string | null | undefined, path: string | null | undefined): string {
  if (comment && comment.trim()) return comment.trim();
  const base = (path ?? "").split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(ppk|pem|key|der|p8|txt)$/i, "");
}

/** 金鑰庫排序：名稱（自然排序）。 */
export function sortStoredKeys(keys: readonly SshStoredKey[]): SshStoredKey[] {
  return [...keys].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
