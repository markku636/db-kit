// SSH 終端機的守門：把助手建議的 shell 指令分成 safe / confirm / block，決定「送到終端機 /
// 執行並回饋」按下去之前要不要先問、還是乾脆擋下。
//
// 這是 chatRun.ts 的 shell 版本，而且更沒有退路：SQL 至少還有唯讀連線、審查並執行、逐句備份，
// shell 指令送進 PTY 就是送進去了，rm -rf 沒有 rollback。所以規則刻意寫得保守——寧可多問一次
// 「確定要執行？」，也不要放過一條 `curl … | sh`。
//
// 三個層級的語意：
// - safe：直接送。ls / cat / grep / systemctl status 這類唯讀或可重複執行的指令。
// - confirm：跳 uiConfirm，reasons 就是對話框裡的那句話（「這段指令{reasons}。確定…？」）。
// - block：連確認框都不跳，只能複製、手改再送。留給「沒有任何正當理由由 AI 建議、使用者一鍵
//   送出」的東西：刪根目錄、格式化磁碟、fork bomb。使用者真要做這些事，親手打進終端機就是了。
//
// interactive 是獨立的旗標、不影響層級：vim / top / 沒帶 -e 的 mysql 送進去不會壞事，只是
// 「執行並回饋」等閒置 300 ms 擷取到的會是一個等待輸入的畫面。UI 拿它提示，不拿它擋。
//
// 純函式、不碰 React / DOM / Tauri；解析是「夠用的 shell 語法」而不是完整的 bash parser：
// 引號內不切段、反斜線跳脫、$( ) 與反引號的內容另外遞迴分級、整行 # 註解跳過。
// 認不得的語法一律往保守的方向倒（多切一段、多掃一次），漏掉的成本遠高於多問一次。
import { t } from "./i18n";

export type ShellLevel = "safe" | "confirm" | "block";

export interface ShellVerdict {
  level: ShellLevel;
  /** 依第一次出現的順序、去重；confirm 對話框直接以「、」串起來念。 */
  reasons: string[];
  /** 會停在畫面上等輸入（編輯器 / pager / 沒帶 -e 的 DB CLI）；不影響 level。 */
  interactive: boolean;
}

// ---- 詞法：token 與段落 ----

interface Tok {
  /** 去掉引號與跳脫後的值。 */
  v: string;
  /** 在原字串裡的起點（供「從這個 token 之後原樣切下去」用，保留後段的引號）。 */
  start: number;
}

const isWs = (c: string): boolean => c === " " || c === "\t";

/**
 * 依空白切 token，單雙引號內的空白不切、引號本身去掉、反斜線跳脫還原。
 * `mysql -e "DROP TABLE t"` 要拿到 `DROP TABLE t` 這一整個 token 才掃得到 DROP。
 */
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && isWs(text[i])) i++;
    if (i >= n) break;
    const start = i;
    let v = "";
    let q: "'" | '"' | null = null;
    while (i < n) {
      const c = text[i];
      if (q === "'") {
        if (c === "'") q = null;
        else v += c;
        i++;
        continue;
      }
      if (q === '"') {
        if (c === '"') q = null;
        else if (c === "\\" && i + 1 < n && '"\\$`'.includes(text[i + 1])) v += text[++i];
        else v += c;
        i++;
        continue;
      }
      if (c === "'" || c === '"') {
        q = c;
        i++;
        continue;
      }
      if (c === "\\" && i + 1 < n) {
        v += text[i + 1];
        i += 2;
        continue;
      }
      if (isWs(c)) break;
      v += c;
      i++;
    }
    out.push({ v, start });
  }
  return out;
}

type Sep = "" | "|" | "&&" | "||" | ";" | "&";

interface Segment {
  text: string;
  /** 這一段前面的分隔符；第一段為空。pipe 鏈的判斷（curl | sh）要靠它。 */
  sep: Sep;
}

/**
 * 一行切成段落：`&&` `||` `;` `|` `|&` `&` 都是邊界，引號、反引號、$( ) 內不切，
 * `>&` `<&` `&>` 是重導向不是背景執行，`\;` 是 find -exec 的結尾不是分隔。
 * 出現在空白之後的 `#` 起算註解，到行尾為止（`$#`、`a#b` 不算）。
 */
function splitDetailed(line: string): Segment[] {
  const out: Segment[] = [];
  let cur = "";
  let sep: Sep = "";
  let q: "'" | '"' | "`" | null = null;
  let sub = 0; // $( ) 深度：裡面的 ; | && 屬於子指令，另由 extractSubstitutions 處理
  const push = (next: Sep) => {
    const text = cur.trim();
    if (text) out.push({ text, sep });
    cur = "";
    sep = next;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const nx = line[i + 1];
    if (q === "'" || q === "`") {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === "\\") {
      cur += c + (nx ?? "");
      i++;
      continue;
    }
    if (q === '"') {
      cur += c;
      if (c === '"') q = null;
      else if (c === "$" && nx === "(") {
        sub++;
        cur += nx;
        i++;
      } else if (c === ")" && sub > 0) sub--;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "$" && nx === "(") {
      sub++;
      cur += c + nx;
      i++;
      continue;
    }
    if (c === ")" && sub > 0) {
      sub--;
      cur += c;
      continue;
    }
    if (sub > 0) {
      cur += c;
      continue;
    }
    if (c === "#" && (cur === "" || isWs(cur[cur.length - 1]))) break;
    if (c === "&" && nx === "&") {
      push("&&");
      i++;
      continue;
    }
    if (c === "|" && nx === "|") {
      push("||");
      i++;
      continue;
    }
    if (c === "|") {
      push("|");
      if (nx === "&") i++;
      continue;
    }
    if (c === ";") {
      push(";");
      if (nx === ";") i++;
      continue;
    }
    if (c === "&") {
      const prev = line[i - 1];
      if (prev === ">" || prev === "<" || nx === ">") {
        cur += c;
        continue;
      }
      push("&");
      continue;
    }
    cur += c;
  }
  push("");
  return out;
}

