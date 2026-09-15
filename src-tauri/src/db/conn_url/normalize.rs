//! 貼上內容的雜訊前置處理：使用者多半是從 `.env`、終端機或雲端控制台整行複製，
//! 連線字串本體外常帶引號、`export DATABASE_URL=` 前綴、尾端分號或換行。
//!
//! 全部以字元判斷實作（不引 regex）。每條規則都刻意收緊條件，寧可少剝也不要吃掉合法內容——
//! 誤剝的後果是「明明貼對了卻解析失敗」，比不處理更難查。

/// 依序套用所有正規化規則，回傳可直接餵給偵測鏈的字串。
pub(super) fn prepare(raw: &str) -> String {
    // 引號與 env 前綴可能互相包夾（`export X="url"` / `"export X=url"`），故做到不動點為止。
    // 上限 4 圈：正常輸入 1-2 圈就穩定，設上限純粹避免惡意輸入造成長迴圈。
    let mut s = raw.trim().to_string();
    for _ in 0..4 {
        let before = s.clone();
        s = unwrap_quotes(&s).trim().to_string();
        s = strip_env_assignment(&s).trim().to_string();
        if s == before {
            break;
        }
    }
    s = join_wrapped_lines(&s);
    strip_trailing_semicolon(&s).trim().to_string()
}

/// 剝除成對的外層引號（`'…'`、`"…"`、`` `…` ``）。只剝一層，由 `prepare` 的迴圈處理多層。
fn unwrap_quotes(s: &str) -> String {
    let b = s.as_bytes();
    if b.len() >= 2 {
        let first = b[0];
        if matches!(first, b'\'' | b'"' | b'`') && b[b.len() - 1] == first {
            return s[1..s.len() - 1].to_string();
        }
    }
    s.to_string()
}

/// 剝除 `export ` 與開頭的 `NAME=` 環境變數指派。
///
/// `NAME` 必須（1）符合 `[A-Za-z_][A-Za-z0-9_]*`、（2）**全大寫**、且（3）餘下部分含 `://`。
/// 三重護欄是為了不吃掉本身就以 `key=value` 開頭的合法連線字串：
/// libpq 的 `host=localhost port=…`（小寫，擋在條件 2）與 ADO.NET 的 `Server=tcp:db,1433`
/// （無 `://`，擋在條件 3）都必須原樣通過。
fn strip_env_assignment(s: &str) -> String {
    let s = super::params::strip_prefix_ci(s, "export ")
        .map(str::trim_start)
        .unwrap_or(s);

    let Some((name, rest)) = s.split_once('=') else {
        return s.to_string();
    };
    let name = name.trim();
    let valid_ident = !name.is_empty()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
        && !name.as_bytes()[0].is_ascii_digit()
        // 全大寫：小寫或混用視為連線字串自己的 key，不剝。
        && name.bytes().all(|c| !c.is_ascii_lowercase());
    if valid_ident && rest.contains("://") {
        return rest.trim().to_string();
    }
    s.to_string()
}

/// 多行輸入：properties 區塊（Kafka）以換行分隔參數，必須保留；
/// 其餘情況的換行是終端機 / 編輯器折行造成的，接合回一行。
fn join_wrapped_lines(s: &str) -> String {
    if !s.contains('\n') {
        return s.to_string();
    }
    if looks_like_props_blob(s) {
        return s.to_string();
    }
    s.split(['\n', '\r'])
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("")
}

/// 是否為 properties 區塊：≥2 個非空行，且其中過半是 `key=value`
/// （key 為 `[A-Za-z][A-Za-z0-9._-]*`，允許鍵後空白）。
fn looks_like_props_blob(s: &str) -> bool {
    let lines: Vec<&str> = s
        .split(['\n', '\r'])
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() < 2 {
        return false;
    }
    let kv = lines.iter().filter(|l| is_props_line(l)).count();
    kv * 2 >= lines.len()
}

fn is_props_line(line: &str) -> bool {
    let Some((k, _)) = line.split_once('=') else {
        return false;
    };
    let k = k.trim();
    !k.is_empty()
        && k.as_bytes()[0].is_ascii_alphabetic()
        && k.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// 剝除尾端分號。只在含 `://` 時做——ADO.NET 與 JAAS 設定的尾端 `;` 是語法的一部分。
fn strip_trailing_semicolon(s: &str) -> String {
    if s.contains("://") {
        s.trim_end().trim_end_matches(';').to_string()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_url_unwrapped() {
        assert_eq!(prepare("\"postgres://h/db\""), "postgres://h/db");
        assert_eq!(prepare("'postgres://h/db'"), "postgres://h/db");
        assert_eq!(prepare("`postgres://h/db`"), "postgres://h/db");
    }

    #[test]
    fn export_database_url_prefix_stripped() {
        assert_eq!(
            prepare("export DATABASE_URL=\"postgresql://u:p@h:5432/db\""),
            "postgresql://u:p@h:5432/db"
        );
        assert_eq!(prepare("DATABASE_URL=postgres://h/db"), "postgres://h/db");
        assert_eq!(prepare("REDIS_URL=rediss://h:6380"), "rediss://h:6380");
    }

    #[test]
    fn lowercase_kv_not_mistaken_for_env_assignment() {
        // libpq keyword/value：全小寫且無 `://`，必須原樣通過（否則 host= 會被當成變數名剝掉）。
        let s = "host=localhost port=5434 dbname=ranai user=u";
        assert_eq!(prepare(s), s);
    }

    #[test]
    fn ado_server_key_not_mistaken_for_env_assignment() {
        // `Server=` 混用大小寫且無 `://`；`SERVER=` 全大寫但同樣無 `://`，兩者都不可剝。
        let s = "Server=tcp:db.example.com,1433;Database=mydb";
        assert_eq!(prepare(s), s);
        let s2 = "SERVER=db,1433;DATABASE=mydb";
        assert_eq!(prepare(s2), s2);
    }

    #[test]
    fn trailing_semicolon_stripped_only_for_urls() {
        assert_eq!(prepare("postgres://h/db;"), "postgres://h/db");
        // ADO.NET 尾端分號屬語法，保留。
        assert_eq!(prepare("Server=h;Database=d;"), "Server=h;Database=d;");
    }

    #[test]
    fn multiline_url_joined() {
        // 終端機折行：接合後應還原成完整 URL。
        assert_eq!(
            prepare("postgres://u:p@host:5432/\ndbname"),
            "postgres://u:p@host:5432/dbname"
        );
    }

    #[test]
    fn multiline_properties_kept() {
        let blob = "bootstrap.servers=pkc-x.confluent.cloud:9092\nsecurity.protocol=SASL_SSL";
        assert_eq!(prepare(blob), blob);
    }

    #[test]
    fn plain_url_untouched() {
        let s = "postgresql://ranai_user:ranai_pass_2026@localhost:5434/ranai";
        assert_eq!(prepare(s), s);
    }
}
