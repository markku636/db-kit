import { useMemo, useState } from "react";
import { api, DbKind, QueryResult, RoutineInfo } from "./api";
import { buildRoutineExecSql, parseRoutineParams, usesSessionVars, type RoutineParam } from "./routineParams";
import { toast } from "./ui";
import { Modal, Button, Input, Textarea } from "./ui/index";
import { useT } from "./i18n";

// 執行預存程序 / 函式的引數表單（對標 Navicat 的「執行函式」輸入視窗）。
//
// 取代原本那個「請輸入引數（以逗號分隔，自行加引號）」的單行 prompt：那個寫法要使用者自己記得
// 引數順序、自己判斷哪些要加引號，而且完全看不出程序到底收幾個參數——簽章沒查回來時它甚至
// 一律說「無引數」。改成一格一引數後，順序與型別由畫面給，引號由 routineArgLiteral 負責。
//
// 產生的 SQL 一律攤在下方讓人看得見：這是唯一能讓「我以為我傳的」與「實際送出的」對得起來的方式，
// 也是運算式（NOW() / 子查詢）這種表單表達不了的東西的逃生口——勾「編輯 SQL」就能直接改。

const MODE_TONE: Record<string, string> = {
  IN: "text-sky-400/80",
  OUT: "text-amber-400/80",
  INOUT: "text-violet-400/80",
};

function ParamRow({ p, index, value, onChange, readOnly }: {
  p: RoutineParam;
  index: number;
  value: string;
  onChange: (v: string) => void;
  readOnly: boolean;
}) {
  const t = useT();
  const isOut = p.mode === "OUT";
  return (
    <div className="grid grid-cols-[3.5rem_minmax(6rem,1fr)_minmax(6rem,1fr)_2fr] items-center gap-2 px-1 py-1">
      <span className={`text-[11px] mono ${MODE_TONE[p.mode] ?? "text-fg/30"}`}>{p.mode || "—"}</span>
      <span className="text-xs mono text-fg/80 truncate" title={p.name}>{p.name || `#${index + 1}`}</span>
      <span className="text-xs mono text-fg/40 truncate" title={p.type}>{p.type || "—"}</span>
      {isOut ? (
        // OUT 沒有輸入值可填——它的值是程序寫回來的，執行後在結果集看到。
        <span className="text-xs text-fg/35 px-2">{t("（輸出，執行後顯示）")}</span>
      ) : (
        <Input
          inputSize="sm"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={readOnly}
          placeholder={t("留空 = NULL")}
        />
      )}
    </div>
  );
}

export default function RoutineExecDialog({ connId, db, kind, routine, onClose, onResult }: {
  connId: string;
  db: string;
  kind: DbKind;
  routine: RoutineInfo;
  onClose: () => void;
  onResult: (title: string, results: QueryResult[]) => void;
}) {
  const t = useT();
  const params = useMemo(() => parseRoutineParams(kind, routine.signature), [kind, routine.signature]);
  const [values, setValues] = useState<string[]>(() => params.map(() => ""));
  const [manual, setManual] = useState(false);
  const [manualSql, setManualSql] = useState("");
  const [busy, setBusy] = useState(false);

  const generated = useMemo(
    () => buildRoutineExecSql(kind, db, routine, params, values),
    [kind, db, routine, params, values],
  );
  const sql = manual ? manualSql : generated.sql;

  // 進入手動模式時把目前產生的 SQL 帶過去當起點；退出則丟掉手改內容回到表單產生的版本。
  const toggleManual = (on: boolean) => {
    if (on) setManualSql(generated.sql);
    setManual(on);
  };

  const setValue = (i: number, v: string) =>
    setValues((prev) => { const next = [...prev]; next[i] = v; return next; });

  const hasOut = params.some((p) => p.mode === "OUT" || p.mode === "INOUT");
  const outUnsupported = hasOut && !usesSessionVars(kind);

  const run = async () => {
    if (busy || !sql.trim()) return;
    setBusy(true);
    try {
      const results = await api.runQueryMulti(connId, sql);
      onResult(routine.name, results);
    } catch (e: any) {
      toast.error(e?.message ?? t("執行失敗"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      size="md"
      zClass="z-[97]"
      title={
        <span className="flex items-center gap-2">
          <span className="font-medium text-sm">
            {t(routine.routine_type === "function" ? "執行函式" : "執行預存程序")}
          </span>
          <span className="text-xs text-fg/45 mono">{routine.name}</span>
        </span>
      }
      footer={
        <>
          <label className="text-xs text-fg/55 flex items-center gap-1.5 mr-auto">
            <input type="checkbox" checked={manual} onChange={(e) => toggleManual(e.target.checked)} />
            {t("編輯 SQL")}
          </label>
          <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={run} loading={busy} disabled={busy || !sql.trim()}>{t("執行")}</Button>
        </>
      }
    >
      <div className="space-y-3">
        {params.length === 0 ? (
          <div className="text-sm text-fg/45">{t("此{kind}沒有引數，直接執行即可。", { kind: t(routine.routine_type === "function" ? "函式" : "預存程序") })}</div>
        ) : (
          <div className="rounded border border-fg/10 divide-y divide-fg/5">
            <div className="grid grid-cols-[3.5rem_minmax(6rem,1fr)_minmax(6rem,1fr)_2fr] gap-2 px-1 py-1.5 text-[11px] text-fg/35">
              <span>{t("方向")}</span><span>{t("引數")}</span><span>{t("型別")}</span><span>{t("值")}</span>
            </div>
            {params.map((p, i) => (
              <ParamRow key={`${p.name || i}`} p={p} index={i} value={values[i] ?? ""}
                onChange={(v) => setValue(i, v)} readOnly={manual} />
            ))}
          </div>
        )}

        {outUnsupported && (
          <div className="text-xs text-amber-400/80">
            {t("此連線的資料庫不支援以 session 變數接收輸出引數，OUT 值將以 NULL 傳入。")}
          </div>
        )}

        <div className="space-y-1">
          <div className="text-[11px] text-fg/35">{t("送出的 SQL")}</div>
          {manual ? (
            <Textarea
              value={manualSql}
              onChange={(e) => setManualSql(e.target.value)}
              spellCheck={false}
              rows={Math.min(10, Math.max(3, manualSql.split("\n").length))}
              className="w-full text-xs mono resize-y"
            />
          ) : (
            <pre className="bg-inset border border-fg/10 rounded px-3 py-2 text-xs mono text-fg/70 whitespace-pre-wrap break-all max-h-40 overflow-auto">{sql}</pre>
          )}
        </div>
      </div>
    </Modal>
  );
}
