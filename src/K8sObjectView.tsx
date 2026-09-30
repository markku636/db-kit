// Kubernetes 資源分頁：上方動作列（依種類：調整副本 / 重新啟動 / 立即執行 / cordon / port-forward / 建資料庫連線 / 刪除），
// 下方子頁（概要 / YAML / 事件，Pod 另有 Log / Shell / 資源，workload 等有 Pod 清單）。
// `table` = `種類複數/名稱`（內建種類）或 `種類複數.group/名稱`（其他資源，靠 discovery 找版本）；
// `@browse:<種類>` 是資源瀏覽器。Log / Shell 切走不卸載（xterm buffer 與串流保留）。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, ArrowRightLeft, Boxes, CalendarClock, DatabaseZap, FileCode2, FileText, Info, ListChecks, Pause, Play, RefreshCw,
  RotateCcw, Scaling, SquareTerminal, Trash2, Zap,
} from "lucide-react";
import { api } from "./api";
import type { K8sObject, K8sResRef } from "./k8sTypes";
import {
  age, builtinRef, canForward, canRestart, canScale, CLUSTER_DB, defaultContainer, kindOf, podStatus, podStatusTone, replicas,
  splitTreeName, templateContainers, workloadSelector,
} from "./k8sModel";
import {
  cordonNode, createDbConnectionFromK8s, deleteResource, errText, forceDeletePod, k8sLooksLikeDb, refreshTree, restartWorkload,
  scaleWorkload, setCronJobSuspend, triggerCronJob, useK8sSub, useK8sUi, type K8sSub,
} from "./k8sActions";
import { ErrorLine } from "./dockerUi";
import K8sSummary from "./K8sSummary";
import { EventsPane, MetricsPane, PodsPane, YamlPane } from "./K8sPanes";
import K8sLogView from "./K8sLogView";
import K8sExecView from "./K8sExecView";
import K8sBrowser from "./K8sBrowser";
import { Badge, Button, EmptyState, Segmented, Spinner } from "./ui/index";
import { useStore } from "./store";
import { useT } from "./i18n";

/** 樹 / 瀏覽器的 table 名稱 → 資源參照（非內建種類要問 discovery）。 */
async function resolveRef(connId: string, pluralKey: string): Promise<K8sResRef | null> {
  const b = builtinRef(pluralKey);
  if (b) return b;
  const dot = pluralKey.indexOf(".");
  const plural = dot < 0 ? pluralKey : pluralKey.slice(0, dot);
  const group = dot < 0 ? "" : pluralKey.slice(dot + 1);
  const disc = await api.k8sDiscovery(connId);
  return disc.find((r) => r.plural === plural && r.group === group) ?? null;
}

export default function K8sObjectView({ connId, ns: db, table }: { connId: string; ns: string; table: string }) {
  if (table.startsWith("@browse")) {
    return <K8sBrowser connId={connId} ns={db === CLUSTER_DB ? null : db} initial={table.slice("@browse:".length)} />;
  }
  return <K8sResourceView connId={connId} db={db} table={table} />;
}

