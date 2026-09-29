// Docker 連線的分頁內容：依連線樹的分類（containers / images / volumes / networks）分派到對應詳情。
import { useCallback, useEffect, useState } from "react";
import { HardDrive, Layers, Network, RefreshCw, Tag, Trash2 } from "lucide-react";
import { api } from "./api";
import type { DockerImageDetail, DockerNetwork, DockerVolume } from "./dockerTypes";
import { fmtBytes, fmtIso, fmtUnix } from "./dockerModel";
import { removeImage, removeNetwork, removeVolume, tagImage } from "./dockerActions";
import { EnvTable, ErrorLine, InfoRow, InfoSection, JsonBlock, MiniTable } from "./dockerUi";
import DockerContainerView from "./DockerContainerView";
import { Badge, Button, EmptyState, Spinner } from "./ui/index";
import { useStore } from "./store";
import { useT } from "./i18n";

export default function DockerObjectView({ connId, category, name }: { connId: string; category: string; name: string }) {
  const conn = useStore((s) => s.connections.find((c) => c.id === connId));
  const requestTreeReload = useStore((s) => s.requestTreeReload);
  const onChanged = useCallback(() => requestTreeReload(connId, category), [requestTreeReload, connId, category]);
  if (!conn) return null;
  switch (category) {
    case "containers":
      return <DockerContainerView conn={conn} name={name} onChanged={onChanged} />;
    case "images":
      return <ImageView connId={connId} reference={name} onChanged={onChanged} />;
    case "volumes":
      return <VolumeView connId={connId} name={name} onChanged={onChanged} />;
    case "networks":
      return <NetworkView connId={connId} name={name} onChanged={onChanged} />;
    default:
      return null;
  }
}

/** 共用的「載入 → 顯示 / 錯誤 / 已不存在」外殼。 */
function useResource<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const reload = useCallback(async () => {
    try {
      setData(await load());
      setErr(null);
      setGone(false);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/404|no such|not found/i.test(msg)) setGone(true);
      setErr(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, gone, reload };
}

function Gone({ name, onRefresh }: { name: string; onRefresh: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon={Trash2}
      title={t("「{name}」已不存在", { name })}
      hint={t("可能已被刪除；請重新整理連線樹。")}
      action={<Button icon={RefreshCw} onClick={onRefresh}>{t("重新整理")}</Button>}
    />
  );
}

function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 px-2 py-1.5 border-b border-fg/10 bg-bar flex-wrap">{children}</div>;
}

