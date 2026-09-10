// 啟動鎖定畫面：全螢幕不透明覆蓋，驗證通過才 onUnlock。
//
// 兩種解法互相獨立，畫面依 status 決定要出現哪些：
//   - 有生物辨識 → 掛載時自動跳一次 OS 提示（不必先按一顆按鈕，那只是多一次點擊）
//   - 有密碼     → 密碼輸入框；兩者都有時可互相切換
//
// **背景必須完全不透明**（bg-app）。閒置重新鎖定時這層是疊在已掛載的主介面之上的，
// 半透明或只加 blur 等於把查詢結果留在螢幕上給人看，鎖了跟沒鎖一樣。

import { useEffect, useRef, useState } from "react";
import { FingerprintPattern, Lock, ScanFace } from "lucide-react";

import { api, type AppLockStatus, type BiometricStatus } from "./api";
import { useT } from "./i18n";
import { Button, Icon, Input } from "./ui/index";
import { copyToClipboard } from "./ui";
// 識別標記用**方形** App 圖示，不是 hero banner：banner 是 1280×520，塞進正方形的圓角磚
// 會被壓扁成一團看不出是什麼的色塊。直接引 src-tauri/icons 那份，`npm run make:app-icon`
// 重產圖示時這裡自動跟上，不必再複製一份到 src/assets 等著和母檔漂移。
// 取 @2x（256×256）而不是 128：磚是 112px，在 2x DPI 要 224px 才不會放大到發軟。
import logoMark from "../src-tauri/icons/128x128@2x.png";

/** 生物辨識驗證的當下狀態。 */
type BioPhase =
  | "idle" // 尚未觸發
  | "prompting" // OS 提示顯示中
  | "failed" // 使用者取消或比對失敗，可重試
  | "unavailable"; // 這台機器現在叫不起來（感測器被拔掉、Hello 被移除…）

/** 設定檔路徑。忘記密碼的自救指引要指對地方，三個平台的設定目錄不一樣。 */
function settingsPath(): string {
  const ua = navigator.userAgent;
  if (ua.includes("Mac OS X")) return "~/Library/Application Support/dev.dbkit.app/app_settings.json";
  if (ua.includes("Windows")) return "%APPDATA%\\dev.dbkit.app\\app_settings.json";
  return "~/.config/dev.dbkit.app/app_settings.json";
}

/** 生物辨識機制的顯示名稱。用系統自己的叫法，使用者才知道等一下會跳出什麼。 */
function biometricName(kind: BiometricStatus["kind"]): string {
  return kind === "touch_id" ? "Touch ID" : "Windows Hello";
}

