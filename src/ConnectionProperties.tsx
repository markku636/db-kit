import { useCallback, useEffect, useRef, useState } from "react";
import { api, ConnectionConfig, KIND_META, PoolStatus } from "./api";
import { Modal, Button } from "./ui/index";
import { useT } from "./i18n";

// 連線（伺服器）屬性：唯讀檢視連線設定 + 即時連線池狀態 / 延遲。
export default function ConnectionProperties({ conn, connected, onClose }: {
  conn: ConnectionConfig;
  connected: boolean;
  onClose: () => void;
}) {
  const t = useT();
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
    ? [[t("檔案路徑"), conn.host || "—"]]
    : [
        [t("主機"), `${conn.host}:${conn.port}`],
        [t("使用者"), conn.username || "—"],
      ];
  connRows.unshift([t("類型"), meta?.label ?? conn.kind]);
  connRows.push([t("預設資料庫"), conn.database || "—"]);
  if (!meta?.fileBased) connRows.push([t("連線池上限"), String(conn.max_connections ?? "—")]);

  const sshRows: [string, string][] = conn.ssh_enabled
    ? [
        [t("SSH 主機"), `${conn.ssh_host ?? "—"}:${conn.ssh_port ?? 22}`],
        [t("SSH 使用者"), conn.ssh_username || "—"],
        [t("SSH 驗證"), conn.ssh_auth_method === "key" ? t("金鑰") : t("密碼")],
      ]
    : [];

  return (
    <Modal
      onClose={onClose}
      size="md"
      zClass="z-[95]"
      className="!w-[460px]"
      bodyClassName="p-5 space-y-4 overflow-auto text-sm"
      title={
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta?.color ?? "#888" }} />
          <span className="font-medium text-sm truncate">{conn.name}</span>
          <span className={`ml-1 text-xs px-1.5 py-0.5 rounded shrink-0 ${connected ? "bg-green-500/15 text-green-400" : "bg-fg/10 text-fg/40"}`}>
            {connected ? t("已連線") : t("未連線")}
          </span>
        </div>
      }
      footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}
    >
      <Section title={t("連線")}>
        {connRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
      </Section>

      {sshRows.length > 0 && (
        <Section title={t("SSH 通道")}>
          {sshRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        </Section>
      )}

      <Section title={t("即時狀態")} action={connected ? (
        <button type="button" onClick={() => void refresh()} disabled={busy}
          className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? t("更新中…") : t("重新整理")}</button>
      ) : undefined}>
        {!connected ? (
          <div className="text-fg/40 text-xs py-1">{t("未連線，無即時狀態。")}</div>
        ) : (
          <>
            <Row k={t("連線延遲")} v={ping == null ? "—" : `${ping} ms`} />
            {!meta?.fileBased && (
              <Row k={t("連線池（使用 / 閒置 / 總計）")}
                v={pool ? `${pool.in_use} / ${pool.idle} / ${pool.size}` : "—"} />
            )}
          </>
        )}
      </Section>
    </Modal>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center mb-1.5">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{title}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="rounded border border-fg/10 divide-y divide-fg/5">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex px-3 py-1.5 gap-3">
      <span className="text-fg/45 w-40 shrink-0">{k}</span>
      <span className="text-fg/85 mono break-all">{v}</span>
    </div>
  );
}
