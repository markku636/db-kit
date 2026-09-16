import { useState } from "react";
import { ChevronDown, ChevronRight, ClipboardCopy, ExternalLink, MessageSquare, AlertTriangle } from "lucide-react";
import Icon from "./ui/Icon";
import { copyToClipboard, toast } from "./ui";
import { useT } from "./i18n";
import { resultToMarkdown } from "./sql";
import type { ChatRunResult } from "./chatTypes";

// 對話裡「執行」某個 SQL 區塊之後，直接貼在該區塊底下的精簡結果表。
//
// 為什麼不丟去查詢分頁就好：使用者問「上個月有幾筆訂單」，答案是一格數字；為了看那一格
// 而切走分頁、失去對話上下文，等於把對話打斷。小結果就地顯示、大結果再提供「在查詢分頁開啟」。

/** 就地顯示的列數上限。超過的部分要看全貌請開查詢分頁（那裡才有排序 / 篩選 / 匯出）。 */
const MAX_SHOWN = 50;

export interface ChatSqlResultProps {
  run: ChatRunResult;
  onOpenInTab: (sql: string) => void;
  /** 把這次結果回饋給模型，讓它接著分析。 */
  onFeedback: () => void;
}

export default function ChatSqlResult({ run, onOpenInTab, onFeedback }: ChatSqlResultProps) {
  const t = useT();
  // 出錯時預設展開：使用者按了執行就是想知道結果，錯誤更是非看不可。
  const [open, setOpen] = useState(true);

  const shown = run.rows.slice(0, MAX_SHOWN);
  const btn = "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-fg/55 hover:text-fg hover:bg-fg/10";

  return (
    <div className={`mt-1 rounded border ${run.error ? "border-danger/30" : "border-fg/10"} overflow-hidden`}>
      <div className="flex items-center gap-1 px-2 py-1 bg-fg/5 text-[10px] text-fg/50">
        <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 hover:text-fg">
          <Icon icon={open ? ChevronDown : ChevronRight} size={12} />
          {run.error ? (
            <span className="text-danger inline-flex items-center gap-1">
              <Icon icon={AlertTriangle} size={11} />{t("執行失敗")}
            </span>
          ) : run.columns.length === 0 ? (
            <span>{t("影響 {n} 列", { n: run.rowsAffected })}</span>
          ) : (
            <span>
              {t("{n} 列", { n: run.rows.length })}
              {run.truncated && ` · ${t("已截斷")}`}
              {` · ${run.ms} ms`}
            </span>
          )}
        </button>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className={btn} onClick={onFeedback} title={t("把這次結果交給 AI 接著分析")}>
            <Icon icon={MessageSquare} size={12} />{t("回饋給 AI")}
          </button>
          <button type="button" className={btn} onClick={() => onOpenInTab(run.sql)} title={t("在查詢分頁開啟這段 SQL")}>
            <Icon icon={ExternalLink} size={12} />{t("在查詢分頁開啟")}
          </button>
          {!run.error && run.columns.length > 0 && (
            <button type="button" className={btn}
              onClick={() => {
                copyToClipboard(resultToMarkdown({ columns: run.columns, rows: run.rows, rows_affected: run.rowsAffected, truncated: run.truncated }));
                toast.success(t("已複製結果 (Markdown)"));
              }}>
              <Icon icon={ClipboardCopy} size={12} />{t("複製")}
            </button>
          )}
        </div>
      </div>

      {open && (
        run.error ? (
          <pre className="p-2 text-[11px] mono whitespace-pre-wrap break-words text-danger">{run.error}</pre>
        ) : run.columns.length === 0 ? (
          <div className="p-2 text-[11px] text-fg/50">{t("（沒有結果集）")}</div>
        ) : (
          <div className="max-h-64 overflow-auto">
            <table className="text-[11px] border-collapse w-full">
              <thead className="sticky top-0 bg-panel">
                <tr>
                  {run.columns.map((c, i) => (
                    <th key={i} className="border border-fg/10 px-1.5 py-0.5 text-left font-semibold whitespace-nowrap">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((cell, ci) => (
                      <td key={ci} className="border border-fg/10 px-1.5 py-0.5 align-top max-w-[18rem] truncate"
                        title={cell ?? undefined}>
                        {cell === null ? <span className="text-fg/30 italic">NULL</span> : cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {run.rows.length > MAX_SHOWN && (
              <div className="px-2 py-1 text-[10px] text-fg/40">
                {t("僅顯示前 {shown} 列，共 {total} 列；完整結果請在查詢分頁開啟。", { shown: MAX_SHOWN, total: run.rows.length })}
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}
