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

    let mut rows = parse_csv(content, delim);
    if rows.is_empty() {
        return Err(AppError::Query("CSV 沒有任何資料列".to_string()));
    }

    // 決定欄名。
    let columns: Vec<String> = if opts.has_header {
        rows.remove(0)
    } else {
        opts.columns
            .clone()
            .ok_or_else(|| AppError::Query("未提供欄名（無表頭時必填 columns）".to_string()))?
    };
    if columns.is_empty() {
        return Err(AppError::Query("欄名為空".to_string()));
    }

    let mut result = ImportResult::default();
    for (i, row) in rows.iter().enumerate() {
        // 行號（1-based，含表頭偏移）供錯誤訊息定位。
        let line_no = if opts.has_header { i + 2 } else { i + 1 };
        if row.iter().all(|c| c.is_empty()) {
            continue; // 略過全空白列
        }
        if row.len() != columns.len() {
            let msg = format!("第 {line_no} 列欄數 {} 與表頭 {} 不符", row.len(), columns.len());
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
                if opts.empty_as_null && v.is_empty() {
                    None
                } else {
                    Some(v.clone())
                }
            })
            .collect();
        let ins = RowInsert { columns: columns.clone(), values };
        match manager.insert_row(id, database, table, &ins).await {
            Ok(_) => result.imported += 1,
            Err(e) => {
                result.failed += 1;
                if result.errors.len() < MAX_ERRORS {
                    result.errors.push(format!("第 {line_no} 列：{e}"));
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
}
