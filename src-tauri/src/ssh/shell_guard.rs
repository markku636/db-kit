//! SSH 指令守門：把一段 shell 指令分成 safe / confirm / block——前端 `src/shellGuard.ts` 的 Rust 版。
//!
//! 前端拿它決定助手建議的指令「送到終端機」前要不要問；這裡給 `dbk mcp` 的 `ssh_run` 用。兩邊的規則
//! 必須一模一樣：同一條指令在 App 裡要確認、透過 MCP 卻直接跑，守門就破了。兩份實作由
//! `tests/fixtures/shell-guard-cases.json` 釘住（前端 `shellGuard.test.ts` 跑同一份），改規則要兩邊一起改。
//!
//! 層級的語意（細節見 TS 版開頭）：
//! - safe：直接執行。
//! - confirm：要使用者明確同意。
//! - block：沒有任何正當理由由 AI 代為執行（刪根目錄、格式化磁碟、fork bomb）。
//! - interactive：會停下來等人打字（vim / top / 沒帶 -e 的 mysql）；獨立旗標，不影響層級。
//!
//! 解析是「夠用的 shell 語法」而不是完整的 bash parser；認不得的語法一律往保守的方向倒。
//! 理由（`reasons`）存繁中原文 key，顯示時才經 `i18n::lookup` 翻譯——測試比對 key，不受語言設定影響。
//!
//! 與 TS 版的差異只在正規表示式的寫法：Rust `regex` 沒有 lookaround / backreference，
//! 重導向改手寫掃描（`redirects`）、fork bomb 改「抓四個名字再比相等」，語意相同。

use once_cell::sync::Lazy;
use regex::Regex;

/// 分級。順序即嚴重度（`Ord`）：合併時取最嚴重的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ShellLevel {
    Safe,
    Confirm,
    Block,
}

impl ShellLevel {
    /// 與前端 `ShellLevel` 字串相同（共用案例比對用）。
    #[cfg(test)]
    pub fn as_str(self) -> &'static str {
        match self {
            ShellLevel::Safe => "safe",
            ShellLevel::Confirm => "confirm",
            ShellLevel::Block => "block",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellVerdict {
    pub level: ShellLevel,
    /// 依第一次出現的順序、去重；繁中原文 key（`reason_texts` 取目前語言的文字）。
    pub reasons: Vec<&'static str>,
    /// 會停在畫面上等輸入；不影響 level。
    pub interactive: bool,
}

impl ShellVerdict {
    fn empty() -> Self {
        Self { level: ShellLevel::Safe, reasons: Vec::new(), interactive: false }
    }

    fn bump(&mut self, level: ShellLevel, reason: &'static str) {
        self.level = self.level.max(level);
        if !self.reasons.contains(&reason) {
            self.reasons.push(reason);
        }
    }

    fn merge(&mut self, from: ShellVerdict) {
        self.level = self.level.max(from.level);
        for r in from.reasons {
            if !self.reasons.contains(&r) {
                self.reasons.push(r);
            }
        }
        self.interactive |= from.interactive;
    }

    /// 理由的顯示文字（目前語言）。
    pub fn reason_texts(&self) -> Vec<&'static str> {
        self.reasons.iter().map(|r| crate::i18n::lookup(r)).collect()
    }
}

/// 理由的原文 key（與前端 `t("…")` 同一句；譯文在 `locales/*.rs`）。
pub mod reason {
    pub const NET_EXEC: &str = "透過網路下載並直接執行";
    pub const HISTORY: &str = "清除指令歷史";
    pub const REVERSE_SHELL: &str = "建立反向連線";
    pub const ROOT: &str = "以 root 權限執行";
    pub const DEVICE_WRITE: &str = "直接寫入磁碟裝置";
    pub const SYS_DIR: &str = "寫入系統目錄";
    pub const RM_ROOT: &str = "遞迴刪除根目錄或家目錄";
    pub const RM_SYS: &str = "遞迴刪除系統目錄";
    pub const RM_RECURSIVE: &str = "遞迴刪除";
    pub const RM_VAR: &str = "目標為變數，未設定時可能刪到根目錄";
    pub const RM_FORCE: &str = "強制或批次刪除檔案";
    pub const RM_FILE: &str = "刪除檔案";
    pub const DD: &str = "以 dd 寫入資料";
    pub const FORMAT_DEVICE: &str = "格式化 / 抹除磁碟裝置";
    pub const FORMAT: &str = "磁碟分割 / 格式化 / 抹除";
    pub const TRUNCATE: &str = "截斷檔案內容";
    pub const CHMOD_ROOT: &str = "遞迴變更根目錄權限";
    pub const CHMOD_RECURSIVE: &str = "遞迴變更權限";
    pub const WORLD_WRITABLE: &str = "開放寫入權限";
    pub const POWER: &str = "關機或重新開機";
    pub const SERVICE: &str = "停止、重啟或停用服務";
    pub const KILL_ALL: &str = "終止所有程序";
    pub const KILL_NAME: &str = "依名稱終止程序";
    pub const FIREWALL: &str = "變更防火牆規則";
    pub const CRON: &str = "清除排程";
    pub const PKG_REMOVE: &str = "移除套件";
    pub const CLOUD_DELETE: &str = "刪除叢集 / 雲端資源";
    pub const GIT_REWRITE: &str = "覆寫 git 歷史或丟棄變更";
    pub const DB_DESTRUCTIVE: &str = "執行破壞性資料庫語句";
    pub const USER: &str = "變更使用者帳號";
    pub const MOUNT: &str = "掛載 / 卸載檔案系統";
    pub const EVAL: &str = "執行動態組出的指令（eval）";
    pub const CONTAINER_DELETE: &str = "刪除容器 / 映像 / 資料卷";
    pub const ENCODED: &str = "執行編碼過的指令";
    pub const TOO_DEEP: &str = "指令巢狀過深，無法判讀";
    pub const FORK_BOMB: &str = "fork bomb（會耗盡系統資源）";
}

use reason as r;

// ---- 詞法：token 與段落 ----

pub(crate) struct Tok {
    /// 去掉引號與跳脫後的值。
    pub v: String,
    /// 在原字串裡的起點（位元組）：「從這個 token 之後原樣切下去」用，保留後段的引號。
    pub start: usize,
}

fn is_ws(c: char) -> bool {
    c == ' ' || c == '\t'
}

/// 依空白切 token，單雙引號內的空白不切、引號本身去掉、反斜線跳脫還原。
pub(crate) fn tokenize(text: &str) -> Vec<Tok> {
    let cs: Vec<(usize, char)> = text.char_indices().collect();
    let n = cs.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        while i < n && is_ws(cs[i].1) {
            i += 1;
        }
        if i >= n {
            break;
        }
        let start = cs[i].0;
        let mut v = String::new();
        let mut q: Option<char> = None;
        while i < n {
            let c = cs[i].1;
            if q == Some('\'') {
                if c == '\'' {
                    q = None;
                } else {
                    v.push(c);
                }
                i += 1;
                continue;
            }
            if q == Some('"') {
                if c == '"' {
                    q = None;
                } else if c == '\\' && i + 1 < n && "\"\\$`".contains(cs[i + 1].1) {
                    i += 1;
                    v.push(cs[i].1);
                } else {
                    v.push(c);
                }
                i += 1;
                continue;
            }
            if c == '\'' || c == '"' {
                q = Some(c);
                i += 1;
                continue;
            }
            if c == '\\' && i + 1 < n {
                v.push(cs[i + 1].1);
                i += 2;
                continue;
            }
            if is_ws(c) {
                break;
            }
            v.push(c);
            i += 1;
        }
        out.push(Tok { v, start });
    }
    out
}

