import { loadAiLibrary } from "./aiLibrary";
import { migrateLegacySkills } from "./aiSkills";

/**
 * 啟動時載入 AI 資源庫快照（並做一次舊版 localStorage 的遷移），之後視窗取得焦點時重讀：
 * 團隊資料夾 `git pull`、或在外部編輯器改了檔案，切回 App 就生效，不必重開。
 * 回傳解除監聽的函式（給 React effect 用）。
 */
export function bootAiLibrary(): () => void {
  let last = Date.now();
  void loadAiLibrary().then((s) => (s ? migrateLegacySkills().catch(() => {}) : undefined));
  const onFocus = () => {
    // 焦點事件很密（對話框開關也會觸發），5 秒內只重讀一次。
    if (Date.now() - last < 5000) return;
    last = Date.now();
    void loadAiLibrary();
  };
  window.addEventListener("focus", onFocus);
  return () => window.removeEventListener("focus", onFocus);
}
