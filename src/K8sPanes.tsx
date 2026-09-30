// Kubernetes 資源分頁的子頁：YAML（檢視 / 編輯 / 試套用 / 套用）、事件、底下的 Pod 清單、Pod 資源用量。
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, CheckCircle2, Copy, Pencil, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import { api } from "./api";
import type { K8sEvent, K8sObject, K8sPodMetrics, K8sResRef } from "./k8sTypes";
import { age, fmtCpu, podReady, podRestarts, podStatus, podStatusTone, TONE_TEXT } from "./k8sModel";
import { errText, openK8sTab } from "./k8sActions";
import { fmtBytes } from "./dockerModel";
import { ErrorLine, InfoSection, MiniTable, StatTile } from "./dockerUi";
import K8sYamlEditor from "./K8sYamlEditor";
import { Button, EmptyState, Spinner } from "./ui/index";
import TimeSeriesChart, { type TsPoint } from "./ui/TimeSeriesChart";
import { copyToClipboard, toast, uiConfirm } from "./ui";
import { useT } from "./i18n";

// ---- YAML ----

export function YamlPane({ connId, res, ns, name, readonly, onSaved }: {
  connId: string;
  res: K8sResRef;
  ns: string | null;
  name: string;
  readonly: boolean;
  onSaved: () => void;
}) {
  const t = useT();
  const [yaml, setYaml] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const y = await api.k8sGetYaml(connId, res, ns, name);
      setYaml(y);
      setDraft(y);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, [connId, res, ns, name]);

  useEffect(() => { void load(); }, [load]);

  const dirty = editing && draft !== yaml;

  const submit = async (dryRun: boolean) => {
    if (!dryRun) {
      const ok = await uiConfirm(t("以編輯後的 YAML 取代 {kind}「{name}」？", { kind: res.kind, name }), { confirmText: t("套用") });
      if (!ok) return;
    }
    setBusy(true);
    setNote(null);
    try {
      await api.k8sReplaceYaml(connId, res, ns, name, draft, dryRun);
      if (dryRun) {
        setNote(t("試套用通過：API server 接受這份 YAML（未寫入）"));
        setErr(null);
      } else {
        toast.success(t("已套用 {kind} {name}", { kind: res.kind, name }));
        setEditing(false);
        await load();
        onSaved();
      }
    } catch (e) {
      const m = errText(e);
      setErr(/ 409/.test(m) ? `${m}\n${t("別人已經改過這個物件；請重新載入後再改。")}` : m);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-1.5 px-2 py-1 border-b border-fg/10 bg-bar text-xs flex-wrap">
        {!editing ? (
          <>
            <Button size="sm" icon={RefreshCw} onClick={() => void load()}>{t("重新載入")}</Button>
            <Button size="sm" variant="ghost" icon={Copy} disabled={!yaml} onClick={() => yaml && copyToClipboard(yaml, t("已複製"))}>{t("複製")}</Button>
            {!readonly && <Button size="sm" icon={Pencil} disabled={!yaml} onClick={() => { setEditing(true); setNote(null); }}>{t("編輯")}</Button>}
          </>
        ) : (
          <>
            <Button size="sm" icon={CheckCircle2} disabled={busy} onClick={() => void submit(true)}>{t("試套用")}</Button>
            <Button size="sm" variant="primary" icon={Save} disabled={busy || !dirty} loading={busy} onClick={() => void submit(false)}>{t("套用")}</Button>
            <Button size="sm" variant="ghost" icon={RotateCcw} disabled={busy || !dirty} onClick={() => setDraft(yaml ?? "")}>{t("還原")}</Button>
            <Button size="sm" variant="ghost" icon={X} disabled={busy} onClick={() => { setEditing(false); setDraft(yaml ?? ""); setErr(null); setNote(null); }}>{t("取消編輯")}</Button>
            {dirty && <span className="text-warning">{t("未套用的變更")}</span>}
          </>
        )}
      </div>
      {err && <div className="px-3 py-1.5 text-xs text-danger mono whitespace-pre-wrap break-all border-b border-fg/10">{err}</div>}
      {note && <div className="px-3 py-1.5 text-xs text-success border-b border-fg/10">{note}</div>}
      <div className="flex-1 min-h-0" data-testid="k8s-yaml">
        {yaml == null ? (
          !err && <div className="flex justify-center p-6"><Spinner /></div>
        ) : (
          <K8sYamlEditor value={editing ? draft : yaml} onChange={editing ? setDraft : undefined} readOnly={!editing} />
        )}
      </div>
    </div>
  );
}

