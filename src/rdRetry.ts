// RustDesk 斷線自動重連，照官方用戶端（flutter/lib/models/model.dart 的 `showMsgBox`、src/client.rs 的 `check_if_retry`）：
// 連上過的連線被中斷時——對方登入 / 登出作業系統、切換使用者、重新開機時，對方的 RustDesk 服務會重新啟動，
// 連線一定會斷——等 1、2、4、8… 秒自動重連，連上就歸零。對方手動中斷、拒絕連線這類的不重連。
// 官方會一直重試下去；這裡等到 30 秒為止、最多重試 3 分鐘（夠對方重新開機），之後留給使用者按「重新連線」。
// VNC 用同一套等待時間（見 `shouldAutoRetry`）。

/** 從第一次斷線起，最多自動重試多久。 */
export const RETRY_WINDOW_MS = 180_000;
/** 兩次重試之間最多等幾秒。 */
export const MAX_RETRY_DELAY = 30;

/** 結束原因裡有這些字的不重連（官方 `check_if_retry` 的排除清單）。 */
const NO_RETRY = ["offline", "not exist", "handshake", "failed", "resolve", "mismatch", "manually", "restricted", "incoming only", "not allowed"];

/** 這個結束原因要不要自動重連；沒有原因 = 使用者自己斷的，不重連。 */
export function isRetryableClose(reason: string | null | undefined): boolean {
  if (!reason) return false;
  const r = reason.toLowerCase();
  return !NO_RETRY.some((w) => r.includes(w));
}

/**
 * 連上過的連線結束了，要不要自動重連。RustDesk 照上面的排除清單；VNC 只要不是使用者自己斷的就重連
 * （對方重新開機、網路斷一下、Mac 登出再登入），但關掉「共享連線」時不重連——獨佔模式重連會把剛連進來的人踢掉，
 * 對方再連回來就變成互踢。RDP 不自動重連。
 */
export function shouldAutoRetry(protocol: string, reason: string | null | undefined, vncShared: boolean): boolean {
  if (protocol === "rustdesk") return isRetryableClose(reason);
  if (protocol === "vnc") return !!reason && vncShared;
  return false;
}

/** 下一次要等幾秒：1 → 2 → 4 → … → 30（`prev` = 上一次等的，第一次給 0）。 */
export function nextRetryDelay(prev: number): number {
  return prev <= 0 ? 1 : Math.min(MAX_RETRY_DELAY, prev * 2);
}
