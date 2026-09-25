// 對話裡 ```bash 區塊底下的執行結果格：使用者按「執行並回饋」後，擷取到的終端機輸出（已去 ANSI）。
// 與 ChatSqlResult 並列；shell 沒有表格可畫，就是一段等寬文字加摘要列。
import { useState } from "react";
import { ChevronDown, ChevronRight, Sparkles, ClipboardCopy } from "lucide-react";
import type { ChatShellRun } from "./chatTypes";
import { useT } from "./i18n";
import Icon from "./ui/Icon";
import { copyToClipboard } from "./ui";
import { fmtElapsed } from "./sql";

const SHOW_CHARS = 4096;

export default function ChatShellResult({ run, onFeedback }: {
  run: ChatShellRun;
  /** 把這次結果回饋給 AI 接著分析（不重跑）。 */
  onFeedback?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const body = run.output.length > SHOW_CHARS ? `${run.output.slice(0, SHOW_CHARS)}\n…` : run.output;
  const lines = run.output ? run.output.split("\n").length : 0;
  return (
    <div className="border-t border-fg/10 bg-fg/[0.03]">
      <div className="flex items-center gap-2 px-2 py-1 text-[10px] text-fg/50">
        <button type="button" onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 hover:text-fg">
          <Icon icon={open ? ChevronDown : ChevronRight} size={11} />
          <span className="mono">{run.host}</span>
        </button>
        {run.error ? (
          <span className="text-danger">{t("送出失敗：{msg}", { msg: run.error })}</span>
        ) : (
          <span>{t("{n} 行輸出 · {ms}", { n: lines, ms: fmtElapsed(run.durationMs) })}</span>
        )}
        {run.truncated && <span className="px-1 rounded bg-warning/15 text-warning">{t("已截斷")}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          {run.output && (
            <button type="button" className="px-1.5 py-0.5 rounded hover:text-fg hover:bg-fg/10"
              onClick={() => void copyToClipboard(run.output, t("已複製輸出"))}>
              <span className="inline-flex items-center gap-0.5"><Icon icon={ClipboardCopy} size={11} />{t("複製輸出")}</span>
            </button>
          )}
          {onFeedback && (
            <button type="button" className="px-1.5 py-0.5 rounded hover:text-fg hover:bg-fg/10" onClick={onFeedback}>
              <span className="inline-flex items-center gap-0.5"><Icon icon={Sparkles} size={11} />{t("回饋給 AI")}</span>
            </button>
          )}
        </div>
      </div>
      {open && (
        <pre className="max-h-56 overflow-auto px-2 pb-2 text-[11px] mono leading-relaxed whitespace-pre-wrap break-words text-fg/75">
          {body || <span className="text-fg/35">{t("（沒有輸出）")}</span>}
        </pre>
      )}
    </div>
  );
}
