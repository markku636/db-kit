//! db-kit 命令列介面（唯讀查詢 + 匯出）。
//!
//! 直接重用核心層（`manager` / `store` / `export` / `backup` / `conn_crypto`），
//! 不經過 Tauri commands，因此可在 `--no-default-features`（無 gui）下單獨編譯。
//! 對資料庫唯讀：只開放查詢 / 瀏覽 / 匯出，`query` 另過唯讀守門（見 `guard`）。

mod args;
mod dispatch;
mod guard;
mod render;
mod resolve;

use std::process::ExitCode;

use clap::{CommandFactory, FromArgMatches};

use crate::i18n::Lang;

/// CLI 進入點。bin shim 在 tokio runtime 上 `block_on` 此函式。
/// 錯誤印到 stderr 並回非零 exit code。
pub async fn run() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();

    // 語言優先序：--lang > DBKIT_LANG > app_settings.json 的 lang > 預設 zh-TW。
    // 必須在 clap 解析（含 --help / --version 提早退出）之前決定，help 文字才能以正確語言呈現。
    let lang = resolve_lang(&argv).await;
    crate::i18n::set_lang(lang);

    // 依語言覆寫 clap 的 about / 參數說明（原文即中文，zh 直接沿用不覆寫）。
    let mut cmd = args::Cli::command();
    if lang == Lang::En {
        cmd = localize_command(cmd);
    }
    // get_matches_from 於 --help / --version / 參數錯誤時自行印出並 exit。
    let matches = cmd.get_matches_from(argv);
    let cli = match args::Cli::from_arg_matches(&matches) {
        Ok(c) => c,
        Err(e) => e.exit(),
    };

    match dispatch::dispatch(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // 用 message() 而非 Display：`#[error(...)]` 屬性是編譯期字面值，只能是中性英文，
            // 印它會讓中文使用者在 CLI 看到「error: query failed: 唯讀模式…」這種半英半中的訊息。
            // message() 走 tf!，外層與內層都跟著當前語言。
            eprintln!("error: {}", e.message());
            ExitCode::FAILURE
        }
    }
}

/// 依優先序解析 CLI 語言。`--lang` 以輕量掃描取得（避免在此觸發 clap 的 --help 提早退出）。
async fn resolve_lang(argv: &[String]) -> Lang {
    // 1) --lang <v> / --lang=<v>
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(v) = a.strip_prefix("--lang=") {
            if let Some(l) = Lang::from_code(v) {
                return l;
            }
        } else if a == "--lang" {
            if let Some(l) = argv.get(i + 1).and_then(|v| Lang::from_code(v)) {
                return l;
            }
        }
        i += 1;
    }
    // 2) 環境變數 DBKIT_LANG
    if let Ok(v) = std::env::var("DBKIT_LANG") {
        if let Some(l) = Lang::from_code(&v) {
            return l;
        }
    }
    // 3) app_settings.json（與 GUI 共用）
    if let Ok(dir) = crate::store::headless_config_dir() {
        if let Ok(s) = crate::store::read_json_in::<crate::store::AppSettings>(
            &dir,
            crate::store::APP_SETTINGS_FILE,
        )
        .await
        {
            if let Some(l) = s.lang.as_deref().and_then(Lang::from_code) {
                return l;
            }
        }
    }
    // 4) 預設
    Lang::default()
}

/// 遞迴以 en 表覆寫 command 樹的 about / 參數說明。查無譯文者保留原文。
fn localize_command(mut cmd: clap::Command) -> clap::Command {
    if let Some(about) = cmd.get_about().map(|s| s.to_string()) {
        if let Some(en) = tr_help(&about) {
            cmd = cmd.about(en.to_string());
        }
    }
    let arg_ids: Vec<String> = cmd
        .get_arguments()
        .map(|a| a.get_id().as_str().to_string())
        .collect();
    for id in arg_ids {
        cmd = cmd.mut_arg(id, |a| match a.get_help().map(|s| s.to_string()) {
            Some(h) => match tr_help(&h) {
                Some(en) => a.help(en.to_string()),
                None => a,
            },
            None => a,
        });
    }
    let sub_names: Vec<String> = cmd
        .get_subcommands()
        .map(|s| s.get_name().to_string())
        .collect();
    for name in sub_names {
        cmd = cmd.mut_subcommand(name, localize_command);
    }
    cmd
}

/// 查 en 表；查無且字串含中文時，於 debug build 以 `debug_assert!` 大聲失敗
/// （clap 內建英文 help 不含中文，不會誤觸；真正遺漏譯文的 help 才會炸出來，避免靜默不生效）。
fn tr_help(s: &str) -> Option<&'static str> {
    match crate::locales::en::lookup(s) {
        Some(en) => Some(en),
        None => {
            debug_assert!(
                !s.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "missing en translation for clap help text: {s:?}"
            );
            None
        }
    }
}
