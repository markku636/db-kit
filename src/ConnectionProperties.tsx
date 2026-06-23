import { useCallback, useEffect, useRef, useState } from "react";
import { api, ConnectionConfig, KIND_META, PoolStatus } from "./api";

// 連線（伺服器）屬性：唯讀檢視連線設定 + 即時連線池狀態 / 延遲。
export default function ConnectionProperties({ conn, connected, onClose }: {
  conn: ConnectionConfig;
  connected: boolean;
  onClose: () => void;
}) {
  const meta = KIND_META[conn.kind];
  const [pool, setPool] = useState<PoolStatus | null>(null);
  const [ping, setPing] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!connected) return;
    setBusy(true);
    const [p, pg] = await Promise.all([
      api.poolStatus(conn.id).catch(() => null),
      api.pingConnection(conn.id).catch(() => null),
    ]);
    if (!aliveRef.current) return; // 對話框已關閉 / 卸載，避免 setState
    setPool(p);
    setPing(pg);
    setBusy(false);
  }, [conn.id, connected]);

  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    return () => { aliveRef.current = false; };
  }, [refresh]);

  const connRows: [string, string][] = meta?.fileBased
    ? [["檔案路徑", conn.host || "—"]]
    : [
        ["主機", `${conn.host}:${conn.port}`],
        ["使用者", conn.username || "—"],
      ];
  connRows.unshift(["類型", meta?.label ?? conn.kind]);
  connRows.push(["預設資料庫", conn.database || "—"]);
  if (!meta?.fileBased) connRows.push(["連線池上限", String(conn.max_connections ?? "—")]);

  const sshRows: [string, string][] = conn.ssh_enabled
    ? [
        ["SSH 主機", `${conn.ssh_host ?? "—"}:${conn.ssh_port ?? 22}`],
        ["SSH 使用者", conn.ssh_username || "—"],
        ["SSH 驗證", conn.ssh_auth_method === "key" ? "金鑰" : "密碼"],
      ]
    : [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[460px] max-w-[92vw] max-h-[88vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: meta?.color ?? "#888" }} />
          <span className="font-medium text-sm truncate">{conn.name}</span>
          <span className={`ml-1 text-xs px-1.5 py-0.5 rounded ${connected ? "bg-green-500/15 text-green-400" : "bg-white/10 text-white/40"}`}>
            {connected ? "已連線" : "未連線"}
          </span>
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>

        <div className="p-5 space-y-4 overflow-auto text-sm">
          <Section title="連線">
            {connRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
          </Section>

          {sshRows.length > 0 && (
            <Section title="SSH 通道">
              {sshRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
            </Section>
          )}

          <Section title="即時狀態" action={connected ? (
            <button type="button" onClick={() => void refresh()} disabled={busy}
              className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? "更新中…" : "重新整理"}</button>
          ) : undefined}>
            {!connected ? (
              <div className="text-white/40 text-xs py-1">未連線，無即時狀態。</div>
            ) : (
              <>
                <Row k="連線延遲" v={ping == null ? "—" : `${ping} ms`} />
                {!meta?.fileBased && (
                  <Row k="連線池（使用 / 閒置 / 總計）"
                    v={pool ? `${pool.in_use} / ${pool.idle} / ${pool.size}` : "—"} />
                )}
              </>
            )}
          </Section>
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end">
          <button type="button" onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">關閉</button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center mb-1.5">
        <span className="text-xs text-white/45 uppercase tracking-wide">{title}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="rounded border border-white/10 divide-y divide-white/5">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex px-3 py-1.5 gap-3">
      <span className="text-white/45 w-40 shrink-0">{k}</span>
      <span className="text-white/85 mono break-all">{v}</span>
    </div>
  );
}
