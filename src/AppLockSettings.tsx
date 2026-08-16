// 設定對話框的「啟動鎖定」區塊。
//
// 兩種解法互相獨立：生物辨識（Windows Hello / Touch ID）與啟動密碼，可單開、可併用。
// 任一啟用即進入鎖定狀態；閒置自動重新鎖定則是兩者共用的加碼。
//
// 文案上刻意不誇大：這是**開啟 App 的閘門，不加密任何資料**。連線機密仍在 OS keychain、
// dbk CLI 不受影響、刪掉設定檔就能解除。加了生物辨識也還是同一句話——把它講成
// 「加密保護」會讓人以為連線密碼受到了它並不存在的保障。
import { useEffect, useState } from "react";
import { FingerprintPattern, Lock } from "lucide-react";

import { api, type AppLockStatus, type BiometricStatus } from "./api";
import { APP_NAME } from "./brand";
import { useT } from "./i18n";
import { toast, uiConfirm, uiPrompt } from "./ui";
import { Button, Field, Icon, Input, Select } from "./ui/index";

/** 生物辨識機制的顯示名稱。用系統自己的叫法，使用者才知道等一下會跳出什麼。 */
function biometricName(kind: BiometricStatus["kind"]): string {
  return kind === "touch_id" ? "Touch ID" : "Windows Hello";
}