export default function LockScreen({
  status,
  onUnlock,
}: {
  status: AppLockStatus;
  onUnlock: () => void;
}) {
  const t = useT();
  // 兩個都開時先走生物辨識——它是比較快的那條路。
  const [usePassword, setUsePassword] = useState(!status.biometric);
  const [bio, setBio] = useState<BioPhase>("idle");
  const [bioKind, setBioKind] = useState<BiometricStatus["kind"]>("windows_hello");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showForgot, setShowForgot] = useState(false);

  const runBiometric = async () => {
    setBio("prompting");
    try {
      if (await api.biometricVerify()) {
        onUnlock();
        return;
      }
      setBio("failed");
    } catch {
      // command 本身出錯 = 這台機器現在叫不起來，和「驗證沒過」是不同的處境，
      // 文案要引導去用密碼而不是叫人再刷一次。
      setBio("unavailable");
    }
  };

  // 掛載時自動跳一次。用 ref 擋重入：React 18 StrictMode 下 effect 會跑兩次，
  // 沒擋的話開發模式一開 app 就連跳兩個 Hello 對話框。
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!status.biometric || autoStarted.current) return;
    autoStarted.current = true;
    api
      .biometricStatus()
      .then((s) => setBioKind(s.kind))
      .catch(() => {});
    void runBiometric();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.biometric]);

  const submit = async () => {
    if (busy || !pw) return;
    setBusy(true);
    try {
      const ok = await api.verifyStartupPassword(pw);
      if (ok) {
        onUnlock();
        return;
      }
      setErr(true);
      setPw("");
    } catch {
      setErr(true);
    } finally {
      setBusy(false);
    }
  };

  const name = biometricName(bioKind);
  const bioIcon = bioKind === "touch_id" ? FingerprintPattern : ScanFace;

  return (
    <div className="fixed inset-0 z-[400] grid place-items-center bg-app">
      <div className="w-[320px] max-w-[88vw] flex flex-col items-center gap-6">
        {/* 鎖定畫面是全螢幕的，上下都是留白 —— 識別標記照工具列的 64px 給，會小得像顆 favicon。
            112px 才撐得起這個版面；圓角同比例放大（16/64 → 28/112）維持一樣的方角觀感。 */}
        <img src={logoMark} alt="DB Kit" className="w-28 h-28 rounded-[28px] shadow-e4" draggable={false} />
        <div className="text-center space-y-1">
          <div className="text-base font-semibold text-fg/90">{t("DB Kit 已鎖定")}</div>
          <div className="text-xs text-fg/50">
            {usePassword
              ? t("輸入啟動密碼以繼續")
              : bio === "prompting"
                ? t("請在 {name} 完成驗證", { name })
                : bio === "unavailable"
                  ? t("{name} 目前無法使用", { name })
                  : t("使用 {name} 驗證以繼續", { name })}
          </div>
        </div>

        {usePassword ? (
          <div className="w-full space-y-2.5">
            <Input
              type="password"
              inputSize="md"
              autoFocus
              value={pw}
              invalid={err}
              placeholder={t("啟動密碼")}
              aria-label={t("啟動密碼")}
              onChange={(e) => { setPw(e.target.value); setErr(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            />
            {err && <div className="text-[11px] text-danger text-center">{t("密碼不正確，請再試一次")}</div>}
            <Button variant="primary" full icon={Lock} loading={busy} disabled={!pw} onClick={submit}>
              {t("解鎖")}
            </Button>
            {status.biometric && (
              <button
                type="button"
                onClick={() => { setUsePassword(false); void runBiometric(); }}
                className="w-full text-[11px] text-fg/45 hover:text-fg/70 underline decoration-dotted"
              >
                {t("改用 {name}", { name })}
              </button>
            )}
          </div>
        ) : (
          <div className="w-full space-y-2.5 flex flex-col items-center">
            <Icon
              icon={bioIcon}
              size={40}
              className={bio === "prompting" ? "text-accent animate-pulse" : "text-fg/35"}
            />
            {bio === "failed" && (
              <div className="text-[11px] text-danger text-center">{t("驗證未通過，請再試一次")}</div>
            )}
            {bio === "unavailable" && (
              <div className="text-[11px] text-danger text-center">
                {status.password ? t("請改用啟動密碼解鎖") : t("請確認系統的生物辨識設定仍然有效")}
              </div>
            )}
            <Button
              variant="primary"
              full
              icon={bioIcon}
              loading={bio === "prompting"}
              onClick={() => void runBiometric()}
            >
              {bio === "idle" || bio === "prompting" ? t("使用 {name} 驗證", { name }) : t("再試一次")}
            </Button>
            {status.password && (
              <button
                type="button"
                onClick={() => setUsePassword(true)}
                className="w-full text-[11px] text-fg/45 hover:text-fg/70 underline decoration-dotted"
              >
                {t("改用密碼")}
              </button>
            )}
          </div>
        )}

        {/* 被鎖在外面時的自救指引：解法只寫在 CHANGELOG 對當事人毫無幫助（死路型 UX）。 */}
        <div className="text-center">
          {!showForgot ? (
            <button type="button" onClick={() => setShowForgot(true)}
              className="text-[11px] text-fg/35 hover:text-fg/60 underline decoration-dotted">
              {t("無法解鎖？")}
            </button>
          ) : (
            <div className="text-[11px] text-fg/50 leading-relaxed max-w-[300px] text-left space-y-1.5">
              <p>
                {t("啟動鎖定只是開啟 App 的閘門。刪除設定目錄中的")}
                <span className="mono"> app_settings.json </span>{t("即可解除（密碼與生物辨識一併失效），")}
                <span className="text-fg/70">{t("不影響已儲存的連線")}</span>{t("（連線機密存於系統 keychain）。")}
              </p>
              <p className="mono break-all text-fg/40">{settingsPath()}</p>
              <button type="button"
                onClick={() => copyToClipboard(settingsPath(), t("已複製路徑"))}
                className="underline decoration-dotted hover:text-fg/70">{t("複製路徑")}</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
