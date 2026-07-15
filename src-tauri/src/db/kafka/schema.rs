//! Confluent Schema Registry 用戶端：列 subjects / 取 schema，並依 wire-format schema id 解 Avro binary。
//!
//! Wire 格式：magic byte `0x00` + schema id（int32 big-endian）+ payload。
//! Avro → JSON 完整解碼；Protobuf / JSON-schema MVP 為顯示-only（protobuf 需 descriptor）。
//!
//! 註：SR 帳密目前存於連線 options（明文，隨 connections.json 落地）。TODO：移至 keychain。

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;
use reqwest::Client;
use serde::Deserialize;

use super::dto::{KafkaSchema, KafkaSchemaSubject};
use super::{query_err, KafkaDriver};
use crate::error::{AppError, AppResult};

impl KafkaDriver {
    fn require_sr(&self) -> AppResult<&SchemaRegistry> {
        self.schema
            .as_deref()
            .ok_or_else(|| AppError::Unsupported(t!("此連線未設定 Schema Registry").into()))
    }

    /// 列出 Schema Registry 的 subjects。
    pub async fn schema_subjects(&self) -> AppResult<Vec<KafkaSchemaSubject>> {
        self.require_sr()?.list_subjects().await
    }

    /// 取某 subject 指定版本（<=0 為 latest）的 schema。
    pub async fn get_schema(&self, subject: &str, version: i32) -> AppResult<KafkaSchema> {
        self.require_sr()?.get_schema(subject, version).await
    }
}

#[derive(Clone)]
struct CachedSchema {
    schema_type: String,
    parsed: Option<Arc<apache_avro::Schema>>,
}

pub struct SchemaRegistry {
    base_url: String,
    user: Option<String>,
    pass: Option<String>,
    client: Client,
    /// schema id → 已取回並（Avro 時）解析的 schema。
    cache: Mutex<HashMap<i32, CachedSchema>>,
}

#[derive(Deserialize)]
struct SubjectVersionResp {
    id: i32,
    version: i32,
    schema: String,
    #[serde(rename = "schemaType")]
    schema_type: Option<String>,
}

#[derive(Deserialize)]
struct SchemaByIdResp {
    schema: String,
    #[serde(rename = "schemaType")]
    schema_type: Option<String>,
}

impl SchemaRegistry {
    pub fn new(base_url: &str, user: Option<String>, pass: Option<String>) -> AppResult<Self> {
        let client = Client::builder()
            .build()
            .map_err(query_err)?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            user,
            pass,
            client,
            cache: Mutex::new(HashMap::new()),
        })
    }

    fn get(&self, url: String) -> reqwest::RequestBuilder {
        let mut rb = self.client.get(url);
        if let Some(u) = &self.user {
            rb = rb.basic_auth(u, self.pass.clone());
        }
        rb
    }

    /// 列出所有 subject 與其版本。
    pub async fn list_subjects(&self) -> AppResult<Vec<KafkaSchemaSubject>> {
        let subjects: Vec<String> = self
            .get(format!("{}/subjects", self.base_url))
            .send()
            .await
            .map_err(query_err)?
            .error_for_status()
            .map_err(query_err)?
            .json()
            .await
            .map_err(query_err)?;

        let mut out = Vec::with_capacity(subjects.len());
        for s in subjects {
            let versions: Vec<i32> = self
                .get(format!("{}/subjects/{}/versions", self.base_url, s))
                .send()
                .await
                .map_err(query_err)?
                .json()
                .await
                .unwrap_or_default();
            let latest = versions.iter().copied().max().unwrap_or(0);
            out.push(KafkaSchemaSubject {
                subject: s,
                versions,
                latest,
            });
        }
        out.sort_by(|a, b| a.subject.cmp(&b.subject));
        Ok(out)
    }

    /// 取某 subject 指定版本（version <= 0 視為 latest）的 schema。
    pub async fn get_schema(&self, subject: &str, version: i32) -> AppResult<KafkaSchema> {
        let ver = if version <= 0 {
            "latest".to_string()
        } else {
            version.to_string()
        };
        let resp: SubjectVersionResp = self
            .get(format!(
                "{}/subjects/{}/versions/{}",
                self.base_url, subject, ver
            ))
            .send()
            .await
            .map_err(query_err)?
            .error_for_status()
            .map_err(query_err)?
            .json()
            .await
            .map_err(query_err)?;
        Ok(KafkaSchema {
            subject: subject.to_string(),
            version: resp.version,
            id: resp.id,
            schema_type: resp.schema_type.unwrap_or_else(|| "AVRO".to_string()),
            schema: resp.schema,
        })
    }

    /// 依 id 取回並快取 schema（Avro 時解析成 apache_avro::Schema）。
    async fn schema_by_id(&self, id: i32) -> AppResult<CachedSchema> {
        if let Some(c) = self.cache.lock().get(&id).cloned() {
            return Ok(c);
        }
        let resp: SchemaByIdResp = self
            .get(format!("{}/schemas/ids/{}", self.base_url, id))
            .send()
            .await
            .map_err(query_err)?
            .error_for_status()
            .map_err(query_err)?
            .json()
            .await
            .map_err(query_err)?;
        let schema_type = resp.schema_type.unwrap_or_else(|| "AVRO".to_string());
        let parsed = if schema_type.eq_ignore_ascii_case("AVRO") {
            apache_avro::Schema::parse_str(&resp.schema).ok().map(Arc::new)
        } else {
            None
        };
        let cached = CachedSchema {
            schema_type,
            parsed,
        };
        self.cache.lock().insert(id, cached.clone());
        Ok(cached)
    }

    /// 解 Confluent wire-format value → (顯示字串, encoding, schema_id)。非框架格式回 None。
    pub async fn decode(&self, bytes: &[u8]) -> Option<(String, String, i32)> {
        if bytes.len() < 5 || bytes[0] != 0x00 {
            return None;
        }
        let id = i32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        let cached = self.schema_by_id(id).await.ok()?;
        if cached.schema_type.eq_ignore_ascii_case("AVRO") {
            if let Some(schema) = &cached.parsed {
                let mut cursor = &bytes[5..];
                if let Ok(value) = apache_avro::from_avro_datum(schema, &mut cursor, None) {
                    // apache_avro::types::Value 未實作 Serialize，經 TryFrom → serde_json::Value。
                    if let Ok(jv) = serde_json::Value::try_from(value) {
                        if let Ok(json) = serde_json::to_string_pretty(&jv) {
                            return Some((json, "avro".to_string(), id));
                        }
                    }
                }
            }
            return Some((format!("(avro schema id {id}，解碼失敗)"), "avro".to_string(), id));
        }
        // Protobuf / JSON-schema：MVP 顯示-only。
        let enc = cached.schema_type.to_lowercase();
        Some((format!("({enc} schema id {id}，未解碼)"), enc, id))
    }
}