/// 段落前面的分隔符。pipe 鏈的判斷（curl | sh）要靠它。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Sep {
    None,
    Pipe,
    And,
    Or,
    Semi,
    Amp,
}

pub(crate) struct Segment {
    pub text: String,
    pub sep: Sep,
}

/// 一行切成段落：`&&` `||` `;` `|` `|&` `&` 都是邊界，引號、反引號、$( ) 內不切，
/// `>&` `<&` `&>` 是重導向不是背景執行，`\;` 是 find -exec 的結尾不是分隔。
/// 出現在空白之後的 `#` 起算註解，到行尾為止。
pub(crate) fn split_detailed(line: &str) -> Vec<Segment> {
    fn push(out: &mut Vec<Segment>, cur: &mut String, sep: &mut Sep, next: Sep) {
        let t = cur.trim();
        if !t.is_empty() {
            out.push(Segment { text: t.to_string(), sep: *sep });
        }
        cur.clear();
        *sep = next;
    }
    let cs: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut sep = Sep::None;
    let mut q: Option<char> = None;
    let mut sub = 0usize; // $( ) 深度：裡面的 ; | && 屬於子指令，另由 extract_substitutions 處理
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        let nx = cs.get(i + 1).copied();
        if q == Some('\'') || q == Some('`') {
            cur.push(c);
            if Some(c) == q {
                q = None;
            }
            i += 1;
            continue;
        }
        if c == '\\' {
            cur.push(c);
            if let Some(n) = nx {
                cur.push(n);
            }
            i += 2;
            continue;
        }
        if q == Some('"') {
            cur.push(c);
            if c == '"' {
                q = None;
            } else if c == '$' && nx == Some('(') {
                sub += 1;
                cur.push('(');
                i += 1;
            } else if c == ')' && sub > 0 {
                sub -= 1;
            }
            i += 1;
            continue;
        }
        if c == '\'' || c == '"' || c == '`' {
            q = Some(c);
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '$' && nx == Some('(') {
            sub += 1;
            cur.push_str("$(");
            i += 2;
            continue;
        }
        if c == ')' && sub > 0 {
            sub -= 1;
            cur.push(c);
            i += 1;
            continue;
        }
        if sub > 0 {
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '#' && cur.chars().last().map_or(true, is_ws) {
            break;
        }
        if c == '&' && nx == Some('&') {
            push(&mut out, &mut cur, &mut sep, Sep::And);
            i += 2;
            continue;
        }
        if c == '|' && nx == Some('|') {
            push(&mut out, &mut cur, &mut sep, Sep::Or);
            i += 2;
            continue;
        }
        if c == '|' {
            push(&mut out, &mut cur, &mut sep, Sep::Pipe);
            i += if nx == Some('&') { 2 } else { 1 };
            continue;
        }
        if c == ';' {
            push(&mut out, &mut cur, &mut sep, Sep::Semi);
            i += if nx == Some(';') { 2 } else { 1 };
            continue;
        }
        if c == '&' {
            let prev = if i > 0 { Some(cs[i - 1]) } else { None };
            if prev == Some('>') || prev == Some('<') || nx == Some('>') {
                cur.push(c);
                i += 1;
                continue;
            }
            push(&mut out, &mut cur, &mut sep, Sep::Amp);
            i += 1;
            continue;
        }
        cur.push(c);
        i += 1;
    }
    push(&mut out, &mut cur, &mut sep, Sep::None);
    out
}

/// 依 `&&` `||` `;` `|` `&` 切段（引號內不切）。前端 `splitSegments` 的對應版，只在共用案例裡比對切法。
#[cfg(test)]
pub fn split_segments(line: &str) -> Vec<String> {
    split_detailed(line).into_iter().map(|s| s.text).collect()
}

/// 抓出 `$( … )` 與反引號裡的子指令（單引號內的是字面值，不算）。
pub(crate) fn extract_substitutions(line: &str) -> Vec<String> {
    let cs: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut q: Option<char> = None;
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '\\' {
            i += 2;
            continue;
        }
        if q == Some('\'') {
            if c == '\'' {
                q = None;
            }
            i += 1;
            continue;
        }
        if c == '\'' && q.is_none() {
            q = Some('\'');
            i += 1;
            continue;
        }
        if c == '"' {
            q = if q == Some('"') { None } else { Some('"') };
            i += 1;
            continue;
        }
        if c == '$' && cs.get(i + 1) == Some(&'(') {
            let mut depth = 1;
            let mut j = i + 2;
            while j < cs.len() && depth > 0 {
                if cs[j] == '\\' {
                    j += 1;
                } else if cs[j] == '(' {
                    depth += 1;
                } else if cs[j] == ')' {
                    depth -= 1;
                }
                j += 1;
            }
            let end = if depth == 0 { j - 1 } else { cs.len() };
            out.push(cs[i + 2..end.max(i + 2)].iter().collect());
            i = j;
            continue;
        }
        if c == '`' {
            match cs[i + 1..].iter().position(|&x| x == '`') {
                Some(p) => {
                    out.push(cs[i + 1..i + 1 + p].iter().collect());
                    i = i + 2 + p;
                    continue;
                }
                None => {
                    out.push(cs[i + 1..].iter().collect());
                    break;
                }
            }
        }
        i += 1;
    }
    out
}

// ---- 前綴包裝：sudo / env / nohup … ----

static ASSIGN_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());
pub(crate) const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish", "ash"];
/// 只是語法骨架、後面才是真正的指令。
const KEYWORDS: &[&str] = &["do", "then", "else", "elif", "if", "while", "until", "!", "{", "(", "time"];

/// 各包裝指令「後面要吃一個參數」的選項；其餘 `-x` 一律當無參數旗標跳過。
pub(crate) fn arg_opts(w: &str) -> &'static [&'static str] {
    match w {
        "sudo" => &[
            "-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-T", "-U", "--user", "--group", "--prompt", "--chdir", "--host", "--role",
            "--type", "--other-user", "--close-from",
        ],
        "doas" => &["-u", "-C"],
        "pkexec" => &["--user"],
        "env" => &["-u", "-C", "-S", "--unset", "--chdir", "--split-string"],
        "nice" => &["-n", "--adjustment"],
        "ionice" => &["-c", "-n", "-p", "-P", "-u", "--class", "--classdata", "--pid", "--pgid", "--uid"],
        "timeout" => &["-s", "-k", "--signal", "--kill-after"],
        "stdbuf" => &["-i", "-o", "-e", "--input", "--output", "--error"],
        "xargs" => &[
            "-I", "-i", "-n", "-L", "-s", "-d", "-a", "-E", "-P", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--replace",
            "--max-lines", "--max-chars", "--eof",
        ],
        "ssh" => &["-p", "-i", "-l", "-o", "-J", "-L", "-R", "-D", "-F", "-W", "-E", "-b", "-c", "-m", "-e", "-O", "-Q", "-S", "-w", "-I", "-B"],
        "mysql" => &["-h", "-u", "-P", "-e", "-D", "-S", "--host", "--user", "--port", "--execute", "--database", "--socket", "--default-character-set"],
        "psql" => &[
            "-h", "-p", "-U", "-d", "-c", "-f", "-v", "-o", "-F", "-R", "-T", "-P", "--host", "--port", "--username", "--dbname", "--command",
            "--file", "--set", "--variable", "--output",
        ],
        "redis-cli" => &["-h", "-p", "-a", "-n", "-u", "-s", "--user", "--pass", "-r", "-i"],
        "mongosh" => &["--host", "--port", "-u", "-p", "--username", "--password", "--authenticationDatabase", "--eval", "-f", "--file"],
        "git" => &["-C", "-c", "--git-dir", "--work-tree", "--namespace"],
        _ => &[],
    }
}

