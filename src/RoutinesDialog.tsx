import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, DbKind, RoutineInfo, QueryResult } from "./api";
import { buildDropRoutine } from "./sql";
import { parseRoutineParams, formatSignature } from "./routineParams";
import { toast, uiConfirm } from "./ui";
import { Modal, Button, Input } from "./ui/index";
import RoutineExecDialog from "./RoutineExecDialog";
import SqlEditor, { type SqlDiagnostic } from "./SqlEditor";
import { useSqlSchema } from "./useSqlSchema";
import { ArrowLeft, Plus, Code2 } from "lucide-react";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

const TYPE_LABEL: Record<string, string> = { procedure: "預存程序", function: "函式", trigger: "觸發器", event: "事件" };

// 各資料庫可新增的 routine 種類。
// external gateway 講 MySQL 方言（同 sql.ts 的 sqlLiteral / genUseDb / buildDropRoutine）；
// 漏掉這列會讓「新增：」那排按鈕整個消失——qland 版只能改既有程序、不能新建。
const NEW_TYPES: Record<string, string[]> = {
  mysql: ["procedure", "function", "trigger", "event"],
  mariadb: ["procedure", "function", "trigger", "event"],
  external: ["procedure", "function", "trigger", "event"],
  postgres: ["function", "procedure", "trigger"],
  sqlite: ["trigger"],
};

// 單一 CREATE 語句範本（執行時整段以一次 runQuery 送出，不前端切句，避免內部 ; 破壞）。
function template(kind: DbKind, type: string, t: ReturnType<typeof useT>): string {
  if (kind === "mysql" || kind === "mariadb" || kind === "external") {
    if (type === "procedure") return "CREATE PROCEDURE proc_name(IN p1 INT)\nBEGIN\n  SELECT p1;\nEND";
    if (type === "function") return "CREATE FUNCTION fn_name(p1 INT) RETURNS INT DETERMINISTIC\nBEGIN\n  RETURN p1 + 1;\nEND";
    if (type === "event") return "CREATE EVENT evt_name\nON SCHEDULE EVERY 1 DAY\nCOMMENT ''\nDO\nBEGIN\n  -- " + t("你的排程 SQL，例如清理舊資料；") + "\n  -- DELETE FROM logs WHERE created < NOW() - INTERVAL 30 DAY;\nEND";
    return "CREATE TRIGGER trg_name BEFORE INSERT ON table_name\nFOR EACH ROW\nBEGIN\n  -- SET NEW.col = ...;\nEND";
  }
  if (kind === "postgres") {
    if (type === "function") return "CREATE OR REPLACE FUNCTION fn_name(p1 integer)\nRETURNS integer LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN p1 + 1;\nEND;\n$$";
    if (type === "procedure") return "CREATE OR REPLACE PROCEDURE proc_name(p1 integer)\nLANGUAGE plpgsql AS $$\nBEGIN\n  -- ...\nEND;\n$$";
    return "-- " + t("觸發器需先有回傳 trigger 的函式") + "\nCREATE TRIGGER trg_name BEFORE INSERT ON table_name\nFOR EACH ROW EXECUTE FUNCTION trg_fn()";
  }
  return "CREATE TRIGGER trg_name AFTER INSERT ON table_name\nBEGIN\n  -- ...\nEND";
}

