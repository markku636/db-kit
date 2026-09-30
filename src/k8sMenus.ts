// Kubernetes 連線樹的右鍵選單（物件層 / 種類資料夾 / namespace 節點）。回傳結構與 App.tsx 的 MenuNode 相容。
// 動作本身在 k8sActions.ts（與資源分頁共用）。
import type { ConnectionConfig } from "./api";
import { canForward, canRestart, canScale, CLUSTER_DB, kindOf, parseObjKind, splitTreeName } from "./k8sModel";
import {
  cordonNode, createDbConnectionFromK8s, deleteResource, openK8sTab, restartWorkload, scaleWorkload, setCronJobSuspend,
  triggerCronJob, useK8sUi, type K8sSub,
} from "./k8sActions";
import { api } from "./api";
import { builtinRef } from "./k8sModel";
import { copyToClipboard } from "./ui";
import { t } from "./i18n";

export type K8sMenuNode =
  | { kind: "item"; label: string; onClick: () => void; danger?: boolean }
  | { kind: "sep" };

const it = (label: string, onClick: () => void, danger?: boolean): K8sMenuNode => ({ kind: "item", label, onClick, danger });
const sep: K8sMenuNode = { kind: "sep" };

export function k8sItemMenu(ctx: {
  conn: ConnectionConfig;
  db: string;
  table: string;
  objKind: string;
  readonly: boolean;
  refresh: () => void;
}): K8sMenuNode[] {
  const { conn, db, table, readonly } = ctx;
  const { plural, name } = splitTreeName(table);
  const state = parseObjKind(ctx.objKind)?.state ?? "";
  const ns = db === CLUSTER_DB ? null : db;
  const open = (sub?: K8sSub) => openK8sTab(conn.id, db, table, sub, ctx.objKind);
  const after = (p: Promise<unknown>) => void p.then((ok) => { if (ok) ctx.refresh(); });
  const nodes: K8sMenuNode[] = [it(t("開啟"), () => open())];

  if (plural === "pods") {
    nodes.push(it(t("Log…"), () => open("logs")));
    if (!readonly && state === "running") nodes.push(it(t("Shell…"), () => open("shell")));
    nodes.push(it(t("資源用量…"), () => open("metrics")));
  }
  if (["deployments", "statefulsets", "daemonsets", "jobs", "services"].includes(plural)) nodes.push(it(t("Pod 清單…"), () => open("pods")));
  nodes.push(it(t("YAML…"), () => open("yaml")));
  nodes.push(it(t("事件…"), () => open("events")));

  if (ns && canForward(plural)) {
    nodes.push(sep);
    nodes.push(it(t("轉發埠…"), () => useK8sUi.getState().openForward({ connId: conn.id, ns, plural, name })));
    nodes.push(it(t("建立資料庫連線…"), () => void createDbConnectionFromK8s(conn, ns, plural, name)));
  }

  if (!readonly) {
    const acts: K8sMenuNode[] = [];
    if (ns && canScale(plural)) {
      acts.push(it(t("調整副本數…"), () => {
        const ref = builtinRef(plural)!;
        void api.k8sGet(conn.id, ref, ns, name).then((o) => after(scaleWorkload(conn.id, ns, plural, name, o.spec?.replicas ?? 1)));
      }));
    }
    if (ns && canRestart(plural)) acts.push(it(t("重新啟動"), () => after(restartWorkload(conn.id, ns, plural, name))));
    if (ns && plural === "cronjobs") {
      acts.push(it(t("立即執行"), () => after(triggerCronJob(conn.id, ns, name))));
      acts.push(state === "suspended"
        ? it(t("恢復排程"), () => after(setCronJobSuspend(conn.id, ns, name, false)))
        : it(t("暫停排程"), () => after(setCronJobSuspend(conn.id, ns, name, true))));
    }
    if (plural === "nodes") {
      acts.push(state === "cordoned"
        ? it(t("恢復排程"), () => after(cordonNode(conn.id, name, false)))
        : it(t("停止排程（cordon）"), () => after(cordonNode(conn.id, name, true))));
    }
    if (acts.length) nodes.push(sep, ...acts);
  }

  nodes.push(sep);
  nodes.push(it(t("複製名稱"), () => copyToClipboard(name, t("已複製"))));
  if (ns) nodes.push(it(t("複製 kubectl 指令"), () => copyToClipboard(kubectlHint(plural, ns, name), t("已複製"))));
  nodes.push(it(t("重新整理"), ctx.refresh));
  if (!readonly) nodes.push(it(t("刪除 {kind}", { kind: kindOf(plural) }), () => after(deleteResource(conn.id, ns, plural, name)), true));
  return nodes;
}

function kubectlHint(plural: string, ns: string, name: string): string {
  if (plural === "pods") return `kubectl -n ${ns} logs -f ${name}`;
  return `kubectl -n ${ns} describe ${plural} ${name}`;
}

/** 種類資料夾（Pods / Deployments…）的右鍵選單。 */
export function k8sFolderMenu(ctx: { connId: string; db: string; plural: string; readonly: boolean; refresh: () => void }): K8sMenuNode[] {
  const ns = ctx.db === CLUSTER_DB ? null : ctx.db;
  const nodes: K8sMenuNode[] = [it(t("以表格瀏覽…"), () => openK8sTab(ctx.connId, ctx.db, `@browse:${ctx.plural}`))];
  if (!ctx.readonly) nodes.push(it(t("套用 YAML…"), () => useK8sUi.getState().openApply({ connId: ctx.connId, ns })));
  nodes.push(sep, it(t("重新整理"), ctx.refresh));
  return nodes;
}

/** namespace / 叢集節點的右鍵選單。 */
export function k8sNamespaceMenu(ctx: {
  conn: ConnectionConfig;
  db: string;
  readonly: boolean;
  refresh: () => void;
  /** 重抓 namespace 清單（刪除 namespace 後）。 */
  refreshDbs: () => void;
  editConn: () => void;
}): K8sMenuNode[] {
  const ns = ctx.db === CLUSTER_DB ? null : ctx.db;
  const nodes: K8sMenuNode[] = [
    it(t("重新整理"), ctx.refresh),
    it(t("瀏覽所有資源…"), () => openK8sTab(ctx.conn.id, ctx.db, ns ? "@browse:pods" : "@browse:nodes")),
    it(t("叢集總覽…"), () => useK8sUi.getState().openOverview(ctx.conn.id)),
  ];
  if (!ctx.readonly) nodes.push(it(t("套用 YAML…"), () => useK8sUi.getState().openApply({ connId: ctx.conn.id, ns })));
  if (ns) nodes.push(it(t("複製 namespace 名稱"), () => copyToClipboard(ns, t("已複製"))));
  nodes.push(it(t("編輯屬性…"), ctx.editConn));
  if (ns && !ctx.readonly) {
    nodes.push(sep, it(t("刪除 namespace…"), () => void deleteResource(ctx.conn.id, null, "namespaces", ns).then((ok) => { if (ok) ctx.refreshDbs(); }), true));
  }
  return nodes;
}
