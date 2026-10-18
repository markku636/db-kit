//! `dbk mcp --ssh`：把 db-kit 存好的 SSH 主機交給 AI 用戶端執行指令（`list_ssh_hosts` / `ssh_run`）。
//!
//! 安全模型與資料庫工具同一套思路——預設唯讀、伺服器旗標是硬上限、守門在撥連線之前：
//! - `--ssh`：唯讀。只放行查看類指令（`ssh::shell_readonly` 白名單）；不在清單上的、寫檔重導向、sudo 都擋。
//! - `--allow-ssh-exec`：可以改系統。分級沿用 App 終端機的守門（`ssh::shell_guard`，與前端 `shellGuard.ts`
//!   由共用案例釘住）：safe 直接跑；confirm 先回原因與一組確認代碼，模型把原因告訴使用者、取得同意後
//!   帶代碼重送同一條指令（代碼綁定主機 + 指令，模型不可能確認一條、執行另一條）；block 一律不給跑。
//! - 互動式指令（vim / top / tail -f…）直接拒絕：exec 通道沒有 PTY，也沒有人在看畫面。
//! - 主機金鑰只信任 known_hosts 裡已記錄的指紋：要不要信任一台新主機，是使用者在 App 裡看過指紋後的決定。
//! - 密碼 / 密語從 keychain 取（與 GUI 同一份）；一次性密碼 / keyboard-interactive 的主機用不了（沒人可問）。
//! - 每次真的執行都寫進 SSH 操作紀錄（來源 `mcp`，指令裡的密碼換成 ***），可在 App 的操作紀錄查。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::dbtools::ToolDef;
use crate::error::AppError;
use crate::ssh::auth::{connect_and_auth, resolve_jump_chain, AuthPrompt, AuthUi, HostKeyDecision, HostKeyQuestion, SshTarget};
use crate::ssh::exec::{self, ExecLimits, ExecOutput};
use crate::ssh::known_hosts::{HostKeyStatus, KnownHostsStore};
use crate::ssh::oplog::{OpEntry, OpLog};
use crate::ssh::redact::redact_secrets;
use crate::ssh::runtime::SshConn;
use crate::ssh::sessions::{self, HostProtocol, SshAuthKind, SshSession, SshSessionsFile};
use crate::ssh::shell_guard::{classify_shell, ShellLevel};
use crate::ssh::shell_readonly::read_only_issues;
use crate::store;

pub const LIST_SSH_HOSTS: &str = "list_ssh_hosts";
pub const SSH_RUN: &str = "ssh_run";

const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 300;
const MAX_COMMAND_CHARS: usize = 16_000;
/// stdout 留頭 4 KB、尾 12 KB（日誌的重點通常在最後）；stderr 頭 2 KB、尾 4 KB。
const LIMITS_STDOUT: (usize, usize) = (4 * 1024, 12 * 1024);
const LIMITS_STDERR: (usize, usize) = (2 * 1024, 4 * 1024);
/// 確認代碼的有效期。
const CONFIRM_TTL: Duration = Duration::from_secs(15 * 60);

pub fn is_tool(name: &str) -> bool {
    matches!(name, LIST_SSH_HOSTS | SSH_RUN)
}

/// 一組待確認的指令：代碼 → 綁定的主機與指令。
struct Pending {
    host_id: String,
    command: String,
    at: Instant,
}

pub struct SshTools {
    /// `--ssh-hosts` 白名單（名稱或 id）；空 = 全部 SSH 主機。
    only: Vec<String>,
    /// `--allow-ssh-exec`。
    exec: bool,
    /// 設定目錄（`ssh_sessions.json` 與 `ssh-oplog/` 所在）；測試可注入。
    dir: Option<PathBuf>,
    known: KnownHostsStore,
    /// 主機 id → 已認證的連線（延遲建立、斷線後重連）。鎖跨越 connect：並發呼叫不會重複撥同一台。
    conns: tokio::sync::Mutex<HashMap<String, Arc<SshConn>>>,
    pending: parking_lot::Mutex<HashMap<String, Pending>>,
    oplog: Option<OpLog>,
}

impl SshTools {
    pub fn new(only: &[String], exec: bool) -> SshTools {
        let dir = store::headless_config_dir().ok();
        Self::with_dir(only, exec, dir, KnownHostsStore::default_path())
    }

