//! 匯入 SSH 主機：OpenSSH 的 `~/.ssh/config` 與 Xshell 的工作階段檔（`.xsh`）。
//!
//! 只負責「讀出候選主機」，不寫任何東西；使用者在前端勾選後，走一般的 `ssh_session_save` 存進來。
//!
//! **~/.ssh/config**：照 OpenSSH 的規則算出每個具體別名（`Host` 裡沒有萬用字元、不是 `!` 否定的那些）
//! 的有效設定——每個參數**第一個取得的值為準**（所以 `Host *` 放最後就是預設值），`IdentityFile` /
//! `CertificateFile` 可累加；`Include` 相對路徑以 `~/.ssh` 為基準、支援 `*`；`Match` 區塊略過。
//! `%d` `%u` `%h` `%r` `%%` 與 `~` 會展開。ProxyJump 記下跳板機的名稱（前端對到同名主機就接上）；
//! ProxyCommand / 連接埠轉送目前不支援，列成提醒。
//!
//! **Xshell**：`.xsh` 是 INI（新版是 UTF-16LE），`[CONNECTION]` 的 Host / Port / Protocol、
//! `[CONNECTION:AUTHENTICATION]` 的 UserName / UserKey、`[TERMINAL]` 的 Type。子資料夾對應成主機資料夾。
//! 密碼是 Xshell 自己加密的，不匯入；使用者金鑰存在 Xshell 的金鑰庫裡（專有格式），只記下名稱提醒使用者
//! 先從 Xshell 匯出成 OpenSSH 再匯入我們的金鑰庫。

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// 一台可以匯入的主機。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportCandidate {
    pub name: String,
    /// 來源裡的資料夾（Xshell 的子資料夾，以 `/` 分隔）；ssh config 沒有。
    pub folder: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 私鑰檔（已展開；OpenSSH 會依序試多把，這裡取第一把）。
    pub identity_file: Option<String>,
    pub certificate_file: Option<String>,
    /// Xshell 使用者金鑰的名稱（在 Xshell 的金鑰庫裡，不是檔案）。
    pub xshell_key: Option<String>,
    /// ProxyJump 的跳板機（別名，或 `user@host:port`）；多層時是最靠近目標的那一台。
    pub proxy_jump: Option<String>,
    pub term: Option<String>,
    /// 匯入時要提醒的事（不支援的設定等），已本地化。
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportScan {
    pub path: String,
    pub hosts: Vec<ImportCandidate>,
    /// 略過的項目數（萬用字元的 Host、非 SSH 的 Xshell 工作階段、讀不懂的檔案）。
    pub skipped: usize,
}

// ---- ~/.ssh/config ----

/// 讀檔的抽象（測試不碰真的檔案系統）。
pub trait ConfigFs {
    fn read(&self, path: &Path) -> Option<String>;
    /// `dir` 底下檔名符合 `pattern`（可含 `*` / `?`）的檔案，依檔名排序。
    fn glob(&self, dir: &Path, pattern: &str) -> Vec<PathBuf>;
}

pub struct RealFs;

impl ConfigFs for RealFs {
    fn read(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
    fn glob(&self, dir: &Path, pattern: &str) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter(|e| wildmatch(pattern, &e.file_name().to_string_lossy(), false))
            .map(|e| e.path())
            .collect();
        out.sort();
        out
    }
}

/// OpenSSH 的萬用字元比對（`*` 任意字串、`?` 單一字元）。`fold` = 不分大小寫（主機名稱比對用）。
pub fn wildmatch(pattern: &str, text: &str, fold: bool) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = if fold {
        (pattern.to_lowercase().chars().collect(), text.to_lowercase().chars().collect())
    } else {
        (pattern.chars().collect(), text.chars().collect())
    };
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut mark) = (None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            pi += 1;
            mark = ti;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// 一行設定拆成 (小寫關鍵字, 參數)。關鍵字與參數之間可以是空白或 `=`；參數可用雙引號包住。
fn split_line(line: &str) -> Option<(String, Vec<String>)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let end = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = line[..end].to_ascii_lowercase();
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim();
    let mut args = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut has = false;
    for c in rest.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                has = true;
            }
            c if c.is_whitespace() && !quoted => {
                if has {
                    args.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        args.push(cur);
    }
    Some((key, args))
}

/// 一個區塊：`Host` 的樣式（`None` = `Match` 區塊，整塊略過）與它底下的設定（依出現順序）。
#[derive(Debug, Default)]
struct Block {
    patterns: Option<Vec<String>>,
    options: Vec<(String, Vec<String>)>,
}

