// SSH 操作紀錄的前端純函式：判斷「游標停在密碼提示上」、從 xterm 畫面讀出剛執行的指令、把指令裡的密碼
// 換成 ***、紀錄的顯示文字與匯出 CSV。存檔 / 查詢在後端（src-tauri/src/ssh/oplog.rs）。
//
// 為什麼從畫面讀、不記鍵盤：在密碼提示下打的字不會回顯，畫面上根本沒有，所以怎麼讀都讀不到密碼；
// 記鍵盤就一定會記到。直接寫在指令裡的密碼（`mysql -pXXX`、`--password=`、網址裡的帳密…）由
// `redactSecrets` 換成 ***——終端機的工作階段記錄檔也走同一個函式。

export type SshOpKind =
  | "connect" | "disconnect" | "command"
  | "upload" | "download" | "delete" | "rename" | "mkdir" | "chmod" | "save" | "create";
export type SshOpSource = "keyboard" | "paste" | "compose" | "ai" | "app";

/** 後端 `OpEntry`（snake_case）。 */
export interface SshOpEntry {
  ts: number;
  kind: SshOpKind | string;
  proto: "ssh" | "sftp" | "ftp" | string;
  conn_id: string;
  host: string;
  port: number;
  user: string;
  session_id?: string | null;
  detail: string;
  target?: string | null;
  cwd?: string | null;
  source?: SshOpSource | string | null;
  result: "ok" | "error" | "cancelled" | string;
  message?: string | null;
}

export interface SshOpQuery {
  from?: number | null;
  to?: number | null;
  kinds?: string[];
  session_id?: string | null;
  host?: string;
  text?: string;
  limit?: number;
}

export interface SshOpPage {
  entries: SshOpEntry[];
  more: boolean;
}

export interface SshOpLogConfig {
  enabled: boolean;
  /** 0 = 永久保留。 */
  retention_days: number;
}

export interface SshOpLogInfo {
  config: SshOpLogConfig;
  dir: string;
}

/** 查詢畫面的種類篩選：指令 / 檔案 / 連線。 */
export const OP_KIND_GROUPS = {
  command: ["command"],
  file: ["upload", "download", "delete", "rename", "mkdir", "chmod", "save", "create"],
  conn: ["connect", "disconnect"],
} as const satisfies Record<string, readonly SshOpKind[]>;
export type SshOpKindGroup = keyof typeof OP_KIND_GROUPS;

// ---- 密碼提示 ----

// 關鍵字後面接（最多 80 個字的）說明，再以冒號結尾；冒號後面允許空白與遮罩字元（有的程式每打一個字回一顆 *）。
const SECRET_PROMPT = new RegExp(
  String.raw`(?:\b(?:password|passwd|passphrase|pass phrase|passcode|pin|otp|token|secret|verification code|one-time code|2fa code)\b|密碼|密码|口令|密語|密语|驗證碼|验证码|PIN 碼)` +
    String.raw`[^\n]{0,80}[:：]\s*[*•●·.]*\s*$`,
  "i",
);

/**
 * 這段文字（游標所在那一行、游標之前的部分）看起來是不是在要密碼 / 密語 / 一次性驗證碼：
 * `[sudo] password for mark:`、`Enter passphrase for key '…':`、`mark@h's password:`、`請輸入密碼：`。
 */
export function isSecretPrompt(text: string): boolean {
  return SECRET_PROMPT.test(text.slice(-200));
}

// ---- 從畫面讀指令 ----

/** xterm `IBufferLine` / `IBuffer` 用得到的部分（測試用假的就好）。 */
export interface BufLineLike {
  readonly isWrapped: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}
export interface BufLike {
  readonly length: number;
  getLine(y: number): BufLineLike | undefined;
}

/** 自動折行的長行算同一行：從 `row` 往上找到這一行真正的開頭。 */
export function logicalStart(buf: BufLike, row: number): number {
  let y = row;
  while (y > 0 && buf.getLine(y)?.isWrapped) y--;
  return y;
}

/** 從 `row` 往下把折下來的續行都算進來，回傳最後一列。 */
export function logicalEnd(buf: BufLike, row: number): number {
  let y = row;
  while (y + 1 < buf.length && buf.getLine(y + 1)?.isWrapped) y++;
  return y;
}

