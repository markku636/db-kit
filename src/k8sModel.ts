// Kubernetes 前端模型：內建資源種類、連線樹節點的解析（`種類/名稱`、`k8s:<種類>:<狀態>`）、狀態色調、
// 常用欄位摘要（Pod 容器狀態、workload 副本、Service 埠）與格式化。純函式，方便 vitest。
import type { K8sObject, K8sResRef } from "./k8sTypes";

/** 連線樹上代表 cluster 範圍資源的 database 名稱（與後端 CLUSTER_DB 一致）。 */
export const CLUSTER_DB = "(cluster)";

type Builtin = { ref: K8sResRef; label: string; short: string };

const B = (group: string, version: string, plural: string, kind: string, namespaced: boolean, label: string, short: string): [string, Builtin] =>
  [plural, { ref: { group, version, plural, kind, namespaced }, label, short }];

/** 內建種類（與後端 ResRef::builtin 同一份）；label 為繁中 i18n key。 */
export const BUILTIN: Record<string, Builtin> = Object.fromEntries([
  B("", "v1", "pods", "Pod", true, "Pod", "pod"),
  B("apps", "v1", "deployments", "Deployment", true, "Deployment", "deploy"),
  B("apps", "v1", "statefulsets", "StatefulSet", true, "StatefulSet", "sts"),
  B("apps", "v1", "daemonsets", "DaemonSet", true, "DaemonSet", "ds"),
  B("apps", "v1", "replicasets", "ReplicaSet", true, "ReplicaSet", "rs"),
  B("batch", "v1", "jobs", "Job", true, "Job", "job"),
  B("batch", "v1", "cronjobs", "CronJob", true, "CronJob", "cronjob"),
  B("", "v1", "services", "Service", true, "Service", "svc"),
  B("networking.k8s.io", "v1", "ingresses", "Ingress", true, "Ingress", "ing"),
  B("", "v1", "configmaps", "ConfigMap", true, "ConfigMap", "cm"),
  B("", "v1", "secrets", "Secret", true, "Secret", "secret"),
  B("", "v1", "persistentvolumeclaims", "PersistentVolumeClaim", true, "PVC", "pvc"),
  B("autoscaling", "v2", "horizontalpodautoscalers", "HorizontalPodAutoscaler", true, "HPA", "hpa"),
  B("", "v1", "serviceaccounts", "ServiceAccount", true, "ServiceAccount", "sa"),
  B("", "v1", "endpoints", "Endpoints", true, "Endpoints", "ep"),
  B("", "v1", "events", "Event", true, "Event", "ev"),
  B("", "v1", "nodes", "Node", false, "Node", "node"),
  B("", "v1", "namespaces", "Namespace", false, "Namespace", "ns"),
  B("", "v1", "persistentvolumes", "PersistentVolume", false, "PV", "pv"),
  B("storage.k8s.io", "v1", "storageclasses", "StorageClass", false, "StorageClass", "sc"),
  B("apiextensions.k8s.io", "v1", "customresourcedefinitions", "CustomResourceDefinition", false, "CRD", "crd"),
]);

/** namespace 節點下的資料夾順序（與後端 TREE_KINDS 一致）。 */
export const TREE_KINDS = [
  "pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs",
  "services", "ingresses", "configmaps", "secrets", "persistentvolumeclaims", "horizontalpodautoscalers",
] as const;
export const CLUSTER_TREE_KINDS = ["nodes", "persistentvolumes", "storageclasses", "customresourcedefinitions"] as const;

export function builtinRef(plural: string): K8sResRef | null {
  return BUILTIN[plural]?.ref ?? null;
}

/** 資料夾標籤（複數顯示名）。 */
export const FOLDER_LABEL: Record<string, string> = {
  pods: "Pods", deployments: "Deployments", statefulsets: "StatefulSets", daemonsets: "DaemonSets",
  jobs: "Jobs", cronjobs: "CronJobs", services: "Services", ingresses: "Ingresses", configmaps: "ConfigMaps",
  secrets: "Secrets", persistentvolumeclaims: "PVCs", horizontalpodautoscalers: "HPAs",
  nodes: "Nodes", persistentvolumes: "PersistentVolumes", storageclasses: "StorageClasses",
  customresourcedefinitions: "CRDs",
};

