// SSH 終端機 / SFTP 的前後端共用 DTO。
// 欄位名與 Rust serde 完全鏡射（snake_case；tagged enum 用 `kind`），前端不做任何改名轉換。
// 放獨立檔而非 api.ts：純邏輯模組（sshTabs / sshCapture / AI 提示）只 `import type`，不拖進 invoke。

/** 認證方式；對映 Rust `ssh::SshAuthKind`。 */
export type SshAuthKind = "password" | "key" | "agent" | "keyboard_interactive";

/** 終端機選項；後端只解讀 term / startup_command / keepalive / env，`ui` 是前端自己的（字級、配色等）。 */
export interface SshTermOptions {
  term: string;
  encoding: string;
  startup_command: string;
  keepalive_secs: number;
  connect_timeout_secs: number;
  env: Record<string, string>;
  ui: Record<string, string>;
}

/** 已儲存的 SSH 主機。刻意沒有 password / passphrase 欄位——秘密只進 OS keychain，永不落地、永不回前端。 */
export interface SshSession {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: SshAuthKind;
  /** 私鑰檔路徑，或金鑰庫參照 `keystore:<id>`。 */
  private_key_path: string;
  /** OpenSSH 使用者憑證；空 = 自動找私鑰旁邊的 `<私鑰>-cert.pub`。 */
  certificate_path: string;
  folder_id: string | null;
  options: SshTermOptions;
}

export interface SshFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface SshSessionsFile {
  version: number;
  folders: SshFolder[];
  sessions: SshSession[];
}

/** 側欄拖放 / 移到資料夾後回存的版面：每個 session 落在哪個資料夾（null = 未分類）。 */
export interface SshPlacement {
  id: string;
  folder_id: string | null;
}

/**
 * 連線目標。`connection` 是沿用資料庫連線的 SSH tunnel 設定（後端從 keychain 取憑證）；
 * `ad_hoc` 供「測試連線」與快速連線用，session 不落地，密碼直接帶過去。
 */
export type SshTargetRef =
  | { kind: "session"; id: string }
  | { kind: "connection"; id: string }
  | { kind: "ad_hoc"; session: SshSession; password?: string | null; passphrase?: string | null };

export interface SshConnInfo {
  conn_id: string;
  host: string;
  port: number;
  username: string;
}

export type SshHostKeyDecision = "accept_save" | "accept_once" | "reject";

/** 後端事件 `ssh-hostkey-prompt`：首次連線或指紋變更時要使用者決定。 */
export interface SshHostKeyPrompt {
  prompt_id: string;
  conn_id: string;
  host_id: string;
  key_type: string;
  fingerprint: string;
  status: "new" | "changed";
  old_fingerprint?: string | null;
}

/** 後端事件 `ssh-auth-prompt`：缺密碼 / 私鑰密語 / keyboard-interactive 時向使用者要答案。 */
export interface SshAuthPrompt {
  prompt_id: string;
  conn_id: string;
  kind: "password" | "passphrase" | "keyboard_interactive";
  name: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

/** 後端事件 `ssh-term-exit`。 */
export interface SshTermExit {
  term_id: string;
  status: number | null;
  signal: string | null;
}

/** 後端事件 `ssh-conn-closed`。 */
export interface SshConnClosed {
  conn_id: string;
  reason: string | null;
}

export interface SftpEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
  link_target_is_dir: boolean | null;
  size: number;
  /** 修改時間（秒，epoch）；伺服器沒給就是 null。 */
  mtime: number | null;
  permissions: number | null;
  /** `ls -l` 風格字串，如 "drwxr-xr-x"。 */
  mode: string;
  uid: number | null;
  gid: number | null;
  owner: string | null;
  group: string | null;
}