// ---- 事件 ----

export function EventsTable({ events, showObject }: { events: K8sEvent[]; showObject?: boolean }) {
  const t = useT();
  return (
    <MiniTable
      head={[t("類型"), t("原因"), ...(showObject ? [t("物件")] : []), t("訊息"), t("次數"), t("最近")]}
      rows={events.map((e) => [
        <span className={e.kind === "Warning" ? "text-warning" : "text-fg/55"}>{e.kind}</span>,
        <span className="mono">{e.reason}</span>,
        ...(showObject ? [<span className="mono text-fg/70">{e.namespace ? `${e.namespace}/` : ""}{e.object_kind}/{e.object_name}</span>] : []),
        <span className="whitespace-pre-wrap">{e.message}</span>,
        e.count,
        <span title={e.last}>{age(e.last)}</span>,
      ])}
      empty={t("沒有事件（事件預設只保留約一小時）")}
    />
  );
}

export function EventsPane({ connId, ns, kind, name }: { connId: string; ns: string | null; kind: string; name: string }) {
  const t = useT();
  const [events, setEvents] = useState<K8sEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      // cluster 範圍的物件（Node）其事件放在 default namespace。
      setEvents(await api.k8sEvents(connId, ns ?? "", kind, name));
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [connId, ns, kind, name]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
      <div className="flex"><Button size="sm" icon={RefreshCw} loading={loading} onClick={() => void load()}>{t("重新整理")}</Button></div>
      <ErrorLine text={err} />
      {events ? <InfoSection title={t("事件（{n}）", { n: events.length })}><EventsTable events={events} /></InfoSection> : !err && <Spinner />}
    </div>
  );
}

// ---- 底下的 Pod ----

export function PodsTable({ connId, pods, metrics }: { connId: string; pods: K8sObject[]; metrics?: K8sPodMetrics[] | null }) {
  const t = useT();
  const m = new Map((metrics ?? []).map((x) => [`${x.namespace}/${x.name}`, x]));
  return (
    <MiniTable
      head={[t("名稱"), t("狀態"), t("就緒"), t("重啟"), "CPU", t("記憶體"), t("節點"), "IP", t("存在時間")]}
      rows={pods.map((p) => {
        const st = podStatus(p);
        const mm = m.get(`${p.metadata.namespace}/${p.metadata.name}`);
        return [
          <button
            type="button"
            className="mono text-accent hover:underline text-left"
            onClick={() => openK8sTab(connId, p.metadata.namespace ?? "", `pods/${p.metadata.name}`)}
          >
            {p.metadata.name}
          </button>,
          <span className={TONE_TEXT[podStatusTone(st)]}>{st}</span>,
          podReady(p),
          podRestarts(p),
          <span className="mono">{mm ? fmtCpu(mm.cpu_milli) : "—"}</span>,
          <span className="mono">{mm ? fmtBytes(mm.memory_bytes) : "—"}</span>,
          <span className="mono text-fg/60">{p.spec?.nodeName ?? ""}</span>,
          <span className="mono text-fg/60">{p.status?.podIP ?? ""}</span>,
          age(p.metadata.creationTimestamp),
        ];
      })}
      empty={t("沒有符合的 Pod")}
    />
  );
}

