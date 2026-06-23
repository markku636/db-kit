import { useCallback, useEffect, useState } from "react";
import { api, DbKind, RoutineInfo } from "./api";
import { quoteIdent, qualifiedName } from "./sql";
import { toast, uiConfirm } from "./ui";

const TYPE_LABEL: Record<string, string> = { procedure: "預存程序", function: "函式", trigger: "觸發器" };

// 各資料庫可新增的 routine 種類。
const NEW_TYPES: Record<string, string[]> = {
  mysql: ["procedure", "function", "trigger"],
  postgres: ["function", "procedure", "trigger"],
  sqlite: ["trigger"],
};

// 單一 CREATE 語句範本（執行時整段以一次 runQuery 送出，不前端切句，避免內部 ; 破壞）。
function template(kind: DbKind, type: string): string {
  if (kind === "mysql") {
    if (type === "procedure") return "CREATE PROCEDURE proc_name(IN p1 INT)\nBEGIN\n  SELECT p1;\nEND";
    if (type === "function") return "CREATE FUNCTION fn_name(p1 INT) RETURNS INT DETERMINISTIC\nBEGIN\n  RETURN p1 + 1;\nEND";
    return "CREATE TRIGGER trg_name BEFORE INSERT ON table_name\nFOR EACH ROW\nBEGIN\n  -- SET NEW.col = ...;\nEND";
  }
  if (kind === "postgres") {
    if (type === "function") return "CREATE OR REPLACE FUNCTION fn_name(p1 integer)\nRETURNS integer LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN p1 + 1;\nEND;\n$$";
    if (type === "procedure") return "CREATE OR REPLACE PROCEDURE proc_name(p1 integer)\nLANGUAGE plpgsql AS $$\nBEGIN\n  -- ...\nEND;\n$$";
    return "-- 觸發器需先有回傳 trigger 的函式\nCREATE TRIGGER trg_name BEFORE INSERT ON table_name\nFOR EACH ROW EXECUTE FUNCTION trg_fn()";
  }
  return "CREATE TRIGGER trg_name AFTER INSERT ON table_name\nBEGIN\n  -- ...\nEND";
}

// 組 DROP 語句（刪除 / 先刪後建用）。
function buildDropRoutine(kind: DbKind, db: string, r: RoutineInfo): string {
  const t = r.routine_type;
  if (kind === "mysql") {
    const kw = t === "procedure" ? "PROCEDURE" : t === "function" ? "FUNCTION" : "TRIGGER";
    return `DROP ${kw} IF EXISTS ${qualifiedName(kind, db, r.name)}`;
  }
  if (kind === "postgres") {
    if (t === "trigger") return `DROP TRIGGER IF EXISTS ${quoteIdent(kind, r.name)} ON ${qualifiedName(kind, db, r.parent ?? "")}`;
    // 帶引數簽章以消除重載歧義（PG 對重載函式無簽章的 DROP 會報 "is not unique"）。
    const sig = r.signature ?? "";
    return `DROP ${t === "procedure" ? "PROCEDURE" : "FUNCTION"} IF EXISTS ${qualifiedName(kind, db, r.name)}(${sig})`;
  }
  return `DROP TRIGGER IF EXISTS ${quoteIdent(kind, r.name)}`;
}

