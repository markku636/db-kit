//! Registry HTTP API v2 用戶端：自動處理 Basic / Bearer token 認證、`Link` 分頁、manifest 內容協商。

use std::time::Duration;

use reqwest::header::{ACCEPT, LINK, WWW_AUTHENTICATE};
use reqwest::{Client, Method, RequestBuilder, Response, StatusCode};
use serde_json::Value;

use super::auth::{parse_challenge, Challenge, TokenCache};
use super::dto::*;
use crate::db::http_tls::{apply_tunnel, client_builder, http_err, reg_target, TlsOpts};
use crate::db::ConnectionConfig;
use crate::error::{AppError, AppResult};

/// 支援的 manifest 格式（OCI 與 Docker v2，含多平台清單）。
const MANIFEST_ACCEPT: &str = "application/vnd.oci.image.index.v1+json, \
application/vnd.docker.distribution.manifest.list.v2+json, \
application/vnd.oci.image.manifest.v1+json, \
application/vnd.docker.distribution.manifest.v2+json;q=0.9, \
application/vnd.docker.distribution.manifest.v1+prettyjws;q=0.5";

/// 清單上限（catalog / tags）：超大 registry 不一次拉爆記憶體與連線樹。
const LIST_CAP: usize = 5000;

pub struct RegistryApi {
    client: Client,
    pub base: String,
    user: String,
    pass: String,
    tokens: TokenCache,
}

impl RegistryApi {
    pub fn new(cfg: &ConnectionConfig) -> AppResult<Self> {
        let target = reg_target(cfg, "registry");
        let tls = if target.tls { TlsOpts::from_options(cfg, "registry_tls") } else { TlsOpts::default() };
        let b = client_builder(&tls, Some(Duration::from_secs(60)))?;
        let (target, b) = apply_tunnel(cfg, target, b);
        Ok(RegistryApi {
            client: b.build().map_err(http_err)?,
            base: target.base_url(),
            user: cfg.username.trim().to_string(),
            pass: cfg.password.clone(),
            tokens: TokenCache::default(),
        })
    }

    fn has_creds(&self) -> bool {
        !self.user.is_empty()
    }

    /// 送請求並處理認證：先用快取 token（或 basic）；401 時依 challenge 換 token 重送一次。
    /// `scope` 為預期權限（`repository:x:pull`）；server challenge 帶 scope 時以它為準。
    async fn send(&self, build: impl Fn() -> RequestBuilder, scope: &str) -> AppResult<Response> {
        let first = match self.tokens.get(scope) {
            Some(tok) => build().bearer_auth(tok),
            None if self.has_creds() => build().basic_auth(&self.user, Some(&self.pass)),
            None => build(),
        };
        let resp = first.send().await.map_err(http_err)?;
        if resp.status() != StatusCode::UNAUTHORIZED {
            return check_status(resp).await;
        }
        let challenge = resp
            .headers()
            .get(WWW_AUTHENTICATE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_challenge);
        match challenge {
            Some(Challenge::Bearer { realm, service, scope: ch_scope }) => {
                let want = if ch_scope.is_empty() { scope.to_string() } else { ch_scope };
                let tok = self.fetch_token(&realm, &service, &want).await?;
                self.tokens.put(scope, tok.0.clone(), tok.1);
                let resp = build().bearer_auth(tok.0).send().await.map_err(http_err)?;
                check_status(resp).await
            }
            Some(Challenge::Basic) if !self.has_creds() => {
                Err(AppError::Connect(t!("此 registry 需要帳號密碼（Basic 認證）").into()))
            }
            _ => check_status(resp).await,
        }
    }