function K8sResourceView({ connId, db, table }: { connId: string; db: string; table: string }) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === connId));
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const { plural: pluralKey, name } = splitTreeName(table);
  const ns = db === CLUSTER_DB ? null : db;
  const [ref, setRef] = useState<K8sResRef | null>(() => builtinRef(pluralKey));
  const plural = ref?.plural ?? pluralKey;
  const [obj, setObj] = useState<K8sObject | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<K8sSub>("summary");
  const [mounted, setMounted] = useState<Set<K8sSub>>(() => new Set(["summary"]));
  const [nodeUsage, setNodeUsage] = useState<{ cpu: number; mem: number } | null>(null);

  const subKey = `${connId}:${db}:${table}`;
  const subReq = useK8sSub((s) => s.req[subKey]);
  useEffect(() => {
    if (!subReq) return;
    setSub(subReq);
    useK8sSub.getState().consume(subKey);
  }, [subReq, subKey]);
  useEffect(() => {
    setMounted((m) => (m.has(sub) ? m : new Set(m).add(sub)));
  }, [sub]);

  useEffect(() => {
    if (ref) return;
    resolveRef(connId, pluralKey)
      .then((r) => (r ? setRef(r) : setErr(t("叢集不認得資源種類「{kind}」", { kind: pluralKey }))))
      .catch((e) => setErr(errText(e)));
  }, [connId, pluralKey, ref, t]);

  const load = useCallback(async () => {
    if (!ref) return;
    try {
      const o = await api.k8sGet(connId, ref, ns, name);
      setObj(o);
      setErr(null);
      setGone(false);
      if (ref.plural === "nodes") {
        const m = await api.k8sNodeMetrics(connId).catch(() => null);
        const hit = m?.find((x) => x.name === name);
        setNodeUsage(hit ? { cpu: hit.cpu_milli, mem: hit.memory_bytes } : null);
      }
    } catch (e) {
      const msg = errText(e);
      if (/ 404/.test(msg)) setGone(true);
      setErr(msg);
    }
  }, [connId, ref, ns, name]);

  useEffect(() => { void load(); }, [load]);
  // 概要頁每 10 秒自動更新（狀態變化快的 Pod / workload 才有意義；其他種類不輪詢）。
  useEffect(() => {
    if (sub !== "summary" || !["pods", "deployments", "statefulsets", "daemonsets", "jobs", "nodes"].includes(plural)) return;
    const h = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(h);
  }, [sub, plural, load]);

  const act = async (fn: () => Promise<boolean | string | null>) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r) {
        refreshTree(connId, db);
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  const containers = useMemo(() => (obj && plural === "pods" ? templateContainers(obj, "pods").map((c) => c.name) : []), [obj, plural]);
  const images = useMemo(() => (obj ? templateContainers(obj, plural).map((c) => c.image) : []), [obj, plural]);

  if (gone) {
    return (
      <EmptyState
        icon={Trash2}
        title={t("{kind}「{name}」已不存在", { kind: kindOf(plural), name })}
        hint={t("可能已被刪除；請重新整理連線樹。")}
        action={<Button icon={RefreshCw} onClick={() => { refreshTree(connId, db); void load(); }}>{t("重新整理")}</Button>}
      />
    );
  }
  if (!ref || !conn) {
    return err ? <div className="p-3"><ErrorLine text={err} /></div> : <div className="flex justify-center p-6"><Spinner /></div>;
  }

  const status = obj && plural === "pods" ? podStatus(obj) : null;
  const running = status === "Running";
  const kind = ref.kind || kindOf(plural);
  const podSelector = obj ? workloadSelector(obj, plural) : "";
  const hasPods = ["deployments", "statefulsets", "daemonsets", "replicasets", "jobs", "services", "nodes"].includes(plural);

  const subs: { value: K8sSub; label: string; icon: typeof Info }[] = [{ value: "summary", label: t("概要"), icon: Info }];
  if (plural === "pods") {
    subs.push({ value: "logs", label: "Log", icon: FileText });
    subs.push({ value: "shell", label: "Shell", icon: SquareTerminal });
    subs.push({ value: "metrics", label: t("資源"), icon: Activity });
  }
  if (hasPods) subs.push({ value: "pods", label: "Pods", icon: Boxes });
  subs.push({ value: "events", label: t("事件"), icon: ListChecks });
  subs.push({ value: "yaml", label: "YAML", icon: FileCode2 });

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-fg/10 bg-bar flex-wrap">
        <Badge tone="info">{kind}</Badge>
        {status && <Badge tone={podStatusTone(status)} dot>{status}</Badge>}
        {obj && ["deployments", "statefulsets", "daemonsets", "replicasets"].includes(plural) && (() => {
          const r = replicas(obj, plural);
          return <Badge tone={r.desired === 0 ? "neutral" : r.ready >= r.desired ? "success" : "warning"} dot>{r.ready}/{r.desired}</Badge>;
        })()}
        {obj && plural === "cronjobs" && obj.spec?.suspend && <Badge tone="warning">{t("已暫停")}</Badge>}
        {obj && plural === "nodes" && obj.spec?.unschedulable && <Badge tone="warning">cordoned</Badge>}
        {obj && <span className="text-xs text-fg/40" title={obj.metadata.creationTimestamp}>{age(obj.metadata.creationTimestamp)}</span>}
        {!readonly && obj && (
          <div className="flex items-center gap-1 flex-wrap">
            {canScale(plural) && (
              <Button size="sm" icon={Scaling} disabled={busy} onClick={() => act(() => scaleWorkload(connId, ns!, plural, name, obj.spec?.replicas ?? 1))}>{t("調整副本數")}</Button>
            )}
            {canRestart(plural) && (
              <Button size="sm" icon={RotateCcw} disabled={busy} onClick={() => act(() => restartWorkload(connId, ns!, plural, name))}>{t("重新啟動")}</Button>
            )}
            {plural === "cronjobs" && (
              <>
                <Button size="sm" icon={Zap} disabled={busy} onClick={() => act(() => triggerCronJob(connId, ns!, name))}>{t("立即執行")}</Button>
                <Button size="sm" variant="ghost" icon={obj.spec?.suspend ? Play : Pause} disabled={busy}
                  onClick={() => act(() => setCronJobSuspend(connId, ns!, name, !obj.spec?.suspend))}>
                  {obj.spec?.suspend ? t("恢復排程") : t("暫停排程")}
                </Button>
              </>
            )}
            {plural === "nodes" && (
              <Button size="sm" icon={obj.spec?.unschedulable ? Play : CalendarClock} disabled={busy}
                onClick={() => act(() => cordonNode(connId, name, !obj.spec?.unschedulable))}>
                {obj.spec?.unschedulable ? t("恢復排程") : t("停止排程（cordon）")}
              </Button>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          {obj && canForward(plural) && ns && (
            <Button size="sm" variant="ghost" icon={ArrowRightLeft} onClick={() => useK8sUi.getState().openForward({ connId, ns, plural, name })}>
              {t("轉發埠")}
            </Button>
          )}
          {obj && canForward(plural) && ns && (plural === "services" || k8sLooksLikeDb(images)) && (
            <Button size="sm" variant="ghost" icon={DatabaseZap} onClick={() => void createDbConnectionFromK8s(conn, ns, plural, name)}>
              {t("建立資料庫連線")}
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={RefreshCw} disabled={busy} onClick={() => void load()}>{t("重新整理")}</Button>
          {!readonly && obj && plural === "pods" && obj.metadata.deletionTimestamp && (
            <Button size="sm" variant="danger" icon={Trash2} disabled={busy} onClick={() => act(() => forceDeletePod(connId, ns!, name))}>{t("強制刪除")}</Button>
          )}
          {!readonly && obj && builtinRef(plural) && !obj.metadata.deletionTimestamp && (
            <Button size="sm" variant="danger" icon={Trash2} disabled={busy} onClick={() => act(() => deleteResource(connId, ns, plural, name))}>{t("刪除")}</Button>
          )}
        </div>
      </div>

      <div className="px-2 py-1 border-b border-fg/10">
        <Segmented value={sub} onChange={setSub} ariaLabel={t("資源檢視")} options={subs} />
      </div>

      <ErrorLine text={err} />

      <div className={`flex-1 min-h-0 overflow-auto p-3 space-y-4 ${sub === "summary" ? "" : "hidden"}`}>
        {obj ? <K8sSummary connId={connId} plural={plural} o={obj} nodeUsage={nodeUsage} /> : !err && <div className="flex justify-center p-6"><Spinner /></div>}
      </div>
      {plural === "pods" && ns && obj && mounted.has("logs") && (
        <div className={`flex-1 min-h-0 flex flex-col ${sub === "logs" ? "" : "hidden"}`}>
          <K8sLogView connId={connId} ns={ns} pod={name} containers={containers} initialContainer={defaultContainer(obj)} />
        </div>
      )}
      {plural === "pods" && ns && obj && mounted.has("shell") && (
        <div className={`flex-1 min-h-0 flex flex-col ${sub === "shell" ? "" : "hidden"}`}>
          {readonly
            ? <EmptyState icon={SquareTerminal} title={t("唯讀連線不開放 Pod shell")} hint={t("在連線設定取消「唯讀連線」後即可使用。")} />
            : <K8sExecView connId={connId} ns={ns} pod={name} containers={containers} initialContainer={defaultContainer(obj)} running={running} />}
        </div>
      )}
      {sub === "metrics" && ns && <MetricsPane connId={connId} ns={ns} pod={name} pod_obj={obj} />}
      {sub === "pods" && obj && (
        <PodsPane
          connId={connId}
          ns={plural === "nodes" ? null : ns}
          labelSelector={plural === "nodes" ? "" : podSelector}
          fieldSelector={plural === "nodes" ? `spec.nodeName=${name}` : undefined}
        />
      )}
      {sub === "events" && <EventsPane connId={connId} ns={ns} kind={kind} name={name} />}
      {mounted.has("yaml") && (
        <div className={`flex-1 min-h-0 flex flex-col ${sub === "yaml" ? "" : "hidden"}`}>
          <YamlPane connId={connId} res={ref} ns={ns} name={name} readonly={readonly} onSaved={() => { refreshTree(connId, db); void load(); }} />
        </div>
      )}
    </div>
  );
}
