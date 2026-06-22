//! 資料匯出（Navicat 風格的多格式選項）。
//!
//! 尊重目前的篩選 / 排序 / AND·OR，將表格資料匯出成 CSV / TSV / JSON / SQL / Markdown。
//! 透過分頁逐批向 driver 取資料（避免一次撈爆），組好後一次寫檔。

use serde::{Deserialize, Serialize};

use crate::db::DataQuery;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

/// 匯出選項。
#[derive(Debug, Deserialize)]
pub struct ExportOptions {
    /// csv | tsv | json | sql | markdown
    pub format: String,
    #[serde(default = "yes")]
    pub include_header: bool,
    /// CSV/TSV 自訂分隔字元；未指定則 csv=","、tsv="\t"。
    #[serde(default)]
    pub delimiter: Option<String>,
    /// NULL 在 CSV/TSV 的呈現（預設空字串）。
    #[serde(default)]
    pub null_text: Option<String>,
    /// SQL 匯出的目標表名（預設用來源表名）。
    #[serde(default)]
    pub sql_table: Option<String>,
    /// true = 匯出全部符合列；false = 只匯出目前這一頁。
    #[serde(default = "yes")]
    pub all_rows: bool,
    /// 在檔首寫 UTF-8 BOM（方便 Excel 開 CSV）。
    #[serde(default)]
    pub bom: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
    pub format: String,
}

/// 一次取多少列。
const PAGE_SIZE: u32 = 2000;
/// 安全上限，避免極大表把記憶體撐爆。
const MAX_ROWS: usize = 1_000_000;

pub async fn export(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    table: &str,
    query: &DataQuery,
    opts: &ExportOptions,
    out_path: &str,
) -> AppResult<ExportResult> {
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut page: u32 = 0;

    loop {
        let q = DataQuery {
            page,
            page_size: PAGE_SIZE,
            filters: query.filters.clone(),
            sorts: query.sorts.clone(),
            match_any: query.match_any,
        };
        let pd = manager.table_data(id, database, table, &q).await?;
        if page == 0 {
            columns = pd.columns.clone();
        }
        let fetched = pd.rows.len();
        rows.extend(pd.rows);

        if !opts.all_rows {
            break;
        }
        if fetched < PAGE_SIZE as usize {
            break;
        }
        if rows.len() >= MAX_ROWS {
            break;
        }
        if (rows.len() as u64) >= pd.total_rows {
            break;
        }
        page += 1;
    }

    let bytes = render(&columns, &rows, opts, table)?;
    tokio::fs::write(out_path, &bytes)
        .await
        .map_err(|e| AppError::Query(format!("寫入檔案失敗：{e}")))?;

    Ok(ExportResult {
        path: out_path.to_string(),
        rows: rows.len() as u64,
        bytes: bytes.len() as u64,
        format: opts.format.clone(),
    })
}

/// 匯出整個資料庫的結構（所有表的建表 SQL，依 `table_ddl` 串接）。致敬 Navicat / DBeaver 的
/// 「轉儲結構」。不支援 `table_ddl` 的表（如 Mongo 集合）會被略過。
pub async fn schema_dump(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
) -> AppResult<String> {
    let tables = manager.list_tables(id, database).await?;
    let mut out = String::new();
    for t in &tables {
        if let Ok(ddl) = manager.table_ddl(id, database, &t.name).await {
            let ddl = ddl.trim().trim_end_matches(';');
            if ddl.is_empty() {
                continue;
            }
            out.push_str(ddl);
            out.push_str(";\n\n");
        }
    }
    if out.is_empty() {
        return Err(AppError::Query(
            "沒有可匯出的結構（此資料庫無資料表或不支援建表 SQL）".to_string(),
        ));
    }
    Ok(out)
}

