// 遠端桌面（RDP / VNC / RustDesk）連線字串。純函式（可單測），給遠端桌面主機對話框與貼上處理用：
// 主機欄 / 連線字串欄貼上 → 拆成協定 / 主機 / 埠 / 帳號 / 網域 / 選項。
//
// 認得的寫法：
//   - RDP：Microsoft 的 `rdp://full%20address=s:host:3389&username=s:CORP\alice&…` URI（`key=型別:值`，
//     也收沒有 `rdp://` 的）、一般 URL `rdp://[user[:pass]@]host[:port]`、`mstsc /v:host:port [/f] [/w: /h:]` 指令。
//   - VNC：RFC 7869 `vnc://[user[:pass]@]host[:port][?VncUsername=…&SecurityType=…&SshHost=…]`；
//     埠 < 100 當顯示編號（5900 + n），`host::port`（兩個冒號）是字面埠——同 vncviewer 的慣例。
//   - RustDesk：官方用戶端（flutter/lib/common.dart 的 urlLinkToCmdArgs）認得的 `rustdesk://` 連結。
//
// 原則同 sshConnString.ts：**保守優先**，認不出來就回 null，讓這次貼上照常進欄位。
// 沒有 scheme 的 RustDesk ID（一串數字）不收——跟埠號、電話、隨手貼的數字分不開。
// .rdp 檔在 rdpFile.ts；兩邊共用 applyRdpKeyValue，同一個鍵永遠對到同一個欄位。

import type { RdOptions, RdProtocol, RdSession, VncSecurity } from "./rdTypes";

export interface ParsedRd {
  protocol: RdProtocol;
  /** RustDesk 放對方的 ID（或 Direct IP 位址）。 */
  host: string;
  /** 0 = 協定預設。 */
  port: number;
  username: string;
  /** RDP 網域（`DOMAIN\user` 的 DOMAIN）。 */
  domain: string;
  /** 字串裡帶的密碼；不會進 RdSession（呼叫端決定要不要存進 keychain）。 */
  password: string | null;
  /** 顯示名稱；空 = 字串沒指定（VNC ConnectionName、.rdp 檔預設用主機）。 */
  name: string;
  /** 只含字串有提到的選項；`ui` 也只含有提到的鍵。 */
  options: Partial<RdOptions>;
  /** VNC SshHost / SshPort / SshUsername：要經 SSH 通道連過去（呼叫端自己對到已存的 SSH 主機）。 */
  viaSsh: { host: string; port: number; username: string } | null;
  /** 給使用者看的提醒（zh-TW）：有東西認得但不支援、被略過。 */
  warnings: string[];
}

/** 空的解析結果（rdpFile.ts 也用）。 */
export function blankParsedRd(protocol: RdProtocol): ParsedRd {
  return { protocol, host: "", port: 0, username: "", domain: "", password: null, name: "", options: {}, viaSsh: null, warnings: [] };
}

function warn(p: ParsedRd, msg: string): void {
  if (!p.warnings.includes(msg)) p.warnings.push(msg);
}

function setUi(p: ParsedRd, key: string, value: string): void {
  p.options.ui = { ...(p.options.ui ?? {}), [key]: value };
}

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 剝掉外層引號與複製指令時常帶上的提示字元（`$ mstsc …`）。 */
function stripNoise(text: string): string {
  let s = text.trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === "`") && s[s.length - 1] === s[0]) {
      s = s.slice(1, -1).trim();
    }
    s = s.replace(/^[$>#]\s+/, "");
    if (s === before) break;
  }
  return s;
}

