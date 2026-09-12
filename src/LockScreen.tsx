// 啟動鎖定畫面：全螢幕不透明覆蓋，驗證通過才 onUnlock。
//
// 兩種解法互相獨立，畫面依 status 決定要出現哪些：
//   - 有生物辨識 → 掛載時自動跳一次 OS 提示（不必先按一顆按鈕，那只是多一次點擊）
//   - 有密碼     → 密碼輸入框；兩者都有時可互相切換
//
// **背景必須完全不透明**（bg-app）。閒置重新鎖定時這層是疊在已掛載的主介面之上的，
// 半透明或只加 blur 等於把查詢結果留在螢幕上給人看，鎖了跟沒鎖一樣。
//
// 版面：全部收進一張卡片，由上而下「識別 → 狀態 → 錯誤 → 主要動作 → 替代動作」，
// 「無法解鎖？」獨立在卡片底部的分隔區。每層只有一個主角 —— 舊版把 40px 臉部圖示、
// 11px 紅字、按鈕、兩個虛線連結擠在 10px 間距裡，圖示還跟按鈕上的重複一次。

import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown, CircleAlert, CircleHelp, Copy, FingerprintPattern, KeyRound, Lock, ScanFace } from "lucide-react";

import { api, type AppLockStatus, type BiometricStatus } from "./api";
import { useT } from "./i18n";
import { Button, Icon, IconButton, Input } from "./ui/index";
import { copyToClipboard } from "./ui";
// 識別標記用**方形** App 圖示，不是 hero banner：banner 是 1280×520，塞進正方形的圓角磚
// 會被壓扁成一團看不出是什麼的色塊。直接引 src-tauri/icons 那份，`npm run make:app-icon`
// 重產圖示時這裡自動跟上，不必再複製一份到 src/assets 等著和母檔漂移。
// 取 @2x（256×256）：磚是 80px，在 2x DPI 要 160px 才不會放大到發軟。
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