fn render(
    columns: &[String],
    rows: &[Vec<Option<String>>],
    opts: &ExportOptions,
    table: &str,
) -> AppResult<Vec<u8>> {
    match opts.format.as_str() {
        "csv" | "tsv" => {
            // 空字串分隔符會產生無法解析的輸出，視為未指定並退回格式預設。
            let delim = opts
                .delimiter
                .clone()
                .filter(|d| !d.is_empty())
                .unwrap_or_else(|| if opts.format == "tsv" { "\t".into() } else { ",".into() });
            let nullt = opts.null_text.clone().unwrap_or_default();
            let mut out = String::new();
            if opts.bom {
                out.push('\u{FEFF}');
            }
            if opts.include_header {
                out.push_str(
                    &columns.iter().map(|c| csv_field(c, &delim)).collect::<Vec<_>>().join(&delim),
                );
                out.push_str("\r\n");
            }
            for row in rows {
                let line = row
                    .iter()
                    .map(|v| match v {
                        Some(s) => csv_field(s, &delim),
                        None => nullt.clone(),
                    })
                    .collect::<Vec<_>>()
                    .join(&delim);
                out.push_str(&line);
                out.push_str("\r\n");
            }
            Ok(out.into_bytes())
        }
        "json" => {
            let arr: Vec<serde_json::Map<String, serde_json::Value>> = rows
                .iter()
                .map(|row| {
                    let mut m = serde_json::Map::new();
                    for (i, c) in columns.iter().enumerate() {
                        let v = row.get(i).and_then(|x| x.clone());
                        m.insert(
                            c.clone(),
                            v.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null),
                        );
                    }
                    m
                })
                .collect();
            serde_json::to_vec_pretty(&arr).map_err(|e| AppError::Query(e.to_string()))
        }
        "sql" => {
            let tbl = opts.sql_table.clone().unwrap_or_else(|| table.to_string());
            let qtbl = format!("`{}`", tbl.replace('`', "``"));
            let collist = columns
                .iter()
                .map(|c| format!("`{}`", c.replace('`', "``")))
                .collect::<Vec<_>>()
                .join(", ");
            let mut out = String::new();
            for row in rows {
                let vals = row
                    .iter()
                    .map(|v| match v {
                        Some(s) => sql_quote(s),
                        None => "NULL".to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                out.push_str(&format!("INSERT INTO {qtbl} ({collist}) VALUES ({vals});\n"));
            }
            Ok(out.into_bytes())
        }
        "markdown" => {
            let mut out = String::new();
            out.push_str("| ");
            out.push_str(&columns.iter().map(|c| md_cell(c)).collect::<Vec<_>>().join(" | "));
            out.push_str(" |\n| ");
            out.push_str(&columns.iter().map(|_| "---").collect::<Vec<_>>().join(" | "));
            out.push_str(" |\n");
            for row in rows {
                out.push_str("| ");
                out.push_str(
                    &row.iter()
                        .map(|v| match v {
                            Some(s) => md_cell(s),
                            None => String::new(),
                        })
                        .collect::<Vec<_>>()
                        .join(" | "),
                );
                out.push_str(" |\n");
            }
            Ok(out.into_bytes())
        }
        other => Err(AppError::Query(format!("不支援的匯出格式：{other}"))),
    }
}

fn csv_field(s: &str, delim: &str) -> String {
    // 公式注入（CSV injection / DDE）防護：以 = + - @ 或 tab/CR 開頭的值，
    // 前置單引號，避免試算表（Excel / Sheets）把它當公式執行。
    let guarded = if s.starts_with(['=', '+', '-', '@', '\t', '\r']) {
        format!("'{s}")
    } else {
        s.to_string()
    };
    if guarded.contains(delim) || guarded.contains('"') || guarded.contains('\n') || guarded.contains('\r') {
        format!("\"{}\"", guarded.replace('"', "\"\""))
    } else {
        guarded
    }
}

// SQL 字串字面值跳脫。此匯出走 MySQL 方言（反引號識別字），故同時跳脫反斜線
// （MySQL 預設把 \ 視為字串轉義字元；只 double 單引號會在含 \ 的值產生錯誤 / 不安全結果）。
fn sql_quote(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\r', "").replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_field_guards_formula_injection() {
        // 以 = + - @ 開頭 → 前置單引號，避免試算表當公式執行。
        assert_eq!(csv_field("=cmd()", ","), "'=cmd()");
        assert_eq!(csv_field("+1", ","), "'+1");
        assert_eq!(csv_field("-1", ","), "'-1");
        assert_eq!(csv_field("@x", ","), "'@x");
        // 一般值不變。
        assert_eq!(csv_field("hello", ","), "hello");
        // 含分隔符 / 引號 → 以雙引號包裹並把內部引號加倍。
        assert_eq!(csv_field("a,b", ","), "\"a,b\"");
        assert_eq!(csv_field("a\"b", ","), "\"a\"\"b\"");
        // 公式開頭 + 含逗號 → 先前置單引號，再整體包引號。
        assert_eq!(csv_field("=a,b", ","), "\"'=a,b\"");
    }

    #[test]
    fn sql_quote_escapes_backslash_and_quote() {
        assert_eq!(sql_quote("plain"), "'plain'");
        assert_eq!(sql_quote("O'Brien"), "'O''Brien'");
        // MySQL 方言：反斜線需加倍，否則含 \ 的值會被誤當轉義。
        assert_eq!(sql_quote("a\\b"), "'a\\\\b'");
        assert_eq!(sql_quote("\\'"), "'\\\\'''");
    }

    // ---- render() 端到端輸出（驗證整個匯出管線，不只 helper）----

    fn opts(format: &str) -> ExportOptions {
        ExportOptions {
            format: format.to_string(),
            include_header: true,
            delimiter: None,
            null_text: None,
            sql_table: None,
            all_rows: true,
            bom: false,
        }
    }

    fn cols(cs: &[&str]) -> Vec<String> {
        cs.iter().map(|s| s.to_string()).collect()
    }

    fn row(vs: &[Option<&str>]) -> Vec<Option<String>> {
        vs.iter().map(|v| v.map(|s| s.to_string())).collect()
    }

    fn render_str(columns: &[String], rows: &[Vec<Option<String>>], o: &ExportOptions) -> String {
        String::from_utf8(render(columns, rows, o, "t").unwrap()).unwrap()
    }

    #[test]
    fn render_csv_quoting_null_and_formula_guard() {
        let columns = cols(&["id", "name"]);
        let rows = vec![
            row(&[Some("1"), Some("a,b")]), // 含逗號 → 包雙引號
            row(&[Some("2"), None]),        // NULL → 預設空字串
            row(&[Some("3"), Some("=cmd")]), // 公式開頭 → 前置單引號
        ];
        let out = render_str(&columns, &rows, &opts("csv"));
        assert_eq!(out, "id,name\r\n1,\"a,b\"\r\n2,\r\n3,'=cmd\r\n");
    }

    #[test]
    fn render_csv_respects_custom_null_text_and_no_header() {
        let columns = cols(&["a"]);
        let rows = vec![row(&[None])];
        let mut o = opts("csv");
        o.include_header = false;
        o.null_text = Some("\\N".into());
        assert_eq!(render_str(&columns, &rows, &o), "\\N\r\n");
    }

    #[test]
    fn render_csv_bom_prefix() {
        let columns = cols(&["a"]);
        let rows = vec![row(&[Some("x")])];
        let mut o = opts("csv");
        o.bom = true;
        let bytes = render(&columns, &rows, &o, "t").unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF], "應以 UTF-8 BOM 開頭");
    }

    #[test]
    fn render_tsv_uses_tab_delimiter() {
        let columns = cols(&["a", "b"]);
        let rows = vec![row(&[Some("1"), Some("2")])];
        assert_eq!(render_str(&columns, &rows, &opts("tsv")), "a\tb\r\n1\t2\r\n");
    }

    #[test]
    fn render_sql_quotes_idents_and_values() {
        let columns = cols(&["id", "name"]);
        let rows = vec![row(&[Some("1"), Some("O'Brien")]), row(&[Some("2"), None])];
        let out = render_str(&columns, &rows, &opts("sql"));
        assert_eq!(
            out,
            "INSERT INTO `t` (`id`, `name`) VALUES ('1', 'O''Brien');\n\
             INSERT INTO `t` (`id`, `name`) VALUES ('2', NULL);\n"
        );
    }

    #[test]
    fn render_json_maps_null_and_strings() {
        let columns = cols(&["id", "name"]);
        let rows = vec![row(&[Some("1"), None])];
        let out = render_str(&columns, &rows, &opts("json"));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v[0]["id"], serde_json::json!("1"));
        assert_eq!(v[0]["name"], serde_json::Value::Null);
    }

    #[test]
    fn render_json_preserves_source_column_order() {
        // 來源欄序 name 在前（字母序則 id 在前）；preserve_order 應讓輸出保留來源欄序。
        let columns = cols(&["name", "id"]);
        let rows = vec![row(&[Some("a"), Some("1")])];
        let out = render_str(&columns, &rows, &opts("json"));
        assert!(
            out.find("\"name\"").unwrap() < out.find("\"id\"").unwrap(),
            "JSON 匯出欄序應保留來源欄序（非字母重排）：{out}"
        );
    }

    #[test]
    fn render_markdown_escapes_pipes() {
        let columns = cols(&["a"]);
        let rows = vec![row(&[Some("x|y")])];
        let out = render_str(&columns, &rows, &opts("markdown"));
        assert!(out.contains("x\\|y"), "markdown 應跳脫 |：{out}");
        assert!(out.contains("| a |"));
    }

    #[test]
    fn render_rejects_unknown_format() {
        let columns = cols(&["a"]);
        let rows = vec![row(&[Some("x")])];
        assert!(render(&columns, &rows, &opts("xml"), "t").is_err());
    }
}
