import { useCallback, useEffect, useRef, useState } from "react";
import { api, DbKind, RoutineInfo, QueryResult } from "./api";
import { buildRoutineCall, buildDropRoutine } from "./sql";
import { toast, uiConfirm, uiPrompt } from "./ui";
import { Modal, Button } from "./ui/index";
import SqlEditor, { type SqlDiagnostic } from "./SqlEditor";
import { useSqlSchema } from "./useSqlSchema";
import { ArrowLeft, Plus, Code2 } from "lucide-react";
import Icon from "./ui/Icon";

const TYPE_LABEL: Record<string, string> = { procedure: "預存程序", function: "函式", trigger: "觸發器", event: "事件" };

// 各資料庫可新增的 routine 種類。
const NEW_TYPES: Record<string, string[]> = {
  mysql: ["procedure", "function", "trigger", "event"],
  mariadb: ["procedure", "function", "trigger", "event"],
  postgres: ["function", "procedure", "trigger"],
  sqlite: ["trigger"],
};

// 單一 CREATE 語句範本（執行時整段以一次 runQuery 送出，不前端切句，避免內部 ; 破壞）。
function template(kind: DbKind, type: string): string {
  if (kind === "mysql" || kind === "mariadb") {
    if (type === "procedure") return "CREATE PROCEDURE proc_name(IN p1 INT)\nBEGIN\n  SELECT p1;\nEND";
    if (type === "function") return "CREATE FUNCTION fn_name(p1 INT) RETURNS INT DETERMINISTIC\nBEGIN\n  RETURN p1 + 1;\nEND";
    if (type === "event") return "CREATE EVENT evt_name\nON SCHEDULE EVERY 1 DAY\nCOMMENT ''\nDO\nBEGIN\n  -- 你的排程 SQL，例如清理舊資料；\n  -- DELETE FROM logs WHERE created < NOW() - INTERVAL 30 DAY;\nEND";
    return "CREATE TRIGGER trg_name BEFORE INSERT ON table_name\nFOR EACH ROW\nBEGIN\n  -- SET NEW.col = ...;\nEND";
  }
  if (kind === "postgres") {
    if (type === "function") return "CREATE OR REPLACE FUNCTION fn_name(p1 integer)\nRETURNS integer LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN p1 + 1;\nEND;\n$$";
    if (type === "procedure") return "CREATE OR REPLACE PROCEDURE proc_name(p1 integer)\nLANGUAGE plpgsql AS $$\nBEGIN\n  -- ...\nEND;\n$$";
    return "-- 觸發器需先有回傳 trigger 的函式\nCREATE TRIGGER trg_name BEFORE INSERT ON table_name\nFOR EACH ROW EXECUTE FUNCTION trg_fn()";
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
  const schema = useSqlSchema(connId, kind, db); // 表 / 欄自動完成（程序 / 函式 / 觸發器內文亦受用）
  const [list, setList] = useState<RoutineInfo[] | null>(null);
  const [mode, setMode] = useState<"list" | "editor">("list");
  const [sqlText, setSqlText] = useState("");
  const [editingRoutine, setEditingRoutine] = useState<RoutineInfo | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [diags, setDiags] = useState<SqlDiagnostic[] | undefined>(undefined);
  const [execResult, setExecResult] = useState<{ title: string; result: QueryResult } | null>(null);

  // 編輯內容變動即清掉舊的驗證標記（避免標在已改過的位置）。
  const editSql = (v: string) => { setSqlText(v); if (diags) setDiags(undefined); };

  const refresh = useCallback(async () => {
    setList(null);
    try { setList(await api.listRoutines(connId, db)); }
    catch (e: any) { toast.error(e?.message ?? "讀取失敗"); setList([]); }
  }, [connId, db]);

  useEffect(() => { void refresh(); }, [refresh]);

  const openNew = (type: string) => {
    setSqlText(template(kind, type));
    setEditingRoutine(null);
    setReplace(false);
    setDiags(undefined);
    setMode("editor");
  };
  const openEdit = async (r: RoutineInfo) => {
    try {
      const def = await api.routineDefinition(connId, db, r.name, r.routine_type);
      setSqlText(def);
      setDiags(undefined);
      setEditingRoutine(r);
      // PG 函式 / 程序定義含 OR REPLACE（不需先刪）；但 PG 觸發器無 OR REPLACE，與 MySQL/SQLite 一樣需先刪後建。
      setReplace(kind !== "postgres" || r.routine_type === "trigger");
      setMode("editor");
    } catch (e: any) {
      toast.error(e?.message ?? "讀取定義失敗");
    }
  };

  const drop = async (r: RoutineInfo) => {
    if (busy) return; // 避免與執行中的 exec / 其他刪除並行送出 DDL
    const ok = await uiConfirm(`刪除${TYPE_LABEL[r.routine_type] ?? r.routine_type}「${r.name}」？此動作無法復原。`, {
      title: "刪除", danger: true, confirmText: "刪除",
    });
    if (!ok) return;
    setBusy(true);
    try { await api.execDdl(connId, buildDropRoutine(kind, db, r)); toast.success(`已刪除「${r.name}」`); refresh(); }
    catch (e: any) { toast.error(e?.message ?? "刪除失敗"); }
    finally { setBusy(false); }
  };
  // 執行函式 / 預存程序（對標 Navicat「執行函式」）：詢問引數後以 SELECT / CALL 執行並顯示結果。
  const execute = async (r: RoutineInfo) => {
    const hint = r.signature ? `引數：${r.signature}` : "無引數";
    const args = await uiPrompt(`執行${TYPE_LABEL[r.routine_type] ?? ""}「${r.name}」\n${hint}\n請輸入引數（以逗號分隔，自行加引號，如 42, 'abc'）：`, {
      title: "執行", placeholder: "（無引數可留空）",
    });
    if (args === null) return;
    setBusy(true);
    try {
      const res = await api.runQuery(connId, buildRoutineCall(kind, db, r.name, r.routine_type, args));
      setExecResult({ title: `${r.name}(${args.trim()})`, result: res });
    } catch (e: any) {
      toast.error(e?.message ?? "執行失敗");
    } finally {
      setBusy(false);
    }
  };

  // 伺服器端語法驗證（不持久化）：PG/SQLite 交易回滾、MySQL 暫存名稱試建。
  const validate = async () => {
    if (validating || busy || !sqlText.trim()) return;
    setValidating(true);
    setDiags(undefined);
    try {
      const r = await api.validateDdl(connId, db, sqlText);
      if (r.validated && r.ok) {
        toast.success("語法驗證通過");
      } else if (r.validated) {
        const where = r.line != null ? `第 ${r.line} 行：` : "";
        toast.error(`語法錯誤 — ${where}${r.message ?? ""}`);
        setDiags([{ line: r.line ?? undefined, severity: "error", message: r.message ?? "語法錯誤" }]);
      } else {
        toast.info(r.caveat ?? "已略過伺服器驗證（僅前端結構檢查）");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "驗證失敗");
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
      toast.success("已執行");
      setMode("list");
      refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "執行失敗");
    } finally {
      setBusy(false);
    }
  };

  // 由樹狀雙擊 / 右鍵帶入 initial 或 newType 時，掛載後自動進入對應模式（僅一次）。
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    if (initial) {
      opened.current = true;
      if (initialAction === "exec") void execute(initial);
      else void openEdit(initial);
    } else if (newType) {
      opened.current = true;
      openNew(newType);
    }
    // execute / openEdit / openNew 為穩定 closure，刻意精簡依賴避免重複觸發。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial, newType]);

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
          <span className="font-medium text-sm">預存程序 / 觸發器</span>
          <span className="text-xs text-fg/40 mono">{db}</span>
          {mode === "editor" && (
            <button type="button" onClick={() => setMode("list")} className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"><Icon icon={ArrowLeft} size={13} /> 返回清單</button>
          )}
        </span>
      }
      footer={mode === "editor" ? (
        <>
          <label className="text-xs text-fg/55 flex items-center gap-1.5 mr-auto">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            先刪除同名再建立（MySQL / SQLite 無 OR REPLACE 時需勾選）
          </label>
          <Button variant="secondary" onClick={() => setMode("list")}>取消</Button>
          <Button variant="secondary" onClick={validate} loading={validating} disabled={validating || busy || !sqlText.trim()}
            title="以資料庫引擎驗證語法（不會實際建立）">驗證</Button>
          <Button variant="primary" onClick={run} loading={busy} disabled={busy || !sqlText.trim()}>執行</Button>
        </>
      ) : undefined}
    >
        {mode === "list" ? (
          <>
            <div className="px-5 py-2 border-b border-fg/10 flex items-center gap-2">
              <span className="text-xs text-fg/45">新增：</span>
              {(NEW_TYPES[kind] ?? []).map((t) => (
                <button key={t} type="button" onClick={() => openNew(t)}
                  className="text-xs px-2 py-1 rounded bg-fg/5 hover:bg-fg/10 inline-flex items-center gap-1"><Icon icon={Plus} size={13} /> {TYPE_LABEL[t]}</button>
              ))}
              <button type="button" onClick={() => refresh()} className="ml-auto text-xs text-fg/40 hover:text-fg/70">重新整理</button>
            </div>
            <div className="flex-1 overflow-auto p-2">
              {list == null ? (
                <div className="text-fg/40 text-sm p-4">載入中…</div>
              ) : list.length === 0 ? (
                <div className="text-fg/40 text-sm p-4">此資料庫沒有預存程序 / 函式 / 觸發器。</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-fg/40 text-xs">
                    <tr><th className="text-left px-3 py-1.5 font-normal">名稱</th><th className="text-left px-3 py-1.5 font-normal">類型</th><th className="text-left px-3 py-1.5 font-normal">所屬表</th><th className="text-left px-3 py-1.5 font-normal whitespace-nowrap">修改時間</th><th className="text-left px-3 py-1.5 font-normal">決定性</th><th className="text-left px-3 py-1.5 font-normal">註解</th><th className="w-32 font-normal" aria-label="操作" /></tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={`${r.routine_type}:${r.name}:${r.signature ?? ""}`} className="border-t border-fg/5 hover:bg-fg/5">
                        <td className="px-3 py-1.5 mono">{r.name}{r.signature != null ? `(${r.signature})` : ""}</td>
                        <td className="px-3 py-1.5 text-fg/60">{TYPE_LABEL[r.routine_type] ?? r.routine_type}</td>
                        <td className="px-3 py-1.5 text-fg/40 mono">{r.parent ?? "—"}</td>
                        <td className="px-3 py-1.5 text-fg/40 mono whitespace-nowrap">{r.modified ?? "—"}</td>
                        <td className="px-3 py-1.5 text-fg/50">{r.deterministic == null ? "—" : r.deterministic ? "是" : "否"}</td>
                        <td className="px-3 py-1.5 text-fg/40 max-w-[180px] truncate" title={r.comment ?? ""}>{r.comment || "—"}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          {(r.routine_type === "function" || r.routine_type === "procedure") && (
                            <button type="button" onClick={() => execute(r)} disabled={busy}
                              className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40 px-1">執行</button>
                          )}
                          <button type="button" onClick={() => openEdit(r)} disabled={busy} className="text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40 px-1">編輯</button>
                          <button type="button" onClick={() => drop(r)} disabled={busy} className="text-xs text-red-400 hover:text-red-300 disabled:opacity-40 px-1">刪除</button>
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
              {editingRoutine ? `編輯：${editingRoutine.name}` : "新增"}　·　整段以單一語句執行（內部 ; 不切句）
            </div>
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
          </>
        )}
    </Modal>

      {execResult && (
        <Modal
          onClose={() => setExecResult(null)}
          size="lg"
          zClass="z-[97]"
          className="max-h-[78vh]"
          bodyClassName="overflow-auto"
          title={
            <span className="flex items-center gap-2 w-full">
              <span className="font-medium text-sm">執行結果：{execResult.title}</span>
              <span className="ml-auto text-xs text-fg/40">{execResult.result.rows.length} 筆 · 影響 {execResult.result.rows_affected}</span>
            </span>
          }
        >
          {execResult.result.columns.length === 0 ? (
                <div className="text-fg/50 text-sm p-5">已執行（無結果集）。</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-inset text-fg/45">
                    <tr>{execResult.result.columns.map((c) => <th key={c} className="text-left px-3 py-1.5 font-normal whitespace-nowrap">{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {execResult.result.rows.map((row, i) => (
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
              )}
        </Modal>
      )}
    </>
  );
}
