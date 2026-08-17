import { useCallback, useEffect, useState } from "react";
import { Server } from "lucide-react";
import { api, QueryResult } from "./api";
import { Modal, Button } from "./ui/index";
import { useColWidths, ColResizer, COL_FONT_XS } from "./ui/useColWidths";
import { useT } from "./i18n";

// hooks 不能條件呼叫：res 尚未載入時以穩定的空陣列餵 useColWidths。
const NO_COLS: string[] = [];
const NO_ROWS: (string | null)[][] = [];

// 通用唯讀結果檢視器：執行一段 SQL（如使用者 / 角色、伺服器變數）並以表格呈現，可重新整理。
export default function ServerQueryDialog({ connId, title, sql, onClose }: {
  connId: string;
  title: string;
  sql: string;
  onClose: () => void;
}) {
  const t = useT();
  const [res, setRes] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api.runQuery(connId, sql));
    } catch (e: any) {
      setErr(e?.message ?? t("讀取失敗"));
    } finally {
      setBusy(false);
    }
  }, [connId, sql]);

  useEffect(() => { void refresh(); }, [refresh]);

  // 欄寬：自動量測 + 拖曳表頭右緣調整（與查詢結果格同手感）。
  const { colWidth, tableWidth, startResize, resetCol } =
    useColWidths(res?.columns ?? NO_COLS, res?.rows ?? NO_ROWS, { font: COL_FONT_XS });

  return (
    <Modal
      onClose={onClose}
      icon={Server}
      size="xl"
      zClass="z-[95]"
      className="!w-[860px] max-w-[96vw] h-[78vh]"
      bodyClassName="overflow-auto"
      title={
        <>
          <span className="font-medium text-sm">{title}</span>
          {res && <span className="text-xs text-fg/40 ml-2">{res.rows.length} {t("筆")}</span>}
          <button type="button" onClick={() => refresh()} disabled={busy}
            className="ml-auto text-xs text-blue-400 hover:text-blue-300 disabled:opacity-40">{busy ? t("讀取中…") : t("重新整理")}</button>
        </>
      }
      footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}
    >
      {err ? (
        <div className="text-red-300 text-sm p-5 mono whitespace-pre-wrap">{err}</div>
      ) : !res ? (
        <div className="text-fg/40 text-sm p-5">{t("讀取中…")}</div>
      ) : res.rows.length === 0 ? (
        <div className="text-fg/40 text-sm p-5">{t("（無資料）")}</div>
      ) : (
        <table className="text-xs" style={{ tableLayout: "fixed", width: tableWidth() }}>
          <thead className="sticky top-0 bg-inset text-fg/45">
            <tr>{res.columns.map((c, ci) => (
              <th key={c} style={{ width: colWidth(ci) }}
                className="relative text-left px-3 py-1.5 font-normal whitespace-nowrap overflow-hidden text-ellipsis">
                {c}
                <ColResizer onStart={(e) => startResize(ci, e)} onReset={() => resetCol(ci)} />
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {res.rows.map((row, i) => (
              <tr key={i} className="border-t border-fg/5 hover:bg-fg/5">
                {row.map((v, j) => (
                  <td key={j} className="px-3 py-1 mono text-fg/80 truncate" title={v ?? "NULL"}>
                    {v ?? <span className="text-fg/30">NULL</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
