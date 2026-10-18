//! 指令裡的密碼遮罩：把看起來是密碼的部分換成 `***`——前端 `src/sshOpLog.ts::redactSecrets` 的 Rust 版。
//!
//! 終端機的指令紀錄由前端先遮再送來；`dbk mcp` 的 `ssh_run` 沒有前端，寫進 SSH 操作紀錄前在這裡遮。
//! 兩份實作由 `tests/fixtures/secret-redact-cases.json` 釘住。寧可多遮：遮錯一個值頂多看不到，漏遮就是密碼外流。
//!
//! Rust `regex` 沒有 lookahead：TS 版的 `(?!-)VALUE`（值不能以 `-` 開頭，那是下一個選項）改寫成
//! 第一個字元排除 `-` 的 `VALUE_NODASH`；`(?!\/\/)`（`-u` 的值不是網址）改寫成「開頭不是 `//`」。

use once_cell::sync::Lazy;
use regex::Regex;

const MASK: &str = "***";

struct Rule {
    re: Regex,
    to: &'static str,
}

static RULES: Lazy<Vec<Rule>> = Lazy::new(|| {
    let value = r#"(?:"[^"]*"|'[^']*'|[^\s"'&;|]+)"#;
    let value_nodash = r#"(?:"[^"]*"|'[^']*'|[^\s"'&;|\-][^\s"'&;|]*)"#;
    let long = "(?:password|passwd|passphrase|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credentials?)";
    let short = "(?:pass|pwd|pw)";
    let name = format!(r"(?:[A-Za-z0-9_.-]*{long}|(?:[A-Za-z0-9_.-]*[_.-])?{short})");
    let same_cmd = r"[^;&|\n]*?";
    let rule = |re: &str, to: &'static str| Rule { re: Regex::new(re).unwrap(), to };
    // 順序有關係：認得特定工具的寫法先套，最後才是通用的「名稱像密碼的選項」。
    vec![
        // 網址裡的帳密：scheme://user:pass@host（帳號可以是空的，例如 redis://:pass@host）。
        rule(r"(?i)\b([a-z][a-z0-9+.-]{0,31}://[^\s:@/]{0,256}):([^\s@/]{1,512})@", "${1}:***@"),
        // HTTP 認證標頭。
        rule(r#"(?i)\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic|token|digest|negotiate)?\s*)([^\s'"]+)"#, "${1}***"),
        rule(r#"(?i)\b((?:x-api-key|api-key|private-token|x-auth-token|x-access-token)\s*:\s*)([^\s'"]+)"#, "${1}***"),
        // JSON：{"password":"abc"}
        rule(&format!(r#"(?i)("{name}"\s*:\s*)"[^"]*""#), "${1}\"***\""),
        // MySQL 家族的 -p密碼（黏在一起；-P 是 port、單獨的 -p 是「等一下問我」，都不動）。
        rule(
            &format!(r"(\b(?:mysql|mysqldump|mariadb|mariadb-dump|mysqladmin|mysqlimport|mysqlcheck|mysqlshow|mysqlpump|mysqlsh)\b{same_cmd}\s-p){value}"),
            "${1}***",
        ),
        // sshpass -p x / -px、redis-cli -a x、mongo -p x、docker login -p x。
        rule(&format!(r"(\bsshpass\b{same_cmd}\s-p)\s*{value_nodash}"), "${1} ***"),
        rule(&format!(r"(\bredis-cli\b{same_cmd}\s-a)\s+{value_nodash}"), "${1} ***"),
        rule(&format!(r"(\b(?:mongo|mongosh|mongodump|mongorestore|mongoexport|mongoimport)\b{same_cmd}\s-p)\s+{value_nodash}"), "${1} ***"),
        rule(&format!(r"(\b(?:docker|podman|nerdctl|buildah)\s+login\b{same_cmd}\s-p)\s*{value_nodash}"), "${1} ***"),
        // curl / wget 的 -u user:pass（值是網址的不算，例如 redis-cli -u redis://…）。
        rule(r"(\s(?:-u|--user|-U|--proxy-user)\s+)([^\s:]+):((?:[^\s/]|/[^\s/])\S*)", "${1}${2}:***"),
        // htpasswd -b 檔案 帳號 密碼。
        rule(r"(\bhtpasswd\s+(?:-\S+\s+)*-[A-Za-z0-9_]*b[A-Za-z0-9_]*\s+(?:-\S+\s+)*\S+\s+\S+\s+)(\S+)", "${1}***"),
        // openssl 的 -passin / -passout / -pass pass:密碼。
        rule(&format!(r"(\s-pass(?:in|out)?\s+pass:){value}"), "${1}***"),
        // echo 密碼 | sudo -S / passwd --stdin / chpasswd / --password-stdin。
        rule(
            r#"(\b(?:echo|printf)\s+(?:-[a-z]+\s+)*)("[^"]*"|'[^']*'|\S+)(\s*\|\s*(?:sudo\b[^|;&\n]*\s-S\b|passwd\b|chpasswd\b|sshpass\b|[^|;&\n]*--password-stdin))"#,
            "${1}***${3}",
        ),
        // name=value：--password=x、PGPASSWORD=x、MYSQL_PWD=x、-d 'user=a&password=b'、--from-literal=password=x。
        rule(&format!(r#"(?i)(^|[\s"'&;(?=,])(-{{0,2}}{name})=({value})"#), "${1}${2}=***"),
        // 選項後面空一格接值：--password x、-storepass x。值以 - 開頭的是下一個選項，不動。
        rule(
            &format!(r"(?i)(^|\s)(--[A-Za-z0-9_-]*(?:{long}|pass|pwd)|-(?:[A-Za-z0-9_-]{{2,}})?(?:{long}|pass|pwd))\s+({value_nodash})"),
            "${1}${2} ***",
        ),
        // 長得就是金鑰的字串（GitHub / GitLab / Slack / OpenAI / Anthropic / AWS）。
        rule(
            r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b",
            MASK,
        ),
    ]
});

/// 把一行（或多行）文字裡看起來是密碼的部分換成 `***`。
pub fn redact_secrets(text: &str) -> String {
    text.split('\n').map(redact_line).collect::<Vec<_>>().join("\n")
}

fn redact_line(line: &str) -> String {
    let mut out = line.to_string();
    for r in RULES.iter() {
        out = r.re.replace_all(&out, r.to).into_owned();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 共用案例：前端 `sshOpLog.test.ts` 跑的是同一份檔案。
    #[test]
    fn shared_cases() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/secret-redact-cases.json");
        let f: serde_json::Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
        let mut bad = Vec::new();
        for c in f["cases"].as_array().unwrap() {
            let (input, want) = (c["input"].as_str().unwrap(), c["output"].as_str().unwrap());
            let got = redact_secrets(input);
            if got != want {
                bad.push(format!("{input:?}\n  got  {got:?}\n  want {want:?}"));
            }
        }
        assert!(bad.is_empty(), "{} 條與前端不一致：\n{}", bad.len(), bad.join("\n"));
    }

    #[test]
    fn long_lines_stay_fast() {
        let s = format!("{} password", "a=b ".repeat(20_000));
        let t0 = std::time::Instant::now();
        redact_secrets(&s);
        assert!(t0.elapsed() < std::time::Duration::from_secs(2));
    }
}
