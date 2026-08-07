// 設定對話框的「結構快取」區塊。
//
// 這裡刻意做三件事、只做三件事：講清楚存了什麼、講清楚存在哪、讓人能一鍵刪掉。
// 快取的是資料庫的表名與欄名——不是機密，但也是第一次有這類東西以明文留在磁碟上
//（機密仍走 OS keychain、永不落地）。能看見、能刪掉，是這件事唯一站得住腳的交代方式。
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { api, type SchemaCacheSummary } from "./api";
import Icon from "./ui/Icon";
import { toast, uiConfirm } from "./ui";
import { useT } from "./i18n";
import { fmtBytes } from "./schemaCache";
import { fmtRelativeTime } from "./sql";
import { invalidateSchemaCache } from "./useSqlSchema";

export function SchemaCacheSettings() {
  const t = useT();
  const [summary, setSummary] = useState<SchemaCacheSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api
      .schemaCacheStats()
      .then(setSummary)
      .catch(() => setSummary(null));
  };
  useEffect(load, []);

  const clearAll = async () => {
    const ok = await uiConfirm(t("清除所有連線的結構快取？下次開啟查詢分頁時會重新載入。"), {
      title: t("清除結構快取"),
      danger: true,
      confirmText: t("清除"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.clearSchemaCache();
      invalidateSchemaCache();
      toast.success(t("已清除結構快取"));
      load();
    } catch (e: any) {
      toast.error(e?.message ?? t("清除結構快取失敗"));
    } finally {
      setBusy(false);
    }
  };

  const total = summary?.entries.reduce((n, e) => n + e.bytes, 0) ?? 0;
  const tables = summary?.entries.reduce((n, e) => n + e.tables, 0) ?? 0;
  const newest = summary?.entries.reduce((n, e) => Math.max(n, e.updated_at_ms), 0) ?? 0;

  return (
    <div className="pt-4 border-t border-fg/10 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-fg/80">{t("結構快取")}</span>
        <button
          type="button"
          onClick={() => void clearAll()}
          disabled={busy || !summary?.entries.length}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-fg/15 hover:bg-fg/10 text-fg/70 disabled:opacity-50"
        >
          <Icon icon={Trash2} size={13} />
          {t("清除全部")}
        </button>
      </div>
      <p className="text-xs text-fg/50 leading-relaxed">
        {t("為了讓 SQL 自動完成開啟即用（也能離線用），表名與欄名會存成 JSON 檔。只存名稱，不存資料、型別、預設值或註解。標記為正式環境的連線預設不會寫入。")}
      </p>
      <p className="text-xs text-fg/60">
        {summary?.entries.length
          ? t("{conns} 個連線 · {tables} 張表 · {size} · 最後更新 {when}", {
              conns: summary.entries.length,
              tables,
              size: fmtBytes(total),
              when: fmtRelativeTime(newest),
            })
          : t("目前沒有快取。")}
      </p>
      {summary?.dir && (
        <p className="text-[11px] text-fg/40 break-all font-mono">{summary.dir}</p>
      )}
    </div>
  );
}