/// 把設定檔（含 Include）攤平成區塊。`Include` 在區塊中間出現時，被引入的內容屬於同一個區塊
/// ——除非被引入的檔案自己開了新的 `Host`，與 OpenSSH 相同。
fn collect_blocks(fs: &dyn ConfigFs, text: &str, ssh_dir: &Path, blocks: &mut Vec<Block>, depth: usize) {
    if depth > 16 {
        return; // Include 迴圈
    }
    for raw in text.lines() {
        let Some((key, args)) = split_line(raw) else { continue };
        match key.as_str() {
            "host" => blocks.push(Block { patterns: Some(args), options: Vec::new() }),
            "match" => blocks.push(Block { patterns: None, options: Vec::new() }),
            "include" => {
                for a in args {
                    let a = expand_tilde(&a);
                    let p = PathBuf::from(&a);
                    let p = if p.is_absolute() { p } else { ssh_dir.join(p) };
                    let (dir, name) = match (p.parent(), p.file_name()) {
                        (Some(d), Some(n)) => (d.to_path_buf(), n.to_string_lossy().to_string()),
                        _ => continue,
                    };
                    let files = if name.contains('*') || name.contains('?') { fs.glob(&dir, &name) } else { vec![p.clone()] };
                    for f in files {
                        if let Some(t) = fs.read(&f) {
                            collect_blocks(fs, &t, ssh_dir, blocks, depth + 1);
                        }
                    }
                }
            }
            _ => {
                if blocks.is_empty() {
                    // 第一個 Host 之前的設定適用於所有主機
                    blocks.push(Block { patterns: Some(vec!["*".into()]), options: Vec::new() });
                }
                if let Some(b) = blocks.last_mut() {
                    b.options.push((key, args));
                }
            }
        }
    }
}

fn block_matches(patterns: &[String], alias: &str) -> bool {
    let mut hit = false;
    for p in patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if wildmatch(neg, alias, true) {
                return false;
            }
        } else if wildmatch(p, alias, true) {
            hit = true;
        }
    }
    hit
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn expand_tilde(s: &str) -> String {
    if s == "~" {
        return home_dir().display().to_string();
    }
    if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
        return home_dir().join(rest).display().to_string();
    }
    s.to_string()
}

/// `%d` 家目錄、`%u` 本機使用者、`%h` 主機、`%r` 遠端使用者、`%%`；其餘照原樣留著。
fn expand_tokens(s: &str, host: &str, user: &str, local_user: &str) -> String {
    let s = expand_tilde(s);
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('d') => out.push_str(&home_dir().display().to_string()),
            Some('u') => out.push_str(local_user),
            Some('h') => out.push_str(host),
            Some('r') => out.push_str(user),
            Some('%') => out.push('%'),
            Some(o) => {
                out.push('%');
                out.push(o);
            }
            None => out.push('%'),
        }
    }
    out
}

fn local_user_name() -> String {
    std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default()
}