    pub fn with_dir(only: &[String], exec: bool, dir: Option<PathBuf>, known: KnownHostsStore) -> SshTools {
        SshTools {
            only: only.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            exec,
            oplog: dir.as_ref().map(|d| OpLog::open(d.join("ssh-oplog"))),
            dir,
            known,
            conns: tokio::sync::Mutex::new(HashMap::new()),
            pending: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    pub fn instructions(&self) -> &'static str {
        if self.exec {
            t!("SSH 主機：先呼叫 list_ssh_hosts，再以 ssh_run 執行指令。有風險的指令會先被擋下並附確認代碼：一定要把指令與原因告訴使用者、取得同意後才帶 confirm_token 重送；不要用互動式指令。")
        } else {
            t!("SSH 主機：先呼叫 list_ssh_hosts，再以 ssh_run 執行查看類指令（唯讀；不能寫檔、刪除、重啟服務或 sudo）。不要用互動式指令。")
        }
    }

    pub fn defs(&self) -> Vec<ToolDef> {
        let run_desc = if self.exec {
            t!("在使用者存在 db-kit 的 SSH 主機上執行 shell 指令，回傳 stdout / stderr / exit code。每條指令都先依 db-kit 終端機的安全規則分級：一般指令直接執行；有風險的（刪除、重啟服務、sudo、寫系統目錄…）不會執行，而是回傳原因與 confirm_token——必須先把指令與原因告訴使用者、取得同意後，才以相同的 host 與 command 加上 confirm_token 重送；極危險的（刪根目錄、格式化磁碟、fork bomb）一律不給執行。沒有終端機畫面、stdin 為空：不要用互動式指令（top 改 top -b -n 1、tail 不要 -f、journalctl 加 --no-pager）。輸出只留頭尾約 16 KB，逾時預設 30 秒。")
        } else {
            t!("在使用者存在 db-kit 的 SSH 主機上執行唯讀（查看類）指令，回傳 stdout / stderr / exit code。只放行 ls、cat、grep、df、ps、systemctl status、journalctl、docker ps、kubectl get 這類查看指令；不能寫檔、刪除、重啟服務或 sudo。沒有終端機畫面、stdin 為空：不要用互動式指令（top 改 top -b -n 1、tail 不要 -f、journalctl 加 --no-pager）。輸出只留頭尾約 16 KB，逾時預設 30 秒。")
        };
        let mut props = json!({
            "host": { "type": "string", "description": t!("SSH 主機名稱（見 list_ssh_hosts）") },
            "command": { "type": "string", "description": t!("要執行的 shell 指令（交給遠端的登入 shell 解譯；可用 && | ; 串接）") },
            "timeout_secs": {
                "type": "integer", "minimum": 1, "maximum": MAX_TIMEOUT_SECS,
                "description": tf!("逾時秒數（預設 {d}，上限 {max}）", d = DEFAULT_TIMEOUT_SECS, max = MAX_TIMEOUT_SECS)
            }
        });
        if self.exec {
            props["confirm_token"] = json!({
                "type": "string",
                "description": t!("前一次 ssh_run 對同一條指令回傳的確認代碼。只有在使用者明確同意執行之後才能帶上。")
            });
        }
        vec![
            ToolDef {
                name: LIST_SSH_HOSTS,
                description: t!("列出可用的 SSH 主機（名稱 / 帳號@主機:埠 / 資料夾 / 跳板機）。ssh_run 的 host 參數用這裡的名稱。").to_string(),
                input_schema: json!({ "type": "object", "properties": {} }),
            },
            ToolDef {
                name: SSH_RUN,
                description: run_desc.to_string(),
                input_schema: json!({ "type": "object", "properties": props, "required": ["host", "command"] }),
            },
        ]
    }

    async fn load(&self) -> Result<SshSessionsFile, String> {
        let dir = self.dir.as_ref().ok_or_else(|| t!("無法取得使用者設定目錄").to_string())?;
        sessions::load_in(dir).await.map_err(|e| e.message())
    }

    /// 可用的 SSH 主機（只讀設定檔，不連線、不碰 keychain）：FTP 主機不算，再套 `--ssh-hosts` 白名單。
    async fn hosts(&self) -> Result<(SshSessionsFile, Vec<SshSession>), String> {
        let file = self.load().await?;
        let list = file
            .sessions
            .iter()
            .filter(|s| s.protocol == HostProtocol::Ssh)
            .filter(|s| self.only.is_empty() || self.only.iter().any(|o| o == &s.name || o == &s.id))
            .cloned()
            .collect();
        Ok((file, list))
    }

    /// 依 `host` 參數找主機：名稱優先、再 id、最後不分大小寫的名稱。
    async fn find(&self, needle: &str) -> Result<(SshSessionsFile, SshSession), String> {
        let (file, list) = self.hosts().await?;
        let found = list
            .iter()
            .find(|s| s.name == needle)
            .or_else(|| list.iter().find(|s| s.id == needle))
            .or_else(|| list.iter().find(|s| s.name.eq_ignore_ascii_case(needle)))
            .cloned();
        match found {
            Some(s) => Ok((file, s)),
            None => {
                let names: Vec<&str> = list.iter().map(|s| s.name.as_str()).collect();
                Err(tf!(
                    "找不到 SSH 主機「{name}」。可用的主機：{list}（可先呼叫 list_ssh_hosts）",
                    name = needle,
                    list = if names.is_empty() { "-".to_string() } else { names.join(", ") }
                ))
            }
        }
    }

    pub async fn list(&self) -> Result<String, String> {
        let (file, list) = self.hosts().await?;
        if list.is_empty() {
            return Ok(t!("（沒有可用的 SSH 主機：請先在 db-kit 的側欄新增 SSH 主機，或檢查 --ssh-hosts 白名單）").to_string());
        }
        let mode = if self.exec { t!("可執行指令（有風險的要先經使用者同意）") } else { t!("唯讀（只放行查看類指令）") };
        let mut out = vec![tf!("SSH 主機（{n} 台，模式：{mode}）。ssh_run 的 host 參數用名稱：", n = list.len(), mode = mode)];
        for s in &list {
            let mut line = format!("- {} · {}@{}:{}", s.name, s.username, s.host, if s.port == 0 { 22 } else { s.port });
            if let Some(f) = s.folder_id.as_deref().and_then(|id| file.folders.iter().find(|f| f.id == id)) {
                line.push_str(&format!(" · {}", tf!("資料夾 {name}", name = f.name)));
            }
            if let Some(j) = s.jump_session_id.as_deref().and_then(|id| file.sessions.iter().find(|x| x.id == id)) {
                line.push_str(&format!(" · {}", tf!("經跳板機 {name}", name = j.name)));
            }
            if s.auth == SshAuthKind::KeyboardInteractive {
                line.push_str(&format!(" · {}", t!("一次性密碼 / 互動式認證（MCP 無法使用）")));
            }
            out.push(line);
        }
        Ok(out.join("\n"))
    }

    /// 執行前的守門（不連線）。Ok = 可以執行。
    fn gate(&self, host_id: &str, command: &str, token: Option<&str>) -> Result<(), String> {
        let v = classify_shell(command);
        if v.interactive {
            return Err(t!("這段指令會停下來等人輸入（互動式），ssh_run 沒有終端機畫面可用。請改用非互動的寫法，例如 top -b -n 1、tail -n 100（不要 -f）、journalctl --no-pager -n 100、mysql -e \"…\"、apt-get -y …。").to_string());
        }
        if !self.exec {
            let mut lines: Vec<String> = read_only_issues(command)
                .into_iter()
                .map(|i| {
                    let why = crate::i18n::lookup(i.why);
                    if i.word.is_empty() { format!("- {why}") } else { format!("- {}", tf!("{word}：{why}", word = i.word, why = why)) }
                })
                .collect();
            if lines.is_empty() && v.level != ShellLevel::Safe {
                lines.extend(v.reason_texts().into_iter().map(|r| format!("- {r}")));
            }
            if lines.is_empty() {
                return Ok(());
            }
            return Err(format!(
                "{}\n{}\n{}",
                t!("這個 MCP 伺服器的 SSH 是唯讀模式，只能執行查看類指令。這段指令有："),
                lines.join("\n"),
                t!("要執行會變更系統的指令，請使用者在 db-kit 的 MCP 設定勾選「允許 AI 執行會變更系統的指令」（--allow-ssh-exec）。")
            ));
        }
        let reasons = v.reason_texts().join(t!("、"));
        match v.level {
            ShellLevel::Safe => Ok(()),
            ShellLevel::Block => Err(tf!(
                "這段指令不允許透過 AI 執行：{reasons}。如果真的需要，請使用者自己在 db-kit 的終端機輸入。",
                reasons = reasons
            )),
            ShellLevel::Confirm => match token.map(str::trim).filter(|t| !t.is_empty()) {
                Some(t) => self.take_token(t, host_id, command),
                None => {
                    let tok = self.issue_token(host_id, command);
                    Err(tf!(
                        "這段指令需要使用者同意才會執行：{reasons}。請先把指令與原因告訴使用者；使用者同意後，以相同的 host 與 command 加上 confirm_token: \"{token}\" 再呼叫一次 ssh_run（15 分鐘內有效、只能用一次）。",
                        reasons = reasons,
                        token = tok
                    ))
                }
            },
        }
    }

    fn issue_token(&self, host_id: &str, command: &str) -> String {
        let tok: String = uuid::Uuid::new_v4().simple().to_string().chars().take(12).collect();
        let mut g = self.pending.lock();
        g.retain(|_, p| p.at.elapsed() < CONFIRM_TTL);
        g.insert(tok.clone(), Pending { host_id: host_id.to_string(), command: command.to_string(), at: Instant::now() });
        tok
    }

    /// 用掉一組確認代碼（不論對不對都作廢：猜錯也不能再試同一組）。
    fn take_token(&self, tok: &str, host_id: &str, command: &str) -> Result<(), String> {
        let p = self.pending.lock().remove(tok);
        match p {
            Some(p) if p.at.elapsed() < CONFIRM_TTL => {
                if p.host_id == host_id && p.command == command {
                    Ok(())
                } else {
                    Err(t!("確認代碼對應的是另一條指令或另一台主機（指令有改動時要重新取得代碼）；請不帶 confirm_token 重新呼叫 ssh_run。").to_string())
                }
            }
            _ => Err(t!("確認代碼不存在、已用過或已逾時（15 分鐘）；請不帶 confirm_token 重新呼叫 ssh_run 取得新的代碼。").to_string()),
        }
    }

    pub async fn run(&self, args: &Value) -> Result<String, String> {
        let host = args
            .get("host")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| t!("缺少 host：請先呼叫 list_ssh_hosts，再以 host 參數指定主機名稱").to_string())?;
        let command = args.get("command").and_then(|v| v.as_str()).map(|s| s.trim_end_matches(['\r', '\n'])).unwrap_or("");
        if command.trim().is_empty() {
            return Err(t!("缺少 command：要執行的指令").to_string());
        }
        if command.chars().count() > MAX_COMMAND_CHARS {
            return Err(tf!("指令太長（上限 {n} 字）；請拆成幾次執行", n = MAX_COMMAND_CHARS));
        }
        let timeout = args.get("timeout_secs").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(1, MAX_TIMEOUT_SECS);
        let (file, s) = self.find(host).await?;
        if s.auth == SshAuthKind::KeyboardInteractive {
            return Err(t!("這台主機用一次性密碼 / 互動式認證登入，MCP 沒辦法代為輸入；請改用密碼（存在 db-kit）、私鑰或 ssh-agent。").to_string());
        }
        self.gate(&s.id, command, args.get("confirm_token").and_then(|v| v.as_str()))?;

        let limits = ExecLimits { timeout: Duration::from_secs(timeout), stdout: LIMITS_STDOUT, stderr: LIMITS_STDERR };
        let conn = self.conn(&file, &s).await?;
        let mut r = exec::run(&conn.handle, command, limits).await;
        if r.is_err() && conn.closed.borrow().is_some() {
            // 快取的連線剛好斷了（伺服器重開、閒置被踢）：重連一次再試。
            self.conns.lock().await.remove(&s.id);
            let conn = self.conn(&file, &s).await?;
            r = exec::run(&conn.handle, command, limits).await;
        }
        self.log(&s, &conn, command, &r).await;
        let out = r.map_err(|e| e.message())?;
        Ok(format_output(&s, command, &out, timeout))
    }

