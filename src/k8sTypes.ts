// Kubernetes 指令的回傳型別（對應 src-tauri/src/db/k8s/dto.rs）。資源本體是原始 JSON（K8sObject）。

/** 資源種類參照（內建種類見 k8sModel.ts 的 BUILTIN；其餘來自 discovery）。 */
export interface K8sResRef {
  group: string;
  version: string;
  plural: string;
  kind: string;
  namespaced: boolean;
}

export interface K8sApiResource extends K8sResRef {
  verbs: string[];
  short_names: string[];
}

/** 原始物件（寬鬆型別：只標出常用欄位）。 */
export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: { kind: string; name: string; controller?: boolean }[];
    resourceVersion?: string;
    [k: string]: unknown;
  };
  spec?: any;
  status?: any;
  data?: Record<string, string>;
  type?: string;
  [k: string]: unknown;
}

export interface K8sTableColumn {
  name: string;
  kind: string;
  priority: number;
  description: string;
}

export interface K8sTableRow {
  name: string;
  namespace: string;
  cells: unknown[];
}

export interface K8sTable {
  columns: K8sTableColumn[];
  rows: K8sTableRow[];
}

export interface K8sEvent {
  namespace: string;
  /** Normal / Warning */
  kind: string;
  reason: string;
  message: string;
  count: number;
  first: string;
  last: string;
  object_kind: string;
  object_name: string;
  source: string;
}

export interface K8sContainerMetrics {
  name: string;
  cpu_milli: number;
  memory_bytes: number;
}

export interface K8sPodMetrics {
  namespace: string;
  name: string;
  cpu_milli: number;
  memory_bytes: number;
  containers: K8sContainerMetrics[];
}

export interface K8sNodeMetrics {
  name: string;
  cpu_milli: number;
  memory_bytes: number;
}

export interface K8sNode {
  name: string;
  /** ready / notready / cordoned */
  state: string;
  roles: string[];
  version: string;
  os_image: string;
  arch: string;
  internal_ip: string;
  cpu_capacity_milli: number;
  memory_capacity_bytes: number;
  cpu_usage_milli: number | null;
  memory_usage_bytes: number | null;
  pods: number;
  created: string;
}

export interface K8sOverview {
  label: string;
  server: string;
  version: string;
  platform: string;
  /** -1 = 沒權限列出 */
  namespaces: number;
  pods: number;
  pod_phases: Record<string, number>;
  nodes: K8sNode[];
  metrics_available: boolean;
  warnings: K8sEvent[];
  errors: string[];
}

export interface K8sApplyResult {
  kind: string;
  name: string;
  namespace: string;
  /** created / configured */
  action: string;
  error: string | null;
}

export interface K8sLogOptions {
  container: string;
  tail: number;
  timestamps: boolean;
  follow: boolean;
  previous: boolean;
  since_seconds: number;
}

export interface K8sForwardInfo {
  id: string;
  conn_id: string;
  namespace: string;
  target: string;
  pod: string;
  remote_port: number;
  local_port: number;
  active: number;
  started: string;
  last_error: string | null;
}

export interface K8sEnvVar {
  container: string;
  name: string;
  value: string;
  secret: boolean;
}

export interface K8sContextInfo {
  name: string;
  cluster: string;
  user: string;
  namespace: string;
  server: string;
  current: boolean;
  /** token / cert / basic / exec:<cmd> / auth-provider:<name> */
  auth: string;
}

export interface K8sKubeconfigInfo {
  files: string[];
  current_context: string;
  contexts: K8sContextInfo[];
}

export interface K8sStreamEnd {
  stream_id: string;
  error: string | null;
  exit_code: number | null;
}