/** workload / Service / Job / Node 底下的 Pod。`selector` 空字串 = 沒有 selector（不列）。 */
export function PodsPane({ connId, ns, labelSelector, fieldSelector }: {
  connId: string;
  ns: string | null;
  labelSelector: string;
  fieldSelector?: string;
}) {
  const t = useT();
  const [pods, setPods] = useState<K8sObject[] | null>(null);
  const [metrics, setMetrics] = useState<K8sPodMetrics[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!labelSelector && !fieldSelector) {
      setPods([]);
      return;
    }
    setLoading(true);
    try {
      const podsRef = { group: "", version: "v1", plural: "pods", kind: "Pod", namespaced: true };
      const [list, mt] = await Promise.all([
        api.k8sList(connId, podsRef, ns, labelSelector || null, fieldSelector || null),
        api.k8sPodMetrics(connId, ns, null).catch(() => null),
      ]);
      list.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
      setPods(list);
      setMetrics(mt);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [connId, ns, labelSelector, fieldSelector]);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Button size="sm" icon={RefreshCw} loading={loading} onClick={() => void load()}>{t("重新整理")}</Button>
        <span className="text-xs text-fg/40 mono truncate">{labelSelector || fieldSelector}</span>
      </div>
      <ErrorLine text={err} />
      {pods ? <InfoSection title={t("Pod（{n}）", { n: pods.length })}><PodsTable connId={connId} pods={pods} metrics={metrics} /></InfoSection> : !err && <Spinner />}
    </div>
  );
}

// ---- Pod 資源用量（metrics-server）----

const HISTORY = 60;

export function MetricsPane({ connId, ns, pod, pod_obj }: { connId: string; ns: string; pod: string; pod_obj: K8sObject | null }) {
  const t = useT();
  const [cur, setCur] = useState<K8sPodMetrics | null>(null);
  const [missing, setMissing] = useState(false);
  const [cpu, setCpu] = useState<TsPoint[]>([]);
  const [mem, setMem] = useState<TsPoint[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    let timer: number | undefined;
    // metrics-server 預設每 15 秒抓一次，輪詢更密也不會更新。
    const tick = async () => {
      try {
        const r = await api.k8sPodMetrics(connId, ns, pod);
        if (!alive.current) return;
        if (r === null) {
          setMissing(true);
          return;
        }
        const m = r[0] ?? null;
        setCur(m);
        setErr(null);
        if (m) {
          const now = Date.now();
          setCpu((a) => [...a, { t: now, v: m.cpu_milli }].slice(-HISTORY));
          setMem((a) => [...a, { t: now, v: m.memory_bytes }].slice(-HISTORY));
        }
      } catch (e) {
        if (alive.current) setErr(errText(e));
      }
      if (alive.current) timer = window.setTimeout(tick, 10000);
    };
    void tick();
    return () => { alive.current = false; window.clearTimeout(timer); };
  }, [connId, ns, pod]);

  if (missing) {
    return <EmptyState icon={Activity} title={t("叢集沒有 metrics-server")} hint={t("安裝 metrics-server 後才有 CPU / 記憶體用量。")} />;
  }
  // requests / limits（加總所有容器）。
  const sum = (key: "requests" | "limits", res: "cpu" | "memory") =>
    (pod_obj?.spec?.containers ?? []).map((c: any) => c.resources?.[key]?.[res]).filter(Boolean).join(" + ");
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
      <ErrorLine text={err} />
      {!cur ? (
        !err && <div className="flex justify-center p-6"><Spinner /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <StatTile label="CPU" value={fmtCpu(cur.cpu_milli)} sub={[sum("requests", "cpu") && `req ${sum("requests", "cpu")}`, sum("limits", "cpu") && `lim ${sum("limits", "cpu")}`].filter(Boolean).join(" · ") || undefined} />
            <StatTile label={t("記憶體")} value={fmtBytes(cur.memory_bytes)} sub={[sum("requests", "memory") && `req ${sum("requests", "memory")}`, sum("limits", "memory") && `lim ${sum("limits", "memory")}`].filter(Boolean).join(" · ") || undefined} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-accent">
            <TimeSeriesChart label="CPU (m)" points={cpu} height={110} formatValue={(v) => fmtCpu(v)} />
            <TimeSeriesChart label={t("記憶體")} points={mem} height={110} formatValue={fmtBytes} />
          </div>
          <InfoSection title={t("各容器")}>
            <MiniTable
              head={[t("容器"), "CPU", t("記憶體")]}
              rows={cur.containers.map((c) => [c.name, <span className="mono">{fmtCpu(c.cpu_milli)}</span>, <span className="mono">{fmtBytes(c.memory_bytes)}</span>])}
            />
          </InfoSection>
        </>
      )}
    </div>
  );
}
