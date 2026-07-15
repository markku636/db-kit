//! Kafka Connect REST 用戶端（仿 schema.rs）：列連接器 / 狀態 / 暫停恢復重啟 / 刪除 /
//! 設定讀寫 / plugins / 設定驗證。連線設定 `kafka_connect_url/_user/_password`。

use std::collections::BTreeMap;

use reqwest::{Client, Method};
use serde::Deserialize;

use super::dto::{KafkaConnectPlugin, KafkaConnectTask, KafkaConnectValidation, KafkaConnector, KafkaHeader};
use super::{query_err, KafkaDriver};
use crate::error::{AppError, AppResult};

impl KafkaDriver {
    fn require_connect(&self) -> AppResult<&ConnectClient> {
        self.connect
            .as_deref()
            .ok_or_else(|| AppError::Unsupported(t!("此連線未設定 Kafka Connect").into()))
    }

    pub async fn connect_list(&self) -> AppResult<Vec<KafkaConnector>> {
        self.require_connect()?.list().await
    }
    pub async fn connect_config(&self, name: &str) -> AppResult<serde_json::Value> {
        self.require_connect()?.config(name).await
    }
    pub async fn connect_pause(&self, name: &str) -> AppResult<()> {
        self.require_connect()?.simple(Method::PUT, &format!("connectors/{name}/pause")).await
    }
    pub async fn connect_resume(&self, name: &str) -> AppResult<()> {
        self.require_connect()?.simple(Method::PUT, &format!("connectors/{name}/resume")).await
    }
    pub async fn connect_restart(&self, name: &str, include_tasks: bool, only_failed: bool) -> AppResult<()> {
        self.require_connect()?.restart(name, include_tasks, only_failed).await
    }
    pub async fn connect_restart_task(&self, name: &str, task: i32) -> AppResult<()> {
        self.require_connect()?.simple(Method::POST, &format!("connectors/{name}/tasks/{task}/restart")).await
    }
    pub async fn connect_delete(&self, name: &str) -> AppResult<()> {
        self.require_connect()?.delete(name).await
    }
    pub async fn connect_put_config(&self, name: &str, config: serde_json::Value) -> AppResult<()> {
        self.require_connect()?.put_config(name, config).await
    }
    pub async fn connect_plugins(&self) -> AppResult<Vec<KafkaConnectPlugin>> {
        self.require_connect()?.plugins().await
    }
    pub async fn connect_validate(&self, class: &str, config: serde_json::Value) -> AppResult<KafkaConnectValidation> {
        self.require_connect()?.validate(class, config).await
    }
}

pub struct ConnectClient {
    base_url: String,
    user: Option<String>,
    pass: Option<String>,
    client: Client,
}