export default function RoutinesDialog({ connId, db, kind, onClose }: {
  connId: string;
  db: string;
  kind: DbKind;
  onClose: () => void;
}) {
  const [list, setList] = useState<RoutineInfo[] | null>(null);
  const [mode, setMode] = useState<"list" | "editor">("list");
  const [sqlText, setSqlText] = useState("");
  const [editingRoutine, setEditingRoutine] = useState<RoutineInfo | null>(null);
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);

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
    setMode("editor");
  };
  const openEdit = async (r: RoutineInfo) => {
    try {
      const def = await api.routineDefinition(connId, db, r.name, r.routine_type);
      setSqlText(def);
      setEditingRoutine(r);
      // PG 函式 / 程序定義含 OR REPLACE（不需先刪）；但 PG 觸發器無 OR REPLACE，與 MySQL/SQLite 一樣需先刪後建。
      setReplace(kind !== "postgres" || r.routine_type === "trigger");
      setMode("editor");
    } catch (e: any) {
      toast.error(e?.message ?? "讀取定義失敗");
    }
  };
  const drop = async (r: RoutineInfo) => {
    const ok = await uiConfirm(`刪除${TYPE_LABEL[r.routine_type] ?? r.routine_type}「${r.name}」？此動作無法復原。`, {
      title: "刪除", danger: true, confirmText: "刪除",
    });
    if (!ok) return;
    try { await api.execDdl(connId, buildDropRoutine(kind, db, r)); toast.success(`已刪除「${r.name}」`); refresh(); }
    catch (e: any) { toast.error(e?.message ?? "刪除失敗"); }
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[95]" onClick={onClose}>
      <div className="bg-[#1a212b] w-[720px] max-w-[94vw] h-[78vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 flex items-center gap-2">
          <span className="font-medium text-sm">預存程序 / 觸發器</span>
          <span className="text-xs text-white/40 mono">{db}</span>
          {mode === "editor" && (
            <button type="button" onClick={() => setMode("list")} className="text-xs text-blue-400 hover:text-blue-300">← 返回清單</button>
          )}
          <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white">✕</button>
        </div>

        {mode === "list" ? (
          <>
            <div className="px-5 py-2 border-b border-white/10 flex items-center gap-2">
              <span className="text-xs text-white/45">新增：</span>
              {(NEW_TYPES[kind] ?? []).map((t) => (
                <button key={t} type="button" onClick={() => openNew(t)}
                  className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10">＋ {TYPE_LABEL[t]}</button>
              ))}
              <button type="button" onClick={() => refresh()} className="ml-auto text-xs text-white/40 hover:text-white/70">重新整理</button>
            </div>
            <div className="flex-1 overflow-auto p-2">
              {list == null ? (
                <div className="text-white/40 text-sm p-4">載入中…</div>
              ) : list.length === 0 ? (
                <div className="text-white/40 text-sm p-4">此資料庫沒有預存程序 / 函式 / 觸發器。</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-white/40 text-xs">
                    <tr><th className="text-left px-3 py-1.5 font-normal">名稱</th><th className="text-left px-3 py-1.5 font-normal">類型</th><th className="text-left px-3 py-1.5 font-normal">所屬表</th><th className="w-32 font-normal" aria-label="操作" /></tr>
                  </thead>
                  <tbody>
                    {list.map((r) => (
                      <tr key={`${r.routine_type}:${r.name}:${r.signature ?? ""}`} className="border-t border-white/5 hover:bg-white/5">
                        <td className="px-3 py-1.5 mono">{r.name}{r.signature != null ? `(${r.signature})` : ""}</td>
                        <td className="px-3 py-1.5 text-white/60">{TYPE_LABEL[r.routine_type] ?? r.routine_type}</td>
                        <td className="px-3 py-1.5 text-white/40 mono">{r.parent ?? "—"}</td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <button type="button" onClick={() => openEdit(r)} className="text-xs text-blue-400 hover:text-blue-300 px-1">編輯</button>
                          <button type="button" onClick={() => drop(r)} className="text-xs text-red-400 hover:text-red-300 px-1">刪除</button>
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
            <div className="px-5 py-2 border-b border-white/10 text-xs text-white/40">
              {editingRoutine ? `編輯：${editingRoutine.name}` : "新增"}　·　整段以單一語句執行（內部 ; 不切句）
            </div>
            <textarea
              value={sqlText}
              onChange={(e) => setSqlText(e.target.value)}
              spellCheck={false}
              title="DDL 編輯器"
              placeholder="CREATE PROCEDURE / FUNCTION / TRIGGER …"
              className="flex-1 m-3 bg-black/40 border border-white/10 rounded p-3 text-sm mono outline-none focus:border-blue-500 resize-none"
            />
            <div className="px-5 py-3 border-t border-white/10 flex items-center gap-3">
              <label className="text-xs text-white/55 flex items-center gap-1.5">
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
                先刪除同名再建立（MySQL / SQLite 無 OR REPLACE 時需勾選）
              </label>
              <button type="button" onClick={() => setMode("list")}
                className="ml-auto px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">取消</button>
              <button type="button" onClick={run} disabled={busy || !sqlText.trim()}
                className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40">
                {busy ? "執行中…" : "執行"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
