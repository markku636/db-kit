// Kubernetes 資源分頁的「概要」子頁：依種類挑重點欄位排版，其他種類（含 CRD）只顯示 metadata + conditions。
import { useState, type ReactNode } from "react";
import { Copy, Eye, EyeOff } from "lucide-react";
import { api } from "./api";
import type { K8sObject } from "./k8sTypes";
import {
  age, b64decode, conditions, defaultContainer, fmtCpu, podContainers, podStatus, podStatusTone, replicas, servicePorts,
  templateContainers, TONE_TEXT,
} from "./k8sModel";
import { isSensitiveEnvKey, fmtBytes, fmtIso } from "./dockerModel";
import { errText } from "./k8sActions";
import { InfoRow, InfoSection, MiniTable, StatTile } from "./dockerUi";
import { IconButton } from "./ui/index";
import { copyToClipboard, toast } from "./ui";
import { useT } from "./i18n";

const Mono = ({ children }: { children: ReactNode }) => <span className="mono">{children}</span>;

function KeyValues({ title, map }: { title: string; map: Record<string, string> | undefined }) {
  const t = useT();
  const entries = Object.entries(map ?? {});
  if (entries.length === 0) return null;
  return (
    <InfoSection title={`${title}（${entries.length}）`}>
      <MiniTable
        head={[t("鍵"), t("值")]}
        rows={entries.map(([k, v]) => [<span className="mono text-fg/70">{k}</span>, <span className="mono whitespace-pre-wrap">{v}</span>])}
      />
    </InfoSection>
  );
}

function Meta({ o }: { o: K8sObject }) {
  const t = useT();
  const m = o.metadata;
  return (
    <InfoSection title={t("中繼資料")}>
      <InfoRow label={t("名稱")} mono>{m.name}</InfoRow>
      {m.namespace && <InfoRow label="Namespace" mono>{m.namespace}</InfoRow>}
      <InfoRow label={t("建立時間")}>{fmtIso(m.creationTimestamp ?? "")}（{age(m.creationTimestamp)}）</InfoRow>
      {m.deletionTimestamp && <InfoRow label={t("刪除中")}><span className="text-info">{fmtIso(m.deletionTimestamp)}</span></InfoRow>}
      {(m.ownerReferences ?? []).length > 0 && (
        <InfoRow label={t("擁有者")} mono>{(m.ownerReferences ?? []).map((r) => `${r.kind}/${r.name}`).join(", ")}</InfoRow>
      )}
      {m.uid && <InfoRow label="UID" mono>{m.uid}</InfoRow>}
    </InfoSection>
  );
}

function Conditions({ o }: { o: K8sObject }) {
  const t = useT();
  const cs = conditions(o);
  if (cs.length === 0) return null;
  return (
    <InfoSection title={t("狀況（conditions）")}>
      <MiniTable
        head={[t("類型"), t("狀態"), t("原因"), t("訊息"), t("變更時間")]}
        rows={cs.map((c) => [
          <Mono>{c.type}</Mono>,
          <span className={c.status === "True" ? "text-success" : c.status === "False" ? "text-warning" : "text-fg/50"}>{c.status}</span>,
          <Mono>{c.reason}</Mono>,
          <span className="whitespace-pre-wrap">{c.message}</span>,
          <span title={c.last}>{age(c.last)}</span>,
        ])}
      />
    </InfoSection>
  );
}

function PodSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const st = podStatus(o);
  const rows = podContainers(o);
  return (
    <>
      <InfoSection title={t("概要")}>
        <InfoRow label={t("狀態")}><span className={TONE_TEXT[podStatusTone(st)]}>{st}</span></InfoRow>
        <InfoRow label={t("節點")} mono>{o.spec?.nodeName ?? "—"}</InfoRow>
        <InfoRow label="Pod IP" mono>{(o.status?.podIPs ?? []).map((x: any) => x.ip).join(", ") || o.status?.podIP || "—"}</InfoRow>
        <InfoRow label="QoS">{o.status?.qosClass ?? "—"}</InfoRow>
        <InfoRow label="ServiceAccount" mono>{o.spec?.serviceAccountName ?? "default"}</InfoRow>
        <InfoRow label={t("重啟策略")}>{o.spec?.restartPolicy ?? ""}</InfoRow>
        {o.status?.message && <InfoRow label={t("訊息")}><span className="text-warning">{o.status.message}</span></InfoRow>}
      </InfoSection>
      <InfoSection title={t("容器（{n}）", { n: rows.length })}>
        <MiniTable
          head={[t("名稱"), t("映像"), t("狀態"), t("就緒"), t("重啟"), t("埠")]}
          rows={rows.map((c) => [
            <span className="mono">{c.name}{c.init ? <span className="text-fg/40"> (init)</span> : null}{c.name === defaultContainer(o) && !c.init && rows.filter((r) => !r.init).length > 1 ? <span className="text-fg/40"> ★</span> : null}</span>,
            <span className="mono text-fg/70">{c.image}</span>,
            <span className={c.state === "running" ? "text-success" : c.state === "waiting" ? "text-warning" : "text-fg/55"}>{c.state}{c.reason ? ` · ${c.reason}` : ""}</span>,
            c.ready ? "✓" : "—",
            c.restarts,
            <span className="mono">{c.ports.map((p) => `${p.port}${p.name ? `/${p.name}` : ""}`).join(", ")}</span>,
          ])}
        />
      </InfoSection>
    </>
  );
}

function WorkloadSummary({ o, plural }: { o: K8sObject; plural: string }) {
  const t = useT();
  const r = replicas(o, plural);
  const containers = templateContainers(o, plural);
  const strategy = o.spec?.strategy?.type ?? o.spec?.updateStrategy?.type ?? "";
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <StatTile label={t("期望")} value={r.desired} />
        <StatTile label={t("就緒")} value={r.ready} tone={r.ready < r.desired ? "warn" : "ok"} />
        <StatTile label={t("已更新")} value={r.updated} />
        <StatTile label={t("可用")} value={r.available} />
      </div>
      <InfoSection title={t("概要")}>
        {strategy && <InfoRow label={t("更新策略")}>{strategy}</InfoRow>}
        <InfoRow label="Selector" mono>{Object.entries(o.spec?.selector?.matchLabels ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}</InfoRow>
        {plural === "statefulsets" && <InfoRow label="Service" mono>{o.spec?.serviceName ?? "—"}</InfoRow>}
        {o.status?.observedGeneration != null && <InfoRow label="Generation">{o.metadata.generation as number} / {o.status.observedGeneration}</InfoRow>}
      </InfoSection>
      <InfoSection title={t("容器（{n}）", { n: containers.length })}>
        <MiniTable head={[t("名稱"), t("映像"), t("埠")]} rows={containers.map((c) => [<Mono>{c.name}</Mono>, <span className="mono text-fg/70">{c.image}</span>, <Mono>{c.ports.join(", ")}</Mono>])} />
      </InfoSection>
    </>
  );
}

function ServiceSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const lb = (o.status?.loadBalancer?.ingress ?? []).map((x: any) => x.ip || x.hostname).filter(Boolean);
  return (
    <>
      <InfoSection title={t("概要")}>
        <InfoRow label={t("類型")}>{o.spec?.type ?? "ClusterIP"}</InfoRow>
        <InfoRow label="Cluster IP" mono>{(o.spec?.clusterIPs ?? [o.spec?.clusterIP]).filter(Boolean).join(", ") || "—"}</InfoRow>
        {lb.length > 0 && <InfoRow label={t("外部位址")} mono>{lb.join(", ")}</InfoRow>}
        {(o.spec?.externalIPs ?? []).length > 0 && <InfoRow label="External IP" mono>{o.spec.externalIPs.join(", ")}</InfoRow>}
        {o.spec?.externalName && <InfoRow label="External name" mono>{o.spec.externalName}</InfoRow>}
        <InfoRow label="Selector" mono>{Object.entries(o.spec?.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "—"}</InfoRow>
        {o.spec?.sessionAffinity && o.spec.sessionAffinity !== "None" && <InfoRow label="Session affinity">{o.spec.sessionAffinity}</InfoRow>}
      </InfoSection>
      <InfoSection title={t("埠")}>
        <MiniTable
          head={[t("名稱"), t("埠"), t("目標埠"), "NodePort", t("協定")]}
          rows={servicePorts(o).map((p) => [<Mono>{p.name}</Mono>, <Mono>{p.port}</Mono>, <Mono>{p.targetPort}</Mono>, <Mono>{p.nodePort ?? ""}</Mono>, p.protocol])}
        />
      </InfoSection>
    </>
  );
}

function IngressSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const rows: ReactNode[][] = [];
  for (const r of o.spec?.rules ?? []) {
    for (const p of r.http?.paths ?? []) {
      const b = p.backend?.service;
      rows.push([<Mono>{r.host ?? "*"}</Mono>, <Mono>{p.path ?? "/"}</Mono>, p.pathType ?? "", <Mono>{b ? `${b.name}:${b.port?.number ?? b.port?.name ?? ""}` : ""}</Mono>]);
    }
  }
  const lb = (o.status?.loadBalancer?.ingress ?? []).map((x: any) => x.ip || x.hostname).filter(Boolean);
  return (
    <>
      <InfoSection title={t("概要")}>
        <InfoRow label="Class" mono>{o.spec?.ingressClassName ?? o.metadata.annotations?.["kubernetes.io/ingress.class"] ?? "—"}</InfoRow>
        <InfoRow label={t("位址")} mono>{lb.join(", ") || "—"}</InfoRow>
        <InfoRow label="TLS" mono>{(o.spec?.tls ?? []).flatMap((x: any) => x.hosts ?? []).join(", ") || "—"}</InfoRow>
      </InfoSection>
      <InfoSection title={t("規則")}>
        <MiniTable head={[t("主機"), t("路徑"), t("比對"), t("後端")]} rows={rows} />
      </InfoSection>
    </>
  );
}

function ConfigMapSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const entries = Object.entries(o.data ?? {});
  const bin = Object.keys((o.binaryData as Record<string, string>) ?? {});
  return (
    <>
      {entries.map(([k, v]) => (
        <InfoSection key={k} title={k} right={<IconButton icon={Copy} label={t("複製")} onClick={() => copyToClipboard(v, t("已複製"))} />}>
          <pre className="mono text-[11px] leading-relaxed p-3 overflow-auto max-h-[360px] whitespace-pre-wrap break-all text-fg/80">{v}</pre>
        </InfoSection>
      ))}
      {bin.length > 0 && <InfoSection title="binaryData"><div className="px-3 py-2 text-xs mono">{bin.join(", ")}</div></InfoSection>}
      {entries.length === 0 && bin.length === 0 && <div className="text-xs text-fg/40">{t("（沒有資料）")}</div>}
    </>
  );
}

function SecretSummary({ connId, o }: { connId: string; o: K8sObject }) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const keys = Object.keys(o.data ?? {});
  const reveal = async (k: string) => {
    let v = values;
    if (!v) {
      try {
        v = await api.k8sSecretData(connId, o.metadata.namespace ?? "", o.metadata.name);
        setValues(v);
      } catch (e) {
        toast.error(errText(e));
        return;
      }
    }
    setShown((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k); else n.add(k);
      return n;
    });
  };
  const valueOf = (k: string) => values?.[k] ?? b64decode(o.data?.[k] ?? "") ?? "";
  return (
    <>
      <InfoSection title={t("概要")}>
        <InfoRow label={t("類型")} mono>{o.type ?? "Opaque"}</InfoRow>
      </InfoSection>
      <InfoSection title={t("資料（{n}）", { n: keys.length })}>
        <MiniTable
          head={[t("鍵"), t("值"), ""]}
          rows={keys.map((k) => [
            <span className="mono text-fg/70">{k}</span>,
            <span className="mono whitespace-pre-wrap break-all">{shown.has(k) ? valueOf(k) : "••••••"}</span>,
            <div className="flex gap-0.5 justify-end">
              <IconButton icon={shown.has(k) ? EyeOff : Eye} label={shown.has(k) ? t("遮罩") : t("顯示")} onClick={() => void reveal(k)} />
              <IconButton icon={Copy} label={t("複製值")} onClick={() => copyToClipboard(valueOf(k), t("已複製"))} />
            </div>,
          ])}
          empty={t("（沒有資料）")}
        />
      </InfoSection>
    </>
  );
}

function JobSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const s = o.status ?? {};
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <StatTile label={t("需完成")} value={o.spec?.completions ?? 1} />
        <StatTile label={t("成功")} value={s.succeeded ?? 0} tone="ok" />
        <StatTile label={t("失敗")} value={s.failed ?? 0} tone={(s.failed ?? 0) > 0 ? "warn" : undefined} />
        <StatTile label={t("執行中")} value={s.active ?? 0} />
      </div>
      <InfoSection title={t("概要")}>
        <InfoRow label={t("開始")}>{fmtIso(s.startTime ?? "") || "—"}</InfoRow>
        <InfoRow label={t("完成")}>{fmtIso(s.completionTime ?? "") || "—"}</InfoRow>
        <InfoRow label={t("平行數")}>{o.spec?.parallelism ?? 1}</InfoRow>
        <InfoRow label={t("重試上限")}>{o.spec?.backoffLimit ?? 6}</InfoRow>
      </InfoSection>
    </>
  );
}

function CronJobSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const c = templateContainers(o, "cronjobs");
  return (
    <>
      <InfoSection title={t("概要")}>
        <InfoRow label={t("排程")} mono>{o.spec?.schedule}{o.spec?.timeZone ? ` (${o.spec.timeZone})` : ""}</InfoRow>
        <InfoRow label={t("暫停")}>{o.spec?.suspend ? <span className="text-warning">{t("是")}</span> : t("否")}</InfoRow>
        <InfoRow label={t("上次排程")}>{fmtIso(o.status?.lastScheduleTime ?? "") || "—"}</InfoRow>
        <InfoRow label={t("上次成功")}>{fmtIso(o.status?.lastSuccessfulTime ?? "") || "—"}</InfoRow>
        <InfoRow label={t("執行中")} mono>{(o.status?.active ?? []).map((a: any) => a.name).join(", ") || "—"}</InfoRow>
        <InfoRow label={t("並行策略")}>{o.spec?.concurrencyPolicy ?? "Allow"}</InfoRow>
      </InfoSection>
      <InfoSection title={t("容器（{n}）", { n: c.length })}>
        <MiniTable head={[t("名稱"), t("映像")]} rows={c.map((x) => [<Mono>{x.name}</Mono>, <span className="mono text-fg/70">{x.image}</span>])} />
      </InfoSection>
    </>
  );
}

function PvcSummary({ o, pv }: { o: K8sObject; pv?: boolean }) {
  const t = useT();
  return (
    <InfoSection title={t("概要")}>
      <InfoRow label={t("狀態")}>{o.status?.phase ?? "—"}</InfoRow>
      <InfoRow label={t("容量")} mono>{pv ? o.spec?.capacity?.storage : o.status?.capacity?.storage ?? o.spec?.resources?.requests?.storage ?? "—"}</InfoRow>
      <InfoRow label={t("存取模式")} mono>{(o.spec?.accessModes ?? []).join(", ")}</InfoRow>
      <InfoRow label="StorageClass" mono>{o.spec?.storageClassName ?? "—"}</InfoRow>
      {pv ? (
        <>
          <InfoRow label={t("回收策略")}>{o.spec?.persistentVolumeReclaimPolicy ?? "—"}</InfoRow>
          <InfoRow label={t("綁定")} mono>{o.spec?.claimRef ? `${o.spec.claimRef.namespace}/${o.spec.claimRef.name}` : "—"}</InfoRow>
        </>
      ) : (
        <InfoRow label="Volume" mono>{o.spec?.volumeName ?? "—"}</InfoRow>
      )}
    </InfoSection>
  );
}