/// 解析 ssh config 的內容（`ssh_dir` = Include 相對路徑的基準，通常是 `~/.ssh`）。
pub fn parse_ssh_config(fs: &dyn ConfigFs, text: &str, ssh_dir: &Path, local_user: &str) -> (Vec<ImportCandidate>, usize) {
    let mut blocks = Vec::new();
    collect_blocks(fs, text, ssh_dir, &mut blocks, 0);
    // 具體別名：依第一次出現的順序
    let mut aliases: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    for b in &blocks {
        for p in b.patterns.iter().flatten() {
            if p.starts_with('!') {
                continue;
            }
            if p.contains('*') || p.contains('?') {
                if p != "*" {
                    skipped += 1;
                }
                continue;
            }
            if !aliases.iter().any(|a| a.eq_ignore_ascii_case(p)) {
                aliases.push(p.clone());
            }
        }
    }
    let mut out = Vec::new();
    for alias in aliases {
        let mut hostname: Option<String> = None;
        let mut user: Option<String> = None;
        let mut port: Option<String> = None;
        let mut identity: Vec<String> = Vec::new();
        let mut cert: Vec<String> = Vec::new();
        let mut jump: Option<String> = None;
        let mut notes: Vec<String> = Vec::new();
        let note_once = |n: String, notes: &mut Vec<String>| {
            if !notes.contains(&n) {
                notes.push(n);
            }
        };
        for b in &blocks {
            let Some(pats) = &b.patterns else { continue };
            if !block_matches(pats, &alias) {
                continue;
            }
            for (k, args) in &b.options {
                let first = args.first().cloned().unwrap_or_default();
                match k.as_str() {
                    "hostname" if hostname.is_none() => hostname = Some(first),
                    "user" if user.is_none() => user = Some(first),
                    "port" if port.is_none() => port = Some(first),
                    "identityfile" if !first.eq_ignore_ascii_case("none") => identity.push(first),
                    "certificatefile" if !first.eq_ignore_ascii_case("none") => cert.push(first),
                    "proxyjump" if jump.is_none() && !first.eq_ignore_ascii_case("none") => {
                        // 多層（a,b）：最靠近目標的是最後一台；更外層要在那台自己的設定裡接
                        let all = args.join("");
                        let hops: Vec<&str> = all.split(',').map(str::trim).filter(|h| !h.is_empty()).collect();
                        if hops.len() > 1 {
                            note_once(
                                tf!("多層跳板機（{via}）：只接最後一台，前面幾層請到那台主機的設定裡設跳板機", via = all),
                                &mut notes,
                            );
                        }
                        jump = hops.last().map(|h| h.to_string());
                    }
                    "proxycommand" if !first.eq_ignore_ascii_case("none") => {
                        note_once(t!("有 ProxyCommand：目前還不支援，匯入後直連可能連不上").to_string(), &mut notes)
                    }
                    "localforward" | "remoteforward" | "dynamicforward" => {
                        note_once(t!("有連接埠轉送設定：目前還不支援，不會一起匯入").to_string(), &mut notes)
                    }
                    _ => {}
                }
            }
        }
        let host = hostname.map(|h| expand_tokens(&h, &alias, "", local_user)).unwrap_or_else(|| alias.clone());
        let user_given = user.is_some();
        let user = user.unwrap_or_else(|| local_user.to_string());
        if !user_given {
            note_once(tf!("沒有設定 User，先用本機帳號 {user}", user = user), &mut notes);
        }
        let port = match port.as_deref().map(str::parse::<u16>) {
            None => 22,
            Some(Ok(p)) if p > 0 => p,
            _ => {
                note_once(t!("Port 設定看不懂，先用 22").to_string(), &mut notes);
                22
            }
        };
        if identity.len() > 1 {
            note_once(tf!("設定了 {n} 把私鑰，先用第一把", n = identity.len()), &mut notes);
        }
        out.push(ImportCandidate {
            name: alias.clone(),
            folder: None,
            identity_file: identity.first().map(|p| expand_tokens(p, &host, &user, local_user)),
            certificate_file: cert.first().map(|p| expand_tokens(p, &host, &user, local_user)),
            host,
            port,
            username: user,
            xshell_key: None,
            proxy_jump: jump,
            term: None,
            notes,
        });
    }
    (out, skipped)
}

pub fn default_ssh_config_path() -> PathBuf {
    home_dir().join(".ssh").join("config")
}

/// 讀 ssh config（`path` 空 = `~/.ssh/config`）。
pub fn scan_ssh_config(path: Option<&str>) -> AppResult<ImportScan> {
    let p = match path.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(expand_tilde(p)),
        None => default_ssh_config_path(),
    };
    let text = std::fs::read_to_string(&p).map_err(|e| AppError::Ssh(tf!("讀不到 {path}：{e}", path = p.display(), e = e)))?;
    let ssh_dir = p.parent().map(Path::to_path_buf).unwrap_or_else(|| home_dir().join(".ssh"));
    let (hosts, skipped) = parse_ssh_config(&RealFs, &text, &ssh_dir, &local_user_name());
    Ok(ImportScan { path: p.display().to_string(), hosts, skipped })
}

// ---- Xshell (.xsh) ----

/// `.xsh` 的文字：新版 Xshell 存 UTF-16LE（有 BOM），舊版是本機編碼 / UTF-8。
fn decode_xsh(bytes: &[u8]) -> String {
    let utf16 = |b: &[u8]| {
        let units: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    };
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return utf16(rest);
    }
    // 沒有 BOM 的 UTF-16LE：ASCII 內容的奇數位元組幾乎全是 0
    if bytes.len() >= 4 && bytes.iter().skip(1).step_by(2).take(64).all(|&b| b == 0) {
        return utf16(bytes);
    }
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

