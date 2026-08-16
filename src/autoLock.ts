// 閒置自動重新鎖定：使用者停手夠久之後，把鎖定畫面重新蓋回主介面上。
//
// 判定刻意用 **wall-clock 相減**（Date.now()）而非單一 setTimeout：筆電闔蓋 / 系統休眠期間
// timer 不會前進，但那段時間正是最需要算進閒置的——用 setTimeout 的話，闔蓋一整晚回來
// 反而還剩幾分鐘才鎖，語意完全相反。

import { useEffect, useRef } from "react";

/** 判定是否已閒置到該鎖定。`minutes <= 0` 表示關閉自動鎖定，恆回 false。 */
export function isIdle(lastActivityMs: number, nowMs: number, minutes: number): boolean {
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  return nowMs - lastActivityMs >= minutes * 60_000;
}

/** 使用者活動事件。passive + capture：不干擾任何既有處理，也不被 stopPropagation 擋掉。 */
const ACTIVITY_EVENTS = ["mousedown", "mousemove", "wheel", "keydown", "touchstart"] as const;

/** 檢查頻率。閒置門檻最小是 5 分鐘，15 秒的解析度綽綽有餘，又不會讓 timer 太吵。 */
const TICK_MS = 15_000;

/** 活動時間戳的寫入節流：mousemove 一秒可以噴上百次，沒必要每次都寫。 */
const RECORD_THROTTLE_MS = 1_000;

/**
 * 閒置達 `minutes` 分鐘時呼叫 `onIdle`。`minutes <= 0` 時完全不掛任何 listener 與 timer。
 *
 * `onIdle` 以 ref 保存：呼叫端通常是行內箭頭函式，放進依賴陣列會讓每次 render 都重掛
 * listener，順帶把 lastActivity 洗掉，永遠鎖不了。
 */
export function useAutoLock(minutes: number, onIdle: () => void): void {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!Number.isFinite(minutes) || minutes <= 0) return;

    let last = Date.now();
    let lastRecorded = last;
    const record = () => {
      const now = Date.now();
      if (now - lastRecorded < RECORD_THROTTLE_MS) return;
      lastRecorded = now;
      last = now;
    };

    const opts: AddEventListenerOptions = { passive: true, capture: true };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, record, opts);

    const timer = window.setInterval(() => {
      if (isIdle(last, Date.now(), minutes)) {
        // 先停掉自己再回呼：鎖定畫面蓋上後 hook 會因為條件改變而卸載，
        // 但這一輪的 interval 仍可能再觸發一次。
        window.clearInterval(timer);
        onIdleRef.current();
      }
    }, TICK_MS);

    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, record, opts);
      window.clearInterval(timer);
    };
  }, [minutes]);
}
