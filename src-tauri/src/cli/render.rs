//! 輸出渲染：table（手刻對齊 ASCII）/ csv / json。無外部相依。

use serde::Serialize;

use super::args::Format;

/// 以指定格式輸出「欄位 + 列」結果（query / table data / 鍵清單等字串型結果）。
pub fn emit(fmt: Format, columns: &[String], rows: &[Vec<Option<String>>]) {
    match fmt {
        Format::Table => print_table(columns, rows),
        Format::Csv => print_csv(columns, rows),
        Format::Json => print_json(columns, rows),
    }
}

/// 單欄字串清單（如資料庫清單 / Redis 鍵）。
pub fn emit_list(fmt: Format, header: &str, items: &[String]) {
    let columns = vec![header.to_string()];
    let rows: Vec<Vec<Option<String>>> = items.iter().map(|s| vec![Some(s.clone())]).collect();
    emit(fmt, &columns, &rows);
}

/// (欄位, 值) 兩欄清單（如 table info / server section）。
pub fn emit_pairs(fmt: Format, items: &[(String, String)]) {
    let columns = vec!["field".to_string(), "value".to_string()];
    let rows: Vec<Vec<Option<String>>> = items
        .iter()
        .map(|(k, v)| vec![Some(k.clone()), Some(v.clone())])
        .collect();
    emit(fmt, &columns, &rows);
}

/// 輸出任意可序列化結果（結構化型別清單）。
/// json → serde pretty；table/csv → 由 JSON 推導欄位（陣列物件取鍵聯集；單一物件轉 key-value）。
pub fn emit_value<T: Serialize>(fmt: Format, value: &T) {
    let val = serde_json::to_value(value).unwrap_or(serde_json::Value::Null);
    if let Format::Json = fmt {
        println!(
            "{}",
            serde_json::to_string_pretty(&val).unwrap_or_else(|_| "null".into())
        );
        return;
    }
    match val {
        serde_json::Value::Array(arr) => {
            let mut columns: Vec<String> = Vec::new();
            for item in &arr {
                if let serde_json::Value::Object(m) = item {
                    for k in m.keys() {
                        if !columns.iter().any(|c| c == k) {
                            columns.push(k.clone());
                        }
                    }
                }
            }
            if columns.is_empty() {
                // 純量陣列（如 Vec<String>）。
                let rows: Vec<Vec<Option<String>>> =
                    arr.iter().map(|v| vec![json_scalar(v)]).collect();
                emit(fmt, &["value".to_string()], &rows);
                return;
            }
            let rows: Vec<Vec<Option<String>>> = arr
                .iter()
                .map(|item| {
                    columns
                        .iter()
                        .map(|c| item.get(c).and_then(|v| json_scalar(v)))
                        .collect()
                })
                .collect();
            emit(fmt, &columns, &rows);
        }
        serde_json::Value::Object(m) => {
            let columns = vec!["field".to_string(), "value".to_string()];
            let rows: Vec<Vec<Option<String>>> = m
                .iter()
                .map(|(k, v)| vec![Some(k.clone()), json_scalar(v)])
                .collect();
            emit(fmt, &columns, &rows);
        }
        other => {
            if let Some(s) = json_scalar(&other) {
                println!("{s}");
            }
        }
    }
}

/// 將 JSON 值轉成單格顯示字串（null → None；巢狀 → 緊湊 JSON）。
fn json_scalar(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        other => Some(other.to_string()),
    }
}

fn print_table(columns: &[String], rows: &[Vec<Option<String>>]) {
    if columns.is_empty() {
        println!("{}", t!("(空結果)"));
        return;
    }
    let n = columns.len();
    let mut widths: Vec<usize> = columns.iter().map(|c| disp_width(c)).collect();
    let clean_rows: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            (0..n)
                .map(|i| clean_cell(row.get(i).and_then(|v| v.as_deref()).unwrap_or("")))
                .collect()
        })
        .collect();
    for row in &clean_rows {
        for i in 0..n {
            let w = disp_width(&row[i]);
            if w > widths[i] {
                widths[i] = w;
            }
        }
    }
    println!("{}", render_row(columns, &widths));
    let sep = widths
        .iter()
        .map(|w| "-".repeat(*w))
        .collect::<Vec<_>>()
        .join("-+-");
    println!("{sep}");
    for row in &clean_rows {
        println!("{}", render_row(row, &widths));
    }
    println!("{}", tf!("({n} 列)", n = rows.len()));
}

fn render_row<S: AsRef<str>>(cells: &[S], widths: &[usize]) -> String {
    cells
        .iter()
        .enumerate()
        .map(|(i, c)| pad(c.as_ref(), widths[i]))
        .collect::<Vec<_>>()
        .join(" | ")
}

fn clean_cell(s: &str) -> String {
    s.chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect()
}

fn pad(s: &str, width: usize) -> String {
    let w = disp_width(s);
    if w >= width {
        s.to_string()
    } else {
        let mut out = String::with_capacity(s.len() + (width - w));
        out.push_str(s);
        out.extend(std::iter::repeat(' ').take(width - w));
        out
    }
}

/// 近似顯示寬度（無 unicode-width 相依）：常見 CJK / 全形 / emoji 視為寬度 2。
fn disp_width(s: &str) -> usize {
    s.chars().map(char_width).sum()
}

fn char_width(c: char) -> usize {
    let u = c as u32;
    if (0x1100..=0x115F).contains(&u)        // Hangul Jamo
        || (0x2E80..=0xA4CF).contains(&u)    // CJK 部首 / 假名 / CJK 統一表意 …
        || (0xAC00..=0xD7A3).contains(&u)    // Hangul 音節
        || (0xF900..=0xFAFF).contains(&u)    // CJK 相容表意
        || (0xFE30..=0xFE4F).contains(&u)    // CJK 相容形式
        || (0xFF00..=0xFF60).contains(&u)    // 全形 ASCII
        || (0xFFE0..=0xFFE6).contains(&u)    // 全形符號
        || (0x1F300..=0x1FAFF).contains(&u)  // emoji（近似）
        || (0x20000..=0x3FFFD).contains(&u)  // CJK 擴充 B+
    {
        2
    } else {
        1
    }
}

fn print_csv(columns: &[String], rows: &[Vec<Option<String>>]) {
    let mut out = String::new();
    out.push_str(
        &columns
            .iter()
            .map(|c| csv_field(c))
            .collect::<Vec<_>>()
            .join(","),
    );
    out.push('\n');
    for row in rows {
        let line = (0..columns.len())
            .map(|i| match row.get(i).and_then(|v| v.as_ref()) {
                Some(s) => csv_field(s),
                None => String::new(),
            })
            .collect::<Vec<_>>()
            .join(",");
        out.push_str(&line);
        out.push('\n');
    }
    print!("{out}");
}

fn csv_field(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn print_json(columns: &[String], rows: &[Vec<Option<String>>]) {
    let arr: Vec<serde_json::Map<String, serde_json::Value>> = rows
        .iter()
        .map(|row| {
            let mut m = serde_json::Map::new();
            for (i, c) in columns.iter().enumerate() {
                let v = row.get(i).and_then(|x| x.clone());
                m.insert(
                    c.clone(),
                    v.map(serde_json::Value::String)
                        .unwrap_or(serde_json::Value::Null),
                );
            }
            m
        })
        .collect();
    match serde_json::to_string_pretty(&arr) {
        Ok(s) => println!("{s}"),
        Err(e) => eprintln!("{}", tf!("json 序列化失敗：{e}", e = e)),
    }
}
