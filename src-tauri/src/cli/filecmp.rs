//! `dbk diff` / `dbk sync`：檔案 / 資料夾比對與同步（核心在 `crate::filecmp`，與 GUI 的比對分頁同一套）。
//!
//! 一邊可以是本機路徑，或 `ssh://<已存主機>/<路徑>`（主機用 GUI 裡的名稱或 id；FTP 主機也用這個寫法）。
//! 也可以直接跑 GUI 存好的比對：`--session <名稱>`，兩邊、排除規則、判斷準則、同步規則都從那筆帶。
//! 同步是寫入指令：未加 `--yes` 只列出將執行的動作（預演）；會刪除檔案時另需 `--force`。

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use serde::Serialize;

use super::args::{FileDiffArgs, FileSyncArgs, Format, SyncRuleArg};
use super::guard::ensure_confirmed;
use super::render;
use crate::error::{AppError, AppResult};
use crate::filecmp::binary;
use crate::filecmp::content::{self, ContentPair};
use crate::filecmp::diff::{align, AlignOpts, Criteria, Row, Status};
use crate::filecmp::linediff;
use crate::filecmp::plan::plan_sync;
use crate::filecmp::remote::{expand_home, open_saved_host, RemoteOpen};
use crate::filecmp::scan::{scan, ScanOpts, SCAN_MAX_ENTRIES};
use crate::filecmp::sessions::{self, CompareSession, FolderSettings, SessionSide, SyncRule};
use crate::filecmp::side::SideFs;
use crate::filecmp::sync::{Endpoint, OpKind, SyncProgress, Syncer};
use crate::filecmp::{scope_dir, text};

/// 解析好的一邊：檔案系統 + 根路徑 + 顯示名稱。遠端的連線放在 `_remote` 裡活到用完。
struct Side {
    fs: SideFs,
    root: String,
    label: String,
    _remote: Option<RemoteOpen>,
}

/// `ssh://host/path`、`sftp://`、`ftp://`、`ftps://` → (主機, 路徑)。其餘當本機路徑。
fn parse_remote(spec: &str) -> Option<(String, String)> {
    let lower = spec.to_ascii_lowercase();
    let rest = ["ssh://", "sftp://", "ftp://", "ftps://"].iter().find_map(|p| lower.starts_with(p).then(|| &spec[p.len()..]))?;
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "~"),
    };
    // `ssh://web/~/app` → `~/app`；`ssh://web/var/www` → `/var/www`。
    let path = if let Some(p) = path.strip_prefix("/~") { format!("~{p}") } else { path.to_string() };
    Some((host.to_string(), path))
}

async fn open_side(config_dir: &Path, spec: &str) -> AppResult<Side> {
    if let Some((host, path)) = parse_remote(spec) {
        let r = open_saved_host(config_dir, &host).await?;
        let root = expand_home(&path, &r.home);
        let label = format!("{}:{}", r.label, root);
        return Ok(Side { fs: SideFs::Remote(r.client.clone()), root, label, _remote: Some(r) });
    }
    Ok(Side { fs: SideFs::Local, root: spec.to_string(), label: spec.to_string(), _remote: None })
}

fn session_spec(s: &SessionSide) -> String {
    match s {
        SessionSide::Local { path } => path.clone(),
        SessionSide::Remote { session_id, path } => {
            let p = if path.starts_with('/') { path.clone() } else { format!("/{path}") };
            format!("ssh://{session_id}{p}")
        }
    }
}

async fn load_session(config_dir: &Path, name: &str) -> AppResult<CompareSession> {
    let f = sessions::load_in(config_dir).await?;
    f.find(name).cloned().ok_or_else(|| AppError::Compare(tf!("找不到已存的比對：{name}", name = name)))
}

/// 兩邊的來源規格 + 資料夾設定（命令列參數蓋過已存比對的設定）。
struct Plan {
    left: String,
    right: String,
    mode: Option<String>,
    folder: FolderSettings,
}

fn apply_flags(folder: &mut FolderSettings, criteria: Option<Criteria>, excludes: &[String], hour: bool, ci: bool) {
    if let Some(c) = criteria {
        folder.criteria = c;
    }
    if !excludes.is_empty() {
        folder.excludes = excludes.to_vec();
    }
    folder.ignore_hour_offset |= hour;
    folder.case_insensitive |= ci;
}

