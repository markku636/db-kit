// 啟動時檢查 GitHub 是否有更新的 Release，供標題列顯示「有新版」小標記。
// 純前端：直打 GitHub API（其回應帶 Access-Control-Allow-Origin: *，且 tauri.conf.json 的
// security.csp = null，故 packaged webview 的跨網域 fetch 可通過）。任何失敗一律安靜略過，不擋啟動。

export const REPO = "markku636/db-kit";
const CACHE_KEY = "db-kit:update"; // 沿用 db-kit:* localStorage 慣例
const TTL_MS = 24 * 60 * 60 * 1000; // 每天最多打一次 API（避開 GitHub 匿名 60 次/小時限制）
const AUTO_KEY = "db-kit:updateCheck"; // 「啟動時自動檢查更新」開關（"0" = 關閉；預設開）

/** 啟動時是否自動檢查更新（設定頁開關；離線 / 內網環境可關閉）。 */
export function autoCheckEnabled(): boolean {
  try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; }
}

export function setAutoCheckEnabled(on: boolean) {
  try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* 忽略寫入失敗 */ }
}

type Cache = { checkedAt: number; version: string; url: string };
export type UpdateInfo = { version: string; url: string };

/**
 * 語意化版本比較：latest 是否比 current 新。
 * 兩者先去掉開頭的 v、砍掉 pre-release（-）與 build metadata（+），再以 . 切段逐段「數值」比較，
 * 確保 0.2.10 > 0.2.9（非字典序）；段數不同時缺的補 0，無法解析的段以 0 計。
 */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] =>
    String(v)
      .trim()
      .replace(/^v/i, "")
      .split(/[-+]/)[0]
      .split(".")
      .map((s) => {
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const a = parse(latest);
  const b = parse(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cache;
    if (typeof c?.checkedAt === "number" && typeof c?.version === "string" && typeof c?.url === "string") {
      return c;
    }
  } catch {
    /* 忽略毀損快取 */
  }
  return null;
}

/**
 * 取得最新 Release 版本（每天最多打一次 API，其餘走 localStorage 快取）。
 * 回傳 { version, url }：version 已去掉 v 前綴，url 為該 Release 的 GitHub 頁面。
 * 離線 / rate-limit / 尚無 release 等任何失敗都回傳既有快取或 null，不丟例外。
 * 注意：本函式只負責「查最新版」，是否比目前版本新由呼叫端用 isNewer 判斷。
 * force：略過 TTL 直打 API（供「關於」對話框手動檢查用）；失敗時仍回退既有快取。
 */
export async function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateInfo | null> {
  const cached = readCache();
  const fallback = (): UpdateInfo | null => (cached ? { version: cached.version, url: cached.url } : null);
  if (!opts?.force && cached && Date.now() - cached.checkedAt < TTL_MS) return fallback();
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return fallback();
    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const version = (data.tag_name ?? "").trim().replace(/^v/i, "");
    if (!version) return fallback();
    const url = data.html_url || `https://github.com/${REPO}/releases/latest`;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ checkedAt: Date.now(), version, url } satisfies Cache));
    } catch {
      /* 忽略寫入失敗 */
    }
    return { version, url };
  } catch {
    return fallback();
  }
}
