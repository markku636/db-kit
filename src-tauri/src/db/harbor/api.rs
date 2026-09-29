//! Harbor REST（`/api/v2.0`）用戶端：basic auth（一般帳號或 robot 帳號；空白＝匿名，只看得到公開專案）。
//!
//! 注意：repository 名稱放進路徑時要把 `/` **二次編碼**成 `%252F`（Harbor 路由的規定），
//! 且路徑用的是去掉專案前綴的名稱（`project/team/app` → `team%252Fapp`）。

use std::time::Duration;

use reqwest::{Client, Method, RequestBuilder, Response};
use serde_json::Value;

use super::dto::*;
use crate::db::http_tls::{apply_tunnel, client_builder, http_err, reg_target, TlsOpts};
use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// 弱點報告格式（Harbor 2.x 需在 header 指明要哪種）。
const VULN_ACCEPT: &str = "application/vnd.security.vulnerability.report; version=1.1, \
application/vnd.scanner.adapter.vuln.report.harbor+json; version=1.0";

const PAGE: usize = 100;
/// 專案 / repository 清單上限。
const LIST_CAP: usize = 5000;

pub struct HarborApi {
    client: Client,
    pub base: String,
    user: String,
    pass: String,
}

impl HarborApi {
    pub fn new(cfg: &ConnectionConfig) -> AppResult<Self> {
        let target = reg_target(cfg, "harbor");
        let tls = if target.tls { TlsOpts::from_options(cfg, "harbor_tls") } else { TlsOpts::default() };
        let b = client_builder(&tls, Some(Duration::from_secs(60)))?;
        let (target, b) = apply_tunnel(cfg, target, b);
        Ok(HarborApi {
            client: b.build().map_err(http_err)?,
            base: target.base_url(),
            user: cfg.username.trim().to_string(),
            pass: cfg.password.clone(),
        })
    }

    fn req(&self, method: Method, path: &str) -> RequestBuilder {
        let rb = self.client.request(method, format!("{}/api/v2.0{}", self.base, path));
        if self.user.is_empty() {
            rb
        } else {
            rb.basic_auth(&self.user, Some(&self.pass))
        }
    }

    async fn send(&self, rb: RequestBuilder) -> AppResult<Response> {
        check_status(rb.send().await.map_err(http_err)?).await
    }

    async fn get_json(&self, path: &str) -> AppResult<Value> {
        self.send(self.req(Method::GET, path)).await?.json().await.map_err(http_err)
    }

    /// 分頁取完（`page` / `page_size`，至回傳不足一頁或達上限）。
    async fn get_all(&self, path: &str) -> AppResult<Vec<Value>> {
        let sep = if path.contains('?') { '&' } else { '?' };
        let mut out = Vec::new();
        for page in 1.. {
            let v = self.get_json(&format!("{path}{sep}page={page}&page_size={PAGE}")).await?;
            let items = v.as_array().cloned().unwrap_or_default();
            let n = items.len();
            out.extend(items);
            if n < PAGE || out.len() >= LIST_CAP {
                break;
            }
        }
        out.truncate(LIST_CAP);
        Ok(out)
    }

    pub async fn ping(&self) -> AppResult<()> {
        self.send(self.req(Method::GET, "/ping")).await.map(|_| ())?;
        // 帳密錯誤時 /ping 仍回 200；帶帳密就再驗一次身分，讓「測試連線」能抓到打錯的密碼。
        if !self.user.is_empty() {
            self.send(self.req(Method::GET, "/users/current")).await.map_err(|e| match e {
                AppError::Connect(m) | AppError::Query(m) if m.contains("401") => {
                    AppError::Connect(tf!("Harbor 帳號或密碼錯誤：{m}", m = m))
                }
                other => other,
            })?;
        }
        Ok(())
    }

