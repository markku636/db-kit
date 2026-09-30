// Kubernetes 的對話框（掛在 App 根部，經 useK8sUi 開啟）：port-forward、套用 YAML、叢集總覽（含進行中的轉發）。
import { useCallback, useEffect, useState } from "react";
import { ArrowRightLeft, CheckCircle2, Copy, FileCode2, RefreshCw, ShipWheel, Square, Upload } from "lucide-react";
import { api } from "./api";
import type { K8sApplyResult, K8sForwardInfo, K8sOverview } from "./k8sTypes";
import { age, builtinRef, CLUSTER_DB, fmtCpu, forwardablePorts, forwardTarget, kindOf, TONE_TEXT } from "./k8sModel";
import { errText, openK8sTab, refreshTree, useK8sUi, type K8sApplyReq, type K8sForwardReq } from "./k8sActions";
import { fmtBytes } from "./dockerModel";
import { ErrorLine, InfoSection, MiniTable, StatTile } from "./dockerUi";
import { EventsTable } from "./K8sPanes";
import K8sYamlEditor from "./K8sYamlEditor";
import { Badge, Button, Field, IconButton, Input, Modal, Select, Spinner } from "./ui/index";
import { copyToClipboard, toast } from "./ui";
import { useStore } from "./store";
import { useT } from "./i18n";

export default function K8sDialogs() {
  const forward = useK8sUi((s) => s.forward);
  const apply = useK8sUi((s) => s.apply);
  const overview = useK8sUi((s) => s.overview);
  const close = useK8sUi((s) => s.close);
  return (
    <>
      {forward && <ForwardDialog req={forward} onClose={() => close("forward")} />}
      {apply && <ApplyDialog req={apply} onClose={() => close("apply")} />}
      {overview && <OverviewDialog connId={overview} onClose={() => close("overview")} />}
    </>
  );
}

// ---- port-forward ----

