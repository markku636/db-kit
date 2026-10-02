// 遠端桌面（RDP / VNC / RustDesk）的前後端共用 DTO。
// 欄位名與 Rust serde 完全鏡射（snake_case；tagged enum 用 `kind`），前端不做任何改名轉換。
// 放獨立檔而非 api.ts：純邏輯模組（rdTabs / rdConnString / rdpFile）只 `import type`，不拖進 invoke。

/** 協定；對映 Rust `rd::sessions::RdProtocol`。 */
export type RdProtocol = "rdp" | "vnc" | "rustdesk";

/**
 * 畫面尺寸跟視窗的關係：
 * - `scale`：遠端解析度固定，本地縮放填滿（預設）。
 * - `remote`：分頁大小變了就請遠端改解析度（RDP 動態解析度 / VNC ExtendedDesktopSize）。
 * - `none`：1:1 顯示，超出就捲動。
 */
export type RdResizeMode = "scale" | "remote" | "none";

/**
 * VNC 認證偏好。`auto` = 依伺服器提供的類型挑最好的（有帳號優先 ARD；伺服器有 VeNCrypt 就走 TLS 加密；其次 VNC 密碼、None）。
 * `ard` 是 macOS 螢幕共享（Apple Remote Desktop，type 30，需要 Mac 帳號 + 密碼）。
 * `tls` = 一定要 VeNCrypt 加密（匿名 TLS 或 X509 憑證）；`plain` = VeNCrypt 帳號 + 密碼（有 TLS 就套 TLS）。
 */
export type VncSecurity = "auto" | "none" | "vnc" | "ard" | "plain" | "tls";

/** 連線選項。全部有預設值（舊檔 / 前端漏欄位都能讀）；`ui` 是前端自己的偏好，後端只存。 */
export interface RdOptions {
  resize_mode: RdResizeMode;
  /** RDP 色深（16 / 24 / 32）；xrdp 的 16-bit 有解碼問題，預設 32。 */
  color_depth: number;
  /** RDP 固定解析度（`resize_mode` 不是 `remote` 時用）；0 = 跟分頁大小。 */
  width: number;
  height: number;
  /** RDP 網路層級驗證（CredSSP / NLA）；關掉 = 只走 TLS（舊主機 / 本機帳號 NLA 失敗時的退路）。 */
  nla: boolean;
  /** 只看不控（VNC ViewOnly；RDP 不送輸入）。 */
  view_only: boolean;
  /** 同步剪貼簿（文字）。 */
  clipboard: boolean;
  vnc_security: VncSecurity;
  /** VNC 共享模式（ClientInit shared-flag）：true = 不踢掉其他檢視者。 */
  vnc_shared: boolean;
  /** RustDesk：ID 伺服器（空 = 公開伺服器）、伺服器公鑰（Key）、強制走中繼、中繼伺服器（空 = 用 ID 伺服器告知的）。 */
  rustdesk_server: string;
  rustdesk_key: string;
  rustdesk_relay: boolean;
  rustdesk_relay_server: string;
  /** 連線逾時秒數；0 → 20 秒。 */
  connect_timeout_secs: number;
  ui: Record<string, string>;
}

/**
 * 已儲存的遠端桌面主機。刻意沒有密碼欄位——秘密只進 OS keychain（`{id}.rdsess`），永不落地、永不回前端。
 * RustDesk 的 `host` 放對方的 ID（經 ID 伺服器）或位址（Direct IP；有 `.` / `:` 的就是位址）。
 */
export interface RdSession {
  id: string;
  name: string;
  protocol: RdProtocol;
  host: string;
  /** 0 = 協定預設（RDP 3389、VNC 5900、RustDesk Direct IP 21118）。 */
  port: number;
  username: string;
  /** RDP 網域（`DOMAIN\user` 的 DOMAIN）；其他協定不用。 */
  domain: string;
  /** 經哪台已存 SSH 主機連過去（direct-tcpip）；null = 直連。 */
  via_ssh_session_id: string | null;
  folder_id: string | null;
  options: RdOptions;
}

export interface RdFolder {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface RdSessionsFile {
  version: number;
  folders: RdFolder[];
  sessions: RdSession[];
}

export interface RdPlacement {
  id: string;
  folder_id: string | null;
}

/** 連線目標：已存主機（密碼從 keychain 取）或尚未存檔的輸入（對話框「測試連線」/ 快速連線）。 */
export type RdTargetRef =
  | { kind: "session"; id: string }
  | { kind: "ad_hoc"; session: RdSession; password?: string | null };

/** `local_list_dir` 的一項（檔案傳輸的本機窗格）。 */
export interface LocalEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number | null;
}

