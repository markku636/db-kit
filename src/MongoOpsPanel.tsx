import { Fragment, useEffect, useState } from "react";
import { Activity, RefreshCw, X } from "lucide-react";
import { api, MongoOp, MongoProfile, MongoSlowQuery, ServerInfoSection } from "./api";
import { toast, uiConfirm, useModalOverlay } from "./ui";
import { IconButton, Select } from "./ui/index";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

type Tab = "status" | "dbstats" | "ops" | "profiler";

// Mongo 監控面板（比照 RedisOpsPanel 的殼）：伺服器狀態 / 資料庫統計 / 進行中操作 / Profiler。
// 每個分頁獨立載入、錯誤各自內嵌顯示（Atlas 等受限帳號部分指令被拒時，其他分頁不受影響）。
export default function MongoOpsPanel({ connId, connName, database, readonly, onClose }: {
  connId: string; connName: string; database: string; readonly: boolean; onClose: () => void;
}) {
  const t = useT();
  useModalOverlay(onClose);
  const [tab, setTab] = useState<Tab>("status");

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-elevated w-[900px] max-w-[95vw] h-[80vh] flex flex-col rounded-lg border border-fg/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-fg/10 flex items-center gap-3">
          <Icon icon={Activity} size={14} className="text-green-400" />
          <span className="font-medium text-sm">{t("監控 ·")} {connName}</span>
          <div className="flex items-center rounded border border-fg/10 overflow-hidden ml-2 text-xs">
            {([["status", t("伺服器狀態")], ["dbstats", t("資料庫統計")], ["ops", t("進行中操作")], ["profiler", "Profiler"]] as [Tab, string][]).map(([v, label]) => (
              <button key={v} type="button" onClick={() => setTab(v)}
                className={`px-3 py-1 ${tab === v ? "bg-fg/15 text-fg" : "text-fg/50 hover:bg-fg/5"}`}>
                {label}
              </button>
            ))}
          </div>
          <IconButton icon={X} label={t("關閉")} iconSize={16} onClick={onClose} className="ml-auto text-fg/40 hover:text-fg" />
        </div>
        <div className="flex-1 overflow-auto p-4">
          {tab === "status" && <StatusTab connId={connId} />}
          {tab === "dbstats" && <DbStatsTab connId={connId} initialDb={database} />}
          {tab === "ops" && <OpsTab connId={connId} readonly={readonly} />}
          {tab === "profiler" && <ProfilerTab connId={connId} initialDb={database} readonly={readonly} />}
        </div>
      </div>
    </div>
  );
}

function ErrBar({ err }: { err: string | null }) {
  if (!err) return null;
  return <div className="text-red-400 text-xs mono mb-2 break-all">{err}</div>;
}

function RefreshBtn({ onClick }: { onClick: () => void }) {
  const t = useT();
  return (
    <button type="button" onClick={onClick}
      className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70">
      <Icon icon={RefreshCw} size={13} /> {t("刷新")}
    </button>
  );
}