function parsePort(s: string): number | null | undefined {
  if (s === "") return null;
  if (!/^\d{1,5}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : undefined;
}

function toInt(s: string): number | null {
  const t = s.trim();
  return /^-?\d{1,9}$/.test(t) ? Number(t) : null;
}

const HOST_RE = /^[^\s@/\\?#;=,&]+$/;

/** `host` / `host:port` / `[v6]` / `[v6]:port`；沒有中括號的多個冒號當裸 IPv6（沒有埠）。不合法回 null。 */
function splitHostPort(s: string): { host: string; port: number | null } | null {
  const v6 = /^\[([^\]\s]+)\](?::(.*))?$/.exec(s);
  if (v6) {
    const port = parsePort(v6[2] ?? "");
    return port === undefined ? null : { host: v6[1], port };
  }
  const colons = s.split(":").length - 1;
  if (colons > 1) return HOST_RE.test(s) ? { host: s, port: null } : null;
  const [host, portStr = ""] = s.split(":");
  const port = parsePort(portStr);
  if (!host || port === undefined || !HOST_RE.test(host)) return null;
  return { host, port };
}

/** `DOMAIN\user` → 網域 + 帳號（`.\admin` 的 `.` = 本機帳號，照樣當網域）；`user@corp.com`（UPN）原樣當帳號。 */
export function splitDomainUser(s: string): { domain: string; username: string } {
  const i = s.indexOf("\\");
  return i < 0 ? { domain: "", username: s } : { domain: s.slice(0, i), username: s.slice(i + 1) };
}

function setRdpUser(p: ParsedRd, raw: string): void {
  const { domain, username } = splitDomainUser(raw);
  p.username = username;
  if (domain) p.domain = domain;
}

/** `a=1&b=2` → 小寫鍵 → 解碼後的值（`?relay` 這種沒有 `=` 的鍵值是空字串）。 */
function parseQuery(q: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of q.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decode(eq < 0 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (k) out.set(k, eq < 0 ? "" : decode(part.slice(eq + 1)));
  }
  return out;
}

function gatewayWarning(src: string): string {
  return `不支援 RD 閘道（${src}），已略過`;
}

const RDP_PASSWORD_WARNING = "未匯入 .rdp 內的加密密碼（只有原電腦能解開）";

/** 明確寫了 `gatewayusagemethod:i:0`（不用閘道）的結果：之後的 gatewayhostname 不必提醒。 */
const gatewayOff = new WeakSet<ParsedRd>();

/**
 * RDP 設定的一個 `key:型別:值`（.rdp 檔的一行，或 Microsoft URI 的一組 `key=型別:值`）套進解析結果。
 * 鍵名不分大小寫；型別字母不檢查（值照鍵的意思解讀）；認不得的鍵略過。
 *
 * 會看的鍵：full address、server port、username、domain、screen mode id、desktopwidth / desktopheight、
 * session bpp、enablecredsspsupport、dynamic resolution、smart sizing、gatewayhostname / gatewayusagemethod、
 * password 51（DPAPI 加密，只提醒不匯入）。alternate full address、authentication level（伺服器驗證失敗時的
 * 行為，本程式一律走憑證 TOFU 提示）等其餘鍵略過。
 */
export function applyRdpKeyValue(p: ParsedRd, key: string, value: string): void {
  const k = key.trim().toLowerCase().replace(/\s+/g, " ");
  const v = value.trim();
  const n = toInt(v);
  switch (k) {
    case "full address": {
      const hp = splitHostPort(v);
      if (!hp) return;
      p.host = hp.host;
      // full address 裡的埠優先於 server port（不管哪行在前）。
      if (hp.port != null) p.port = hp.port;
      return;
    }
    case "server port":
      if (n != null && n >= 1 && n <= 65535 && p.port === 0) p.port = n;
      return;
    case "username":
      if (v) setRdpUser(p, v);
      return;
    case "domain":
      if (v) p.domain = v;
      return;
    case "screen mode id":
      // 1 = 視窗、2 = 全螢幕；明確寫了視窗就記 "0"，免得蓋不掉既有主機的全螢幕偏好。
      if (n === 2) setUi(p, "fullscreen", "1");
      else if (n === 1) setUi(p, "fullscreen", "0");
      return;
    case "desktopwidth":
      if (n != null && n > 0) p.options.width = n;
      return;
    case "desktopheight":
      if (n != null && n > 0) p.options.height = n;
      return;
    case "session bpp": {
      const d = n === 15 ? 16 : n;
      if (d === 16 || d === 24 || d === 32) p.options.color_depth = d;
      return;
    }
    case "enablecredsspsupport":
      if (n === 0) p.options.nla = false;
      else if (n === 1) p.options.nla = true;
      return;
    case "dynamic resolution":
      if (n === 1) p.options.resize_mode = "remote";
      return;
    case "smart sizing":
      // 兩個都開時動態解析度優先（不管哪行在前）。
      if (n === 1 && p.options.resize_mode !== "remote") p.options.resize_mode = "scale";
      return;
    case "gatewayhostname":
      if (v && !gatewayOff.has(p)) warn(p, gatewayWarning("gatewayhostname"));
      return;
    case "gatewayusagemethod":
      if (n === 0) {
        gatewayOff.add(p);
        p.warnings = p.warnings.filter((w) => w !== gatewayWarning("gatewayhostname"));
      }
      return;
    case "password 51":
      if (v) warn(p, RDP_PASSWORD_WARNING);
      return;
    default:
      return;
  }
}

// ---------------------------------------------------------------------------
// RDP
// ---------------------------------------------------------------------------

/** `full%20address=s:…&username=s:…`：第一組就要長得像 `鍵=s|i|b:`。 */
function isMsUri(body: string): boolean {
  return /^[a-z][a-z0-9 ]*=[sib]:/i.test(decode(body.split("&")[0]));
}

function parseMsUri(body: string): ParsedRd | null {
  const p = blankParsedRd("rdp");
  for (const pair of body.split("&")) {
    // 整組先解碼再拆：值裡的 `&` 一定是 %26，拆 `&` 在解碼前做就不會切錯。
    const m = /^([^=]+)=([a-z]):(.*)$/is.exec(decode(pair));
    if (m) applyRdpKeyValue(p, m[1], m[3]);
  }
  return p.host ? p : null;
}

/** `rdp://[user[:pass]@]host[:port][/…]`；帳號可以是 `DOMAIN\user` / `DOMAIN%5Cuser`。 */
function parseRdpUrl(rest: string): ParsedRd | null {
  const cut = rest.search(/[/?#]/);
  const authority = cut < 0 ? rest : rest.slice(0, cut);
  const at = authority.lastIndexOf("@");
  const hp = splitHostPort(authority.slice(at + 1));
  if (!hp) return null;
  const p = blankParsedRd("rdp");
  p.host = hp.host;
  p.port = hp.port ?? 0;
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    const user = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
    if (user) setRdpUser(p, user);
    if (colon >= 0) p.password = decode(userinfo.slice(colon + 1));
  }
  return p;
}

/** 空白分隔、引號可包空白；反斜線不當跳脫（Windows 路徑、`DOMAIN\user`）。引號沒關回 null。 */
function tokenize(s: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) { out.push(cur); cur = ""; has = false; }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) return null;
  if (has) out.push(cur);
  return out;
}