async fn resolve_plan(
    config_dir: &Path,
    session: Option<&str>,
    left: Option<&str>,
    right: Option<&str>,
) -> AppResult<Plan> {
    if let Some(name) = session {
        let s = load_session(config_dir, name).await?;
        return Ok(Plan {
            left: left.map(str::to_string).unwrap_or_else(|| session_spec(&s.left)),
            right: right.map(str::to_string).unwrap_or_else(|| session_spec(&s.right)),
            mode: Some(s.mode.clone()),
            folder: s.folder,
        });
    }
    match (left, right) {
        (Some(l), Some(r)) => Ok(Plan { left: l.into(), right: r.into(), mode: None, folder: FolderSettings::default() }),
        _ => Err(AppError::Compare(t!("請給左右兩邊的路徑，或用 --session 指定已存的比對").into())),
    }
}

async fn is_dir(side: &Side) -> AppResult<bool> {
    Ok(side
        .fs
        .stat(&side.root)
        .await?
        .ok_or_else(|| AppError::Compare(tf!("找不到：{path}", path = side.label)))?
        .is_dir)
}

// ---- 資料夾 ----

async fn folder_rows(l: &Side, r: &Side, folder: &FolderSettings, temp: &Path) -> AppResult<Vec<Row>> {
    let cancel = AtomicBool::new(false);
    let opts = ScanOpts { excludes: &folder.excludes, max_entries: SCAN_MAX_ENTRIES };
    let (a, b) = tokio::join!(
        scan(&l.fs, &l.root, &opts, &cancel, &|_| {}),
        scan(&r.fs, &r.root, &opts, &cancel, &|_| {}),
    );
    let (a, b) = (a?, b?);
    for (side, (p, m)) in a.errors.iter().map(|e| ("left", e)).chain(b.errors.iter().map(|e| ("right", e))) {
        eprintln!("{}", tf!("警告：{side} 讀不到 {path}：{msg}", side = side, path = p, msg = m));
    }
    let align_opts: AlignOpts = folder.align_opts();
    let mut rows = align(&a.nodes, &b.nodes, &align_opts);
    // 準則是「內容」：大小相同的檔逐一比內容（遠端先下載到暫存）。
    let pairs: Vec<ContentPair> = rows
        .iter()
        .filter(|r| r.status == Status::Unchecked)
        .map(|r| ContentPair { key: r.key.clone(), left: r.left.as_ref().unwrap().rel.clone(), right: r.right.as_ref().unwrap().rel.clone() })
        .collect();
    if !pairs.is_empty() {
        let cancel = Arc::new(AtomicBool::new(false));
        let res = content::check_pairs(&l.fs, &l.root, &r.fs, &r.root, pairs, temp, &cancel, &|_, _, _| {}).await?;
        for c in res {
            if let Some(row) = rows.iter_mut().find(|r| r.key == c.key) {
                match c.equal {
                    Some(true) => row.status = Status::Same,
                    Some(false) => row.status = Status::Diff,
                    None => eprintln!("{}", tf!("警告：無法比對內容 {path}：{msg}", path = c.key, msg = c.error.unwrap_or_default())),
                }
            }
        }
    }
    Ok(rows)
}

fn status_word(s: Status) -> &'static str {
    match s {
        Status::Same => "same",
        Status::Diff => "diff",
        Status::LeftOnly => "left_only",
        Status::RightOnly => "right_only",
        Status::TypeMismatch => "type_mismatch",
        Status::Unchecked => "unchecked",
    }
}

fn time_str(t: Option<u64>) -> Option<String> {
    let t = t?;
    chrono::DateTime::from_timestamp(t as i64, 0).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
}

fn is_dir_row(r: &Row) -> bool {
    r.left.as_ref().or(r.right.as_ref()).is_some_and(|m| m.is_dir) && r.status != Status::TypeMismatch
}