// 卡片外的光暈。疊在不透明的 bg-app 之上當背景圖層，不改變「底色完全不透明」這件事。
const GLOW = "radial-gradient(ellipse 50% 42% at 50% 45%, rgb(var(--c-accent) / 0.12), transparent 72%)";

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

  let subtitle: string;
  if (usePassword) subtitle = t("輸入啟動密碼以繼續");
  else if (bio === "prompting") subtitle = t("請在 {name} 完成驗證", { name });
  else if (bio === "unavailable") subtitle = t("{name} 目前無法使用", { name });
  else subtitle = t("使用 {name} 驗證以繼續", { name });

  // 同一時間最多一則錯誤，一律進主要按鈕上方的提示框。
  let alert: string | null = null;
  if (usePassword) alert = err ? t("密碼不正確，請再試一次") : null;
  else if (bio === "failed") alert = t("驗證未通過，請再試一次");
  else if (bio === "unavailable")
    alert = status.password ? t("請改用啟動密碼解鎖") : t("請確認系統的生物辨識設定仍然有效");

  return (
    <div className="fixed inset-0 z-[400] overflow-y-auto bg-app" style={{ backgroundImage: GLOW }}>
      <div className="min-h-full grid place-items-center px-6 py-10">
        <div className="modal-shell-in w-[400px] max-w-full rounded-lg border border-fg/10 bg-elevated shadow-e4">
          <div className="px-8 pt-10 pb-8 flex flex-col items-center text-center">
            <div className="relative">
              <img src={logoMark} alt="DB Kit" draggable={false} className="w-20 h-20 rounded-[20px] shadow-e3" />
              {/* 鎖頭徽章：外圈用卡片底色描 4px，看起來像從圖示角落挖出來的，不是貼上去的貼紙。 */}
              <span className="absolute -right-2 -bottom-2 grid place-items-center w-8 h-8 rounded-full bg-accent ring-4 ring-elevated">
                <Icon icon={Lock} size={14} strokeWidth={2.25} />
              </span>
            </div>
            <h1 className="mt-7 text-xl font-semibold tracking-tight text-fg">{t("DB Kit 已鎖定")}</h1>
            <p className="mt-1.5 text-sm text-fg/55">{subtitle}</p>

            {alert && (
              <div
                role="alert"
                className="mt-6 w-full flex items-start gap-2 rounded-md border border-danger/25 bg-danger/10 px-3 py-2.5 text-left text-[13px] leading-snug text-danger"
              >
                <Icon icon={CircleAlert} size={16} className="shrink-0" />
                <span>{alert}</span>
              </div>
            )}

            <div className={`w-full ${alert ? "mt-4" : "mt-8"}`}>
              {usePassword ? (
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                  <Input
                    type="password"
                    inputSize="lg"
                    autoFocus
                    value={pw}
                    invalid={err}
                    placeholder={t("啟動密碼")}
                    aria-label={t("啟動密碼")}
                    onChange={(e) => { setPw(e.target.value); setErr(false); }}
                  />
                  <Button type="submit" variant="primary" size="lg" full icon={Lock} loading={busy} disabled={!pw}>
                    {t("解鎖")}
                  </Button>
                  {status.biometric && (
                    <Button
                      variant="secondary"
                      size="lg"
                      full
                      icon={bioIcon}
                      onClick={() => { setUsePassword(false); void runBiometric(); }}
                    >
                      {t("改用 {name}", { name })}
                    </Button>
                  )}
                </form>
              ) : (
                <div className="space-y-3">
                  <Button
                    variant="primary"
                    size="lg"
                    full
                    icon={bioIcon}
                    loading={bio === "prompting"}
                    onClick={() => void runBiometric()}
                  >
                    {bio === "idle" || bio === "prompting" ? t("使用 {name} 驗證", { name }) : t("再試一次")}
                  </Button>
                  {status.password && (
                    <Button variant="secondary" size="lg" full icon={KeyRound} onClick={() => setUsePassword(true)}>
                      {t("改用密碼")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <ForgotHelp />
        </div>
      </div>
    </div>
  );
}

/** 被鎖在外面時的自救指引：解法只寫在 CHANGELOG 對當事人毫無幫助（死路型 UX）。 */
function ForgotHelp() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const path = settingsPath();
  return (
    <div className="border-t border-fg/[0.08] px-8 py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="mx-auto flex items-center gap-1.5 rounded px-2 py-1 text-[13px] text-fg/45 hover:text-fg/75 transition-colors focus-visible:outline-2 focus-visible:outline-accent/60"
      >
        <Icon icon={CircleHelp} size={14} />
        {t("無法解鎖？")}
        <Icon icon={ChevronDown} size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="mt-2 mb-3 space-y-3 text-left text-[13px] leading-relaxed text-fg/60">
          <p>
            {t("啟動鎖定只是開啟 App 的閘門。刪除設定目錄中的")}
            <code className="mono mx-0.5 rounded-xs bg-fg/[0.07] px-1 py-px text-[12px] text-fg/80">app_settings.json</code>
            {t("即可解除（密碼與生物辨識一併失效），")}
            <span className="text-fg/85">{t("不影響已儲存的連線")}</span>
            {t("（連線機密存於系統 keychain）。")}
          </p>
          <div className="flex items-center gap-1 rounded-md border border-fg/[0.08] bg-well py-1 pl-3 pr-1">
            {/* 只在路徑分隔符後斷行（<wbr>）；break-all 會把 app_settings.json 切成「.js / on」。 */}
            <span className="mono min-w-0 flex-1 text-[12px] text-fg/70 [overflow-wrap:anywhere]">
              {path.split(/(?<=[\\/])/).map((seg, i) => (
                <Fragment key={i}>{i > 0 && <wbr />}{seg}</Fragment>
              ))}
            </span>
            <IconButton
              icon={Copy}
              label={t("複製路徑")}
              iconSize={14}
              onClick={() => copyToClipboard(path, t("已複製路徑"))}
            />
          </div>
        </div>
      )}
    </div>
  );
}
