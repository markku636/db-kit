//! MCP 唯讀模式的指令白名單：`dbk mcp --ssh`（沒加 `--allow-ssh-exec`）只放行「只會讀」的指令。
//!
//! 和 `shell_guard` 的方向相反：守門是黑名單（認得的危險才擋），這裡是白名單（認得的唯讀才放）。
//! shell 沒有真正的唯讀保證——任何程式都能寫檔——所以清單刻意收斂在「看狀態、看日誌、看設定」：
//! - 指令不在清單上、或是清單上但用了會寫入 / 執行其他程式的選項（`find -exec`、`sed -i`、`curl -o`、
//!   `sort -o`、`git -c`）都不放；子指令型工具（git / docker / kubectl / systemctl…）只放查看類子指令。
//! - 輸出重導向只准寫到 `/dev/null`；`$( )`、反引號、`<( )` 裡的子指令一樣逐段檢查。
//! - sudo / su 不放：要 root 才看得到的東西，由使用者決定要不要打開 `--allow-ssh-exec`。
//! - 會一直等新輸出的寫法（`docker logs -f`、`kubectl get -w`）不放：exec 通道沒有人按 Ctrl+C。
//!
//! 斷詞、剝包裝（`env` / `nohup` / `timeout` / `xargs`…）沿用 `shell_guard`，兩邊對指令的切法一致。

use once_cell::sync::Lazy;
use regex::Regex;

use super::shell_guard::{
    self, base_word, cluster, extract_substitutions, full_cluster_ends, has_short, logical_lines, redirects, skip_opts, split_args,
    split_detailed, strip_wrappers, tokenize, write_targets,
};

/// 一個不符合唯讀的地方。`why` 是繁中原文 key（顯示時經 `i18n::lookup` 翻譯）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadOnlyIssue {
    pub word: String,
    pub why: &'static str,
}

pub mod why {
    pub const COMMAND: &str = "不在唯讀模式允許的指令清單";
    pub const SUBCOMMAND: &str = "唯讀模式只允許查看類的子指令";
    pub const OPTION: &str = "帶了會寫入檔案或執行其他程式的選項";
    pub const REDIRECT: &str = "輸出重導向到檔案";
    pub const FOLLOW: &str = "會持續等待新輸出（例如 -f / --follow / -w），請改用一次性的寫法";
    pub const DB_CLI: &str = "資料庫命令列工具不在唯讀範圍（查資料庫請改用 db-kit 的資料庫工具）";
    pub const ROOT: &str = super::shell_guard::reason::ROOT;
    pub const TOO_DEEP: &str = super::shell_guard::reason::TOO_DEEP;
}

/// 整段指令（可多行）裡不符合唯讀的地方；空 = 全部是查看類指令。依出現順序、去重。
pub fn read_only_issues(script: &str) -> Vec<ReadOnlyIssue> {
    let mut out = Vec::new();
    for line in logical_lines(script) {
        ro_line(&line, 0, &mut out);
    }
    let mut seen = Vec::new();
    out.retain(|i: &ReadOnlyIssue| {
        let k = (i.word.clone(), i.why);
        if seen.contains(&k) {
            false
        } else {
            seen.push(k);
            true
        }
    });
    out
}

fn issue(out: &mut Vec<ReadOnlyIssue>, word: &str, why: &'static str) {
    out.push(ReadOnlyIssue { word: word.to_string(), why });
}

fn ro_line(line: &str, depth: usize, out: &mut Vec<ReadOnlyIssue>) {
    if depth > 4 {
        issue(out, "", why::TOO_DEEP);
        return;
    }
    for seg in split_detailed(line) {
        ro_segment(&seg.text, depth, out);
    }
    for sub in extract_substitutions(line) {
        ro_line(&sub, depth + 1, out);
    }
    for (write, sub) in process_substitutions(line) {
        if write {
            issue(out, ">(…)", why::REDIRECT);
        }
        ro_line(&sub, depth + 1, out);
    }
}

