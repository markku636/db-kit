//! Elasticsearch / OpenSearch REST 用戶端（reqwest 包裝，逐段仿 `db/kafka/schema.rs`）。
//!
//! base URL 組成與認證由 `config.rs` 決定；此處只負責帶認證發請求、把非 2xx body
//! 納入 `AppError::Query`，並提供 GET/POST/PUT/DELETE 的 JSON helper。

use reqwest::{Client, Method};

use crate::error::{AppError, AppResult};

/// 認證方式。
pub enum EsAuth {
    /// 不帶認證。
    None,
    /// HTTP Basic（username / password）。
    Basic { user: String, pass: String },
    /// `Authorization: ApiKey <value>`；value 已是 base64(id:key)。
    ApiKey(String),
}

/// EsClient 建構參數（由 `config::build_params` 產生）。
pub struct EsClientParams {
    pub base_url: String,
    pub auth: EsAuth,
    /// 自訂 CA 憑證（PEM bytes）；None = 用系統信任根（reqwest rustls-tls-native-roots）。
    pub ca_pem: Option<Vec<u8>>,
    /// 略過 TLS 憑證驗證（自簽 / 內網）。
    pub insecure: bool,
}

/// 連線 / 建立錯誤 → AppError::Connect。
fn conn_err(e: impl std::fmt::Display) -> AppError {
    AppError::Connect(e.to_string())
}

/// 查詢 / 操作錯誤 → AppError::Query。
fn query_err(e: impl std::fmt::Display) -> AppError {
    AppError::Query(e.to_string())
}

/// 一個 Elasticsearch / OpenSearch REST 端點。
pub struct EsClient {
    base_url: String,
    auth: EsAuth,
    client: Client,
}

impl EsClient {
    pub fn new(params: EsClientParams) -> AppResult<Self> {
        // 逾時：避免連到被防火牆黑洞掉的主機時無限期掛住（ES 端 ?timeout= 只約束叢集層，管不到 TCP/HTTP）。
        let mut builder = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30));
        if let Some(pem) = &params.ca_pem {
            let cert = reqwest::Certificate::from_pem(pem).map_err(conn_err)?;
            builder = builder.add_root_certificate(cert);
        }
        if params.insecure {
            builder = builder.danger_accept_invalid_certs(true);
        }
        let client = builder.build().map_err(conn_err)?;
        Ok(Self {
            base_url: params.base_url.trim_end_matches('/').to_string(),
            auth: params.auth,
            client,
        })
    }

    /// 通用請求建構（帶認證）。`path` 以 `/` 開頭（如 `/_cluster/health`）。
    fn req(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self.client.request(method, format!("{}{}", self.base_url, path));
        match &self.auth {
            EsAuth::None => {}
            EsAuth::Basic { user, pass } => {
                rb = rb.basic_auth(user, Some(pass.clone()));
            }
            EsAuth::ApiKey(value) => {
                rb = rb.header(reqwest::header::AUTHORIZATION, format!("ApiKey {value}"));
            }
        }
        rb
    }

    /// 檢查回應狀態；非 2xx 時把 body（含 ES error / reason）納入 AppError::Query。
    async fn check_status(resp: reqwest::Response) -> AppResult<reqwest::Response> {
        if resp.status().is_success() {
            return Ok(resp);
        }
        let code = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        Err(AppError::Query(format!("Elasticsearch {code}：{body}")))
    }

    pub async fn get_json(&self, path: &str) -> AppResult<serde_json::Value> {
        let resp = self.req(Method::GET, path).send().await.map_err(query_err)?;
        let resp = Self::check_status(resp).await?;
        resp.json().await.map_err(query_err)
    }

    /// GET，允許 404 回 None（如文件不存在）。
    pub async fn get_json_opt(&self, path: &str) -> AppResult<Option<serde_json::Value>> {
        let resp = self.req(Method::GET, path).send().await.map_err(query_err)?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        let resp = Self::check_status(resp).await?;
        resp.json().await.map(Some).map_err(query_err)
    }

    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let resp = self
            .req(Method::POST, path)
            .json(body)
            .send()
            .await
            .map_err(query_err)?;
        let resp = Self::check_status(resp).await?;
        resp.json().await.map_err(query_err)
    }

    #[allow(dead_code)] // 第一版唯讀；PUT helper 供日後寫入路徑（建索引 / 更新文件）用。
    pub async fn put_json(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> AppResult<serde_json::Value> {
        let resp = self
            .req(Method::PUT, path)
            .json(body)
            .send()
            .await
            .map_err(query_err)?;
        let resp = Self::check_status(resp).await?;
        resp.json().await.map_err(query_err)
    }

    pub async fn delete_json(&self, path: &str) -> AppResult<serde_json::Value> {
        let resp = self.req(Method::DELETE, path).send().await.map_err(query_err)?;
        let resp = Self::check_status(resp).await?;
        resp.json().await.map_err(query_err)
    }
}