    pub async fn overview(&self) -> AppResult<HarborOverview> {
        let sys = self.get_json("/systeminfo").await.unwrap_or(Value::Null);
        let health = self.get_json("/health").await.unwrap_or(Value::Null);
        let stats = self.get_json("/statistics").await.unwrap_or(Value::Null);
        let me = if self.user.is_empty() { Value::Null } else { self.get_json("/users/current").await.unwrap_or(Value::Null) };
        Ok(HarborOverview {
            base_url: self.base.clone(),
            harbor_version: s(&sys, "harbor_version"),
            auth_mode: s(&sys, "auth_mode"),
            registry_url: s(&sys, "registry_url"),
            health: s(&health, "status"),
            components: arr(&health, "components")
                .iter()
                .map(|c| HarborComponent { name: s(c, "name"), status: s(c, "status"), error: s(c, "error") })
                .collect(),
            private_projects: i(&stats, "private_project_count"),
            public_projects: i(&stats, "public_project_count"),
            private_repos: i(&stats, "private_repo_count"),
            public_repos: i(&stats, "public_repo_count"),
            storage_used: stats["total_storage_consumption"].as_i64().unwrap_or(-1),
            user: s(&me, "username"),
            is_admin: me["sysadmin_flag"].as_bool().unwrap_or(false),
        })
    }

    pub async fn project_names(&self) -> AppResult<Vec<String>> {
        let mut v: Vec<String> = self.get_all("/projects").await?.iter().map(|p| s(p, "name")).collect();
        v.sort();
        Ok(v)
    }

    pub async fn project(&self, name: &str) -> AppResult<HarborProject> {
        let p = self.get_json(&format!("/projects/{}", enc(name))).await?;
        let sum = self.get_json(&format!("/projects/{}/summary", enc(name))).await.unwrap_or(Value::Null);
        let md = &p["metadata"];
        let flag = |k: &str| md[k].as_str() == Some("true");
        Ok(HarborProject {
            name: s(&p, "name"),
            project_id: i(&p, "project_id"),
            public: flag("public"),
            repo_count: sum["repo_count"].as_i64().unwrap_or_else(|| i(&p, "repo_count")),
            owner: s(&p, "owner_name"),
            creation_time: s(&p, "creation_time"),
            auto_scan: flag("auto_scan"),
            prevent_vul: flag("prevent_vul"),
            severity: md["severity"].as_str().unwrap_or("").to_string(),
            quota_hard: sum["quota"]["hard"]["storage"].as_i64().unwrap_or(-1),
            quota_used: sum["quota"]["used"]["storage"].as_i64().unwrap_or(-1),
            registry_name: s(&sum["registry"], "name"),
        })
    }

    pub async fn repositories(&self, project: &str) -> AppResult<Vec<HarborRepository>> {
        let items = self.get_all(&format!("/projects/{}/repositories", enc(project))).await?;
        let prefix = format!("{project}/");
        let mut v: Vec<HarborRepository> = items
            .iter()
            .map(|r| {
                let full = s(r, "name");
                HarborRepository {
                    name: full.strip_prefix(&prefix).unwrap_or(&full).to_string(),
                    full_name: full,
                    artifact_count: i(r, "artifact_count"),
                    pull_count: i(r, "pull_count"),
                    creation_time: s(r, "creation_time"),
                    update_time: s(r, "update_time"),
                    description: s(r, "description"),
                }
            })
            .collect();
        v.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(v)
    }

    fn artifacts_path(project: &str, repo: &str) -> String {
        format!("/projects/{}/repositories/{}/artifacts", enc(project), repo_seg(repo))
    }

    pub async fn artifacts(&self, project: &str, repo: &str, page: u32, page_size: u32) -> AppResult<HarborArtifactPage> {
        let path = format!(
            "{}?page={}&page_size={}&with_tag=true&with_label=true&with_scan_overview=true",
            Self::artifacts_path(project, repo),
            page.max(1),
            page_size.clamp(1, 100)
        );
        let resp = self.send(self.req(Method::GET, &path).header("X-Accept-Vulnerabilities", VULN_ACCEPT)).await?;
        let total = resp
            .headers()
            .get("x-total-count")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(-1);
        let v: Value = resp.json().await.map_err(http_err)?;
        Ok(HarborArtifactPage { items: arr(&v, "").iter().map(map_artifact).collect(), total })
    }

    pub async fn scan(&self, project: &str, repo: &str, digest: &str) -> AppResult<()> {
        let path = format!("{}/{}/scan", Self::artifacts_path(project, repo), digest);
        self.send(self.req(Method::POST, &path)).await.map(|_| ())
    }