function ImageView({ connId, reference, onChanged }: { connId: string; reference: string; onChanged: () => void }) {
  const t = useT();
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const { data: d, err, gone, reload } = useResource<DockerImageDetail>(() => api.dockerImageInspect(connId, reference), [connId, reference]);
  if (gone) return <Gone name={reference} onRefresh={() => { onChanged(); void reload(); }} />;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Toolbar>
        <Layers size={14} className="text-fg/40" />
        <span className="text-xs mono text-fg/70 truncate">{reference}</span>
        {d && <Badge>{fmtBytes(d.size)}</Badge>}
        {d && <Badge>{d.os}/{d.arch}</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void reload()}>{t("重新整理")}</Button>
          {!readonly && (
            <>
              <Button size="sm" variant="ghost" icon={Tag} onClick={async () => { if (await tagImage(connId, reference)) onChanged(); }}>{t("加上 tag…")}</Button>
              <Button size="sm" variant="danger" icon={Trash2} onClick={async () => { if (await removeImage(connId, reference)) onChanged(); }}>{t("刪除")}</Button>
            </>
          )}
        </div>
      </Toolbar>
      <ErrorLine text={err} />
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
        {!d ? !err && <div className="flex justify-center p-6"><Spinner /></div> : (
          <>
            <InfoSection title={t("概要")}>
              <InfoRow label="ID" mono>{d.id.replace(/^sha256:/, "").slice(0, 12)}</InfoRow>
              <InfoRow label={t("Tag")} mono>{d.repo_tags.join(", ") || "—"}</InfoRow>
              <InfoRow label="Digest" mono>{d.repo_digests.join("\n") || "—"}</InfoRow>
              <InfoRow label={t("建立時間")}>{fmtIso(d.created)}</InfoRow>
              <InfoRow label={t("大小")}>{fmtBytes(d.size)}{t("（{n} 層）", { n: d.layers })}</InfoRow>
              <InfoRow label="Entrypoint" mono>{d.entrypoint.join(" ") || "—"}</InfoRow>
              <InfoRow label="Cmd" mono>{d.cmd.join(" ") || "—"}</InfoRow>
              {d.working_dir && <InfoRow label={t("工作目錄")} mono>{d.working_dir}</InfoRow>}
              {d.user && <InfoRow label={t("使用者")} mono>{d.user}</InfoRow>}
              <InfoRow label={t("開放埠")} mono>{d.exposed_ports.join(", ") || "—"}</InfoRow>
            </InfoSection>
            <EnvTable env={d.env} />
            <InfoSection title={t("建置歷史（{n}）", { n: d.history.length })}>
              <MiniTable
                head={[t("時間"), t("大小"), t("指令")]}
                rows={d.history.map((h) => [
                  <span className="whitespace-nowrap">{fmtUnix(h.created)}</span>,
                  <span className="whitespace-nowrap">{fmtBytes(h.size)}</span>,
                  <span className="mono text-fg/70">{h.created_by.replace(/^\/bin\/sh -c (#\(nop\) )?/, "")}</span>,
                ])}
              />
            </InfoSection>
            {Object.keys(d.labels).length > 0 && (
              <InfoSection title={t("標籤（{n}）", { n: Object.keys(d.labels).length })}>
                <MiniTable head={[t("鍵"), t("值")]} rows={Object.entries(d.labels).map(([k, v]) => [<span className="mono text-fg/70">{k}</span>, <span className="mono">{v}</span>])} />
              </InfoSection>
            )}
            <JsonBlock title="inspect JSON" json={d.raw} />
          </>
        )}
      </div>
    </div>
  );
}

function VolumeView({ connId, name, onChanged }: { connId: string; name: string; onChanged: () => void }) {
  const t = useT();
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const { data: v, err, gone, reload } = useResource<DockerVolume | undefined>(
    async () => {
      const list = await api.dockerVolumes(connId);
      const found = list.find((x) => x.name === name);
      if (!found) throw new Error("404 not found");
      return found;
    },
    [connId, name],
  );
  if (gone) return <Gone name={name} onRefresh={() => { onChanged(); void reload(); }} />;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Toolbar>
        <HardDrive size={14} className="text-fg/40" />
        <span className="text-xs mono text-fg/70 truncate">{name}</span>
        {v && <Badge tone={v.used_by.length ? "success" : "neutral"}>{v.used_by.length ? t("使用中") : t("未使用")}</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void reload()}>{t("重新整理")}</Button>
          {!readonly && v && (
            <Button size="sm" variant="danger" icon={Trash2} onClick={async () => { if (await removeVolume(connId, name, v.used_by)) onChanged(); }}>{t("刪除")}</Button>
          )}
        </div>
      </Toolbar>
      <ErrorLine text={err} />
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
        {!v ? !err && <div className="flex justify-center p-6"><Spinner /></div> : (
          <>
            <InfoSection title={t("概要")}>
              <InfoRow label={t("名稱")} mono>{v.name}</InfoRow>
              <InfoRow label="Driver">{v.driver}</InfoRow>
              <InfoRow label={t("掛載點")} mono>{v.mountpoint}</InfoRow>
              <InfoRow label={t("建立時間")}>{fmtIso(v.created)}</InfoRow>
              <InfoRow label="Scope">{v.scope}</InfoRow>
              <InfoRow label={t("使用中的容器")} mono>{v.used_by.join(", ") || "—"}</InfoRow>
            </InfoSection>
            {Object.keys(v.labels).length > 0 && (
              <InfoSection title={t("標籤（{n}）", { n: Object.keys(v.labels).length })}>
                <MiniTable head={[t("鍵"), t("值")]} rows={Object.entries(v.labels).map(([k, val]) => [<span className="mono text-fg/70">{k}</span>, <span className="mono">{val}</span>])} />
              </InfoSection>
            )}
            <JsonBlock title="JSON" json={v.raw} />
          </>
        )}
      </div>
    </div>
  );
}

function NetworkView({ connId, name, onChanged }: { connId: string; name: string; onChanged: () => void }) {
  const t = useT();
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const { data: n, err, gone, reload } = useResource<DockerNetwork>(() => api.dockerNetworkInspect(connId, name), [connId, name]);
  if (gone) return <Gone name={name} onRefresh={() => { onChanged(); void reload(); }} />;
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Toolbar>
        <Network size={14} className="text-fg/40" />
        <span className="text-xs mono text-fg/70 truncate">{name}</span>
        {n && <Badge>{n.driver}</Badge>}
        {n?.builtin && <Badge tone="info">{t("內建")}</Badge>}
        {n?.internal && <Badge tone="warning">internal</Badge>}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void reload()}>{t("重新整理")}</Button>
          {!readonly && n && !n.builtin && (
            <Button size="sm" variant="danger" icon={Trash2} onClick={async () => { if (await removeNetwork(connId, name)) onChanged(); }}>{t("刪除")}</Button>
          )}
        </div>
      </Toolbar>
      <ErrorLine text={err} />
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-4">
        {!n ? !err && <div className="flex justify-center p-6"><Spinner /></div> : (
          <>
            <InfoSection title={t("概要")}>
              <InfoRow label="ID" mono>{n.id.slice(0, 12)}</InfoRow>
              <InfoRow label="Driver">{n.driver}</InfoRow>
              <InfoRow label="Scope">{n.scope}</InfoRow>
              <InfoRow label={t("子網")} mono>{n.subnets.join(", ") || "—"}</InfoRow>
              <InfoRow label={t("閘道")} mono>{n.gateways.join(", ") || "—"}</InfoRow>
            </InfoSection>
            <InfoSection title={t("連接的容器（{n}）", { n: n.members.length })}>
              <MiniTable
                head={[t("容器"), "IPv4", "MAC"]}
                rows={n.members.map((m) => [m.name, <span className="mono">{m.ipv4}</span>, <span className="mono text-fg/60">{m.mac}</span>])}
              />
            </InfoSection>
            <JsonBlock title="inspect JSON" json={n.raw} />
          </>
        )}
      </div>
    </div>
  );
}