/** `local_list_dir` 的回傳：`path` 空字串 = Windows 的磁碟機清單；`parent` null = 最上層。 */
export interface LocalListing {
  path: string;
  parent: string | null;
  entries: LocalEntry[];
}

/** `rd_connect` 的回傳。 */
export interface RdConnInfo {
  conn_id: string;
  protocol: RdProtocol;
  width: number;
  height: number;
  /** 實際採用的安全層：`nla` / `tls` / `rdp` / `vnc-none` / `vnc-auth` / `ard` / `vencrypt-plain` / `vencrypt-tls-*`（VNC 匿名 TLS）/ `vencrypt-x509-*`（VNC 憑證 TLS）/ `rustdesk-direct`（Direct IP）/ `rustdesk-ssh` / `rustdesk-secure`（經 ID 伺服器、已加密）/ `rustdesk-id`（經 ID 伺服器、未加密）。 */
  security: string;
  /** 畫面內容是否加密（VNC 只有 VeNCrypt 的 TLS / X509 子型別有加密）。 */
  encrypted: boolean;
}

/** 後端事件 `rd-cert-prompt`：RDP 伺服器憑證首次出現或變更（TOFU）。 */
export interface RdCertPrompt {
  prompt_id: string;
  conn_id: string;
  host_id: string;
  fingerprint: string;
  subject: string;
  status: "new" | "changed";
  old_fingerprint?: string | null;
}

/** 後端事件 `rd-auth-prompt`：沒存密碼、或伺服器要帳號（ARD）時問使用者。 */
export interface RdAuthPrompt {
  prompt_id: string;
  conn_id: string;
  /** 要不要帳號欄（ARD / VeNCrypt Plain / RDP 沒存帳號時）。 */
  need_username: boolean;
  username: string;
  /** 前一次失敗的原因（重試時顯示）。 */
  error?: string | null;
  /** 不是錯誤的說明（RustDesk 等對方按接受時）。 */
  notice?: string | null;
  /** 問的是雙重驗證碼（RustDesk 對方開了 2FA）：答案放 `password`，不顯示「記住密碼」。 */
  otp?: boolean;
  /** 驗證碼對話框可勾「信任這台裝置」（對方允許時）：答案放 `remember`。 */
  can_trust?: boolean;
  /** 沒有欄位、只能取消：等 RustDesk 對方按「接受」（對方設成不收密碼）。 */
  wait?: boolean;
}

export interface RdAuthAnswer {
  username: string;
  password: string;
  /** 記住密碼（寫進 keychain；只有已存主機才有意義）。驗證碼對話框時 = 信任這台裝置。 */
  remember: boolean;
}

export type RdCertDecision = "accept_save" | "accept_once" | "reject";

export interface RdConnClosed {
  conn_id: string;
  reason: string | null;
}

export interface RdClipboardEvent {
  conn_id: string;
  text: string;
}

/** 前端執行期的連線狀態（不進後端）。 */
export type RdStatus = "connecting" | "connected" | "disconnected" | "error";

export const RD_PROTOCOLS: readonly RdProtocol[] = ["rdp", "vnc", "rustdesk"];

/** 協定預設 port（`port == 0` 時用）。 */
export function defaultRdPort(p: RdProtocol): number {
  return p === "rdp" ? 3389 : p === "vnc" ? 5900 : 21118;
}

export function effectiveRdPort(s: Pick<RdSession, "protocol" | "port">): number {
  return s.port > 0 ? s.port : defaultRdPort(s.protocol);
}

export function defaultRdOptions(): RdOptions {
  return {
    resize_mode: "scale",
    color_depth: 32,
    width: 0,
    height: 0,
    nla: true,
    view_only: false,
    clipboard: true,
    vnc_security: "auto",
    vnc_shared: true,
    rustdesk_server: "",
    rustdesk_key: "",
    rustdesk_relay: false,
    rustdesk_relay_server: "",
    connect_timeout_secs: 0,
    ui: {},
  };
}

/** 新主機的空白骨架（對話框「新增」用）；id 由呼叫端決定（通常 `crypto.randomUUID()`）。 */
export function blankRdSession(id: string, protocol: RdProtocol = "rdp", folderId: string | null = null): RdSession {
  return {
    id,
    name: "",
    protocol,
    host: "",
    port: 0,
    username: "",
    domain: "",
    via_ssh_session_id: null,
    folder_id: folderId,
    options: defaultRdOptions(),
  };
}