/** `mstsc /v:host[:port] [/f] [/w:寬 /h:高] [/g:閘道]`；其餘開關（/admin、/multimon…）與 .rdp 檔路徑略過。 */
function parseMstsc(args: string[]): ParsedRd | null {
  const p = blankParsedRd("rdp");
  let target: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const m = /^\/([a-z]+)(?::(.*))?$/is.exec(args[i]);
    if (!m) continue;
    const sw = m[1].toLowerCase();
    const val = m[2];
    if (sw === "v") {
      const t = val ?? args[++i];
      if (!t) return null;
      target = t;
    } else if (sw === "f") {
      setUi(p, "fullscreen", "1");
    } else if (sw === "w" || sw === "h") {
      const n = toInt(val ?? "");
      if (n != null && n > 0) p.options[sw === "w" ? "width" : "height"] = n;
    } else if (sw === "g") {
      warn(p, gatewayWarning("/g"));
    }
  }
  if (!target) return null;
  const hp = splitHostPort(target);
  if (!hp) return null;
  p.host = hp.host;
  p.port = hp.port ?? 0;
  return p;
}

// ---------------------------------------------------------------------------
// VNC（RFC 7869）
// ---------------------------------------------------------------------------

/**
 * VNC 的主機埠：`host:n` 的 n < 100 是顯示編號（5900 + n），`host::port` 是字面埠；沒寫埠 → 0。
 * `[v6]:n` / `[v6]::port` 同理；沒中括號的多個冒號（且不是 `host::port`）當裸 IPv6。
 */
