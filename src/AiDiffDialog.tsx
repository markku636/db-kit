import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { sql, StandardSQL } from "@codemirror/lang-sql";
import { unifiedMergeView } from "@codemirror/merge";
import { AlertTriangle, ClipboardCopy, Check, RotateCw, Square, X, ExternalLink, GitCompare } from "lucide-react";
import type { DbKind } from "./api";
import { Button, Modal } from "./ui/index";
import Icon from "./ui/Icon";
import { copyToClipboard, toast } from "./ui";
import { useT } from "./i18n";
import { useTheme } from "./theme";
import { resolveEditorTheme } from "./editorThemes";
import { DIALECT } from "./SqlEditor";
import { extractSqlProposal, isDestructive } from "./aiActions";
import { useOneShotGenerate } from "./useOneShotGenerate";
import { diffLines } from "./diff";
import { isDangerousStatement, splitSqlStatements } from "./sql";

// AI 改寫的差異預覽：串流生成 → 擷取語句 → 與原文並排比對 → 接受才寫回編輯器。
//
// 為什麼非要 diff 不可：先前「貼到編輯器」是整段覆蓋，使用者無從得知模型到底改了哪幾行，
// 於是只有兩種用法——盲目接受，或整段丟掉自己重打。有了逐塊差異與逐塊拒絕，
// 「模型改對了八成」這種最常見的情況才真的可用。
//
// 用 @codemirror/merge 的 unifiedMergeView 而非自己畫 diff：它給的是「提案文件本身可編輯 +
// 每塊可單獨拒絕」，接受時取的是使用者微調過的最終文字；自製的行 diff 只能全有或全無。

export interface AiDiffDialogProps {
  title: string;
  kind: DbKind;
  /** 這次改寫的範圍描述（選取範圍 / 游標所在語句 / 整個編輯器），顯示在標題列下。 */
  scopeLabel: string;
  /** 原文（要被取代的那一段）。 */
  original: string;
  /** 送給模型的提示；「重新生成」會再送一次同一份。 */
  prompt: string;
  /**
   * 編輯器內容是否已經變動到無法就地套用。父層比對「當初那段文字是否還在原位」，
   * 變了就只能另開分頁——直接照舊位移覆蓋會砍掉使用者自己新打的字。
   */
  isStale: () => boolean;
  onAccept: (finalSql: string) => void;
  onOpenInNewTab: (finalSql: string) => void;
  onClose: () => void;
}

