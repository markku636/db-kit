// Docker 總覽（連線右鍵 overlay，版型同 RabbitMqOverview / KafkaClusterOverview）：
// 引擎資訊 + 容器數磚 + 磁碟用量與清理 + 依 compose 專案分組的容器清單（可直接啟停 / 開分頁）。
import { useCallback, useEffect, useState } from "react";
import { Container, Download, Play, RefreshCw, Square, X } from "lucide-react";
import { api } from "./api";
import type { DockerContainer, DockerDiskUsage, DockerOverview as Overview, DockerPruneTarget } from "./dockerTypes";
import { containerStateTone, fmtBytes, groupByCompose, portLabel } from "./dockerModel";
import { prune, pruneLabel, runContainerAction } from "./dockerActions";
import { ErrorLine, StatTile } from "./dockerUi";
import { Badge, Button, IconButton, ModalViewControls, useModalView } from "./ui/index";
import Icon from "./ui/Icon";
import { useModalOverlay } from "./ui";
import { useStore } from "./store";
import { useT } from "./i18n";

export default function DockerOverview({ connId, connName, onClose, onPull }: {
  connId: string;
  connName: string;
  onClose: () => void;
  onPull: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const { shellClass } = useModalView();
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const requestTreeReload = useStore((s) => s.requestTreeReload);
  const [info, setInfo] = useState<Overview | null>(null);
  const [df, setDf] = useState<DockerDiskUsage | null>(null);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, cs] = await Promise.all([api.dockerOverview(connId), api.dockerContainers(connId, true)]);
      setInfo(o);
      setContainers(cs);
      setErr(null);
      // /system/df 在映像很多的機器上要好幾秒，不擋住其他資訊。
      api.dockerDiskUsage(connId).then(setDf).catch(() => setDf(null));
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [connId]);

  useEffect(() => { void load(); }, [load]);

  const afterChange = (category: string) => {
    requestTreeReload(connId, category);
    void load();
  };

  const doPrune = async (target: DockerPruneTarget, all: boolean) => {
    if (await prune(connId, target, all)) afterChange(target === "build" ? "images" : target);
  };

  const open = (c: DockerContainer) => {
    useStore.getState().openTable(connId, "containers", c.name, "data", `container-${c.state}`);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-app w-[900px] max-w-[95vw] max-h-[85vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl ${shellClass}`} onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Container} size={14} className="text-sky-400" />
          <span className="font-medium text-sm">{t("總覽")} · {connName}</span>
          {info && <span className="text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/60">Docker {info.server_version} · API {info.api_version}</span>}
          <div className="ml-auto flex items-center gap-1">
            {!readonly && <Button size="sm" icon={Download} onClick={onPull}>{t("拉取映像…")}</Button>}
            <IconButton icon={RefreshCw} label={t("重新整理")} onClick={() => void load()} className={loading ? "animate-spin" : ""} />
            <ModalViewControls />
            <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="text-fg/40 hover:text-fg" />
          </div>
        </div>

        <ErrorLine text={err} />

        <div className="flex-1 min-h-0 overflow-auto p-4 text-xs space-y-4">
          {info && (
            <>
              <div className="grid grid-cols-5 gap-2">
                <StatTile label={t("容器")} value={info.containers} />
                <StatTile label={t("執行中")} value={info.running} tone={info.running ? "ok" : "dim"} />
                <StatTile label={t("已暫停")} value={info.paused} tone={info.paused ? "warn" : "dim"} />
                <StatTile label={t("已停止")} value={info.stopped} tone="dim" />
                <StatTile label={t("映像")} value={info.images} />
              </div>

              {df && (
                <div className="grid grid-cols-4 gap-2">
                  <StatTile label={t("映像")} value={fmtBytes(df.images_size)} sub={t("可回收 {size}", { size: fmtBytes(df.images_reclaimable) })} />
                  <StatTile label={t("容器寫入層")} value={fmtBytes(df.containers_size)} sub={t("{n} 個容器", { n: df.containers_count })} />
                  <StatTile label="Volume" value={fmtBytes(df.volumes_size)} sub={t("可回收 {size}", { size: fmtBytes(df.volumes_reclaimable) })} />
                  <StatTile label={t("建置快取")} value={fmtBytes(df.build_cache_size)} sub={t("{n} 筆", { n: df.build_cache_count })} />
                </div>
              )}

              {!readonly && (
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-fg/40 self-center mr-1">{t("清理")}：</span>
                  {([["containers", false], ["images", false], ["images", true], ["volumes", false], ["networks", false], ["build", false]] as [DockerPruneTarget, boolean][]).map(([tg, all]) => (
                    <Button key={`${tg}:${all}`} size="sm" variant="ghost" onClick={() => void doPrune(tg, all)}>{pruneLabel(tg, all)}</Button>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                {groupByCompose(containers).map((g) => (
                  <div key={g.project || "_"} className="rounded border border-fg/10">
                    <div className="px-3 py-1.5 border-b border-fg/10 text-fg/50 flex items-center gap-2">
                      <span className="font-medium text-fg/70">{g.project || t("未分組")}</span>
                      {g.project && <span className="text-[10px]">compose</span>}
                      <span className="ml-auto">{t("{n} 個容器", { n: g.items.length })}</span>
                    </div>
                    <table className="w-full">
                      <tbody>
                        {g.items.map((c) => (
                          <tr key={c.id} className="border-b border-fg/5 last:border-b-0 hover:bg-fg/[0.03]">
                            <td className="px-3 py-1.5 w-[28%]">
                              <button type="button" className="text-left hover:underline truncate max-w-full mono" onClick={() => open(c)}>{c.name}</button>
                            </td>
                            <td className="px-2 py-1.5 w-[12%]"><Badge tone={containerStateTone(c.state)} dot>{c.state}</Badge></td>
                            <td className="px-2 py-1.5 mono text-fg/55 truncate max-w-0 w-[30%]" title={c.image}>{c.image}</td>
                            <td className="px-2 py-1.5 mono text-fg/55 truncate max-w-0" title={c.ports.map(portLabel).join(", ")}>
                              {c.ports.filter((p) => p.public_port != null).map(portLabel).join(", ")}
                            </td>
                            <td className="px-2 py-1.5 w-16 text-right">
                              {!readonly && (c.state === "running"
                                ? <IconButton icon={Square} label={t("停止")} onClick={async () => { if (await runContainerAction(connId, c.name, "stop")) afterChange("containers"); }} />
                                : <IconButton icon={Play} label={t("啟動")} onClick={async () => { if (await runContainerAction(connId, c.name, "start")) afterChange("containers"); }} />)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              <div className="border-t border-fg/10 pt-2 text-fg/35 mono space-y-0.5">
                <div>endpoint: {info.endpoint}</div>
                <div>{info.name} · {info.os} ({info.os_type}/{info.arch}) · kernel {info.kernel}</div>
                <div>CPU {info.ncpu} · {t("記憶體")} {fmtBytes(info.mem_total)} · storage {info.driver} · {info.root_dir}</div>
                {info.warnings.map((w, i) => <div key={i} className="text-warning">{w}</div>)}
              </div>
            </>
          )}
          {!info && !err && <div className="text-fg/30">{t("載入中…")}</div>}
        </div>
      </div>
    </div>
  );
}