function NodeSummary({ o, usage }: { o: K8sObject; usage?: { cpu: number; mem: number } | null }) {
  const t = useT();
  const info = o.status?.nodeInfo ?? {};
  const alloc = o.status?.allocatable ?? {};
  const cap = o.status?.capacity ?? {};
  return (
    <>
      {usage && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatTile label="CPU" value={fmtCpu(usage.cpu)} sub={`/ ${alloc.cpu ?? "?"}`} />
          <StatTile label={t("記憶體")} value={fmtBytes(usage.mem)} sub={`/ ${alloc.memory ?? "?"}`} />
        </div>
      )}
      <InfoSection title={t("概要")}>
        <InfoRow label={t("可排程")}>{o.spec?.unschedulable ? <span className="text-warning">{t("否（cordoned）")}</span> : t("是")}</InfoRow>
        <InfoRow label={t("位址")} mono>{(o.status?.addresses ?? []).map((a: any) => `${a.type}: ${a.address}`).join(" · ")}</InfoRow>
        <InfoRow label="Kubelet" mono>{info.kubeletVersion}</InfoRow>
        <InfoRow label="OS" mono>{info.osImage} · {info.kernelVersion} · {info.architecture}</InfoRow>
        <InfoRow label="Runtime" mono>{info.containerRuntimeVersion}</InfoRow>
        <InfoRow label={t("容量")} mono>CPU {cap.cpu} · {t("記憶體")} {cap.memory} · Pods {cap.pods}</InfoRow>
        <InfoRow label={t("可配置")} mono>CPU {alloc.cpu} · {t("記憶體")} {alloc.memory} · Pods {alloc.pods}</InfoRow>
        {(o.spec?.taints ?? []).length > 0 && (
          <InfoRow label="Taints" mono>{o.spec.taints.map((x: any) => `${x.key}${x.value ? `=${x.value}` : ""}:${x.effect}`).join(", ")}</InfoRow>
        )}
      </InfoSection>
    </>
  );
}

function HpaSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const ref = o.spec?.scaleTargetRef;
  return (
    <InfoSection title={t("概要")}>
      <InfoRow label={t("目標")} mono>{ref ? `${ref.kind}/${ref.name}` : "—"}</InfoRow>
      <InfoRow label={t("副本數")}>{o.status?.currentReplicas ?? 0} → {o.status?.desiredReplicas ?? 0}（{o.spec?.minReplicas ?? 1}–{o.spec?.maxReplicas}）</InfoRow>
      {(o.spec?.metrics ?? []).map((m: any, i: number) => {
        const r = m.resource;
        const target = r?.target?.averageUtilization != null ? `${r.target.averageUtilization}%` : r?.target?.averageValue ?? r?.target?.value ?? "";
        const cur = (o.status?.currentMetrics ?? [])[i]?.resource?.current;
        const curText = cur?.averageUtilization != null ? `${cur.averageUtilization}%` : cur?.averageValue ?? "";
        return <InfoRow key={i} label={r?.name ?? m.type} mono>{curText || "?"} / {target}</InfoRow>;
      })}
    </InfoSection>
  );
}

function CrdSummary({ o }: { o: K8sObject }) {
  const t = useT();
  return (
    <InfoSection title={t("概要")}>
      <InfoRow label="Group" mono>{o.spec?.group}</InfoRow>
      <InfoRow label={t("範圍")}>{o.spec?.scope}</InfoRow>
      <InfoRow label="Kind" mono>{o.spec?.names?.kind}</InfoRow>
      <InfoRow label={t("複數")} mono>{o.spec?.names?.plural}{(o.spec?.names?.shortNames ?? []).length ? ` (${o.spec.names.shortNames.join(", ")})` : ""}</InfoRow>
      <InfoRow label={t("版本")} mono>{(o.spec?.versions ?? []).map((v: any) => `${v.name}${v.storage ? "*" : ""}${v.served ? "" : " (off)"}`).join(", ")}</InfoRow>
    </InfoSection>
  );
}

