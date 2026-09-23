//! 幫使用者把 CLI 供應商（claude / codex）裝起來、登入：官方安裝指令，
//! 以及「開一個看得見的終端機視窗去跑」。Tauri 指令在 `agent.rs`（它才有 `resolve_bin`），這裡只有純邏輯 + spawn。
//!
//! 設計取捨：
//! - 開**看得見的**終端機，而不是在背景默默跑：安裝腳本是從網路抓下來執行的，讓使用者親眼看到
//!   跑了什麼、跑到哪、有沒有錯，比轉圈圈誠實；登入（`claude` 首次啟動 / `codex login`）本來就是
//!   互動式的（要開瀏覽器、要按鍵），背景根本跑不了。
//! - 指令一律在這裡寫死、由後端決定，前端只傳「哪個供應商、裝還是登入」——
//!   這支 Tauri 指令不能變成任意指令執行的入口。
//! - 面板上顯示的指令就是終端機實際跑的那一行（同一個來源），使用者自己複製去跑也一樣。

use std::io;
use std::path::Path;
use std::process::Command;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// 官方安裝指令（見 code.claude.com/docs/en/setup）。Windows 是 PowerShell 語法，其餘是 sh。
/// API 供應商與不認得的 id 回 `None`。
pub fn install_command(provider: &str, os: Os) -> Option<&'static str> {
    match (provider, os) {
        ("claude", Os::Windows) => Some("irm https://claude.ai/install.ps1 | iex"),
        ("claude", _) => Some("curl -fsSL https://claude.ai/install.sh | bash"),
        ("codex", _) => Some("npm i -g @openai/codex"),
        _ => None,
    }
}

/// 登入指令：用**解析到的絕對路徑**呼叫，因為剛裝好時新開的終端機繼承的是 App 啟動當下的 PATH，
/// 多半還找不到 `claude`。Claude 沒有獨立的登入子指令，首次啟動就會帶使用者走瀏覽器登入。
pub fn login_command(provider: &str, bin: &str, os: Os) -> Option<String> {
    let exe = match os {
        Os::Windows => format!("& {}", ps_quote(bin)),
        _ => sh_quote(bin),
    };
    match provider {
        "claude" => Some(exe),
        "codex" => Some(format!("{exe} login")),
        _ => None,
    }
}

/// PowerShell 單引號字串：內部的 `'` 寫成 `''`，其餘字元（含 `$`、反引號）一律照字面。
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// POSIX sh 單引號字串：內部的 `'` 寫成 `'\''`。
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// 終端機裡實際跑的腳本：先印出要跑的指令（讓使用者知道發生什麼事），跑完印一行提示。
/// 不管成功失敗都不自動關窗 —— 錯誤訊息要留給使用者看。
pub fn terminal_script(command: &str, done_msg: &str, os: Os) -> String {
    match os {
        // 先從登錄檔重讀 PATH：使用者可能是看到提示後才去裝 Node（npm），
        // 而新視窗繼承的是 App 啟動當下的舊 PATH。
        Os::Windows => format!(
            "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + \
             [Environment]::GetEnvironmentVariable('Path','User'); \
             Write-Host {echo}; {command}; Write-Host ''; Write-Host {done}",
            echo = ps_quote(&format!("> {command}")),
            done = ps_quote(done_msg),
        ),
        // 最後換成互動 shell，視窗才不會一跑完就被終端機關掉。
        Os::Mac | Os::Linux => format!(
            "echo {echo}; {command}; echo; echo {done}; exec \"${{SHELL:-/bin/bash}}\"",
            echo = sh_quote(&format!("$ {command}")),
            done = sh_quote(done_msg),
        ),
    }
}

/// 一種開終端機的方式。
#[derive(Debug, PartialEq, Eq)]
pub struct Launch {
    pub program: &'static str,
    pub args: Vec<String>,
}

/// Linux 沒有「預設終端機」這回事：依序試常見的幾支，第一支 spawn 得起來的就用它。
/// 第二欄是「後面接要執行的指令」的旗標，各家不同。
const LINUX_TERMINALS: &[(&str, &str)] = &[
    ("x-terminal-emulator", "-e"),
    ("gnome-terminal", "--"),
    ("konsole", "-e"),
    ("xfce4-terminal", "-x"),
    ("kgx", "--"),
    ("xterm", "-e"),
];

/// 各平台的候選開法（Linux 多支依序嘗試；其餘只有一種）。
/// macOS 走 `.command` 檔（見 [`open_terminal`]），不在這裡。
pub fn launch_plans(script: &str, os: Os) -> Vec<Launch> {
    match os {
        // -ExecutionPolicy Bypass 只作用在這個行程：npm 在 PowerShell 裡是 npm.ps1，
        // 預設的 Restricted 原則會擋掉它。-NoExit 讓視窗留著給使用者看結果。
        Os::Windows => vec![Launch {
            program: "powershell",
            args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", script]
                .map(String::from)
                .to_vec(),
        }],
        Os::Linux => LINUX_TERMINALS
            .iter()
            .map(|&(program, flag)| Launch {
                program,
                args: [flag, "bash", "-c", script].map(String::from).to_vec(),
            })
            .collect(),
        Os::Mac => Vec::new(),
    }
}