/// `<( … )` / `>( … )` 的內容（單引號內不算）；`true` = 是 `>( )`（把輸出餵給另一支程式）。
fn process_substitutions(line: &str) -> Vec<(bool, String)> {
    let cs: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut single = false;
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '\\' && !single {
            i += 2;
            continue;
        }
        if c == '\'' {
            single = !single;
        } else if !single && (c == '<' || c == '>') && cs.get(i + 1) == Some(&'(') {
            let mut depth = 1;
            let mut j = i + 2;
            while j < cs.len() && depth > 0 {
                match cs[j] {
                    '(' => depth += 1,
                    ')' => depth -= 1,
                    _ => {}
                }
                j += 1;
            }
            let end = if depth == 0 { j - 1 } else { cs.len() };
            out.push((c == '>', cs[i + 2..end.max(i + 2)].iter().collect()));
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

fn ro_segment(seg: &str, depth: usize, out: &mut Vec<ReadOnlyIssue>) {
    let s = strip_wrappers(seg);
    if s.root {
        let w = tokenize(seg.trim_start_matches(['(', '{', ' '])).first().map(|t| base_word(&t.v).to_string()).unwrap_or_default();
        issue(out, &w, why::ROOT);
    }
    if s.sub {
        ro_line(&s.text, depth + 1, out);
        return;
    }
    let toks = tokenize(&s.text);
    let Some(first) = toks.first() else { return };
    for (_, target) in redirects(&s.text) {
        if target != "/dev/null" {
            issue(out, &target, why::REDIRECT);
        }
    }
    let word = base_word(&first.v);
    let args: Vec<String> = toks[1..].iter().map(|t| t.v.clone()).collect();
    if let Err(w) = allowed(word, &args) {
        issue(out, word, w);
    }
}

/// 不帶任何選項限制就放行的指令：只讀檔、看狀態、做文字處理後印到 stdout。
const PLAIN: &[&str] = &[
    "ls", "dir", "vdir", "exa", "eza", "pwd", "cd", "pushd", "popd", "dirs", "echo", "printf", "cat", "tac", "bat", "batcat", "head", "tail",
    "wc", "nl", "cut", "paste", "tr", "rev", "fold", "fmt", "column", "expand", "unexpand", "comm", "join", "diff", "diff3", "sdiff", "cmp",
    "grep", "egrep", "fgrep", "zgrep", "zegrep", "zfgrep", "zcat", "bzcat", "xzcat", "zstdcat", "lz4cat", "ag", "stat", "du", "df", "free",
    "uptime", "w", "who", "whoami", "id", "groups", "users", "last", "lastb", "lastlog", "uname", "arch", "cal", "ps", "pgrep", "pidof",
    "pstree", "top", "vmstat", "iostat", "mpstat", "pidstat", "sar", "nproc", "lscpu", "lsmem", "lsblk", "lspci", "lsusb", "lsmod", "lsns",
    "lsipc", "lslocks", "blkid", "findmnt", "lsof", "netstat", "ping", "ping6", "traceroute", "traceroute6", "tracepath", "dig", "nslookup",
    "host", "getent", "whois", "which", "whereis", "type", "realpath", "readlink", "basename", "dirname", "md5sum", "sha1sum", "sha224sum",
    "sha256sum", "sha384sum", "sha512sum", "b2sum", "cksum", "sum", "strings", "od", "hexdump", "hd", "jq", "base64", "base32", "printenv",
    "locale", "getconf", "ulimit", "namei", "getfacl", "lsattr", "numfmt", "expr", "bc", "seq", "sleep", "true", "false", "test", "[", "[[",
    ":", "for", "done", "fi", "esac", "in", "export", "set", "unset", "wait", "shopt", "dpkg-query", "zipinfo", "atq", "tput",
];

/// 只准查版本（`-v` / `--version` / `version`）的直譯器與建置工具：其餘參數都可能跑任意程式碼。
const VERSION_ONLY: &[&str] = &[
    "php", "node", "nodejs", "java", "javac", "ruby", "perl", "go", "rustc", "cargo", "gcc", "g++", "cc", "clang", "make", "cmake", "dotnet",
    "mvn", "gradle", "deno", "bun", "lua", "erl", "elixir", "terraform", "tofu", "ansible", "composer", "rails",
];
const VERSION_ARGS: &[&str] = &["-v", "-V", "--version", "-version", "version"];

static AWK_PRINT_TO_FILE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\bprintf?\b[^;}]*>").unwrap());
/// sed 的 `w 檔案` / `W 檔案` / `e 指令`（含 `s///w`、`s///e`）。
static SED_EXEC_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?:^|[;{}\s0-9$!/])[wWe](?:\s|$|;|\})").unwrap());
static SED_SFLAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"/[gpiImM0-9]*[we](?:\s|$|;|\})").unwrap());