/**
 * 讀 `(startRow, startCol)` 到 `endRow` 結尾的文字：折行直接接起來；真的換行（多行貼上、續行提示）用 \n。
 * 每行尾端的空白去掉（xterm 會補滿整列）。
 */
export function readSpan(buf: BufLike, startRow: number, startCol: number, endRow: number): string {
  let out = "";
  for (let y = startRow; y <= endRow; y++) {
    const l = buf.getLine(y);
    if (!l) continue;
    let text = l.translateToString(false, y === startRow ? startCol : 0);
    // 寬字（中文）放不進這列最後一格時，xterm 把那一格留空、整個字折到下一列——那一格不是使用者打的空白。
    const next = y < endRow ? buf.getLine(y + 1) : undefined;
    if (next?.isWrapped && text.endsWith(" ") && WIDE_START.test(next.translateToString(false))) text = text.slice(0, -1);
    if (y > startRow && !l.isWrapped) out = `${out.replace(/\s+$/, "")}\n`;
    out += text;
  }
  return out.replace(/\s+$/, "");
}

// East Asian Wide / Fullwidth（中日韓、全形符號）與常見 emoji：終端機裡佔兩格的字。
const WIDE_START = /^[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** 游標前、同一個邏輯行裡的文字（判斷是不是密碼提示用）。 */
export function textBeforeCursor(buf: BufLike, row: number, col: number): string {
  const start = logicalStart(buf, row);
  let out = "";
  for (let y = start; y <= row; y++) {
    const l = buf.getLine(y);
    if (!l) continue;
    out += y === row ? l.translateToString(false, 0, col) : l.translateToString(false);
  }
  return out;
}

// 常見的提示符結尾：bash / zsh 的 `$` `#` `%`、PowerShell / cmd / 各種 REPL 的 `>`、主題常用的 ❯ › » ➜。
const PROMPT_END = /^.{0,200}?[$#%>❯›»➜](?:\s+|$)/u;

/**
 * 不知道提示符在哪裡結束時的退路：去掉第一個常見的提示符結尾之前的部分。
 * `mark@web01:~/app$ git pull` → `git pull`；找不到就整行照舊（例如沒有提示符的程式）。
 */
export function stripPrompt(line: string): string {
  const first = line.split("\n", 1)[0];
  const m = PROMPT_END.exec(first);
  if (!m) return line.trim();
  return line.slice(m[0].length).trim();
}

/**
 * 按下 Enter 當下讀到一次、回顯完再讀一次：後讀的是先讀的延伸（最後幾個字晚到）才用後讀的；
 * 畫面被清掉 / 改寫了就用 Enter 當下那份。
 */
export function pickLater(atEnter: string, later: string | null): string {
  if (later == null) return atEnter;
  if (!atEnter) return later;
  return later.startsWith(atEnter) ? later : atEnter;
}

// ---- 輸入分類 ----

export type InputKind =
  | { kind: "enter" }
  /** 貼上（含換行）。`bracketed` = shell 開了 bracketed paste，換行不會立刻執行，要等使用者按 Enter。 */
  | { kind: "paste"; bracketed: boolean; lines: string[]; rest: string }
  /** 終端機自己回的（游標位置、裝置屬性、焦點、滑鼠、顏色查詢）：不是使用者按的鍵。 */
  | { kind: "report" }
  | { kind: "other" };

const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";
const TERMINAL_REPORT = /^(?:\x1b\[\??[\d;]*[Rcn]|\x1b\[[IO]|\x1b\[<[\d;]+[Mm]|\x1b\[M[\s\S]{3}|\x1b\][\s\S]*(?:\x07|\x1b\\)|\x1bP[\s\S]*\x1b\\)$/;

/** xterm `onData` 一次送來的東西：一個 Enter、一段（多行）貼上、終端機的回報、或其他按鍵。 */
export function classifyInput(data: string): InputKind {
  if (data === "\r") return { kind: "enter" };
  if (TERMINAL_REPORT.test(data)) return { kind: "report" };
  const bracketed = data.startsWith(BP_START);
  const body = bracketed ? data.slice(BP_START.length).replace(BP_END, "") : data;
  if (bracketed || (data.length > 1 && !data.startsWith("\x1b") && /[\r\n]/.test(data))) {
    const parts = body.split(/\r\n|\r|\n/);
    const rest = parts.pop() ?? "";
    // bracketed paste 後面可能緊跟一個 Enter（貼上的內容本身就以換行結尾、且終端機沒有包進去）。
    return { kind: "paste", bracketed, lines: parts, rest };
  }
  return { kind: "other" };
}

// ---- 密碼遮罩 ----

const MASK = "***";
const VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'&;|]+)`;
// 名稱以這些字結尾就當成祕密：長字任何前綴都算（PGPASSWORD、csrftoken），短字要在開頭或接在 _ - . 之後（MYSQL_PWD、db.pass）。
const LONG_SECRET = "(?:password|passwd|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credentials?)";
const SHORT_SECRET = "(?:pass|pwd|pw)";
const SECRET_NAME = String.raw`(?:[\w.-]*${LONG_SECRET}|(?:[\w.-]*[_.-])?${SHORT_SECRET})`;
// 同一條指令裡（不跨 ; & | 換行）。
const SAME_CMD = String.raw`[^;&|\n]*?`;

interface Rule {
  re: RegExp;
  to: string;
}

// 順序有關係：認得特定工具的寫法先套（sshpass -ppass 的 -p 後面就是密碼），最後才是通用的「名稱像密碼的選項」。
// 每條規則都要是線性的：工作階段記錄會拿整段輸出來過，一行可能幾萬字（scheme 長度因此設上限）。
const RULES: Rule[] = [
  // 網址裡的帳密：scheme://user:pass@host（帳號可以是空的，例如 redis://:pass@host）。
  { re: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@/]{0,256}):([^\s@/]{1,512})@/gi, to: `$1:${MASK}@` },
  // HTTP 認證標頭。
  { re: /\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic|token|digest|negotiate)?\s*)([^\s'"]+)/gi, to: `$1${MASK}` },
  { re: /\b((?:x-api-key|api-key|private-token|x-auth-token|x-access-token)\s*:\s*)([^\s'"]+)/gi, to: `$1${MASK}` },
  // JSON：{"password":"abc"}
  { re: new RegExp(String.raw`("${SECRET_NAME}"\s*:\s*)"[^"]*"`, "gi"), to: `$1"${MASK}"` },
  // MySQL 家族的 -p密碼（黏在一起；-P 是 port、單獨的 -p 是「等一下問我」，都不動）。
  { re: new RegExp(String.raw`(\b(?:mysql|mysqldump|mariadb|mariadb-dump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mysqlsh)\b${SAME_CMD}\s-p)${VALUE}`, "g"), to: `$1${MASK}` },
  // sshpass -p x / -px、redis-cli -a x、mongo -p x、docker login -p x。
  { re: new RegExp(String.raw`(\bsshpass\b${SAME_CMD}\s-p)\s*(?!-)${VALUE}`, "g"), to: `$1 ${MASK}` },
  { re: new RegExp(String.raw`(\bredis-cli\b${SAME_CMD}\s-a)\s+(?!-)${VALUE}`, "g"), to: `$1 ${MASK}` },
  { re: new RegExp(String.raw`(\b(?:mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)\b${SAME_CMD}\s-p)\s+(?!-)${VALUE}`, "g"), to: `$1 ${MASK}` },
  { re: new RegExp(String.raw`(\b(?:docker|podman|nerdctl|buildah)\s+login\b${SAME_CMD}\s-p)\s*(?!-)${VALUE}`, "g"), to: `$1 ${MASK}` },
  // curl / wget 的 -u user:pass（值是網址的不算，例如 redis-cli -u redis://…）。
  { re: /(\s(?:-u|--user|-U|--proxy-user)\s+)([^\s:]+):(?!\/\/)(\S+)/g, to: `$1$2:${MASK}` },
  // htpasswd -b 檔案 帳號 密碼。
  { re: /(\bhtpasswd\s+(?:-\S+\s+)*-\w*b\w*\s+(?:-\S+\s+)*\S+\s+\S+\s+)(\S+)/g, to: `$1${MASK}` },
  // openssl 的 -passin / -passout / -pass pass:密碼。
  { re: new RegExp(String.raw`(\s-pass(?:in|out)?\s+pass:)${VALUE}`, "g"), to: `$1${MASK}` },
  // echo 密碼 | sudo -S / passwd --stdin / chpasswd / --password-stdin。
  {
    re: /(\b(?:echo|printf)\s+(?:-[a-z]+\s+)*)("[^"]*"|'[^']*'|\S+)(\s*\|\s*(?:sudo\b[^|;&\n]*\s-S\b|passwd\b|chpasswd\b|sshpass\b|[^|;&\n]*--password-stdin))/g,
    to: `$1${MASK}$3`,
  },
  // name=value：--password=x、PGPASSWORD=x、MYSQL_PWD=x、-d 'user=a&password=b'、--from-literal=password=x。
  { re: new RegExp(String.raw`(^|[\s"'&;(?=,])(-{0,2}${SECRET_NAME})=(${VALUE})`, "gi"), to: `$1$2=${MASK}` },
  // 選項後面空一格接值：--password x、-storepass x。值以 - 開頭的是下一個選項，不動。
  // 單一個 - 的選項至少要有兩個字的前綴（-storepass、-keypass）或沒有前綴（-pass）：-ppass 是 -p 黏著密碼，不是選項名稱。
  { re: new RegExp(String.raw`(^|\s)(--[\w-]*(?:${LONG_SECRET}|pass|pwd)|-(?:[\w-]{2,})?(?:${LONG_SECRET}|pass|pwd))\s+(?!-)(${VALUE})`, "gi"), to: `$1$2 ${MASK}` },
  // 長得就是金鑰的字串（GitHub / GitLab / Slack / OpenAI / Anthropic / AWS）。
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[\w-]{20,}|AKIA[0-9A-Z]{16})\b/g, to: MASK },
];

/**
 * 把一行（或多行）文字裡看起來是密碼的部分換成 `***`。寧可多遮：遮錯一個值頂多看不到，漏遮就是密碼外流。
 */
export function redactSecrets(text: string): string {
  if (!text) return text;
  return text.includes("\n") ? text.split("\n").map(redactLine).join("\n") : redactLine(text);
}

function redactLine(line: string): string {
  let out = line;
  for (const r of RULES) out = out.replace(r.re, r.to);
  return out;
}

// ---- 顯示 / 匯出 ----

/** `user@host`（port 不是預設值才加 `:port`）。 */
export function entryHost(e: Pick<SshOpEntry, "user" | "host" | "port" | "proto">): string {
  const def = e.proto === "ftp" ? 21 : 22;
  const who = e.user ? `${e.user}@${e.host}` : e.host;
  return e.port && e.port !== def ? `${who}:${e.port}` : who;
}

/** 本機時間 `2026-10-02 14:03:05`。 */
export function fmtTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function csvCell(v: string): string {
  const s = /^[=+\-@\t]/.test(v) ? `'${v}` : v;
  return s !== v || /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 匯出 CSV（UTF-8 BOM，Excel 打開中文不會亂碼）。`labels` 給欄名與種類 / 結果 / 來源的顯示字；
 * `hostName` 把已存主機 id 換成名稱。開頭是 = + - @ 的格子前面補 '，免得被試算表當成公式。
 */
export function toCsv(
  entries: readonly SshOpEntry[],
  labels: { header: string[]; kind: (k: string) => string; result: (r: string) => string; source: (s: string) => string },
  hostName: (e: SshOpEntry) => string,
): string {
  const rows = [labels.header];
  for (const e of entries) {
    rows.push([
      fmtTs(e.ts),
      hostName(e),
      entryHost(e),
      e.proto,
      labels.kind(e.kind),
      e.detail,
      e.target ?? "",
      e.cwd ?? "",
      e.source ? labels.source(e.source) : "",
      labels.result(e.result),
      e.message ?? "",
    ]);
  }
  return `﻿${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** 查詢畫面的時間範圍 → `[from, to)`（毫秒；null = 不限）。`days` = 含今天往回幾天。 */
export function rangeFor(days: number | null, now = new Date()): { from: number | null; to: number | null } {
  if (days == null) return { from: null, to: null };
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  return { from: start.getTime(), to: null };
}