    /// 取得（必要時建立）這台主機的連線。
    async fn conn(&self, file: &SshSessionsFile, s: &SshSession) -> Result<Arc<SshConn>, String> {
        let mut g = self.conns.lock().await;
        if let Some(c) = g.get(&s.id) {
            if c.closed.borrow().is_none() {
                return Ok(c.clone());
            }
            g.remove(&s.id);
        }
        let secrets = |id: &str| {
            (store::kc_get(&sessions::session_password_account(id)), store::kc_get(&sessions::session_passphrase_account(id)))
        };
        let (pw, pp) = secrets(&s.id);
        let mut t = SshTarget::from_session(s, pw, pp);
        t.jump = resolve_jump_chain(file, &s.id, s.jump_session_id.as_deref(), secrets).map_err(|e| e.message())?;
        let ui = Arc::new(KnownOnlyUi::default());
        let conn_id = format!("mcp-{}", s.id);
        let c = connect_and_auth(&t, &conn_id, ui.clone(), self.known.clone()).await.map_err(|e| explain_connect_error(&e, &ui))?;
        let conn = Arc::new(SshConn::new(conn_id, &t, c));
        g.insert(s.id.clone(), conn.clone());
        Ok(conn)
    }

    /// 寫進 SSH 操作紀錄（關掉時什麼都不做；寫不進去只記 stderr，不影響工具結果）。
    async fn log(&self, s: &SshSession, conn: &SshConn, command: &str, r: &Result<ExecOutput, AppError>) {
        let Some(log) = &self.oplog else { return };
        let (result, message) = match r {
            Ok(o) => {
                let fine = !o.timed_out && o.exit_signal.is_none() && o.exit_status.unwrap_or(0) == 0;
                (if fine { "ok" } else { "error" }, Some(status_line(o, 0)))
            }
            Err(e) => ("error", Some(e.message())),
        };
        let e = OpEntry {
            ts: chrono::Local::now().timestamp_millis(),
            kind: "command".into(),
            proto: "ssh".into(),
            conn_id: conn.id.clone(),
            host: conn.info.host.clone(),
            port: conn.info.port,
            user: conn.info.username.clone(),
            session_id: Some(s.id.clone()),
            detail: redact_secrets(command),
            target: None,
            cwd: None,
            source: Some("mcp".into()),
            result: result.into(),
            message,
        };
        if let Err(err) = log.append(e).await {
            eprintln!("[dbk mcp] {}", tf!("寫入 SSH 操作紀錄失敗：{e}", e = err.message()));
        }
    }

