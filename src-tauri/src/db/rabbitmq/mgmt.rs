//! RabbitMQ Management REST 用戶端（逐段仿 `db/kafka/connect.rs` 的 ConnectClient）：
//! reqwest + basic_auth + check_status。base URL 由 `config::mgmt_url` 決定；
//! 帳密第一版強制同 AMQP 帳密（top-level username / password），不做覆寫。
//!
//! 端點：`/api/overview`、`/api/queues/{vhost}`、`/api/exchanges/{vhost}`、
//! `/api/queues/{vhost}/{name}`、`DELETE /api/queues/{vhost}/{name}/contents`（purge）。
//! vhost / name 路徑段 percent-encode（`/` → `%2F`）。

use reqwest::{Client, Method};
use serde::Deserialize;

use super::config::pct_encode;
use super::dto::{RabbitExchange, RabbitOverview, RabbitQueue};
use super::query_err;
use crate::error::{AppError, AppResult};

/// 一個 RabbitMQ Management REST 端點（帶 basic auth）。
pub struct MgmtClient {
    base_url: String,
    user: String,
    pass: String,
    client: Client,
}

impl MgmtClient {
    pub fn new(base_url: &str, user: String, pass: String) -> AppResult<Self> {
        // 逾時：避免連到被防火牆黑洞的 15672 埠時無限期掛住。
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(query_err)?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            user,
            pass,
            client,
        })
    }

    /// 通用請求建構（帶 basic auth）。`path` 以 `/` 開頭（如 `/api/overview`）。
    fn req(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{}", self.base_url, path))
            .basic_auth(&self.user, Some(self.pass.clone()))
    }

    /// GET JSON（非 2xx → AppError::Query，含 body）。
    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> AppResult<T> {
        let resp = self.req(Method::GET, path).send().await.map_err(query_err)?;
        let resp = check_status(resp).await?;
        resp.json().await.map_err(query_err)
    }

    /// 叢集總覽。
    pub async fn overview(&self) -> AppResult<RabbitOverview> {
        let r: OverviewResp = self.get_json("/api/overview").await?;
        let node = if r.node.is_empty() { r.cluster_name } else { r.node };
        Ok(RabbitOverview {
            rabbitmq_version: r.rabbitmq_version,
            erlang_version: r.erlang_version,
            node,
            queue_total: r.object_totals.queues,
            connection_total: r.object_totals.connections,
            consumer_total: r.object_totals.consumers,
            messages_ready: r.queue_totals.messages_ready,
            messages_unacked: r.queue_totals.messages_unacknowledged,
            publish_rate: r.message_stats.publish_details.rate,
            deliver_rate: r.message_stats.deliver_get_details.rate,
        })
    }

    /// 某 vhost 的佇列清單。
    pub async fn queues(&self, vhost: &str) -> AppResult<Vec<RabbitQueue>> {
        let path = format!("/api/queues/{}", pct_encode(vhost));
        let qs: Vec<QueueResp> = self.get_json(&path).await?;
        let mut out: Vec<RabbitQueue> = qs.into_iter().map(map_queue).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// 某 vhost 的交換器清單。
    pub async fn exchanges(&self, vhost: &str) -> AppResult<Vec<RabbitExchange>> {
        let path = format!("/api/exchanges/{}", pct_encode(vhost));
        let xs: Vec<ExchangeResp> = self.get_json(&path).await?;
        let mut out: Vec<RabbitExchange> = xs
            .into_iter()
            .map(|x| RabbitExchange {
                name: x.name,
                exchange_type: x.exchange_type,
                durable: x.durable,
                auto_delete: x.auto_delete,
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// 單一佇列詳細。
    pub async fn queue_detail(&self, vhost: &str, name: &str) -> AppResult<RabbitQueue> {
        let path = format!("/api/queues/{}/{}", pct_encode(vhost), pct_encode(name));
        let q: QueueResp = self.get_json(&path).await?;
        Ok(map_queue(q))
    }

    /// 清空佇列（DELETE `/api/queues/{vhost}/{name}/contents`）。
    pub async fn purge(&self, vhost: &str, name: &str) -> AppResult<()> {
        let path = format!(
            "/api/queues/{}/{}/contents",
            pct_encode(vhost),
            pct_encode(name)
        );
        let resp = self.req(Method::DELETE, &path).send().await.map_err(query_err)?;
        check_status(resp).await?;
        Ok(())
    }
}

/// QueueResp → RabbitQueue（queue_type 空 → classic；messages_unacknowledged → messages_unacked）。
fn map_queue(q: QueueResp) -> RabbitQueue {
    let queue_type = if q.queue_type.is_empty() {
        "classic".to_string()
    } else {
        q.queue_type
    };
    RabbitQueue {
        name: q.name,
        vhost: q.vhost,
        queue_type,
        state: q.state,
        messages: q.messages,
        messages_ready: q.messages_ready,
        messages_unacked: q.messages_unacknowledged,
        consumers: q.consumers,
        durable: q.durable,
        auto_delete: q.auto_delete,
        memory: q.memory,
    }
}

async fn check_status(resp: reqwest::Response) -> AppResult<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let code = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    Err(AppError::Query(format!("RabbitMQ Management {code}：{body}")))
}

// ---- Management API 回應（內部；只取需要欄位，其餘 serde 忽略）----

#[derive(Deserialize, Default)]
struct OverviewResp {
    #[serde(default)]
    rabbitmq_version: String,
    #[serde(default)]
    erlang_version: String,
    #[serde(default)]
    node: String,
    #[serde(default)]
    cluster_name: String,
    #[serde(default)]
    object_totals: ObjectTotals,
    #[serde(default)]
    queue_totals: QueueTotals,
    #[serde(default)]
    message_stats: MessageStats,
}

#[derive(Deserialize, Default)]
struct ObjectTotals {
    #[serde(default)]
    queues: u64,
    #[serde(default)]
    connections: u64,
    #[serde(default)]
    consumers: u64,
}

#[derive(Deserialize, Default)]
struct QueueTotals {
    #[serde(default)]
    messages_ready: u64,
    #[serde(default)]
    messages_unacknowledged: u64,
}

#[derive(Deserialize, Default)]
struct MessageStats {
    #[serde(default)]
    publish_details: RateDetail,
    #[serde(default)]
    deliver_get_details: RateDetail,
}

#[derive(Deserialize, Default)]
struct RateDetail {
    #[serde(default)]
    rate: f64,
}

#[derive(Deserialize)]
struct QueueResp {
    #[serde(default)]
    name: String,
    #[serde(default)]
    vhost: String,
    #[serde(rename = "type", default)]
    queue_type: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    messages: u64,
    #[serde(default)]
    messages_ready: u64,
    #[serde(default)]
    messages_unacknowledged: u64,
    #[serde(default)]
    consumers: u64,
    #[serde(default)]
    durable: bool,
    #[serde(default)]
    auto_delete: bool,
    #[serde(default)]
    memory: u64,
}

#[derive(Deserialize)]
struct ExchangeResp {
    #[serde(default)]
    name: String,
    #[serde(rename = "type", default)]
    exchange_type: String,
    #[serde(default)]
    durable: bool,
    #[serde(default)]
    auto_delete: bool,
}