/// 從 args[i] 起跳過選項（含要吃參數的），回傳第一個非選項 token 的索引；`--` 結束選項。
/// 可能回超過 `args.len()` 的值（最後一個選項缺參數），呼叫端一律當「後面沒東西」。
pub(crate) fn skip_opts(args: &[String], mut i: usize, with_arg: &[&str]) -> usize {
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            return i + 1;
        }
        if !a.starts_with('-') || a == "-" {
            return i;
        }
        // `--user=x` 已含參數；`-u x` / `--user x` 要多跳一個。
        if !a.contains('=') && with_arg.contains(&a) {
            i += 2;
        } else {
            i += 1;
        }
    }
    i
}

/// `/usr/bin/rm` → `rm`、`\rm`（略過 alias）→ `rm`。
pub(crate) fn base_word(v: &str) -> &str {
    let s = v.strip_prefix('\\').unwrap_or(v);
    match s.rfind('/') {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

pub(crate) struct Stripped {
    /// 剝掉包裝後剩下的指令文字。sub 為 true 時是 `-c` 字串的內容（已去引號），要當一整行重新解析。
    pub text: String,
    pub root: bool,
    pub sub: bool,
    /// 由 xargs / find -exec 餵參數：rm 就算沒帶 -r 也是批次刪除。
    pub batch: bool,
    pub interactive: bool,
}

/// `text` 從第 `idx` 個參數（不含指令本身）起原樣切下去；沒有就是空字串。
fn rest_from(text: &str, toks: &[Tok], idx: usize) -> String {
    match toks.get(1 + idx) {
        Some(t) => text[t.start..].to_string(),
        None => String::new(),
    }
}

/// 剝掉 sudo / doas / su -c / env VAR= / nohup / time / nice / command / exec / setsid / xargs
/// 這些「真正的指令在後面」的前綴。sudo 記下 root；su -c / sh -c 記下 sub（字串裡可能又是一整行）。
pub(crate) fn strip_wrappers(seg: &str) -> Stripped {
    let text = seg
        .trim_start_matches(|c: char| c.is_whitespace() || c == '(' || c == '{')
        .trim_end_matches(|c: char| c.is_whitespace() || c == ')' || c == '}');
    let mut out = Stripped { text: text.to_string(), root: false, sub: false, batch: false, interactive: false };
    for _ in 0..12 {
        let toks = tokenize(&out.text);
        let mut i = 0;
        while i < toks.len() && ASSIGN_RE.is_match(&toks[i].v) {
            i += 1;
        }
        if i >= toks.len() {
            out.text.clear();
            return out;
        }
        // 前置的 `VAR=x` 指派剝掉再來一輪，讓下面每個分支都從 toks[0] 看起。
        if i > 0 {
            out.text = out.text[toks[i].start..].to_string();
            continue;
        }
        let w = base_word(&toks[0].v).to_string();
        let args: Vec<String> = toks[1..].iter().map(|t| t.v.clone()).collect();

        if KEYWORDS.contains(&w.as_str()) || matches!(w.as_str(), "nohup" | "exec" | "builtin" | "setsid" | "busybox") {
            let j = if w == "time" || w == "setsid" { skip_opts(&args, 0, &[]) } else { 0 };
            out.text = rest_from(&out.text, &toks, j);
            continue;
        }
        if matches!(w.as_str(), "sudo" | "doas" | "pkexec") {
            out.root = true;
            let j = skip_opts(&args, 0, arg_opts(&w));
            // `sudo -i` / `sudo -s` 沒有後續指令：開一個 root shell 等人打字。
            if j >= args.len() {
                out.interactive = out.interactive || args.iter().any(|a| cluster(a).contains(['i', 's']));
            }
            out.text = rest_from(&out.text, &toks, j);
            continue;
        }
        if w == "su" {
            out.root = true;
            match args.iter().position(|a| a == "-c" || a == "--command" || a.starts_with("--command=")) {
                Some(c) => {
                    out.text = match args[c].strip_prefix("--command=") {
                        Some(v) => v.to_string(),
                        None => args.get(c + 1).cloned().unwrap_or_default(),
                    };
                    out.sub = true;
                }
                None => {
                    out.text.clear();
                    out.interactive = true;
                }
            }
            return out;
        }
        if SHELLS.contains(&w.as_str()) {
            if let Some(c) = args.iter().position(|a| full_cluster_ends(a, &['c'])) {
                if c + 1 < args.len() {
                    out.text = args[c + 1].clone();
                    out.sub = true;
                    return out;
                }
            }
            // `bash` 沒帶腳本 / 字串 → 互動 shell；`bash x.sh` 是跑腳本（內容看不到，不分級）。
            if skip_opts(&args, 0, &[]) >= args.len() {
                out.interactive = true;
            }
            return out;
        }
        if matches!(w.as_str(), "env" | "nice" | "ionice" | "stdbuf" | "timeout") {
            let mut j = skip_opts(&args, 0, arg_opts(&w));
            if w == "env" {
                while j < args.len() && ASSIGN_RE.is_match(&args[j]) {
                    j += 1;
                }
            }
            if w == "timeout" {
                j += 1; // 時間長度
            }
            out.text = rest_from(&out.text, &toks, j);
            continue;
        }
        if w == "command" {
            // `command -v rm` 只是查路徑，不是執行。
            if args.iter().any(|a| cluster(a).contains(['v', 'V'])) {
                out.text.clear();
                return out;
            }
            out.text = rest_from(&out.text, &toks, skip_opts(&args, 0, &[]));
            continue;
        }
        if w == "xargs" {
            out.batch = true;
            out.text = rest_from(&out.text, &toks, skip_opts(&args, 0, arg_opts("xargs")));
            continue;
        }
        return out;
    }
    out
}

/// 剝掉 sudo / env VAR= / nohup … 之後的第一個字（去路徑）；`su -c "…"` 取字串裡的第一個字。
/// 前端 `commandWord` 的對應版，只在共用案例裡比對剝包裝的結果。
#[cfg(test)]
pub fn command_word(seg: &str) -> String {
    let s = strip_wrappers(seg);
    if s.sub {
        return split_detailed(&s.text).first().map(|f| command_word(&f.text)).unwrap_or_default();
    }
    tokenize(&s.text).first().map(|t| base_word(&t.v).to_string()).unwrap_or_default()
}

// ---- 選項的小工具（取代 TS 版的 /^-[A-Za-z]*x/ 一類正規表示式）----

/// `-abc…` 開頭那串字母（`/^-[A-Za-z]*/` 匹配到的字母部分）；不是 `-` 開頭回空字串。
pub(crate) fn cluster(a: &str) -> &str {
    match a.strip_prefix('-') {
        Some(rest) => {
            let end = rest.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(rest.len());
            &rest[..end]
        }
        None => "",
    }
}

/// 整個參數是 `-字母…X`（`/^-[A-Za-z]*X$/`），X 在 `last` 之中。
pub(crate) fn full_cluster_ends(a: &str, last: &[char]) -> bool {
    match a.strip_prefix('-') {
        Some(rest) => !rest.is_empty() && rest.chars().all(|c| c.is_ascii_alphabetic()) && rest.ends_with(last),
        None => false,
    }
}

pub(crate) struct SplitArgs<'a> {
    pub flags: Vec<&'a str>,
    pub ops: Vec<&'a str>,
}

/// 旗標與運算元分家；`--` 之後全是運算元。單獨的 `-`（stdin）算運算元。
pub(crate) fn split_args(args: &[String]) -> SplitArgs<'_> {
    let mut flags = Vec::new();
    let mut ops = Vec::new();
    let mut done = false;
    for a in args {
        let a = a.as_str();
        if done {
            ops.push(a);
        } else if a == "--" {
            done = true;
        } else if a.starts_with('-') && a != "-" {
            flags.push(a);
        } else {
            ops.push(a);
        }
    }
    SplitArgs { flags, ops }
}

