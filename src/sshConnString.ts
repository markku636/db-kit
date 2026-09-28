// SSH / SFTP 連線字串：`ssh://` `sftp://` URL、從文件或終端機複製來的 `ssh …` / `sftp …` 指令，
// 以及 SSH 主機欄裡的 `user@host:port`。純函式（可單測），兩個地方用：
//   - 新增連線對話框：連線字串欄 / 主機欄貼上的是 SSH 字串 → 轉交給 SSH 主機對話框（資料庫表單不收 SSH）。
//   - SSH 主機對話框：主機欄貼上 → 拆成主機 / 埠 / 使用者 / 認證等欄位。
//
// 原則與 connString.ts 相同：**保守優先**。認不出來就回 null，讓這次貼上照常進欄位——
// 誤攔的代價（使用者的輸入被吃掉、欄位被改寫）比沒有這個功能更糟。

import { resolveJumpRef } from "./sshHostImport";
import type { SshAuthKind, SshSession } from "./sshTypes";

export type SshProtocol = "ssh" | "sftp";

export interface ParsedSsh {
  /** sftp:// 或 `sftp` 指令：存成同一種 SSH 主機，但開啟時一併展開 SFTP 面板。 */
  protocol: SshProtocol;
  host: string;
  port: number | null;
  username: string | null;
  password: string | null;
  /** `-i` / `-o IdentityFile=`：私鑰檔。 */
  identityFile: string | null;
  /** `-J` / `-o ProxyJump=` 的最後一跳（直接連到目標的那台），`[user@]host[:port]` 或主機名稱。 */
  jump: string | null;
  /** SFTP 起始資料夾（URL 路徑或 `sftp user@host:/path`）；`~/…` = 相對家目錄。 */
  path: string | null;
}

export interface ParseSshOptions {
  /**
   * 也接受沒有 scheme 的 `user@host[:port]` / `host:port`。只給 SSH 主機欄用——那一欄本來就只收主機，
   * 貼進來帶 `@` 或埠號一定是想連這台；新增連線對話框不能用（`user@host` 也可能是別種東西的片段）。
   */
  bare?: boolean;
}

/** 剝掉外層引號與複製指令時常帶上的提示字元（`$ ssh …`）。 */
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

