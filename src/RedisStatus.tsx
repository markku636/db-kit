import { useEffect, useMemo, useState } from "react";
import { CircleDot, RefreshCw } from "lucide-react";
import { api, ServerInfoSection } from "./api";
import Icon from "./ui/Icon";
import { Modal } from "./ui/index";
import { useT } from "./i18n";

// Redis 伺服器狀態面板：仿 Another Redis Desktop Manager 的 Status 分頁。
// 上方為重點指標卡片，下方為 INFO 全分區明細；可開關自動刷新（預設每 2 秒）。
export default function RedisStatus({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
  const t = useT();
  const [sections, setSections] = useState<ServerInfoSection[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    api
      .serverInfo(connId)
      .then((s) => {
        if (cancelled) return;
        setSections(s);
        setErr(null);
        setUpdatedAt(new Date().toLocaleTimeString());
      })
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    return () => { cancelled = true; };
  }, [connId, nonce]);

  // 自動刷新。
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setNonce((n) => n + 1), 2000);
    return () => clearInterval(timer);
  }, [auto]);

  // 攤平成 key→value 方便查指標。
  const flat = useMemo(() => {
    const m: Record<string, string> = {};
    sections?.forEach((sec) => sec.items.forEach(([k, v]) => { m[k] = v; }));
    return m;
  }, [sections]);

  const totalKeys = useMemo(() => {
    const ks = sections?.find((s) => s.name.toLowerCase() === "keyspace");
    if (!ks) return 0;
    let sum = 0;
    ks.items.forEach(([, v]) => {
      const m = /keys=(\d+)/.exec(v);
      if (m) sum += Number(m[1]);
    });
    return sum;
  }, [sections]);

  const hitRate = useMemo(() => {
    const hits = Number(flat["keyspace_hits"] ?? 0);
    const misses = Number(flat["keyspace_misses"] ?? 0);
    const total = hits + misses;
    return total > 0 ? `${((hits / total) * 100).toFixed(1)}%` : "—";
  }, [flat]);

  const metrics: { label: string; value: string; sub?: string }[] = [
    { label: t("版本"), value: flat["redis_version"] ?? "—", sub: flat["redis_mode"] },
    { label: t("執行時間"), value: fmtUptime(flat["uptime_in_seconds"]) },
    { label: t("連線數"), value: flat["connected_clients"] ?? "—", sub: flat["blocked_clients"] ? t("阻塞 {flat}", { flat: flat["blocked_clients"] }) : undefined },
    { label: t("記憶體"), value: flat["used_memory_human"] ?? "—", sub: flat["used_memory_peak_human"] ? t("峰值 {flat}", { flat: flat["used_memory_peak_human"] }) : undefined },
    { label: t("ops/秒"), value: flat["instantaneous_ops_per_sec"] ?? "—" },
    { label: t("命中率"), value: hitRate, sub: `H ${flat["keyspace_hits"] ?? 0} / M ${flat["keyspace_misses"] ?? 0}` },
    { label: t("總鍵數"), value: String(totalKeys) },
    { label: t("已處理命令"), value: fmtNum(flat["total_commands_processed"]) },
  ];

  return (
    <Modal
      onClose={onClose}
      icon={CircleDot}
      title={(
        <span className="flex items-center gap-3">
          <span>{t("伺服器狀態 ·")} {connName}</span>
          <label className="ml-auto text-xs text-fg/50 flex items-center gap-1.5 cursor-pointer font-normal">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            {t("自動刷新")}
          </label>
          <button type="button" onClick={() => setNonce((n) => n + 1)} title={t("立即刷新")}
            className="text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 inline-flex items-center gap-1 font-normal">
            <Icon icon={RefreshCw} size={14} /> {t("刷新")}
          </button>
        </span>
      )}
      size="lg"
      zClass="z-50"
      className="!w-[760px] max-w-[94vw] max-h-[86vh]"
      bodyClassName="p-4 overflow-auto"
      footer={updatedAt ? (
        <div className="mr-auto text-[11px] text-fg/35">{t("最後更新：")}{updatedAt}</div>
      ) : undefined}
    >
      {err && <div className="text-red-400 text-sm mono mb-3 break-all">{err}</div>}
      {!sections && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}

      {sections && (
        <>
          {/* 重點指標卡片 */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            {metrics.map((m) => (
              <div key={m.label} className="bg-inset border border-fg/10 rounded p-2.5">
                <div className="text-[11px] text-fg/40">{m.label}</div>
                <div className="text-lg font-semibold mono truncate" title={m.value}>{m.value}</div>
                {m.sub && <div className="text-[10px] text-fg/35 truncate" title={m.sub}>{m.sub}</div>}
              </div>
            ))}
          </div>

          {/* INFO 全分區明細 */}
          <div className="grid grid-cols-2 gap-3">
            {sections.map((sec) => (
              <div key={sec.name} className="bg-inset border border-fg/10 rounded overflow-hidden">
                <div className="px-3 py-1.5 bg-fg/5 text-xs font-medium text-fg/70 border-b border-fg/10">
                  {sec.name}
                </div>
                <table className="text-xs mono w-full">
                  <tbody>
                    {sec.items.map(([k, v], i) => (
                      <tr key={i} className="hover:bg-fg/5">
                        <td className="px-3 py-0.5 text-fg/45 align-top whitespace-nowrap">{k}</td>
                        <td className="px-3 py-0.5 text-fg/80 break-all">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function fmtUptime(secsStr?: string): string {
  const secs = Number(secsStr);
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtNum(s?: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s ?? "—";
  return n.toLocaleString();
}