    async fn fetch_token(&self, realm: &str, service: &str, scope: &str) -> AppResult<(String, u64)> {
        let mut rb = self.client.get(realm);
        let mut q: Vec<(&str, &str)> = Vec::new();
        if !service.is_empty() {
            q.push(("service", service));
        }
        if !scope.is_empty() {
            q.push(("scope", scope));
        }
        rb = rb.query(&q);
        if self.has_creds() {
            rb = rb.basic_auth(&self.user, Some(&self.pass));
        }
        let resp = rb.send().await.map_err(http_err)?;
        if !resp.status().is_success() {
            let code = resp.status().as_u16();
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Connect(tf!(
                "向 token 服務換發權杖失敗（HTTP {code}）：{body}",
                code = code,
                body = body.chars().take(300).collect::<String>()
            )));
        }
        let v: Value = resp.json().await.map_err(http_err)?;
        let tok = v["token"].as_str().or_else(|| v["access_token"].as_str()).unwrap_or_default().to_string();
        if tok.is_empty() {
            return Err(AppError::Connect(t!("token 服務沒有回傳權杖").into()));
        }
        Ok((tok, v["expires_in"].as_u64().unwrap_or(60)))
    }

    fn get(&self, path: &str) -> impl Fn() -> RequestBuilder + '_ {
        let url = format!("{}{}", self.base, path);
        move || self.client.request(Method::GET, &url)
    }

    // ---- API ----

    /// `/v2/` 探測 + `_catalog` 可用性。
    pub async fn probe(&self) -> AppResult<RegistryInfo> {
        let resp = self.send(self.get("/v2/"), "").await?;
        let api_version = resp
            .headers()
            .get("docker-distribution-api-version")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let auth = if self.tokens.get("").is_some() {
            "bearer"
        } else if self.has_creds() {
            "basic"
        } else {
            "none"
        };
        let catalog = self.send(self.get("/v2/_catalog?n=1"), "registry:catalog:*").await.is_ok();
        Ok(RegistryInfo { base_url: self.base.clone(), api_version, auth: auth.to_string(), catalog })
    }

    pub async fn ping(&self) -> AppResult<()> {
        self.send(self.get("/v2/"), "").await.map(|_| ())
    }

    /// 全部 repository（`Link` 分頁，上限 LIST_CAP）。
    pub async fn catalog(&self) -> AppResult<Vec<String>> {
        self.paged("/v2/_catalog?n=500", "repositories", "registry:catalog:*").await
    }

    /// repository 的 tag 清單。
    pub async fn tags(&self, repo: &str) -> AppResult<Vec<String>> {
        let mut tags = self
            .paged(&format!("/v2/{}/tags/list?n=1000", repo_path(repo)), "tags", &pull_scope(repo))
            .await?;
        tags.sort_by(|a, b| natural_cmp(b, a)); // 新版本（數字大）在前
        Ok(tags)
    }

    async fn paged(&self, first: &str, field: &str, scope: &str) -> AppResult<Vec<String>> {
        let mut out = Vec::new();
        let mut path = first.to_string();
        loop {
            let resp = self.send(self.get(&path), scope).await?;
            let next = resp.headers().get(LINK).and_then(|v| v.to_str().ok()).and_then(next_link);
            let v: Value = resp.json().await.map_err(http_err)?;
            if let Some(a) = v[field].as_array() {
                out.extend(a.iter().filter_map(|x| x.as_str().map(str::to_string)));
            }
            match next {
                Some(n) if out.len() < LIST_CAP => path = n,
                _ => break,
            }
        }
        out.truncate(LIST_CAP);
        Ok(out)
    }

    /// 取 manifest（單一映像會一併取 config blob）。
    pub async fn manifest(&self, repo: &str, reference: &str) -> AppResult<RegistryManifest> {
        let url = format!("{}/v2/{}/manifests/{}", self.base, repo_path(repo), reference);
        let resp = self
            .send(|| self.client.get(&url).header(ACCEPT, MANIFEST_ACCEPT), &pull_scope(repo))
            .await?;
        let digest = header_str(&resp, "docker-content-digest");
        let ctype = header_str(&resp, "content-type");
        let body = resp.text().await.map_err(http_err)?;
        let v: Value = serde_json::from_str(&body).map_err(|e| AppError::Query(e.to_string()))?;
        let mut m = parse_manifest(repo, reference, &digest, &ctype, &v, &body);
        if !m.is_index && !m.config_digest.is_empty() {
            m.config = self.config_blob(repo, &m.config_digest).await.ok();
        }
        Ok(m)
    }

    async fn config_blob(&self, repo: &str, digest: &str) -> AppResult<RegistryImageConfig> {
        // blob 常 307 轉到物件儲存（S3 / GCS）；reqwest 跨主機轉址會自動丟掉 Authorization，正合所需。
        let resp = self
            .send(self.get(&format!("/v2/{}/blobs/{}", repo_path(repo), digest)), &pull_scope(repo))
            .await?;
        let v: Value = resp.json().await.map_err(http_err)?;
        Ok(parse_config(&v))
    }

    /// 刪除 manifest（依 digest；給 tag 會先 HEAD 取 digest）。registry 需開啟刪除。
    pub async fn delete(&self, repo: &str, reference: &str) -> AppResult<()> {
        let digest = if reference.starts_with("sha256:") {
            reference.to_string()
        } else {
            let url = format!("{}/v2/{}/manifests/{}", self.base, repo_path(repo), reference);
            let resp = self
                .send(|| self.client.head(&url).header(ACCEPT, MANIFEST_ACCEPT), &pull_scope(repo))
                .await?;
            let d = header_str(&resp, "docker-content-digest");
            if d.is_empty() {
                return Err(AppError::Query(t!("registry 沒有回傳 digest，無法依 tag 刪除").into()));
            }
            d
        };
        let url = format!("{}/v2/{}/manifests/{}", self.base, repo_path(repo), digest);
        let scope = format!("repository:{repo}:delete");
        match self.send(|| self.client.delete(&url), &scope).await {
            Ok(_) => Ok(()),
            Err(AppError::Query(m)) if m.contains("405") => Err(AppError::Query(
                t!("此 registry 未啟用刪除（registry:2 需設 REGISTRY_STORAGE_DELETE_ENABLED=true）").into(),
            )),
            Err(e) => Err(e),
        }
    }
}

