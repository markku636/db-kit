//! 純函式：mapping / search hits / aggregations 攤平成 db-kit 的 ColumnInfo / QueryResult，
//! 以及 DataQuery.filters → Elasticsearch bool query。單元測試集中於此。

use serde_json::Value;

use crate::db::{ColumnInfo, Filter, QueryResult};

/// 建 ColumnInfo（elastic 只用到 name / data_type / key）。
fn col(name: &str, data_type: &str, key: &str, nullable: bool) -> ColumnInfo {
    ColumnInfo {
        name: name.to_string(),
        data_type: data_type.to_string(),
        nullable,
        key: key.to_string(),
        default: None,
        extra: String::new(),
        comment: String::new(),
    }
}

/// 合成的 `_id` 主鍵欄（每份文件都有）。
fn synthetic_id_column() -> ColumnInfo {
    col("_id", "keyword", "PRI", false)
}

/// 一個 JSON 值投影成資料格字串：null → NULL；字串原樣；物件 / 陣列 / 數字 / 布林 → JSON 文字。
fn value_to_cell(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

/// 單鍵物件 `{key: value}`（避開 json! 巨集不吃動態 key）。
fn single(key: &str, value: Value) -> Value {
    let mut m = serde_json::Map::new();
    m.insert(key.to_string(), value);
    Value::Object(m)
}

// ---- (a) mapping properties → ColumnInfo ----

/// `GET /{index}/_mapping` 回應攤平成欄位清單（含合成 `_id`）。
///
/// 回應形狀：`{ "{index}": { "mappings": { "properties": {...} } } }`；多索引時取首個有 mapping 者。
pub fn mapping_to_columns(resp: &Value) -> Vec<ColumnInfo> {
    let mut out = vec![synthetic_id_column()];
    if let Some(obj) = resp.as_object() {
        for (_index, body) in obj {
            if let Some(props) = body
                .pointer("/mappings/properties")
                .and_then(|p| p.as_object())
            {
                flatten_properties(props, "", &mut out);
                break; // 首個有 mapping 的索引即代表本次查詢
            }
        }
    }
    out
}

/// 遞迴攤平 mapping properties：巢狀物件以 dot path（`user.name`），multi-field 子欄（`title.keyword`）一併列。
fn flatten_properties(
    props: &serde_json::Map<String, Value>,
    prefix: &str,
    out: &mut Vec<ColumnInfo>,
) {
    for (name, spec) in props {
        let path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}.{name}")
        };
        let spec_obj = spec.as_object();
        // 巢狀物件（object / nested）：有 sub-properties → 遞迴到葉節點的 dot path。
        if let Some(sub) = spec_obj
            .and_then(|o| o.get("properties"))
            .and_then(|p| p.as_object())
        {
            flatten_properties(sub, &path, out);
        } else {
            let ty = spec_obj
                .and_then(|o| o.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("object");
            out.push(col(&path, ty, "", true));
        }
        // multi-field 子欄（如 title.keyword）。
        if let Some(fields) = spec_obj
            .and_then(|o| o.get("fields"))
            .and_then(|f| f.as_object())
        {
            for (fname, fspec) in fields {
                let fty = fspec
                    .as_object()
                    .and_then(|o| o.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("keyword");
                out.push(col(&format!("{path}.{fname}"), fty, "", true));
            }
        }
    }
}

// ---- (b) search hits → QueryResult ----

/// `hits.total.value`（ES7+）或 `hits.total`（ES5/6 為純數字）。
pub fn hits_total(resp: &Value) -> u64 {
    match resp.pointer("/hits/total") {
        Some(Value::Object(o)) => o.get("value").and_then(|v| v.as_u64()).unwrap_or(0),
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        _ => 0,
    }
}

/// `_search` 的 hits → QueryResult。
/// columns = `["_id", "_score", ..._source 頂層鍵（依首見順序 union）]`；缺鍵 → NULL。
pub fn hits_to_query_result(resp: &Value) -> QueryResult {
    let empty = Vec::new();
    let hits = resp
        .pointer("/hits/hits")
        .and_then(|h| h.as_array())
        .unwrap_or(&empty);

    // _source 頂層鍵：依首見順序去重。跳過 _id / _score（已是合成欄），避免重複欄頭。
    let mut source_keys: Vec<String> = Vec::new();
    for hit in hits {
        if let Some(src) = hit.get("_source").and_then(|s| s.as_object()) {
            for k in src.keys() {
                if k == "_id" || k == "_score" {
                    continue;
                }
                if !source_keys.iter().any(|x| x == k) {
                    source_keys.push(k.clone());
                }
            }
        }
    }

    let mut columns = vec!["_id".to_string(), "_score".to_string()];
    columns.extend(source_keys.iter().cloned());

    let mut rows = Vec::with_capacity(hits.len());
    for hit in hits {
        let mut row: Vec<Option<String>> = Vec::with_capacity(columns.len());
        row.push(value_to_cell(hit.get("_id").unwrap_or(&Value::Null)));
        row.push(value_to_cell(hit.get("_score").unwrap_or(&Value::Null)));
        let src = hit.get("_source");
        for k in &source_keys {
            match src.and_then(|s| s.get(k)) {
                Some(v) => row.push(value_to_cell(v)),
                None => row.push(None),
            }
        }
        rows.push(row);
    }

    QueryResult {
        columns,
        rows,
        rows_affected: 0,
        truncated: false,
    }
}

// ---- (c) aggregations → QueryResult ----

/// 攤平 aggregations（第一版：單層 bucket / metric-only；無法識別回 fallback 單欄 pretty JSON）。
///
/// 「絕不吞資料」原則：只有能完整表達的形狀才攤平成表，其餘一律走 fallback（誠實顯示完整 JSON）：
/// - metric-only：所有頂層 agg 皆純量 metric（avg/sum/max…）→ 一列多欄。
/// - 單一頂層 bucket agg 且無巢狀子 bucket → 表格。
/// - 其餘（多個頂層 agg 混含 bucket、bucket 內含巢狀 sub-bucket…）→ fallback，不丟兄弟 / 巢狀資料。
pub fn aggs_to_query_result(aggs: &Value) -> QueryResult {
    let obj = match aggs.as_object() {
        Some(o) if !o.is_empty() => o,
        _ => return agg_fallback(aggs),
    };

    // metric-only：每個頂層 agg 都有純量 "value"（avg / sum / max…）→ 一列多欄。
    if obj.values().all(|v| v.get("value").is_some()) {
        let columns: Vec<String> = obj.keys().cloned().collect();
        let row: Vec<Option<String>> = obj
            .values()
            .map(|v| value_to_cell(v.get("value").unwrap_or(&Value::Null)))
            .collect();
        return QueryResult {
            columns,
            rows: vec![row],
            rows_affected: 0,
            truncated: false,
        };
    }

    // 單一頂層 bucket agg（terms / histogram / date_histogram）——多個頂層 agg 時走 fallback，
    // 否則直接取首個會靜默丟掉兄弟 agg（如同層的 metric）。
    if obj.len() == 1 {
        let (name, first) = obj.iter().next().expect("len == 1");
        if let Some(buckets) = first.get("buckets").and_then(|b| b.as_array()) {
            // bucket 內含巢狀子 bucket（超出單層攤平能力）→ fallback，不丟巢狀資料。
            let has_nested = buckets.iter().any(|b| {
                b.as_object().is_some_and(|o| {
                    o.iter().any(|(k, v)| {
                        !matches!(k.as_str(), "key" | "key_as_string" | "doc_count")
                            && v.get("buckets").is_some()
                    })
                })
            });
            if !has_nested {
                return buckets_to_result(name, buckets);
            }
        }
    }

    agg_fallback(aggs)
}

fn buckets_to_result(name: &str, buckets: &[Value]) -> QueryResult {
    // sub-metric 欄：bucket 內非 key/key_as_string/doc_count 且本身是含 "value" 的 metric 物件。
    let mut sub_metrics: Vec<String> = Vec::new();
    for b in buckets {
        if let Some(o) = b.as_object() {
            for (k, v) in o {
                if matches!(k.as_str(), "key" | "key_as_string" | "doc_count") {
                    continue;
                }
                if v.get("value").is_some() && !sub_metrics.iter().any(|x| x == k) {
                    sub_metrics.push(k.clone());
                }
            }
        }
    }

    let mut columns = vec![name.to_string(), "doc_count".to_string()];
    columns.extend(sub_metrics.iter().cloned());

    let mut rows = Vec::with_capacity(buckets.len());
    for b in buckets {
        let mut row: Vec<Option<String>> = Vec::with_capacity(columns.len());
        // key：優先 key_as_string（date_histogram），否則 key。
        let key_val = b
            .get("key_as_string")
            .or_else(|| b.get("key"))
            .unwrap_or(&Value::Null);
        row.push(value_to_cell(key_val));
        row.push(value_to_cell(b.get("doc_count").unwrap_or(&Value::Null)));
        for m in &sub_metrics {
            match b.get(m).and_then(|sub| sub.get("value")) {
                Some(v) => row.push(value_to_cell(v)),
                None => row.push(None),
            }
        }
        rows.push(row);
    }

    QueryResult {
        columns,
        rows,
        rows_affected: 0,
        truncated: false,
    }
}

/// 無法識別的 aggregations：單欄單列，pretty JSON（絕不吞資料）。
fn agg_fallback(aggs: &Value) -> QueryResult {
    let pretty = serde_json::to_string_pretty(aggs).unwrap_or_else(|_| aggs.to_string());
    QueryResult {
        columns: vec!["aggregations".to_string()],
        rows: vec![vec![Some(pretty)]],
        rows_affected: 0,
        truncated: false,
    }
}

// ---- (d) DataQuery.filters → ES bool query ----

/// filters → ES query DSL。空 filters → match_all。
/// match_any=false → bool.filter（AND）；true → bool.should + minimum_should_match=1（OR）。
pub fn filters_to_query(filters: &[Filter], match_any: bool) -> Value {
    if filters.is_empty() {
        return single("match_all", Value::Object(serde_json::Map::new()));
    }
    let clauses: Vec<Value> = filters.iter().map(filter_to_clause).collect();
    let mut boolq = serde_json::Map::new();
    if match_any {
        boolq.insert("should".to_string(), Value::Array(clauses));
        boolq.insert("minimum_should_match".to_string(), Value::from(1));
    } else {
        boolq.insert("filter".to_string(), Value::Array(clauses));
    }
    single("bool", Value::Object(boolq))
}

/// 單一 filter → 單一 query 子句（否定運算子已各自包成獨立 bool，方便 OR 合併）。
fn filter_to_clause(f: &Filter) -> Value {
    let field = f.column.as_str();
    // 值一律以字串傳給 ES：ES 於 term / range 會依欄位型別自動轉型（數字 / 日期 / 布林），
    // 避免我方誤把 keyword "007" 轉成數字 7。
    let val = Value::String(f.value.clone().unwrap_or_default());
    let range = |op_key: &str| single("range", single(field, single(op_key, val.clone())));
    match f.op.as_str() {
        "=" => single("term", single(field, val)),
        "!=" => single("bool", single("must_not", single("term", single(field, val)))),
        ">" => range("gt"),
        ">=" => range("gte"),
        "<" => range("lt"),
        "<=" => range("lte"),
        "like" => single(
            "wildcard",
            single(field, Value::String(like_to_wildcard(&f.value.clone().unwrap_or_default()))),
        ),
        "is_null" => single(
            "bool",
            single("must_not", single("exists", single("field", Value::String(field.to_string())))),
        ),
        "is_not_null" => single("exists", single("field", Value::String(field.to_string()))),
        // 未知運算子：不縮小結果（防呆，不吞資料）。
        _ => single("match_all", Value::Object(serde_json::Map::new())),
    }
}

/// SQL LIKE 樣式 → ES wildcard 樣式：`%` → `*`（任意長度）、`_` → `?`（單一字元）。
fn like_to_wildcard(pattern: &str) -> String {
    pattern
        .chars()
        .map(|c| match c {
            '%' => '*',
            '_' => '?',
            other => other,
        })
        .collect()
}

// ---- (e) ILM/data-stream backing index → Data View 分組 ----

/// 依 ILM/data-stream 命名規則解析 backing index：
/// `.ds-{group}-{yyyy.MM.dd}-{generation}` → `Some(group)`；不符合此形式 → `None`
/// （一般索引、`.kibana` 等系統索引、或格式異常的 `.ds-` 項目 → 一律維持原樣個別顯示，
/// 不嘗試分組、不 panic）。
///
/// 用 `rsplit_once` 從右側依序剝離「世代號」與「日期」兩段（而非用正則貪婪比對），
/// 只認「最靠右側」的一組合法日期+世代後綴，避免群組名稱本身含數字/連字號時的匹配歧義。
pub fn ds_backing_group(index: &str) -> Option<String> {
    let rest = index.strip_prefix(".ds-")?;
    // 世代號：純數字（如 "000076"）。
    let (head, generation) = rest.rsplit_once('-')?;
    if generation.is_empty() || !generation.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    // 日期：`yyyy.MM.dd`（10 碼、第 5/8 碼為 '.'、三段皆數字，不驗證日期範圍合法性）。
    let (group, date) = head.rsplit_once('-')?;
    let date_ok = date.len() == 10
        && date.as_bytes().get(4) == Some(&b'.')
        && date.as_bytes().get(7) == Some(&b'.')
        && date.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if !date_ok || group.is_empty() {
        return None;
    }
    Some(group.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mapping_flattens_nested_and_multifields_with_synthetic_id() {
        let resp = json!({
            "my-index": {
                "mappings": {
                    "properties": {
                        "title": {
                            "type": "text",
                            "fields": { "keyword": { "type": "keyword" } }
                        },
                        "user": {
                            "properties": {
                                "name": { "type": "keyword" },
                                "age": { "type": "integer" }
                            }
                        }
                    }
                }
            }
        });
        let cols = mapping_to_columns(&resp);
        let names: Vec<&str> = cols.iter().map(|c| c.name.as_str()).collect();
        // 合成 _id 在最前且為主鍵。
        assert_eq!(cols[0].name, "_id");
        assert_eq!(cols[0].key, "PRI");
        assert!(names.contains(&"title"));
        assert!(names.contains(&"title.keyword")); // multi-field
        assert!(names.contains(&"user.name")); // 巢狀 dot path
        assert!(names.contains(&"user.age"));
        // 型別對映。
        let age = cols.iter().find(|c| c.name == "user.age").unwrap();
        assert_eq!(age.data_type, "integer");
    }

    #[test]
    fn hits_union_columns_and_null_for_missing_keys() {
        let resp = json!({
            "hits": {
                "total": { "value": 2 },
                "hits": [
                    { "_id": "1", "_score": 1.5, "_source": { "name": "alice", "tags": ["a", "b"] } },
                    { "_id": "2", "_score": null, "_source": { "name": "bob", "age": 30 } }
                ]
            }
        });
        let qr = hits_to_query_result(&resp);
        assert_eq!(qr.columns, vec!["_id", "_score", "name", "tags", "age"]);
        assert_eq!(hits_total(&resp), 2);
        // row 0：tags 是陣列 → 序列化成 JSON 字串；age 缺 → NULL。
        assert_eq!(qr.rows[0][0], Some("1".to_string()));
        assert_eq!(qr.rows[0][3], Some("[\"a\",\"b\"]".to_string()));
        assert_eq!(qr.rows[0][4], None);
        // row 1：_score null → NULL；tags 缺 → NULL；age = 30。
        assert_eq!(qr.rows[1][1], None);
        assert_eq!(qr.rows[1][3], None);
        assert_eq!(qr.rows[1][4], Some("30".to_string()));
    }

    #[test]
    fn hits_total_supports_es5_numeric_total() {
        let resp = json!({ "hits": { "total": 42, "hits": [] } });
        assert_eq!(hits_total(&resp), 42);
    }

    #[test]
    fn aggs_terms_bucket_with_submetric() {
        let aggs = json!({
            "by_country": {
                "buckets": [
                    { "key": "US", "doc_count": 10, "avg_price": { "value": 3.5 } },
                    { "key": "TW", "doc_count": 4, "avg_price": { "value": 9.0 } }
                ]
            }
        });
        let qr = aggs_to_query_result(&aggs);
        assert_eq!(qr.columns, vec!["by_country", "doc_count", "avg_price"]);
        assert_eq!(qr.rows[0], vec![Some("US".to_string()), Some("10".to_string()), Some("3.5".to_string())]);
        assert_eq!(qr.rows[1], vec![Some("TW".to_string()), Some("4".to_string()), Some("9.0".to_string())]);
    }

    #[test]
    fn aggs_date_histogram_prefers_key_as_string() {
        let aggs = json!({
            "over_time": {
                "buckets": [
                    { "key_as_string": "2021-01-01", "key": 1609459200000i64, "doc_count": 5 }
                ]
            }
        });
        let qr = aggs_to_query_result(&aggs);
        assert_eq!(qr.rows[0][0], Some("2021-01-01".to_string()));
    }

    #[test]
    fn aggs_metric_only_single_row() {
        let aggs = json!({
            "avg_age": { "value": 33.2 },
            "max_age": { "value": 90.0 }
        });
        let qr = aggs_to_query_result(&aggs);
        assert_eq!(qr.columns, vec!["avg_age", "max_age"]);
        assert_eq!(qr.rows.len(), 1);
        assert_eq!(qr.rows[0], vec![Some("33.2".to_string()), Some("90.0".to_string())]);
    }

    #[test]
    fn aggs_unrecognized_falls_back_to_pretty_json() {
        let aggs = json!({ "weird": { "something_else": [1, 2, 3] } });
        let qr = aggs_to_query_result(&aggs);
        assert_eq!(qr.columns, vec!["aggregations"]);
        assert_eq!(qr.rows.len(), 1);
        // 絕不吞資料：完整 JSON 出現在唯一格。
        assert!(qr.rows[0][0].as_ref().unwrap().contains("something_else"));
    }

    #[test]
    fn aggs_bucket_with_sibling_metric_falls_back_not_dropped() {
        // 首個為 bucket、同層還有 metric → 不可只回 bucket 表把 metric 丟掉，須 fallback。
        let aggs = json!({
            "by_country": { "buckets": [ { "key": "TW", "doc_count": 3 } ] },
            "avg_price": { "value": 3.5 }
        });
        let qr = aggs_to_query_result(&aggs);
        assert_eq!(qr.columns, vec!["aggregations"]);
        let cell = qr.rows[0][0].as_ref().unwrap();
        assert!(cell.contains("by_country") && cell.contains("avg_price"), "兩個 agg 都要保留：{cell}");
    }

    #[test]
    fn aggs_nested_subbuckets_fall_back_not_dropped() {
        // 單一 bucket 但 bucket 內含巢狀子 bucket → 超出單層攤平，fallback 不丟巢狀資料。
        let aggs = json!({
            "by_country": { "buckets": [
                { "key": "TW", "doc_count": 3, "by_city": { "buckets": [ { "key": "Taipei", "doc_count": 2 } ] } }
            ] }
        });
        let qr = aggs_to_query_result(&aggs);
        assert_eq!(qr.columns, vec!["aggregations"]);
        assert!(qr.rows[0][0].as_ref().unwrap().contains("by_city"), "巢狀 buckets 不可被丟");
    }

    #[test]
    fn hits_source_id_score_no_duplicate_columns() {
        // _source 自帶名為 _id / _score 的欄位不可與合成欄重複。
        let resp = json!({
            "hits": { "total": { "value": 1 }, "hits": [
                { "_id": "1", "_score": 1.0, "_source": { "_id": "inner", "_score": 9, "name": "x" } }
            ] }
        });
        let qr = hits_to_query_result(&resp);
        assert_eq!(qr.columns, vec!["_id", "_score", "name"]);
        // 合成 _id / _score（doc id 與檢索分數）優先，非 _source 內的同名值。
        assert_eq!(qr.rows[0][0].as_deref(), Some("1"));
    }

    #[test]
    fn filters_empty_is_match_all() {
        assert_eq!(filters_to_query(&[], false), json!({ "match_all": {} }));
    }

    #[test]
    fn filters_and_maps_operators() {
        let filters = vec![
            Filter { column: "status".into(), op: "=".into(), value: Some("active".into()) },
            Filter { column: "age".into(), op: ">=".into(), value: Some("18".into()) },
            Filter { column: "name".into(), op: "like".into(), value: Some("jo%".into()) },
            Filter { column: "deleted".into(), op: "!=".into(), value: Some("true".into()) },
            Filter { column: "email".into(), op: "is_null".into(), value: None },
            Filter { column: "phone".into(), op: "is_not_null".into(), value: None },
        ];
        let q = filters_to_query(&filters, false);
        let expected = json!({
            "bool": {
                "filter": [
                    { "term": { "status": "active" } },
                    { "range": { "age": { "gte": "18" } } },
                    { "wildcard": { "name": "jo*" } },
                    { "bool": { "must_not": { "term": { "deleted": "true" } } } },
                    { "bool": { "must_not": { "exists": { "field": "email" } } } },
                    { "exists": { "field": "phone" } }
                ]
            }
        });
        assert_eq!(q, expected);
    }

    #[test]
    fn filters_or_uses_should_with_minimum_should_match() {
        let filters = vec![
            Filter { column: "a".into(), op: "=".into(), value: Some("1".into()) },
            Filter { column: "b".into(), op: "=".into(), value: Some("2".into()) },
        ];
        let q = filters_to_query(&filters, true);
        let expected = json!({
            "bool": {
                "should": [
                    { "term": { "a": "1" } },
                    { "term": { "b": "2" } }
                ],
                "minimum_should_match": 1
            }
        });
        assert_eq!(q, expected);
    }

    #[test]
    fn like_to_wildcard_converts_both_metachars() {
        assert_eq!(like_to_wildcard("jo%"), "jo*");
        assert_eq!(like_to_wildcard("a_b%"), "a?b*");
    }

    #[test]
    fn ds_backing_group_parses_normal_cases() {
        assert_eq!(
            ds_backing_group(".ds-nova88-t1p-k8s_api_adminsite-2026.07.02-000076"),
            Some("nova88-t1p-k8s_api_adminsite".to_string())
        );
        assert_eq!(
            ds_backing_group(".ds-nova88-prod-mysql-2026.07.07-000012"),
            Some("nova88-prod-mysql".to_string())
        );
    }

    #[test]
    fn ds_backing_group_rejects_non_ds_prefixed_names() {
        assert_eq!(ds_backing_group(".kibana_task_manager"), None);
        assert_eq!(ds_backing_group("my-index"), None);
        // 人工模仿 ILM 命名但非 .ds- 前綴：不得被誤判分組。
        assert_eq!(ds_backing_group("xxx-2026.07.02-000001"), None);
    }

    #[test]
    fn ds_backing_group_rejects_malformed_ds_names() {
        assert_eq!(ds_backing_group(".ds-onlyname"), None);
        assert_eq!(ds_backing_group(".ds-name-2026.07.02"), None); // 缺世代號
        assert_eq!(ds_backing_group(".ds-name-notanumber-2026.07.02"), None);
        assert_eq!(ds_backing_group(".ds-name-2026.07.02-00a1"), None); // 世代號非純數字
        assert_eq!(ds_backing_group(".ds-name-2026-07-02-000001"), None); // 日期段用 '-' 而非 '.'，長度/分隔符不合規則
        assert_eq!(ds_backing_group(".ds--2026.07.02-000001"), None); // 群組名稱為空
    }
}