// ---- 伺服器狀態（serverStatus 分區 + 自動更新）----
function StatusTab({ connId }: { connId: string }) {
  const t = useT();
  const [secs, setSecs] = useState<ServerInfoSection[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.serverInfo(connId)
      .then((r) => !cancelled && (setSecs(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    return () => { cancelled = true; };
  }, [connId, nonce]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setNonce((n) => n + 1), 2000);
    return () => clearInterval(timer);
  }, [auto]);

  return (
    <>
      <div className="flex items-center gap-2 mb-3 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-fg/60">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{t("每 2 秒自動更新")}
        </label>
        <RefreshBtn onClick={() => setNonce((n) => n + 1)} />
      </div>
      <ErrBar err={err} />
      {!secs && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}
      {secs && (
        <div className="grid grid-cols-2 gap-3">
          {secs.map((s) => (
            <div key={s.name} className="rounded border border-fg/10 bg-well/50">
              <div className="px-3 py-1.5 text-xs font-medium text-fg/60 border-b border-fg/10">{s.name}</div>
              <table className="w-full text-xs">
                <tbody>
                  {s.items.map(([k, v]) => (
                    <tr key={k} className="hover:bg-fg/5">
                      <td className="px-3 py-1 text-fg/50 whitespace-nowrap">{k}</td>
                      <td className="px-3 py-1 mono text-fg/80 break-all">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---- 資料庫統計（dbStats，可切換 db）----
function DbStatsTab({ connId, initialDb }: { connId: string; initialDb: string }) {
  const t = useT();
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState(initialDb);
  const [rows, setRows] = useState<[string, string][] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    api.listDatabases(connId).then((list) => {
      setDbs(list);
      // initialDb 不在清單（如空字串）時退回第一個庫。
      setDb((d) => (d && list.includes(d) ? d : list[0] ?? d));
    }).catch(() => {});
  }, [connId]);
  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    setRows(null);
    api.mongoDbStats(connId, db)
      .then((r) => !cancelled && (setRows(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    return () => { cancelled = true; };
  }, [connId, db, nonce]);

  return (
    <>
      <div className="flex items-center gap-2 mb-3 text-xs">
        <span className="text-fg/50">{t("資料庫")}</span>
        <div className="w-52">
          <Select value={db} onChange={(e) => setDb(e.target.value)}>
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </div>
        <RefreshBtn onClick={() => setNonce((n) => n + 1)} />
      </div>
      <ErrBar err={err} />
      {!rows && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}
      {rows && (
        <table className="text-sm w-full max-w-md border-collapse">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k} className="hover:bg-fg/5">
                <td className="px-3 py-1.5 border-b border-fg/5 text-fg/50 whitespace-nowrap">{k}</td>
                <td className="px-3 py-1.5 border-b border-fg/5 mono text-fg/85">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---- 進行中操作（currentOp + kill）----
function OpsTab({ connId, readonly }: { connId: string; readonly: boolean }) {
  const t = useT();
  const [rows, setRows] = useState<MongoOp[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [expand, setExpand] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.mongoCurrentOps(connId)
      .then((r) => !cancelled && (setRows(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    return () => { cancelled = true; };
  }, [connId, nonce]);
  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(() => setNonce((n) => n + 1), 2000);
    return () => clearInterval(timer);
  }, [auto]);

  const kill = async (op: MongoOp) => {
    const ok = await uiConfirm(
      t("終止操作 {opid}？\n{op} {ns}（已執行 {secs_running}s）\n終止內部 / 複寫操作可能造成不可預期後果。", { opid: op.opid, op: op.op, ns: op.ns, secs_running: op.secs_running }),
      { title: t("終止操作"), danger: true, confirmText: t("終止") },
    );
    if (!ok) return;
    try {
      await api.mongoKillOp(connId, op.opid);
      toast.success(t("已送出 killOp {opid}", { opid: op.opid }));
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("終止失敗"));
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="text-fg/40">{rows?.length ?? 0} {t("個進行中操作（不含閒置連線）")}</span>
        <label className="flex items-center gap-1.5 cursor-pointer select-none text-fg/60 ml-2">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />{t("自動更新")}
        </label>
        <RefreshBtn onClick={() => setNonce((n) => n + 1)} />
      </div>
      <ErrBar err={err} />
      {!rows && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}
      {rows && rows.length === 0 && <div className="text-fg/40 text-sm">{t("（目前沒有進行中的操作）")}</div>}
      {rows && rows.length > 0 && (
        <table className="text-xs mono w-full border-collapse">
          <thead><tr className="text-fg/45">
            <th className="text-left px-2 py-1 border-b border-fg/10">opid</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">op</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">ns</th>
            <th className="text-right px-2 py-1 border-b border-fg/10">{t("秒數")}</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("用戶端")}</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("說明")}</th>
            {!readonly && <th className="w-12 border-b border-fg/10" />}
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.opid}>
                <tr className="hover:bg-fg/5 cursor-pointer"
                  onClick={() => setExpand(expand === r.opid ? null : r.opid)}>
                  <td className="px-2 py-1 border-b border-fg/5 text-fg/60">{r.opid}</td>
                  <td className="px-2 py-1 border-b border-fg/5">{r.op}</td>
                  <td className="px-2 py-1 border-b border-fg/5 text-fg/70 break-all">{r.ns}</td>
                  <td className={`px-2 py-1 border-b border-fg/5 text-right ${r.secs_running > 10 ? "text-amber-300" : "text-fg/60"}`}>{r.secs_running}</td>
                  <td className="px-2 py-1 border-b border-fg/5 text-fg/50">{r.client}</td>
                  <td className="px-2 py-1 border-b border-fg/5 text-fg/50 break-all">{r.desc}{r.waiting_for_lock ? t("（等鎖）") : ""}</td>
                  {!readonly && (
                    <td className="px-2 py-1 border-b border-fg/5 text-right">
                      <button type="button" onClick={(e) => { e.stopPropagation(); void kill(r); }}
                        className="px-1.5 py-0.5 rounded text-red-300 hover:bg-red-500/20">{t("終止")}</button>
                    </td>
                  )}
                </tr>
                {expand === r.opid && r.command_json && (
                  <tr>
                    <td colSpan={readonly ? 6 : 7} className="px-2 py-1 border-b border-fg/5">
                      <pre className="max-h-48 overflow-auto rounded bg-well p-2 text-[11px] whitespace-pre-wrap break-all">{r.command_json}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---- Profiler（level / slowms 設定 + system.profile 慢查詢表）----
function ProfilerTab({ connId, initialDb, readonly }: { connId: string; initialDb: string; readonly: boolean }) {
  const t = useT();
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState(initialDb);
  const [profile, setProfile] = useState<MongoProfile | null>(null);
  const [level, setLevel] = useState(0);
  const [slowMs, setSlowMs] = useState(100);
  const [rows, setRows] = useState<MongoSlowQuery[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [expand, setExpand] = useState<number | null>(null);

  useEffect(() => {
    api.listDatabases(connId).then((list) => {
      setDbs(list);
      setDb((d) => (d && list.includes(d) ? d : list[0] ?? d));
    }).catch(() => {});
  }, [connId]);
  useEffect(() => {
    if (!db) return;
    let cancelled = false;
    api.mongoProfileGet(connId, db)
      .then((p) => { if (cancelled) return; setProfile(p); setLevel(p.level); setSlowMs(p.slow_ms); })
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取 Profiler 設定失敗")));
    setRows(null);
    api.mongoSlowQueries(connId, db, 100)
      .then((r) => !cancelled && (setRows(r), setErr(null)))
      .catch((e) => !cancelled && setErr(e?.message ?? t("讀取失敗")));
    return () => { cancelled = true; };
  }, [connId, db, nonce]);

  const apply = async () => {
    if (level === 2) {
      const ok = await uiConfirm(
        t("Level 2 會記錄「所有」操作，額外寫入負擔明顯，正式環境慎用。確定套用？"),
        { title: "Profiler Level 2", danger: true, confirmText: t("套用") },
      );
      if (!ok) return;
    }
    try {
      const p = await api.mongoProfileSet(connId, db, level, slowMs);
      setProfile(p);
      toast.success(t("Profiler 已設為 level {level}（slowms {slow_ms}）", { level: p.level, slow_ms: p.slow_ms }));
      setNonce((n) => n + 1);
    } catch (e: any) {
      toast.error(e?.message ?? t("設定失敗（mongos / 受限帳號不支援）"));
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3 text-xs">
        <span className="text-fg/50">{t("資料庫")}</span>
        <div className="w-44">
          <Select value={db} onChange={(e) => setDb(e.target.value)}>
            {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
          </Select>
        </div>
        <span className="text-fg/50 ml-2">{t("目前 level：")}<span className="mono text-fg/80">{profile?.level ?? "—"}</span></span>
        {!readonly && (
          <>
            <div className="flex items-center rounded border border-fg/10 overflow-hidden ml-2">
              {[0, 1, 2].map((l) => (
                <button key={l} type="button" onClick={() => setLevel(l)}
                  title={l === 0 ? t("關閉") : l === 1 ? t("僅記錄慢查詢（≥ slowms）") : t("記錄所有操作（慎用）")}
                  className={`px-2.5 py-1 ${level === l ? "bg-fg/15 text-fg" : "text-fg/50 hover:bg-fg/5"}`}>
                  {l}
                </button>
              ))}
            </div>
            <span className="text-fg/50">slowms</span>
            <input type="number" value={slowMs} onChange={(e) => setSlowMs(Number(e.target.value) || 0)}
              className="w-20 h-6 rounded bg-inset border border-fg/10 px-2 text-xs outline-none focus:border-accent/60" />
            <button type="button" onClick={apply}
              className="px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/80">{t("套用")}</button>
          </>
        )}
        <RefreshBtn onClick={() => setNonce((n) => n + 1)} />
      </div>
      <ErrBar err={err} />
      {!rows && !err && <div className="text-fg/40 text-sm">{t("讀取中…")}</div>}
      {rows && rows.length === 0 && (
        <div className="text-fg/40 text-sm">
          {t("system.profile 尚無紀錄 —— 需先將 Profiler 設為 level 1（慢查詢）或 2（全部），且 profiling 為單一資料庫層級、mongos 上不可用。")}
        </div>
      )}
      {rows && rows.length > 0 && (
        <table className="text-xs mono w-full border-collapse">
          <thead><tr className="text-fg/45">
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("時間")}</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">op</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">ns</th>
            <th className="text-right px-2 py-1 border-b border-fg/10">{t("毫秒")}</th>
            <th className="text-left px-2 py-1 border-b border-fg/10">{t("計畫")}</th>
            <th className="text-right px-2 py-1 border-b border-fg/10">{t("鍵/文件掃描")}</th>
            <th className="text-right px-2 py-1 border-b border-fg/10">{t("回傳")}</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={i}>
                <tr className="hover:bg-fg/5 cursor-pointer" onClick={() => setExpand(expand === i ? null : i)}>
                  <td className="px-2 py-1 border-b border-fg/5 text-fg/60 whitespace-nowrap">{r.ts.replace("T", " ").slice(0, 19)}</td>
                  <td className="px-2 py-1 border-b border-fg/5">{r.op}</td>
                  <td className="px-2 py-1 border-b border-fg/5 text-fg/70 break-all">{r.ns}</td>
                  <td className="px-2 py-1 border-b border-fg/5 text-right text-amber-300">{r.millis}</td>
                  <td className={`px-2 py-1 border-b border-fg/5 ${r.plan_summary.includes("COLLSCAN") ? "text-red-400" : "text-fg/60"}`}>{r.plan_summary || "—"}</td>
                  <td className="px-2 py-1 border-b border-fg/5 text-right text-fg/60">{r.keys_examined}/{r.docs_examined}</td>
                  <td className="px-2 py-1 border-b border-fg/5 text-right text-fg/60">{r.nreturned}</td>
                </tr>
                {expand === i && r.command_json && (
                  <tr>
                    <td colSpan={7} className="px-2 py-1 border-b border-fg/5">
                      <pre className="max-h-48 overflow-auto rounded bg-well p-2 text-[11px] whitespace-pre-wrap break-all">{r.command_json}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
