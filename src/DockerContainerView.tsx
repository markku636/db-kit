// 容器分頁：上方動作列（啟停 / 刪除 / 建資料庫連線），下方子頁（資訊 / Log / Shell / 資源 / 行程）。
// Log 與 Shell 切走時不卸載（xterm buffer 與 exec 串流都保留），資訊 / 資源在切回來時才重抓。
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, DatabaseZap, FileText, Info, ListTree, Pause, Pencil, Play, RefreshCw, RotateCcw, Skull, Square, SquareTerminal, Trash2,
} from "lucide-react";
import { api, type ConnectionConfig } from "./api";
import type { DockerContainerDetail, DockerStats, DockerTop } from "./dockerTypes";
import { containerStateTone, fmtBytes, fmtIso, portLabel } from "./dockerModel";
import { looksLikeDbImage } from "./dockerDbGuess";
import {
  createDbConnectionFromContainer, removeContainer, renameContainer, runContainerAction,
} from "./dockerActions";
import { EnvTable, ErrorLine, InfoRow, InfoSection, JsonBlock, MiniTable, StatTile } from "./dockerUi";
import DockerLogView from "./DockerLogView";
import DockerExecView from "./DockerExecView";
import { Badge, Button, EmptyState, Segmented, Spinner } from "./ui/index";
import TimeSeriesChart, { type TsPoint } from "./ui/TimeSeriesChart";
import { useStore } from "./store";
import { useContainerSub } from "./dockerMenus";
import { useT } from "./i18n";

type Sub = "info" | "logs" | "shell" | "stats" | "top";