/// 開一個新的終端機視窗跑 `script`，起始目錄為 `cwd`。只負責開窗，不等它跑完。
/// macOS 需要 `tmp_dir` 放 `.command` 檔；其餘平台不用。
pub fn open_terminal(script: &str, cwd: &Path, tmp_dir: &Path) -> io::Result<()> {
    let os = Os::current();
    if os == Os::Mac {
        // 用 `open x.command` 交給 Terminal.app 執行，而不是 osascript 叫 Terminal `do script`：
        // 後者是 Apple Event，App 沒有宣告自動化權限時會被 TCC 靜默擋掉。
        let file = tmp_dir.join("db-kit-cli-setup.command");
        std::fs::write(&file, format!("#!/bin/bash\ncd {}\n{script}\n", sh_quote(&cwd.to_string_lossy())))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))?;
        }
        return reap(Command::new("open").arg(&file).spawn()?);
    }
    let mut last = io::Error::new(io::ErrorKind::NotFound, "no terminal emulator found");
    for plan in launch_plans(script, os) {
        let mut c = Command::new(plan.program);
        c.args(&plan.args).current_dir(cwd);
        // 開發模式下 App 自己掛著主控台，不加這個旗標 PowerShell 會跑進那個主控台而不是開新視窗。
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
            c.creation_flags(CREATE_NEW_CONSOLE);
        }
        match c.spawn() {
            Ok(child) => return reap(child),
            Err(e) => last = e,
        }
    }
    Err(last)
}

/// 背景等子行程結束，避免 Unix 上留下殭屍行程（終端機視窗開多久都不影響 App）。
fn reap(mut child: std::process::Child) -> io::Result<()> {
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_commands_follow_the_official_docs() {
        assert_eq!(install_command("claude", Os::Windows), Some("irm https://claude.ai/install.ps1 | iex"));
        assert_eq!(install_command("claude", Os::Mac), Some("curl -fsSL https://claude.ai/install.sh | bash"));
        assert_eq!(install_command("claude", Os::Linux), Some("curl -fsSL https://claude.ai/install.sh | bash"));
        assert_eq!(install_command("codex", Os::Windows), Some("npm i -g @openai/codex"));
        // API 供應商沒有東西可裝；不認得的 id 也不能掉回某個預設指令。
        assert_eq!(install_command("anthropic-api", Os::Windows), None);
        assert_eq!(install_command("rm -rf /", Os::Linux), None);
    }

    #[test]
    fn login_uses_the_resolved_path_quoted_for_the_shell() {
        assert_eq!(
            login_command("claude", r"C:\Users\o'neil\.local\bin\claude.exe", Os::Windows).as_deref(),
            Some(r"& 'C:\Users\o''neil\.local\bin\claude.exe'"),
        );
        assert_eq!(
            login_command("codex", r"C:\Users\me\AppData\Roaming\npm\codex.cmd", Os::Windows).as_deref(),
            Some(r"& 'C:\Users\me\AppData\Roaming\npm\codex.cmd' login"),
        );
        assert_eq!(
            login_command("claude", "/home/o'neil/.local/bin/claude", Os::Linux).as_deref(),
            Some(r"'/home/o'\''neil/.local/bin/claude'"),
        );
        assert_eq!(login_command("openai-api", "/x", Os::Linux), None);
    }

    #[test]
    fn script_echoes_the_command_and_quotes_the_message() {
        let s = terminal_script("irm https://claude.ai/install.ps1 | iex", "Done. It's fine to close this.", Os::Windows);
        assert!(s.starts_with("$env:Path = "));
        assert!(s.contains("Write-Host '> irm https://claude.ai/install.ps1 | iex'; irm https://claude.ai/install.ps1 | iex;"));
        assert!(s.ends_with("Write-Host 'Done. It''s fine to close this.'"));

        let s = terminal_script("curl -fsSL https://claude.ai/install.sh | bash", "It's done", Os::Linux);
        assert_eq!(
            s,
            r#"echo '$ curl -fsSL https://claude.ai/install.sh | bash'; curl -fsSL https://claude.ai/install.sh | bash; echo; echo 'It'\''s done'; exec "${SHELL:-/bin/bash}""#,
        );
    }

    #[test]
    fn windows_opens_one_powershell_that_stays_open() {
        let plans = launch_plans("Write-Host hi", Os::Windows);
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].program, "powershell");
        assert!(plans[0].args.iter().any(|a| a == "-NoExit"));
        assert_eq!(plans[0].args.last().map(String::as_str), Some("Write-Host hi"));
    }

    #[test]
    fn linux_tries_each_terminal_with_its_own_exec_flag() {
        let plans = launch_plans("echo hi", Os::Linux);
        assert_eq!(plans.first().map(|p| p.program), Some("x-terminal-emulator"));
        let gnome = plans.iter().find(|p| p.program == "gnome-terminal").unwrap();
        assert_eq!(gnome.args, ["--", "bash", "-c", "echo hi"]);
        assert!(plans.iter().all(|p| p.args.last().map(String::as_str) == Some("echo hi")));
    }

    /// 真的開一個 PowerShell 視窗，確認整條命令列引號沒被吃掉：腳本寫一個標記檔就自己關窗。
    /// 會跳出視窗，預設不跑：`cargo test agent_setup -- --ignored`。
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn really_opens_a_powershell_window() {
        let dir = std::env::temp_dir().join(format!("dbkit-setup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("marker.txt");
        let script = terminal_script(
            &format!("Set-Content -LiteralPath {} -Value $PWD.Path; exit", ps_quote(&marker.to_string_lossy())),
            "It's done — 完成",
            Os::Windows,
        );
        open_terminal(&script, &dir, &dir).unwrap();
        for _ in 0..100 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let pwd = std::fs::read_to_string(&marker).expect("script did not run");
        // 起始目錄有照 cwd 走。
        assert_eq!(pwd.trim().to_lowercase(), dir.to_string_lossy().to_lowercase());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