/** `ssh_sftp_read_text` 的結果：小檔預覽（上限 1 MiB），超過就截斷並標記。 */
export interface SftpText {
  text: string;
  truncated: boolean;
  size: number;
  /** 內容有無效的 UTF-8（畫面上已被替換字元取代）：照這份存回去會弄壞原檔，編輯器只給唯讀。 */
  lossy: boolean;
  /** 前 8 KiB 內有 NUL：幾乎確定是二進位檔。 */
  binary: boolean;
}

export interface SftpOpenInfo {
  sftp_id: string;
  home: string;
}

/** 後端事件 `ssh-sftp-progress`。 */
export interface SftpProgress {
  transfer_id: string;
  done: number;
  total: number | null;
  state: "running" | "done" | "error" | "cancelled";
  message?: string | null;
}

/** 批次傳輸時目的地已有同名項目：整批不開始 / 覆蓋（資料夾合併）/ 略過同名。 */
export type SftpOnConflict = "fail" | "overwrite" | "skip";

// ---- 使用者金鑰（後端 ssh/keys.rs） ----

/** 主機設定裡參照金鑰庫的前綴。 */
export const KEYSTORE_PREFIX = "keystore:";

export interface SshKeyInfo {
  /** 格式名（OpenSSH / PuTTY PPK v3 / PKCS#8 / PEM (PKCS#1 RSA), DES-EDE3-CBC …） */
  format: string;
  algorithm: string;
  bits: number | null;
  fingerprint: string;
  comment: string;
  encrypted: boolean;
  /** authorized_keys 那一行 */
  public_openssh: string;
}

export interface SshCertInfo {
  path: string;
  key_id: string;
  principals: string[];
  valid_after: number;
  /** u64::MAX（JSON 裡會失真成 ~1.8e19）= 永久有效 */
  valid_before: number;
  cert_type: "user" | "host";
  ca_fingerprint: string;
  matches_key: boolean | null;
  validity: "valid" | "expired" | "not_yet_valid";
}

export type SshKeyInspectStatus = "ok" | "need_passphrase" | "bad_passphrase" | "unsupported" | "invalid";

export interface SshKeyInspect {
  status: SshKeyInspectStatus;
  format: string | null;
  /** ok 時完整；要密語時若公鑰是明文存的（OpenSSH / PPK）也會先給 */
  info: SshKeyInfo | null;
  message: string | null;
  cert: SshCertInfo | null;
}

export interface SshStoredKey {
  id: string;
  name: string;
  algorithm: string;
  bits: number | null;
  fingerprint: string;
  comment: string;
  encrypted: boolean;
  source_format: string;
  created_at: number;
  has_cert: boolean;
}

export interface SshKeyImportOutcome {
  key: SshStoredKey;
  /** 同一把（指紋相同）早就在金鑰庫裡 */
  existed: boolean;
}

export type SshKeySource = { kind: "path"; path: string } | { kind: "text"; text: string };

export type SshKeyGenAlgorithm = "ed25519" | "ecdsa-p256" | "ecdsa-p384" | "rsa-3072" | "rsa-4096";

/** 前端執行期的連線狀態（不進後端）。 */
export type SshStatus = "connecting" | "connected" | "disconnected" | "error";

export const SSH_AUTH_KINDS: readonly SshAuthKind[] = ["password", "key", "agent", "keyboard_interactive"];

export function defaultSshTermOptions(): SshTermOptions {
  return {
    term: "xterm-256color",
    encoding: "utf-8",
    startup_command: "",
    keepalive_secs: 30,
    connect_timeout_secs: 0,
    env: {},
    ui: {},
  };
}

/** 新主機的空白骨架（對話框「新增」用）；id 由呼叫端決定（通常 `crypto.randomUUID()`）。 */
export function blankSshSession(id: string, folderId: string | null = null): SshSession {
  return {
    id,
    name: "",
    host: "",
    port: 22,
    username: "",
    auth: "password",
    private_key_path: "",
    certificate_path: "",
    folder_id: folderId,
    options: defaultSshTermOptions(),
  };
}