    /// 收尾：斷開所有連線。
    pub async fn shutdown(&self) {
        let all: Vec<Arc<SshConn>> = self.conns.lock().await.drain().map(|(_, c)| c).collect();
        for c in all {
            let _ = c.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
        }
    }
}

/// 不發問、也不替使用者信任新主機：只有 known_hosts 裡已記錄的指紋放行（`Known` 不會走到這裡）。
#[derive(Default)]
struct KnownOnlyUi {
    asked: parking_lot::Mutex<Option<HostKeyQuestion>>,
}

#[async_trait]
impl AuthUi for KnownOnlyUi {
    async fn host_key(&self, q: HostKeyQuestion) -> HostKeyDecision {
        *self.asked.lock() = Some(q);
        HostKeyDecision::Reject
    }

    async fn prompt(&self, _q: AuthPrompt) -> Option<Vec<String>> {
        None
    }

    fn can_prompt(&self) -> bool {
        false
    }
}

/// 連線錯誤 → 給模型（與使用者）看得懂、知道下一步的訊息。
fn explain_connect_error(e: &AppError, ui: &KnownOnlyUi) -> String {
    if let Some(q) = ui.asked.lock().take() {
        match q.status {
            HostKeyStatus::New => {
                return tf!(
                    "{host} 的主機金鑰還沒被信任過（{kind} {fp}）。MCP 不會替使用者信任新主機：請使用者先在 db-kit 開一次這台主機的終端機、確認指紋後再試。",
                    host = q.host_id,
                    kind = q.key_type,
                    fp = q.fingerprint
                )
            }
            HostKeyStatus::Changed { .. } => {
                return tf!(
                    "{host} 的主機金鑰與記錄的指紋不同（現在是 {fp}），可能是主機重灌或遭中間人攻擊，已拒絕連線。請使用者在 db-kit 開這台主機的終端機確認。",
                    host = q.host_id,
                    fp = q.fingerprint
                )
            }
            HostKeyStatus::Known => {}
        }
    }
    let msg = e.message();
    if matches!(e, AppError::SshAuth(_)) {
        return format!("{msg}\n{}", t!("MCP 無法詢問密碼：請在 db-kit 的主機設定存好密碼（或私鑰密語），或改用私鑰 / ssh-agent。"));
    }
    msg
}