impl ConnectClient {
    pub fn new(base_url: &str, user: Option<String>, pass: Option<String>) -> AppResult<Self> {
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            user,
            pass,
            client: Client::builder().build().map_err(query_err)?,
        })
    }

    fn req(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        let mut rb = self.client.request(method, format!("{}/{}", self.base_url, path));
        if let Some(u) = &self.user {
            rb = rb.basic_auth(u, self.pass.clone());
        }
        rb
    }

    /// 無回傳內容的動作（pause/resume/restart-task）。
    async fn simple(&self, method: Method, path: &str) -> AppResult<()> {
        let resp = self.req(method, path).send().await.map_err(query_err)?;
        check_status(resp).await?;
        Ok(())
    }

    /// 列連接器（?expand=status&expand=info 單次取回名稱 + 狀態 + 設定）。
    async fn list(&self) -> AppResult<Vec<KafkaConnector>> {
        #[derive(Deserialize)]
        struct Expanded {
            status: Option<StatusResp>,
        }
        #[derive(Deserialize)]
        struct StatusResp {
            #[serde(rename = "type")]
            connector_type: Option<String>,
            connector: ConnectorState,
            #[serde(default)]
            tasks: Vec<TaskState>,
        }
        #[derive(Deserialize)]
        struct ConnectorState {
            state: String,
            #[serde(default)]
            worker_id: String,
        }
        #[derive(Deserialize)]
        struct TaskState {
            id: i32,
            state: String,
            #[serde(default)]
            worker_id: String,
            #[serde(default)]
            trace: Option<String>,
        }
        let resp = self
            .req(Method::GET, "connectors?expand=status&expand=info")
            .send()
            .await
            .map_err(query_err)?;
        let resp = check_status(resp).await?;
        let map: BTreeMap<String, Expanded> = resp.json().await.map_err(query_err)?;
        let mut out: Vec<KafkaConnector> = map
            .into_iter()
            .filter_map(|(name, e)| {
                let s = e.status?;
                Some(KafkaConnector {
                    name,
                    connector_type: s.connector_type.unwrap_or_default(),
                    state: s.connector.state,
                    worker_id: s.connector.worker_id,
                    tasks: s
                        .tasks
                        .into_iter()
                        .map(|t| KafkaConnectTask {
                            id: t.id,
                            state: t.state,
                            worker_id: t.worker_id,
                            trace: t.trace,
                        })
                        .collect(),
                })
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn config(&self, name: &str) -> AppResult<serde_json::Value> {
        let resp = self.req(Method::GET, &format!("connectors/{name}/config")).send().await.map_err(query_err)?;
        let resp = check_status(resp).await?;
        resp.json().await.map_err(query_err)
    }

    async fn restart(&self, name: &str, include_tasks: bool, only_failed: bool) -> AppResult<()> {
        let path = format!("connectors/{name}/restart?includeTasks={include_tasks}&onlyFailed={only_failed}");
        let resp = self.req(Method::POST, &path).send().await.map_err(query_err)?;
        // 舊版 Connect（<3.0）不支援 query 參數 → 404/405 時退回無參數 restart。
        if matches!(resp.status().as_u16(), 404 | 405) {
            return self.simple(Method::POST, &format!("connectors/{name}/restart")).await;
        }
        check_status(resp).await?;
        Ok(())
    }

    async fn delete(&self, name: &str) -> AppResult<()> {
        let resp = self.req(Method::DELETE, &format!("connectors/{name}")).send().await.map_err(query_err)?;
        if resp.status().as_u16() == 409 {
            return Err(AppError::Query(t!("連接器正在重新平衡，請稍後再試").into()));
        }
        check_status(resp).await?;
        Ok(())
    }

    /// 建立或更新連接器設定（PUT /connectors/{n}/config，不存在即建立）。
    async fn put_config(&self, name: &str, config: serde_json::Value) -> AppResult<()> {
        let resp = self
            .req(Method::PUT, &format!("connectors/{name}/config"))
            .json(&config)
            .send()
            .await
            .map_err(query_err)?;
        check_status(resp).await?;
        Ok(())
    }

    async fn plugins(&self) -> AppResult<Vec<KafkaConnectPlugin>> {
        #[derive(Deserialize)]
        struct Plugin {
            class: String,
            #[serde(rename = "type", default)]
            kind: String,
            #[serde(default)]
            version: String,
        }
        let resp = self.req(Method::GET, "connector-plugins").send().await.map_err(query_err)?;
        let resp = check_status(resp).await?;
        let ps: Vec<Plugin> = resp.json().await.map_err(query_err)?;
        Ok(ps
            .into_iter()
            .map(|p| KafkaConnectPlugin { class: p.class, kind: p.kind, version: p.version })
            .collect())
    }

    /// 驗證連接器設定（PUT /connector-plugins/{class}/config/validate）。回傳每欄錯誤。
    async fn validate(&self, class: &str, config: serde_json::Value) -> AppResult<KafkaConnectValidation> {
        #[derive(Deserialize)]
        struct ValidateResp {
            error_count: i32,
            configs: Vec<ConfigEntry>,
        }
        #[derive(Deserialize)]
        struct ConfigEntry {
            value: ConfigValue,
        }
        #[derive(Deserialize)]
        struct ConfigValue {
            name: String,
            #[serde(default)]
            errors: Vec<String>,
        }
        // class 可能含 '.'；Connect 端接受完整類名。
        let short = class.rsplit('.').next().unwrap_or(class);
        let resp = self
            .req(Method::PUT, &format!("connector-plugins/{short}/config/validate"))
            .json(&config)
            .send()
            .await
            .map_err(query_err)?;
        let resp = check_status(resp).await?;
        let r: ValidateResp = resp.json().await.map_err(query_err)?;
        let errors = r
            .configs
            .into_iter()
            .filter(|c| !c.value.errors.is_empty())
            .map(|c| KafkaHeader { key: c.value.name, value: c.value.errors.join("; ") })
            .collect();
        Ok(KafkaConnectValidation { error_count: r.error_count, errors })
    }
}

async fn check_status(resp: reqwest::Response) -> AppResult<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let code = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Err(AppError::Query(format!("Kafka Connect {code}：{body}")))
}