/// 短選項群裡有沒有這個字母（`-rf` 含 r 與 f；`--x` 不算）。
pub(crate) fn has_short(flags: &[&str], letter: char) -> bool {
    flags.iter().any(|f| !f.starts_with("--") && f[1..].contains(letter))
}

// ---- 規則 ----

static DEVICE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^/dev/(sd[a-z]+[0-9]*|nvme[0-9]+n[0-9]+(p[0-9]+)?|vd[a-z]+[0-9]*|xvd[a-z]+[0-9]*|hd[a-z]+[0-9]*|mmcblk[0-9]+(p[0-9]+)?|disk[0-9]+(s[0-9]+)?|mapper/\S+)$").unwrap()
});
/// rm -r 的目標是整個系統或家目錄。
static ROOTISH_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^(/+|/\*|~|~/|~/\*|\$HOME/?|\$\{HOME\}/?|\$HOME/\*|\$\{HOME\}/\*|\.|\.\.|\./|\.\./|/\.|/\.\.)$").unwrap()
});
/// rm -r 的目標是頂層系統目錄本身（不含底下的子路徑）。
static SYS_TOP_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^/(etc|bin|sbin|usr|lib|lib64|boot|var|dev|proc|sys|root|home|opt)/?(\*)?$").unwrap());
/// 寫入這些目錄要先問：改到的是系統設定 / 二進位，不是使用者自己的檔案。
static SYS_DIR_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(/etc|/boot|/bin|/sbin|/usr|/lib|/lib64|/var/lib|/proc/sys|/sys)(/|$)").unwrap());
/// 只帶變數名的目標：變數沒設定時 `rm -rf "$DIR/"` 就是 `rm -rf /`。
static BARE_VAR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/?$").unwrap());
/// fork bomb 的四個名字（`f(){ f|f& };f`）：TS 版用 backreference，這裡抓出來再比相等。
static FORK_BOMB_RE: Lazy<Regex> = Lazy::new(|| {
    let name = r"([A-Za-z_:][A-Za-z0-9_:]*)";
    Regex::new(&format!(r"^{name}\s*\(\)\s*\{{\s*{name}\s*\|\s*{name}\s*&\s*;?\s*\}}\s*;?\s*{name}")).unwrap()
});
static FORK_LOOP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\bfork\s+while\s+fork\b").unwrap());
/// `bash <(curl …)` / `sh -c "$(wget …)"` / `source <(curl …)`：下載回來的東西直接當程式跑。
static NET_EXEC_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\s*(?:(?:sudo|doas|env|nohup|exec)\s+(?:-\S+\s+)*)?(?:\S*/)?(?:(?:sh|bash|zsh|dash|ksh|fish|source|eval)\b|\.\s).*?(?:<\(|\$\(|`)\s*(?:curl|wget)\b").unwrap()
});
static DB_DESTRUCTIVE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b(drop|truncate|delete\s+from|flushall|flushdb|dropDatabase|deleteMany|drop_database)\b").unwrap());
static HISTFILE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(^|\s)(export\s+)?HISTFILE=|\bset\s+\+o\s+history\b").unwrap());
static DEV_TCP_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"/dev/(tcp|udp)/").unwrap());
static WORLD_WRITABLE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(?:[ugo]*[oa][ugo]*|)[+=][rwxXst]*w").unwrap());
static REMOUNT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bremount\b").unwrap());
static CONTINUATION_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\\\r?\n").unwrap());

const PKG_MANAGERS: &[&str] = &[
    "apt", "apt-get", "aptitude", "yum", "dnf", "zypper", "apk", "brew", "snap", "pip", "pip3", "pipx", "npm", "pnpm", "yarn", "gem", "cargo",
    "flatpak", "choco", "winget",
];
const PKG_REMOVE: &[&str] = &["remove", "purge", "autoremove", "erase", "uninstall", "del", "rm", "un", "unlink", "r"];
pub(crate) const DB_CLIS: &[&str] = &["mysql", "mariadb", "psql", "sqlite3", "mongosh", "mongo", "redis-cli", "clickhouse-client", "cqlsh"];
const CONTAINER_CLIS: &[&str] = &["docker", "podman", "nerdctl", "docker-compose"];
const ALWAYS_INTERACTIVE: &[&str] = &[
    "vim", "vi", "nvim", "vimdiff", "nano", "pico", "emacs", "micro", "top", "htop", "btop", "atop", "iotop", "iftop", "nload", "glances", "less",
    "more", "most", "man", "watch", "tmux", "screen", "telnet", "ftp", "lftp", "sftp", "irb", "mc", "ranger", "read", "visudo", "vipw", "cfdisk",
    "mysql_secure_installation", "dpkg-reconfigure", "raspi-config", "nmtui", "alsamixer",
];

/// 輸出重導向（`>` `>>` `&>` `&>>` `>|`）與它的目標；`2>&1` 這類 fd 複製不算。
/// TS 版：`/(?<![<>&])(\d*)(>{1,2}|&>>?|>\|)(?![>&])\s*["']?([^\s"'&|;<>]+)/g`，這裡手寫掃描。
pub(crate) fn redirects(raw: &str) -> Vec<(&'static str, String)> {
    const OPS: [&str; 5] = [">>", ">", "&>>", "&>", ">|"];
    let b = raw.as_bytes();
    let n = b.len();
    let is_target = |c: u8| !(c.is_ascii_whitespace() || matches!(c, b'"' | b'\'' | b'&' | b'|' | b';' | b'<' | b'>'));
    let mut out = Vec::new();
    let mut i = 0;
    'scan: while i < n {
        if i > 0 && matches!(b[i - 1], b'<' | b'>' | b'&') {
            i += 1;
            continue;
        }
        let mut j = i;
        while j < n && b[j].is_ascii_digit() {
            j += 1;
        }
        for op in OPS {
            // 比對位元組：i / j 可能落在多位元組字元中間（`echo 你好 > x`），不能切 &str。
            if !b[j..].starts_with(op.as_bytes()) {
                continue;
            }
            let mut k = j + op.len();
            if k < n && matches!(b[k], b'>' | b'&') {
                continue;
            }
            while k < n && (b[k] == b' ' || b[k] == b'\t') {
                k += 1;
            }
            if k < n && (b[k] == b'"' || b[k] == b'\'') {
                k += 1;
            }
            let t0 = k;
            while k < n && is_target(b[k]) {
                k += 1;
            }
            if k > t0 {
                out.push((op, raw[t0..k].to_string()));
                i = k;
                continue 'scan;
            }
        }
        i += 1;
    }
    out
}

/// chmod 的 mode 會不會讓所有人可寫：`777` / `666` / `o+w` / `a+w` / `+w`。
fn world_writable(mode: &str) -> bool {
    if (3..=4).contains(&mode.len()) && mode.chars().all(|c| ('0'..='7').contains(&c)) {
        return mode.chars().last().and_then(|c| c.to_digit(8)).is_some_and(|d| d & 2 != 0);
    }
    mode.split(',').any(|clause| WORLD_WRITABLE_RE.is_match(clause))
}

fn is_fork_bomb(line: &str) -> bool {
    if FORK_LOOP_RE.is_match(line) {
        return true;
    }
    if !line.contains("()") {
        return false;
    }
    // 名字可以從任何位置開始（`xbomb(){ bomb|bomb& };bomb` 裡的 bomb），逐一試起點。
    line.char_indices().any(|(i, c)| {
        (c.is_ascii_alphabetic() || c == '_' || c == ':')
            && FORK_BOMB_RE.captures(&line[i..]).is_some_and(|m| m[1] == m[2] && m[2] == m[3] && m[3] == m[4])
    })
}

/// pipe 的下游是不是「把 stdin 當程式跑」的東西（`| sh`、`| python3 -`；`| python -m json.tool` 不是）。
fn is_exec_sink(word: &str, args: &[String]) -> bool {
    let sp = split_args(args);
    let all_stdin = sp.ops.iter().all(|o| *o == "-");
    let fl = |set: &[char]| sp.flags.iter().any(|f| cluster(f).contains(set));
    if SHELLS.contains(&word) {
        return !sp.flags.iter().any(|f| full_cluster_ends(f, &['c']));
    }
    let py = word.strip_prefix("python").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'));
    if py {
        return !fl(&['c', 'm']) && all_stdin;
    }
    match word {
        "perl" => !fl(&['e', 'E', 'n', 'p']) && all_stdin,
        "ruby" => !fl(&['e']) && all_stdin,
        "node" | "nodejs" => {
            !(fl(&['e', 'p']) || sp.flags.iter().any(|f| f.starts_with("--eval") || f.starts_with("--print"))) && all_stdin
        }
        "php" => !fl(&['r']) && all_stdin,
        _ => false,
    }
}

fn is_decoder(word: &str, args: &[String]) -> bool {
    let has = |s: &str| args.iter().any(|a| a == s);
    match word {
        "base64" | "base32" => args.iter().any(|a| a == "-d" || a == "-D" || a == "--decode" || cluster(a).contains('d')),
        "openssl" => has("-d") || has("-base64") || has("base64"),
        "xxd" => has("-r") || has("-p"),
        "uudecode" => true,
        _ => false,
    }
}

/// 有沒有把檔案寫到指定位置：`cp x /etc/…`、`curl -o /usr/local/bin/x`。
pub(crate) fn write_targets(word: &str, args: &[String]) -> Vec<String> {
    let sp = split_args(args);
    match word {
        "tee" | "ln" | "install" => sp.ops.iter().map(|s| s.to_string()).collect(),
        "sed" => {
            if has_short(&sp.flags, 'i') || sp.flags.iter().any(|f| f.starts_with("--in-place")) {
                sp.ops.iter().map(|s| s.to_string()).collect()
            } else {
                Vec::new()
            }
        }
        "mv" | "cp" | "rsync" => {
            if sp.ops.len() >= 2 {
                vec![sp.ops[sp.ops.len() - 1].to_string()]
            } else {
                Vec::new()
            }
        }
        "curl" | "wget" => {
            // curl 是 `-o 檔名`（`-O` 是「用遠端檔名」、不吃參數）；wget 相反，是 `-O 檔名`。
            let letter = if word == "curl" { 'o' } else { 'O' };
            let attached = format!("-{letter}/");
            let mut out = Vec::new();
            for (i, a) in args.iter().enumerate() {
                if a == "--output" || a == "--output-document" || full_cluster_ends(a, &[letter]) {
                    if let Some(n) = args.get(i + 1) {
                        out.push(n.clone());
                    }
                } else if a.starts_with("--output=") || a.starts_with("--output-document=") {
                    out.push(a[a.find('=').unwrap_or(0) + 1..].to_string());
                } else if a.starts_with(&attached) && a.len() > attached.len() {
                    out.push(a[2..].to_string());
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

/// 互動判斷：會停下來等人打字的程式。level 不變，只是提示。
fn is_interactive(word: &str, args: &[String], raw: &str) -> bool {
    let sp = split_args(args);
    let (flags, ops) = (&sp.flags, &sp.ops);
    let flag = |s: &str| flags.contains(&s);
    let op0 = ops.first().copied().unwrap_or("");
    if ALWAYS_INTERACTIVE.contains(&word) {
        return !(word == "top" && has_short(flags, 'b'));
    }
    // `mysql < dump.sql` 是餵檔案，不是等人；`<(` 是 process substitution。
    let has_stdin = raw.match_indices('<').any(|(i, _)| !raw[i + 1..].starts_with('('));
    let after = |j: usize| args.get(j..).unwrap_or(&[]);
    match word {
        "ssh" => after(skip_opts(args, 0, arg_opts("ssh"))).iter().filter(|a| !a.starts_with('-')).count() < 2,
        "mysql" | "mariadb" => !has_stdin && !flags.iter().any(|f| full_cluster_ends(f, &['e']) || f.starts_with("--execute")),
        "psql" => {
            !has_stdin
                && !flags.iter().any(|f| {
                    full_cluster_ends(f, &['c', 'f', 'l']) || f.starts_with("--command") || f.starts_with("--file") || f.starts_with("--list")
                })
        }
        "sqlite3" => !has_stdin && ops.len() < 2,
        "mongosh" | "mongo" => {
            !has_stdin
                && !flags.iter().any(|f| f.starts_with("--eval") || *f == "-f" || f.starts_with("--file"))
                && !ops.iter().any(|o| o.ends_with(".js"))
        }
        "redis-cli" => after(skip_opts(args, 0, arg_opts("redis-cli"))).is_empty(),
        "python" | "python2" | "python3" => (ops.is_empty() && !flags.iter().any(|f| cluster(f).contains(['c', 'm']))) || has_short(flags, 'i'),
        "node" | "nodejs" => {
            ops.is_empty()
                && !flags.iter().any(|f| cluster(f).contains(['e', 'p']) || f.starts_with("--eval") || f.starts_with("--print"))
                && !has_stdin
        }
        "php" => has_short(flags, 'a'),
        "tail" => has_short(flags, 'f') || has_short(flags, 'F') || flags.iter().any(|f| f.starts_with("--follow")),
        "journalctl" | "dmesg" => has_short(flags, 'f') || has_short(flags, 'w') || flags.iter().any(|f| f.starts_with("--follow")),
        "ping" => !flags.iter().any(|f| cluster(f).contains(['c', 'w', 'W'])),
        "crontab" => has_short(flags, 'e'),
        "passwd" => true,
        "rm" | "cp" | "mv" | "ln" => has_short(flags, 'i'),
        "docker" | "podman" | "nerdctl" => {
            matches!(op0, "exec" | "run" | "attach")
                && (flags.iter().any(|f| cluster(f).contains('i') && cluster(f).contains('t'))
                    || (flag("-i") && flag("-t"))
                    || flag("--interactive"))
        }
        "kubectl" => {
            (matches!(op0, "exec" | "attach") && (flags.iter().any(|f| cluster(f).contains('i') && cluster(f).contains('t')) || flag("-i")))
                || (op0 == "logs" && (has_short(flags, 'f') || flag("--follow")))
        }
        "git" => match op0 {
            "rebase" | "add" => has_short(flags, 'i') || has_short(flags, 'p') || flag("--interactive") || flag("--patch"),
            // 沒給訊息的 commit 會開編輯器。
            "commit" => {
                !has_short(flags, 'm')
                    && !has_short(flags, 'F')
                    && !flags.iter().any(|f| {
                        f.starts_with("--message") || f.starts_with("--file") || *f == "--no-edit" || f.starts_with("--reuse-message")
                    })
            }
            _ => false,
        },
        "apt" | "apt-get" | "yum" | "dnf" => {
            ["install", "remove", "purge", "upgrade", "dist-upgrade", "full-upgrade", "autoremove", "reinstall"].contains(&op0)
                && !has_short(flags, 'y')
                && !flag("--yes")
                && !flag("--assume-yes")
                && !flag("--assumeyes")
        }
        "pacman" => flags.iter().any(|f| cluster(f).contains(['S', 'R', 'U'])) && !flag("--noconfirm"),
        "zypper" => {
            ["install", "in", "remove", "rm", "update", "up", "dist-upgrade", "dup", "patch"].contains(&op0)
                && !has_short(flags, 'n')
                && !flag("--non-interactive")
        }
        _ => false,
    }
}

/// `of=…` 的目標（去掉一層引號）。
fn dd_target(a: &str) -> Option<&str> {
    let v = a.strip_prefix("of=")?;
    let v = v.strip_prefix(['"', '\'']).filter(|s| !s.is_empty()).unwrap_or(v);
    let v = v.strip_suffix(['"', '\'']).filter(|s| !s.is_empty()).unwrap_or(v);
    (!v.is_empty()).then_some(v)
}

/// 一段（沒有 && ; | 的最小單位）的分級。batch：由 xargs / find -exec 餵參數。
fn classify_segment(seg: &str, depth: usize, batch: bool) -> ShellVerdict {
    use ShellLevel::{Block, Confirm};
    let mut v = ShellVerdict::empty();
    // 這三條看的是剝包裝**之前**的原文：`HISTFILE=/dev/null bash` 的指派會被當環境變數剝掉，
    // `bash -c "$(curl …)"` 的 -c 字串則要連著前面的 bash 一起看才成立。
    if NET_EXEC_RE.is_match(seg) {
        v.bump(Confirm, r::NET_EXEC);
    }
    if HISTFILE_RE.is_match(seg) {
        v.bump(Confirm, r::HISTORY);
    }
    if DEV_TCP_RE.is_match(seg) {
        v.bump(Confirm, r::REVERSE_SHELL);
    }
    let s = strip_wrappers(seg);
    if s.root {
        v.bump(Confirm, r::ROOT);
    }
    if s.interactive {
        v.interactive = true;
    }
    if s.sub {
        v.merge(classify_line(&s.text, depth + 1));
        return v;
    }
    let raw = s.text.as_str();
    let toks = tokenize(raw);
    let Some(first) = toks.first() else {
        return v;
    };
    let word = base_word(&first.v).to_string();
    let word = word.as_str();
    let args: Vec<String> = toks[1..].iter().map(|t| t.v.clone()).collect();
    let sp = split_args(&args);
    let (flags, ops) = (&sp.flags, &sp.ops);
    let flag = |s: &str| flags.contains(&s);
    let op = |s: &str| ops.contains(&s);
    let arg = |s: &str| args.iter().any(|a| a == s);
    let batch = batch || s.batch;

    if is_interactive(word, &args, raw) {
        v.interactive = true;
    }

    // 重導向：寫進磁碟裝置是 block，覆寫系統目錄要問。`>>`（附加）刻意不算——
    // `echo … >> ~/.bashrc` 這種常見寫法一律要問的話，確認框很快就會被無腦按掉。
    for (op, target) in redirects(raw) {
        if DEVICE_RE.is_match(&target) {
            v.bump(Block, r::DEVICE_WRITE);
        } else if op != ">>" && op != "&>>" && SYS_DIR_RE.is_match(&target) {
            v.bump(Confirm, r::SYS_DIR);
        }
    }
    for target in write_targets(word, &args) {
        if DEVICE_RE.is_match(&target) {
            v.bump(Block, r::DEVICE_WRITE);
        } else if SYS_DIR_RE.is_match(&target) {
            v.bump(Confirm, r::SYS_DIR);
        }
    }

    match word {
        "rm" | "unlink" => {
            let recursive = word == "rm" && (has_short(flags, 'r') || has_short(flags, 'R') || flag("--recursive"));
            let force = has_short(flags, 'f') || flag("--force");
            if recursive && (flag("--no-preserve-root") || ops.iter().any(|o| ROOTISH_RE.is_match(o))) {
                v.bump(Block, r::RM_ROOT);
            } else if recursive && ops.iter().any(|o| SYS_TOP_RE.is_match(o)) {
                v.bump(Block, r::RM_SYS);
            } else if recursive || batch {
                v.bump(Confirm, r::RM_RECURSIVE);
                if recursive && ops.iter().any(|o| BARE_VAR_RE.is_match(o)) {
                    v.bump(Confirm, r::RM_VAR);
                }
            } else if force || ops.iter().any(|o| o.contains(['*', '?', '[', '$'])) {
                v.bump(Confirm, r::RM_FORCE);
            } else {
                v.bump(Confirm, r::RM_FILE);
            }
        }
        "find" => {
            if arg("-delete") {
                v.bump(Confirm, r::RM_RECURSIVE);
            }
            for (i, a) in args.iter().enumerate() {
                if !["-exec", "-execdir", "-ok", "-okdir"].contains(&a.as_str()) {
                    continue;
                }
                let end = args.iter().enumerate().skip(i + 1).find(|(_, x)| *x == ";" || *x == "+").map_or(args.len(), |(j, _)| j);
                let sub = args[i + 1..end].join(" ");
                if !sub.is_empty() {
                    v.merge(classify_segment(&sub, depth + 1, true));
                }
            }
        }
        "rsync" => {
            if flags.iter().any(|f| f.starts_with("--delete") || *f == "--remove-source-files") {
                v.bump(Confirm, r::RM_RECURSIVE);
            }
        }
        "dd" => {
            v.bump(Confirm, r::DD);
            if args.iter().filter_map(|a| dd_target(a)).any(|t| DEVICE_RE.is_match(t)) {
                v.bump(Block, r::DEVICE_WRITE);
            }
        }
        "wipefs" | "shred" | "mke2fs" | "mkswap" => {
            if ops.iter().any(|o| o.starts_with("/dev/")) {
                v.bump(Block, r::FORMAT_DEVICE);
            } else {
                v.bump(Confirm, r::FORMAT);
            }
        }
        // `fdisk -l` / `parted -l` 只是列出分割表。
        "fdisk" | "sfdisk" | "parted" | "gdisk" | "cfdisk" => {
            if !has_short(flags, 'l') && !flag("--list") {
                v.bump(Confirm, r::FORMAT);
            }
        }
        "truncate" => v.bump(Confirm, r::TRUNCATE),
        "chmod" | "chown" | "chgrp" => {
            let recursive = has_short(flags, 'R') || flag("--recursive");
            if recursive && ops.iter().any(|o| !o.is_empty() && o.chars().all(|c| c == '/')) {
                v.bump(Block, r::CHMOD_ROOT);
            } else if recursive {
                v.bump(Confirm, r::CHMOD_RECURSIVE);
            }
            if word == "chmod" && ops.first().is_some_and(|m| world_writable(m)) {
                v.bump(Confirm, r::WORLD_WRITABLE);
            }
        }
        "shutdown" | "reboot" | "halt" | "poweroff" | "telinit" => v.bump(Confirm, r::POWER),
        "init" => {
            if op("0") || op("6") {
                v.bump(Confirm, r::POWER);
            }
        }
        "systemctl" => {
            if ops.iter().any(|o| ["reboot", "poweroff", "halt", "kexec"].contains(o)) {
                v.bump(Confirm, r::POWER);
            }
            if ops.iter().any(|o| ["stop", "disable", "mask", "restart", "kill"].contains(o)) {
                v.bump(Confirm, r::SERVICE);
            }
        }
        "service" | "rc-service" => {
            if ops.iter().any(|o| ["stop", "restart", "force-reload"].contains(o)) {
                v.bump(Confirm, r::SERVICE);
            }
        }
        // `kill -9 -1`：訊號後面的 -1 是「所有程序」；`kill -1 123` 的 -1 則是 SIGHUP。
        "kill" => {
            if args.iter().skip(1).any(|a| a == "-1") || op("1") {
                v.bump(Confirm, r::KILL_ALL);
            }
        }
        "killall" | "killall5" | "pkill" => v.bump(Confirm, r::KILL_NAME),
        "iptables" | "ip6tables" => {
            let flush = args.iter().any(|a| ["-F", "--flush", "-X", "--delete-chain"].contains(&a.as_str()) || full_cluster_ends(a, &['F', 'X']));
            let policy = (arg("-P") || arg("--policy")) && (arg("DROP") || arg("REJECT"));
            if flush || policy {
                v.bump(Confirm, r::FIREWALL);
            }
        }
        "nft" => {
            if op("flush") {
                v.bump(Confirm, r::FIREWALL);
            }
        }
        "ufw" => {
            if op("disable") || op("reset") {
                v.bump(Confirm, r::FIREWALL);
            }
        }
        "firewall-cmd" => {
            if flag("--panic-on") {
                v.bump(Confirm, r::FIREWALL);
            }
        }
        "crontab" => {
            if has_short(flags, 'r') {
                v.bump(Confirm, r::CRON);
            }
        }
        "history" => {
            if has_short(flags, 'c') {
                v.bump(Confirm, r::HISTORY);
            }
        }
        "unset" => {
            if op("HISTFILE") {
                v.bump(Confirm, r::HISTORY);
            }
        }
        "pacman" => {
            if flags.iter().any(|f| f.starts_with("-R")) {
                v.bump(Confirm, r::PKG_REMOVE);
            }
        }
        "dpkg" => {
            if has_short(flags, 'r') || has_short(flags, 'P') || flag("--remove") || flag("--purge") {
                v.bump(Confirm, r::PKG_REMOVE);
            }
        }
        "rpm" => {
            if has_short(flags, 'e') || flag("--erase") {
                v.bump(Confirm, r::PKG_REMOVE);
            }
        }
        "kubectl" => {
            if op("delete") || op("drain") {
                v.bump(Confirm, r::CLOUD_DELETE);
            }
        }
        "helm" => {
            if op("uninstall") || op("delete") {
                v.bump(Confirm, r::CLOUD_DELETE);
            }
        }
        "terraform" | "tofu" => {
            if op("destroy") {
                v.bump(Confirm, r::CLOUD_DELETE);
            }
        }
        "git" => {
            let j = skip_opts(&args, 0, arg_opts("git"));
            let sub = args.get(j).map(String::as_str).unwrap_or("");
            let rest = args.get(j + 1..).unwrap_or(&[]);
            let rsp = split_args(rest);
            let (rf, rops) = (&rsp.flags, &rsp.ops);
            let rflag = |s: &str| rf.contains(&s);
            let rewrite = (sub == "push"
                && (rf.iter().any(|f| f.starts_with("--force") || *f == "--mirror" || *f == "--delete" || cluster(f).contains(['f', 'd']))
                    || rops.iter().any(|o| o.starts_with(':'))))
                || (sub == "reset" && rflag("--hard"))
                || (sub == "clean"
                    && !has_short(rf, 'n')
                    && !rflag("--dry-run")
                    && rf.iter().any(|f| cluster(f).contains(['f', 'd', 'x']) || *f == "--force"))
                || (sub == "checkout" && (rest.iter().any(|a| a == "--") || rops.iter().any(|o| *o == "." || o.ends_with("/."))))
                || (sub == "restore" && !rflag("--staged") && !rops.is_empty())
                || (sub == "branch" && (rflag("-D") || (rflag("--delete") && rflag("--force")) || rf.iter().any(|f| cluster(f).contains('D'))))
                || (sub == "stash" && (rops.contains(&"drop") || rops.contains(&"clear")))
                || sub == "filter-branch"
                || sub == "filter-repo";
            if rewrite {
                v.bump(Confirm, r::GIT_REWRITE);
            }
        }
        "dropdb" => v.bump(Confirm, r::DB_DESTRUCTIVE),
        "mysqladmin" => {
            if op("drop") || op("shutdown") {
                v.bump(Confirm, r::DB_DESTRUCTIVE);
            }
        }
        "userdel" | "deluser" | "groupdel" | "delgroup" | "chpasswd" | "passwd" => v.bump(Confirm, r::USER),
        "usermod" => {
            if has_short(flags, 'L') || flag("--lock") || has_short(flags, 'e') || flag("--expiredate") {
                v.bump(Confirm, r::USER);
            }
        }
        "umount" => v.bump(Confirm, r::MOUNT),
        "mount" => {
            if args.iter().any(|a| REMOUNT_RE.is_match(a)) {
                v.bump(Confirm, r::MOUNT);
            }
        }
        "eval" => v.bump(Confirm, r::EVAL),
        "nc" | "ncat" | "netcat" => {
            if flags.iter().any(|f| cluster(f).contains(['e', 'c']) || *f == "--exec" || *f == "--sh-exec") {
                v.bump(Confirm, r::REVERSE_SHELL);
            }
        }
        "socat" => {
            if args.iter().any(|a| a.to_ascii_lowercase().starts_with("exec:")) {
                v.bump(Confirm, r::REVERSE_SHELL);
            }
        }
        _ => {
            if word == "mkfs" || word.starts_with("mkfs.") {
                if ops.iter().any(|o| o.starts_with("/dev/")) {
                    v.bump(Block, r::FORMAT_DEVICE);
                } else {
                    v.bump(Confirm, r::FORMAT);
                }
            } else if PKG_MANAGERS.contains(&word) {
                if ops.iter().any(|o| PKG_REMOVE.contains(o)) {
                    v.bump(Confirm, r::PKG_REMOVE);
                }
            } else if CONTAINER_CLIS.contains(&word) {
                // `docker rm` 不帶 -f 也問：停掉的容器一樣有人要它的 log 與 volume。
                let o0 = ops.first().copied().unwrap_or("");
                let o1 = ops.get(1).copied().unwrap_or("");
                let down = if o0 == "compose" { o1 } else if word == "docker-compose" { o0 } else { "" };
                let dangerous = op("prune")
                    || o0 == "rm"
                    || o0 == "rmi"
                    || (["volume", "network", "container", "image"].contains(&o0) && (o1 == "rm" || o1 == "remove"))
                    || (down == "down" && (has_short(flags, 'v') || flag("--volumes") || flags.iter().any(|f| f.starts_with("--rmi"))));
                if dangerous {
                    v.bump(Confirm, r::CONTAINER_DELETE);
                }
            } else if DB_CLIS.contains(&word) && DB_DESTRUCTIVE_RE.is_match(raw) {
                v.bump(Confirm, r::DB_DESTRUCTIVE);
            }
        }
    }
    v
}

/// 一行（可能含 && ; | 與 $( )）的分級。
fn classify_line(line: &str, depth: usize) -> ShellVerdict {
    use ShellLevel::{Block, Confirm};
    let mut v = ShellVerdict::empty();
    // 遞迴深度上限：`bash -c "bash -c '…'"` 這種一層層包下去的，掃到第四層還沒見底就當可疑。
    if depth > 4 {
        v.bump(Confirm, r::TOO_DEEP);
        return v;
    }
    if is_fork_bomb(line) {
        v.bump(Block, r::FORK_BOMB);
    }
    // pipe 鏈：上游是 curl / wget / base64 -d、下游把 stdin 當程式跑。
    let mut download = false;
    let mut decode = false;
    for seg in split_detailed(line) {
        if seg.sep != Sep::Pipe {
            download = false;
            decode = false;
        }
        v.merge(classify_segment(&seg.text, depth, false));
        let s = strip_wrappers(&seg.text);
        if s.sub || s.text.is_empty() {
            continue;
        }
        let toks = tokenize(&s.text);
        let Some(first) = toks.first() else { continue };
        let word = base_word(&first.v);
        let args: Vec<String> = toks[1..].iter().map(|t| t.v.clone()).collect();
        if is_exec_sink(word, &args) {
            if download {
                v.bump(Confirm, r::NET_EXEC);
            }
            if decode {
                v.bump(Confirm, r::ENCODED);
            }
        }
        if word == "curl" || word == "wget" {
            download = true;
        }
        if is_decoder(word, &args) {
            decode = true;
        }
    }
    for sub in extract_substitutions(line) {
        v.merge(classify_line(&sub, depth + 1));
    }
    v
}

/// 行尾反斜線接起來後的邏輯行（去頭尾空白；空行與整行 `#` 註解跳過）。
pub(crate) fn logical_lines(script: &str) -> Vec<String> {
    CONTINUATION_RE
        .replace_all(script, " ")
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect()
}

/// 整段腳本的分級：逐行掃、最嚴重的層級勝出、reasons 依第一次出現的順序去重。
/// heredoc 的內容**也**照常分級——`cat <<EOF | sh` 裡的每一行都會被執行，寧可對一份純文字多問一次。
pub fn classify_shell(script: &str) -> ShellVerdict {
    let mut v = ShellVerdict::empty();
    for line in logical_lines(script) {
        v.merge(classify_line(&line, 0));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/shell-guard-cases.json");
        serde_json::from_slice(&std::fs::read(&p).expect("read fixture")).expect("parse fixture")
    }

    /// 共用案例：前端 `shellGuard.test.ts` 跑的是同一份檔案。這裡綠、那裡紅，就是兩個實作分岔了。
    #[test]
    fn shared_cases_classify() {
        let f = fixture();
        let cases = f["classify"].as_array().unwrap();
        assert!(cases.len() > 300, "fixture 應含完整案例");
        let mut bad = Vec::new();
        for c in cases {
            let cmd = c["cmd"].as_str().unwrap();
            let v = classify_shell(cmd);
            let want_reasons: Vec<&str> = c["reasons"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
            if v.level.as_str() != c["level"].as_str().unwrap() || v.reasons != want_reasons || v.interactive != c["interactive"].as_bool().unwrap() {
                bad.push(format!("{cmd:?}: got {} {:?} interactive={} / want {}", v.level.as_str(), v.reasons, v.interactive, c));
            }
        }
        assert!(bad.is_empty(), "{} 條與前端不一致：\n{}", bad.len(), bad.join("\n"));
    }

    #[test]
    fn shared_cases_segments_and_command_word() {
        let f = fixture();
        for c in f["segments"].as_array().unwrap() {
            let want: Vec<&str> = c["segments"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            assert_eq!(split_segments(c["line"].as_str().unwrap()), want, "{c}");
        }
        for c in f["command_word"].as_array().unwrap() {
            assert_eq!(command_word(c["seg"].as_str().unwrap()), c["word"].as_str().unwrap(), "{c}");
        }
    }

    #[test]
    fn redirect_scanner_matches_the_ts_regex() {
        assert_eq!(redirects("echo x > /etc/hosts"), vec![(">", "/etc/hosts".to_string())]);
        assert_eq!(redirects("echo x >>/tmp/a"), vec![(">>", "/tmp/a".to_string())]);
        assert_eq!(redirects("cmd 2>&1 | grep x"), vec![]);
        assert_eq!(redirects("cmd &> /dev/null"), vec![("&>", "/dev/null".to_string())]);
        assert_eq!(redirects("cmd >| out"), vec![(">|", "out".to_string())]);
        assert_eq!(redirects("cmd >>> x"), vec![]);
        assert_eq!(redirects("echo x > '/etc/a b'"), vec![(">", "/etc/a".to_string())]);
        assert_eq!(redirects("a 2> err.log > out.log"), vec![(">", "err.log".to_string()), (">", "out.log".to_string())]);
    }

    #[test]
    fn fork_bomb_name_can_start_mid_word() {
        assert!(is_fork_bomb("xbomb(){ bomb|bomb& };bomb"));
        assert!(!is_fork_bomb("a(){ a|a& };ab"));
        assert!(!is_fork_bomb("f() { echo hi; }; f"));
    }

    #[test]
    fn reason_texts_follow_the_lookup() {
        let v = classify_shell("rm -rf ./x");
        assert_eq!(v.reasons, vec![r::RM_RECURSIVE]);
        assert_eq!(v.reason_texts().len(), 1);
    }
}