    pub async fn vulnerabilities(&self, project: &str, repo: &str, digest: &str) -> AppResult<HarborVulnReport> {
        let path = format!("{}/{}/additions/vulnerabilities", Self::artifacts_path(project, repo), digest);
        let resp = self.send(self.req(Method::GET, &path).header("X-Accept-Vulnerabilities", VULN_ACCEPT)).await?;
        let v: Value = resp.json().await.map_err(http_err)?;
        Ok(parse_vuln_report(&v))
    }

    pub async fn delete_artifact(&self, project: &str, repo: &str, digest: &str) -> AppResult<()> {
        let path = format!("{}/{}", Self::artifacts_path(project, repo), digest);
        self.send(self.req(Method::DELETE, &path)).await.map(|_| ())
    }

    pub async fn delete_tag(&self, project: &str, repo: &str, digest: &str, tag: &str) -> AppResult<()> {
        let path = format!("{}/{}/tags/{}", Self::artifacts_path(project, repo), digest, enc(tag));
        self.send(self.req(Method::DELETE, &path)).await.map(|_| ())
    }

    pub async fn delete_repository(&self, project: &str, repo: &str) -> AppResult<()> {
        let path = format!("/projects/{}/repositories/{}", enc(project), repo_seg(repo));
        self.send(self.req(Method::DELETE, &path)).await.map(|_| ())
    }
}

async fn check_status(resp: Response) -> AppResult<Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let code = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    // Harbor 錯誤格式：{"errors":[{"code":"UNAUTHORIZED","message":"…"}]}
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["errors"].as_array().map(|a| {
                a.iter()
                    .map(|e| format!("{} {}", s(e, "code"), s(e, "message")).trim().to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            })
        })
        .filter(|x| !x.is_empty())
        .unwrap_or(body);
    let err = format!("Harbor {code}：{}", msg.trim());
    Err(if code == 401 { AppError::Connect(err) } else { AppError::Query(err) })
}

fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &c in s.as_bytes() {
        match c {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(c as char),
            _ => out.push_str(&format!("%{c:02X}")),
        }
    }
    out
}

/// repository 路徑段：各段編碼後以 `%252F`（`/` 的二次編碼）串起。
pub(crate) fn repo_seg(repo: &str) -> String {
    repo.split('/').map(enc).collect::<Vec<_>>().join("%252F")
}

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn i(v: &Value, k: &str) -> i64 {
    v[k].as_i64().unwrap_or(0)
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    let x = if k.is_empty() { v } else { &v[k] };
    x.as_array().map(|a| a.as_slice()).unwrap_or(&[])
}

pub(crate) fn map_artifact(a: &Value) -> HarborArtifact {
    let extra = &a["extra_attrs"];
    HarborArtifact {
        digest: s(a, "digest"),
        kind: s(a, "type"),
        media_type: s(a, "manifest_media_type"),
        size: i(a, "size"),
        push_time: s(a, "push_time"),
        pull_time: s(a, "pull_time"),
        os: s(extra, "os"),
        arch: s(extra, "architecture"),
        tags: arr(a, "tags")
            .iter()
            .map(|t| HarborTag {
                name: s(t, "name"),
                push_time: s(t, "push_time"),
                pull_time: s(t, "pull_time"),
                immutable: t["immutable"].as_bool().unwrap_or(false),
            })
            .collect(),
        labels: arr(a, "labels").iter().map(|l| HarborLabel { name: s(l, "name"), color: s(l, "color") }).collect(),
        scan: a["scan_overview"].as_object().and_then(|o| o.values().next()).map(parse_scan),
        references: arr(a, "references").len() as i64,
    }
}

fn parse_scan(r: &Value) -> HarborScan {
    let sum = &r["summary"];
    let by = &sum["summary"];
    HarborScan {
        status: s(r, "scan_status"),
        severity: s(r, "severity"),
        total: i(sum, "total"),
        fixable: i(sum, "fixable"),
        critical: i(by, "Critical"),
        high: i(by, "High"),
        medium: i(by, "Medium"),
        low: i(by, "Low"),
        unknown: i(by, "Unknown") + i(by, "Negligible"),
        end_time: s(r, "end_time"),
        complete_percent: i(r, "complete_percent"),
        scanner: s(&r["scanner"], "name"),
    }
}