// 存檔後刻意**不關閉**設定對話框（舊版的啟動密碼會關）：狀態徽章就在標題右邊，
// 讓使用者當場看到它從「未啟用」翻成「已啟用」，比關掉視窗再自己開回來確認好得多。
export function AppLockSettings() {
  const t = useT();
  const [status, setStatus] = useState<AppLockStatus | null>(null);
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api
      .appLockStatus()
      .then(setStatus)
      .catch(() => setStatus({ password: false, biometric: false, auto_lock_minutes: 0 }));

  useEffect(() => {
    void reload();
    api
      .biometricStatus()
      .then(setBio)
      .catch(() => setBio({ available: false, kind: "none", reason: "unsupported_platform" }));
  }, []);

  const hasPw = status?.password ?? false;
  const bioOn = status?.biometric ?? false;
  const locked = hasPw || bioOn;
  const name = biometricName(bio?.kind ?? "none");

  /** 生物辨識開關勾不動時要說明為什麼——只把 checkbox 變灰，使用者只會以為壞了。 */
  const bioHint = (): string => {
    switch (bio?.reason) {
      case "available":
        return t("開啟後，每次啟動改用 {name} 驗證。", { name });
      case "not_enrolled":
        return t("請先到系統設定完成 {name} 的設定。", { name });
      case "no_device":
        return t("此裝置沒有可用的指紋或臉部辨識感測器。");
      case "disabled_by_policy":
        return t("已被系統原則停用。");
      case "device_busy":
        return t("感測器忙碌中或已暫時鎖定，請稍後再試。");
      case "unsupported_platform":
        return t("此平台不支援生物辨識，請改用啟動密碼。");
      default:
        return "";
    }
  };

  const toggleBiometric = async (enabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.setBiometricUnlock(enabled, null);
      toast.success(enabled ? t("已啟用 {name} 解鎖", { name }) : t("已關閉 {name} 解鎖", { name }));
      await reload();
    } catch (e: unknown) {
      // 關閉時驗不過（感測器壞了 / Hello 被移除）還有密碼這條退路，別讓人被鎖死在這個開關上。
      if (!enabled && hasPw) {
        const pw = await uiPrompt(t("{name} 驗證未通過。輸入啟動密碼以關閉生物辨識解鎖。", { name }), {
          title: t("關閉生物辨識解鎖"),
          confirmText: t("關閉"),
        });
        if (pw) {
          try {
            await api.setBiometricUnlock(false, pw);
            toast.success(t("已關閉 {name} 解鎖", { name }));
            await reload();
            return;
          } catch (e2: unknown) {
            toast.error((e2 as { message?: string })?.message ?? t("設定失敗"));
            return;
          }
        }
        return;
      }
      toast.error((e as { message?: string })?.message ?? t("設定失敗"));
    } finally {
      setBusy(false);
    }
  };

  const savePassword = async () => {
    if (busy) return;
    if (next.length < 4) { toast.error(t("密碼至少 4 碼")); return; }
    if (next !== confirm) { toast.error(t("兩次輸入的密碼不一致")); return; }
    setBusy(true);
    try {
      await api.setStartupPassword(hasPw ? current : null, next);
      toast.success(hasPw ? t("已更新啟動密碼") : t("已啟用啟動密碼"));
      setCurrent(""); setNext(""); setConfirm("");
      await reload();
    } catch (e: unknown) {
      toast.error((e as { message?: string })?.message ?? t("設定失敗"));
    } finally {
      setBusy(false);
    }
  };

  const removePassword = async () => {
    if (busy || !current) return;
    const ok = await uiConfirm(
      bioOn
        ? t("移除後將只剩 {name} 可以解鎖。確定移除啟動密碼？", { name })
        : t("移除後，下次開啟 DB Kit 將不再需要輸入密碼。確定移除啟動密碼？"),
      { title: t("移除啟動密碼"), danger: true, confirmText: t("移除") },
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.clearStartupPassword(current);
      toast.success(t("已移除啟動密碼"));
      setCurrent(""); setNext(""); setConfirm("");
      await reload();
    } catch (e: unknown) {
      toast.error((e as { message?: string })?.message ?? t("移除失敗"));
    } finally {
      setBusy(false);
    }
  };

  const setAutoLock = async (minutes: number) => {
    setStatus((s) => (s ? { ...s, auto_lock_minutes: minutes } : s));
    try {
      await api.setAutoLockMinutes(minutes);
    } catch {
      void reload();
    }
  };

  return (
    <div className="pt-4 border-t border-fg/10 space-y-3">
      <div className="text-sm font-medium text-fg/90 flex items-center gap-2">
        <Icon icon={Lock} size={15} /> {t("啟動鎖定")}
        {status && (
          locked ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> {t("已啟用")}
            </span>
          ) : (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-fg/40">
              <span className="w-1.5 h-1.5 rounded-full bg-fg/30" /> {t("未啟用")}
            </span>
          )
        )}
      </div>
      <p className="text-xs text-fg/50 leading-relaxed">
        {t("啟用後，每次開啟 {app} 需先通過驗證才能進入。這僅作為開啟 App 的閘門，", { app: APP_NAME })}
        <span className="text-fg/70">{t("不會加密你的連線資料")}</span>{t("（連線機密仍存於作業系統 keychain，")}
        <span className="mono"> dbk </span>{t("CLI 不受影響）。")}
      </p>

      {/* 1. 生物辨識 */}
      <label
        className={`flex items-start gap-2 text-sm text-fg/80 select-none ${
          bio?.available ? "cursor-pointer" : "cursor-not-allowed opacity-60"
        }`}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={bioOn}
          disabled={busy || !bio?.available || status === null}
          onChange={(e) => void toggleBiometric(e.target.checked)}
        />
        <span className="flex-1">
          <span className="inline-flex items-center gap-1.5">
            <Icon icon={FingerprintPattern} size={14} />
            {bio?.available ? t("使用 {name} 解鎖", { name }) : t("生物辨識解鎖")}
          </span>
          <span className="block text-xs text-fg/45 mt-0.5 leading-relaxed">{bioHint()}</span>
        </span>
      </label>

      {/* 2. 啟動密碼 */}
      <div className="pt-1 space-y-3">
        <div className="text-xs font-medium text-fg/70">
          {hasPw ? t("啟動密碼（已啟用）") : t("啟動密碼")}
        </div>
        {hasPw ? (
          <Field label={t("目前密碼")}>
            <Input type="password" inputSize="md" value={current} placeholder={t("輸入目前的啟動密碼")}
              onChange={(e) => setCurrent(e.target.value)} />
          </Field>
        ) : null}
        <Field label={hasPw ? t("新密碼") : t("設定密碼")} hint={t("至少 4 碼")}>
          <Input type="password" inputSize="md" value={next} placeholder={t("輸入密碼")}
            onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label={t("確認密碼")}>
          <Input type="password" inputSize="md" value={confirm} placeholder={t("再次輸入密碼")}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") savePassword(); }} />
        </Field>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            loading={busy}
            disabled={!next || !confirm || (hasPw && !current)}
            onClick={savePassword}
          >
            {hasPw ? t("更新密碼") : t("啟用密碼")}
          </Button>
          {hasPw && (
            <>
              <Button variant="danger" disabled={busy || !current} onClick={removePassword}>
                {t("移除啟動密碼")}
              </Button>
              {!current && <span className="text-[11px] text-fg/40">{t("需先輸入目前密碼")}</span>}
            </>
          )}
        </div>
      </div>

      {/* 3. 閒置自動重新鎖定 */}
      <div className="pt-1">
        <Field
          label={t("閒置自動鎖定")}
          hint={locked ? t("離開座位一段時間後自動蓋回鎖定畫面；已開啟的查詢與編輯內容會保留") : t("需先啟用生物辨識或啟動密碼")}
        >
          <Select
            selectSize="md"
            disabled={!locked}
            value={String(status?.auto_lock_minutes ?? 0)}
            onChange={(e) => void setAutoLock(Number(e.target.value))}
          >
            <option value="0">{t("關閉（預設）")}</option>
            <option value="5">{t("5 分鐘")}</option>
            <option value="15">{t("15 分鐘")}</option>
            <option value="30">{t("30 分鐘")}</option>
            <option value="60">{t("1 小時")}</option>
          </Select>
        </Field>
      </div>

      {/* 設定完就關掉對話框的路徑保留給呼叫端的「關閉」鈕；此處只在剛啟用時給個提示。 */}
      {locked && (
        <p className="text-[11px] text-fg/40 leading-relaxed">
          {t("忘記密碼或感測器故障時，刪除設定目錄中的 app_settings.json 即可解除鎖定（不影響已儲存的連線）。")}
        </p>
      )}
    </div>
  );
}
