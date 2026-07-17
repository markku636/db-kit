import { KIND_META, KIND_CATEGORIES, type DbKind } from "./api";
import { kindIcon } from "./kindIcons";
import Icon from "./ui/Icon";
import { useT } from "./i18n";

// 連線類型選擇器（ConnectionDialog 用）：依 KIND_META.category 分組的按鈕格。
// 兩態設計——展開＝完整分組 grid（新增模式初始）；收合＝單列 chip + 「變更類型」（選定後 / 編輯模式），
// 讓表單區在多數時間不被 12+ 種類型的選擇器擠壓。空分類自動隱藏（新 kind 落地前不佔版面）。
// 未來種類 >16 時可在頂部加 fuzzyFilter 搜尋列，不動 dialog 本體。
interface Props {
  value: DbKind;
  /** 選定類型（呼叫端接 onKindChange 並收合）。 */
  onChange: (k: DbKind) => void;
  collapsed: boolean;
  onExpand: () => void;
}

export default function KindPicker({ value, onChange, collapsed, onExpand }: Props) {
  const t = useT();
  if (collapsed) {
    const m = KIND_META[value];
    const cat = KIND_CATEGORIES.find((c) => c.id === m.category);
    return (
      <div className="flex items-center gap-2 h-9 px-3 rounded border border-fg/10 bg-inset">
        <Icon icon={kindIcon(value)} size={14} style={{ color: m.color }} />
        <span className="text-sm font-medium">{m.label}</span>
        {cat && <span className="text-xs text-fg/40">{t(cat.label)}</span>}
        <button type="button" onClick={onExpand} className="ml-auto text-xs text-accent hover:underline">
          {t("變更類型")}
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-2.5" role="radiogroup" aria-label={t("連線類型")}>
      {KIND_CATEGORIES.map((cat) => {
        const kinds = (Object.keys(KIND_META) as DbKind[])
          .filter((k) => KIND_META[k].category === cat.id)
          // 外部 gateway（external）：開源版無內建驅動，預設隱藏（__EXTERNAL__ 建置期開關）。
          .filter((k) => __EXTERNAL__ || k !== "external");
        if (kinds.length === 0) return null;
        return (
          <div key={cat.id}>
            <div className="text-[11px] uppercase tracking-wide text-fg/40 mb-1.5">{t(cat.label)}</div>
            {/* 欄數固定 4，超過換行（長標籤如「SQL Server」在單排等寬時會被壓到換行而跑版）。 */}
            <div className="grid grid-cols-4 gap-2">
              {kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={value === k}
                  onClick={() => onChange(k)}
                  className="h-9 px-2 rounded text-sm border transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                  style={{
                    borderColor: value === k ? KIND_META[k].color : "rgb(var(--c-fg) / 0.12)",
                    background: value === k ? KIND_META[k].color + "22" : "transparent",
                    color: value === k ? KIND_META[k].color : "rgb(var(--c-fg) / 0.55)",
                  }}
                >
                  <Icon icon={kindIcon(k)} size={14} />
                  {KIND_META[k].label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