fn ok_if(cond: bool, why: &'static str) -> Result<(), &'static str> {
    if cond { Ok(()) } else { Err(why) }
}

/// 一個指令（已剝掉 env / nohup / xargs 等包裝）在唯讀模式下能不能跑。
fn allowed(word: &str, args: &[String]) -> Result<(), &'static str> {
    let sp = split_args(args);
    let (flags, ops) = (&sp.flags, &sp.ops);
    let has = |s: &str| args.iter().any(|a| a == s);
    let flag_starts = |p: &str| flags.iter().any(|f| f.starts_with(p));
    let op0 = ops.first().copied().unwrap_or("");
    let op1 = ops.get(1).copied().unwrap_or("");

    if PLAIN.contains(&word) {
        return Ok(());
    }
    let py = word.strip_prefix("python").is_some_and(|v| v.chars().all(|c| c.is_ascii_digit() || c == '.'));
    if py || VERSION_ONLY.contains(&word) {
        return ok_if(!args.is_empty() && args.iter().all(|a| VERSION_ARGS.contains(&a.as_str())), why::OPTION);
    }
    if shell_guard::DB_CLIS.contains(&word) {
        return Err(why::DB_CLI);
    }
    match word {
        "tree" => ok_if(!has_short(flags, 'o'), why::OPTION),
        "file" => ok_if(!has_short(flags, 'C') && !has("--compile"), why::OPTION),
        "rg" => ok_if(!flag_starts("--pre"), why::OPTION),
        "fd" | "fdfind" => ok_if(!flags.iter().any(|f| cluster(f).contains(['x', 'X']) || f.starts_with("--exec")), why::OPTION),
        "ss" => ok_if(!flags.iter().any(|f| cluster(f).contains('K') || *f == "--kill"), why::OPTION),
        "hostname" => ok_if(ops.is_empty() && !flags.iter().any(|f| matches!(*f, "-F" | "--file" | "-b" | "--boot")), why::OPTION),
        "date" => date_ok(args),
        "sort" => ok_if(!flags.iter().any(|f| cluster(f).contains('o') || f.starts_with("--output") || f.starts_with("--compress-program")), why::OPTION),
        "uniq" => ok_if(ops.len() <= 1, why::OPTION),
        "xxd" => ok_if(!flags.iter().any(|f| cluster(f).contains('r')) && ops.len() <= 1, why::OPTION),
        "find" => ok_if(
            !args.iter().any(|a| {
                matches!(a.as_str(), "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir" | "-fprint" | "-fprint0" | "-fprintf" | "-fls")
            }),
            why::OPTION,
        ),
        "tar" => tar_list_only(args),
        "unzip" => ok_if(flags.iter().any(|f| cluster(f).contains(['l', 'v', 'Z', 't', 'p'])), why::OPTION),
        "gzip" | "gunzip" | "bzip2" | "bunzip2" | "xz" | "unxz" | "zstd" | "unzstd" | "lz4" => ok_if(
            flags.iter().any(|f| cluster(f).contains(['c', 'l', 't']) || matches!(*f, "--stdout" | "--to-stdout" | "--list" | "--test")),
            why::OPTION,
        ),
        "awk" | "gawk" | "mawk" | "nawk" => awk_ok(args),
        "sed" => sed_ok(args),
        "yq" => ok_if(!flags.iter().any(|f| cluster(f).contains('i') || f.starts_with("--inplace")), why::OPTION),
        "curl" => curl_ok(args),
        "wget" => wget_ok(args),
        "openssl" => {
            let bad = args.iter().any(|a| matches!(a.as_str(), "-out" | "-keyout" | "-new" | "-newkey" | "-genkey" | "-signkey" | "-x509"));
            let sub_ok = ["version", "x509", "s_client", "verify", "ciphers", "crl", "asn1parse", "errstr", "list", "req", "dgst"].contains(&op0);
            if !sub_ok {
                Err(why::SUBCOMMAND)
            } else {
                ok_if(!bad, why::OPTION)
            }
        }
        "ssh-keygen" => ok_if(
            flags.iter().any(|f| cluster(f).contains(['l', 'F', 'L'])) && !flags.iter().any(|f| cluster(f).contains('R')),
            why::OPTION,
        ),
        "systemctl" => ok_if(
            op0.is_empty()
                || [
                    "status", "show", "cat", "list-units", "list-unit-files", "list-sockets", "list-timers", "list-jobs", "list-dependencies",
                    "list-machines", "is-active", "is-enabled", "is-failed", "is-system-running", "get-default", "show-environment", "help",
                    "version",
                ]
                .contains(&op0),
            why::SUBCOMMAND,
        ),
        "service" => ok_if(has("--status-all") || (ops.len() == 2 && op1 == "status"), why::SUBCOMMAND),
        "journalctl" => ok_if(
            !flags.iter().any(|f| {
                f.starts_with("--vacuum")
                    || matches!(*f, "--rotate" | "--flush" | "--sync" | "--relinquish-var" | "--smart-relinquish-var" | "--setup-keys" | "--update-catalog")
            }),
            why::OPTION,
        ),
        "dmesg" => ok_if(
            !flags.iter().any(|f| {
                cluster(f).contains(['c', 'C', 'D', 'E', 'n'])
                    || matches!(*f, "--clear" | "--read-clear" | "--console-off" | "--console-on" | "--console-level")
            }),
            why::OPTION,
        ),
        "sysctl" => ok_if(
            !flags.iter().any(|f| cluster(f).contains(['w', 'p']) || matches!(*f, "--write" | "--load" | "--system")) && !ops.iter().any(|o| o.contains('=')),
            why::OPTION,
        ),
        "crontab" => ok_if(has_short(flags, 'l') && !has_short(flags, 'r') && !has_short(flags, 'e'), why::OPTION),
        "mount" => ok_if(
            flags.iter().all(|f| matches!(*f, "-l" | "-t" | "--show-labels" | "--types" | "-v")) && ops.len() <= usize::from(has("-t") || has("--types")),
            why::OPTION,
        ),
        "swapon" => ok_if(ops.is_empty() && flags.iter().all(|f| f.starts_with("--show") || matches!(*f, "-s" | "--summary" | "--noheadings" | "--bytes" | "--raw")), why::OPTION),
        "ip" => ip_ok(args),
        "ifconfig" => ok_if(ops.len() <= 1, why::OPTION),
        "route" => ok_if(!ops.iter().any(|o| ["add", "del", "delete", "flush", "change", "append", "replace"].contains(o)), why::SUBCOMMAND),
        "arp" => ok_if(!flags.iter().any(|f| cluster(f).contains(['d', 's', 'f']) || matches!(*f, "--delete" | "--set" | "--file")), why::OPTION),
        "iptables" | "ip6tables" => {
            let list = flags.iter().any(|f| cluster(f).contains(['L', 'S']) || matches!(*f, "--list" | "--list-rules"));
            let change = flags.iter().any(|f| {
                cluster(f).contains(['A', 'I', 'D', 'R', 'F', 'X', 'P', 'N', 'E', 'Z'])
                    || matches!(*f, "--append" | "--insert" | "--delete" | "--replace" | "--flush" | "--delete-chain" | "--policy" | "--new-chain" | "--rename-chain" | "--zero")
            });
            ok_if(list && !change, why::OPTION)
        }
        "nft" => ok_if(op0 == "list", why::SUBCOMMAND),
        "ufw" => ok_if(op0 == "status" || op0 == "show" || (op0 == "app" && op1 == "list"), why::SUBCOMMAND),
        "firewall-cmd" => ok_if(
            ops.is_empty()
                && !flags.is_empty()
                && flags.iter().all(|f| {
                    f.starts_with("--list") || f.starts_with("--get") || f.starts_with("--query") || f.starts_with("--info") || f.starts_with("--zone") || matches!(*f, "--state" | "--permanent")
                }),
            why::OPTION,
        ),
        "timedatectl" | "hostnamectl" | "localectl" => ok_if(
            op0.is_empty() || op0.starts_with("list-") || matches!(op0, "status" | "show" | "timesync-status" | "show-timesync"),
            why::SUBCOMMAND,
        ),
        "loginctl" => ok_if(op0.is_empty() || op0.starts_with("list-") || op0.starts_with("show-") || op0.ends_with("-status"), why::SUBCOMMAND),
        "git" => git_ok(args),
        "docker" | "podman" | "nerdctl" => docker_ok(args),
        "docker-compose" => compose_ok(args),
        "kubectl" | "oc" => kubectl_ok(args),
        "helm" => {
            let j = skip_opts(args, 0, &["-n", "--namespace", "--kube-context", "--kubeconfig"]);
            let verb = args.get(j).map(String::as_str).unwrap_or("");
            let next = args.get(j + 1..).map(split_args).and_then(|s| s.ops.first().map(|o| o.to_string())).unwrap_or_default();
            ok_if(
                ["list", "ls", "status", "get", "history", "show", "inspect", "search", "version", "env", "template", "lint"].contains(&verb)
                    || (matches!(verb, "dependency" | "repo" | "plugin") && (next == "list" || next == "ls")),
                why::SUBCOMMAND,
            )
        }
        "npm" | "pnpm" | "yarn" => {
            if ops.is_empty() {
                ok_if(!flags.is_empty() && flags.iter().all(|f| VERSION_ARGS.contains(f)), why::OPTION)
            } else {
                let ro = ["ls", "list", "ll", "la", "view", "v", "info", "show", "outdated", "root", "prefix", "doctor", "explain", "why", "search", "query"].contains(&op0)
                    || (op0 == "config" && matches!(op1, "get" | "list" | "ls"))
                    || (op0 == "audit" && !ops.contains(&"fix"))
                    || (op0 == "version" && ops.len() == 1);
                ok_if(ro, why::SUBCOMMAND)
            }
        }
        "pip" | "pip3" | "pipx" => ok_if(
            (ops.is_empty() && !flags.is_empty() && flags.iter().all(|f| matches!(*f, "-V" | "--version")))
                || ["list", "show", "freeze", "check", "debug", "inspect", "help"].contains(&op0)
                || (op0 == "config" && matches!(op1, "list" | "get" | "debug")),
            why::SUBCOMMAND,
        ),
        "apt" => ok_if(["list", "show", "search", "policy", "depends", "rdepends", "showsrc", "changelog"].contains(&op0), why::SUBCOMMAND),
        "apt-cache" => ok_if(
            ["show", "search", "policy", "depends", "rdepends", "madison", "showpkg", "showsrc", "stats", "dump", "unmet", "pkgnames"].contains(&op0),
            why::SUBCOMMAND,
        ),
        "dpkg" => ok_if(
            !flags.is_empty()
                && flags.iter().all(|f| {
                    matches!(
                        *f,
                        "-l" | "-L" | "-s" | "-S" | "-p" | "-c" | "-I" | "-C" | "--list" | "--listfiles" | "--status" | "--search" | "--print-avail"
                            | "--contents" | "--info" | "--get-selections" | "--print-architecture" | "--compare-versions" | "--version" | "--audit"
                    )
                }),
            why::OPTION,
        ),
        "rpm" => {
            let query = flags.iter().any(|f| cluster(f).starts_with(['q', 'V']) || matches!(*f, "--query" | "--verify" | "--version" | "--querytags"));
            let change = flags.iter().any(|f| {
                cluster(f).starts_with(['e', 'i', 'U', 'F'])
                    || matches!(*f, "--erase" | "--install" | "--upgrade" | "--freshen" | "--import" | "--rebuilddb" | "--initdb" | "--setperms" | "--setugids")
            });
            ok_if(query && !change, why::OPTION)
        }
        "yum" | "dnf" => ok_if(
            ["list", "info", "search", "repolist", "provides", "whatprovides", "check-update", "deplist", "repoquery"].contains(&op0)
                || (op0 == "history" && matches!(op1, "" | "list" | "info")),
            why::SUBCOMMAND,
        ),
        "apk" => ok_if(["info", "list", "search", "policy", "version", "stats"].contains(&op0), why::SUBCOMMAND),
        "snap" => ok_if(["list", "info", "find", "version", "services", "changes", "connections"].contains(&op0), why::SUBCOMMAND),
        "brew" => ok_if(["list", "ls", "info", "search", "outdated", "config", "doctor", "deps", "leaves", "uses", "desc", "--version"].contains(&op0), why::SUBCOMMAND),
        "zypper" => ok_if(
            ["search", "se", "info", "if", "list-updates", "lu", "repos", "lr", "packages", "pa", "patches", "products", "pd"].contains(&op0),
            why::SUBCOMMAND,
        ),
        "pacman" => ok_if(flags.iter().any(|f| cluster(f).starts_with('Q') || matches!(cluster(f), "Ss" | "Si" | "Sl")), why::OPTION),
        "nginx" => ok_if(flags.iter().any(|f| matches!(*f, "-t" | "-T" | "-v" | "-V")) && !has("-s"), why::OPTION),
        "apachectl" | "apache2ctl" | "httpd" => ok_if(
            !args.is_empty()
                && args.iter().all(|a| matches!(a.as_str(), "configtest" | "-t" | "-S" | "-M" | "-l" | "-L" | "-v" | "-V" | "status" | "fullstatus")),
            why::OPTION,
        ),
        "certbot" => ok_if(op0 == "certificates", why::SUBCOMMAND),
        _ => Err(why::COMMAND),
    }
}

