import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Check, Lock, Users } from "lucide-react";
import { api, QueryResult } from "./api";
import { toast, uiConfirm, uiPrompt, copyToClipboard } from "./ui";
import { Modal, Button } from "./ui/index";
import Icon from "./ui/Icon";
import {
  userListSql,
  buildCreateUser,
  buildDropUser,
  buildAlterUserPassword,
  buildSetUserLock,
  buildAlterUserLimits,
  buildAlterUserSsl,
  showGrantsSql,
  grantScope,
  buildGrant,
  buildRevoke,
} from "./sql";
import { useT } from "./i18n";

// MySQL 常用權限（GRANT 關鍵字，非識別字）。
const PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX",
  "REFERENCES", "CREATE VIEW", "SHOW VIEW", "EXECUTE", "ALL PRIVILEGES"];

// MySQL 使用者管理：對標 Navicat「使用者」檢視 —— 列出帳號（含資源限制 / SSL / 鎖定），
// 並支援新增 / 刪除 / 修改密碼 / 鎖定切換 / 檢視授權（SHOW GRANTS）。
// 全部以既有 runQuery（讀）+ execDdl（DDL）達成，DDL 字串由 sql.ts 之純函式組出（已單元測試）。

// 值即 t() 的 key：常數表在模組載入時求值一次，若在這裡呼叫 t()，切換語言後表頭不會更新。
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
  const t = useT();
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [nName, setNName] = useState("");
  const [nHost, setNHost] = useState("%");
  const [nPass, setNPass] = useState("");
  const [grants, setGrants] = useState<{ user: UserRow; lines: string[] } | null>(null);
  const [limitsFor, setLimitsFor] = useState<UserRow | null>(null);
  const [lim, setLim] = useState({ queries: "", updates: "", connections: "", userConnections: "" });
  const [ssl, setSsl] = useState("NONE");
  const [sslOrig, setSslOrig] = useState("NONE");
  const [gPrivs, setGPrivs] = useState<string[]>([]);
  const [gDb, setGDb] = useState("");
  const [gTable, setGTable] = useState("");
  const [gGrantOption, setGGrantOption] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.runQuery(connId, userListSql()));
    } catch (e: any) {
      setErr(e?.message ?? t("讀取失敗"));
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
      toast.error(e?.message ?? t("操作失敗"));
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    const name = nName.trim();
    if (!name) { toast.error(t("請輸入使用者名稱")); return; }
    await run(buildCreateUser(name, nHost.trim() || "%", nPass), t("已新增使用者 {name}", { name }));
    setAdding(false); setNName(""); setNHost("%"); setNPass("");
  };

  const doDrop = async (u: UserRow) => {
    if (isInternalAccount(u.name)) { toast.error(t("系統內建帳號不可刪除")); return; }
    const acct = `${u.name}@${u.host}`;
    if (await uiConfirm(t("確定刪除使用者 {acct}？此操作無法復原。", { acct }), { title: t("刪除使用者"), danger: true, confirmText: t("刪除") }))
      await run(buildDropUser(u.name, u.host), t("已刪除 {acct}", { acct }));
  };

  const doPassword = async (u: UserRow) => {
    if (isInternalAccount(u.name)) { toast.error(t("系統內建帳號不可修改")); return; }
    const p = await uiPrompt(t("為 {name}@{host} 設定新密碼：", { name: u.name, host: u.host }), { title: t("修改密碼"), placeholder: t("新密碼") });
    if (p === null) return;
    if (!p) { toast.error(t("密碼不可為空")); return; }
    await run(buildAlterUserPassword(u.name, u.host, p), t("密碼已更新"));
  };

  const doLock = async (u: UserRow) => {
    // 鎖定為破壞性操作（帳號將無法登入）需確認；解鎖維持一鍵。
    if (!u.locked && !(await uiConfirm(t("鎖定帳號「{name}@{host}」？該帳號將無法登入。", { name: u.name, host: u.host }), { title: t("鎖定帳號"), danger: true, confirmText: t("鎖定") })))
      return;
    return run(buildSetUserLock(u.name, u.host, !u.locked), u.locked ? t("已解鎖") : t("已鎖定"));
  };

  const openLimits = (u: UserRow) => {
    setLim({
      queries: u.meta.max_questions ?? "0",
      updates: u.meta.max_updates ?? "0",
      connections: u.meta.max_connections ?? "0",
      userConnections: u.meta.max_user_connections ?? "0",
    });
    // ssl_type 空字串＝未要求 SSL；ANY / X509 對應到 REQUIRE 模式。
    const st = (u.meta.ssl_type ?? "").toUpperCase();
    const mode = st === "ANY" ? "SSL" : st === "X509" ? "X509" : "NONE";
    setSsl(mode); setSslOrig(mode);
    setLimitsFor(u);
  };
  const applyLimits = async () => {
    if (!limitsFor) return;
    const limSql = buildAlterUserLimits(limitsFor.name, limitsFor.host, {
      queries: Number(lim.queries) || 0,
      updates: Number(lim.updates) || 0,
      connections: Number(lim.connections) || 0,
      userConnections: Number(lim.userConnections) || 0,
    });
    setBusy(true);
    try {
      if (limSql) await api.execDdl(connId, limSql);
      if (ssl !== sslOrig) await api.execDdl(connId, buildAlterUserSsl(limitsFor.name, limitsFor.host, ssl));
      toast.success(t("帳號設定已更新"));
      setLimitsFor(null);
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? t("更新失敗"));
    } finally {
      setBusy(false);
    }
  };

  const fetchGrants = async (u: UserRow): Promise<string[]> => {
    const g = await api.runQuery(connId, showGrantsSql(u.name, u.host));
    return g.rows.map((r) => r[0] ?? "").filter(Boolean);
  };

  const showGrants = async (u: UserRow) => {
    setBusy(true);
    try {
      setGrants({ user: u, lines: await fetchGrants(u) });
      setGPrivs([]); setGDb(""); setGTable("");
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取授權失敗"));
    } finally {
      setBusy(false);
    }
  };

  const togglePriv = (p: string) =>
    setGPrivs((cur) => {
      if (p === "ALL PRIVILEGES") return cur.includes(p) ? [] : ["ALL PRIVILEGES"];
      const next = cur.filter((x) => x !== "ALL PRIVILEGES");
      return next.includes(p) ? next.filter((x) => x !== p) : [...next, p];
    });

  const applyGrant = async (revoke: boolean) => {
    if (!grants) return;
    if (gPrivs.length === 0) { toast.error(t("請選擇至少一項權限")); return; }
    const u = grants.user;
    const scope = grantScope(gDb.trim() || null, gTable.trim() || null);
    const sql = revoke ? buildRevoke(gPrivs, scope, u.name, u.host) : buildGrant(gPrivs, scope, u.name, u.host, gGrantOption);
    setBusy(true);
    try {
      await api.execDdl(connId, sql);
      toast.success(revoke ? t("已撤銷權限") : t("已授予權限"));
      setGrants({ user: u, lines: await fetchGrants(u) });
    } catch (e: any) {
      toast.error(e?.message ?? t("操作失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
    <Modal
      onClose={onClose}
      icon={Users}
      size="xl"
      zClass="z-[95]"
      className="!w-[940px] max-w-[96vw] h-[80vh]"
      bodyClassName="p-0 flex flex-col min-h-0"
      title={
        <span className="flex items-center gap-2">
          <span>{t("使用者管理")}</span>
          {res && <span className="text-xs text-fg/40 font-normal">{rows.length} {t("個帳號")}</span>}
          <button type="button" onClick={() => setAdding((s) => !s)} disabled={busy}
            className="ml-2 inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40"><Icon icon={Plus} size={14} /> {t("新增使用者")}</button>
          <button type="button" onClick={() => refresh()} disabled={busy}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? t("處理中…") : t("重新整理")}</button>
        </span>
      }
    >
        {adding && (
          <div className="px-5 py-3 border-b border-fg/10 bg-inset flex items-end gap-2 text-xs">
            <label className="flex flex-col gap-1">{t("使用者")}
              <input value={nName} onChange={(e) => setNName(e.target.value)} autoFocus
                className="bg-well border border-fg/15 rounded px-2 py-1 focus:border-accent w-40" placeholder={t("例：app_user")} /></label>
            <label className="flex flex-col gap-1">{t("主機")}
              <input value={nHost} onChange={(e) => setNHost(e.target.value)}
                className="bg-well border border-fg/15 rounded px-2 py-1 focus:border-accent w-32" placeholder="%" /></label>
            <label className="flex flex-col gap-1">{t("密碼")}
              <input value={nPass} onChange={(e) => setNPass(e.target.value)} type="password"
                onKeyDown={(e) => e.key === "Enter" && doCreate()}
                className="bg-well border border-fg/15 rounded px-2 py-1 focus:border-accent w-44" placeholder={t("（可留空）")} /></label>
            <button type="button" onClick={doCreate} disabled={busy}
              className="px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">{t("建立")}</button>
            <button type="button" onClick={() => setAdding(false)}
              className="px-3 py-1.5 rounded border border-fg/15 hover:bg-fg/5">{t("取消")}</button>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {err ? (
            <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
          ) : !res ? (
            <div className="text-fg/40 text-sm p-5">{t("讀取中…")}</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-inset text-fg/45">
                <tr>
                  <th className="text-left px-3 py-1.5 font-normal">{t("使用者")}</th>
                  <th className="text-left px-3 py-1.5 font-normal">{t("主機")}</th>
                  {META_COLS.map((c) => <th key={c} className="text-left px-3 py-1.5 font-normal whitespace-nowrap">{t(HEAD[c])}</th>)}
                  <th className="text-left px-3 py-1.5 font-normal">{t("狀態")}</th>
                  <th className="text-right px-3 py-1.5 font-normal">{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u, i) => (
                  <tr key={i} className="border-t border-fg/5 hover:bg-fg/5">
                    <td className="px-3 py-1 mono text-fg/85">{u.name || <span className="text-fg/30">{t("（匿名）")}</span>}</td>
                    <td className="px-3 py-1 mono text-fg/60">{u.host}</td>
                    {META_COLS.map((c) => (
                      <td key={c} className="px-3 py-1 mono text-fg/60 whitespace-nowrap">
                        {/* ssl_type 空字串＝未要求 SSL；顯示文字在這裡產生（SQL 只回原值，見 userListSql）。 */}
                        {c === "Super_priv"
                          ? (u.meta[c] === "Y" ? <Icon icon={Check} size={14} /> : "")
                          : c === "ssl_type"
                          ? (u.meta[c] || t("無"))
                          : (u.meta[c] ?? "")}
                      </td>
                    ))}
                    <td className="px-3 py-1">
                      {u.locked ? <span className="inline-flex items-center gap-1 text-amber-300"><Icon icon={Lock} size={13} /> {t("已鎖定")}</span> : <span className="text-green-300/70">{t("正常")}</span>}
                    </td>
                    <td className="px-3 py-1 text-right whitespace-nowrap">
                      <button type="button" onClick={() => showGrants(u)} disabled={busy}
                        className="text-blue-400 hover:text-blue-300 disabled:opacity-40 px-1">{t("授權")}</button>
                      {!isInternalAccount(u.name) && <>
                        <button type="button" onClick={() => openLimits(u)} disabled={busy}
                          className="text-fg/60 hover:text-fg disabled:opacity-40 px-1">{t("限制")}</button>
                        <button type="button" onClick={() => doPassword(u)} disabled={busy}
                          className="text-fg/60 hover:text-fg disabled:opacity-40 px-1">{t("密碼")}</button>
                        <button type="button" onClick={() => doLock(u)} disabled={busy}
                          className="text-fg/60 hover:text-fg disabled:opacity-40 px-1">{u.locked ? t("解鎖") : t("鎖定")}</button>
                        <button type="button" onClick={() => doDrop(u)} disabled={busy}
                          className="text-red-300 hover:text-red-200 disabled:opacity-40 px-1">{t("刪除")}</button>
                      </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
    </Modal>

      {limitsFor && (
        <Modal
          onClose={() => setLimitsFor(null)}
          title={t("帳號設定：{name}@{host}", { name: limitsFor.name, host: limitsFor.host })}
          size="sm"
          zClass="z-[97]"
          bodyClassName="p-5 space-y-2.5 text-xs overflow-auto"
          footer={<>
            <Button variant="secondary" onClick={() => setLimitsFor(null)}>{t("取消")}</Button>
            <Button variant="primary" loading={busy} onClick={applyLimits}>{t("套用")}</Button>
          </>}
        >
              <label className="flex items-center gap-3">
                <span className="text-fg/55 w-28 shrink-0">{t("SSL 需求")}</span>
                <select value={ssl} onChange={(e) => setSsl(e.target.value)} title={t("SSL 需求")}
                  className="bg-well border border-fg/15 rounded px-2 py-1 focus:border-accent">
                  <option value="NONE">{t("NONE（不要求）")}</option>
                  <option value="SSL">SSL</option>
                  <option value="X509">X509</option>
                </select>
              </label>
              <div className="text-fg/40 pt-1">{t("每小時限制（0 = 無限制）")}</div>
              {([
                [t("每小時查詢數"), "queries"], [t("每小時更新數"), "updates"],
                [t("每小時連線數"), "connections"], [t("最大同時連線"), "userConnections"],
              ] as const).map(([label, key]) => (
                <label key={key} className="flex items-center gap-3">
                  <span className="text-fg/55 w-28 shrink-0">{label}</span>
                  <input value={(lim as any)[key]} onChange={(e) => setLim((s) => ({ ...s, [key]: e.target.value.replace(/[^0-9]/g, "") }))}
                    className="bg-well border border-fg/15 rounded px-2 py-1 focus:border-accent w-28 mono" placeholder="0" />
                </label>
              ))}
        </Modal>
      )}

      {grants && (
        <Modal
          onClose={() => setGrants(null)}
          size="lg"
          zClass="z-[97]"
          className="!w-[680px] max-h-[82vh]"
          bodyClassName="p-0 flex flex-col min-h-0"
          title={
            <span className="flex items-center gap-2">
              <span>{t("權限管理員：")}{grants.user.name}@{grants.user.host}</span>
              <button type="button" onClick={() => copyToClipboard(grants.lines.join(";\n") + ";")}
                className="text-xs text-blue-400 hover:text-blue-300 font-normal">{t("複製")}</button>
            </span>
          }
        >
            <div className="flex-1 overflow-auto p-4 space-y-2">
              <div className="text-fg/45 text-xs">{t("目前授權")}</div>
              {grants.lines.length === 0 ? (
                <div className="text-fg/40 text-sm">{t("（無授權）")}</div>
              ) : grants.lines.map((g, i) => (
                <div key={i} className="mono text-xs text-fg/80 bg-well border border-fg/10 rounded px-3 py-2 whitespace-pre-wrap break-all">{g}</div>
              ))}
            </div>
            {!isInternalAccount(grants.user.name) && (
              <div className="border-t border-fg/10 p-4 space-y-3 bg-inset">
                <div className="text-fg/45 text-xs">{t("授予 / 撤銷權限")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {PRIVS.map((p) => (
                    <button key={p} type="button" onClick={() => togglePriv(p)}
                      className={`text-xs px-2 py-1 rounded border ${gPrivs.includes(p)
                        ? "bg-accent border-accent text-white"
                        : "border-fg/15 text-fg/60 hover:bg-fg/5"}`}>{p}</button>
                  ))}
                </div>
                <div className="flex items-end gap-2 text-xs">
                  <label className="flex flex-col gap-1">{t("資料庫（留空=全域 *.*）")}
                    <input value={gDb} onChange={(e) => setGDb(e.target.value)}
                      className="bg-well border border-fg/15 rounded px-2 py-1 focus:border-accent w-44" placeholder="*.*" /></label>
                  <label className="flex flex-col gap-1">{t("資料表（留空=整個 db）")}
                    <input value={gTable} onChange={(e) => setGTable(e.target.value)}
                      className="bg-well border border-fg/15 rounded px-2 py-1 focus:border-accent w-44" placeholder={t("（全部）")} /></label>
                  <button type="button" onClick={() => applyGrant(false)} disabled={busy}
                    className="px-3 py-1.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-40">{t("授予")}</button>
                  <button type="button" onClick={() => applyGrant(true)} disabled={busy}
                    className="px-3 py-1.5 rounded border border-red-400/40 text-red-300 hover:bg-red-500/10 disabled:opacity-40">{t("撤銷")}</button>
                </div>
                <label className="flex items-center gap-1.5 text-fg/55">
                  <input type="checkbox" checked={gGrantOption} onChange={(e) => setGGrantOption(e.target.checked)} />
                  {t("WITH GRANT OPTION（允許此帳號轉授上述權限）")}
                </label>
              </div>
            )}
        </Modal>
      )}
    </>
  );
}
