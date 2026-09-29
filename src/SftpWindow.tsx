// SFTP 獨立視窗（sftp.html?tab=<分頁鍵>，一個終端機分頁一個）。內容就是終端機側邊的 SFTP 面板，差別是
// 這個視窗收得到系統的檔案拖放（拿得到本機路徑），拖進來就上傳；可以拖到另一個螢幕、放大成全螢幕。
// SSH 連線與終端機都在主視窗：連線 id / 狀態、終端機所在的資料夾由主視窗推過來（見 sftpWindowBridge）。
import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Lock, Unplug } from "lucide-react";
import SftpPanel from "./SftpPanel";
import { applyHostState, listenHostState, requestCd, sayBye, sayHello, type SftpWinState } from "./sftpWindowBridge";
import { useSshTransfers } from "./useSshTransfers";
import { useT } from "./i18n";
import { Button, Icon, Spinner } from "./ui/index";
import { toast, uiConfirm, UiHost } from "./ui";

/** 打招呼幾次都沒回應，就告訴使用者主視窗那邊可能已經沒有這個分頁。 */
const HELLO_TRIES_BEFORE_WARN = 4;
const HELLO_INTERVAL_MS = 1500;

export default function SftpWindow({ tabKey }: { tabKey: string }) {
  const t = useT();
  const [host, setHost] = useState<SftpWinState | null>(null);
  const [noReply, setNoReply] = useState(false);
  // 從側邊面板移過來時面板所在的資料夾：只有第一次開通道時用得到，主視窗之後不會再帶。
  const [initialDir, setInitialDir] = useState<string | undefined>(undefined);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 跟主視窗接上：一直打招呼直到收到第一份狀態（主視窗可能還在掛監聽）。
  useEffect(() => {
    let alive = true;
    let got = false;
    let tries = 0;
    let timer: number | undefined;
    let un: (() => void) | undefined;
    const hello = () => {
      if (!alive || got) return;
      void sayHello(tabKey).catch(() => undefined);
      if (++tries >= HELLO_TRIES_BEFORE_WARN) setNoReply(true);
      timer = window.setTimeout(hello, HELLO_INTERVAL_MS);
    };
    listenHostState(tabKey, (s) => {
      got = true;
      setNoReply(false);
      if (s.initialDir) setInitialDir(s.initialDir);
      applyHostState(s);
      setHost(s);
    })
      .then((u) => { if (alive) { un = u; hello(); } else u(); })
      .catch(() => setNoReply(true));
    return () => { alive = false; un?.(); window.clearTimeout(timer); };
  }, [tabKey]);

  const label = host ? (host.user && host.host ? `${host.user}@${host.host}` : host.title ?? "") : "";
  useEffect(() => { document.title = label ? `${label} — SFTP` : "SFTP"; }, [label]);

  // 鎖定時遮罩蓋住畫面，inert 讓焦點與按鍵也進不去（不然 Delete 之類的快捷鍵照樣作用在清單上）。
  const locked = !!host?.locked;
  useEffect(() => { bodyRef.current?.toggleAttribute("inert", locked); }, [locked]);

  // 關窗前：還有傳輸在跑就先問。關掉之後後端會收掉這個視窗的 sftp 通道，傳到一半的檔案照斷線處理（留著給續傳）。
  const confirmClose = useCallback(async (): Promise<boolean> => {
    const running = Object.values(useSshTransfers.getState().jobs).filter((j) => j.state === "running").length;
    if (running) {
      const ok = await uiConfirm(
        t("還有 {n} 個傳輸沒完成，關閉視窗會中斷它們。已傳的部分會留著，之後再傳同一個檔可以從中斷的地方接著傳。", { n: running }),
        { title: t("關閉 SFTP 視窗"), danger: true, confirmText: t("關閉視窗") },
      );
      if (!ok) return false;
    }
    void sayBye(tabKey).catch(() => undefined);
    return true;
  }, [t, tabKey]);

  // 標題列的 ×：有 JS 監聽時 Tauri 會等這裡決定，沒擋下就由 onCloseRequested 自己 destroy。
  useEffect(() => {
    let alive = true;
    let un: (() => void) | undefined;
    getCurrentWindow().onCloseRequested(async (e) => { if (!(await confirmClose())) e.preventDefault(); })
      .then((u) => { if (alive) un = u; else u(); })
      .catch(() => undefined);
    return () => { alive = false; un?.(); };
  }, [confirmClose]);

  const closeWindow = async () => {
    if (!(await confirmClose())) return;
    await getCurrentWindow().destroy().catch(() => window.close());
  };

  const onCd = (path: string) => {
    requestCd(tabKey, path)
      .then(() => toast.success(t("已在終端機 cd 到 {dir}", { dir: path })))
      .catch((e) => toast.error(String(e)));
  };

  const status = host?.status;
  const banner = !host || !host.connId ? null
    : status === "connecting" ? t("正在重新連線…")
    : status === "disconnected" || status === "error" ? t("SSH 連線已中斷：到主視窗重新連線，這裡會自動接上。")
    : null;

  return (
    <div className="h-full flex flex-col bg-panel text-fg">
      {banner && (
        <div data-testid="sftp-window-banner" role="status"
          className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-warning/25 bg-warning/10 text-xs">
          {status === "connecting" ? <Spinner size={12} /> : <Icon icon={Unplug} size={14} className="text-warning shrink-0" />}
          <span className="truncate">{banner}</span>
        </div>
      )}
      <div ref={bodyRef} className="relative flex-1 min-h-0 flex flex-col">
        {host?.connId ? (
          <SftpPanel
            tabKey={tabKey}
            connId={host.connId}
            onCd={onCd}
            onClose={() => void closeWindow()}
            startDir={host.startDir ?? undefined}
            initialDir={initialDir}
            nativeDrop
          />
        ) : (
          <div data-testid="sftp-window-waiting" className="flex-1 flex items-center justify-center p-6 text-xs">
            {host && !host.connId ? (
              <span className="text-fg/55">{t("這個終端機分頁已經關閉。")}</span>
            ) : noReply ? (
              <div className="max-w-sm text-center space-y-3">
                <Icon icon={Unplug} size={22} className="mx-auto text-warning" />
                <div className="text-fg/70">{t("主視窗沒有回應：這個終端機分頁可能已經關閉。")}</div>
                <Button size="sm" onClick={() => void closeWindow()}>{t("關閉視窗")}</Button>
              </div>
            ) : (
              <span className="flex items-center gap-2 text-fg/50"><Spinner size={14} />{t("正在連到主視窗…")}</span>
            )}
          </div>
        )}
      </div>
      {locked && (
        <div data-testid="sftp-window-locked" className="fixed inset-0 z-[300] flex items-center justify-center bg-app">
          <div className="text-center space-y-2">
            <Icon icon={Lock} size={28} className="mx-auto text-fg/50" />
            <div className="text-sm text-fg/85">{t("DB Kit 已鎖定")}</div>
            <div className="text-xs text-fg/50">{t("到主視窗解鎖後就能繼續使用。")}</div>
          </div>
        </div>
      )}
      <UiHost />
    </div>
  );
}
