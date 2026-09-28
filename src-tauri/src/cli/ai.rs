//! `dbk ai …`：AI 資源庫（人設 / 技能 / 提示範本 / 輸出契約）的命令列入口。與 GUI 讀同一個設定目錄。
//!
//! - `list` / `show`：看目前生效的是哪一層的哪一份（內建 / 個人 / 團隊）。
//! - `lint [--dir]`：檢查資源庫；`--dir` 只檢查一個資料夾（把團隊的 dba-rules repo 放進 CI）。
//! - `sync`：同步人設與技能到 Claude Code / Codex；沿用 CLI 的確認慣例，未加 `--yes` 只列出計畫。
//! - `path`：個人層與團隊資料夾的位置。

use crate::ai_library::library::{resolve, Kind, Layer, Library};
use crate::ai_library::{settings, sync};
use crate::error::{AppError, AppResult};
use crate::store;

use super::args::{AiCmd, Format};
use super::render;

fn lang() -> &'static str {
    crate::i18n::current().as_code()
}

fn parse_target(t: &str) -> AppResult<(Kind, String)> {
    let (k, n) = t.split_once(['/', ':']).ok_or_else(|| AppError::Query(t!("請用「種類/名稱」指定，例如 agent/dba-senior、prompt/review-sql").into()))?;
    let kind = Kind::parse(k).ok_or_else(|| AppError::Query(tf!("未知的種類：{k}（agent | skill | prompt | contract）", k = k)))?;
    Ok((kind, n.trim().to_string()))
}

fn title_of(e: &crate::ai_library::library::Entry) -> String {
    let r = resolve(e, lang());
    crate::ai_library::frontmatter::field_str(&r.fields, "dbkit-title").filter(|s| !s.trim().is_empty()).unwrap_or_else(|| e.name.clone())
}

fn print_issues(fmt: Format, issues: &[crate::ai_library::library::Issue]) {
    if matches!(fmt, Format::Json) {
        render::emit_value(fmt, &issues);
        return;
    }
    for i in issues {
        let what = match (&i.kind, &i.name) {
            (Some(k), Some(n)) => format!("{}/{n}", k.as_str()),
            _ => String::new(),
        };
        let at = i.path.as_deref().unwrap_or("");
        println!("[{}] {what} {}{}", i.level, i.message, if at.is_empty() { String::new() } else { format!("\n        {at}") });
    }
}

