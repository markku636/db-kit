import { api, needsOtpPrompt, type ConnectionConfig } from "./api";
import { t } from "./i18n";
import { uiPrompt } from "./ui";

/** `askOtpCode` 的結果：cancelled＝使用者按取消（呼叫端應靜默中止，不視為連線失敗）。 */
export interface OtpGateResult {
  cancelled: boolean;
  /** 使用者輸入的一次性驗證碼；不需要 OTP 或已取消時為 undefined。 */
  code?: string;
}

/**
 * 連線前的 OTP 關卡：設為「每次手動輸入」的連線先跳窗要驗證碼，其餘直接放行。
 *
 * 驗證碼是一次性的，後端不會存進 keychain、也無法像密碼那樣自動補回，
 * 因此每個會建立連線的入口（連線 / 測試連線）都要先過這道關卡。
 *
 * 例外：後端還握著這個 gateway 的 session 時直接放行——中斷連線只丟掉連線本身，
 * 登入 session 活到 app 關閉為止，重連沿用既有 cookie，根本用不到新的驗證碼。
 * 所以「一個 app 生命週期只驗一次」：重開 app（session 隨行程消失）或 session 被
 * gateway 判過期時，後端回報 session 已不在，這道關卡才會再跳窗。
 */
export async function askOtpCode(config: ConnectionConfig): Promise<OtpGateResult> {
  if (!needsOtpPrompt(config)) return { cancelled: false };
  // 查詢失敗（舊版後端無此 command 等）→ 當成沒 session，照舊跳窗，不會把人擋在外面。
  const alive = await api.externalSessionAlive(config).catch(() => false);
  if (alive) return { cancelled: false };
  const code = await uiPrompt(t("輸入驗證器 App 顯示的 6 碼驗證碼"), {
    title: t("兩階段驗證：{name}", { name: config.name }),
    placeholder: t("6 位數字"),
    confirmText: t("確定"),
  });
  // null＝取消；空白＝當成取消（送空碼一定失敗，不如不送）。
  if (code == null || !code.trim()) return { cancelled: true };
  return { cancelled: false, code: code.trim() };
}