/** 樹節點 table 名稱 `plural/name` → 拆開。 */
export function splitTreeName(table: string): { plural: string; name: string } {
  const i = table.indexOf("/");
  return i < 0 ? { plural: "", name: table } : { plural: table.slice(0, i), name: table.slice(i + 1) };
}

/** `k8s:<plural>:<state>` → { plural, state }；不是 k8s 節點回 null。 */
export function parseObjKind(objKind: string | undefined | null): { plural: string; state: string } | null {
  if (!objKind || !objKind.startsWith("k8s:")) return null;
  const rest = objKind.slice(4);
  const i = rest.indexOf(":");
  return i < 0 ? { plural: rest, state: "" } : { plural: rest.slice(0, i), state: rest.slice(i + 1) };
}

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/** 樹節點狀態 → 色調。 */
export function stateTone(plural: string, state: string): Tone {
  switch (state) {
    case "running": case "succeeded": case "ok": case "complete": case "ready": case "bound": case "active":
      return plural === "pods" && state === "succeeded" ? "neutral" : "success";
    case "pending": case "notready": case "warn": case "cordoned": case "released":
      return "warning";
    case "failed": case "error": case "lost":
      return "danger";
    case "terminating":
      return "info";
    case "zero": case "suspended":
      return "neutral";
    default:
      return "neutral";
  }
}

export const TONE_TEXT: Record<Tone, string> = {
  success: "text-emerald-400",
  warning: "text-amber-400",
  danger: "text-red-400",
  info: "text-sky-400",
  neutral: "text-fg/40",
};

/** 物件年齡（`3d`、`5h`、`12m`、`40s`），同 kubectl 的 AGE 欄。 */
export function age(ts: string | undefined | null, now = Date.now()): string {
  if (!ts) return "";
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return "";
  let s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  s = Math.floor(h / 24);
  return s < 730 ? `${s}d` : `${Math.floor(s / 365)}y`;
}

export function fmtCpu(milli: number | null | undefined): string {
  if (milli == null) return "—";
  if (milli >= 1000) return `${(milli / 1000).toFixed(milli >= 10000 ? 0 : 2)}`;
  return `${Math.round(milli)}m`;
}

// ---- Pod ----

export interface ContainerRow {
  name: string;
  image: string;
  init: boolean;
  ready: boolean;
  restarts: number;
  /** running / waiting / terminated / "" */
  state: string;
  reason: string;
  started: string;
  ports: { name: string; port: number; protocol: string }[];
}

export function podContainers(pod: K8sObject): ContainerRow[] {
  const statuses = new Map<string, any>();
  for (const s of [...(pod.status?.containerStatuses ?? []), ...(pod.status?.initContainerStatuses ?? [])]) statuses.set(s.name, s);
  const rows: ContainerRow[] = [];
  const add = (c: any, init: boolean) => {
    const st = statuses.get(c.name);
    const stateKey = st?.state ? Object.keys(st.state)[0] ?? "" : "";
    const inner = st?.state?.[stateKey] ?? {};
    rows.push({
      name: c.name,
      image: c.image ?? "",
      init,
      ready: !!st?.ready,
      restarts: st?.restartCount ?? 0,
      state: stateKey,
      reason: inner.reason ?? (stateKey === "terminated" && inner.exitCode != null ? `exit ${inner.exitCode}` : ""),
      started: inner.startedAt ?? "",
      ports: (c.ports ?? []).map((p: any) => ({ name: p.name ?? "", port: p.containerPort, protocol: p.protocol ?? "TCP" })),
    });
  };
  for (const c of pod.spec?.initContainers ?? []) add(c, true);
  for (const c of pod.spec?.containers ?? []) add(c, false);
  return rows;
}

