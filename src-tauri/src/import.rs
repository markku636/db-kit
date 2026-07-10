//! 資料匯入（CSV → 資料表）。致敬 Navicat / DBeaver 的匯入精靈。
//!
//! 流程：解析 CSV（RFC4180：引號欄位可含分隔符 / 換行 / "" 轉義）→ 以第一列為欄名（或指定欄名）
//! → 逐列透過 driver 的 insert_row 寫入（沿用嚴格型別的參數轉型修正，整數 / 時間欄位也能匯入）。
//! 空欄位可選擇視為 NULL（預設開，避免把空字串塞進數值欄而失敗）。

use serde::{Deserialize, Serialize};

use crate::db::RowInsert;
use crate::error::{AppError, AppResult};
use crate::manager::ConnectionManager;

#[derive(Debug, Deserialize)]
pub struct ImportOptions {
    /// 分隔字元；未指定則為 ","。
    #[serde(default)]
    pub delimiter: Option<String>,
    /// 第一列是否為欄名。
    #[serde(default = "yes")]
    pub has_header: bool,
    /// 空字串欄位是否視為 NULL（預設開）。
    #[serde(default = "yes")]
    pub empty_as_null: bool,
    /// 無表頭時的欄名（has_header=false 時必填）。
    #[serde(default)]
    pub columns: Option<Vec<String>>,
    /// 任一列失敗即中止（預設關：盡量匯入，回報失敗列數與前幾筆錯誤）。
    #[serde(default)]
    pub stop_on_error: bool,
    /// 去除每格前後空白（資料清理；於 empty→NULL 判定前套用）。預設關。
    #[serde(default)]
    pub trim: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Serialize, Default)]
pub struct ImportResult {
    pub imported: u64,
    pub failed: u64,
    /// 前幾筆錯誤訊息（含列號），方便使用者定位問題。
    pub errors: Vec<String>,
}

/// 最多保留的錯誤訊息數（避免回傳爆量）。
const MAX_ERRORS: usize = 20;

/// 解析 CSV 文字為列 → 欄的二維字串。RFC4180：
/// - 欄以 `delimiter` 分隔，列以換行分隔（吃 `\n`，`\r` 略過以相容 CRLF）。
/// - 欄可用雙引號包裹，內部可含分隔符 / 換行 / `""`（轉義為單一 `"`）。
/// - 引號僅在欄起始處才視為「開始引號」；非起始的引號視為字面字元。
/// - 去除開頭 UTF-8 BOM（Excel 匯出的 CSV 常見）；否則第一欄欄名會被前置 `\u{FEFF}`。
pub fn parse_csv(content: &str, delimiter: char) -> Vec<Vec<String>> {
    let content = content.strip_prefix('\u{FEFF}').unwrap_or(content);
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    // 該欄是否「已開始」（用以正確處理空欄 / 引號空欄與列尾的 flush）。
    let mut field_active = false;
    let mut chars = content.chars().peekable();

    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
            continue;
        }
        if c == '"' && field.is_empty() {
            in_quotes = true;
            field_active = true;
        } else if c == delimiter {
            record.push(std::mem::take(&mut field));
            field_active = false; // 分隔後開始下一個（尚未開始的）欄
        } else if c == '\n' {
            record.push(std::mem::take(&mut field));
            records.push(std::mem::take(&mut record));
            field_active = false;
        } else if c == '\r' {
            // 略過（CRLF 的 \r）；\n 才是列終止。
        } else {
            field.push(c);
            field_active = true;
        }
    }
    // 收尾：若最後一欄 / 列尚未 flush（檔案結尾無換行）。
    if field_active || !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    records
}

pub async fn import_csv(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    table: &str,
    content: &str,
    opts: &ImportOptions,
) -> AppResult<ImportResult> {
    let delim = opts
        .delimiter
        .as_deref()
        .and_then(|d| d.chars().next())
        .unwrap_or(',');
    let rows = parse_csv(content, delim);
    import_rows(manager, id, database, table, rows, opts).await
}