/// `date`：`-s` / `--set` 與「沒有 + 的運算元」（MMDDhhmm 格式）都是改系統時間。
fn date_ok(args: &[String]) -> Result<(), &'static str> {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if matches!(a, "-d" | "--date" | "-r" | "--reference" | "-f" | "--file") {
            i += 2;
            continue;
        }
        if a.starts_with("--set") || (a.starts_with('-') && !a.starts_with("--") && cluster(a).contains('s')) {
            return Err(why::OPTION);
        }
        if !a.starts_with('-') && !a.starts_with('+') {
            return Err(why::OPTION);
        }
        i += 1;
    }
    Ok(())
}

/// `tar`：只放列出內容（`-t` / `--list`），不放建立 / 解開 / 附加。
fn tar_list_only(args: &[String]) -> Result<(), &'static str> {
    let first = args.first().map(String::as_str).unwrap_or("");
    // 舊式寫法 `tar tvf x.tar` 的第一個參數就是選項群。
    let old = if !first.starts_with('-') && first.chars().all(|c| c.is_ascii_alphabetic()) { first } else { "" };
    let clusters: Vec<&str> = std::iter::once(old).chain(args.iter().filter(|a| !a.starts_with("--")).map(|a| cluster(a))).collect();
    let list = clusters.iter().any(|c| c.contains('t')) || args.iter().any(|a| a == "--list");
    let change = clusters.iter().any(|c| c.contains(['c', 'x', 'r', 'u', 'A']))
        || args.iter().any(|a| matches!(a.as_str(), "--create" | "--extract" | "--get" | "--append" | "--update" | "--delete" | "--concatenate"));
    ok_if(list && !change, why::OPTION)
}