export default function RoutinesDialog({ connId, db, kind, initial = null, initialAction = "edit", newType = null, onClose }: {
  connId: string;
  db: string;
  kind: DbKind;
  initial?: RoutineInfo | null; // 帶入時開啟即直接進入該 routine（樹狀雙擊 / 右鍵「設計」用）。
  initialAction?: "edit" | "exec"; // initial 帶入時的動作：edit=開設計編輯器（預設）、exec=直接執行。
  newType?: string | null; // 無 initial 時帶入種類（function / procedure / trigger …），掛載後直接開新增編輯器（右鍵「新增」用）。
  onClose: () => void;
}) {
  const t = useT();
  const schema = useSqlSchema(connId, kind, db); // 表 / 欄自動完成（程序 / 函式 / 觸發器內文亦受用）
  const [list, setList] = useState<RoutineInfo[] | null>(null);
  // 初始模式在**掛載當下**就定案，不能等 routineDefinition 回來再切。
  // gateway 型連線（qland）查定義是 HTTP 往返、動輒數秒；沿用「先停在清單、載完才翻頁」的寫法，
  // 使用者按右鍵「設計」會先看到一整頁清單在載入中、畫面才忽然跳掉，像是點錯了東西。
  const [mode, setMode] = useState<"list" | "editor">(initial && initialAction === "edit" ? "editor" : "list");
  const [sqlText, setSqlText] = useState("");
  const [loadingDef, setLoadingDef] = useState(initial != null && initialAction === "edit");
  const [editingRoutine, setEditingRoutine] = useState<RoutineInfo | null>(initialAction === "edit" ? initial : null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [diags, setDiags] = useState<SqlDiagnostic[] | undefined>(undefined);
  const [execResult, setExecResult] = useState<{ title: string; results: QueryResult[] } | null>(null);
  const [execTarget, setExecTarget] = useState<RoutineInfo | null>(initialAction === "exec" ? initial : null);
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  // 編輯內容變動即清掉舊的驗證標記（避免標在已改過的位置）。
  const editSql = (v: string) => { setSqlText(v); if (diags) setDiags(undefined); };

  // in-flight 旗標讓「setList(null) → 下方 effect 再次觸發」變成 no-op，effect 才能安全地
  // 以 `list == null` 當作「還沒查過」的條件。
  const listing = useRef(false);
  const refresh = useCallback(async () => {
    if (listing.current) return;
    listing.current = true;
    setList(null);
    try { setList(await api.listRoutines(connId, db)); }
    catch (e: any) { toast.error(e?.message ?? t("讀取失敗")); setList([]); }
    finally { listing.current = false; }
  }, [connId, db]);

  // 清單只在真的要顯示時才查。右鍵「設計」/「執行」直接進編輯器 / 執行表單，根本用不到清單，
  // 而 list_routines 對 gateway 型連線是兩趟（routines + triggers）白花的 HTTP 往返。
  // execTarget 也要擋：直接叫出的執行表單蓋在清單之上，此時去查清單一樣是白花的往返，
  // 只是換成在對話框背後載入。使用者關掉表單回到清單時，這個 effect 會再跑一次。
  useEffect(() => {
    if (mode === "list" && list == null && !execTarget) void refresh();
  }, [mode, list, execTarget, refresh]);

  const openNew = (type: string) => {
    setSqlText(template(kind, type, t));
    setEditingRoutine(null);
    setReplace(false);
    setDiags(undefined);
    setMode("editor");
  };
  // 先翻到編輯器（帶載入態）再抓定義——順序刻意如此，理由見 `mode` 初值的註解。
  const openEdit = async (r: RoutineInfo) => {
    setSqlText("");
    setDiags(undefined);
    setEditingRoutine(r);
    setLoadingDef(true);
    setMode("editor");
    try {
      const def = await api.routineDefinition(connId, db, r.name, r.routine_type);
      setSqlText(def);
      // PG 函式 / 程序定義含 OR REPLACE（不需先刪）；但 PG 觸發器無 OR REPLACE，與 MySQL/SQLite 一樣需先刪後建。
      setReplace(kind !== "postgres" || r.routine_type === "trigger");
    } catch (e: any) {
      toast.error(e?.message ?? t("讀取定義失敗"));
      setMode("list"); // 讀不到定義就退回清單，不留一個空編輯器讓人以為程序是空的
    } finally {
      setLoadingDef(false);
    }
  };

  const drop = async (r: RoutineInfo) => {
    if (busy) return; // 避免與執行中的 exec / 其他刪除並行送出 DDL
    const ok = await uiConfirm(t("刪除{kind}「{name}」？此動作無法復原。", { kind: t(TYPE_LABEL[r.routine_type] ?? r.routine_type), name: r.name }), {
      title: t("刪除"), danger: true, confirmText: t("刪除"),
    });
    if (!ok) return;
    setBusy(true);
    try { await api.execDdl(connId, buildDropRoutine(kind, db, r)); toast.success(t("已刪除「{name}」", { name: r.name })); refresh(); }
    catch (e: any) { toast.error(e?.message ?? t("刪除失敗")); }
    finally { setBusy(false); }
  };
  // 執行函式 / 預存程序（對標 Navicat「執行函式」）：開一格一引數的表單，見 RoutineExecDialog。
  const execute = (r: RoutineInfo) => setExecTarget(r);

  // 伺服器端語法驗證（不持久化）：PG/SQLite 交易回滾、MySQL 暫存名稱試建。
  const validate = async () => {
    if (validating || busy || !sqlText.trim()) return;
    setValidating(true);
    setDiags(undefined);
    try {
      const r = await api.validateDdl(connId, db, sqlText);
      if (r.validated && r.ok) {
        toast.success(t("語法驗證通過"));
      } else if (r.validated) {
        const where = r.line != null ? t("第 {line} 行：", { line: r.line }) : "";
        toast.error(t("語法錯誤 — {where}{message}", { where, message: r.message ?? "" }));
        setDiags([{ line: r.line ?? undefined, severity: "error", message: r.message ?? t("語法錯誤") }]);
      } else {
        toast.info(r.caveat ?? t("已略過伺服器驗證（僅前端結構檢查）"));
      }
    } catch (e: any) {
      toast.error(e?.message ?? t("驗證失敗"));
    } finally {
      setValidating(false);
    }
  };

  const run = async () => {
    if (busy || !sqlText.trim()) return;
    setBusy(true);
    try {
      if (replace && editingRoutine) await api.execDdl(connId, buildDropRoutine(kind, db, editingRoutine));
      await api.execDdl(connId, sqlText);
      toast.success(t("已執行"));
      setList(null); // 建立 / 取代後清單已過期，回到清單時由下方 effect 重查
      setMode("list");
    } catch (e: any) {
      toast.error(e?.message ?? t("執行失敗"));
    } finally {
      setBusy(false);
    }
  };

  // 由樹狀雙擊 / 右鍵帶入 initial 或 newType 時，掛載後自動進入對應模式（僅一次）。
  // initial 的兩條路徑（editor / exec）在 useState 初值就已定案，此處只補「真的去抓定義」與「開新增」。
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    if (initial) {
      opened.current = true;
      if (initialAction === "edit") void openEdit(initial); // exec 由 execTarget 初值直接開表單
    } else if (newType) {
      opened.current = true;
      openNew(newType);
    }
    // openEdit / openNew 為穩定 closure，刻意精簡依賴避免重複觸發。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, newType]);

  // 清單過濾：名稱 / 註解 / 所屬表比對關鍵字，再依類型收窄。程序多的庫（qland 動輒數百支）
  // 沒有搜尋等於要用眼睛捲，這是清單唯一真正缺的東西。
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list ?? []).filter((r) => {
      if (typeFilter && r.routine_type !== typeFilter) return false;
      if (!q) return true;
      return `${r.name} ${r.comment ?? ""} ${r.parent ?? ""}`.toLowerCase().includes(q);
    });
  }, [list, filter, typeFilter]);
  // 只顯示這份清單裡真的有的類型，避免給出「按了必定空白」的按鈕。
  const kindsPresent = useMemo(
    () => Array.from(new Set((list ?? []).map((r) => r.routine_type))),
    [list],
  );
  // 空結果集（CALL 本身、SET）不畫表格，只有真的有欄位的才渲染。
  const execTables = useMemo(
    () => (execResult?.results ?? []).filter((r) => r.columns.length > 0),
    [execResult],
  );

  return (
    <>
    <Modal
      onClose={onClose}
      icon={Code2}
      size="lg"
      zClass="z-[95]"
      className="h-[78vh]"
      bodyClassName="flex flex-col min-h-0 overflow-hidden"
      title={
        <span className="flex items-center gap-2">
          <span className="font-medium text-sm">{t("預存程序 / 觸發器")}</span>
          <span className="text-xs text-fg/40 mono">{db}</span>
          {mode === "editor" && (
            <button type="button" onClick={() => setMode("list")} className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"><Icon icon={ArrowLeft} size={13} /> {t("返回清單")}</button>
          )}
        </span>
      }
      footer={mode === "editor" ? (
        <>
          <label className="text-xs text-fg/55 flex items-center gap-1.5 mr-auto">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            {t("先刪除同名再建立（MySQL / SQLite 無 OR REPLACE 時需勾選）")}
          </label>
          <Button variant="secondary" onClick={() => setMode("list")}>{t("取消")}</Button>
          <Button variant="secondary" onClick={validate} loading={validating} disabled={validating || busy || !sqlText.trim()}
            title={t("以資料庫引擎驗證語法（不會實際建立）")}>{t("驗證")}</Button>
          <Button variant="primary" onClick={run} loading={busy} disabled={busy || !sqlText.trim()}>{t("執行")}</Button>
        </>
      ) : undefined}
    >
        {mode === "list" ? (
          <>
            <div className="px-5 py-2 border-b border-fg/10 flex items-center gap-2">
              <span className="text-xs text-fg/45">{t("新增：")}</span>
              {(NEW_TYPES[kind] ?? []).map((item) => (
                <button key={item} type="button" onClick={() => openNew(item)}
                  className="text-xs px-2 py-1 rounded bg-fg/5 hover:bg-fg/10 inline-flex items-center gap-1"><Icon icon={Plus} size={13} /> {t(TYPE_LABEL[item])}</button>
              ))}
              <button type="button" onClick={() => refresh()} className="ml-auto text-xs text-fg/40 hover:text-fg/70">{t("重新整理")}</button>
            </div>
            <div className="px-5 py-2 border-b border-fg/10 flex items-center gap-2">
              <Input inputSize="sm" value={filter} onChange={(e) => setFilter(e.target.value)}
                placeholder={t("搜尋名稱 / 註解…")} className="w-56" />
              {kindsPresent.map((k) => (
                <button key={k} type="button" onClick={() => setTypeFilter(typeFilter === k ? null : k)}
                  className={`text-xs px-2 py-1 rounded ${typeFilter === k ? "bg-accent/20 text-accent" : "bg-fg/5 text-fg/50 hover:bg-fg/10"}`}>
                  {t(TYPE_LABEL[k] ?? k)}
                </button>
              ))}
              {list != null && (
                <span className="ml-auto text-xs text-fg/35">
                  {shown.length === list.length ? t("{n} 項", { n: list.length }) : t("{n} / {total} 項", { n: shown.length, total: list.length })}
                </span>
              )}
            </div>
            <div className="flex-1 overflow-auto p-2">
              {list == null ? (
                <div className="text-fg/40 text-sm p-4">{t("載入中…")}</div>
              ) : list.length === 0 ? (
                <div className="text-fg/40 text-sm p-4">{t("此資料庫沒有預存程序 / 函式 / 觸發器。")}</div>
              ) : shown.length === 0 ? (
                <div className="text-fg/40 text-sm p-4">{t("沒有符合條件的項目。")}</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-fg/40 text-xs">
                    <tr><th className="text-left px-3 py-1.5 font-normal">{t("名稱")}</th><th className="text-left px-3 py-1.5 font-normal">{t("類型")}</th><th className="text-left px-3 py-1.5 font-normal">{t("所屬表")}</th><th className="text-left px-3 py-1.5 font-normal whitespace-nowrap">{t("修改時間")}</th><th className="text-left px-3 py-1.5 font-normal">{t("決定性")}</th><th className="text-left px-3 py-1.5 font-normal">{t("註解")}</th><th className="w-32 font-normal" aria-label={t("操作")} /></tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={`${r.routine_type}:${r.name}:${r.signature ?? ""}`} className="border-t border-fg/5 hover:bg-fg/5 align-top">
                        {/* 簽章換行放在名稱底下，不跟名稱擠成一長串——程序名本來就長，接上
                            `(IN p_a int, IN p_b varchar(20))` 之後整個表格會被撐到需要橫捲。 */}
                        <td className="px-3 py-1.5">
                          <div className="mono">{r.name}</div>
                          {r.signature != null && (
                            <div className="mono text-[11px] text-fg/35 max-w-[22rem] truncate" title={r.signature}>
                              {formatSignature(parseRoutineParams(kind, r.signature))}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-fg/60">{t(TYPE_LABEL[r.routine_type] ?? r.routine_type)}</td>
                        <td className="px-3 py-1.5 text-fg/40 mono">{r.parent ?? "—"}</td>
                        <td className="px-3 py-1.5 text-fg/40 mono whitespace-nowrap">{r.modified ?? "—"}</td>
                        <td className="px-3 py-1.5 text-fg/50">{r.deterministic == null ? "—" : r.deterministic ? t("是") : t("否")}</td>
                        <td className="px-3 py-1.5 text-fg/40 max-w-[180px] truncate" title={r.comment ?? ""}>{r.comment || "—"}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          {(r.routine_type === "function" || r.routine_type === "procedure") && (
                            <button type="button" onClick={() => execute(r)} disabled={busy}
                              className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40 px-1">{t("執行")}</button>
                          )}
                          <button type="button" onClick={() => openEdit(r)} disabled={busy} className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 px-1">{t("編輯")}</button>
                          <button type="button" onClick={() => drop(r)} disabled={busy} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 px-1">{t("刪除")}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="px-5 py-2 border-b border-fg/10 text-xs text-fg/40">
              {editingRoutine ? t("編輯：{name}", { name: editingRoutine.name }) : t("新增")}　{t("·　整段以單一語句執行（內部 ; 不切句）")}
            </div>
            {loadingDef ? (
              <div className="flex-1 m-3 min-h-0 bg-inset border border-fg/10 rounded grid place-items-center text-sm text-fg/40">
                {t("載入定義中…")}
              </div>
            ) : (
            <div className="flex-1 m-3 min-h-0 bg-inset border border-fg/10 rounded overflow-hidden focus-within:border-accent">
              <SqlEditor
                value={sqlText}
                onChange={editSql}
                kind={kind}
                schema={schema}
                diagnostics={diags}
                onSubmit={run}
                autoFocus
                placeholder="CREATE PROCEDURE / FUNCTION / TRIGGER …"
              />
            </div>
            )}
          </>
        )}
    </Modal>

      {execTarget && (
        <RoutineExecDialog
          connId={connId}
          db={db}
          kind={kind}
          routine={execTarget}
          onClose={() => setExecTarget(null)}
          onResult={(title, results) => { setExecTarget(null); setExecResult({ title, results }); }}
        />
      )}

      {execResult && (
        <Modal
          onClose={() => setExecResult(null)}
          size="lg"
          zClass="z-[98]"
          className="max-h-[78vh]"
          bodyClassName="overflow-auto"
          title={
            <span className="flex items-center gap-2 w-full">
              <span className="font-medium text-sm">{t("執行結果：")}{execResult.title}</span>
              <span className="ml-auto text-xs text-fg/40">
                {execResult.results.length > 1 && <>{t("{n} 個結果集 · ", { n: execResult.results.length })}</>}
                {execResult.results.reduce((n, r) => n + r.rows.length, 0)} {t("筆 · 影響")} {execResult.results.reduce((n, r) => n + r.rows_affected, 0)}
              </span>
            </span>
          }
        >
          {/* OUT 引數會多帶一個 SELECT @var 的結果集，故一律以陣列渲染（見 buildRoutineExecSql）。 */}
          {execTables.length === 0 ? (
            <div className="text-fg/50 text-sm p-5">{t("已執行（無結果集）。")}</div>
          ) : (
            execTables.map((res, ri) => (
              <div key={ri} className="border-b border-fg/5 last:border-0">
                {execTables.length > 1 && (
                  <div className="px-3 pt-2 text-[11px] text-fg/35">{t("結果集 {n}", { n: ri + 1 })}</div>
                )}
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-inset text-fg/45">
                    <tr>{res.columns.map((c) => <th key={c} className="text-left px-3 py-1.5 font-normal whitespace-nowrap">{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {res.rows.map((row, i) => (
                      <tr key={i} className="border-t border-fg/5 hover:bg-fg/5">
                        {row.map((v, j) => (
                          <td key={j} className="px-3 py-1 mono text-fg/80 max-w-[360px] truncate" title={v ?? "NULL"}>
                            {v ?? <span className="text-fg/30">NULL</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </Modal>
      )}
    </>
  );
}
