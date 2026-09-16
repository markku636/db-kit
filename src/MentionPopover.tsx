import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Table2, Database, FileText, Sparkles, Check, Search } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Icon from "./ui/Icon";
import { fuzzyFilter } from "./fuzzy";
import { useT } from "./i18n";

// 聊天輸入框上方的補全浮層：`@` 挑資料表 / 資料庫 / 檔案 / 特殊情境，`/` 挑指令，
// 以及「範圍」按鈕的多選勾選模式。
//
// 鍵盤由父層（textarea 的 onKeyDown）驅動而非自己掛 listener：輸入焦點必須留在 textarea，
// 使用者才能邊打字邊縮小清單；浮層若自己搶焦點，每選一次就得再點回輸入框。

export type MentionGroup = "special" | "table" | "view" | "db" | "file" | "command";

export interface PopoverItem {
  id: string;
  label: string;
  hint?: string;
  group: MentionGroup;
  /** 選中後要插進輸入框的字串（多選模式改用 id 比對，不用這個）。 */
  insert: string;
}

/** 父層透過 ref 驅動鍵盤操作。 */
export interface MentionPopoverHandle {
  move: (delta: number) => void;
  /** 取目前選取項（Enter / Tab 用）；清單為空回 null。 */
  pick: () => PopoverItem | null;
}

const GROUP_ICON: Record<MentionGroup, LucideIcon> = {
  special: Sparkles,
  table: Table2,
  view: Table2,
  db: Database,
  file: FileText,
  command: Sparkles,
};

const GROUP_LABEL: Record<MentionGroup, string> = {
  special: "情境",
  table: "資料表",
  view: "視圖",
  db: "資料庫",
  file: "檔案",
  command: "指令",
};

export interface MentionPopoverProps {
  items: PopoverItem[];
  /** 已輸入的過濾字（`@ord` 的 `ord`）。 */
  query: string;
  loading?: boolean;
  onPick: (item: PopoverItem) => void;
  onClose: () => void;
  /** 多選模式（「範圍」按鈕）：顯示勾選框與「完成」。 */
  multi?: { selected: Set<string>; onToggle: (id: string) => void; onDone: () => void };
}

const MentionPopover = forwardRef<MentionPopoverHandle, MentionPopoverProps>(function MentionPopover(
  { items, query, loading, onPick, onClose, multi }, ref,
) {
  const t = useT();
  const [sel, setSel] = useState(0);
  const [localQ, setLocalQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  // 多選模式有自己的搜尋框（它不是跟著輸入框打字來的）；單選模式吃父層傳進來的 query。
  const effectiveQ = multi ? localQ : query;
  const filtered = useMemo(
    () => fuzzyFilter(effectiveQ, items, (x) => `${x.label} ${x.hint ?? ""}`, 30),
    [effectiveQ, items],
  );

  useEffect(() => { setSel(0); }, [effectiveQ, items]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  useImperativeHandle(ref, () => ({
    move: (delta: number) => setSel((s) => Math.max(0, Math.min(s + delta, filtered.length - 1))),
    pick: () => filtered[sel] ?? null,
  }), [filtered, sel]);

  // 清單空了就自己收掉：留一個「無相符項目」的空框擋在輸入框上方只會礙事。
  useEffect(() => {
    if (!loading && !multi && filtered.length === 0) onClose();
  }, [loading, multi, filtered.length, onClose]);

  let lastGroup: MentionGroup | null = null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 z-20 bg-elevated border border-fg/10 rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-64">
      {multi && (
        <div className="flex items-center gap-2 px-2 h-8 border-b border-fg/10 shrink-0">
          <Icon icon={Search} size={13} className="text-fg/40" />
          {/* 多選面板是使用者主動按開的，焦點就該落在搜尋框（與命令面板同一慣例）。 */}
          <input ref={(el) => el?.focus()} value={localQ} onChange={(e) => setLocalQ(e.target.value)}
            placeholder={t("搜尋資料表…")}
            className="flex-1 bg-transparent outline-none text-xs" />
          <button type="button" onClick={multi.onDone}
            className="text-[11px] px-1.5 py-0.5 rounded bg-accent text-white hover:bg-accent/90">{t("完成")}</button>
        </div>
      )}
      <div ref={listRef} className="overflow-auto py-1 min-h-0">
        {loading && filtered.length === 0 ? (
          <div className="px-3 py-3 text-center text-[11px] text-fg/40">{t("載入中…")}</div>
        ) : filtered.length === 0 ? (
          <div className="px-3 py-3 text-center text-[11px] text-fg/40">{t("無相符項目")}</div>
        ) : (
          filtered.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const on = multi?.selected.has(it.id) ?? false;
            return (
              <div key={it.id}>
                {head && (
                  <div className="px-2 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-fg/30">{t(GROUP_LABEL[head])}</div>
                )}
                <button type="button" data-idx={i}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={(e) => { e.preventDefault(); if (multi) multi.onToggle(it.id); else onPick(it); }}
                  className={`flex items-center gap-2 w-full text-left px-2 py-1 text-[12px] ${i === sel ? "bg-accent/15 text-accent" : "text-fg/80 hover:bg-fg/5"}`}>
                  {multi ? (
                    <span className={`w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center ${on ? "bg-accent border-accent" : "border-fg/25"}`}>
                      {on && <Icon icon={Check} size={10} className="text-white" />}
                    </span>
                  ) : (
                    <Icon icon={GROUP_ICON[it.group]} size={12} className={i === sel ? "text-accent" : "text-fg/40"} />
                  )}
                  <span className="truncate">{it.label}</span>
                  {it.hint && <span className="ml-auto shrink-0 text-[10px] text-fg/35 truncate max-w-[40%]">{it.hint}</span>}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});

export default MentionPopover;
