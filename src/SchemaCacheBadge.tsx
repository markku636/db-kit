// 查詢分頁工具列上的結構快取徽章：告訴使用者「自動完成是根據哪個時間點的結構」，
// 並讓他一鍵重抓。
//
// 為什麼要有這個東西：快取讓補全變快，代價是它可能是舊的。舊到什麼程度只有使用者知道
// （同事昨天跑了 migration，本機無從得知），所以唯一誠實的做法是把時間攤開講、
// 把重抓放在手邊——而不是給一個綠勾假裝一切同步。
import { RefreshCw } from "lucide-react";
import Icon from "./ui/Icon";
import { useT } from "./i18n";
import { fmtRelativeTime } from "./sql";
import type { SqlSchemaState } from "./useSqlSchema";

export function SchemaCacheBadge({ state }: { state: SqlSchemaState }) {
  const t = useT();
  const { supported, database, updatedAt, stale, loading, refresh } = state;
  // 不適用結構快取的種類（Redis / Kafka / ES…）不顯示，免得暗示有一份根本不存在的東西。
  if (!supported || !database) return null;

  const never = updatedAt <= 0;
  const label = loading
    ? t("更新中…")
    : never
      ? t("尚未快取")
      : fmtRelativeTime(updatedAt);
  const tone = loading
    ? "text-fg/50"
    : never || stale
      ? "text-amber-300/90"
      : "text-fg/50";
  const title = never
    ? t("尚未建立「{db}」的結構快取。點擊立即載入整庫表名與欄名，之後開啟查詢分頁就能立即補全。", { db: database })
    : t("自動完成使用的結構快取更新於 {when}（資料庫「{db}」）。別人在資料庫端做的變更不會自動偵測到——點擊重新整理。", {
        when: fmtRelativeTime(updatedAt),
        db: database,
      });

  return (
    <button
      type="button"
      onClick={() => void refresh()}
      disabled={loading}
      title={title}
      className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-fg/15 hover:bg-fg/10 shrink-0 disabled:opacity-60 ${tone}`}
    >
      <Icon icon={RefreshCw} size={11} className={loading ? "animate-spin" : undefined} />
      {t("結構")} {label}
    </button>
  );
}
