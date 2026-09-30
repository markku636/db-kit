//! Kubernetes 指令的回傳型別（前端 `k8sTypes.ts` 對應）。資源本體一律以原始 JSON 傳給前端。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 資源種類參照（前端傳入；內建種類見 `ResRef::builtin`，其餘來自 discovery）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResRef {
    #[serde(default)]
    pub group: String,
    pub version: String,
    pub plural: String,
    #[serde(default)]
    pub kind: String,
    pub namespaced: bool,
}

/// discovery 回來的一種資源。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ApiResource {
    pub group: String,
    pub version: String,
    pub plural: String,
    pub kind: String,
    pub namespaced: bool,
    pub verbs: Vec<String>,
    pub short_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct K8sTableColumn {
    pub name: String,
    /// string / integer / number / boolean / date
    pub kind: String,
    /// 0 = 預設顯示；>0 = `-o wide` 才顯示。
    pub priority: i64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct K8sTableRow {
    pub name: String,
    pub namespace: String,
    pub cells: Vec<Value>,
}

/// server-side printing 表格。
#[derive(Debug, Clone, Serialize)]
pub struct K8sTable {
    pub columns: Vec<K8sTableColumn>,
    pub rows: Vec<K8sTableRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct K8sEvent {
    pub namespace: String,
    /// Normal / Warning
    pub kind: String,
    pub reason: String,
    pub message: String,
    pub count: i64,
    pub first: String,
    pub last: String,
    pub object_kind: String,
    pub object_name: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct K8sContainerMetrics {
    pub name: String,
    pub cpu_milli: f64,
    pub memory_bytes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct K8sPodMetrics {
    pub namespace: String,
    pub name: String,
    pub cpu_milli: f64,
    pub memory_bytes: i64,
    pub containers: Vec<K8sContainerMetrics>,
}

#[derive(Debug, Clone, Serialize)]
pub struct K8sNodeMetrics {
    pub name: String,
    pub cpu_milli: f64,
    pub memory_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct K8sNode {
    pub name: String,
    /// ready / notready / cordoned
    pub state: String,
    pub roles: Vec<String>,
    pub version: String,
    pub os_image: String,
    pub arch: String,
    pub internal_ip: String,
    pub cpu_capacity_milli: f64,
    pub memory_capacity_bytes: i64,
    pub cpu_usage_milli: Option<f64>,
    pub memory_usage_bytes: Option<i64>,
    pub pods: i64,
    pub created: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct K8sOverview {
    pub label: String,
    pub server: String,
    pub version: String,
    pub platform: String,
    /// -1 = 沒權限列出。
    pub namespaces: i64,
    pub pods: i64,
    pub pod_phases: BTreeMap<String, i64>,
    pub nodes: Vec<K8sNode>,
    pub metrics_available: bool,
    pub warnings: Vec<K8sEvent>,
    /// 部分資訊取不到（多為 RBAC）時的錯誤訊息。
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct K8sApplyResult {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    /// created / configured（有 error 時為空）
    pub action: String,
    pub error: Option<String>,
}

/// Pod 環境變數的實際值。
#[derive(Debug, Clone, Serialize)]
pub struct K8sEnvVar {
    pub container: String,
    pub name: String,
    pub value: String,
    /// 值來自 Secret（前端遮罩）。
    pub secret: bool,
}

/// log 串流選項。
#[derive(Debug, Clone, Deserialize, Default)]
pub struct LogOptions {
    #[serde(default)]
    pub container: String,
    #[serde(default)]
    pub tail: u32,
    #[serde(default)]
    pub timestamps: bool,
    #[serde(default)]
    pub follow: bool,
    #[serde(default)]
    pub previous: bool,
    #[serde(default)]
    pub since_seconds: u64,
}

/// 進行中的 port-forward。
#[derive(Debug, Clone, Serialize)]
pub struct K8sForwardInfo {
    pub id: String,
    pub conn_id: String,
    pub namespace: String,
    /// 使用者指定的目標（`svc/pg`、`pod/x`）。
    pub target: String,
    /// 實際轉到的 Pod。
    pub pod: String,
    pub remote_port: u16,
    pub local_port: u16,
    /// 目前開著的 TCP 連線數。
    pub active: u32,
    pub started: String,
    /// 最近一次錯誤（例如 Pod 被刪了）。
    pub last_error: Option<String>,
}
