//! Harbor 對前端的 DTO（snake_case，與 src/api.ts 對齊）。

use serde::Serialize;

#[derive(Debug, Clone, Serialize, Default)]
pub struct HarborOverview {
    pub base_url: String,
    pub harbor_version: String,
    pub auth_mode: String,
    pub registry_url: String,
    /// overall 健康狀態（healthy / unhealthy）與各元件。
    pub health: String,
    pub components: Vec<HarborComponent>,
    pub private_projects: i64,
    pub public_projects: i64,
    pub private_repos: i64,
    pub public_repos: i64,
    /// 總儲存用量（bytes；需系統管理員權限，否則 -1）。
    pub storage_used: i64,
    pub user: String,
    pub is_admin: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborComponent {
    pub name: String,
    pub status: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborProject {
    pub name: String,
    pub project_id: i64,
    pub public: bool,
    pub repo_count: i64,
    pub owner: String,
    pub creation_time: String,
    pub auto_scan: bool,
    pub prevent_vul: bool,
    pub severity: String,
    /// 配額（bytes；-1 = 無限制 / 無權限看）。
    pub quota_hard: i64,
    pub quota_used: i64,
    /// proxy cache 專案的上游 registry 名稱（一般專案為空）。
    pub registry_name: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborRepository {
    /// 不含專案前綴的名稱（`app`；完整名 `project/app`）。
    pub name: String,
    pub full_name: String,
    pub artifact_count: i64,
    pub pull_count: i64,
    pub creation_time: String,
    pub update_time: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborTag {
    pub name: String,
    pub push_time: String,
    pub pull_time: String,
    pub immutable: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborLabel {
    pub name: String,
    pub color: String,
}

/// 弱點掃描摘要（取第一個掃描報告）。
#[derive(Debug, Clone, Serialize, Default)]
pub struct HarborScan {
    /// Success / Running / Pending / Error / Stopped / NotScanned
    pub status: String,
    pub severity: String,
    pub total: i64,
    pub fixable: i64,
    pub critical: i64,
    pub high: i64,
    pub medium: i64,
    pub low: i64,
    pub unknown: i64,
    pub end_time: String,
    pub complete_percent: i64,
    pub scanner: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborArtifact {
    pub digest: String,
    pub kind: String,
    pub media_type: String,
    pub size: i64,
    pub push_time: String,
    pub pull_time: String,
    pub os: String,
    pub arch: String,
    pub tags: Vec<HarborTag>,
    pub labels: Vec<HarborLabel>,
    pub scan: Option<HarborScan>,
    /// 多平台 index 的子 artifact 數。
    pub references: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborArtifactPage {
    pub items: Vec<HarborArtifact>,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HarborVulnerability {
    pub id: String,
    pub package: String,
    pub version: String,
    pub fix_version: String,
    pub severity: String,
    pub description: String,
    pub links: Vec<String>,
    pub cvss: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct HarborVulnReport {
    pub scanner: String,
    pub generated_at: String,
    pub severity: String,
    pub items: Vec<HarborVulnerability>,
}