function StorageClassSummary({ o }: { o: K8sObject }) {
  const t = useT();
  const def = o.metadata.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
  return (
    <InfoSection title={t("概要")}>
      <InfoRow label="Provisioner" mono>{o.provisioner as string}</InfoRow>
      <InfoRow label={t("預設")}>{def ? t("是") : t("否")}</InfoRow>
      <InfoRow label={t("回收策略")}>{(o.reclaimPolicy as string) ?? "Delete"}</InfoRow>
      <InfoRow label={t("綁定模式")}>{(o.volumeBindingMode as string) ?? "Immediate"}</InfoRow>
      <InfoRow label={t("可擴充")}>{o.allowVolumeExpansion ? t("是") : t("否")}</InfoRow>
    </InfoSection>
  );
}

/** 環境變數（Pod：含 Secret / ConfigMap 參照的實際值，機密值遮罩）。 */
export function PodEnvSection({ connId, pod }: { connId: string; pod: K8sObject }) {
  const t = useT();
  const [env, setEnv] = useState<{ container: string; name: string; value: string; secret: boolean }[] | null>(null);
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    try {
      setEnv(await api.k8sPodEnv(connId, pod.metadata.namespace ?? "", pod.metadata.name));
    } catch (e) {
      setErr(errText(e));
    }
  };
  if (!env) {
    const count = (pod.spec?.containers ?? []).reduce((a: number, c: any) => a + (c.env?.length ?? 0) + (c.envFrom?.length ?? 0), 0);
    if (count === 0) return null;
    return (
      <InfoSection title={t("環境變數")}>
        <div className="px-3 py-2 text-xs flex items-center gap-2">
          <button type="button" className="text-accent hover:underline" onClick={() => void load()}>{t("載入環境變數（含 Secret / ConfigMap 參照的值）")}</button>
          {err && <span className="text-danger">{err}</span>}
        </div>
      </InfoSection>
    );
  }
  return (
    <InfoSection
      title={t("環境變數（{n}）", { n: env.length })}
      right={<IconButton icon={reveal ? EyeOff : Eye} label={reveal ? t("遮罩機密值") : t("顯示機密值")} onClick={() => setReveal((v) => !v)} />}
    >
      <MiniTable
        head={[t("容器"), t("名稱"), t("值")]}
        rows={env.map((e) => [
          <span className="text-fg/50">{e.container}</span>,
          <span className="mono text-fg/70">{e.name}</span>,
          <span className="mono break-all">{!reveal && (e.secret || isSensitiveEnvKey(e.name)) && e.value ? "••••••" : e.value}</span>,
        ])}
      />
    </InfoSection>
  );
}

export default function K8sSummary({ connId, plural, o, nodeUsage }: {
  connId: string;
  plural: string;
  o: K8sObject;
  nodeUsage?: { cpu: number; mem: number } | null;
}) {
  const t = useT();
  let body: ReactNode = null;
  switch (plural) {
    case "pods": body = <><PodSummary o={o} /><PodEnvSection connId={connId} pod={o} /></>; break;
    case "deployments": case "statefulsets": case "daemonsets": case "replicasets": body = <WorkloadSummary o={o} plural={plural} />; break;
    case "services": body = <ServiceSummary o={o} />; break;
    case "ingresses": body = <IngressSummary o={o} />; break;
    case "configmaps": body = <ConfigMapSummary o={o} />; break;
    case "secrets": body = <SecretSummary connId={connId} o={o} />; break;
    case "jobs": body = <JobSummary o={o} />; break;
    case "cronjobs": body = <CronJobSummary o={o} />; break;
    case "persistentvolumeclaims": body = <PvcSummary o={o} />; break;
    case "persistentvolumes": body = <PvcSummary o={o} pv />; break;
    case "nodes": body = <NodeSummary o={o} usage={nodeUsage} />; break;
    case "horizontalpodautoscalers": body = <HpaSummary o={o} />; break;
    case "customresourcedefinitions": body = <CrdSummary o={o} />; break;
    case "storageclasses": body = <StorageClassSummary o={o} />; break;
  }
  return (
    <>
      {body}
      <Conditions o={o} />
      <Meta o={o} />
      <KeyValues title={t("標籤")} map={o.metadata.labels} />
      <KeyValues title={t("註記")} map={Object.fromEntries(Object.entries(o.metadata.annotations ?? {}).filter(([k]) => k !== "kubectl.kubernetes.io/last-applied-configuration"))} />
    </>
  );
}