function decode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function parsePort(s: string): number | null | undefined {
  if (s === "") return null;
  if (!/^\d{1,5}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : undefined;
}

const HOST_RE = /^[^\s@/\\?#;=,]+$/;

/**
 * `host` / `host:port` / `[v6]` / `[v6]:port`。沒有中括號的多個冒號當成裸 IPv6（沒有埠）。
 * 回 null = 不是合法的主機（空字串、含空白或 `/` 之類、埠號不是 1–65535）。
 */
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

/** 切出 `user@` 前綴（最後一個 `@`：帳號可能含 `@`，主機不會）。 */
function splitUser(s: string): { user: string | null; rest: string } {
  const at = s.lastIndexOf("@");
  if (at < 0) return { user: null, rest: s };
  return { user: s.slice(0, at) || null, rest: s.slice(at + 1) };
}

/** URL 路徑 → SFTP 起始資料夾。`/` 與 `/~` 是家目錄（null）；`/~/x` 是家目錄下的 x。 */
function urlPathToDir(raw: string): string | null {
  const p = decode(raw);
  if (p === "" || p === "/" || p === "/~" || p === "/~/") return null;
  if (p.startsWith("/~/")) return `~/${p.slice(3)}`;
  return p;
}

function empty(protocol: SshProtocol, host: string, port: number | null): ParsedSsh {
  return { protocol, host, port, username: null, password: null, identityFile: null, jump: null, path: null };
}

/**
 * `ssh://[user[;fingerprint=…][:password]@]host[:port]`，sftp / scp 另收路徑
 * （draft-ietf-secsh-scp-sftp-ssh-uri 的形式；`;` 之後的連線參數略過）。
 */
function parseUrl(scheme: string, rest: string): ParsedSsh | null {
  const protocol: SshProtocol = scheme === "ssh" ? "ssh" : "sftp";
  const cut = rest.search(/[/?#]/);
  const authority = cut < 0 ? rest : rest.slice(0, cut);
  const tail = cut < 0 ? "" : rest.slice(cut);
  const at = authority.lastIndexOf("@");
  const hp = splitHostPort(authority.slice(at + 1));
  if (!hp) return null;
  const out = empty(protocol, hp.host, hp.port);
  if (at >= 0) {
    const userinfo = authority.slice(0, at);
    const colon = userinfo.indexOf(":");
    const userPart = (colon < 0 ? userinfo : userinfo.slice(0, colon)).split(";")[0];
    out.username = userPart ? decode(userPart) : null;
    if (colon >= 0) out.password = decode(userinfo.slice(colon + 1));
  }
  if (protocol === "sftp" && tail.startsWith("/")) out.path = urlPathToDir(tail.replace(/[?#].*$/s, ""));
  return out;
}

/**
 * 指令列切成 token：空白分隔，單 / 雙引號可包住含空白的值。反斜線**不**當跳脫——
 * Windows 上貼來的 `-i C:\Users\me\.ssh\id_ed25519` 要原樣保留。
 */
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

// 帶參數的選項（其餘單字母旗標如 -A -X -t -v 不帶參數，略過）。兩支程式的字母不完全一樣：
// ssh 的 -p 是埠、-l 是帳號；sftp 的 -P 才是埠，-l 是頻寬上限、-p 是保留時間戳（不帶參數）。
const ARG_OPTS: Record<SshProtocol, string> = {
  ssh: "BbcDEeFIiJLlmOopQRSWw",
  sftp: "BbcDFiJloPRSs",
};

/** `ssh [選項] destination [指令]` / `sftp [選項] destination`。 */
function parseCommand(protocol: SshProtocol, args: string[]): ParsedSsh | null {
  const o: { port: number | null; user: string | null; identity: string | null; jump: string | null } =
    { port: null, user: null, identity: null, jump: null };
  let dest: string | null = null;

  const setOpt = (c: string, v: string): boolean => {
    if ((protocol === "ssh" && c === "p") || (protocol === "sftp" && c === "P")) {
      const n = parsePort(v);
      if (n == null) return false;
      o.port = n;
    } else if (protocol === "ssh" && c === "l") o.user = v;
    else if (c === "i") o.identity = v;
    else if (c === "J") o.jump = v;
    else if (c === "o") {
      const m = /^([A-Za-z]+)\s*[=\s]\s*(.+)$/.exec(v.trim());
      if (!m) return true;
      const key = m[1].toLowerCase();
      if (key === "port") return setOpt(protocol === "ssh" ? "p" : "P", m[2]);
      if (key === "user") o.user = m[2];
      else if (key === "identityfile") o.identity = m[2];
      else if (key === "proxyjump") o.jump = m[2];
    }
    return true;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { dest ??= args[i + 1] ?? null; break; }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        if (!ARG_OPTS[protocol].includes(a[j])) continue;
        const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
        if (v == null || !setOpt(a[j], v)) return null;
        break;
      }
      continue;
    }
    // 第一個非選項是目的地。OpenSSH 也收寫在目的地後面的選項（ssh host -p 2222），
    // 再下一個非選項就是遠端指令（ssh host uptime），不收。
    if (dest) break;
    dest = a;
  }
  if (!dest) return null;

  let out: ParsedSsh | null;
  const url = /^(ssh|sftp):\/\/(.*)$/is.exec(dest);
  if (url) {
    out = parseUrl(url[1].toLowerCase(), url[2]);
  } else if (protocol === "sftp") {
    // sftp 的 `host:path`：冒號後面是路徑，不是埠（埠用 -P）。
    const { user: u, rest } = splitUser(dest);
    const m = /^(\[[^\]]+\]|[^:]+)(?::(.*))?$/.exec(rest);
    const hp = m ? splitHostPort(m[1]) : null;
    if (!hp) return null;
    out = empty("sftp", hp.host, hp.port);
    out.username = u;
    const p = m![2] ?? "";
    if (p) out.path = p.startsWith("/") || p.startsWith("~") ? p : `~/${p}`;
  } else {
    // ssh 本身不收 `host:port`，但這是最常見的手誤，照字面意思接下來。
    const { user: u, rest } = splitUser(dest);
    const hp = splitHostPort(rest);
    if (!hp) return null;
    out = empty("ssh", hp.host, hp.port);
    out.username = u;
  }
  if (!out) return null;
  out.port = o.port ?? out.port;
  out.username = o.user ?? out.username;
  out.identityFile = o.identity;
  // 多層跳板（a,b）：目標直接經由最後一台連進去，前面幾層是那台自己的跳板機設定。
  const hops = o.jump?.split(",").map((h) => h.trim()).filter(Boolean) ?? [];
  const last = hops.at(-1);
  out.jump = last ? last.replace(/^ssh:\/\//i, "") : null;
  return out;
}

/**
 * 解析 SSH / SFTP 字串；認不出來回 null。
 *
 * 認得：`ssh://` `sftp://` `scp://` URL；`ssh …` / `sftp …` 指令（-p/-P、-l、-i、-J、-o Port/User/
 * IdentityFile/ProxyJump）；`bare` 時另收 `user@host[:port]` 與 `host:port`。
 */
export function parseSshString(text: string, opts: ParseSshOptions = {}): ParsedSsh | null {
  const s = stripNoise(text);
  if (!s || s.includes("\n")) return null;

  const url = /^(ssh|sftp|scp):\/\/(.*)$/is.exec(s);
  if (url) return parseUrl(url[1].toLowerCase(), url[2]);

  const cmd = /^(ssh|sftp)(?:\.exe)?\s+(.+)$/is.exec(s);
  if (cmd) {
    const toks = tokenize(cmd[2]);
    return toks ? parseCommand(cmd[1].toLowerCase() as SshProtocol, toks) : null;
  }

  if (!opts.bare || /\s/.test(s)) return null;
  const { user, rest } = splitUser(s);
  // `user:pass@host` 不是 SSH 的寫法，別猜。
  if (user?.includes(":")) return null;
  const hp = splitHostPort(rest);
  // 只有主機名＝一般的貼上，不必攔。
  if (!hp || (user == null && hp.port == null)) return null;
  const out = empty("ssh", hp.host, hp.port);
  out.username = user;
  return out;
}

// ---------------------------------------------------------------------------
// 解析結果 → SSH 主機表單
// ---------------------------------------------------------------------------

/** SSH 主機對話框裡「字串可能填到」的欄位。 */
export interface SshFormFields {
  host: string;
  port: number;
  username: string;
  auth: SshAuthKind;
  password: string;
  keyPath: string;
  /** 跳板機的主機 id；"" = 直連。 */
  jumpId: string;
  openSftp: boolean;
  sftpDir: string;
}

export interface ApplySshResult {
  next: SshFormFields;
  /** 字串指定了跳板機、清單裡卻找不到對應的已存主機（原值保留，請使用者自己選）。 */
  jumpMissing: string | null;
}

/**
 * 解析結果套進 SSH 主機表單（純函式）。語意同 connString.applyParsedToForm：
 * **字串沒提到的欄位保留現值**。帶了密碼 → 密碼認證；帶了私鑰檔 → 私鑰認證；
 * sftp → 開啟時一併展開 SFTP 面板（ssh 不會反過來把它關掉）。
 */
export function applySshString(
  p: ParsedSsh,
  cur: SshFormFields,
  sessions: readonly Pick<SshSession, "id" | "name" | "host" | "username" | "port">[],
): ApplySshResult {
  const next: SshFormFields = { ...cur, host: p.host };
  if (p.port != null) next.port = p.port;
  if (p.username != null) next.username = p.username;
  if (p.password != null) { next.auth = "password"; next.password = p.password; }
  if (p.identityFile) { next.auth = "key"; next.keyPath = p.identityFile; }
  let jumpMissing: string | null = null;
  if (p.jump) {
    const id = resolveJumpRef(p.jump, sessions);
    if (id) next.jumpId = id;
    else jumpMissing = p.jump;
  }
  if (p.protocol === "sftp") next.openSftp = true;
  if (p.path) next.sftpDir = p.path;
  return { next, jumpMissing };
}

/**
 * SFTP 起始資料夾 → 要列的絕對路徑。空 / `~` = 家目錄；`~/x` 與相對路徑都接在家目錄下
 * （SFTP 面板的上一層 / 麵包屑都假設是絕對路徑）。
 */
export function resolveSftpDir(dir: string | null | undefined, home: string): string {
  const d = (dir ?? "").trim();
  const base = home || "/";
  if (!d || d === "~" || d === "~/") return base;
  if (d.startsWith("/")) return d;
  const rel = d.startsWith("~/") ? d.slice(2) : d;
  return base.endsWith("/") ? `${base}${rel}` : `${base}/${rel}`;
}
