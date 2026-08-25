import { useEffect, useState } from "react";
import { CircleDot, RefreshCw, X } from "lucide-react";
import { api, BigKey, ClientInfo, SlowLogEntry } from "./api";
import { copyToClipboard, toast, uiConfirm, useModalOverlay } from "./ui";
import { useStore } from "./store";
import { IconButton, ModalViewControls, useModalView } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

type Tab = "slowlog" | "clients" | "bigkeys";

// Redis 維運面板：慢查詢日誌 / 用戶端連線 / 大鍵掃描（對齊 Another Redis Desktop Manager 的狀態工具）。
export default function RedisOpsPanel({ connId, connName, database, onClose }: {
  connId: string; connName: string; database: string; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose); // Esc 關閉 + 計入 modalCount（避免全域快捷鍵在面板背後動作）
  const [tab, setTab] = useState<Tab>("slowlog");

  const { shellClass } = useModalView();

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-elevated w-[860px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl ${shellClass}`}
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={CircleDot} size={14} className="text-red-400" />
          <span className="font-medium text-sm">{t("維運 ·")} {connName}</span>
          <div className="flex items-center rounded border border-fg/10 overflow-hidden ml-2 text-xs">
            {([["slowlog", t("慢查詢")], ["clients", t("用戶端")], ["bigkeys", t("大鍵")]] as [Tab, string][]).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setTab(v)}
                className={`px-3 py-1 ${tab === v ? "bg-fg/15 text-fg" : "text-fg/50 hover:bg-fg/5"}`}>
                {label}
              </button>
            ))}
          </div>
          <ModalViewControls className="ml-auto" />
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="text-fg/40 hover:text-fg" />
        </div>
        <div className="flex-1 overflow-auto p-4">
          {tab === "slowlog" && <SlowLogTab connId={connId} />}
          {tab === "clients" && <ClientsTab connId={connId} />}
          {tab === "bigkeys" && <BigKeysTab connId={connId} database={database} />}
        </div>
      </div>
    </div>
  );
}

function ErrBar({ err }: { err: string | null }) {
  if (!err) return null;
  return <div className="text-red-400 text-xs mono mb-2 break-all">{err}</div>;
}

function SlowLogTab({ connId }: { connId: string }) {
  const t = useT();
  const [rows, setRows] = useState<SlowLogEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.redisSlowlog(connId, 128)
      .then((r) => !cancelled && (setRows(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    return () => { cancelled = true; };
  }, [connId, nonce]);

  const reset = async () => {
    if (!(await uiConfirm(t("清空慢查詢日誌（SLOWLOG RESET）？"), { title: t("清空慢查詢"), confirmText: t("清空") }))) return;
    try {
      await api.runQuery(connId, "SLOWLOG RESET");
      toast.success(t("已清空"));
      setNonce((n) => n + 1);
    } catch (e: any) {
      setErr(e?.message ?? t("清空失敗"));
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-fg/40">{t("最近 {count} 筆慢查詢", { count: rows?.length ?? 0 })}</span>
        <button type="button" onClick={() => setNonce((n) => n + 1)}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70"><Icon icon={RefreshCw} size={13} /> {t("刷新")}</button>
        <button type="button" onClick={reset}
          className="px-2 py-1 rounded border border-fg/15 hover:bg-red-500/20 text-red-300">{t("清空")}</button>
      </div>
      <ErrBar err={err} />
      {!rows && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}
      {rows && rows.length === 0 && <div className="text-fg/40 text-sm">{t("（無慢查詢紀錄）")}</div>}
      {rows && rows.length > 0 && (
        <table className="text-xs mono w-full border-collapse">
          <thead><tr className="text-fg/45">
            <th className="text-left px-2 py-1 border-b border-fg/10">#</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("時間")}</th>
            <th className="text-right px-2 py-1 border-b border-fg/10">{t("耗時")}</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("命令")}</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("用戶端")}</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-fg/5">
                <td className="px-2 py-1 border-b border-fg/5 text-fg/40">{r.id}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/60 whitespace-nowrap">{fmtUnix(r.time)}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-right text-amber-300 whitespace-nowrap">{fmtDuration(r.duration_us)}</td>
                <td className="px-2 py-1 border-b border-fg/5 break-all text-fg/80">{r.command}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/50 whitespace-nowrap">{r.client}{r.client_name ? ` (${r.client_name})` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function ClientsTab({ connId }: { connId: string }) {
  const t = useT();
  const [rows, setRows] = useState<ClientInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.redisClients(connId)
      .then((r) => !cancelled && (setRows(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    return () => { cancelled = true; };
  }, [connId, nonce]);

  const kill = async (c: ClientInfo) => {
    if (!(await uiConfirm(t("中斷用戶端 {addr}（id={id}）？", { addr: c.addr, id: c.id }), { title: t("中斷用戶端"), danger: true, confirmText: t("中斷") }))) return;
    try {
      await api.redisClientKill(connId, c.id);
      toast.success(t("已中斷"));
      setNonce((n) => n + 1);
    } catch (e: any) {
      setErr(e?.message ?? t("中斷失敗"));
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-fg/40">{rows?.length ?? 0} {t("個用戶端連線")}</span>
        <button type="button" onClick={() => setNonce((n) => n + 1)}
          className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70"><Icon icon={RefreshCw} size={13} /> {t("刷新")}</button>
      </div>
      <ErrBar err={err} />
      {!rows && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}
      {rows && rows.length > 0 && (
        <table className="text-xs mono w-full border-collapse">
          <thead><tr className="text-fg/45">
            <th className="text-left px-2 py-1 border-b border-fg/10">id</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">addr</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">name</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">db</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">age</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">idle</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">cmd</th>
            <th className="w-12 border-b border-fg/10" />
          </tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="hover:bg-fg/5 group">
                <td className="px-2 py-1 border-b border-fg/5 text-fg/40">{c.id}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/80">{c.addr}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/60">{c.name || "—"}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/60">{c.db}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/60">{c.age}s</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/60">{c.idle}s</td>
                <td className="px-2 py-1 border-b border-fg/5 text-emerald-300/80">{c.cmd}</td>
                <td className="px-1 py-1 border-b border-fg/5 text-center">
                  <button type="button" onClick={() => kill(c)} title={t("中斷此用戶端")}
                    className="px-1.5 py-0.5 rounded text-fg/20 group-hover:text-red-400 hover:bg-red-500/20">{t("中斷")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function BigKeysTab({ connId, database }: { connId: string; database: string }) {
  const t = useT();
  // 唯讀連線：只掃描不清除（與資料格 / 鍵樹的唯讀規則一致）。
  const readonly = useStore((s) => s.readonlyConns[connId] === true);
  const [sample, setSample] = useState("1000");
  const [top, setTop] = useState("50");
  const [rows, setRows] = useState<BigKey[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // 勾選要清掉的大鍵；每次重新掃描即清空（避免對已不存在的鍵下 DEL）。
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const scan = async () => {
    setScanning(true);
    setErr(null);
    try {
      const r = await api.redisBigKeys(connId, database, Number(sample) || 1000, Number(top) || 50);
      setRows(r);
      setMarked(new Set());
    } catch (e: any) {
      setErr(e?.message ?? t("掃描失敗"));
    } finally {
      setScanning(false);
    }
  };

  const toggle = (key: string) =>
    setMarked((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  // 找到大鍵之後就地清掉（維運面板的重點在於「找出來能處理」，不必再回鍵樹逐一刪）。
  const removeKeys = async (keys: string[]) => {
    if (keys.length === 0 || deleting) return;
    const preview = keys.slice(0, 5).join("\n") + (keys.length > 5 ? t("\n…等 {n} 個鍵", { n: keys.length }) : "");
    if (!(await uiConfirm(
      t("將刪除 DB {database} 的 {n} 個鍵，此動作無法復原：\n{preview}", { database, n: keys.length, preview }),
      { title: t("刪除鍵"), danger: true, confirmText: t("刪除") },
    ))) return;
    setDeleting(true);
    try {
      const n = await api.redisDeleteKeys(connId, database, keys);
      toast.success(t("已刪除 {n} 個鍵", { n }));
      const gone = new Set(keys);
      setRows((r) => (r ? r.filter((b) => !gone.has(b.key)) : r));
      setMarked((s) => new Set([...s].filter((k) => !gone.has(k))));
    } catch (e: any) {
      const msg = e?.message ?? t("刪除失敗");
      setErr(msg);
      toast.error(msg);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-fg/40">DB {database} {t("· 取樣")}</span>
        <input value={sample} onChange={(e) => setSample(e.target.value.replace(/[^\d]/g, ""))}
          title={t("SCAN 取樣的鍵數上限")} className="w-20 bg-inset border border-fg/10 rounded px-2 py-1 mono text-center outline-none focus:border-accent" />
        <span className="text-fg/40">{t("取前")}</span>
        <input value={top} onChange={(e) => setTop(e.target.value.replace(/[^\d]/g, ""))}
          className="w-16 bg-inset border border-fg/10 rounded px-2 py-1 mono text-center outline-none focus:border-accent" />
        <button type="button" onClick={scan} disabled={scanning}
          className="ml-auto px-3 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">
          {scanning ? t("掃描中…") : t("掃描")}
        </button>
      </div>
      <div className="text-[11px] text-fg/35 mb-2">{t("取樣式掃描（非全量），以 MEMORY USAGE 估算記憶體用量；大型實例請斟酌取樣數。")}</div>
      {rows && rows.length > 0 && !readonly && (
        <div className="flex items-center gap-2 mb-2 text-xs">
          <span className="text-fg/40">{t("已勾選 {n}", { n: marked.size })}</span>
          <button type="button" onClick={() => removeKeys([...marked])} disabled={marked.size === 0 || deleting}
            title={t("刪除已勾選的鍵")}
            className="px-2 py-1 rounded border border-fg/15 hover:bg-red-500/20 text-red-300 disabled:opacity-30 disabled:hover:bg-transparent">
            {deleting ? t("刪除中…") : t("刪除選取")}
          </button>
        </div>
      )}
      <ErrBar err={err} />
      {rows && rows.length === 0 && <div className="text-fg/40 text-sm">{t("（取樣範圍內無鍵）")}</div>}
      {rows && rows.length > 0 && (
        <table className="text-xs mono w-full border-collapse">
          <thead><tr className="text-fg/45">
            {!readonly && (
              <th className="px-2 py-1 border-b border-fg/10 w-8 text-center">
                <input type="checkbox" title={t("全選 / 取消")}
                  checked={marked.size === rows.length}
                  ref={(el) => { if (el) el.indeterminate = marked.size > 0 && marked.size < rows.length; }}
                  onChange={() => setMarked(marked.size === rows.length ? new Set() : new Set(rows.map((b) => b.key)))} />
              </th>
            )}
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("鍵")}</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("型別")}</th>
            <th className="text-right px-2 py-1 border-b border-fg/10">{t("記憶體")}</th>
            <th className="text-right px-2 py-1 border-b border-fg/10">TTL</th>
            <th className="w-20 border-b border-fg/10" />
          </tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.key} className="hover:bg-fg/5 group">
                {!readonly && (
                  <td className="px-2 py-1 border-b border-fg/5 text-center">
                    <input type="checkbox" aria-label={b.key} checked={marked.has(b.key)} onChange={() => toggle(b.key)} />
                  </td>
                )}
                <td className="px-2 py-1 border-b border-fg/5 break-all text-blue-300/90">{b.key}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-fg/60">{b.type_}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-right text-amber-300 whitespace-nowrap">{b.bytes < 0 ? "—" : humanBytes(b.bytes)}</td>
                <td className="px-2 py-1 border-b border-fg/5 text-right text-fg/50 whitespace-nowrap">{b.ttl < 0 ? t("永久") : `${b.ttl}s`}</td>
                <td className="px-1 py-1 border-b border-fg/5 text-right whitespace-nowrap">
                  <button type="button" onClick={() => copyToClipboard(b.key, t("已複製鍵名"))} title={t("複製鍵名")}
                    className="px-1.5 py-0.5 rounded text-fg/20 group-hover:text-fg/70 hover:bg-fg/10">{t("複製")}</button>
                  {!readonly && (
                    <button type="button" onClick={() => removeKeys([b.key])} disabled={deleting} title={t("刪除此鍵")}
                      className="px-1.5 py-0.5 rounded text-fg/20 group-hover:text-red-400 hover:bg-red-500/20 disabled:opacity-30">{t("刪除")}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function fmtUnix(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "—";
  return new Date(secs * 1000).toLocaleString();
}

function fmtDuration(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(2)}s`;
  if (us >= 1000) return `${(us / 1000).toFixed(2)}ms`;
  return `${us}µs`;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}