/// Excel (.xlsx/.xls) → 二維字串。取第一張工作表的使用範圍；calamine 會把不齊列補空格，
/// 故每列欄數一致（利於與表頭比對）。儲存格依型別轉成字串（日期 → `YYYY-MM-DD HH:MM:SS`、
/// 整數型浮點去小數），空格為空字串。去除尾端全空白列（Excel 殘留空列）。
pub fn parse_xlsx(bytes: &[u8]) -> AppResult<Vec<Vec<String>>> {
    use calamine::{Reader, Xlsx};
    use std::io::Cursor;

    let mut wb: Xlsx<_> = Xlsx::new(Cursor::new(bytes))
        .map_err(|e| AppError::Query(tf!("讀取 Excel 失敗：{e}", e = e)))?;
    let sheet = wb
        .sheet_names()
        .first()
        .cloned()
        .ok_or_else(|| AppError::Query(t!("Excel 沒有任何工作表").to_string()))?;
    let range = wb
        .worksheet_range(&sheet)
        .map_err(|e| AppError::Query(tf!("讀取工作表「{sheet}」失敗：{e}", sheet = sheet, e = e)))?;

    let mut out: Vec<Vec<String>> = range
        .rows()
        .map(|row| row.iter().map(cell_to_string).collect())
        .collect();
    while out
        .last()
        .map(|r| r.iter().all(|c| c.is_empty()))
        .unwrap_or(false)
    {
        out.pop();
    }
    Ok(out)
}

/// 單一儲存格 → 字串（保真為主）。
fn cell_to_string(d: &calamine::Data) -> String {
    use calamine::Data;
    match d {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Bool(b) => b.to_string(),
        Data::Int(i) => i.to_string(),
        // Excel 內部以 f64 存數字；整數型浮點去掉 .0，其餘以最短往返表示。
        Data::Float(f) => {
            if f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15 {
                (*f as i64).to_string()
            } else {
                f.to_string()
            }
        }
        Data::DateTime(dt) => dt
            .as_datetime()
            .map(|x| x.format("%Y-%m-%d %H:%M:%S").to_string())
            .unwrap_or_else(|| dt.to_string()),
        // 公式錯誤格（#DIV/0! 等）→ 空字串，避免把錯誤文字塞進資料。
        Data::Error(_) => String::new(),
    }
}

/// Excel 匯入：解析 + 與 CSV 共用同一套寫入邏輯（型別轉型 / 空→NULL / 錯誤回報）。
pub async fn import_xlsx(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    table: &str,
    bytes: &[u8],
    opts: &ImportOptions,
) -> AppResult<ImportResult> {
    let rows = parse_xlsx(bytes)?;
    import_rows(manager, id, database, table, rows, opts).await
}

/// 匯入預覽（致敬 Navicat 匯入精靈的預覽 + 欄位對應）：欄名、前幾列、總列數。
#[derive(Debug, Serialize)]
pub struct ImportPreview {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_rows: u64,
}

/// 純函式：由解析後的二維字串組預覽。決定欄名（columns 覆蓋 > 表頭 > col1..colN），
/// 回傳（欄名、前 limit 筆資料列、總資料列數）。供單元測試。
pub fn build_preview(
    mut rows: Vec<Vec<String>>,
    has_header: bool,
    columns_override: Option<Vec<String>>,
    limit: usize,
) -> (Vec<String>, Vec<Vec<String>>, u64) {
    let header = if has_header && !rows.is_empty() { Some(rows.remove(0)) } else { None };
    let columns = columns_override
        .filter(|c| !c.is_empty())
        .or(header)
        .unwrap_or_else(|| {
            let n = rows.first().map(|r| r.len()).unwrap_or(0);
            (1..=n).map(|i| format!("col{i}")).collect()
        });
    let total = rows.len() as u64;
    let preview = rows.into_iter().take(limit).collect();
    (columns, preview, total)
}