function splitVncHostPort(s: string): { host: string; port: number } | null {
  let host: string;
  let sep = "";
  let portStr = "";
  const v6 = /^\[([^\]\s]+)\](?:(::?)(.*))?$/.exec(s);
  const dc = /^([^:]+)::(.*)$/.exec(s);
  if (v6) {
    host = v6[1];
    sep = v6[2] ?? "";
    portStr = v6[3] ?? "";
  } else if (dc) {
    host = dc[1];
    sep = "::";
    portStr = dc[2];
  } else if (s.split(":").length - 1 > 1) {
    host = s;
  } else {
    const i = s.indexOf(":");
    host = i < 0 ? s : s.slice(0, i);
    if (i >= 0) { sep = ":"; portStr = s.slice(i + 1); }
  }
  if (!host || !HOST_RE.test(host)) return null;
  if (!sep || portStr === "") return { host, port: 0 };
  if (!/^\d{1,5}$/.test(portStr)) return null;
  let n = Number(portStr);
  if (sep === ":" && n < 100) n += 5900;
  return n >= 1 && n <= 65535 ? { host, port: n } : null;
}

/** RFC 7869 SecurityType（RFB 安全類型編號，也收名稱）→ 認證偏好；認不得回 null。 */
function vncSecurity(v: string): VncSecurity | null {
  switch (v.trim().toLowerCase()) {
    case "1": case "none": return "none";
    case "2": case "vnc": case "vncauth": return "vnc";
    case "30": case "ard": return "ard";
    case "19": case "vencrypt": case "plain": return "plain";
    default: return null;
  }
}

function parseBool(v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (s === "" || s === "1" || s === "true" || s === "yes") return true;
  if (s === "0" || s === "false" || s === "no") return false;
  return null;
}

