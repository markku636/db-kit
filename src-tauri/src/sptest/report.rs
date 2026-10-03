//! 執行結果的資料型別、基線（golden）檔、JUnit XML 與 Markdown 報表。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::assert::Difference;
use super::errclass::ErrorClass;
use super::session::ResultSet;
use super::snapshot::TableEffect;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrInfo {
    pub code: Option<String>,
    pub class: ErrorClass,
    pub message: String,
}

/// 一個 step 在一個引擎上的實際輸出。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StepOutcome {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub result_sets: Vec<ResultSet>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub out: BTreeMap<String, Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub return_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrInfo>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<TableEffect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tx_state: Option<String>,
    #[serde(default)]
    pub elapsed_ms: u64,
    /// 這一步結束時的純量符號（名 → 值）。基線 / 差分比對時，等於某符號值的儲存格換成 `<符號>` 再比——
    /// identity 值每次執行、每個引擎都不同，但「同一個符號」就是同一筆資料。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub symbols: BTreeMap<String, String>,
    /// 符號的來源欄名（只有從引擎擷取的符號才有）：只在欄名對得上（或兩邊都是 *id 欄）時才換成符號。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub symbol_cols: BTreeMap<String, String>,
    /// 情境碰到的表的 identity / 時間預設值欄名（聯集）：基線 / 差分比對時依欄名遮罩。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub masked_cols: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Pass,
    Fail,
    Error,
    SeedError,
    Skipped,
    Mismatch,
    ErrorOnOneSide,
    BothError,
    PerfFail,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Pass => "pass",
            Verdict::Fail => "fail",
            Verdict::Error => "error",
            Verdict::SeedError => "seed_error",
            Verdict::Skipped => "skipped",
            Verdict::Mismatch => "mismatch",
            Verdict::ErrorOnOneSide => "error_on_one_side",
            Verdict::BothError => "both_error",
            Verdict::PerfFail => "perf_fail",
        }
    }

    /// CI 的 exit code 看這個：pass / skipped / both_error（無差異）算綠。
    pub fn is_green(self) -> bool {
        matches!(self, Verdict::Pass | Verdict::Skipped | Verdict::BothError)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepReport {
    pub label: String,
    pub kind: String,
    /// 引擎標籤（kind 名，diff 時兩個）→ 輸出。
    pub outcomes: BTreeMap<String, StepOutcome>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub differences: Vec<Difference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioReport {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case: Option<String>,
    pub verdict: Verdict,
    pub mode_used: String,
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
    /// harness 層的錯誤（連線失敗、開場失敗、未預期的引擎錯誤…）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub steps: Vec<StepReport>,
}

impl ScenarioReport {
    pub fn display_name(&self) -> String {
        match &self.case {
            Some(c) => format!("{}/{}", self.id, c),
            None => self.id.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReport {
    pub file: String,
    pub mode: String,
    pub targets: Vec<String>,
    pub started_at: String,
    pub scenarios: Vec<ScenarioReport>,
}

impl FileReport {
    pub fn counts(&self) -> BTreeMap<&'static str, usize> {
        let mut m = BTreeMap::new();
        for s in &self.scenarios {
            *m.entry(s.verdict.as_str()).or_insert(0) += 1;
        }
        m
    }

    pub fn all_green(&self) -> bool {
        self.scenarios.iter().all(|s| s.verdict.is_green())
    }
}

// ---------------------------------------------------------------------------
// 基線
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldenFile {
    pub recorded_at: String,
    pub engine: String,
    pub steps: Vec<StepOutcome>,
}

/// `<dir>/<engine>/<file stem>/<scenario>[__<case>].json`
pub fn golden_path(dir: &Path, engine: &str, file_stem: &str, scenario: &str, case: Option<&str>) -> PathBuf {
    let name = match case {
        Some(c) => format!("{}__{}.json", sanitize(scenario), sanitize(c)),
        None => format!("{}.json", sanitize(scenario)),
    };
    dir.join(sanitize(engine)).join(sanitize(file_stem)).join(name)
}

fn sanitize(s: &str) -> String {
    let out: String = s.chars().map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' }).collect();
    if out.is_empty() { "_".into() } else { out }
}

pub async fn write_golden(path: &Path, g: &GoldenFile) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| AppError::Storage(e.to_string()))?;
    }
    let bytes = serde_json::to_vec_pretty(g).map_err(|e| AppError::Storage(e.to_string()))?;
    tokio::fs::write(path, bytes).await.map_err(|e| AppError::Storage(e.to_string()))
}

pub async fn read_golden(path: &Path) -> AppResult<Option<GoldenFile>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| AppError::Storage(e.to_string())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Storage(e.to_string())),
    }
}

