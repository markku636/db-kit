//! Registry v2 對前端的 DTO（snake_case，與 src/api.ts 對齊）。

use std::collections::BTreeMap;

use serde::Serialize;

/// 端點概況（`/v2/` 探測結果）。
#[derive(Debug, Clone, Serialize)]
pub struct RegistryInfo {
    pub base_url: String,
    /// `Docker-Distribution-Api-Version` header（多為 `registry/2.0`）。
    pub api_version: String,
    /// 認證方式：none / basic / bearer。
    pub auth: String,
    /// `_catalog` 是否可用（Docker Hub / GHCR 等不開放）。
    pub catalog: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegistryLayer {
    pub digest: String,
    pub size: i64,
    pub media_type: String,
}

/// 多平台清單（OCI index / manifest list）的一項。
#[derive(Debug, Clone, Serialize)]
pub struct RegistryPlatform {
    pub digest: String,
    pub os: String,
    pub arch: String,
    pub variant: String,
    pub size: i64,
    pub media_type: String,
}

/// 映像 config blob 的精簡內容。
#[derive(Debug, Clone, Serialize, Default)]
pub struct RegistryImageConfig {
    pub created: String,
    pub os: String,
    pub arch: String,
    pub author: String,
    pub entrypoint: Vec<String>,
    pub cmd: Vec<String>,
    pub env: Vec<String>,
    pub exposed_ports: Vec<String>,
    pub working_dir: String,
    pub user: String,
    pub labels: BTreeMap<String, String>,
    /// 建置歷史（created_by）。
    pub history: Vec<String>,
}

/// 一個 manifest（單一映像或多平台清單）。
#[derive(Debug, Clone, Serialize)]
pub struct RegistryManifest {
    pub repository: String,
    pub reference: String,
    pub digest: String,
    pub media_type: String,
    /// 映像總大小（config + layers；index 為各平台 manifest 本身大小總和）。
    pub size: i64,
    pub is_index: bool,
    pub layers: Vec<RegistryLayer>,
    pub platforms: Vec<RegistryPlatform>,
    pub config_digest: String,
    pub config: Option<RegistryImageConfig>,
    pub raw: String,
}
