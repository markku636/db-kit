import { useCallback, useEffect, useMemo, useState } from "react";
import { api, QueryResult } from "./api";
import { useEscToClose, toast, uiConfirm, uiPrompt, copyToClipboard } from "./ui";
import {
  userListSql,
  buildCreateUser,
  buildDropUser,
  buildAlterUserPassword,
  buildSetUserLock,
  showGrantsSql,
} from "./sql";

// MySQL 使用者管理：對標 Navicat「使用者」檢視 —— 列出帳號（含資源限制 / SSL / 鎖定），
// 並支援新增 / 刪除 / 修改密碼 / 鎖定切換 / 檢視授權（SHOW GRANTS）。
// 全部以既有 runQuery（讀）+ execDdl（DDL）達成，DDL 字串由 sql.ts 之純函式組出（已單元測試）。

const HEAD: Record<string, string> = {
  ssl_type: "SSL",
  max_questions: "查詢/時",
  max_updates: "更新/時",
  max_connections: "連線/時",
  max_user_connections: "最大連線",
  Super_priv: "超級",
};
const META_COLS = ["ssl_type", "max_questions", "max_updates", "max_connections", "max_user_connections", "Super_priv"];

// 內建系統帳號：不允許刪除 / 改密碼（刪除會破壞 MySQL）。
function isInternalAccount(name: string): boolean {
  return name.startsWith("mysql.") || name === "" || name === "debian-sys-maint";
}

interface UserRow {
  name: string;
  host: string;
  locked: boolean;
  meta: Record<string, string | null>;
}