/// 共用列寫入：由二維字串（含可選表頭）逐列 insert_row。CSV / Excel 匯入皆走此。
async fn import_rows(
    manager: &ConnectionManager,
    id: &str,
    database: &str,
    table: &str,
    mut rows: Vec<Vec<String>>,
    opts: &ImportOptions,
) -> AppResult<ImportResult> {
    if rows.is_empty() {
        return Err(AppError::Query(t!("沒有任何資料列").to_string()));
    }

    // 決定欄名。has_header 時先吃掉表頭列；欄名以 opts.columns 覆蓋為優先（致敬 Navicat 匯入欄位對應，
    // 可把不一致的檔案表頭對齊到目標欄位），否則用表頭列；無表頭又無覆蓋則報錯。
    let header_row = if opts.has_header && !rows.is_empty() {
        Some(rows.remove(0))
    } else {
        None
    };
    let override_cols = opts.columns.clone().filter(|c| !c.is_empty());
    let columns: Vec<String> = match (override_cols, header_row) {
        (Some(over), _) => over,
        (None, Some(header)) => header,
        (None, None) => {
            return Err(AppError::Query(t!("未提供欄名（無表頭時必填 columns）").to_string()))
        }
    };
    if columns.is_empty() {
        return Err(AppError::Query(t!("欄名為空").to_string()));
    }

    let mut result = ImportResult::default();
    for (i, row) in rows.iter().enumerate() {
        // 行號（1-based，含表頭偏移）供錯誤訊息定位。
        let line_no = if opts.has_header { i + 2 } else { i + 1 };
        // 略過全空白列；trim 開啟時純空白（trim 後為空）亦視為空白列，
        // 否則會插入一整列 NULL（auto-PK 表更會無聲產生雜訊列）。
        let blank = row
            .iter()
            .all(|c| if opts.trim { c.trim().is_empty() } else { c.is_empty() });
        if blank {
            continue;
        }
        if row.len() != columns.len() {
            let msg = tf!(
                "第 {line_no} 列欄數 {got} 與表頭 {want} 不符",
                line_no = line_no,
                got = row.len(),
                want = columns.len()
            );
            result.failed += 1;
            if result.errors.len() < MAX_ERRORS {
                result.errors.push(msg.clone());
            }
            if opts.stop_on_error {
                return Err(AppError::Query(msg));
            }
            continue;
        }
        let values: Vec<Option<String>> = row
            .iter()
            .map(|v| {
                let s = if opts.trim { v.trim() } else { v.as_str() };
                if opts.empty_as_null && s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                }
            })
            .collect();
        let ins = RowInsert { columns: columns.clone(), values };
        match manager.insert_row(id, database, table, &ins).await {
            Ok(_) => result.imported += 1,
            Err(e) => {
                result.failed += 1;
                if result.errors.len() < MAX_ERRORS {
                    result.errors.push(tf!("第 {line_no} 列：{e}", line_no = line_no, e = e));
                }
                if opts.stop_on_error {
                    return Err(e);
                }
            }
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::parse_csv;

    fn rows(content: &str) -> Vec<Vec<String>> {
        parse_csv(content, ',')
    }

    #[test]
    fn simple_rows() {
        assert_eq!(rows("a,b,c\n1,2,3"), vec![
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec!["1".to_string(), "2".to_string(), "3".to_string()],
        ]);
    }

    #[test]
    fn trailing_newline_no_extra_record() {
        assert_eq!(rows("a,b\n1,2\n"), vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["1".to_string(), "2".to_string()],
        ]);
    }

    #[test]
    fn crlf_handled() {
        assert_eq!(rows("a,b\r\n1,2\r\n"), vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["1".to_string(), "2".to_string()],
        ]);
    }

    #[test]
    fn quoted_field_with_comma_and_newline() {
        let got = rows("name,note\n\"Smith, John\",\"line1\nline2\"");
        assert_eq!(got, vec![
            vec!["name".to_string(), "note".to_string()],
            vec!["Smith, John".to_string(), "line1\nline2".to_string()],
        ]);
    }

    #[test]
    fn escaped_doubled_quotes() {
        // "He said ""hi""" → He said "hi"
        let got = rows("v\n\"He said \"\"hi\"\"\"");
        assert_eq!(got, vec![vec!["v".to_string()], vec!["He said \"hi\"".to_string()]]);
    }

    #[test]
    fn empty_and_trailing_fields() {
        assert_eq!(rows("a,,c"), vec![vec!["a".to_string(), "".to_string(), "c".to_string()]]);
        assert_eq!(rows("a,b,"), vec![vec!["a".to_string(), "b".to_string(), "".to_string()]]);
        assert_eq!(rows(",,"), vec![vec!["".to_string(), "".to_string(), "".to_string()]]);
    }

    #[test]
    fn quoted_empty_field() {
        // a,"" → ["a", ""]
        assert_eq!(rows("a,\"\""), vec![vec!["a".to_string(), "".to_string()]]);
    }

    #[test]
    fn custom_delimiter_via_tab() {
        assert_eq!(parse_csv("a\tb\n1\t2", '\t'), vec![
            vec!["a".to_string(), "b".to_string()],
            vec!["1".to_string(), "2".to_string()],
        ]);
    }

    #[test]
    fn delimiter_inside_quotes_not_split_with_tab() {
        assert_eq!(parse_csv("\"a\tb\"\tc", '\t'), vec![vec!["a\tb".to_string(), "c".to_string()]]);
    }

    #[test]
    fn empty_input_no_records() {
        assert!(rows("").is_empty());
    }

    #[test]
    fn strips_leading_utf8_bom() {
        // Excel 匯出的 CSV 常以 BOM 開頭；第一欄欄名不應被前置 \u{FEFF}。
        let got = parse_csv("\u{FEFF}id,name\n1,a", ',');
        assert_eq!(got, vec![
            vec!["id".to_string(), "name".to_string()],
            vec!["1".to_string(), "a".to_string()],
        ]);
        // 確認第一欄是乾淨的 "id"（不含 BOM）。
        assert_eq!(got[0][0], "id");
    }

    // ---- Excel 匯入：以 rust_xlsxwriter 產一個活頁簿再讀回，端到端驗證 parse_xlsx ----
    #[test]
    fn parse_xlsx_roundtrip_types_and_blanks() {
        use rust_xlsxwriter::Workbook;
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        // 表頭
        ws.write_string(0, 0, "id").unwrap();
        ws.write_string(0, 1, "name").unwrap();
        ws.write_string(0, 2, "price").unwrap();
        // 列 1：整數型浮點去 .0、字串、含小數
        ws.write_number(1, 0, 1.0).unwrap();
        ws.write_string(1, 1, "apple").unwrap();
        ws.write_number(1, 2, 9.99).unwrap();
        // 列 2：name 留空（空白格）
        ws.write_number(2, 0, 2.0).unwrap();
        ws.write_number(2, 2, 0.0).unwrap();
        let bytes = wb.save_to_buffer().unwrap();

        let got = super::parse_xlsx(&bytes).unwrap();
        assert_eq!(got[0], vec!["id", "name", "price"]);
        assert_eq!(got[1], vec!["1", "apple", "9.99"]);
        // 空白格 → 空字串；整數型浮點 → 無小數。
        assert_eq!(got[2], vec!["2", "", "0"]);
    }

    #[test]
    fn parse_xlsx_rejects_non_xlsx_bytes() {
        assert!(super::parse_xlsx(b"not a real xlsx").is_err());
    }

    #[test]
    fn build_preview_header_and_limit() {
        let rows = vec![
            vec!["id".into(), "name".into()],
            vec!["1".into(), "a".into()],
            vec!["2".into(), "b".into()],
            vec!["3".into(), "c".into()],
        ];
        let (cols, prev, total) = super::build_preview(rows, true, None, 2);
        assert_eq!(cols, vec!["id".to_string(), "name".to_string()]);
        assert_eq!(prev.len(), 2, "預覽限 2 列");
        assert_eq!(total, 3, "總資料列 3（不含表頭）");
    }

    #[test]
    fn build_preview_override_and_no_header() {
        let rows = vec![vec!["1".into(), "a".into()]];
        // 無表頭 + 無覆蓋 → col1..colN。
        let (cols, _, total) = super::build_preview(rows.clone(), false, None, 10);
        assert_eq!(cols, vec!["col1".to_string(), "col2".to_string()]);
        assert_eq!(total, 1);
        // 覆蓋優先；has_header 時仍吃掉表頭列。
        let (cols2, prev2, total2) =
            super::build_preview(rows, true, Some(vec!["x".into(), "y".into()]), 10);
        assert_eq!(cols2, vec!["x".to_string(), "y".to_string()]);
        assert_eq!(total2, 0, "唯一列被當表頭吃掉");
        assert!(prev2.is_empty());
    }
}