/** 依 `&&` `||` `;` `|` `&` 切段（引號內不切）。 */
export function splitSegments(line: string): string[] {
  return splitDetailed(line).map((s) => s.text);
}

/**
 * 抓出 `$( … )` 與反引號裡的子指令（單引號內的是字面值，不算）。
 * `echo $(rm -rf /)` 的外層 word 是 echo，不另外掃子指令就會整段放行。
 */
function extractSubstitutions(line: string): string[] {
  const out: string[] = [];
  let q: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === "'" && q === null) {
      q = "'";
      continue;
    }
    if (c === '"') {
      q = q === '"' ? null : '"';
      continue;
    }
    if (c === "$" && line[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < line.length && depth > 0; j++) {
        if (line[j] === "\\") j++;
        else if (line[j] === "(") depth++;
        else if (line[j] === ")") depth--;
      }
      out.push(line.slice(i + 2, depth === 0 ? j - 1 : line.length));
      i = j - 1;
      continue;
    }
    if (c === "`") {
      const j = line.indexOf("`", i + 1);
      out.push(j < 0 ? line.slice(i + 1) : line.slice(i + 1, j));
      if (j < 0) break;
      i = j;
    }
  }
  return out;
}

// ---- 前綴包裝：sudo / env / nohup … ----

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"]);
/** 只是語法骨架、後面才是真正的指令。 */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "(", "time"]);