function parseVnc(rest: string): ParsedRd | null {
  const hash = rest.indexOf("#");
  const body = hash < 0 ? rest : rest.slice(0, hash);
  const q = body.indexOf("?");
  const beforeQ = q < 0 ? body : body.slice(0, q);
  const slash = beforeQ.indexOf("/");
  const authority = slash < 0 ? beforeQ : beforeQ.slice(0, slash);
  const at = authority.lastIndexOf("@");
  const hp = splitVncHostPort(authority.slice(at + 1));
  if (!hp) return null;

  const p = blankParsedRd("vnc");
  p.host = hp.host;
  p.port = hp.port;
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    p.username = decode(colon < 0 ? userinfo : userinfo.slice(0, colon));
    if (colon >= 0) p.password = decode(userinfo.slice(colon + 1));
  }

  const params = parseQuery(q < 0 ? "" : body.slice(q + 1));
  const get = (k: string) => params.get(k.toLowerCase());
  const user = get("VncUsername");
  if (user) p.username = user;
  const pass = get("VncPassword");
  if (pass != null) p.password = pass;
  const name = get("ConnectionName");
  if (name) p.name = name.trim();
  // 沒寫 SecurityType 就不設（有帳號時後端自動優先 ARD）。
  const sec = get("SecurityType");
  if (sec) {
    const s = vncSecurity(sec);
    if (s) p.options.vnc_security = s;
    else warn(p, `不支援的 VNC 安全類型（SecurityType=${sec}），改用自動`);
  }
  const vo = get("ViewOnly");
  if (vo != null) {
    const b = parseBool(vo);
    if (b != null) p.options.view_only = b;
  }
  const sshHost = get("SshHost");
  if (sshHost) {
    // 標準只放主機名；順手收 `user@host:port`，個別參數優先。
    const sat = sshHost.lastIndexOf("@");
    const shp = splitHostPort(sshHost.slice(sat + 1));
    if (shp) {
      const sp = parsePort(get("SshPort") ?? "");
      p.viaSsh = {
        host: shp.host,
        port: sp ?? shp.port ?? 22,
        username: get("SshUsername") || (sat > 0 ? sshHost.slice(0, sat) : ""),
      };
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// RustDesk
// ---------------------------------------------------------------------------

// RustDesk 其他動作的連結（檔案傳輸、埠轉發…）不是遠端桌面，不收。
const RUSTDESK_OTHER = ["play", "file-transfer", "view-camera", "port-forward", "rdp", "terminal", "config", "password"];

/**
 * 仿官方 urlLinkToCmdArgs：
 *   `rustdesk://<id>`、`rustdesk://<id>/r`（強制中繼）、`rustdesk://<id>/r@<server>`、`rustdesk://<id>@<server>`、
 *   `rustdesk://connect/<id>`、`rustdesk://connection/new/<id>`（舊版相容）；
 *   查詢參數 password / relay / key（鍵不分大小寫）。
 */
function parseRustdesk(rest: string): ParsedRd | null {
  const hash = rest.indexOf("#");
  const body = hash < 0 ? rest : rest.slice(0, hash);
  const q = body.indexOf("?");
  const beforeQ = q < 0 ? body : body.slice(0, q);
  const slash = beforeQ.indexOf("/");
  const authority = slash < 0 ? beforeQ : beforeQ.slice(0, slash);
  const path = slash < 0 ? "" : beforeQ.slice(slash);
  const auth = authority.toLowerCase();

  let raw: string;
  if (auth === "connection") {
    if (!path.startsWith("/new/")) return null;
    raw = path.slice("/new/".length);
  } else if (auth === "connect") {
    raw = path.slice(1);
  } else if (RUSTDESK_OTHER.includes(auth)) {
    return null;
  } else if (authority.length > 2 && (path.length <= 1 || path === "/r" || path.startsWith("/r@"))) {
    raw = authority + (path.length > 1 ? path : "");
  } else {
    return null;
  }

  // `<id>/r`、`<id>/r@<server>`、`<id>@<server>`（也收 `<id>@<server>/r`）。
  let id = decode(raw);
  let relay = false;
  if (id.endsWith("/r")) { relay = true; id = id.slice(0, -2); }
  let server = "";
  const at = id.indexOf("@");
  if (at >= 0) {
    server = id.slice(at + 1).trim();
    id = id.slice(0, at);
    if (!server || /[\s/]/.test(server)) return null;
  }
  if (id.endsWith("/r")) { relay = true; id = id.slice(0, -2); }
  // ID 常被寫成 `123 456 789`。
  id = id.replace(/\s+/g, "");
  if (!id || !/^[^/?#@\\]+$/.test(id)) return null;

  const p = blankParsedRd("rustdesk");
  // Direct IP：`192.168.1.5:21118` / `[v6]:port` 拆出埠；ID 本身不會有冒號。
  const hp = /:\d{1,5}$/.test(id) ? splitHostPort(id) : null;
  if (hp && hp.port != null) {
    p.host = hp.host;
    p.port = hp.port;
  } else {
    p.host = id;
  }
  if (server) p.options.rustdesk_server = server;

  const params = parseQuery(q < 0 ? "" : body.slice(q + 1));
  const pw = params.get("password");
  if (pw != null) p.password = pw;
  const key = params.get("key");
  if (key) p.options.rustdesk_key = key;
  const r = params.get("relay");
  if (r != null && parseBool(r) !== false) relay = true;
  if (relay) p.options.rustdesk_relay = true;
  return p;
}

// ---------------------------------------------------------------------------
// 進入點
// ---------------------------------------------------------------------------

// `mstsc` / `mstsc.exe` / `C:\Windows\System32\mstsc.exe`（路徑不能含空白、不能是 URL）。
const MSTSC_RE = /^(?:(?:[a-z]:)?(?:[\\/][^\s"'\\/:]+)*[\\/])?mstsc(?:\.exe)?(?:\s+(.*))?$/is;

/**
 * 解析遠端桌面連線字串；認不出來回 null（ssh://、http://、資料庫 URL、純主機名、沒有 scheme 的 RustDesk ID…）。
 * scheme 不分大小寫；多行文字不收（.rdp 檔內容走 rdpFile.parseRdpFile）。
 */
export function parseRdString(input: string): ParsedRd | null {
  const s = stripNoise(input);
  if (!s || /[\r\n]/.test(s)) return null;

  const url = /^(rdp|vnc|rustdesk):\/\/(.*)$/is.exec(s);
  if (url) {
    const scheme = url[1].toLowerCase();
    const rest = url[2];
    if (scheme === "rdp") return isMsUri(rest) ? parseMsUri(rest) : parseRdpUrl(rest);
    if (scheme === "vnc") return parseVnc(rest);
    return parseRustdesk(rest);
  }
  if (isMsUri(s)) return parseMsUri(s);

  const cmd = MSTSC_RE.exec(s);
  if (cmd) {
    const toks = tokenize(cmd[1] ?? "");
    return toks ? parseMstsc(toks) : null;
  }
  return null;
}

/** 貼上處理用的便宜判斷：看起來像遠端桌面字串才值得呼叫 parseRdString（仍可能回 null）。 */
export function looksLikeRdString(input: string): boolean {
  const s = stripNoise(input);
  return /^(?:rdp|vnc|rustdesk):\/\//i.test(s) || MSTSC_RE.test(s) || /(?:^|&)full(?:%20|\s)address=/i.test(s);
}

/**
 * 解析結果套進主機（回傳新物件，不改 base）。
 * - 協定 / 主機 / 埠一律用字串的（埠 0 = 協定預設；換協定時舊埠沒有意義）。
 * - 帳號：字串有帶就用；沒帶且協定沒變就保留原值，換了協定就清空。
 * - 網域：只有 RDP 有；字串有帶網域就用，只帶帳號（沒網域）就清空，都沒帶且協定沒變就保留。
 * - 名稱：只在 base 還沒取名時填。
 * - 選項：字串提到的才覆寫，`ui` 逐鍵合併。
 * - 密碼不進 session（呼叫端決定要不要存 keychain）；viaSsh 也由呼叫端對到已存 SSH 主機。
 */
export function applyRdString(base: RdSession, p: ParsedRd): RdSession {
  const same = base.protocol === p.protocol;
  const username = p.username || (same ? base.username : "");
  const domain = p.protocol !== "rdp" ? "" : p.domain || (same && !p.username ? base.domain : "");
  return {
    ...base,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    username,
    domain,
    name: base.name || p.name,
    options: {
      ...base.options,
      ...p.options,
      ui: { ...base.options.ui, ...(p.options.ui ?? {}) },
    },
  };
}

// ---------------------------------------------------------------------------
// RustDesk 的「ID / 中繼伺服器」設定字串
// ---------------------------------------------------------------------------

export interface RustdeskServerConfig {
  /** ID 伺服器（hbbs）。 */
  host: string;
  /** 中繼伺服器（hbbr）。 */
  relay: string;
  /** API 伺服器（帳號 / 通訊錄用；連線用不到）。 */
  api: string;
  /** ID 伺服器的公鑰。 */
  key: string;
}

/**
 * RustDesk「ID / 中繼伺服器」對話框的匯出字串 → 各欄位；認不出來回 null。
 * 格式：`{"host":…,"relay":…,"api":…,"key":…}` 的 JSON 本身，或它的 base64（URL-safe、可省略 `=`）整串倒過來寫。
 */
export function parseRustdeskServerConfig(input: string): RustdeskServerConfig | null {
  const s = input.trim();
  if (!s || /\s/.test(s)) return null;
  const tryJson = (text: string): RustdeskServerConfig | null => {
    try {
      const v: unknown = JSON.parse(text);
      if (!v || typeof v !== "object" || Array.isArray(v)) return null;
      const o = v as Record<string, unknown>;
      const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
      const c = { host: str("host"), relay: str("relay"), api: str("api"), key: str("key") };
      // 至少要有 ID 伺服器或 Key，才算是伺服器設定（避免把隨便一段 JSON 當成設定）。
      return "host" in o && (c.host || c.key) ? c : null;
    } catch {
      return null;
    }
  };
  if (s.startsWith("{")) return tryJson(s);
  const b64 = [...s].reverse().join("").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return null;
  const padded = b64.replace(/=+$/, "") + "=".repeat((4 - (b64.replace(/=+$/, "").length % 4)) % 4);
  let text: string;
  try {
    const bin = atob(padded);
    text = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
  return tryJson(text);
}