/// 讀一個 `.xsh` 的 INI 內容，回 `(區段小寫, 鍵小寫) → 值`。
fn parse_ini(text: &str) -> std::collections::HashMap<(String, String), String> {
    let mut out = std::collections::HashMap::new();
    let mut section = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if let Some(s) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = s.trim().to_ascii_lowercase();
        } else if let Some((k, v)) = line.split_once('=') {
            out.insert((section.clone(), k.trim().to_ascii_lowercase()), v.trim().to_string());
        }
    }
    out
}

/// 一個 Xshell 工作階段。非 SSH（Telnet / Serial / RLogin…）或沒有主機的回 None。
pub fn parse_xsh(bytes: &[u8], name: &str, folder: Option<String>) -> Option<ImportCandidate> {
    let ini = parse_ini(&decode_xsh(bytes));
    let get = |s: &str, k: &str| ini.get(&(s.to_string(), k.to_string())).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let protocol = get("connection", "protocol").unwrap_or_else(|| "SSH".into());
    if !protocol.eq_ignore_ascii_case("ssh") && !protocol.eq_ignore_ascii_case("sftp") {
        return None;
    }
    let host = get("connection", "host")?;
    let port = get("connection", "port").and_then(|p| p.parse::<u16>().ok()).filter(|p| *p > 0).unwrap_or(22);
    let username = get("connection:authentication", "username").unwrap_or_default();
    let xshell_key = get("connection:authentication", "userkey");
    let mut notes = Vec::new();
    if username.is_empty() {
        notes.push(t!("工作階段沒有存使用者名稱，匯入後請補上").to_string());
    }
    if let Some(k) = &xshell_key {
        notes.push(tf!(
            "用的是原軟體金鑰庫裡的金鑰「{key}」：請先在原本的軟體把它匯出成 OpenSSH 格式，再匯入 db-kit 的金鑰庫（同名的金鑰匯入時會自動對上）",
            key = k
        ));
    }
    Some(ImportCandidate {
        name: name.to_string(),
        folder,
        host,
        port,
        username,
        identity_file: None,
        certificate_file: None,
        xshell_key,
        proxy_jump: None,
        term: get("terminal", "type"),
        notes,
    })
}

/// Xshell 預設的工作階段資料夾：`文件\NetSarang Computer\<版本>\Xshell\Sessions`，取版本最新的那個。
pub fn default_xshell_dir() -> Option<PathBuf> {
    let base = dirs::document_dir()?.join("NetSarang Computer");
    let mut found: Vec<(u32, PathBuf)> = std::fs::read_dir(&base)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let v: u32 = e.file_name().to_string_lossy().parse().ok()?;
            let dir = e.path().join("Xshell").join("Sessions");
            dir.is_dir().then_some((v, dir))
        })
        .collect();
    found.sort();
    found.pop().map(|(_, d)| d)
}