export default function DockerContainerView({ conn, name, onChanged }: {
  conn: ConnectionConfig;
  name: string;
  /** 狀態 / 名稱 / 存在與否改變後通知（重新整理側欄）。 */
  onChanged: () => void;
}) {
  const t = useT();
  const readonly = useStore((s) => s.readonlyConns[conn.id] === true);
  const [sub, setSub] = useState<Sub>("info");
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  // 已經打開過的子頁才掛載（Log / Shell 開過之後常駐，切走不斷線）。
  const [mounted, setMounted] = useState<Set<Sub>>(() => new Set(["info"]));
  // 側欄右鍵「Log…」「Shell…」：開分頁後切到指定子頁（一次性請求）。
  const subKey = `${conn.id}:${name}`;
  const subReq = useContainerSub((s) => s.req[subKey]);
  useEffect(() => {
    if (!subReq) return;
    setSub(subReq.sub);
    useContainerSub.getState().consume(subKey);
  }, [subReq, subKey]);

  const load = useCallback(async () => {
    try {
      const d = await api.dockerContainerInspect(conn.id, name);
      setDetail(d);
      setErr(null);
      setGone(false);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (/404|no such container/i.test(msg)) setGone(true);
      setErr(msg);
    }
  }, [conn.id, name]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    setMounted((m) => (m.has(sub) ? m : new Set(m).add(sub)));
    if (sub === "info") void load();
  }, [sub, load]);

  const act = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (await fn()) {
        onChanged();
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (gone) {
    return (
      <EmptyState
        icon={Trash2}
        title={t("容器「{name}」已不存在", { name })}
        hint={t("可能已被刪除或改名；請重新整理連線樹。")}
        action={<Button icon={RefreshCw} onClick={() => { onChanged(); void load(); }}>{t("重新整理")}</Button>}
      />
    );
  }

  const running = !!detail?.running && !detail.paused;
  const paused = !!detail?.paused;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-fg/10 bg-bar flex-wrap">
        {detail && (
          <Badge tone={containerStateTone(detail.paused ? "paused" : detail.state)} dot>
            {detail.paused ? "paused" : detail.state}
          </Badge>
        )}
        {detail?.health && <Badge tone={detail.health === "healthy" ? "success" : detail.health === "unhealthy" ? "danger" : "warning"}>{detail.health}</Badge>}
        <span className="text-xs text-fg/45 mono truncate max-w-[40%]" title={detail?.image}>{detail?.image}</span>
        {!readonly && detail && (
          <div className="flex items-center gap-1">
            {!running && !paused && (
              <Button size="sm" icon={Play} disabled={busy} onClick={() => act(() => runContainerAction(conn.id, name, "start"))}>{t("啟動")}</Button>
            )}
            {running && (
              <Button size="sm" icon={Square} disabled={busy} onClick={() => act(() => runContainerAction(conn.id, name, "stop"))}>{t("停止")}</Button>
            )}
            {(running || paused) && (
              <Button size="sm" icon={RotateCcw} disabled={busy} onClick={() => act(() => runContainerAction(conn.id, name, "restart"))}>{t("重新啟動")}</Button>
            )}
            {running && (
              <Button size="sm" variant="ghost" icon={Pause} disabled={busy} onClick={() => act(() => runContainerAction(conn.id, name, "pause"))}>{t("暫停")}</Button>
            )}
            {paused && (
              <Button size="sm" icon={Play} disabled={busy} onClick={() => act(() => runContainerAction(conn.id, name, "unpause"))}>{t("繼續")}</Button>
            )}
            {(running || paused) && (
              <Button size="sm" variant="ghost" icon={Skull} disabled={busy} onClick={() => act(() => runContainerAction(conn.id, name, "kill"))}>{t("強制終止")}</Button>
            )}
          </div>
        )}
        <div className="ml-auto flex items-center gap-1">
          {detail && looksLikeDbImage(detail.image) && (
            <Button size="sm" variant="ghost" icon={DatabaseZap} onClick={() => void createDbConnectionFromContainer(conn, name)}>
              {t("建立資料庫連線")}
            </Button>
          )}
          {!readonly && detail && (
            <>
              <Button size="sm" variant="ghost" icon={Pencil} disabled={busy}
                onClick={() => act(async () => {
                  const next = await renameContainer(conn.id, name);
                  // 改名後這個分頁的 name 已失效：交給側欄重新整理，分頁顯示「已不存在」引導重開。
                  return next !== null;
                })}>
                {t("重新命名")}
              </Button>
              <Button size="sm" variant="danger" icon={Trash2} disabled={busy}
                onClick={() => act(() => removeContainer(conn.id, name, running || paused))}>
                {t("刪除")}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="px-2 py-1 border-b border-fg/10">
        <Segmented
          value={sub}
          onChange={setSub}
          ariaLabel={t("容器檢視")}
          options={[
            { value: "info", label: t("資訊"), icon: Info },
            { value: "logs", label: "Log", icon: FileText },
            { value: "shell", label: "Shell", icon: SquareTerminal },
            { value: "stats", label: t("資源"), icon: Activity },
            { value: "top", label: t("行程"), icon: ListTree },
          ]}
        />
      </div>

      <ErrorLine text={gone ? null : err} />

      <div className={`flex-1 min-h-0 overflow-auto p-3 space-y-4 ${sub === "info" ? "" : "hidden"}`}>
        {detail ? <ContainerInfo d={detail} /> : !err && <div className="flex justify-center p-6"><Spinner /></div>}
      </div>
      {mounted.has("logs") && (
        <div className={`flex-1 min-h-0 flex flex-col ${sub === "logs" ? "" : "hidden"}`}>
          <DockerLogView connId={conn.id} container={name} />
        </div>
      )}
      {mounted.has("shell") && (
        <div className={`flex-1 min-h-0 flex flex-col ${sub === "shell" ? "" : "hidden"}`}>
          {readonly
            ? <EmptyState icon={SquareTerminal} title={t("唯讀連線不開放容器 shell")} hint={t("在連線設定取消「唯讀連線」後即可使用。")} />
            : <DockerExecView connId={conn.id} container={name} running={running} />}
        </div>
      )}
      {sub === "stats" && <StatsPane connId={conn.id} name={name} running={running} />}
      {sub === "top" && <TopPane connId={conn.id} name={name} running={running} />}
    </div>
  );
}

function ContainerInfo({ d }: { d: DockerContainerDetail }) {
  const t = useT();
  const cmd = [...d.entrypoint, ...d.cmd].join(" ");
  return (
    <>
      <InfoSection title={t("概要")}>
        <InfoRow label={t("名稱")} mono>{d.name}</InfoRow>
        <InfoRow label="ID" mono>{d.id.slice(0, 12)}</InfoRow>
        <InfoRow label={t("映像")} mono>{d.image}</InfoRow>
        <InfoRow label={t("指令")} mono>{cmd || "—"}</InfoRow>
        <InfoRow label={t("建立時間")}>{fmtIso(d.created)}</InfoRow>
        <InfoRow label={t("啟動時間")}>{fmtIso(d.started_at) || "—"}</InfoRow>
        {!d.running && <InfoRow label={t("結束時間")}>{fmtIso(d.finished_at) || "—"}</InfoRow>}
        {!d.running && <InfoRow label={t("結束碼")}>{d.exit_code}{d.oom_killed ? " (OOM killed)" : ""}</InfoRow>}
        {d.error && <InfoRow label={t("錯誤")}><span className="text-danger">{d.error}</span></InfoRow>}
        <InfoRow label={t("重啟策略")}>{d.restart_policy || "no"}{d.restart_count ? t("（已重啟 {n} 次）", { n: d.restart_count }) : ""}</InfoRow>
        {d.working_dir && <InfoRow label={t("工作目錄")} mono>{d.working_dir}</InfoRow>}
        {d.user && <InfoRow label={t("使用者")} mono>{d.user}</InfoRow>}
        {d.hostname && <InfoRow label={t("主機名")} mono>{d.hostname}</InfoRow>}
      </InfoSection>

      <InfoSection title={t("埠映射")}>
        <MiniTable
          head={[t("容器埠"), t("主機")]}
          rows={d.ports.map((p) => [
            <span className="mono">{p.private_port}/{p.proto}</span>,
            <span className="mono">{p.public_port != null ? portLabel(p).split(" → ")[0] : t("未發布")}</span>,
          ])}
          empty={t("沒有對外發布的埠")}
        />
      </InfoSection>

      <InfoSection title={t("網路（{mode}）", { mode: d.network_mode || "default" })}>
        <MiniTable
          head={[t("網路"), "IP", t("閘道"), t("別名")]}
          rows={d.networks.map((n) => [
            n.name, <span className="mono">{n.ip}</span>, <span className="mono">{n.gateway}</span>,
            <span className="mono text-fg/60">{n.aliases.join(", ")}</span>,
          ])}
        />
      </InfoSection>

      <InfoSection title={t("掛載")}>
        <MiniTable
          head={[t("類型"), t("來源"), t("容器路徑"), t("模式")]}
          rows={d.mounts.map((m) => [
            m.kind,
            <span className="mono">{m.name || m.source}</span>,
            <span className="mono">{m.destination}</span>,
            m.rw ? "rw" : "ro",
          ])}
        />
      </InfoSection>

      <EnvTable env={d.env} />

      {d.health_log.length > 0 && (
        <InfoSection title={t("健康檢查（最近 {n} 次）", { n: d.health_log.length })}>
          <MiniTable
            head={[t("時間"), t("結束碼"), t("輸出")]}
            rows={d.health_log.map((h) => [fmtIso(h.start), h.exit_code, <span className="mono whitespace-pre-wrap">{h.output.trim()}</span>])}
          />
        </InfoSection>
      )}

      {Object.keys(d.labels).length > 0 && (
        <InfoSection title={t("標籤（{n}）", { n: Object.keys(d.labels).length })}>
          <MiniTable head={[t("鍵"), t("值")]} rows={Object.entries(d.labels).map(([k, v]) => [<span className="mono text-fg/70">{k}</span>, <span className="mono">{v}</span>])} />
        </InfoSection>
      )}

      <JsonBlock title="inspect JSON" json={d.raw} />
    </>
  );
}

const HISTORY = 60;

function StatsPane({ connId, name, running }: { connId: string; name: string; running: boolean }) {
  const t = useT();
  const [cur, setCur] = useState<DockerStats | null>(null);
  const [cpu, setCpu] = useState<TsPoint[]>([]);
  const [mem, setMem] = useState<TsPoint[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (!running) return;
    let timer: number | undefined;
    // 一次一個請求（stream=false 本身會花 ~1 秒取兩個樣本），回來後隔 1 秒再抓下一筆。
    const tick = async () => {
      try {
        const s = await api.dockerContainerStats(connId, name);
        if (!alive.current) return;
        setCur(s);
        setErr(null);
        const now = Date.now();
        setCpu((a) => [...a, { t: now, v: s.cpu_percent }].slice(-HISTORY));
        setMem((a) => [...a, { t: now, v: s.mem_usage }].slice(-HISTORY));
      } catch (e: any) {
        if (alive.current) setErr(e?.message ?? String(e));
      }
      if (alive.current) timer = window.setTimeout(tick, 1000);
    };
    void tick();
    return () => { alive.current = false; window.clearTimeout(timer); };
  }, [connId, name, running]);

  if (!running) return <EmptyState icon={Activity} title={t("容器未在執行")} hint={t("啟動後才有 CPU / 記憶體用量。")} />;
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
      <ErrorLine text={err} />
      {!cur ? <div className="flex justify-center p-6"><Spinner /></div> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <StatTile label="CPU" value={`${cur.cpu_percent.toFixed(1)}%`} sub={t("{n} 核", { n: cur.online_cpus })} tone={cur.cpu_percent > 80 * cur.online_cpus ? "warn" : undefined} />
            <StatTile label={t("記憶體")} value={fmtBytes(cur.mem_usage)} sub={`${cur.mem_percent.toFixed(1)}% / ${fmtBytes(cur.mem_limit)}`} tone={cur.mem_percent > 90 ? "warn" : undefined} />
            <StatTile label={t("網路 收 / 送")} value={`${fmtBytes(cur.net_rx)} / ${fmtBytes(cur.net_tx)}`} />
            <StatTile label={t("磁碟 讀 / 寫")} value={`${fmtBytes(cur.blk_read)} / ${fmtBytes(cur.blk_write)}`} sub={t("{n} 個行程", { n: cur.pids })} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 text-accent">
            <TimeSeriesChart label="CPU %" points={cpu} height={110} formatValue={(v) => `${v.toFixed(1)}%`} />
            <TimeSeriesChart label={t("記憶體")} points={mem} height={110} formatValue={fmtBytes} />
          </div>
        </>
      )}
    </div>
  );
}

function TopPane({ connId, name, running }: { connId: string; name: string; running: boolean }) {
  const t = useT();
  const [top, setTop] = useState<DockerTop | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTop(await api.dockerContainerTop(connId, name));
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [connId, name]);
  useEffect(() => { if (running) void load(); }, [running, load]);
  if (!running) return <EmptyState icon={ListTree} title={t("容器未在執行")} />;
  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
      <div className="flex">
        <Button size="sm" icon={RefreshCw} loading={loading} onClick={() => void load()}>{t("重新整理")}</Button>
      </div>
      <ErrorLine text={err} />
      {top && (
        <InfoSection title={t("行程（{n}）", { n: top.processes.length })}>
          <MiniTable head={top.titles} rows={top.processes.map((r) => r.map((c) => <span className="mono">{c}</span>))} />
        </InfoSection>
      )}
    </div>
  );
}