pub fn run(fmt: Format, yes: bool, cmd: AiCmd) -> AppResult<()> {
    let dir = store::headless_config_dir()?;
    match cmd {
        AiCmd::Path => {
            let s = settings::load(&dir);
            let mut rows: Vec<(String, String)> = vec![(t!("個人").into(), settings::personal_dir(&dir).display().to_string())];
            for (i, t) in s.team_dirs.iter().enumerate() {
                let label = if t.label.trim().is_empty() { tf!("團隊 {n}", n = i + 1) } else { t.label.clone() };
                rows.push((label, settings::resolve_dir(&dir, &t.path).display().to_string()));
            }
            rows.push((t!("設定檔").into(), dir.join(settings::SETTINGS_FILE).display().to_string()));
            render::emit_pairs(fmt, &rows);
            Ok(())
        }
        AiCmd::List { kind } => {
            let (lib, _) = settings::load_library(&dir);
            let want = match kind.as_deref() {
                Some(k) => Some(Kind::parse(k).ok_or_else(|| AppError::Query(tf!("未知的種類：{k}（agent | skill | prompt | contract）", k = k)))?),
                None => None,
            };
            let cols: Vec<String> = ["kind", "name", "title", "layer", "path"].iter().map(|s| s.to_string()).collect();
            let rows: Vec<Vec<Option<String>>> = lib
                .entries
                .iter()
                .filter(|e| want.is_none_or(|k| e.kind == k))
                .map(|e| {
                    vec![
                        Some(e.kind.as_str().to_string()),
                        Some(e.name.clone()),
                        Some(title_of(e)),
                        Some(e.layer_label.clone()),
                        e.variants.get("").map(|v| v.path.clone()),
                    ]
                })
                .collect();
            render::emit(fmt, &cols, &rows);
            Ok(())
        }
        AiCmd::Show { target, variant, raw } => {
            let (lib, _) = settings::load_library(&dir);
            let (kind, name) = parse_target(&target)?;
            let e = lib.find(kind, &name).ok_or_else(|| AppError::Query(tf!("找不到：{name}", name = target)))?;
            let l = variant.as_deref().unwrap_or(lang());
            if raw {
                let r = resolve(e, l);
                let v = e.variants.get(&r.lang).or_else(|| e.variants.get("")).unwrap();
                print!("{}", v.raw);
            } else {
                println!("{}", resolve(e, l).body);
            }
            Ok(())
        }
        AiCmd::Lint { dir: only } => {
            let lib = match only {
                Some(d) => {
                    let root = settings::resolve_dir(&std::env::current_dir().unwrap_or(dir.clone()), &d);
                    if !root.is_dir() {
                        return Err(AppError::Query(tf!("資料夾不存在：{dir}", dir = root.display())));
                    }
                    // 單獨檢查一個資料夾：疊在內建之上（才判斷得出「覆蓋內建範本」與登錄欄位），只列那個資料夾的問題。
                    let layer = Layer { id: "team:0".into(), label: d.clone(), root: Some(root.clone()), writable: false };
                    let full = Library::load(&[Layer::builtin(), layer]);
                    let prefix = root.to_string_lossy().to_string();
                    Library {
                        issues: full.issues.into_iter().filter(|i| i.path.as_deref().is_some_and(|p| p.starts_with(&prefix))).collect(),
                        entries: full.entries,
                    }
                }
                None => settings::load_library(&dir).0,
            };
            print_issues(fmt, &lib.issues);
            let errors = lib.issues.iter().filter(|i| i.level == "error").count();
            let warns = lib.issues.iter().filter(|i| i.level == "warn").count();
            if !matches!(fmt, Format::Json) {
                eprintln!("{}", tf!("{e} 個錯誤、{w} 個警告", e = errors, w = warns));
            }
            if errors > 0 {
                return Err(AppError::Query(tf!("資源庫有 {n} 個錯誤", n = errors)));
            }
            Ok(())
        }
        AiCmd::Sync { claude, codex, project } => {
            let (lib, mut s) = settings::load_library(&dir);
            // 旗標只收窄目標；都沒給時用設定檔的同步目標。
            if claude || codex {
                s.sync.claude_user = claude;
                s.sync.codex_user = codex;
            }
            if !project.is_empty() {
                s.sync.project_dirs = project;
            }
            let plan = sync::plan(&lib, &s, &dir, lang());
            if matches!(fmt, Format::Json) && !yes {
                render::emit_value(fmt, &plan);
                return Ok(());
            }
            for it in &plan.items {
                println!("{:<9} {}  {}", format!("{:?}", it.action).to_lowercase(), it.path, it.source);
            }
            if !yes {
                eprintln!("{}", t!("未加 --yes：只列出計畫，沒有寫入任何檔案。"));
                eprintln!("{}", plan.mcp_hint);
                return Ok(());
            }
            let rep = sync::apply(&plan, &dir);
            if matches!(fmt, Format::Json) {
                render::emit_value(fmt, &rep);
            } else {
                eprintln!("{}", tf!("已寫入 {w} 個、刪除 {d} 個、略過 {s} 個（衝突）", w = rep.written, d = rep.deleted, s = rep.skipped));
                eprintln!("{}", plan.mcp_hint);
            }
            if !rep.errors.is_empty() {
                return Err(AppError::Storage(rep.errors.join("\n")));
            }
            Ok(())
        }
    }
}