/** Pod 的狀態字串（同 kubectl STATUS 欄的主要邏輯）。 */
export function podStatus(pod: K8sObject): string {
  if (pod.metadata.deletionTimestamp) return "Terminating";
  const cs: any[] = pod.status?.containerStatuses ?? [];
  for (const c of cs) {
    const w = c.state?.waiting?.reason;
    if (w) return w;
    const term = c.state?.terminated?.reason;
    if (term && pod.status?.phase !== "Succeeded") return term;
  }
  return pod.status?.reason ?? pod.status?.phase ?? "Unknown";
}

export function podReady(pod: K8sObject): string {
  const cs: any[] = pod.status?.containerStatuses ?? [];
  const n = (pod.spec?.containers ?? []).length;
  return `${cs.filter((c) => c.ready).length}/${n}`;
}

export function podRestarts(pod: K8sObject): number {
  return (pod.status?.containerStatuses ?? []).reduce((a: number, c: any) => a + (c.restartCount ?? 0), 0);
}

/** 預設容器：annotation `kubectl.kubernetes.io/default-container`，否則第一個一般容器。 */
export function defaultContainer(pod: K8sObject): string {
  const ann = pod.metadata.annotations?.["kubectl.kubernetes.io/default-container"];
  const names = (pod.spec?.containers ?? []).map((c: any) => c.name as string);
  if (ann && names.includes(ann)) return ann;
  return names[0] ?? "";
}

export function podStatusTone(status: string): Tone {
  if (status === "Running" || status === "Completed" || status === "Succeeded") return status === "Running" ? "success" : "neutral";
  if (status === "Pending" || status === "ContainerCreating" || status === "PodInitializing") return "warning";
  if (status === "Terminating") return "info";
  return "danger";
}

// ---- workload ----

export interface ReplicaSummary {
  desired: number;
  ready: number;
  updated: number;
  available: number;
}

export function replicas(o: K8sObject, plural: string): ReplicaSummary {
  const st = o.status ?? {};
  if (plural === "daemonsets") {
    return { desired: st.desiredNumberScheduled ?? 0, ready: st.numberReady ?? 0, updated: st.updatedNumberScheduled ?? 0, available: st.numberAvailable ?? 0 };
  }
  return { desired: o.spec?.replicas ?? 1, ready: st.readyReplicas ?? 0, updated: st.updatedReplicas ?? 0, available: st.availableReplicas ?? 0 };
}

/** matchLabels → labelSelector 字串（matchExpressions 忽略；只用於列出 Pod）。 */
export function selectorString(sel: Record<string, string> | undefined | null): string {
  return Object.entries(sel ?? {}).map(([k, v]) => `${k}=${v}`).join(",");
}

export function workloadSelector(o: K8sObject, plural: string): string {
  if (plural === "services") return selectorString(o.spec?.selector);
  if (plural === "jobs") return selectorString(o.spec?.selector?.matchLabels) || (o.metadata.uid ? `controller-uid=${o.metadata.uid}` : "");
  return selectorString(o.spec?.selector?.matchLabels);
}

export function canScale(plural: string): boolean {
  return plural === "deployments" || plural === "statefulsets" || plural === "replicasets";
}

export function canRestart(plural: string): boolean {
  return plural === "deployments" || plural === "statefulsets" || plural === "daemonsets";
}

/** workload 的容器（pod template）。 */
export function templateContainers(o: K8sObject, plural: string): { name: string; image: string; ports: number[] }[] {
  const spec = plural === "cronjobs" ? o.spec?.jobTemplate?.spec?.template?.spec : plural === "pods" ? o.spec : o.spec?.template?.spec;
  return (spec?.containers ?? []).map((c: any) => ({ name: c.name, image: c.image ?? "", ports: (c.ports ?? []).map((p: any) => p.containerPort) }));
}

// ---- Service ----

export interface SvcPort {
  name: string;
  port: number;
  targetPort: string;
  nodePort: number | null;
  protocol: string;
}

export function servicePorts(svc: K8sObject): SvcPort[] {
  return (svc.spec?.ports ?? []).map((p: any) => ({
    name: p.name ?? "",
    port: p.port,
    targetPort: p.targetPort != null ? String(p.targetPort) : String(p.port),
    nodePort: p.nodePort ?? null,
    protocol: p.protocol ?? "TCP",
  }));
}