/// `exit 0 · 0.42 s` / 被訊號中斷 / 逾時。`timeout` 為 0 時不提逾時秒數。
fn status_line(o: &ExecOutput, timeout: u64) -> String {
    let secs = format!("{:.2} s", o.elapsed.as_secs_f64());
    if o.timed_out {
        return if timeout > 0 {
            tf!("逾時（{n} 秒）已中斷，遠端程序可能仍在執行", n = timeout)
        } else {
            t!("逾時已中斷").to_string()
        };
    }
    match (&o.exit_signal, o.exit_status) {
        (Some(sig), _) => tf!("被訊號中斷：{sig} · {secs}", sig = sig, secs = secs),
        (None, Some(code)) => format!("exit {code} · {secs}"),
        (None, None) => tf!("沒有回報結束碼 · {secs}", secs = secs),
    }
}

fn format_output(s: &SshSession, command: &str, o: &ExecOutput, timeout: u64) -> String {
    let shown: String = if command.chars().count() > 300 { format!("{}…", command.chars().take(300).collect::<String>()) } else { command.to_string() };
    let port = if s.port == 0 { 22 } else { s.port };
    let mut out = vec![format!("{} ({}@{}:{}) $ {}", s.name, s.username, s.host, port, shown), status_line(o, timeout)];
    for (label, c) in [("stdout", &o.stdout), ("stderr", &o.stderr)] {
        if !c.is_empty() {
            out.push(format!("--- {label} ---"));
            out.push(c.render().trim_end_matches(['\n', '\r']).to_string());
        }
    }
    if o.stdout.is_empty() && o.stderr.is_empty() {
        out.push(t!("（沒有輸出）").to_string());
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::sessions::{SshFolder, SshTermOptions};

    fn session(id: &str, name: &str, auth: SshAuthKind) -> SshSession {
        SshSession {
            id: id.into(),
            name: name.into(),
            host: "127.0.0.1".into(),
            port: 1,
            username: "deploy".into(),
            auth,
            private_key_path: String::new(),
            certificate_path: String::new(),
            jump_session_id: None,
            folder_id: None,
            options: SshTermOptions { connect_timeout_secs: 2, ..Default::default() },
            protocol: HostProtocol::Ssh,
            ftp: Default::default(),
        }
    }

    /// 臨時設定目錄 + 三台主機（一台 FTP、一台 OTP）。
    async fn tools(only: &[&str], exec: bool) -> (SshTools, PathBuf) {
        let dir = std::env::temp_dir().join(format!("dbkit-mcp-ssh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut web = session("id-web", "web1", SshAuthKind::Password);
        web.folder_id = Some("f1".into());
        web.jump_session_id = Some("id-otp".into());
        let otp = session("id-otp", "bastion", SshAuthKind::KeyboardInteractive);
        let mut ftp = session("id-ftp", "files", SshAuthKind::Password);
        ftp.protocol = HostProtocol::Ftp;
        sessions::import_in(&dir, vec![SshFolder { id: "f1".into(), name: "prod".into(), parent_id: None }], vec![web, otp, ftp]).await.unwrap();
        let only: Vec<String> = only.iter().map(|s| s.to_string()).collect();
        let t = SshTools::with_dir(&only, exec, Some(dir.clone()), KnownHostsStore::at(dir.join("kh.json")));
        (t, dir)
    }

    #[tokio::test]
    async fn list_skips_ftp_and_marks_otp_hosts() {
        let (t, dir) = tools(&[], false).await;
        let s = t.list().await.unwrap();
        assert!(s.contains("web1") && s.contains("bastion"), "{s}");
        assert!(!s.contains("files"), "{s}");
        assert!(s.contains("prod"), "{s}"); // 資料夾名稱
        let (t2, _) = tools(&["bastion"], false).await;
        let s2 = t2.list().await.unwrap();
        assert!(s2.contains("bastion") && !s2.contains("web1"), "{s2}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn gate_runs_before_connecting() {
        let (ro, dir) = tools(&[], false).await;
        // 唯讀模式：寫入 / 刪除在連線前就擋（主機的 port 1 連不上，錯誤若是連線失敗就代表守門太晚）。
        for cmd in ["rm -rf /tmp/x", "echo x > /etc/hosts", "systemctl restart nginx", "sudo ls"] {
            let e = ro.run(&json!({ "host": "web1", "command": cmd })).await.unwrap_err();
            assert!(e.contains("--allow-ssh-exec"), "{cmd}: {e}");
        }
        // 互動式在兩種模式都擋。
        let e = ro.run(&json!({ "host": "web1", "command": "top" })).await.unwrap_err();
        assert!(e.contains("top -b -n 1"), "{e}");
        // 找不到主機 / FTP 主機不算 / 缺參數。
        let e = ro.run(&json!({ "host": "files", "command": "ls" })).await.unwrap_err();
        assert!(e.contains("list_ssh_hosts"), "{e}");
        assert!(ro.run(&json!({ "command": "ls" })).await.unwrap_err().contains("host"));
        assert!(ro.run(&json!({ "host": "web1", "command": "  " })).await.unwrap_err().contains("command"));
        // OTP 主機：明講用不了。
        let e = ro.run(&json!({ "host": "bastion", "command": "ls" })).await.unwrap_err();
        assert!(e.contains("ssh-agent"), "{e}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn exec_mode_confirm_token_is_bound_and_single_use() {
        let (t, dir) = tools(&[], true).await;
        // block：沒有代碼可拿。
        let e = t.run(&json!({ "host": "web1", "command": "rm -rf /" })).await.unwrap_err();
        assert!(!e.contains("confirm_token"), "{e}");
        // confirm：回原因與代碼。
        let e = t.run(&json!({ "host": "web1", "command": "systemctl restart nginx" })).await.unwrap_err();
        let tok = e.split('"').nth(1).unwrap_or_default().to_string();
        assert_eq!(tok.len(), 12, "{e}");
        // 拿 A 指令的代碼去跑 B 指令：拒絕，而且代碼作廢。
        let e = t.run(&json!({ "host": "web1", "command": "systemctl stop nginx", "confirm_token": tok })).await.unwrap_err();
        assert!(e.contains("另一條指令"), "{e}");
        let e = t.run(&json!({ "host": "web1", "command": "systemctl restart nginx", "confirm_token": tok })).await.unwrap_err();
        assert!(e.contains("已用過"), "{e}");
        // 正確的代碼：過了守門、走到連線（port 1 連不上 → 連線錯誤，不再是守門錯誤）。
        let e = t.run(&json!({ "host": "web1", "command": "systemctl restart nginx" })).await.unwrap_err();
        let tok = e.split('"').nth(1).unwrap_or_default().to_string();
        let e = t.run(&json!({ "host": "web1", "command": "systemctl restart nginx", "confirm_token": tok })).await.unwrap_err();
        assert!(!e.contains("confirm_token") && !e.contains("同意"), "{e}");
        // safe 指令直接往連線走。
        let e = t.run(&json!({ "host": "web1", "command": "touch /tmp/x" })).await.unwrap_err();
        assert!(!e.contains("--allow-ssh-exec") && !e.contains("confirm_token"), "{e}");
        let _ = std::fs::remove_dir_all(dir);
    }

    // ---- 端到端：行程內的 russh 測試伺服器（不需要 Docker）----

    use russh::keys::ssh_key::{Algorithm, HashAlg, LineEnding, PrivateKey};
    use russh::server::{Auth, Msg, Session};
    use russh::{Channel, ChannelId};

    struct FakeSshd;

    impl russh::server::Handler for FakeSshd {
        type Error = russh::Error;

        async fn auth_publickey(&mut self, _user: &str, _key: &russh::keys::PublicKey) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn exec_request(&mut self, ch: ChannelId, data: &[u8], s: &mut Session) -> Result<(), Self::Error> {
            let cmd = String::from_utf8_lossy(data).to_string();
            s.channel_success(ch)?;
            let code = match cmd.as_str() {
                "sleep 30" => return Ok(()), // 永遠不回：測逾時
                "cat /var/log/big.log" => {
                    s.data(ch, vec![b'x'; 100_000])?;
                    0
                }
                "false" => 1,
                _ => {
                    s.data(ch, format!("ran: {cmd}\n").into_bytes())?;
                    s.extended_data(ch, 1, b"warn\n".to_vec())?;
                    0
                }
            };
            s.exit_status_request(ch, code)?;
            s.eof(ch)?;
            s.close(ch)?;
            Ok(())
        }
    }

    /// 起一個只收公鑰（任何金鑰都收）的 SSH 伺服器；回傳 port 與主機金鑰指紋。
    async fn fake_sshd() -> (u16, String) {
        let key = PrivateKey::random(&mut rand010::rng(), Algorithm::Ed25519).unwrap();
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            auth_rejection_time: Duration::from_millis(10),
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((sock, _)) = listener.accept().await {
                let cfg = config.clone();
                tokio::spawn(async move {
                    if let Ok(s) = russh::server::run_stream(cfg, sock, FakeSshd).await {
                        let _ = s.await;
                    }
                });
            }
        });
        (port, fp)
    }

    #[tokio::test]
    async fn end_to_end_against_an_in_process_server() {
        let (port, fp) = fake_sshd().await;
        let dir = std::env::temp_dir().join(format!("dbkit-mcp-ssh-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let client_key = PrivateKey::random(&mut rand010::rng(), Algorithm::Ed25519).unwrap();
        let key_path = dir.join("id_ed25519");
        std::fs::write(&key_path, client_key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
        let mut s = session("id-e2e", "lab", SshAuthKind::Key);
        s.port = port;
        s.private_key_path = key_path.display().to_string();
        sessions::import_in(&dir, vec![], vec![s]).await.unwrap();
        let kh = dir.join("kh.json");
        let t = SshTools::with_dir(&[], false, Some(dir.clone()), KnownHostsStore::at(kh.clone()));
        let run = |cmd: &str| json!({ "host": "lab", "command": cmd });

        // 新主機：不自動信任，訊息帶指紋、指路到 App。
        let e = t.run(&run("echo hi")).await.unwrap_err();
        assert!(e.contains(&fp) && e.contains("db-kit"), "{e}");
        assert!(!kh.exists(), "MCP 不該寫入 known_hosts");

        // 使用者在 App 裡信任過之後（這裡直接寫 known_hosts）。
        std::fs::write(&kh, serde_json::to_vec(&json!({ format!("127.0.0.1:{port}"): fp })).unwrap()).unwrap();
        let out = t.run(&run("echo hi")).await.unwrap();
        assert!(out.contains("lab (deploy@127.0.0.1:") && out.contains("$ echo hi"), "{out}");
        assert!(out.contains("exit 0") && out.contains("ran: echo hi") && out.contains("--- stderr ---\nwarn"), "{out}");

        // 非零結束碼照常回結果（不是工具錯誤），模型自己讀 exit。
        assert!(t.run(&run("false")).await.unwrap().contains("exit 1"));
        // 大量輸出只留頭尾。
        let big = t.run(&run("cat /var/log/big.log")).await.unwrap();
        assert!(big.len() < 20_000 && big.contains("…"), "{}", &big[..200]);
        // 逾時：中斷並明講。
        let slow = t.run(&json!({ "host": "lab", "command": "sleep 30", "timeout_secs": 1 })).await.unwrap();
        assert!(slow.contains("1"), "{slow}");
        assert!(slow.contains("逾時") || slow.to_lowercase().contains("timed out"), "{slow}");

        // 操作紀錄：來源 mcp、結果依 exit code。
        t.shutdown().await;
        let logs: Vec<OpEntry> = std::fs::read_dir(dir.join("ssh-oplog"))
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
            .flat_map(|e| std::fs::read_to_string(e.path()).unwrap().lines().map(|l| serde_json::from_str::<OpEntry>(l).unwrap()).collect::<Vec<_>>())
            .collect();
        assert_eq!(logs.len(), 4, "{logs:?}");
        assert!(logs.iter().all(|e| e.source.as_deref() == Some("mcp") && e.kind == "command" && e.session_id.as_deref() == Some("id-e2e")));
        assert_eq!(logs.iter().find(|e| e.detail == "false").unwrap().result, "error");
        assert_eq!(logs.iter().find(|e| e.detail == "echo hi").unwrap().result, "ok");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn defs_follow_the_mode() {
        let ro = SshTools::with_dir(&[], false, None, KnownHostsStore::at(std::env::temp_dir().join("x.json")));
        let d = ro.defs();
        assert_eq!(d.iter().map(|d| d.name).collect::<Vec<_>>(), [LIST_SSH_HOSTS, SSH_RUN]);
        assert!(d[1].input_schema["properties"].get("confirm_token").is_none());
        let ex = SshTools::with_dir(&[], true, None, KnownHostsStore::at(std::env::temp_dir().join("x.json")));
        assert!(ex.defs()[1].input_schema["properties"]["confirm_token"].is_object());
    }
}