export default function AiDiffDialog({
  title, kind, scopeLabel, original, prompt, isStale, onAccept, onOpenInNewTab, onClose,
}: AiDiffDialogProps) {
  const t = useT();
  const themeId = useTheme((s) => s.themeId);
  const appTheme = useTheme((s) => s.theme);
  const { text, running, error, run, cancel } = useOneShotGenerate({ mode: "edit" });
  // 使用者在 merge 視圖裡的最終文字（逐塊拒絕 / 手動微調之後）。
  const [draft, setDraft] = useState<string | null>(null);
  const [noStatement, setNoStatement] = useState(false);
  const startedRef = useRef(false);

  // 掛載即生成一次。ref 守衛：StrictMode 的雙重 effect 會送出兩次請求、燒兩份額度。
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run(prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 串流結束才擷取：途中的 ``` 是半截的，提早擷取只會拿到殘缺語句。
  useEffect(() => {
    if (running) return;
    if (!text.trim()) return;
    const code = extractSqlProposal(text);
    setDraft(code);
    setNoStatement(code == null);
  }, [running, text]);

  const regenerate = () => {
    setDraft(null);
    setNoStatement(false);
    void run(prompt);
  };

  const dialect = DIALECT[kind] ?? StandardSQL;
  const theme = resolveEditorTheme(themeId, appTheme);

  // merge 視圖：doc = 提案、original = 原文。extensions 以 original 為相依重建即可
  // （draft 只在第一次擷取時設定，之後由使用者在編輯器內改，不該觸發重建）。
  //
  // mergeControls 傳 render 函式而非 true：預設畫的是英文 Accept / Reject，而這個 app 的
  // 介面語言是跟著設定走的。順帶讓按鈕吃 app 的色票，不然它自帶的樣式在暗色主題下幾乎看不見。
  const mergeExt = useMemo<Extension[]>(
    () => [
      sql({ dialect, upperCaseKeywords: true }),
      EditorView.lineWrapping,
      unifiedMergeView({
        original,
        highlightChanges: true,
        gutter: true,
        // 只改一個欄名這種「單行內的小異動」攤成一刪一增兩行反而難讀，讓它就地標出來。
        allowInlineDiffs: true,
        mergeControls: (type, action) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = type === "accept" ? t("採用") : t("還原");
          b.title = type === "accept" ? t("保留這一塊的修改") : t("這一塊改回原本的內容");
          b.className = `mx-0.5 px-1 rounded text-[10px] border ${
            type === "accept"
              ? "border-emerald-400/40 text-emerald-300 hover:bg-emerald-400/10"
              : "border-fg/20 text-fg/50 hover:bg-fg/10"
          }`;
          b.onclick = action;
          return b;
        },
      }),
    ],
    // t 進相依：切語言時按鈕文字要跟著換。
    [original, dialect, t],
  );
  const streamExt = useMemo<Extension[]>(() => [sql({ dialect, upperCaseKeywords: true }), EditorView.lineWrapping], [dialect]);

  const final = draft ?? "";
  const stale = !running && !!draft && isStale();
  // 破壞性偵測走兩套判準：aiActions 的粗篩（DROP/TRUNCATE/ALTER、無 WHERE 的 DML）
  // 與 sql.ts 逐句、會剝掉註解與子查詢的嚴格版。任一命中就示警，寧可多提醒。
  const dangerous = !!draft && (isDestructive(final) || splitSqlStatements(final).some(isDangerousStatement));

  // 行數增減：讓使用者一眼判斷「模型只動了兩行」還是「整段重寫」。
  const counts = useMemo(() => {
    if (!draft) return null;
    const d = diffLines(original, final);
    return { add: d.filter((l) => l.type === "add").length, del: d.filter((l) => l.type === "del").length };
  }, [draft, original, final]);

  const accept = () => {
    if (!draft || stale) return;
    onAccept(final);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      icon={GitCompare}
      size="xl"
      codeZoom
      // 差異視圖裡的每一次逐塊拒絕都是工作成果，點到背板就整個消失太容易誤觸。
      dismissOnBackdrop={false}
      bodyClassName=""
      footer={
        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="secondary" icon={Square} onClick={cancel}>{t("停止")}</Button>
          ) : (
            <Button variant="primary" icon={Check} onClick={accept} disabled={!draft || stale}>{t("接受")}</Button>
          )}
          <Button variant="ghost" icon={X} onClick={onClose}>{t("拒絕")}</Button>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" icon={RotateCw} onClick={regenerate} disabled={running}>{t("重新生成")}</Button>
            <Button variant="ghost" icon={ClipboardCopy} onClick={() => void copyToClipboard(final)} disabled={!draft}>{t("複製")}</Button>
            <Button variant="secondary" icon={ExternalLink} onClick={() => { onOpenInNewTab(final); onClose(); }} disabled={!draft}>
              {t("在新分頁開啟")}
            </Button>
          </div>
        </div>
      }
    >
      <div className="px-5 pt-3 pb-2 flex flex-wrap items-center gap-2 text-[11px] text-fg/50 border-b border-fg/10">
        <span className="px-1.5 py-0.5 rounded bg-fg/10">{scopeLabel}</span>
        {counts && (
          <span className="mono">
            <span className="text-emerald-400">+{counts.add}</span>{" "}
            <span className="text-danger">−{counts.del}</span>
          </span>
        )}
        {running && <span className="animate-pulse">{t("生成中…")}</span>}
        <span className="ml-auto">{t("可逐塊拒絕，也能直接在下方編輯後再接受")}</span>
      </div>

      {stale && (
        <div className="mx-5 mt-2 flex items-start gap-1.5 text-[11px] text-amber-200/90 bg-amber-500/10 rounded px-2 py-1.5">
          <Icon icon={AlertTriangle} size={13} className="shrink-0 mt-px" />
          {t("編輯器內容已變更，無法就地套用；請改用「在新分頁開啟」或「複製」。")}
        </div>
      )}
      {dangerous && !stale && (
        <div className="mx-5 mt-2 flex items-start gap-1.5 text-[11px] text-danger bg-danger/10 rounded px-2 py-1.5">
          <Icon icon={AlertTriangle} size={13} className="shrink-0 mt-px" />
          {t("這段語句含破壞性操作，套用前請再確認一次。")}
        </div>
      )}
      {error && (
        <div className="mx-5 mt-2 text-[11px] text-danger bg-danger/10 rounded px-2 py-1.5">⚠ {error}</div>
      )}

      <div className="px-5 py-3">
        <div className="rounded border border-fg/10 overflow-hidden" style={{ height: "24rem" }}>
          {draft != null ? (
            <CodeMirror
              value={draft}
              onChange={setDraft}
              theme={theme}
              extensions={mergeExt}
              height="100%"
              basicSetup={{ lineNumbers: true, foldGutter: false, autocompletion: false, highlightActiveLine: false }}
            />
          ) : (
            // 生成途中顯示原始串流文字（可能還夾著說明段落），讓使用者看得到進度。
            <CodeMirror
              value={text || t("（等待模型回應…）")}
              editable={false}
              theme={theme}
              extensions={streamExt}
              height="100%"
              basicSetup={{ lineNumbers: false, foldGutter: false, autocompletion: false, highlightActiveLine: false }}
            />
          )}
        </div>
        {noStatement && !running && (
          <div className="mt-2 text-[11px] text-fg/50">{t("未取得語句，請重試或改寫描述")}</div>
        )}
      </div>
    </Modal>
  );
}

// 給父層用的小工具：接受後提示可復原（replaceRange 走 dispatch，Ctrl+Z 能退回）。
export function toastAccepted(msg: string) {
  toast.success(msg);
}