/// awk：程式不能呼叫 system()、不能用 `|`（`print | "sh"`、`"cmd" | getline`）、不能 `print > 檔案`；
/// 程式放在檔案裡（`-f`）看不到內容，不放。
fn awk_ok(args: &[String]) -> Result<(), &'static str> {
    let mut i = 0;
    let mut prog: Option<&str> = None;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-f" || a.starts_with("--file") || (a.starts_with("-f") && !a.starts_with("--")) || matches!(a, "-i" | "--include" | "-E" | "--exec" | "-l" | "--load") {
            return Err(why::OPTION);
        }
        if a == "-F" || a == "-v" || a == "--assign" || a == "--field-separator" {
            i += 2;
            continue;
        }
        if a.starts_with('-') && a != "-" && prog.is_none() {
            i += 1;
            continue;
        }
        prog.get_or_insert(a);
        i += 1;
    }
    let p = prog.unwrap_or("");
    let bad = p.contains("system") || p.replace("||", "").contains('|') || AWK_PRINT_TO_FILE_RE.is_match(p) || p.contains("@load") || p.contains("@include");
    ok_if(!bad, why::OPTION)
}

/// sed：不放 `-i`（就地改檔）、`-f`（腳本在檔案裡），以及腳本裡的 `w` / `W` / `e` 命令。
fn sed_ok(args: &[String]) -> Result<(), &'static str> {
    let mut scripts: Vec<&str> = Vec::new();
    let mut first_op: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a.starts_with("--in-place") || a.starts_with("--file") || (a.starts_with('-') && !a.starts_with("--") && cluster(a).contains(['i', 'f'])) {
            return Err(why::OPTION);
        }
        if a == "-e" || a == "--expression" {
            if let Some(s) = args.get(i + 1) {
                scripts.push(s);
            }
            i += 2;
            continue;
        }
        if let Some(s) = a.strip_prefix("--expression=") {
            scripts.push(s);
        } else if !a.starts_with('-') && first_op.is_none() {
            first_op = Some(a);
        }
        i += 1;
    }
    if scripts.is_empty() {
        scripts.extend(first_op);
    }
    ok_if(!scripts.iter().any(|s| SED_EXEC_RE.is_match(s) || SED_SFLAG_RE.is_match(s)), why::OPTION)
}

/// curl：只放 GET / HEAD，不上傳資料、不寫檔（`-o /dev/null` 與 `-o -` 除外）。
fn curl_ok(args: &[String]) -> Result<(), &'static str> {
    let read_method = |m: &str| matches!(m.to_ascii_uppercase().as_str(), "GET" | "HEAD" | "OPTIONS");
    if write_targets("curl", args).iter().any(|t| t != "/dev/null" && t != "-") {
        return Err(why::OPTION);
    }
    for (i, a) in args.iter().enumerate() {
        let a = a.as_str();
        if let Some(long) = a.strip_prefix("--") {
            let name = long.split('=').next().unwrap_or("");
            if name == "request" {
                let m = long.split_once('=').map(|(_, v)| v.to_string()).or_else(|| args.get(i + 1).cloned()).unwrap_or_default();
                if !read_method(&m) {
                    return Err(why::OPTION);
                }
            } else if name.starts_with("data")
                || name.starts_with("form")
                || name.starts_with("remote-name")
                || name.starts_with("trace")
                || matches!(name, "upload-file" | "json" | "config" | "cookie-jar" | "dump-header" | "output-dir" | "create-dirs" | "libcurl" | "stderr")
            {
                return Err(why::OPTION);
            }
            continue;
        }
        let c = cluster(a);
        if c.contains(['d', 'F', 'T', 'K', 'c', 'D', 'O']) {
            return Err(why::OPTION);
        }
        if let Some(pos) = c.find('X') {
            // `-X GET` / `-sX GET`（方法在下一個參數）或 `-XPOST`（黏在後面）。
            let m = if pos + 1 == c.len() && a.len() == c.len() + 1 { args.get(i + 1).cloned().unwrap_or_default() } else { a[pos + 2..].to_string() };
            if !read_method(&m) {
                return Err(why::OPTION);
            }
        }
    }
    Ok(())
}