/** 各包裝指令「後面要吃一個參數」的選項；其餘 `-x` 一律當無參數旗標跳過。 */
const ARG_OPTS: Record<string, readonly string[]> = {
  sudo: ["-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-T", "-U", "--user", "--group", "--prompt", "--chdir", "--host", "--role", "--type", "--other-user", "--close-from"],
  doas: ["-u", "-C"],
  pkexec: ["--user"],
  env: ["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
  nice: ["-n", "--adjustment"],
  ionice: ["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  stdbuf: ["-i", "-o", "-e", "--input", "--output", "--error"],
  xargs: ["-I", "-i", "-n", "-L", "-s", "-d", "-a", "-E", "-P", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace", "--max-lines", "--max-chars", "--eof"],
  ssh: ["-p", "-i", "-l", "-o", "-J", "-L", "-R", "-D", "-F", "-W", "-E", "-b", "-c", "-m", "-e", "-O", "-Q", "-S", "-w", "-I", "-B"],
  mysql: ["-h", "-u", "-P", "-e", "-D", "-S", "--host", "--user", "--port", "--execute", "--database", "--socket", "--default-character-set"],
  psql: ["-h", "-p", "-U", "-d", "-c", "-f", "-v", "-o", "-F", "-R", "-T", "-P", "--host", "--port", "--username", "--dbname", "--command", "--file", "--set", "--variable", "--output"],
  "redis-cli": ["-h", "-p", "-a", "-n", "-u", "-s", "--user", "--pass", "-r", "-i"],
  mongosh: ["--host", "--port", "-u", "-p", "--username", "--password", "--authenticationDatabase", "--eval", "-f", "--file"],
  git: ["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
  find: [],
};

/** 從 args[i] 起跳過選項（含要吃參數的），回傳第一個非選項 token 的索引；`--` 結束選項。 */
function skipOpts(args: string[], i: number, withArg: readonly string[] = []): number {
  while (i < args.length) {
    const a = args[i];
    if (a === "--") return i + 1;
    if (!a.startsWith("-") || a === "-") return i;
    // `--user=x` 已含參數；`-u x` / `--user x` 要多跳一個。
    if (!a.includes("=") && withArg.includes(a)) i += 2;
    else i += 1;
  }
  return i;
}

/** `/usr/bin/rm` → `rm`、`\rm`（略過 alias）→ `rm`。 */
function baseWord(v: string): string {
  const s = v.startsWith("\\") ? v.slice(1) : v;
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

interface Stripped {
  /** 剝掉包裝後剩下的指令文字。sub 為 true 時是 `-c` 字串的內容（已去引號），要當一整行重新解析。 */
  text: string;
  root: boolean;
  sub: boolean;
  /** 由 xargs / find -exec 餵參數：rm 就算沒帶 -r 也是批次刪除。 */
  batch: boolean;
  interactive: boolean;
}

/**
 * 剝掉 sudo / doas / su -c / env VAR= / nohup / time / nice / command / exec / setsid / xargs
 * 這些「真正的指令在後面」的前綴。sudo 記下 root；su -c / sh -c 記下 sub（字串裡可能又是一整行）。
 */
function stripWrappers(seg: string): Stripped {
  const out: Stripped = { text: seg.replace(/^[\s({]+/, "").replace(/[\s)}]+$/, ""), root: false, sub: false, batch: false, interactive: false };
  for (let guard = 0; guard < 12; guard++) {
    const toks = tokenize(out.text);
    let i = 0;
    while (i < toks.length && ASSIGN_RE.test(toks[i].v)) i++;
    if (i >= toks.length) {
      out.text = "";
      return out;
    }
    // 前置的 `VAR=x` 指派剝掉再來一輪，讓下面每個分支都從 toks[0] 看起。
    if (i > 0) {
      out.text = out.text.slice(toks[i].start);
      continue;
    }
    const w = baseWord(toks[i].v);
    const args = toks.slice(i + 1).map((x) => x.v);
    const from = (j: number): string => (i + 1 + j < toks.length ? out.text.slice(toks[i + 1 + j].start) : "");

    if (KEYWORDS.has(w) || w === "nohup" || w === "exec" || w === "builtin" || w === "setsid" || w === "busybox") {
      out.text = from(w === "time" || w === "setsid" ? skipOpts(args, 0) : 0);
      continue;
    }
    if (w === "sudo" || w === "doas" || w === "pkexec") {
      out.root = true;
      const j = skipOpts(args, 0, ARG_OPTS[w]);
      // `sudo -i` / `sudo -s` 沒有後續指令：開一個 root shell 等人打字。
      if (j >= args.length) out.interactive = out.interactive || args.some((a) => /^-[A-Za-z]*[is]/.test(a));
      out.text = from(j);
      continue;
    }
    if (w === "su") {
      out.root = true;
      const c = args.findIndex((a) => a === "-c" || a === "--command" || a.startsWith("--command="));
      if (c >= 0) {
        const cmd = args[c].startsWith("--command=") ? args[c].slice("--command=".length) : (args[c + 1] ?? "");
        out.text = cmd;
        out.sub = true;
      } else {
        out.text = "";
        out.interactive = true;
      }
      return out;
    }
    if (SHELLS.has(w)) {
      const c = args.findIndex((a) => /^-[A-Za-z]*c$/.test(a));
      if (c >= 0 && c + 1 < args.length) {
        out.text = args[c + 1];
        out.sub = true;
        return out;
      }
      // `bash` 沒帶腳本 / 字串 → 互動 shell；`bash x.sh` 是跑腳本（內容看不到，不分級）。
      if (skipOpts(args, 0) >= args.length) out.interactive = true;
      return out;
    }
    if (w === "env" || w === "nice" || w === "ionice" || w === "stdbuf" || w === "timeout") {
      let j = skipOpts(args, 0, ARG_OPTS[w]);
      if (w === "env") while (j < args.length && ASSIGN_RE.test(args[j])) j++;
      if (w === "timeout") j++; // 時間長度
      out.text = from(j);
      continue;
    }
    if (w === "command") {
      // `command -v rm` 只是查路徑，不是執行。
      if (args.some((a) => /^-[A-Za-z]*[vV]/.test(a))) {
        out.text = "";
        return out;
      }
      out.text = from(skipOpts(args, 0));
      continue;
    }
    if (w === "xargs") {
      out.batch = true;
      out.text = from(skipOpts(args, 0, ARG_OPTS.xargs));
      continue;
    }
    return out;
  }
  return out;
}

/** 剝掉 sudo / env VAR= / nohup … 之後的第一個字（去路徑）；`su -c "…"` 取字串裡的第一個字。 */
export function commandWord(seg: string): string {
  const s = stripWrappers(seg);
  if (s.sub) {
    const first = splitDetailed(s.text)[0];
    return first ? commandWord(first.text) : "";
  }
  const toks = tokenize(s.text);
  return toks.length ? baseWord(toks[0].v) : "";
}

// ---- 規則 ----

const DEVICE_RE = /^\/dev\/(sd[a-z]+\d*|nvme\d+n\d+(p\d+)?|vd[a-z]+\d*|xvd[a-z]+\d*|hd[a-z]+\d*|mmcblk\d+(p\d+)?|disk\d+(s\d+)?|mapper\/\S+)$/;
/** rm -r 的目標是整個系統或家目錄。 */
const ROOTISH_RE = /^(\/+|\/\*|~|~\/|~\/\*|\$HOME\/?|\$\{HOME\}\/?|\$HOME\/\*|\$\{HOME\}\/\*|\.|\.\.|\.\/|\.\.\/|\/\.|\/\.\.)$/;
/** rm -r 的目標是頂層系統目錄本身（不含底下的子路徑）。 */
const SYS_TOP_RE = /^\/(etc|bin|sbin|usr|lib|lib64|boot|var|dev|proc|sys|root|home|opt)\/?(\*)?$/;
/** 寫入這些目錄要先問：改到的是系統設定 / 二進位，不是使用者自己的檔案。 */
const SYS_DIR_RE = /^(\/etc|\/boot|\/bin|\/sbin|\/usr|\/lib|\/lib64|\/var\/lib|\/proc\/sys|\/sys)(\/|$)/;
/** 只帶變數名的目標：變數沒設定時 `rm -rf "$DIR/"` 就是 `rm -rf /`。 */
const BARE_VAR_RE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\/?$/;
const FORK_BOMB_RE = /([A-Za-z_:][\w:]*)\s*\(\)\s*\{\s*\1\s*\|\s*\1\s*&\s*;?\s*\}\s*;?\s*\1(?![\w:])/;
const FORK_LOOP_RE = /\bfork\s+while\s+fork\b/i;
/** `bash <(curl …)` / `sh -c "$(wget …)"` / `source <(curl …)`：下載回來的東西直接當程式跑。 */
const NET_EXEC_RE = /^\s*(?:(?:sudo|doas|env|nohup|exec)\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:(?:sh|bash|zsh|dash|ksh|fish|source|eval)\b|\.(?=\s)).*?(?:<\(|\$\(|`)\s*(?:curl|wget)\b/;
const DB_DESTRUCTIVE_RE = /\b(drop|truncate|delete\s+from|flushall|flushdb|dropDatabase|deleteMany|drop_database)\b/i;
const HISTFILE_RE = /(^|\s)(export\s+)?HISTFILE=|\bset\s+\+o\s+history\b/;
const REDIRECT_RE = /(?<![<>&])(\d*)(>{1,2}|&>>?|>\|)(?![>&])\s*["']?([^\s"'&|;<>]+)/g;

const PKG_MANAGERS = new Set(["apt", "apt-get", "aptitude", "yum", "dnf", "zypper", "apk", "brew", "snap", "pip", "pip3", "pipx", "npm", "pnpm", "yarn", "gem", "cargo", "flatpak", "choco", "winget"]);
const PKG_REMOVE = new Set(["remove", "purge", "autoremove", "erase", "uninstall", "del", "rm", "un", "unlink", "r"]);
const DB_CLIS = new Set(["mysql", "mariadb", "psql", "sqlite3", "mongosh", "mongo", "redis-cli", "clickhouse-client", "cqlsh"]);
const CONTAINER_CLIS = new Set(["docker", "podman", "nerdctl", "docker-compose"]);
const ALWAYS_INTERACTIVE = new Set([
  "vim", "vi", "nvim", "vimdiff", "nano", "pico", "emacs", "micro", "top", "htop", "btop", "atop", "iotop", "iftop", "nload", "glances",
  "less", "more", "most", "man", "watch", "tmux", "screen", "telnet", "ftp", "lftp", "sftp", "irb", "mc", "ranger", "read",
  "visudo", "vipw", "cfdisk", "mysql_secure_installation", "dpkg-reconfigure", "raspi-config", "nmtui", "alsamixer",
]);

interface Split {
  flags: string[];
  ops: string[];
}

/** 旗標與運算元分家；`--` 之後全是運算元。單獨的 `-`（stdin）算運算元。 */
function splitArgs(args: string[]): Split {
  const flags: string[] = [];
  const ops: string[] = [];
  let done = false;
  for (const a of args) {
    if (done) ops.push(a);
    else if (a === "--") done = true;
    else if (a.startsWith("-") && a !== "-") flags.push(a);
    else ops.push(a);
  }
  return { flags, ops };
}

const hasShort = (flags: string[], letter: string): boolean =>
  flags.some((f) => !f.startsWith("--") && f.slice(1).includes(letter));

/** chmod 的 mode 會不會讓所有人可寫：`777` / `666` / `o+w` / `a+w` / `+w`。 */
function worldWritable(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) return (Number(mode[mode.length - 1]) & 2) !== 0;
  return mode.split(",").some((clause) => /^(?:[ugo]*[oa][ugo]*|)[+=][rwxXst]*w/.test(clause));
}

function bump(v: ShellVerdict, level: ShellLevel, reason: string): void {
  if (level === "block" || (level === "confirm" && v.level === "safe")) v.level = level;
  if (!v.reasons.includes(reason)) v.reasons.push(reason);
}

function merge(into: ShellVerdict, from: ShellVerdict): void {
  if (from.level === "block" || (from.level === "confirm" && into.level === "safe")) into.level = from.level;
  for (const r of from.reasons) if (!into.reasons.includes(r)) into.reasons.push(r);
  into.interactive = into.interactive || from.interactive;
}

const empty = (): ShellVerdict => ({ level: "safe", reasons: [], interactive: false });

/** pipe 的下游是不是「把 stdin 當程式跑」的東西（`| sh`、`| python3 -`；`| python -m json.tool` 不是）。 */
function isExecSink(word: string, args: string[]): boolean {
  const { flags, ops } = splitArgs(args);
  if (SHELLS.has(word)) return !flags.some((f) => /^-[A-Za-z]*c$/.test(f));
  if (/^python[0-9.]*$/.test(word)) return !flags.some((f) => /^-[A-Za-z]*[cm]/.test(f)) && ops.every((o) => o === "-");
  if (word === "perl") return !flags.some((f) => /^-[A-Za-z]*[eEnp]/.test(f)) && ops.every((o) => o === "-");
  if (word === "ruby") return !flags.some((f) => /^-[A-Za-z]*e/.test(f)) && ops.every((o) => o === "-");
  if (word === "node" || word === "nodejs") return !flags.some((f) => /^-[A-Za-z]*[ep]/.test(f) || f.startsWith("--eval") || f.startsWith("--print")) && ops.every((o) => o === "-");
  if (word === "php") return !flags.some((f) => /^-[A-Za-z]*r/.test(f)) && ops.every((o) => o === "-");
  return false;
}

function isDecoder(word: string, args: string[]): boolean {
  if (word === "base64" || word === "base32") return args.some((a) => a === "-d" || a === "-D" || a === "--decode" || /^-[A-Za-z]*d/.test(a));
  if (word === "openssl") return args.includes("-d") || args.includes("-base64") || args.includes("base64");
  if (word === "xxd") return args.includes("-r") || args.includes("-p");
  return word === "uudecode";
}

/** 有沒有把「所有人 / 不特定人」的檔案一次交出去：`cp x /etc/…`、`curl -o /usr/local/bin/x`。 */
function writeTargets(word: string, args: string[]): string[] {
  const { flags, ops } = splitArgs(args);
  switch (word) {
    case "tee":
    case "ln":
    case "install":
      return ops;
    case "sed":
      return hasShort(flags, "i") || flags.some((f) => f.startsWith("--in-place")) ? ops : [];
    case "mv":
    case "cp":
    case "rsync":
      return ops.length >= 2 ? [ops[ops.length - 1]] : [];
    case "curl":
    case "wget": {
      // curl 是 `-o 檔名`（`-O` 是「用遠端檔名」、不吃參數）；wget 相反，是 `-O 檔名`。
      const letter = word === "curl" ? "o" : "O";
      const cluster = new RegExp(`^-[A-Za-z]*${letter}$`);
      const attached = new RegExp(`^-${letter}(\\/.+)$`);
      const out: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--output" || a === "--output-document" || cluster.test(a)) {
          if (i + 1 < args.length) out.push(args[i + 1]);
        } else if (a.startsWith("--output=") || a.startsWith("--output-document=")) out.push(a.slice(a.indexOf("=") + 1));
        else {
          const m = attached.exec(a);
          if (m) out.push(m[1]);
        }
      }
      return out;
    }
    default:
      return [];
  }
}

/** 互動判斷：會停下來等人打字的程式。level 不變，只是提示。 */
function isInteractive(word: string, args: string[], raw: string): boolean {
  const { flags, ops } = splitArgs(args);
  if (ALWAYS_INTERACTIVE.has(word)) return !(word === "top" && hasShort(flags, "b"));
  const hasStdin = /<(?!\()/.test(raw); // `mysql < dump.sql` 是餵檔案，不是等人
  switch (word) {
    case "ssh": {
      const j = skipOpts(args, 0, ARG_OPTS.ssh);
      return args.slice(j).filter((a) => !a.startsWith("-")).length < 2;
    }
    case "mysql":
    case "mariadb":
      return !hasStdin && !flags.some((f) => /^-[A-Za-z]*e$/.test(f) || f.startsWith("--execute"));
    case "psql":
      return !hasStdin && !flags.some((f) => /^-[A-Za-z]*[cfl]$/.test(f) || /^--(command|file|list)/.test(f));
    case "sqlite3":
      return !hasStdin && ops.length < 2;
    case "mongosh":
    case "mongo":
      return !hasStdin && !flags.some((f) => f.startsWith("--eval") || f === "-f" || f.startsWith("--file")) && !ops.some((o) => o.endsWith(".js"));
    case "redis-cli":
      return args.slice(skipOpts(args, 0, ARG_OPTS["redis-cli"])).length === 0;
    case "python":
    case "python2":
    case "python3":
      return (ops.length === 0 && !flags.some((f) => /^-[A-Za-z]*[cm]/.test(f))) || hasShort(flags, "i");
    case "node":
    case "nodejs":
      return ops.length === 0 && !flags.some((f) => /^-[A-Za-z]*[ep]/.test(f) || f.startsWith("--eval") || f.startsWith("--print")) && !hasStdin;
    case "php":
      return hasShort(flags, "a");
    case "tail":
      return hasShort(flags, "f") || hasShort(flags, "F") || flags.some((f) => f.startsWith("--follow"));
    case "journalctl":
    case "dmesg":
      return hasShort(flags, "f") || hasShort(flags, "w") || flags.some((f) => f.startsWith("--follow"));
    case "ping":
      return !flags.some((f) => /^-[A-Za-z]*[cwW]/.test(f));
    case "crontab":
      return hasShort(flags, "e");
    case "passwd":
      return true;
    case "rm":
    case "cp":
    case "mv":
    case "ln":
      return hasShort(flags, "i");
    case "docker":
    case "podman":
    case "nerdctl":
      return (ops[0] === "exec" || ops[0] === "run" || ops[0] === "attach") &&
        (flags.some((f) => /^-[A-Za-z]*i[A-Za-z]*t|^-[A-Za-z]*t[A-Za-z]*i/.test(f)) || (flags.includes("-i") && flags.includes("-t")) || flags.includes("--interactive"));
    case "kubectl":
      return ((ops[0] === "exec" || ops[0] === "attach") && (flags.some((f) => /^-[A-Za-z]*i[A-Za-z]*t|^-[A-Za-z]*t[A-Za-z]*i/.test(f)) || flags.includes("-i"))) ||
        (ops[0] === "logs" && (hasShort(flags, "f") || flags.includes("--follow")));
    case "git": {
      const sub = ops[0];
      if (sub === "rebase" || sub === "add") return hasShort(flags, "i") || hasShort(flags, "p") || flags.includes("--interactive") || flags.includes("--patch");
      // 沒給訊息的 commit 會開編輯器。
      if (sub === "commit") return !hasShort(flags, "m") && !hasShort(flags, "F") && !flags.some((f) => f.startsWith("--message") || f.startsWith("--file") || f === "--no-edit" || f.startsWith("--reuse-message"));
      return false;
    }
    case "apt":
    case "apt-get":
    case "yum":
    case "dnf":
      return ["install", "remove", "purge", "upgrade", "dist-upgrade", "full-upgrade", "autoremove", "reinstall"].includes(ops[0]) &&
        !hasShort(flags, "y") && !flags.includes("--yes") && !flags.includes("--assume-yes") && !flags.includes("--assumeyes");
    case "pacman":
      return flags.some((f) => /^-[A-Za-z]*[SRU]/.test(f)) && !flags.includes("--noconfirm");
    case "zypper":
      return ["install", "in", "remove", "rm", "update", "up", "dist-upgrade", "dup", "patch"].includes(ops[0]) && !hasShort(flags, "n") && !flags.includes("--non-interactive");
    default:
      return false;
  }
}

/** 一段（沒有 && ; | 的最小單位）的分級。batch：由 xargs / find -exec 餵參數。 */
function classifySegment(seg: string, depth: number, batch = false): ShellVerdict {
  const v = empty();
  // 這三條看的是剝包裝**之前**的原文：`HISTFILE=/dev/null bash` 的指派會被當環境變數剝掉，
  // `bash -c "$(curl …)"` 的 -c 字串則要連著前面的 bash 一起看才成立。
  if (NET_EXEC_RE.test(seg)) bump(v, "confirm", t("透過網路下載並直接執行"));
  if (HISTFILE_RE.test(seg)) bump(v, "confirm", t("清除指令歷史"));
  if (/\/dev\/(tcp|udp)\//.test(seg)) bump(v, "confirm", t("建立反向連線"));
  const s = stripWrappers(seg);
  if (s.root) bump(v, "confirm", t("以 root 權限執行"));
  if (s.interactive) v.interactive = true;
  if (s.sub) {
    merge(v, classifyLine(s.text, depth + 1));
    return v;
  }
  const raw = s.text;
  if (!raw) return v;
  const toks = tokenize(raw);
  const word = baseWord(toks[0].v);
  const args = toks.slice(1).map((x) => x.v);
  const { flags, ops } = splitArgs(args);
  batch = batch || s.batch;

  if (isInteractive(word, args, raw)) v.interactive = true;

  // 重導向：寫進磁碟裝置是 block，覆寫系統目錄要問。`>>`（附加）刻意不算——計畫如此，
  // 而且 `echo … >> ~/.bashrc` 這種常見寫法一律要問的話，確認框很快就會被無腦按掉。
  for (const m of raw.matchAll(REDIRECT_RE)) {
    const [, , op, target] = m;
    if (DEVICE_RE.test(target)) bump(v, "block", t("直接寫入磁碟裝置"));
    else if (op !== ">>" && op !== "&>>" && SYS_DIR_RE.test(target)) bump(v, "confirm", t("寫入系統目錄"));
  }

  for (const target of writeTargets(word, args)) {
    if (DEVICE_RE.test(target)) bump(v, "block", t("直接寫入磁碟裝置"));
    else if (SYS_DIR_RE.test(target)) bump(v, "confirm", t("寫入系統目錄"));
  }

  switch (word) {
    case "rm":
    case "unlink": {
      const recursive = word === "rm" && (hasShort(flags, "r") || hasShort(flags, "R") || flags.includes("--recursive"));
      const force = hasShort(flags, "f") || flags.includes("--force");
      const noPreserve = flags.includes("--no-preserve-root");
      if (recursive && (noPreserve || ops.some((o) => ROOTISH_RE.test(o)))) bump(v, "block", t("遞迴刪除根目錄或家目錄"));
      else if (recursive && ops.some((o) => SYS_TOP_RE.test(o))) bump(v, "block", t("遞迴刪除系統目錄"));
      else if (recursive || batch) {
        bump(v, "confirm", t("遞迴刪除"));
        if (recursive && ops.some((o) => BARE_VAR_RE.test(o))) bump(v, "confirm", t("目標為變數，未設定時可能刪到根目錄"));
      } else if (force || ops.some((o) => /[*?[]|\$/.test(o))) bump(v, "confirm", t("強制或批次刪除檔案"));
      else bump(v, "confirm", t("刪除檔案"));
      break;
    }
    case "find": {
      if (args.includes("-delete")) bump(v, "confirm", t("遞迴刪除"));
      for (let i = 0; i < args.length; i++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i])) continue;
        const end = args.findIndex((a, j) => j > i && (a === ";" || a === "+"));
        const sub = args.slice(i + 1, end < 0 ? args.length : end).join(" ");
        if (sub) merge(v, classifySegment(sub, depth + 1, true));
      }
      break;
    }
    case "rsync":
      if (flags.some((f) => f.startsWith("--delete") || f === "--remove-source-files")) bump(v, "confirm", t("遞迴刪除"));
      break;
    case "dd":
      bump(v, "confirm", t("以 dd 寫入資料"));
      for (const a of args) {
        const m = /^of=["']?(.+?)["']?$/.exec(a);
        if (m && DEVICE_RE.test(m[1])) bump(v, "block", t("直接寫入磁碟裝置"));
      }
      break;
    case "wipefs":
    case "shred":
    case "mke2fs":
    case "mkswap":
      if (ops.some((o) => o.startsWith("/dev/"))) bump(v, "block", t("格式化 / 抹除磁碟裝置"));
      else bump(v, "confirm", t("磁碟分割 / 格式化 / 抹除"));
      break;
    case "fdisk":
    case "sfdisk":
    case "parted":
    case "gdisk":
    case "cfdisk":
      // `fdisk -l` / `parted -l` 只是列出分割表。
      if (!hasShort(flags, "l") && !flags.includes("--list")) bump(v, "confirm", t("磁碟分割 / 格式化 / 抹除"));
      break;
    case "truncate":
      bump(v, "confirm", t("截斷檔案內容"));
      break;
    case "chmod":
    case "chown":
    case "chgrp": {
      const recursive = hasShort(flags, "R") || flags.includes("--recursive");
      if (recursive && ops.some((o) => /^\/+$/.test(o))) bump(v, "block", t("遞迴變更根目錄權限"));
      else if (recursive) bump(v, "confirm", t("遞迴變更權限"));
      if (word === "chmod" && ops.length && worldWritable(ops[0])) bump(v, "confirm", t("開放寫入權限"));
      break;
    }
    case "shutdown":
    case "reboot":
    case "halt":
    case "poweroff":
    case "telinit":
      bump(v, "confirm", t("關機或重新開機"));
      break;
    case "init":
      if (ops.includes("0") || ops.includes("6")) bump(v, "confirm", t("關機或重新開機"));
      break;
    case "systemctl":
      if (ops.some((o) => ["reboot", "poweroff", "halt", "kexec"].includes(o))) bump(v, "confirm", t("關機或重新開機"));
      if (ops.some((o) => ["stop", "disable", "mask", "restart", "kill"].includes(o))) bump(v, "confirm", t("停止、重啟或停用服務"));
      break;
    case "service":
    case "rc-service":
      if (ops.some((o) => ["stop", "restart", "force-reload"].includes(o))) bump(v, "confirm", t("停止、重啟或停用服務"));
      break;
    case "kill":
      // `kill -9 -1`：訊號後面的 -1 是「所有程序」；`kill -1 123` 的 -1 則是 SIGHUP。
      if (args.slice(1).includes("-1") || ops.includes("1")) bump(v, "confirm", t("終止所有程序"));
      break;
    case "killall":
    case "killall5":
    case "pkill":
      bump(v, "confirm", t("依名稱終止程序"));
      break;
    case "iptables":
    case "ip6tables":
      if (args.some((a) => ["-F", "--flush", "-X", "--delete-chain"].includes(a) || /^-[A-Za-z]*[FX]$/.test(a)) ||
        ((args.includes("-P") || args.includes("--policy")) && (args.includes("DROP") || args.includes("REJECT")))) bump(v, "confirm", t("變更防火牆規則"));
      break;
    case "nft":
      if (ops.includes("flush")) bump(v, "confirm", t("變更防火牆規則"));
      break;
    case "ufw":
      if (ops.includes("disable") || ops.includes("reset")) bump(v, "confirm", t("變更防火牆規則"));
      break;
    case "firewall-cmd":
      if (flags.includes("--panic-on")) bump(v, "confirm", t("變更防火牆規則"));
      break;
    case "crontab":
      if (hasShort(flags, "r")) bump(v, "confirm", t("清除排程"));
      break;
    case "history":
      if (hasShort(flags, "c")) bump(v, "confirm", t("清除指令歷史"));
      break;
    case "unset":
      if (ops.includes("HISTFILE")) bump(v, "confirm", t("清除指令歷史"));
      break;
    case "pacman":
      if (flags.some((f) => /^-R/.test(f))) bump(v, "confirm", t("移除套件"));
      break;
    case "dpkg":
      if (hasShort(flags, "r") || hasShort(flags, "P") || flags.includes("--remove") || flags.includes("--purge")) bump(v, "confirm", t("移除套件"));
      break;
    case "rpm":
      if (hasShort(flags, "e") || flags.includes("--erase")) bump(v, "confirm", t("移除套件"));
      break;
    case "kubectl":
      if (ops.includes("delete") || ops.includes("drain")) bump(v, "confirm", t("刪除叢集 / 雲端資源"));
      break;
    case "helm":
      if (ops.includes("uninstall") || ops.includes("delete")) bump(v, "confirm", t("刪除叢集 / 雲端資源"));
      break;
    case "terraform":
    case "tofu":
      if (ops.includes("destroy")) bump(v, "confirm", t("刪除叢集 / 雲端資源"));
      break;
    case "git": {
      const j = skipOpts(args, 0, ARG_OPTS.git);
      const sub = args[j];
      const rest = args.slice(j + 1);
      const rf = splitArgs(rest).flags;
      const rops = splitArgs(rest).ops;
      const rewrite =
        (sub === "push" && (rf.some((f) => f.startsWith("--force") || f === "--mirror" || f === "--delete" || /^-[A-Za-z]*[fd]/.test(f)) || rops.some((o) => o.startsWith(":")))) ||
        (sub === "reset" && rf.includes("--hard")) ||
        (sub === "clean" && !hasShort(rf, "n") && !rf.includes("--dry-run") && rf.some((f) => /^-[A-Za-z]*[fdx]/.test(f) || f === "--force")) ||
        (sub === "checkout" && (rest.includes("--") || rops.some((o) => o === "." || o.endsWith("/.")))) ||
        (sub === "restore" && !rf.includes("--staged") && rops.length > 0) ||
        (sub === "branch" && (rf.includes("-D") || (rf.includes("--delete") && rf.includes("--force")) || rf.some((f) => /^-[A-Za-z]*D/.test(f)))) ||
        (sub === "stash" && (rops.includes("drop") || rops.includes("clear"))) ||
        sub === "filter-branch" || sub === "filter-repo";
      if (rewrite) bump(v, "confirm", t("覆寫 git 歷史或丟棄變更"));
      break;
    }
    case "dropdb":
      bump(v, "confirm", t("執行破壞性資料庫語句"));
      break;
    case "mysqladmin":
      if (ops.includes("drop") || ops.includes("shutdown")) bump(v, "confirm", t("執行破壞性資料庫語句"));
      break;
    case "userdel":
    case "deluser":
    case "groupdel":
    case "delgroup":
    case "chpasswd":
    case "passwd":
      bump(v, "confirm", t("變更使用者帳號"));
      break;
    case "usermod":
      if (hasShort(flags, "L") || flags.includes("--lock") || hasShort(flags, "e") || flags.includes("--expiredate")) bump(v, "confirm", t("變更使用者帳號"));
      break;
    case "umount":
      bump(v, "confirm", t("掛載 / 卸載檔案系統"));
      break;
    case "mount":
      if (args.some((a) => /\bremount\b/.test(a))) bump(v, "confirm", t("掛載 / 卸載檔案系統"));
      break;
    case "eval":
      bump(v, "confirm", t("執行動態組出的指令（eval）"));
      break;
    case "nc":
    case "ncat":
    case "netcat":
      if (flags.some((f) => /^-[A-Za-z]*[ec]/.test(f) || f === "--exec" || f === "--sh-exec")) bump(v, "confirm", t("建立反向連線"));
      break;
    case "socat":
      if (args.some((a) => /^exec:/i.test(a))) bump(v, "confirm", t("建立反向連線"));
      break;
    default:
      if (/^mkfs(\.|$)/.test(word)) {
        if (ops.some((o) => o.startsWith("/dev/"))) bump(v, "block", t("格式化 / 抹除磁碟裝置"));
        else bump(v, "confirm", t("磁碟分割 / 格式化 / 抹除"));
      } else if (PKG_MANAGERS.has(word)) {
        if (ops.some((o) => PKG_REMOVE.has(o))) bump(v, "confirm", t("移除套件"));
      } else if (CONTAINER_CLIS.has(word)) {
        // 比計畫寬：`docker rm` 不帶 -f 也問。停掉的容器一樣有人要它的 log 與 volume。
        const dangerous =
          ops.includes("prune") ||
          ops[0] === "rm" || ops[0] === "rmi" ||
          ((ops[0] === "volume" || ops[0] === "network" || ops[0] === "container" || ops[0] === "image") && (ops[1] === "rm" || ops[1] === "remove")) ||
          ((ops[0] === "compose" ? ops[1] : word === "docker-compose" ? ops[0] : "") === "down" && (hasShort(flags, "v") || flags.includes("--volumes") || flags.some((f) => f.startsWith("--rmi"))));
        if (dangerous) bump(v, "confirm", t("刪除容器 / 映像 / 資料卷"));
      } else if (DB_CLIS.has(word)) {
        if (DB_DESTRUCTIVE_RE.test(raw)) bump(v, "confirm", t("執行破壞性資料庫語句"));
      }
  }
  return v;
}

/** 一行（可能含 && ; | 與 $( )）的分級。 */
function classifyLine(line: string, depth: number): ShellVerdict {
  const v = empty();
  // 遞迴深度上限：`bash -c "bash -c '…'"` 這種一層層包下去的，掃到第四層還沒見底就當可疑。
  if (depth > 4) {
    bump(v, "confirm", t("指令巢狀過深，無法判讀"));
    return v;
  }
  if (FORK_BOMB_RE.test(line) || FORK_LOOP_RE.test(line)) bump(v, "block", t("fork bomb（會耗盡系統資源）"));

  // pipe 鏈：上游是 curl / wget / base64 -d、下游把 stdin 當程式跑。
  let download = false;
  let decode = false;
  for (const seg of splitDetailed(line)) {
    if (seg.sep !== "|") {
      download = false;
      decode = false;
    }
    merge(v, classifySegment(seg.text, depth));
    const s = stripWrappers(seg.text);
    if (s.sub || !s.text) continue;
    const toks = tokenize(s.text);
    const word = baseWord(toks[0].v);
    const args = toks.slice(1).map((x) => x.v);
    if (isExecSink(word, args)) {
      if (download) bump(v, "confirm", t("透過網路下載並直接執行"));
      if (decode) bump(v, "confirm", t("執行編碼過的指令"));
    }
    if (word === "curl" || word === "wget") download = true;
    if (isDecoder(word, args)) decode = true;
  }
  for (const sub of extractSubstitutions(line)) merge(v, classifyLine(sub, depth + 1));
  return v;
}

/**
 * 整段腳本的分級：逐行掃、最嚴重的層級勝出、reasons 依第一次出現的順序去重。
 * 整行 `#` 註解跳過；行尾反斜線接到下一行；heredoc 的內容**也**照常分級——
 * `cat <<EOF | sh` 裡的每一行都會被執行，寧可對一份純文字多問一次。
 */
export function classifyShell(script: string): ShellVerdict {
  const v = empty();
  const joined = script.replace(/\\\r?\n/g, " ");
  for (const rawLine of joined.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    merge(v, classifyLine(line, 0));
  }
  return v;
}
