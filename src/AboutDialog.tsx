import { useState } from "react";
import { Bug, Copy, ExternalLink, FileText, Info, RefreshCw } from "lucide-react";
import { Button, Icon, Modal } from "./ui/index";
import { api, KIND_META } from "./api";
import { checkForUpdate, isNewer, REPO, type UpdateInfo } from "./updateCheck";
import { copyToClipboard } from "./ui";

// 手動檢查更新的狀態機：idle（未檢查）→ checking → latest / update / failed。
type CheckState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "latest" }
  | { phase: "update"; info: UpdateInfo }
  | { phase: "failed" };

// 「關於 DB Kit」對話框：版本 / 支援的資料庫 / 手動檢查更新 / GitHub 相關連結 / 授權。
// 更新檢查沿用 updateCheck 但帶 force 略過每日快取（使用者主動點的就該真的去查）。
export default function AboutDialog({ onClose }: { onClose: () => void }) {
  const [check, setCheck] = useState<CheckState>({ phase: "idle" });
  const openUrl = (url: string) => api.openExternal(url).catch(() => {});
  const runCheck = async () => {
    setCheck({ phase: "checking" });
    const r = await checkForUpdate({ force: true }).catch(() => null);
    if (!r) setCheck({ phase: "failed" });
    else if (isNewer(r.version, __APP_VERSION__)) setCheck({ phase: "update", info: r });
    else setCheck({ phase: "latest" });
  };
  // 支援的資料庫清單直接從 KIND_META 導出（排除 QLand 這類外掛入口），新增 kind 時自動跟上。
  const dbs = Object.values(KIND_META)
    .filter((m) => !m.external)
    .map((m) => m.label)
    .join(" · ");
  const links: { icon: typeof ExternalLink; label: string; url: string }[] = [
    { icon: ExternalLink, label: "GitHub 專案", url: `https://github.com/${REPO}` },
    { icon: FileText, label: "變更紀錄", url: `https://github.com/${REPO}/blob/main/CHANGELOG.md` },
    { icon: Bug, label: "回報問題", url: `https://github.com/${REPO}/issues/new` },
  ];
  return (
    <Modal open onClose={onClose} title="關於 DB Kit" icon={Info} size="sm">
      <div className="flex flex-col items-center text-center gap-1 py-2">
        {/* 圖示沿用 make-favicon.mjs 產出的正方形吉祥物（public/ 下的檔案佈署後在站台根目錄） */}
        <img src="/apple-touch-icon.png" alt="DB Kit" className="w-16 h-16 mb-2" draggable={false} />
        <div className="text-lg font-semibold">DB Kit</div>
        <div className="flex items-center gap-1 text-xs text-fg/40 tabular-nums">
          <span>版本 {__APP_VERSION__}</span>
          <button
            type="button"
            onClick={() => copyToClipboard(`DB Kit v${__APP_VERSION__} (${navigator.platform})`, "已複製版本資訊")}
            title="複製版本資訊（回報問題時附上）"
            className="w-5 h-5 grid place-items-center rounded text-fg/40 hover:text-fg hover:bg-fg/10"
          >
            <Icon icon={Copy} size={12} />
          </button>
        </div>
        <p className="text-sm text-fg/60 mt-1">跨資料庫管理工具：{dbs}</p>

        {/* 更新檢查：結果訊息 + 檢查按鈕 */}
        <div className="mt-3 flex flex-col items-center gap-2 min-h-[52px]">
          {check.phase === "update" && (
            <button
              type="button"
              onClick={() => openUrl(check.info.url)}
              className="text-sm font-medium text-accent hover:underline inline-flex items-center gap-1.5"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />
              有新版 v{check.info.version}，點擊前往下載
            </button>
          )}
          {check.phase === "latest" && <div className="text-sm text-success">已是最新版本</div>}
          {check.phase === "failed" && (
            <div className="text-sm text-fg/50">檢查失敗（離線或已達 GitHub API 上限），稍後再試</div>
          )}
          <Button icon={RefreshCw} loading={check.phase === "checking"} onClick={runCheck}>
            {check.phase === "checking" ? "檢查中…" : "檢查更新"}
          </Button>
        </div>

        {/* 相關連結（以系統瀏覽器開啟） */}
        <div className="mt-3 flex items-center gap-1">
          {links.map((l) => (
            <button
              type="button"
              key={l.label}
              onClick={() => openUrl(l.url)}
              className="inline-flex items-center gap-1.5 text-[13px] text-fg/60 hover:text-fg hover:bg-fg/5 rounded px-2 py-1"
            >
              <Icon icon={l.icon} size={13} />
              {l.label}
            </button>
          ))}
        </div>

        <div className="mt-3 text-[11px] text-fg/35">MIT 授權 · Tauri + React 打造</div>
      </div>
    </Modal>
  );
}