// ---------------------------------------------------------------------------
// JUnit
// ---------------------------------------------------------------------------

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// 一個檔案一個 `<testsuite>`、一個 scenario（含 case 展開）一個 `<testcase>`。
pub fn to_junit(reports: &[FileReport]) -> String {
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<testsuites>\n");
    for f in reports {
        let tests = f.scenarios.len();
        let failures = f.scenarios.iter().filter(|s| matches!(s.verdict, Verdict::Fail | Verdict::Mismatch | Verdict::PerfFail)).count();
        let errors = f.scenarios.iter().filter(|s| matches!(s.verdict, Verdict::Error | Verdict::SeedError | Verdict::ErrorOnOneSide)).count();
        let skipped = f.scenarios.iter().filter(|s| s.verdict == Verdict::Skipped).count();
        let time: f64 = f.scenarios.iter().map(|s| s.elapsed_ms as f64 / 1000.0).sum();
        out.push_str(&format!(
            "  <testsuite name=\"{}\" tests=\"{tests}\" failures=\"{failures}\" errors=\"{errors}\" skipped=\"{skipped}\" time=\"{time:.3}\">\n",
            xml_escape(&f.file)
        ));
        for s in &f.scenarios {
            out.push_str(&format!(
                "    <testcase name=\"{}\" classname=\"{}\" time=\"{:.3}\">\n",
                xml_escape(&s.display_name()),
                xml_escape(&f.file),
                s.elapsed_ms as f64 / 1000.0
            ));
            match s.verdict {
                Verdict::Skipped => out.push_str(&format!("      <skipped message=\"{}\"/>\n", xml_escape(s.skipped.as_deref().unwrap_or("")))),
                Verdict::Fail | Verdict::Mismatch | Verdict::PerfFail => {
                    let first = first_difference(s).unwrap_or_else(|| s.verdict.as_str().to_string());
                    out.push_str(&format!("      <failure message=\"{}\"><![CDATA[{}]]></failure>\n", xml_escape(&first), render_scenario_md(s)));
                }
                Verdict::Error | Verdict::SeedError | Verdict::ErrorOnOneSide => {
                    let msg = s.error.clone().or_else(|| first_difference(s)).unwrap_or_else(|| s.verdict.as_str().to_string());
                    out.push_str(&format!("      <error message=\"{}\"><![CDATA[{}]]></error>\n", xml_escape(&msg), render_scenario_md(s)));
                }
                Verdict::Pass | Verdict::BothError => {}
            }
            out.push_str("    </testcase>\n");
        }
        out.push_str("  </testsuite>\n");
    }
    out.push_str("</testsuites>\n");
    out
}

fn first_difference(s: &ScenarioReport) -> Option<String> {
    s.steps.iter().flat_map(|st| st.differences.iter().map(move |d| format!("{} @ {}: {}", d.kind, st.label, d.summary()))).next()
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

pub fn render_scenario_md(s: &ScenarioReport) -> String {
    let mut md = String::new();
    md.push_str(&format!("### {} — {}\n\n", s.display_name(), s.verdict.as_str()));
    if let Some(e) = &s.error {
        md.push_str(&format!("{}\n\n", tf!("錯誤：{e}", e = e)));
    }
    for st in &s.steps {
        if st.differences.is_empty() {
            continue;
        }
        md.push_str(&format!("**{}** ({})\n\n{}\n|---|---|---|---|---|\n", st.label, st.kind, t!("| 類型 | 位置 | 期望 / A | 實際 / B | 備註 |")));
        for d in &st.differences {
            md.push_str(&format!(
                "| {} | {} | {} | {} | {} |\n",
                d.kind,
                md_cell(&d.location),
                md_cell(d.expected.as_deref().unwrap_or("")),
                md_cell(d.actual.as_deref().unwrap_or("")),
                md_cell(d.note.as_deref().unwrap_or(""))
            ));
        }
        md.push('\n');
    }
    md
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

pub fn render_md(reports: &[FileReport]) -> String {
    let mut md = String::new();
    md.push_str(&format!("# {}\n\n{}\n|---|---|---|---|---|---|---|\n", t!("預存程序整合測試報表"), t!("| 檔案 | 模式 | 目標 | 通過 | 失敗 | 錯誤 | 略過 |")));
    for f in reports {
        let c = f.counts();
        let n = |k: &str| c.get(k).copied().unwrap_or(0);
        md.push_str(&format!(
            "| {} | {} | {} | {} | {} | {} | {} |\n",
            f.file,
            f.mode,
            f.targets.join(" ↔ "),
            n("pass") + n("both_error"),
            n("fail") + n("mismatch") + n("perf_fail"),
            n("error") + n("seed_error") + n("error_on_one_side"),
            n("skipped")
        ));
    }
    md.push('\n');
    for f in reports {
        for s in f.scenarios.iter().filter(|s| !s.verdict.is_green() || s.steps.iter().any(|st| !st.differences.is_empty())) {
            md.push_str(&render_scenario_md(s));
        }
    }
    md
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scenario(id: &str, verdict: Verdict) -> ScenarioReport {
        ScenarioReport {
            id: id.into(),
            case: None,
            verdict,
            mode_used: "wrapped".into(),
            elapsed_ms: 12,
            skipped: None,
            error: None,
            steps: vec![StepReport {
                label: "#1 call".into(),
                kind: "call".into(),
                outcomes: BTreeMap::new(),
                differences: if verdict == Verdict::Fail {
                    vec![Difference::new("cell", "set 0 / row 0 / total", Some("25.00".into()), Some("20.00".into()))]
                } else {
                    vec![]
                },
            }],
        }
    }

    #[test]
    fn junit_counts_and_escaping() {
        let f = FileReport {
            file: "usp_x.json".into(),
            mode: "assert".into(),
            targets: vec!["mssql".into()],
            started_at: "2026-01-01T00:00:00Z".into(),
            scenarios: vec![scenario("a", Verdict::Pass), scenario("b<c>", Verdict::Fail), scenario("d", Verdict::Error), scenario("e", Verdict::Skipped)],
        };
        let xml = to_junit(&[f]);
        assert!(xml.contains("tests=\"4\" failures=\"1\" errors=\"1\" skipped=\"1\""));
        assert!(xml.contains("name=\"b&lt;c&gt;\""));
        assert!(xml.contains("<failure message=\"cell @ #1 call: set 0 / row 0 / total: expected 25.00, got 20.00\">"));
        assert!(xml.contains("<![CDATA["));
    }

    #[test]
    fn golden_paths_are_sanitized() {
        let p = golden_path(Path::new("g"), "mssql", "usp x", "place/order", Some("c:1"));
        assert_eq!(p, Path::new("g").join("mssql").join("usp_x").join("place_order__c_1.json"));
    }
}