fn pull_scope(repo: &str) -> String {
    format!("repository:{repo}:pull")
}

/// repo 名本身含 `/`（`library/nginx`）；各段 percent-encode，但保留分隔的 `/`。
fn repo_path(repo: &str) -> String {
    repo.split('/').map(enc).collect::<Vec<_>>().join("/")
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

fn header_str(resp: &Response, name: &str) -> String {
    resp.headers().get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

async fn check_status(resp: Response) -> AppResult<Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let code = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    // Registry 錯誤格式：{"errors":[{"code":"NAME_UNKNOWN","message":"…"}]}
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v["errors"].as_array().map(|a| {
                a.iter()
                    .map(|e| format!("{} {}", e["code"].as_str().unwrap_or(""), e["message"].as_str().unwrap_or("")).trim().to_string())
                    .collect::<Vec<_>>()
                    .join("; ")
            })
        })
        .filter(|s| !s.is_empty())
        .unwrap_or(body);
    let err = format!("Registry {code}：{}", msg.trim());
    Err(if code == 401 || code == 403 { AppError::Connect(err) } else { AppError::Query(err) })
}

/// `Link: </v2/_catalog?last=x&n=500>; rel="next"` → 路徑。
pub(crate) fn next_link(h: &str) -> Option<String> {
    for part in h.split(',') {
        let part = part.trim();
        if !part.contains("rel=\"next\"") && !part.contains("rel=next") {
            continue;
        }
        let start = part.find('<')? + 1;
        let end = part[start..].find('>')? + start;
        let url = &part[start..end];
        // 可能是絕對 URL；只取 path + query。
        let path = match url.find("/v2/") {
            Some(i) => &url[i..],
            None => url,
        };
        return Some(path.to_string());
    }
    None
}

/// 數字段以數值比較的自然排序（`1.10` > `1.9`）。
pub(crate) fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let (va, vb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = va.len().cmp(&vb.len()).then_with(|| va.cmp(vb));
                if ord != std::cmp::Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_string()
}