/// wget：只放 `--spider` 或輸出到 stdout（`-O -` / `-qO-`）；不放送出資料。
fn wget_ok(args: &[String]) -> Result<(), &'static str> {
    if args.iter().any(|a| a.starts_with("--post") || a.starts_with("--method") || a.starts_with("--body") || a.starts_with("--output-file") || a.starts_with("--append-output")) {
        return Err(why::OPTION);
    }
    if args.iter().any(|a| !a.starts_with("--") && (cluster(a).contains(['o', 'a']))) {
        return Err(why::OPTION);
    }
    let stdout = args.iter().enumerate().any(|(i, a)| {
        a == "--output-document=-"
            || (!a.starts_with("--") && a.starts_with('-') && a.ends_with("O-"))
            || ((a == "--output-document" || full_cluster_ends(a, &['O'])) && args.get(i + 1).is_some_and(|n| n == "-"))
    });
    ok_if(stdout || args.iter().any(|a| a == "--spider"), why::OPTION)
}

/// `ip`：物件後面沒有命令、或命令是 show / list / get；`-batch`（從檔案讀命令）不放，`monitor` 會一直等。
fn ip_ok(args: &[String]) -> Result<(), &'static str> {
    let mut pos: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if matches!(a, "-b" | "-batch" | "-force") {
            return Err(why::OPTION);
        }
        if matches!(a, "-n" | "-netns" | "-l" | "-loops" | "-f" | "-family" | "-rc" | "-rcvbuf") {
            i += 2;
            continue;
        }
        if !a.starts_with('-') {
            pos.push(a);
        }
        i += 1;
    }
    match (pos.first().copied(), pos.get(1).copied()) {
        (Some("monitor" | "mon"), _) => Err(why::FOLLOW),
        (_, None) => Ok(()),
        (_, Some(c)) => ok_if(matches!(c, "show" | "list" | "ls" | "lst" | "sh" | "s" | "l" | "get" | "help"), why::SUBCOMMAND),
    }
}

fn git_ok(args: &[String]) -> Result<(), &'static str> {
    let j = skip_opts(args, 0, shell_guard::arg_opts("git"));
    // `git -c core.fsmonitor=… status` / `-c core.sshCommand=…` 會跑任意指令。
    if args[..j.min(args.len())].iter().any(|a| a == "-c" || a.starts_with("--config-env") || a.starts_with("--exec-path")) {
        return Err(why::OPTION);
    }
    let sub = args.get(j).map(String::as_str).unwrap_or("");
    let rest = args.get(j + 1..).unwrap_or(&[]);
    let rsp = split_args(rest);
    let (rf, rops) = (&rsp.flags, &rsp.ops);
    let rop0 = rops.first().copied().unwrap_or("");
    if rf.iter().any(|f| f.starts_with("--output") || *f == "-O" || f.starts_with("--open-files-in-pager") || f.starts_with("--ext-diff")) {
        return Err(why::OPTION);
    }
    let ok = match sub {
        "status" | "log" | "diff" | "show" | "blame" | "annotate" | "shortlog" | "describe" | "rev-parse" | "rev-list" | "ls-files" | "ls-tree"
        | "ls-remote" | "cat-file" | "grep" | "whatchanged" | "name-rev" | "merge-base" | "for-each-ref" | "show-ref" | "show-branch"
        | "count-objects" | "verify-commit" | "verify-tag" | "check-ignore" | "check-attr" | "version" | "help" | "cherry" | "range-diff"
        | "diff-tree" | "diff-index" | "diff-files" | "var" => true,
        "branch" => {
            let change = rf.iter().any(|f| {
                cluster(f).contains(['d', 'D', 'm', 'M', 'c', 'C', 'u', 'f'])
                    || matches!(*f, "--delete" | "--move" | "--copy" | "--force" | "--unset-upstream" | "--edit-description")
                    || f.starts_with("--set-upstream")
            });
            let listing = rops.is_empty()
                || rf.iter().any(|f| *f == "--list" || *f == "-l" || f.starts_with("--contains") || f.starts_with("--merged") || f.starts_with("--no-merged") || f.starts_with("--points-at"));
            !change && listing
        }
        "tag" => {
            let change = rf.iter().any(|f| cluster(f).contains(['d', 'a', 's', 'f', 'm', 'F', 'u', 'e']) || matches!(*f, "--delete" | "--annotate" | "--sign" | "--force"));
            !change && (rops.is_empty() || rf.iter().any(|f| *f == "-l" || *f == "--list"))
        }
        "remote" => rops.is_empty() || matches!(rop0, "show" | "get-url"),
        "config" => {
            let set = rf.iter().any(|f| {
                matches!(*f, "--unset" | "--unset-all" | "--add" | "--replace-all" | "--edit" | "-e" | "--rename-section" | "--remove-section")
            });
            let get = rf.iter().any(|f| matches!(*f, "--get" | "--get-all" | "--get-regexp" | "--get-urlmatch" | "--list" | "-l"));
            !set && (get || rops.len() <= 1)
        }
        "stash" => matches!(rop0, "list" | "show"),
        "worktree" => rop0 == "list",
        "reflog" => rops.is_empty() || rop0 == "show",
        "notes" => rops.is_empty() || matches!(rop0, "list" | "show"),
        "submodule" => rops.is_empty() || matches!(rop0, "status" | "summary"),
        _ => false,
    };
    ok_if(ok, why::SUBCOMMAND)
}