/** 可轉發的埠（Service：service port；Pod / workload：容器埠）。 */
export function forwardablePorts(o: K8sObject, plural: string): { port: number; label: string }[] {
  if (plural === "services") return servicePorts(o).filter((p) => p.protocol === "TCP").map((p) => ({ port: p.port, label: p.name ? `${p.port} (${p.name})` : String(p.port) }));
  const seen = new Set<number>();
  const out: { port: number; label: string }[] = [];
  const spec = plural === "pods" ? o.spec : o.spec?.template?.spec;
  for (const c of spec?.containers ?? []) {
    for (const p of c.ports ?? []) {
      if ((p.protocol ?? "TCP") !== "TCP" || seen.has(p.containerPort)) continue;
      seen.add(p.containerPort);
      out.push({ port: p.containerPort, label: `${p.containerPort}${p.name ? ` (${p.name})` : ""} · ${c.name}` });
    }
  }
  return out;
}

/** 轉發目標字串（後端 resolve_forward 吃的格式）。 */
export function forwardTarget(plural: string, name: string): string {
  const short = plural === "services" ? "svc" : plural === "deployments" ? "deploy" : plural === "statefulsets" ? "sts" : plural === "daemonsets" ? "ds" : "pod";
  return `${short}/${name}`;
}

export function canForward(plural: string): boolean {
  return plural === "pods" || plural === "services" || plural === "deployments" || plural === "statefulsets" || plural === "daemonsets";
}

// ---- 條件（conditions）----

export interface Condition {
  type: string;
  status: string;
  reason: string;
  message: string;
  last: string;
}

export function conditions(o: K8sObject): Condition[] {
  return (o.status?.conditions ?? []).map((c: any) => ({
    type: c.type, status: c.status, reason: c.reason ?? "", message: c.message ?? "", last: c.lastTransitionTime ?? c.lastUpdateTime ?? "",
  }));
}

/** base64 → UTF-8 字串（非文字回 null）。 */
export function b64decode(s: string): string | null {
  try {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 顯示 table 名稱：`pods/redis-abc` → `redis-abc`。 */
export function treeLabel(table: string): string {
  return splitTreeName(table).name;
}

/** 物件的顯示種類（`Deployment`），未知 plural 回 plural 本身。 */
export function kindOf(plural: string): string {
  return BUILTIN[plural]?.ref.kind ?? plural;
}

// ---- 連線設定（options 的 k8s_* 鍵）----

export type K8sOpts = Record<string, string>;

/** options 裡屬於 Kubernetes 的鍵。 */
export function pickK8sOpts(options: Record<string, string> | undefined | null): K8sOpts {
  return Object.fromEntries(Object.entries(options ?? {}).filter(([k]) => k.startsWith("k8s_")));
}

const CLUSTER_KEYS = ["k8s_source", "k8s_kubeconfig", "k8s_context", "k8s_namespaces", "k8s_tls_ca", "k8s_tls_cert", "k8s_tls_key", "k8s_tls_insecure"];
const FORWARD_KEYS = ["k8s_conn", "k8s_ns", "k8s_target", "k8s_port"];

/** 存檔用：Kubernetes 連線只留叢集鍵；資料庫連線只在啟用轉發時留轉發鍵。空值不存。 */
export function k8sOptionsFor(kind: string, opts: K8sOpts): K8sOpts {
  const keys = kind === "kubernetes" ? CLUSTER_KEYS : opts.k8s_conn ? FORWARD_KEYS : [];
  const manual = opts.k8s_source === "manual";
  const out: K8sOpts = {};
  for (const k of keys) {
    const v = (opts[k] ?? "").trim();
    if (!v) continue;
    // 模式互斥的鍵不存：kubeconfig 模式不留手填憑證，手填模式不留 kubeconfig / context。
    if (kind === "kubernetes" && manual && (k === "k8s_kubeconfig" || k === "k8s_context")) continue;
    if (kind === "kubernetes" && !manual && k.startsWith("k8s_tls_")) continue;
    out[k] = v;
  }
  return out;
}

export function k8sForwardEnabled(opts: K8sOpts): boolean {
  return !!opts.k8s_conn;
}