/// 掃 Xshell 工作階段資料夾（遞迴；子資料夾對應成主機資料夾）。
pub fn scan_xshell_dir(dir: Option<&str>) -> AppResult<ImportScan> {
    let root = match dir.map(str::trim).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(expand_tilde(d)),
        None => default_xshell_dir().ok_or_else(|| AppError::Ssh(t!("找不到預設的 .xsh 工作階段資料夾，請手動選擇").into()))?,
    };
    if !root.is_dir() {
        return Err(AppError::Ssh(tf!("不是資料夾：{path}", path = root.display())));
    }
    let mut hosts = Vec::new();
    let mut skipped = 0usize;
    let mut stack = vec![(root.clone(), Vec::<String>::new())];
    let mut seen = 0usize;
    while let Some((d, rel)) = stack.pop() {
        let mut entries: Vec<_> = std::fs::read_dir(&d).into_iter().flatten().flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            seen += 1;
            if seen > 10_000 {
                break;
            }
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if p.is_dir() {
                let mut r = rel.clone();
                r.push(name);
                stack.push((p, r));
            } else if p.extension().is_some_and(|x| x.eq_ignore_ascii_case("xsh")) {
                let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or(name);
                let folder = (!rel.is_empty()).then(|| rel.join("/"));
                match std::fs::read(&p).ok().and_then(|b| parse_xsh(&b, &stem, folder)) {
                    Some(h) => hosts.push(h),
                    None => skipped += 1,
                }
            }
        }
    }
    hosts.sort_by(|a, b| (a.folder.clone(), a.name.to_lowercase()).cmp(&(b.folder.clone(), b.name.to_lowercase())));
    Ok(ImportScan { path: root.display().to_string(), hosts, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct MemFs(HashMap<PathBuf, String>);
    impl ConfigFs for MemFs {
        fn read(&self, path: &Path) -> Option<String> {
            self.0.get(path).cloned()
        }
        fn glob(&self, dir: &Path, pattern: &str) -> Vec<PathBuf> {
            let mut v: Vec<PathBuf> = self
                .0
                .keys()
                .filter(|p| p.parent() == Some(dir))
                .filter(|p| wildmatch(pattern, &p.file_name().unwrap().to_string_lossy(), false))
                .cloned()
                .collect();
            v.sort();
            v
        }
    }

    fn find<'a>(hs: &'a [ImportCandidate], name: &str) -> &'a ImportCandidate {
        hs.iter().find(|h| h.name == name).unwrap_or_else(|| panic!("no {name}: {hs:?}"))
    }

    #[test]
    fn wildcards() {
        assert!(wildmatch("*.example.com", "web.example.com", true));
        assert!(wildmatch("web-?", "WEB-1", true));
        assert!(!wildmatch("web-?", "web-10", true));
        assert!(wildmatch("*", "", false));
        assert!(!wildmatch("a*b", "acd", false));
    }

    #[test]
    fn first_value_wins_and_host_star_defaults() {
        let cfg = r#"
# 全域
ServerAliveInterval 30

Host web-01 web-02
    HostName %h.prod.example.com
    User deploy
    IdentityFile ~/.ssh/id_prod

Host db
    HostName=10.0.0.5
    Port 2222
    User "db admin"
    CertificateFile ~/.ssh/id_db-cert.pub
    IdentityFile ~/.ssh/id_db
    IdentityFile ~/.ssh/id_fallback

Host *.internal !bastion.internal
    ProxyJump bastion

Host *
    User fallback
    IdentityFile ~/.ssh/id_default
"#;
        let fs = MemFs(HashMap::new());
        let (hs, skipped) = parse_ssh_config(&fs, cfg, Path::new("/home/me/.ssh"), "me");
        assert_eq!(hs.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), vec!["web-01", "web-02", "db"]);
        assert_eq!(skipped, 1, "萬用字元的 Host（*.internal）不算主機；Host * 不計入略過");
        let w = find(&hs, "web-01");
        assert_eq!((w.host.as_str(), w.username.as_str(), w.port), ("web-01.prod.example.com", "deploy", 22));
        assert!(w.identity_file.as_deref().unwrap().ends_with("id_prod"), "{:?}", w.identity_file);
        // Host * 的 IdentityFile 也累加上去（OpenSSH 會依序試兩把）→ 提醒只用第一把
        assert_eq!(w.notes.len(), 1, "{:?}", w.notes);
        assert!(w.notes[0].contains('2'), "{:?}", w.notes);
        let d = find(&hs, "db");
        assert_eq!((d.host.as_str(), d.username.as_str(), d.port), ("10.0.0.5", "db admin", 2222));
        assert!(d.identity_file.as_deref().unwrap().ends_with("id_db"));
        assert!(d.certificate_file.as_deref().unwrap().ends_with("id_db-cert.pub"));
        assert!(d.notes.iter().any(|n| n.contains('3')), "IdentityFile 累加到 3 把（含 Host * 的），提醒只用第一把：{:?}", d.notes);
    }

    #[test]
    fn negation_proxyjump_and_missing_user() {
        let cfg = "Host app.internal bastion.internal\n  HostName %h\nHost *.internal !bastion.internal\n  ProxyJump bastion\n  LocalForward 8080 localhost:80\n";
        let (hs, _) = parse_ssh_config(&MemFs(HashMap::new()), cfg, Path::new("/h/.ssh"), "me");
        let app = find(&hs, "app.internal");
        assert_eq!(app.proxy_jump.as_deref(), Some("bastion"));
        assert!(app.notes.iter().any(|n| n.contains("轉送")), "{:?}", app.notes);
        assert_eq!(app.username, "me", "沒設 User 用本機帳號");
        let b = find(&hs, "bastion.internal");
        assert_eq!(b.proxy_jump, None, "!bastion.internal 排除");
        // 多層：接最後一台並提醒
        let (hs, _) = parse_ssh_config(&MemFs(HashMap::new()), "Host deep\n  ProxyJump edge,bastion\n", Path::new("/h/.ssh"), "me");
        assert_eq!(hs[0].proxy_jump.as_deref(), Some("bastion"));
        assert!(hs[0].notes.iter().any(|n| n.contains("edge,bastion")), "{:?}", hs[0].notes);
    }

    #[test]
    fn include_with_glob_relative_to_ssh_dir() {
        let mut files = HashMap::new();
        files.insert(PathBuf::from("/h/.ssh/conf.d/a.conf"), "Host alpha\n  HostName 10.1.1.1\n  User a\n".to_string());
        files.insert(PathBuf::from("/h/.ssh/conf.d/b.conf"), "Host beta\n  HostName 10.1.1.2\n".to_string());
        files.insert(PathBuf::from("/h/.ssh/conf.d/notes.txt"), "Host gamma\n".to_string());
        let cfg = "Include conf.d/*.conf\nHost beta\n  User late\n";
        let (hs, _) = parse_ssh_config(&MemFs(files), cfg, Path::new("/h/.ssh"), "me");
        assert_eq!(hs.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), vec!["alpha", "beta"]);
        assert_eq!(find(&hs, "beta").username, "late");
        assert_eq!(find(&hs, "alpha").host, "10.1.1.1");
    }

    #[test]
    fn match_blocks_are_ignored() {
        let cfg = "Host web\n  User a\nMatch host web exec \"true\"\n  User b\n  Port 99\n";
        let (hs, _) = parse_ssh_config(&MemFs(HashMap::new()), cfg, Path::new("/h/.ssh"), "me");
        assert_eq!((hs[0].username.as_str(), hs[0].port), ("a", 22));
    }

    fn utf16le_bom(s: &str) -> Vec<u8> {
        let mut v = vec![0xFF, 0xFE];
        for u in s.encode_utf16() {
            v.extend_from_slice(&u.to_le_bytes());
        }
        v
    }

    #[test]
    fn xshell_sessions() {
        let xsh = "[CONNECTION]\r\nHost=10.20.0.15\r\nPort=2200\r\nProtocol=SSH\r\n[CONNECTION:AUTHENTICATION]\r\nUserName=deploy\r\nUserKey=id_rsa_2048\r\nPassword=ENCRYPTED\r\n[TERMINAL]\r\nType=xterm\r\n";
        let h = parse_xsh(&utf16le_bom(xsh), "web-01", Some("PROD".into())).unwrap();
        assert_eq!((h.host.as_str(), h.port, h.username.as_str()), ("10.20.0.15", 2200, "deploy"));
        assert_eq!((h.folder.as_deref(), h.xshell_key.as_deref(), h.term.as_deref()), (Some("PROD"), Some("id_rsa_2048"), Some("xterm")));
        assert!(h.notes.iter().any(|n| n.contains("id_rsa_2048")));
        // UTF-8、沒有 BOM 的舊檔
        let h = parse_xsh("[CONNECTION]\nHost=h\n".as_bytes(), "x", None).unwrap();
        assert_eq!((h.port, h.username.as_str()), (22, ""));
        assert!(!h.notes.is_empty(), "沒有使用者名稱要提醒");
        // 非 SSH 的略過
        assert!(parse_xsh(utf16le_bom("[CONNECTION]\nHost=h\nProtocol=TELNET\n").as_slice(), "t", None).is_none());
        // 沒有主機的略過
        assert!(parse_xsh(b"[CONNECTION]\nPort=22\n", "n", None).is_none());
    }

    #[test]
    fn xshell_dir_walk_maps_subfolders() {
        let root = std::env::temp_dir().join(format!("dbkit-xsh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("PROD").join("web")).unwrap();
        std::fs::write(root.join("bastion.xsh"), utf16le_bom("[CONNECTION]\nHost=bastion.example.com\n[CONNECTION:AUTHENTICATION]\nUserName=ops\n")).unwrap();
        std::fs::write(root.join("PROD").join("web").join("web-01.xsh"), utf16le_bom("[CONNECTION]\nHost=10.0.0.1\n[CONNECTION:AUTHENTICATION]\nUserName=deploy\n")).unwrap();
        std::fs::write(root.join("PROD").join("serial.xsh"), utf16le_bom("[CONNECTION]\nHost=COM1\nProtocol=SERIAL\n")).unwrap();
        std::fs::write(root.join("readme.txt"), "x").unwrap();
        let scan = scan_xshell_dir(Some(&root.display().to_string())).unwrap();
        assert_eq!(scan.skipped, 1);
        let names: Vec<(Option<&str>, &str)> = scan.hosts.iter().map(|h| (h.folder.as_deref(), h.name.as_str())).collect();
        assert_eq!(names, vec![(None, "bastion"), (Some("PROD/web"), "web-01")]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
