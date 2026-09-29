//! Docker 對前端的 DTO（snake_case，與 src/api.ts 對齊）。Engine API 的原始回應（PascalCase）
//! 在 api.rs 內部解析後映射到這裡，只保留介面用得到的欄位。

use std::collections::BTreeMap;

use serde::Serialize;

/// 引擎總覽（/version + /info）。
#[derive(Debug, Clone, Serialize, Default)]
pub struct DockerOverview {
    pub endpoint: String,
    pub server_version: String,
    pub api_version: String,
    pub os: String,
    pub os_type: String,
    pub arch: String,
    pub kernel: String,
    pub name: String,
    pub ncpu: i64,
    pub mem_total: i64,
    pub driver: String,
    pub root_dir: String,
    pub containers: i64,
    pub running: i64,
    pub paused: i64,
    pub stopped: i64,
    pub images: i64,
    pub warnings: Vec<String>,
}

/// 容器發布的埠。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DockerPort {
    pub private_port: u16,
    pub public_port: Option<u16>,
    pub ip: String,
    pub proto: String,
}

/// 容器清單列。
#[derive(Debug, Clone, Serialize)]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub command: String,
    pub created: i64,
    /// running / exited / paused / restarting / created / dead / removing
    pub state: String,
    /// 人類可讀狀態（"Up 3 hours (healthy)"）。
    pub status: String,
    pub ports: Vec<DockerPort>,
    /// compose 專案名（label `com.docker.compose.project`）。
    pub compose_project: String,
    pub compose_service: String,
}

/// 掛載點。
#[derive(Debug, Clone, Serialize)]
pub struct DockerMount {
    pub kind: String,
    pub name: String,
    pub source: String,
    pub destination: String,
    pub mode: String,
    pub rw: bool,
}

/// 容器所在網路。
#[derive(Debug, Clone, Serialize)]
pub struct DockerContainerNet {
    pub name: String,
    pub ip: String,
    pub gateway: String,
    pub mac: String,
    pub aliases: Vec<String>,
}

/// health check 紀錄。
#[derive(Debug, Clone, Serialize)]
pub struct DockerHealthLog {
    pub start: String,
    pub exit_code: i64,
    pub output: String,
}

/// 容器詳情（inspect 精簡版 + 原始 JSON）。
#[derive(Debug, Clone, Serialize)]
pub struct DockerContainerDetail {
    pub id: String,
    pub name: String,
    pub image: String,
    pub image_id: String,
    pub created: String,
    pub state: String,
    pub running: bool,
    pub paused: bool,
    pub restarting: bool,
    pub oom_killed: bool,
    pub pid: i64,
    pub exit_code: i64,
    pub error: String,
    pub started_at: String,
    pub finished_at: String,
    pub restart_count: i64,
    pub restart_policy: String,
    pub health: String,
    pub health_log: Vec<DockerHealthLog>,
    pub tty: bool,
    pub hostname: String,
    pub user: String,
    pub working_dir: String,
    pub entrypoint: Vec<String>,
    pub cmd: Vec<String>,
    pub env: Vec<String>,
    pub labels: BTreeMap<String, String>,
    pub ports: Vec<DockerPort>,
    pub mounts: Vec<DockerMount>,
    pub networks: Vec<DockerContainerNet>,
    pub network_mode: String,
    /// 完整 inspect JSON（排版後），供「JSON」檢視與複製。
    pub raw: String,
}

/// 單次資源用量快照。
#[derive(Debug, Clone, Serialize, Default)]
pub struct DockerStats {
    pub cpu_percent: f64,
    pub online_cpus: i64,
    pub mem_usage: i64,
    pub mem_limit: i64,
    pub mem_percent: f64,
    pub net_rx: i64,
    pub net_tx: i64,
    pub blk_read: i64,
    pub blk_write: i64,
    pub pids: i64,
}

/// 容器內行程（/top）。
#[derive(Debug, Clone, Serialize)]
pub struct DockerTop {
    pub titles: Vec<String>,
    pub processes: Vec<Vec<String>>,
}

/// 映像清單列（每個 tag 一列；無 tag 的懸空映像以短 id 表示）。
#[derive(Debug, Clone, Serialize)]
pub struct DockerImage {
    pub id: String,
    /// 樹節點 / 操作用的參照：`repo:tag`，懸空映像為短 id。
    pub reference: String,
    pub repo_tags: Vec<String>,
    pub repo_digests: Vec<String>,
    pub created: i64,
    pub size: i64,
    /// 使用中的容器數（daemon 未計算時為 -1）。
    pub containers: i64,
    pub dangling: bool,
}

/// 映像建置歷史的一層。
#[derive(Debug, Clone, Serialize)]
pub struct DockerImageLayer {
    pub created: i64,
    pub created_by: String,
    pub size: i64,
    pub comment: String,
}

/// 映像詳情。
#[derive(Debug, Clone, Serialize)]
pub struct DockerImageDetail {
    pub id: String,
    pub repo_tags: Vec<String>,
    pub repo_digests: Vec<String>,
    pub created: String,
    pub arch: String,
    pub os: String,
    pub size: i64,
    pub author: String,
    pub entrypoint: Vec<String>,
    pub cmd: Vec<String>,
    pub env: Vec<String>,
    pub exposed_ports: Vec<String>,
    pub working_dir: String,
    pub user: String,
    pub labels: BTreeMap<String, String>,
    pub layers: usize,
    pub history: Vec<DockerImageLayer>,
    pub raw: String,
}

/// Volume。
#[derive(Debug, Clone, Serialize)]
pub struct DockerVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub created: String,
    pub scope: String,
    pub labels: BTreeMap<String, String>,
    /// 使用此 volume 的容器名（由容器清單推得）。
    pub used_by: Vec<String>,
    pub raw: String,
}

/// 網路上連接的容器。
#[derive(Debug, Clone, Serialize)]
pub struct DockerNetworkMember {
    pub name: String,
    pub ipv4: String,
    pub mac: String,
}

/// Network。
#[derive(Debug, Clone, Serialize)]
pub struct DockerNetwork {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub internal: bool,
    pub subnets: Vec<String>,
    pub gateways: Vec<String>,
    pub members: Vec<DockerNetworkMember>,
    /// bridge / host / none 等內建網路不可刪。
    pub builtin: bool,
    pub raw: String,
}

/// 磁碟用量（/system/df）。
#[derive(Debug, Clone, Serialize, Default)]
pub struct DockerDiskUsage {
    pub images_count: i64,
    pub images_size: i64,
    /// 沒有任何容器使用的映像大小（可回收）。
    pub images_reclaimable: i64,
    pub containers_count: i64,
    pub containers_size: i64,
    pub volumes_count: i64,
    pub volumes_size: i64,
    pub volumes_reclaimable: i64,
    pub build_cache_count: i64,
    pub build_cache_size: i64,
}

/// prune 結果。
#[derive(Debug, Clone, Serialize, Default)]
pub struct DockerPruneResult {
    pub deleted: i64,
    pub space_reclaimed: i64,
}

/// 拉取映像的進度事件（逐行 JSON）。
#[derive(Debug, Clone, Serialize)]
pub struct DockerPullProgress {
    pub id: String,
    pub status: String,
    pub progress: String,
    pub current: i64,
    pub total: i64,
    pub error: String,
}
