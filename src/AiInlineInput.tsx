import { useEffect, useRef, useState } from "react";
import { Sparkles, CornerDownLeft, X } from "lucide-react";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// Ctrl+I 的就地指示輸入框（Cursor 風）：浮在選取段上方，輸入「把這段改成用 CTE」之類的
// 自然語言指示，送出後走與其他 AI 動作相同的差異預覽。
//
// 刻意做成浮動小框而不是對話框：使用者要一邊看著那段 SQL 一邊描述要改什麼，
// 對話框會把它蓋掉，等於要先記住程式碼再打字。

export interface AiInlineInputProps {
  /** 錨點（選取段起點的畫面座標）；null 時退到編輯器左上角。 */
  anchor: { left: number; top: number } | null;
  /** 這次指示的作用範圍描述，讓使用者確認自己框對了地方。 */
  scopeLabel: string;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}

export default function AiInlineInput({ anchor, scopeLabel, onSubmit, onClose }: AiInlineInputProps) {
  const t = useT();
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { ref.current?.focus(); }, []);

  // Esc 關閉：掛在 window 而非 textarea，因為使用者可能已經點到框外。
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
  };

  // 夾在視窗內：選取段若靠近右緣或底部，照原座標畫會有一半在畫面外。
  const width = 420;
  const left = anchor ? Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)) : 16;
  const top = anchor ? Math.max(8, anchor.top - 96) : 80;

  return (
    <>
      {/* 點框外即關閉；透明背板同時擋住編輯器的點擊（避免游標跑掉、選取範圍變動）。 */}
      <div className="fixed inset-0 z-[110]" onMouseDown={onClose} />
      <div className="fixed z-[111] bg-elevated border border-fg/10 rounded-lg shadow-2xl p-2 space-y-1.5"
        style={{ left, top, width }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5 text-[11px] text-fg/50">
          <Icon icon={Sparkles} size={12} className="text-accent" />
          <span className="font-medium text-fg/70">{t("用自然語言修改這段")}</span>
          <span className="px-1.5 py-0.5 rounded bg-fg/10">{scopeLabel}</span>
          <button type="button" onClick={onClose} className="ml-auto text-fg/40 hover:text-fg/70">
            <Icon icon={X} size={14} />
          </button>
        </div>
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={2}
          placeholder={t("例如：改用 CTE 改寫、加上分頁、把 JOIN 換成 EXISTS…（Enter 送出、Esc 取消）")}
          className="w-full resize-none bg-inset border border-fg/10 rounded px-2 py-1.5 text-sm outline-none focus:border-accent"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
        />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-fg/35">{t("會先顯示差異，確認後才套用")}</span>
          <button type="button" onClick={submit} disabled={!value.trim()}
            className="ml-auto inline-flex items-center gap-1 h-7 px-2.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-30 text-xs">
            <Icon icon={CornerDownLeft} size={12} />{t("送出")}
          </button>
        </div>
      </div>
    </>
  );
}
