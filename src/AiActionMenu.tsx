import { useState } from "react";
import { ChevronRight, Sparkles, FileText, Gauge, Wrench, MessageSquare, Repeat, Database, ListTree } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { KIND_META, type DbKind } from "./api";
import MenuPanel from "./ui/MenuPanel";
import Icon from "./ui/Icon";
import { useT } from "./i18n";
import { AI_ACTIONS, dialectTargetsFor, type AiActionId, type AiActionMeta } from "./aiActions";
import type { PaletteItem } from "./CommandPalette";

// 編輯器 AI 動作選單：右鍵、工具列「AI ▾」、命令面板三個入口共用同一份項目定義，
// 免得三處各列一份清單，之後加一個動作要改三個地方（而且一定會漏掉一個）。

/** 目前情境有哪些輸入可用，決定哪些動作可按。 */
export interface AiActionAvailability {
  kind: DbKind;
  /** 上一次執行有錯誤（「修正」才有意義）。 */
  hasError: boolean;
  /** 已跑過視覺化解釋（「白話解釋計畫」才有計畫可講）。 */
  hasPlan: boolean;
  /** 側欄選了資料表或 SQL 裡認得出表（「產生測試資料」需要）。 */
  hasTable: boolean;
}

const ICONS: Record<AiActionId, LucideIcon> = {
  explain: MessageSquare,
  optimize: Gauge,
  fix: Wrench,
  comment: FileText,
  convert: Repeat,
  testdata: Database,
  explainPlan: ListTree,
  inline: Sparkles,
};

/** 該動作在目前情境下是否可用；不可用時選單顯示為灰階並附上原因。 */
export function unavailableReason(a: AiActionMeta, av: AiActionAvailability, t: (s: string) => string): string | null {
  if (a.needs === "error" && !av.hasError) return t("沒有執行錯誤可修正");
  if (a.needs === "plan" && !av.hasPlan) return t("請先在「解釋」分頁執行視覺化解釋");
  if (a.needs === "table" && !av.hasTable) return t("請先選取一張資料表");
  return null;
}

/** 選單裡要顯示的動作（inline 是 Ctrl+I 的入口，不進選單）。 */
export function menuActions(): AiActionMeta[] {
  return AI_ACTIONS.filter((a) => a.id !== "inline");
}

/** 命令面板（Ctrl+K / AI 快選）用的項目。轉方言在快選裡攤平成每個目標一項，省一層子選單。 */
export function aiActionItems(
  av: AiActionAvailability,
  onRun: (id: AiActionId, opts?: { targetKind?: DbKind }) => void,
  t: (s: string, p?: Readonly<Record<string, string | number>>) => string,
): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const a of menuActions()) {
    const why = unavailableReason(a, av, t);
    if (a.id === "convert") {
      for (const target of dialectTargetsFor(av.kind)) {
        out.push({
          id: `ai:convert:${target}`,
          label: t("AI：轉換為 {label}", { label: KIND_META[target].label }),
          hint: t("AI 動作"),
          group: "action",
          icon: ICONS.convert,
          run: () => onRun("convert", { targetKind: target }),
        });
      }
      continue;
    }
    out.push({
      id: `ai:${a.id}`,
      label: `AI：${t(a.label)}`,
      hint: why ?? t("AI 動作"),
      group: "action",
      icon: ICONS[a.id],
      run: () => { if (!why) onRun(a.id); },
    });
  }
  return out;
}

const ITEM = "flex items-center gap-2 w-full text-left px-2.5 py-1 text-[13px] text-fg/80 hover:bg-fg/10";
const ITEM_OFF = "flex items-center gap-2 w-full text-left px-2.5 py-1 text-[13px] text-fg/25 cursor-default";

export interface AiActionMenuProps {
  x: number;
  y: number;
  av: AiActionAvailability;
  onRun: (id: AiActionId, opts?: { targetKind?: DbKind }) => void;
  onClose: () => void;
}

/** 右鍵選單版（含「轉換方言 ▸」子選單）。 */
export default function AiActionMenu({ x, y, av, onRun, onClose }: AiActionMenuProps) {
  const t = useT();
  const [dialectOpen, setDialectOpen] = useState(false);
  const targets = dialectTargetsFor(av.kind);

  const fire = (id: AiActionId, opts?: { targetKind?: DbKind }) => { onClose(); onRun(id, opts); };

  return (
    <MenuPanel x={x} y={y} onClose={onClose} minW={200} className="py-1">
      <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-fg/35 flex items-center gap-1">
        <Icon icon={Sparkles} size={11} className="text-accent" /> {t("AI 動作")}
      </div>
      {menuActions().map((a) => {
        const why = unavailableReason(a, av, t);
        if (a.id === "convert") {
          if (!targets.length) return null;
          return (
            <div key={a.id} className="relative" onMouseEnter={() => setDialectOpen(true)} onMouseLeave={() => setDialectOpen(false)}>
              <button type="button" className={ITEM}>
                <Icon icon={ICONS.convert} size={13} className="text-fg/40" />
                {t(a.label)}
                <Icon icon={ChevronRight} size={13} className="ml-auto text-fg/30" />
              </button>
              {dialectOpen && (
                <div className="absolute left-full top-0 -mt-1 min-w-[150px] bg-elevated border border-fg/10 rounded shadow-2xl py-1 z-10">
                  {targets.map((target) => (
                    <button key={target} type="button" className={ITEM}
                      onClick={() => fire("convert", { targetKind: target })}>
                      {KIND_META[target].label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <button key={a.id} type="button" disabled={!!why} title={why ?? undefined}
            className={why ? ITEM_OFF : ITEM}
            onClick={() => { if (!why) fire(a.id); }}>
            <Icon icon={ICONS[a.id]} size={13} className={why ? "text-fg/20" : "text-fg/40"} />
            {t(a.label)}
          </button>
        );
      })}
      <div className="my-1 border-t border-fg/10" />
      <button type="button" className={ITEM} onClick={() => fire("inline")}>
        <Icon icon={Sparkles} size={13} className="text-accent" />
        {t("用自然語言修改這段…")}
        <kbd className="ml-auto text-[10px] text-fg/30 border border-fg/15 rounded px-1">Ctrl+I</kbd>
      </button>
    </MenuPanel>
  );
}