const DOCKER_GLOBAL_OPTS: &[&str] = &["-H", "--host", "-c", "--context", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"];

fn docker_ok(args: &[String]) -> Result<(), &'static str> {
    let j = skip_opts(args, 0, DOCKER_GLOBAL_OPTS);
    let sub = args.get(j).map(String::as_str).unwrap_or("");
    let rest = args.get(j + 1..).unwrap_or(&[]);
    let rsp = split_args(rest);
    let (rf, rops) = (&rsp.flags, &rsp.ops);
    let rop0 = rops.first().copied().unwrap_or("");
    let follow = rf.iter().any(|f| cluster(f).contains('f') || *f == "--follow");
    let in_list = |list: &[&str]| list.contains(&rop0);
    match sub {
        "ps" | "images" | "inspect" | "top" | "port" | "version" | "info" | "history" | "diff" | "search" => Ok(()),
        "logs" => ok_if(!follow, why::FOLLOW),
        "stats" => ok_if(rf.contains(&"--no-stream"), why::FOLLOW),
        "system" => ok_if(in_list(&["df", "info"]), why::SUBCOMMAND),
        "image" => ok_if(in_list(&["ls", "list", "inspect", "history"]), why::SUBCOMMAND),
        "container" => match rop0 {
            "logs" => ok_if(!follow, why::FOLLOW),
            "stats" => ok_if(rf.contains(&"--no-stream"), why::FOLLOW),
            _ => ok_if(in_list(&["ls", "list", "ps", "inspect", "top", "port", "diff"]), why::SUBCOMMAND),
        },
        "volume" | "network" | "context" | "node" | "secret" | "config" | "plugin" => ok_if(in_list(&["ls", "list", "inspect", "show"]), why::SUBCOMMAND),
        "service" => match rop0 {
            "logs" => ok_if(!follow, why::FOLLOW),
            _ => ok_if(in_list(&["ls", "ps", "inspect"]), why::SUBCOMMAND),
        },
        "stack" => ok_if(in_list(&["ls", "ps", "services"]), why::SUBCOMMAND),
        "compose" => compose_ok(rest),
        "buildx" => ok_if(in_list(&["ls", "version", "inspect"]), why::SUBCOMMAND),
        "manifest" => ok_if(rop0 == "inspect", why::SUBCOMMAND),
        _ => Err(why::SUBCOMMAND),
    }
}

/// `docker compose …` / `docker-compose …`。
fn compose_ok(args: &[String]) -> Result<(), &'static str> {
    let j = skip_opts(args, 0, &["-f", "--file", "-p", "--project-name", "--project-directory", "--env-file", "--profile", "--ansi", "--progress"]);
    let sub = args.get(j).map(String::as_str).unwrap_or("");
    let rest = args.get(j + 1..).unwrap_or(&[]);
    let follow = split_args(rest).flags.iter().any(|f| cluster(f).contains('f') || *f == "--follow");
    match sub {
        "logs" => ok_if(!follow, why::FOLLOW),
        "ps" | "config" | "ls" | "images" | "top" | "version" | "port" => Ok(()),
        _ => Err(why::SUBCOMMAND),
    }
}