/// 嚴重度排序權重（Critical 最前）。
fn severity_rank(s: &str) -> u8 {
    match s.to_ascii_lowercase().as_str() {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        "negligible" => 4,
        _ => 5,
    }
}

pub(crate) fn parse_vuln_report(v: &Value) -> HarborVulnReport {
    let Some(r) = v.as_object().and_then(|o| o.values().next()) else {
        return HarborVulnReport::default();
    };
    let mut items: Vec<HarborVulnerability> = arr(r, "vulnerabilities")
        .iter()
        .map(|x| HarborVulnerability {
            id: s(x, "id"),
            package: s(x, "package"),
            version: s(x, "version"),
            fix_version: s(x, "fix_version"),
            severity: s(x, "severity"),
            description: s(x, "description"),
            links: arr(x, "links").iter().filter_map(|l| l.as_str().map(str::to_string)).collect(),
            cvss: x["preferred_cvss"]["score_v3"].as_f64().unwrap_or(0.0),
        })
        .collect();
    items.sort_by(|a, b| severity_rank(&a.severity).cmp(&severity_rank(&b.severity)).then(b.cvss.total_cmp(&a.cvss)));
    HarborVulnReport {
        scanner: format!("{} {}", s(&r["scanner"], "name"), s(&r["scanner"], "version")).trim().to_string(),
        generated_at: s(r, "generated_at"),
        severity: s(r, "severity"),
        items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_seg_double_encodes_slash() {
        assert_eq!(repo_seg("app"), "app");
        assert_eq!(repo_seg("team/app"), "team%252Fapp");
    }

    #[test]
    fn artifact_with_scan_overview() {
        let v: Value = serde_json::from_str(
            r##"{"digest":"sha256:d","type":"IMAGE","size":123,"push_time":"2026-01-01T00:00:00Z",
            "extra_attrs":{"os":"linux","architecture":"amd64"},
            "tags":[{"name":"1.0","immutable":true}],"labels":[{"name":"prod","color":"#f00"}],
            "scan_overview":{"application/vnd.security.vulnerability.report; version=1.1":
              {"scan_status":"Success","severity":"High","summary":{"total":5,"fixable":3,"summary":{"High":2,"Low":3}},"scanner":{"name":"Trivy"}}},
            "references":[{"child_digest":"a"},{"child_digest":"b"}]}"##,
        )
        .unwrap();
        let a = map_artifact(&v);
        assert_eq!((a.os.as_str(), a.arch.as_str(), a.references), ("linux", "amd64", 2));
        assert!(a.tags[0].immutable);
        let sc = a.scan.unwrap();
        assert_eq!((sc.status.as_str(), sc.total, sc.high, sc.low, sc.critical), ("Success", 5, 2, 3, 0));
    }

    #[test]
    fn artifact_without_scan() {
        let a = map_artifact(&serde_json::json!({"digest":"sha256:x","tags":null}));
        assert!(a.scan.is_none() && a.tags.is_empty());
    }

    #[test]
    fn vuln_report_sorted_by_severity_then_cvss() {
        let v: Value = serde_json::from_str(
            r#"{"application/vnd.security.vulnerability.report; version=1.1":{"scanner":{"name":"Trivy","version":"0.50"},
            "severity":"Critical","vulnerabilities":[
              {"id":"CVE-1","package":"a","severity":"Low"},
              {"id":"CVE-2","package":"b","severity":"Critical","preferred_cvss":{"score_v3":9.1}},
              {"id":"CVE-3","package":"c","severity":"Critical","preferred_cvss":{"score_v3":9.8}}]}}"#,
        )
        .unwrap();
        let r = parse_vuln_report(&v);
        assert_eq!(r.scanner, "Trivy 0.50");
        assert_eq!(r.items.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["CVE-3", "CVE-2", "CVE-1"]);
        assert!(parse_vuln_report(&serde_json::json!({})).items.is_empty());
    }
}