fn strs(v: &Value, k: &str) -> Vec<String> {
    v[k].as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub(crate) fn parse_manifest(repo: &str, reference: &str, digest: &str, ctype: &str, v: &Value, body: &str) -> RegistryManifest {
    let media_type = v["mediaType"].as_str().map(str::to_string).unwrap_or_else(|| ctype.split(';').next().unwrap_or("").to_string());
    let is_index = v["manifests"].is_array();
    let layers: Vec<RegistryLayer> = v["layers"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|l| RegistryLayer { digest: s(l, "digest"), size: l["size"].as_i64().unwrap_or(0), media_type: s(l, "mediaType") })
                .collect()
        })
        .unwrap_or_default();
    let platforms: Vec<RegistryPlatform> = v["manifests"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|m| {
                    let p = &m["platform"];
                    RegistryPlatform {
                        digest: s(m, "digest"),
                        os: s(p, "os"),
                        arch: s(p, "architecture"),
                        variant: s(p, "variant"),
                        size: m["size"].as_i64().unwrap_or(0),
                        media_type: s(m, "mediaType"),
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let config_size = v["config"]["size"].as_i64().unwrap_or(0);
    let size = if is_index {
        platforms.iter().map(|p| p.size).sum()
    } else {
        config_size + layers.iter().map(|l| l.size).sum::<i64>()
    };
    let raw = serde_json::to_string_pretty(v).unwrap_or_else(|_| body.to_string());
    RegistryManifest {
        repository: repo.to_string(),
        reference: reference.to_string(),
        digest: digest.to_string(),
        media_type,
        size,
        is_index,
        layers,
        platforms,
        config_digest: s(&v["config"], "digest"),
        config: None,
        raw,
    }
}

pub(crate) fn parse_config(v: &Value) -> RegistryImageConfig {
    let c = &v["config"];
    RegistryImageConfig {
        created: s(v, "created"),
        os: s(v, "os"),
        arch: s(v, "architecture"),
        author: s(v, "author"),
        entrypoint: strs(c, "Entrypoint"),
        cmd: strs(c, "Cmd"),
        env: strs(c, "Env"),
        exposed_ports: c["ExposedPorts"].as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default(),
        working_dir: s(c, "WorkingDir"),
        user: s(c, "User"),
        labels: c["Labels"]
            .as_object()
            .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
            .unwrap_or_default(),
        history: v["history"]
            .as_array()
            .map(|a| a.iter().map(|h| s(h, "created_by")).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn link_header() {
        assert_eq!(
            next_link(r#"</v2/_catalog?last=b&n=500>; rel="next""#).as_deref(),
            Some("/v2/_catalog?last=b&n=500")
        );
        assert_eq!(
            next_link(r#"<https://reg.example.com/v2/x/tags/list?last=1.0&n=1000>; rel="next""#).as_deref(),
            Some("/v2/x/tags/list?last=1.0&n=1000")
        );
        assert_eq!(next_link(r#"</v2/a>; rel="prev""#), None);
    }

    #[test]
    fn natural_sort() {
        let mut v = vec!["1.9", "1.10", "latest", "1.2.3", "2"];
        v.sort_by(|a, b| natural_cmp(b, a));
        assert_eq!(v, vec!["latest", "2", "1.10", "1.9", "1.2.3"]);
    }

    #[test]
    fn repo_path_keeps_slashes() {
        assert_eq!(repo_path("library/nginx"), "library/nginx");
        assert_eq!(repo_path("a b/c"), "a%20b/c");
    }

    #[test]
    fn parse_image_manifest_and_index() {
        let img: Value = serde_json::from_str(
            r#"{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json",
            "config":{"digest":"sha256:c","size":100},
            "layers":[{"digest":"sha256:l1","size":1000,"mediaType":"x"},{"digest":"sha256:l2","size":24,"mediaType":"x"}]}"#,
        )
        .unwrap();
        let m = parse_manifest("app", "1.0", "sha256:m", "", &img, "");
        assert!(!m.is_index);
        assert_eq!((m.size, m.layers.len(), m.config_digest.as_str()), (1124, 2, "sha256:c"));

        let idx: Value = serde_json::from_str(
            r#"{"schemaVersion":2,"manifests":[
            {"digest":"sha256:a","size":500,"mediaType":"m","platform":{"os":"linux","architecture":"amd64"}},
            {"digest":"sha256:b","size":501,"mediaType":"m","platform":{"os":"linux","architecture":"arm64","variant":"v8"}}]}"#,
        )
        .unwrap();
        let m = parse_manifest("app", "1.0", "sha256:i", "application/vnd.oci.image.index.v1+json; charset=utf-8", &idx, "");
        assert!(m.is_index);
        assert_eq!(m.media_type, "application/vnd.oci.image.index.v1+json");
        assert_eq!((m.platforms[1].arch.as_str(), m.platforms[1].variant.as_str()), ("arm64", "v8"));
    }

    #[test]
    fn parse_config_blob() {
        let v: Value = serde_json::from_str(
            r#"{"created":"2026-01-01T00:00:00Z","os":"linux","architecture":"amd64",
            "config":{"Env":["A=1"],"Cmd":["nginx"],"ExposedPorts":{"80/tcp":{}},"Labels":{"k":"v"}},
            "history":[{"created_by":"ADD file"},{"empty_layer":true}]}"#,
        )
        .unwrap();
        let c = parse_config(&v);
        assert_eq!(c.exposed_ports, vec!["80/tcp"]);
        assert_eq!(c.history, vec!["ADD file"]);
        assert_eq!(c.labels.get("k").map(String::as_str), Some("v"));
    }
}