fn emit_rows(fmt: Format, rows: &[Row], all: bool) {
    let cols: Vec<String> = ["status", "path", "left_size", "right_size", "left_mtime", "right_mtime", "newer"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let out: Vec<Vec<Option<String>>> = rows
        .iter()
        // 預設只列不同的；兩邊都有的資料夾狀態一律是 same（差異看底下的檔），所以也只在 --all 時列。
        .filter(|r| all || r.status != Status::Same)
        .map(|r| {
            let path = r.left.as_ref().or(r.right.as_ref()).map(|m| m.rel.clone()).unwrap_or_default();
            let dir = r.left.as_ref().or(r.right.as_ref()).is_some_and(|m| m.is_dir);
            vec![
                Some(status_word(r.status).to_string()),
                Some(if dir { format!("{path}/") } else { path }),
                r.left.as_ref().filter(|m| !m.is_dir).map(|m| m.size.to_string()),
                r.right.as_ref().filter(|m| !m.is_dir).map(|m| m.size.to_string()),
                r.left.as_ref().and_then(|m| time_str(m.mtime)),
                r.right.as_ref().and_then(|m| time_str(m.mtime)),
                r.newer.map(str::to_string),
            ]
        })
        .collect();
    render::emit(fmt, &cols, &out);
}

#[derive(Serialize, Default)]
struct Summary {
    same: usize,
    diff: usize,
    left_only: usize,
    right_only: usize,
}

/// 檔案層級的統計（與 GUI 的 countFiles 一致：資料夾本身不算，只在一邊的資料夾把底下的檔算進去）。
fn summarize(rows: &[Row]) -> Summary {
    let mut s = Summary::default();
    for r in rows.iter().filter(|r| !is_dir_row(r)) {
        match r.status {
            Status::Same => s.same += 1,
            Status::Diff | Status::TypeMismatch | Status::Unchecked => s.diff += 1,
            Status::LeftOnly => s.left_only += 1,
            Status::RightOnly => s.right_only += 1,
        }
    }
    s
}

// ---- dbk diff ----

pub async fn diff(fmt: Format, a: FileDiffArgs) -> AppResult<()> {
    let config_dir = crate::store::headless_config_dir()?;
    let mut plan = resolve_plan(&config_dir, a.session.as_deref(), a.left.as_deref(), a.right.as_deref()).await?;
    apply_flags(&mut plan.folder, a.criteria.map(Into::into), &a.exclude, a.ignore_hour_offset, a.ignore_case);
    let l = open_side(&config_dir, &plan.left).await?;
    let r = open_side(&config_dir, &plan.right).await?;
    let temp = scope_dir(&format!("cli-{}", uuid::Uuid::new_v4()));
    let res = run_diff(fmt, &a, &plan, &l, &r, &temp).await;
    let _ = tokio::fs::remove_dir_all(&temp).await;
    match res? {
        true if a.exit_code => Err(AppError::Compare(t!("兩邊不同").into())),
        _ => Ok(()),
    }
}

/// 回傳「有沒有差異」。
async fn run_diff(fmt: Format, a: &FileDiffArgs, plan: &Plan, l: &Side, r: &Side, temp: &Path) -> AppResult<bool> {
    let (ld, rd) = (is_dir(l).await?, is_dir(r).await?);
    if ld != rd {
        return Err(AppError::Compare(t!("一邊是資料夾、一邊是檔案，無法比對").into()));
    }
    let mode = match a.mode.as_deref().or(plan.mode.as_deref()) {
        Some("folder") | None if ld => "folder",
        Some("folder") => return Err(AppError::Compare(t!("資料夾比對的兩邊都要是資料夾").into())),
        _ if ld => return Err(AppError::Compare(t!("兩邊是資料夾，請改用資料夾比對").into())),
        Some(m @ ("text" | "binary")) => m,
        _ => "auto",
    };
    if mode == "folder" {
        let rows = folder_rows(l, r, &plan.folder, temp).await?;
        let s = summarize(&rows);
        // 以列判斷而不是統計：只在一邊的空資料夾也算有差異。
        let differ = rows.iter().any(|r| r.status != Status::Same);
        if fmt == Format::Json {
            render::emit_value(fmt, &serde_json::json!({ "left": l.label, "right": r.label, "summary": s, "rows": rows }));
        } else {
            emit_rows(fmt, &rows, a.all);
            if fmt == Format::Table {
                eprintln!(
                    "{}",
                    tf!(
                        "相同 {same} · 不同 {diff} · 只在左 {lo} · 只在右 {ro}",
                        same = s.same,
                        diff = s.diff,
                        lo = s.left_only,
                        ro = s.right_only
                    )
                );
            }
        }
        return Ok(differ);
    }
    // 單一檔案：兩邊都先拿到本機路徑。
    let cancel = Arc::new(AtomicBool::new(false));
    let (pa, _) = content::local_copy(&l.fs, &l.root, temp, &cancel).await?;
    let (pb, _) = content::local_copy(&r.fs, &r.root, temp, &cancel).await?;
    let mut mode = mode.to_string();
    let (ta, tb) = (text::read(&pa, 0).await?, text::read(&pb, 0).await?);
    if mode == "auto" {
        mode = if ta.binary || tb.binary || ta.lossy || tb.lossy { "binary".into() } else { "text".into() };
    }
    if mode == "binary" {
        let (pa2, pb2, c) = (pa.clone(), pb.clone(), cancel.clone());
        let d = tokio::task::spawn_blocking(move || binary::diff_files(&pa2, &pb2, &c))
            .await
            .map_err(|e| AppError::Compare(e.to_string()))??;
        let differ = d.diff_bytes > 0;
        if fmt == Format::Json {
            render::emit_value(fmt, &d);
        } else {
            let cols = vec!["offset".to_string(), "length".to_string()];
            let rows: Vec<Vec<Option<String>>> =
                d.ranges.iter().map(|[o, n]| vec![Some(format!("0x{o:08x}")), Some(n.to_string())]).collect();
            if differ {
                render::emit(fmt, &cols, &rows);
            }
            eprintln!(
                "{}",
                if differ {
                    tf!("{n} 段不同，共 {bytes} 個位元組（{a} / {b} bytes）", n = d.ranges.len(), bytes = d.diff_bytes, a = d.size_a, b = d.size_b)
                } else {
                    t!("內容相同").to_string()
                }
            );
        }
        return Ok(differ);
    }
    if ta.truncated || tb.truncated {
        return Err(AppError::Compare(t!("檔案太大，無法逐行比對，請改用 --mode binary").into()));
    }
    let u = linediff::unified(&ta.text, &tb.text, &l.label, &r.label, a.context)
        .ok_or_else(|| AppError::Compare(t!("兩個檔差異太大，無法逐行比對，請改用 --mode binary").into()))?;
    let differ = !u.is_empty();
    if fmt == Format::Json {
        render::emit_value(fmt, &serde_json::json!({ "left": l.label, "right": r.label, "equal": !differ, "diff": u }));
    } else if differ {
        print!("{u}");
    } else {
        eprintln!("{}", t!("內容相同"));
    }
    Ok(differ)
}

// ---- dbk sync ----

fn rule_of(a: Option<SyncRuleArg>, saved: Option<SyncRule>) -> AppResult<SyncRule> {
    a.map(Into::into)
        .or(saved)
        .ok_or_else(|| AppError::Compare(t!("請用 --rule 指定同步規則（mirror-lr / mirror-rl / update-lr / update-rl / update-both）").into()))
}

pub async fn sync(fmt: Format, yes: bool, force: bool, a: FileSyncArgs) -> AppResult<()> {
    let config_dir = crate::store::headless_config_dir()?;
    let mut plan = resolve_plan(&config_dir, a.session.as_deref(), a.left.as_deref(), a.right.as_deref()).await?;
    apply_flags(&mut plan.folder, a.criteria.map(Into::into), &a.exclude, a.ignore_hour_offset, a.ignore_case);
    let rule = rule_of(a.rule, plan.folder.rule)?;
    let l = open_side(&config_dir, &plan.left).await?;
    let r = open_side(&config_dir, &plan.right).await?;
    if !is_dir(&l).await? || !is_dir(&r).await? {
        return Err(AppError::Compare(t!("同步的兩邊都要是資料夾").into()));
    }
    let temp = scope_dir(&format!("cli-{}", uuid::Uuid::new_v4()));
    let res = run_sync(fmt, yes, force, rule, &plan, &l, &r, &temp).await;
    let _ = tokio::fs::remove_dir_all(&temp).await;
    res
}

#[allow(clippy::too_many_arguments)]
async fn run_sync(fmt: Format, yes: bool, force: bool, rule: SyncRule, plan: &Plan, l: &Side, r: &Side, temp: &PathBuf) -> AppResult<()> {
    let rows = folder_rows(l, r, &plan.folder, temp).await?;
    let p = plan_sync(&rows, rule);
    let cols = vec!["action".to_string(), "path".to_string(), "to".to_string()];
    let listed: Vec<Vec<Option<String>>> = p
        .ops
        .iter()
        .map(|o| {
            let action = match o.kind {
                OpKind::CopyLr => "copy →",
                OpKind::CopyRl => "copy ←",
                OpKind::DeleteLeft => "delete left",
                OpKind::DeleteRight => "delete right",
            };
            let slash = if o.is_dir { "/" } else { "" };
            vec![Some(action.into()), Some(format!("{}{slash}", o.src)), o.dst.clone()]
        })
        .collect();
    for c in &p.conflicts {
        eprintln!("{}", tf!("衝突（不處理）：{path}", path = c));
    }
    if p.ops.is_empty() {
        println!("{}", t!("兩邊已經一致，沒有需要處理的項目。"));
        return Ok(());
    }
    render::emit(fmt, &cols, &listed);
    let deletes = p.ops.iter().filter(|o| matches!(o.kind, OpKind::DeleteLeft | OpKind::DeleteRight)).count();
    let copies = p.ops.len() - deletes;
    let action = tf!("同步 {left} ↔ {right}：複製 {c} 項、刪除 {d} 項", left = l.label, right = r.label, c = copies, d = deletes);
    ensure_confirmed(yes, force, deletes > 0, &action)?;
    let cancel = AtomicBool::new(false);
    let quiet = fmt != Format::Table;
    let progress: Arc<dyn Fn(SyncProgress) + Send + Sync> = Arc::new(move |p: SyncProgress| {
        if !quiet && !p.current.is_empty() {
            eprint!("\r[{}/{}] {:<60}", p.done_items + 1, p.total_items, p.current.chars().take(60).collect::<String>());
        }
    });
    let mut syncer = Syncer::new(
        Endpoint { fs: &l.fs, root: &l.root },
        Endpoint { fs: &r.fs, root: &r.root },
        &plan.folder.excludes,
        temp.clone(),
        &cancel,
        progress,
    );
    let rep = syncer.run(&p.ops).await?;
    if !quiet {
        eprintln!();
    }
    for (path, msg) in &rep.failed {
        eprintln!("{}", tf!("失敗：{path}：{msg}", path = path, msg = msg));
    }
    println!("{}", tf!("完成：複製 {c} 項、刪除 {d} 項", c = rep.copied, d = rep.deleted));
    if rep.mtime_not_kept > 0 {
        eprintln!("{}", tf!("{n} 個檔案無法保留修改時間（FTP），重新比較時可能仍顯示時間不同", n = rep.mtime_not_kept));
    }
    if !rep.failed.is_empty() {
        return Err(AppError::Compare(tf!("{n} 項失敗", n = rep.failed.len())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_remote_specs() {
        assert_eq!(parse_remote("ssh://web-01/var/www"), Some(("web-01".into(), "/var/www".into())));
        assert_eq!(parse_remote("SFTP://web-01/~/app"), Some(("web-01".into(), "~/app".into())));
        assert_eq!(parse_remote("ftp://files"), Some(("files".into(), "~".into())));
        assert_eq!(parse_remote("C:\\work\\site"), None);
        assert_eq!(parse_remote("/home/me"), None);
        assert_eq!(session_spec(&SessionSide::Remote { session_id: "h1".into(), path: "~/x".into() }), "ssh://h1/~/x");
        assert_eq!(parse_remote(&session_spec(&SessionSide::Remote { session_id: "h1".into(), path: "~/x".into() })), Some(("h1".into(), "~/x".into())));
    }

    #[tokio::test]
    async fn local_folder_diff_and_sync() {
        let base = std::env::temp_dir().join(format!("dbk-cli-fcmp-{}", uuid::Uuid::new_v4()));
        let (lp, rp) = (base.join("l"), base.join("r"));
        std::fs::create_dir_all(lp.join("sub")).unwrap();
        std::fs::create_dir_all(&rp).unwrap();
        std::fs::write(lp.join("a.txt"), "1").unwrap();
        std::fs::write(lp.join("sub/b.txt"), "2").unwrap();
        std::fs::write(rp.join("gone.txt"), "x").unwrap();
        let dir = base.join("cfg");
        let l = open_side(&dir, &lp.display().to_string()).await.unwrap();
        let r = open_side(&dir, &rp.display().to_string()).await.unwrap();
        let plan = Plan { left: String::new(), right: String::new(), mode: None, folder: FolderSettings::default() };
        let rows = folder_rows(&l, &r, &plan.folder, &base.join("tmp")).await.unwrap();
        let s = summarize(&rows);
        assert_eq!((s.left_only, s.right_only), (2, 1));
        // 沒有 --yes：預演、以錯誤結束、不動任何東西。
        let e = run_sync(Format::Json, false, false, SyncRule::MirrorLr, &plan, &l, &r, &base.join("tmp")).await;
        assert!(matches!(e, Err(AppError::NeedsConfirm(_))));
        assert!(rp.join("gone.txt").exists());
        // 有刪除要 --force。
        let e = run_sync(Format::Json, true, false, SyncRule::MirrorLr, &plan, &l, &r, &base.join("tmp")).await;
        assert!(matches!(e, Err(AppError::NeedsConfirm(_))));
        run_sync(Format::Json, true, true, SyncRule::MirrorLr, &plan, &l, &r, &base.join("tmp")).await.unwrap();
        assert!(rp.join("sub/b.txt").exists() && !rp.join("gone.txt").exists());
        let rows = folder_rows(&l, &r, &plan.folder, &base.join("tmp")).await.unwrap();
        let s = summarize(&rows);
        assert_eq!((s.diff, s.left_only, s.right_only), (0, 0, 0));
        std::fs::remove_dir_all(&base).unwrap();
    }
}