fn kubectl_ok(args: &[String]) -> Result<(), &'static str> {
    let opts = [
        "-n", "--namespace", "--context", "--kubeconfig", "-s", "--server", "--cluster", "--user", "--token", "--as", "--as-group", "-l",
        "--selector", "-o", "--output",
    ];
    let j = skip_opts(args, 0, &opts);
    let verb = args.get(j).map(String::as_str).unwrap_or("");
    let rest = args.get(j + 1..).unwrap_or(&[]);
    let rsp = split_args(rest);
    let next = rsp.ops.first().copied().unwrap_or("");
    let watch = rsp.flags.iter().any(|f| cluster(f).contains('w') || f.starts_with("--watch"));
    match verb {
        "get" | "events" => ok_if(!watch, why::FOLLOW),
        "describe" | "logs" | "top" | "explain" | "version" | "api-resources" | "api-versions" | "diff" => Ok(()),
        "cluster-info" => ok_if(!rest.iter().any(|a| a.starts_with("--output-directory")), why::OPTION),
        "config" => ok_if(matches!(next, "view" | "get-contexts" | "current-context" | "get-clusters" | "get-users"), why::SUBCOMMAND),
        "auth" => ok_if(matches!(next, "can-i" | "whoami"), why::SUBCOMMAND),
        "rollout" => ok_if(matches!(next, "status" | "history"), why::SUBCOMMAND),
        _ => Err(why::SUBCOMMAND),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(cmd: &str) -> bool {
        read_only_issues(cmd).is_empty()
    }

    #[test]
    fn inspection_commands_pass() {
        for c in [
            "ls -la /var/www",
            "cat /etc/os-release",
            "df -h && free -m",
            "uptime; uname -a",
            "ps aux | grep nginx | head -n 20",
            "ps aux --sort=-%mem | awk 'NR<=10 {print $2, $11}'",
            "systemctl status nginx --no-pager",
            "systemctl",
            "journalctl -u nginx -n 100 --no-pager",
            "tail -n 200 /var/log/syslog",
            "grep -rn ERROR /var/log/app/ | tail -n 50",
            "docker ps -a",
            "docker logs --tail 100 web",
            "docker stats --no-stream",
            "docker compose ps",
            "docker compose logs --tail=50 api",
            "kubectl get pods -n prod -o wide",
            "kubectl -n prod logs deploy/api --tail=100",
            "kubectl config get-contexts",
            "git status && git log --oneline -n 10",
            "git branch -a",
            "git config user.name",
            "git -C /srv/app diff HEAD~1 --stat",
            "ip -br a",
            "ip route get 1.1.1.1",
            "ss -tlnp",
            "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/health",
            "curl -sI https://example.com",
            "curl -X GET http://localhost/api",
            "wget -qO- http://localhost/health",
            "sed -n '1,20p' /etc/nginx/nginx.conf",
            "sed 's/foo/bar/g' a.txt",
            "find /var/log -name '*.log' -mtime -1",
            "du -sh /var/* 2>/dev/null | sort -h | tail",
            "tar tzf backup.tgz",
            "openssl x509 -in cert.pem -noout -dates",
            "date +%F",
            "date -d yesterday +%F",
            "nginx -t",
            "python3 --version",
            "top -b -n 1 | head -n 20",
            "ls > /dev/null 2>&1",
            "echo $(hostname)",
            "for f in /etc/*.conf; do wc -l $f; done",
            "if [ -f /etc/hosts ]; then cat /etc/hosts; fi",
            "diff <(ls a) <(ls b)",
            "timeout 5 curl -s http://x",
            "env LANG=C ls",
            "find . -type f | xargs wc -l",
            "crontab -l",
            "apt list --installed | grep nginx",
            "dpkg -l nginx",
            "rpm -qa | grep kernel",
            "iptables -L -n",
            "cat /etc/passwd | cut -d: -f1",
            "awk -F: '{print $1}' /etc/passwd",
            "",
        ] {
            assert!(ok(c), "{c:?} 應通過：{:?}", read_only_issues(c));
        }
    }

    #[test]
    fn changes_and_escapes_are_rejected() {
        for c in [
            "rm -f /tmp/x",
            "touch x",
            "mkdir -p /opt/x",
            "echo x > /tmp/a",
            "cat a >> b",
            "ls | tee out.txt",
            "sudo cat /etc/shadow",
            "systemctl restart nginx",
            "service nginx restart",
            "kill -9 1234",
            "docker rm -f web",
            "docker exec web ls",
            "docker logs -f web",
            "docker stats",
            "kubectl delete pod x",
            "kubectl get pods -w",
            "kubectl apply -f x.yaml",
            "git pull",
            "git checkout main",
            "git branch new-feature",
            "git -c core.fsmonitor='rm -rf ~' status",
            "git config user.name bob",
            "git diff --output=/tmp/x",
            "sed -i 's/a/b/' f",
            "sed 's/a/b/w /tmp/x' f",
            "sed '1e id' f",
            "find / -name x -delete",
            "find . -exec cat {} \\;",
            "sort -o out.txt in.txt",
            "uniq in.txt out.txt",
            "curl -o /tmp/x https://x",
            "curl -O https://x/a.sh",
            "curl -X POST http://x",
            "curl -XDELETE http://x",
            "curl -d a=b http://x",
            "wget https://x/a.sh",
            "awk 'BEGIN{system(\"id\")}'",
            "awk '{print > \"/tmp/x\"}' f",
            "awk '{print | \"sh\"}' f",
            "awk -f prog.awk f",
            "tar xzf a.tgz",
            "tar czf a.tgz dir",
            "python3 -c 'import os'",
            "node app.js",
            "bash script.sh",
            "sh -c 'rm x'",
            "echo $(rm -rf x)",
            "echo `touch x`",
            "ls >(cat)",
            "mysql -e 'select 1'",
            "redis-cli get k",
            "date -s '2020-01-01'",
            "date 010112002020",
            "hostname newname",
            "ip link set eth0 down",
            "ip monitor",
            "sysctl -w vm.swappiness=10",
            "sysctl vm.swappiness=10",
            "crontab -r",
            "mount /dev/sdb1 /mnt",
            "iptables -F",
            "apt install nginx",
            "pip install x",
            "npm install",
            "openssl req -new -key k.pem",
            "$CMD --flag",
            "./deploy.sh",
            "scp a b:",
            "ssh other-host ls",
            "nc -l 80",
        ] {
            assert!(!ok(c), "{c:?} 不該通過");
        }
    }

    #[test]
    fn issues_name_the_command_and_reason() {
        let v = read_only_issues("ls && rm -f x && echo y > /tmp/z");
        assert_eq!(
            v,
            vec![
                ReadOnlyIssue { word: "rm".into(), why: why::COMMAND },
                ReadOnlyIssue { word: "/tmp/z".into(), why: why::REDIRECT },
            ]
        );
        assert_eq!(read_only_issues("sudo ls")[0], ReadOnlyIssue { word: "sudo".into(), why: why::ROOT });
        assert_eq!(read_only_issues("docker logs -f web")[0].why, why::FOLLOW);
        assert_eq!(read_only_issues("psql -c 'select 1'")[0].why, why::DB_CLI);
        assert_eq!(read_only_issues("git push")[0].why, why::SUBCOMMAND);
        // 同一個問題只列一次。
        assert_eq!(read_only_issues("rm a; rm b").len(), 1);
    }
}