function ForwardDialog({ req, onClose }: { req: K8sForwardReq; onClose: () => void }) {
  const t = useT();
  const [ports, setPorts] = useState<{ port: number; label: string }[] | null>(null);
  const [remote, setRemote] = useState(req.port ? String(req.port) : "");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [started, setStarted] = useState<K8sForwardInfo | null>(null);

  useEffect(() => {
    const ref = builtinRef(req.plural);
    if (!ref) return;
    api.k8sGet(req.connId, ref, req.ns, req.name)
      .then((o) => {
        const p = forwardablePorts(o, req.plural);
        setPorts(p);
        if (!req.port && p[0]) {
          setRemote(String(p[0].port));
          setLocal(String(p[0].port));
        }
      })
      .catch((e) => { setPorts([]); setErr(errText(e)); });
  }, [req]);

  const start = async () => {
    const rp = Number(remote);
    const lp = local.trim() === "" ? 0 : Number(local);
    if (!Number.isInteger(rp) || rp <= 0 || rp > 65535 || !Number.isInteger(lp) || lp < 0 || lp > 65535) {
      setErr(t("埠號必須是 1–65535（本機埠留空＝自動）"));
      return;
    }
    setBusy(true);
    try {
      const f = await api.k8sForwardOpen(req.connId, req.ns, forwardTarget(req.plural, req.name), rp, lp);
      setStarted(f);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const addr = started ? `127.0.0.1:${started.local_port}` : "";
  return (
    <Modal
      onClose={onClose}
      title={t("轉發埠：{kind}/{name}", { kind: kindOf(req.plural), name: req.name })}
      icon={ArrowRightLeft}
      size="sm"
      noMaximize
      footer={started ? (
        <Button variant="primary" onClick={onClose}>{t("完成")}</Button>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" icon={ArrowRightLeft} loading={busy} disabled={!remote} onClick={() => void start()}>{t("開始轉發")}</Button>
        </>
      )}
    >
      {started ? (
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-fg/60">{t("已轉發到")}</span>
            <span className="mono text-accent">{addr}</span>
            <IconButton icon={Copy} label={t("複製")} onClick={() => copyToClipboard(addr, t("已複製"))} />
          </div>
          <div className="text-xs text-fg/50">
            {t("→ Pod {pod} 的埠 {port}。轉發會持續到中斷連線；可在「叢集總覽」停止。", { pod: started.pod, port: started.remote_port })}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label={t("遠端埠")} hint={req.plural === "services" ? t("Service 的埠；會轉到後端某個 Ready 的 Pod") : undefined}>
            {ports && ports.length > 0 ? (
              <Select value={remote} onChange={(e) => { setRemote(e.target.value); if (!local || ports.some((p) => String(p.port) === local)) setLocal(e.target.value); }}>
                {ports.map((p) => <option key={p.port} value={p.port}>{p.label}</option>)}
                {!ports.some((p) => String(p.port) === remote) && remote && <option value={remote}>{remote}</option>}
              </Select>
            ) : (
              <Input value={remote} onChange={(e) => setRemote(e.target.value.replace(/\D/g, ""))} placeholder="5432" />
            )}
          </Field>
          <Field label={t("本機埠")} hint={t("留空＝由系統挑一個空的埠")}>
            <Input value={local} onChange={(e) => setLocal(e.target.value.replace(/\D/g, ""))} placeholder={t("自動")} />
          </Field>
          {!ports && <Spinner />}
          <ErrorLine text={err} />
        </div>
      )}
    </Modal>
  );
}

// ---- 套用 YAML ----

const APPLY_SAMPLE = `apiVersion: v1
kind: ConfigMap
metadata:
  name: example
data:
  key: value
`;

function ApplyDialog({ req, onClose }: { req: K8sApplyReq; onClose: () => void }) {
  const t = useT();
  const readonly = useStore((s) => s.readonlyConns[req.connId] === true);
  const [yaml, setYaml] = useState(req.initial ?? APPLY_SAMPLE);
  const [ns, setNs] = useState(req.ns ?? "");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<{ dry: boolean; items: K8sApplyResult[] } | null>(null);

  useEffect(() => {
    api.k8sNamespaces(req.connId).then(setNamespaces).catch(() => undefined);
  }, [req.connId]);

  const run = async (dry: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const items = await api.k8sApplyYaml(req.connId, yaml, ns || null, dry, force);
      setResults({ dry, items });
      if (!dry && items.every((r) => !r.error)) {
        toast.success(t("已套用 {n} 個資源", { n: items.length }));
        const touched = new Set(items.map((r) => r.namespace || CLUSTER_DB));
        for (const n of touched) refreshTree(req.connId, n);
      }
    } catch (e) {
      setErr(errText(e));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={t("套用 YAML")}
      icon={Upload}
      size="xl"
      codeZoom
      bodyClassName="p-0 flex flex-col min-h-0"
      className="h-[80vh]"
      footer={
        <>
          <label className="mr-auto flex items-center gap-1.5 text-xs text-fg/60 cursor-pointer select-none" title={t("欄位由別的工具管理時也覆寫（server-side apply 的 force）")}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            {t("強制接管衝突欄位")}
          </label>
          <Button variant="ghost" onClick={onClose}>{t("關閉")}</Button>
          <Button icon={CheckCircle2} loading={busy} onClick={() => void run(true)}>{t("試套用")}</Button>
          {!readonly && <Button variant="primary" icon={Upload} loading={busy} onClick={() => void run(false)}>{t("套用")}</Button>}
        </>
      }
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-fg/10 text-xs">
        <span className="text-fg/55">{t("預設 namespace")}</span>
        <Select value={ns} onChange={(e) => setNs(e.target.value)} className="w-56">
          <option value="">{t("（context 預設）")}</option>
          {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
        <span className="text-fg/40">{t("YAML 裡有寫 metadata.namespace 的以 YAML 為準；可放多份文件（---）")}</span>
      </div>
      <div className="flex-1 min-h-0" data-testid="k8s-apply-editor">
        <K8sYamlEditor value={yaml} onChange={setYaml} autoFocus />
      </div>
      {(err || results) && (
        <div className="max-h-48 overflow-auto border-t border-fg/10">
          <ErrorLine text={err} />
          {results && (
            <MiniTable
              head={[t("資源"), "Namespace", t("結果")]}
              rows={results.items.map((r) => [
                <span className="mono">{r.kind}/{r.name}</span>,
                <span className="mono text-fg/60">{r.namespace}</span>,
                r.error
                  ? <span className="text-danger whitespace-pre-wrap">{r.error}</span>
                  : <span className="text-success">{results.dry ? t("可套用（{a}）", { a: r.action }) : r.action}</span>,
              ])}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

// ---- 叢集總覽 ----

function OverviewDialog({ connId, onClose }: { connId: string; onClose: () => void }) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === connId));
  const [o, setO] = useState<K8sOverview | null>(null);
  const [fwds, setFwds] = useState<K8sForwardInfo[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ov, fw] = await Promise.all([api.k8sOverview(connId), api.k8sForwardList(connId)]);
      setO(ov);
      setFwds(fw);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setLoading(false);
    }
  }, [connId]);
  useEffect(() => { void load(); }, [load]);
  // 轉發的連線數會變，輕量輪詢。
  useEffect(() => {
    const h = window.setInterval(() => { api.k8sForwardList(connId).then(setFwds).catch(() => undefined); }, 3000);
    return () => window.clearInterval(h);
  }, [connId]);

  const stopFwd = async (id: string) => {
    await api.k8sForwardClose(id).catch((e) => toast.error(errText(e)));
    setFwds(await api.k8sForwardList(connId).catch(() => []));
  };

  const phases = Object.entries(o?.pod_phases ?? {});
  return (
    <Modal
      onClose={onClose}
      title={t("叢集總覽：{name}", { name: conn?.name ?? connId })}
      icon={ShipWheel}
      size="xl"
      className="h-[80vh]"
      footer={
        <>
          <Button variant="ghost" icon={FileCode2} className="mr-auto" onClick={() => { onClose(); useK8sUi.getState().openApply({ connId, ns: null }); }}>{t("套用 YAML…")}</Button>
          <Button icon={RefreshCw} loading={loading} onClick={() => void load()}>{t("重新整理")}</Button>
          <Button variant="primary" onClick={onClose}>{t("關閉")}</Button>
        </>
      }
    >
      <div className="space-y-4">
        <ErrorLine text={err} />
        {!o ? (!err && <div className="flex justify-center p-6"><Spinner /></div>) : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
              <StatTile label={t("版本")} value={o.version} sub={o.platform} />
              <StatTile label={t("節點")} value={o.nodes.length} sub={t("{n} 個就緒", { n: o.nodes.filter((n) => n.state !== "notready").length })} tone={o.nodes.some((n) => n.state === "notready") ? "warn" : undefined} />
              <StatTile label="Namespace" value={o.namespaces < 0 ? "—" : o.namespaces} />
              <StatTile label="Pod" value={o.pods < 0 ? "—" : o.pods} sub={phases.map(([k, v]) => `${k} ${v}`).join(" · ")} tone={phases.some(([k]) => k === "Failed" || k === "Pending") ? "warn" : undefined} />
            </div>
            <div className="text-xs text-fg/45 mono break-all">{o.label} · {o.server}{!o.metrics_available && ` · ${t("沒有 metrics-server（不顯示用量）")}`}</div>
            {o.errors.length > 0 && <div className="text-xs text-warning whitespace-pre-wrap">{o.errors.join("\n")}</div>}

            <InfoSection title={t("節點（{n}）", { n: o.nodes.length })}>
              <MiniTable
                head={[t("名稱"), t("狀態"), t("角色"), "CPU", t("記憶體"), "Pod", t("版本"), "IP", t("存在時間")]}
                rows={o.nodes.map((n) => [
                  <button type="button" className="mono text-accent hover:underline" onClick={() => { onClose(); openK8sTab(connId, CLUSTER_DB, `nodes/${n.name}`); }}>{n.name}</button>,
                  <span className={TONE_TEXT[n.state === "ready" ? "success" : n.state === "cordoned" ? "warning" : "danger"]}>{n.state}</span>,
                  n.roles.join(", ") || "—",
                  <span className="mono">{n.cpu_usage_milli != null ? `${fmtCpu(n.cpu_usage_milli)} / ` : ""}{fmtCpu(n.cpu_capacity_milli)}</span>,
                  <span className="mono">{n.memory_usage_bytes != null ? `${fmtBytes(n.memory_usage_bytes)} / ` : ""}{fmtBytes(n.memory_capacity_bytes)}</span>,
                  n.pods,
                  <span className="mono">{n.version}</span>,
                  <span className="mono">{n.internal_ip}</span>,
                  age(n.created),
                ])}
              />
            </InfoSection>

            <InfoSection title={t("進行中的轉發（{n}）", { n: fwds.length })}>
              <MiniTable
                head={[t("本機"), t("目標"), "Pod", t("連線數"), t("開始"), ""]}
                rows={fwds.map((f) => [
                  <span className="mono text-accent">127.0.0.1:{f.local_port}</span>,
                  <span className="mono">{f.namespace}/{f.target}:{f.remote_port}</span>,
                  <span className="mono text-fg/60">{f.pod}</span>,
                  <span>{f.active}{f.last_error && <span className="text-warning" title={f.last_error}> ⚠</span>}</span>,
                  age(f.started),
                  <IconButton icon={Square} label={t("停止轉發")} onClick={() => void stopFwd(f.id)} />,
                ])}
                empty={t("沒有進行中的轉發（從 Pod / Service 右鍵「轉發埠…」開始）")}
              />
            </InfoSection>

            <InfoSection title={<span className="flex items-center gap-2">{t("最近的警告事件")}{o.warnings.length > 0 && <Badge tone="warning">{o.warnings.length}</Badge>}</span>}>
              <EventsTable events={o.warnings} showObject />
            </InfoSection>
          </>
        )}
      </div>
    </Modal>
  );
}