export default function UserManager({ connId, onClose }: { connId: string; onClose: () => void }) {
  useEscToClose(onClose);
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [nName, setNName] = useState("");
  const [nHost, setNHost] = useState("%");
  const [nPass, setNPass] = useState("");
  const [grants, setGrants] = useState<{ account: string; lines: string[] } | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.runQuery(connId, userListSql()));
    } catch (e: any) {
      setErr(e?.message ?? "讀取失敗");
    } finally {
      setBusy(false);
    }
  }, [connId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const rows: UserRow[] = useMemo(() => {
    if (!res) return [];
    const idx = (c: string) => res.columns.indexOf(c);
    const iUser = idx("User"), iHost = idx("Host"), iLock = idx("account_locked");
    return res.rows.map((r) => {
      const meta: Record<string, string | null> = {};
      for (const c of META_COLS) {
        const i = idx(c);
        if (i >= 0) meta[c] = r[i];
      }
      return {
        name: iUser >= 0 ? r[iUser] ?? "" : "",
        host: iHost >= 0 ? r[iHost] ?? "" : "",
        locked: iLock >= 0 && r[iLock] === "Y",
        meta,
      };
    });
  }, [res]);

  const run = async (sql: string, ok: string) => {
    setBusy(true);
    try {
      await api.execDdl(connId, sql);
      toast.success(ok);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "操作失敗");
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    const name = nName.trim();
    if (!name) { toast.error("請輸入使用者名稱"); return; }
    await run(buildCreateUser(name, nHost.trim() || "%", nPass), `已新增使用者 ${name}`);
    setAdding(false); setNName(""); setNHost("%"); setNPass("");
  };

  const doDrop = async (u: UserRow) => {
    if (isInternalAccount(u.name)) { toast.error("系統內建帳號不可刪除"); return; }
    const acct = `${u.name}@${u.host}`;
    if (await uiConfirm(`確定刪除使用者 ${acct}？此操作無法復原。`, { title: "刪除使用者", danger: true, confirmText: "刪除" }))
      await run(buildDropUser(u.name, u.host), `已刪除 ${acct}`);
  };

  const doPassword = async (u: UserRow) => {
    if (isInternalAccount(u.name)) { toast.error("系統內建帳號不可修改"); return; }
    const p = await uiPrompt(`為 ${u.name}@${u.host} 設定新密碼：`, { title: "修改密碼", placeholder: "新密碼" });
    if (p === null) return;
    if (!p) { toast.error("密碼不可為空"); return; }
    await run(buildAlterUserPassword(u.name, u.host, p), "密碼已更新");
  };

  const doLock = async (u: UserRow) =>
    run(buildSetUserLock(u.name, u.host, !u.locked), u.locked ? "已解鎖" : "已鎖定");

  const showGrants = async (u: UserRow) => {
    setBusy(true);
    try {
      const g = await api.runQuery(connId, showGrantsSql(u.name, u.host));
      setGrants({ account: `${u.name}@${u.host}`, lines: g.rows.map((r) => r[0] ?? "").filter(Boolean) });
    } catch (e: any) {
      toast.error(e?.message ?? "讀取授權失敗");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[940px] max-w-[96vw] h-[80vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">使用者管理</span>
          {res && <span className="text-xs text-white/40">{rows.length} 個帳號</span>}
          <button type="button" onClick={() => setAdding((s) => !s)} disabled={busy}
            className="ml-auto text-xs px-2 py-1 rounded bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40">＋ 新增使用者</button>
          <button type="button" onClick={() => refresh()} disabled={busy}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? "處理中…" : "重新整理"}</button>
          <button type="button" onClick={onClose} className="text-white/40 hover:text-white">✕</button>
        </div>

        {adding && (
          <div className="px-5 py-3 border-b border-white/10 bg-[#10161e] flex items-end gap-2 text-xs">
            <label className="flex flex-col gap-1">使用者
              <input value={nName} onChange={(e) => setNName(e.target.value)} autoFocus
                className="bg-[#0c1118] border border-white/15 rounded px-2 py-1 w-40" placeholder="例：app_user" /></label>
            <label className="flex flex-col gap-1">主機
              <input value={nHost} onChange={(e) => setNHost(e.target.value)}
                className="bg-[#0c1118] border border-white/15 rounded px-2 py-1 w-32" placeholder="%" /></label>
            <label className="flex flex-col gap-1">密碼
              <input value={nPass} onChange={(e) => setNPass(e.target.value)} type="password"
                onKeyDown={(e) => e.key === "Enter" && doCreate()}
                className="bg-[#0c1118] border border-white/15 rounded px-2 py-1 w-44" placeholder="（可留空）" /></label>
            <button type="button" onClick={doCreate} disabled={busy}
              className="px-3 py-1.5 rounded bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40">建立</button>
            <button type="button" onClick={() => setAdding(false)}
              className="px-3 py-1.5 rounded border border-white/15 hover:bg-white/5">取消</button>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {err ? (
            <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
          ) : !res ? (
            <div className="text-white/40 text-sm p-5">讀取中…</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[#10161e] text-white/45">
                <tr>
                  <th className="text-left px-3 py-1.5 font-normal">使用者</th>
                  <th className="text-left px-3 py-1.5 font-normal">主機</th>
                  {META_COLS.map((c) => <th key={c} className="text-left px-3 py-1.5 font-normal whitespace-nowrap">{HEAD[c]}</th>)}
                  <th className="text-left px-3 py-1.5 font-normal">狀態</th>
                  <th className="text-right px-3 py-1.5 font-normal">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u, i) => (
                  <tr key={i} className="border-t border-white/5 hover:bg-white/5">
                    <td className="px-3 py-1 mono text-white/85">{u.name || <span className="text-white/30">（匿名）</span>}</td>
                    <td className="px-3 py-1 mono text-white/60">{u.host}</td>
                    {META_COLS.map((c) => (
                      <td key={c} className="px-3 py-1 mono text-white/60 whitespace-nowrap">
                        {c === "Super_priv" ? (u.meta[c] === "Y" ? "✓" : "") : (u.meta[c] ?? "")}
                      </td>
                    ))}
                    <td className="px-3 py-1">
                      {u.locked ? <span className="text-amber-300">🔒 已鎖定</span> : <span className="text-green-300/70">正常</span>}
                    </td>
                    <td className="px-3 py-1 text-right whitespace-nowrap">
                      <button type="button" onClick={() => showGrants(u)} disabled={busy}
                        className="text-blue-400 hover:text-blue-300 disabled:opacity-40 px-1">授權</button>
                      {!isInternalAccount(u.name) && <>
                        <button type="button" onClick={() => doPassword(u)} disabled={busy}
                          className="text-white/60 hover:text-white disabled:opacity-40 px-1">密碼</button>
                        <button type="button" onClick={() => doLock(u)} disabled={busy}
                          className="text-white/60 hover:text-white disabled:opacity-40 px-1">{u.locked ? "解鎖" : "鎖定"}</button>
                        <button type="button" onClick={() => doDrop(u)} disabled={busy}
                          className="text-red-300 hover:text-red-200 disabled:opacity-40 px-1">刪除</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {grants && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[97]" onClick={() => setGrants(null)}>
          <div className="bg-[#1a212b] w-[640px] max-w-[94vw] max-h-[70vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
            onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
              <span className="font-medium text-sm">授權：{grants.account}</span>
              <button type="button" onClick={() => copyToClipboard(grants.lines.join(";\n") + ";")}
                className="ml-auto text-xs text-blue-400 hover:text-blue-300">複製</button>
              <button type="button" onClick={() => setGrants(null)} className="text-white/40 hover:text-white">✕</button>
            </div>
            <div className="flex-1 overflow-auto p-4 space-y-2">
              {grants.lines.length === 0 ? (
                <div className="text-white/40 text-sm">（無授權）</div>
              ) : grants.lines.map((g, i) => (
                <div key={i} className="mono text-xs text-white/80 bg-[#0c1118] border border-white/10 rounded px-3 py-2 whitespace-pre-wrap break-all">{g}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
