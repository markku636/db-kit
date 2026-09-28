use std::path::{Path, PathBuf};

fn main() {
    // 內建 AI 資源庫：GUI 與 CLI 都要（`dbk run` 的審查提示、`dbk ai …`），放在 gui 判斷之外。
    embed_ai_library();
    // 只有 GUI build 需要 Tauri context / 嵌入前端 dist（generate_context!）。
    // CLI（--no-default-features，無 gui feature）跳過，避免要求 ../dist 存在。
    if std::env::var_os("CARGO_FEATURE_GUI").is_some() {
        tauri_build::build();
    }
}

/// 把 repo 根目錄 `ai-library/` 底下的 `.md` 逐檔 `include_str!` 成 `$OUT_DIR/ai_builtin.rs`。
/// 前端用 Vite `import.meta.glob` 打包同一批檔案——兩邊的內建內容永遠是同一份。
fn embed_ai_library() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let root = manifest.join("..").join("ai-library");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    walk(&root, "", &mut files);
    files.sort();
    let mut out = String::from("/// 內建 AI 資源庫：`(相對路徑, 內容)`。由 build.rs 從 repo 的 `ai-library/` 產生，請勿手改。\n");
    out.push_str("pub static FILES: &[(&str, &str)] = &[\n");
    for (rel, abs) in &files {
        out.push_str(&format!("    ({rel:?}, include_str!({:?})),\n", abs.to_string_lossy()));
    }
    out.push_str("];\n");
    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("ai_builtin.rs");
    std::fs::write(dest, out).expect("寫入 ai_builtin.rs");
}

fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        let r = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if path.is_dir() {
            walk(&path, &r, out);
        } else if name.ends_with(".md") {
            out.push((r, path));
        }
    }
}
