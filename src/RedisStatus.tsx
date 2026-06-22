import { useEffect, useMemo, useState } from "react";
import { api, ServerInfoSection } from "./api";

// Redis 伺服器狀態面板：仿 Another Redis Desktop Manager 的 Status 分頁。
// 上方為重點指標卡片，下方為 INFO 全分區明細；可開關自動刷新（預設每 2 秒）。
export default function RedisStatus({ connId, connName, onClose }: {
  connId: string; connName: string; onClose: () => void;
}) {
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
      .catch((e) => !cancelled && setErr(e?.message ?? "讀取失敗"));
    return () => { cancelled = true; };
  }, [connId, nonce]);

  // 自動刷新。
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => setNonce((n) => n + 1), 2000);
    return () => clearInterval(t);
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
    { label: "版本", value: flat["redis_version"] ?? "—", sub: flat["redis_mode"] },
    { label: "執行時間", value: fmtUptime(flat["uptime_in_seconds"]) },
    { label: "連線數", value: flat["connected_clients"] ?? "—", sub: flat["blocked_clients"] ? `阻塞 ${flat["blocked_clients"]}` : undefined },
    { label: "記憶體", value: flat["used_memory_human"] ?? "—", sub: flat["used_memory_peak_human"] ? `峰值 ${flat["used_memory_peak_human"]}` : undefined },
    { label: "ops/秒", value: flat["instantaneous_ops_per_sec"] ?? "—" },
    { label: "命中率", value: hitRate, sub: `H ${flat["keyspace_hits"] ?? 0} / M ${flat["keyspace_misses"] ?? 0}` },
    { label: "總鍵數", value: String(totalKeys) },
    { label: "已處理命令", value: fmtNum(flat["total_commands_processed"]) },
  ];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1a212b] w-[760px] max-w-[94vw] max-h-[86vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-3">
          <span className="text-red-400">●</span>
          <span className="font-medium text-sm">伺服器狀態 · {connName}</span>
          <label className="ml-auto text-xs text-white/50 flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            自動刷新
          </label>
          <button type="button" onClick={() => setNonce((n) => n + 1)} title="立即刷新"
            className="text-xs px-2 py-1 rounded border border-white/15 hover:bg-white/10 text-white/70">
            ↻ 刷新
          </button>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>

        <div className="p-4 overflow-auto">
          {err && <div className="text-red-400 text-sm mono mb-3 break-all">{err}</div>}
          {!sections && !err && <div className="text-white/40 text-sm">讀取中…</div>}

          {sections && (
            <>
              {/* 重點指標卡片 */}
              <div className="grid grid-cols-4 gap-2 mb-4">
                {metrics.map((m) => (
                  <div key={m.label} className="bg-black/30 border border-white/10 rounded p-2.5">
                    <div className="text-[11px] text-white/40">{m.label}</div>
                    <div className="text-lg font-semibold mono truncate" title={m.value}>{m.value}</div>
                    {m.sub && <div className="text-[10px] text-white/35 truncate" title={m.sub}>{m.sub}</div>}
                  </div>
                ))}
              </div>

              {/* INFO 全分區明細 */}
              <div className="grid grid-cols-2 gap-3">
                {sections.map((sec) => (
                  <div key={sec.name} className="bg-black/20 border border-white/10 rounded overflow-hidden">
                    <div className="px-3 py-1.5 bg-white/5 text-xs font-medium text-white/70 border-b border-white/10">
                      {sec.name}
                    </div>
                    <table className="text-xs mono w-full">
                      <tbody>
                        {sec.items.map(([k, v], i) => (
                          <tr key={i} className="hover:bg-white/5">
                            <td className="px-3 py-0.5 text-white/45 align-top whitespace-nowrap">{k}</td>
                            <td className="px-3 py-0.5 text-white/80 break-all">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {updatedAt && (
          <div className="px-5 py-2 border-t border-white/10 text-[11px] text-white/35">
            最後更新：{updatedAt}
          </div>
        )}
      </div>
    </div>
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
