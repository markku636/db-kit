// 工作階段還原：關掉 app 再開，回到上次開著的那幾個查詢分頁（含上次停在哪一個）。
// 純前端、localStorage 持久化（對標 connReadonly / pins）。
//
// 編輯器內容本來就 per-連線 × per-分頁 存著（見 App.tsx 的 sqlStoreKey），缺的只是「分頁清單」——
// 沒有它，重開永遠只掛出一個 home 分頁，其餘分頁的草稿雖然還躺在磁碟上卻沒有分頁承接，
// 對使用者來說就是「上次的查詢沒被記住」。
//
// 只記查詢分頁，不記表分頁：表分頁要有實際連線才開得起來，而啟動時刻意不自動連線
// （密碼在 keychain、gateway 連線還要 OTP、正式環境更不該自己連上去）。

export const SESSION_KEY = "db-kit:session";

/** 分頁數上限：損毀的存檔不該讓啟動時一次掛出上百個分頁。 */
export const MAX_QUERY_TABS = 50;

export interface SessionState {
  /** 開啟中的查詢分頁 id（陣列順序＝分頁列順序）。空陣列＝上次把查詢分頁全關光了，照實還原。 */
  queryTabs: string[];
  /** 上次停留的查詢分頁；null＝交給 MainArea 退回第一個。 */
  activeQueryTab: string | null;
}

/** 首次啟動（無存檔）的預設：一個乾淨的 home 分頁，與改動前的 store 初值一致。 */
const DEFAULT_SESSION: SessionState = { queryTabs: ["__query__"], activeQueryTab: "__query__" };

/** 查詢分頁 id 形狀：home 為 `__query__`，其餘為 `__query__:N`（N ≥ 2，見 store 的 nextQueryTabId）。 */
export function isQueryTabId(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v === "__query__") return true;
  const m = /^__query__:(\d+)$/.exec(v);
  // 允許 :2 起跳且不含前導零——`__query__:02` 不是 nextQueryTabId 產得出來的 id，
  // 放它進來會變成一個永遠對不上 sqlStoreKey 草稿的幽靈分頁。
  return !!m && !m[1].startsWith("0") && Number(m[1]) >= 2;
}

/**
 * 純函式：把存檔正規化成可直接餵給 store 的狀態。
 * 濾掉非法 id、去重、截到上限；active 不在清單內就退回第一個（清單為空則 null）。
 * 整個 queryTabs 不是陣列（存檔損毀）才退回預設——空陣列是使用者的真實選擇，不是損毀。
 */
export function normalizeSession(raw: unknown): SessionState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_SESSION;
  const r = raw as { queryTabs?: unknown; activeQueryTab?: unknown };
  if (!Array.isArray(r.queryTabs)) return DEFAULT_SESSION;
  const queryTabs: string[] = [];
  for (const v of r.queryTabs) {
    if (queryTabs.length >= MAX_QUERY_TABS) break;
    if (isQueryTabId(v) && !queryTabs.includes(v)) queryTabs.push(v);
  }
  const active = r.activeQueryTab;
  return {
    queryTabs,
    activeQueryTab: isQueryTabId(active) && queryTabs.includes(active) ? active : (queryTabs[0] ?? null),
  };
}

// 最後停留過的查詢分頁（模組層記憶）。使用者切去看某張表時 activeTabKey 會變成表分頁鍵，
// 那不該把「停在查詢 3」覆寫掉——回到查詢分頁時本來就該回到原本那一個。
let lastActiveQueryTab: string | null = DEFAULT_SESSION.activeQueryTab;

export function loadSession(): SessionState {
  let parsed: unknown = null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    /* 忽略損毀的存檔 */
  }
  const s = parsed == null ? DEFAULT_SESSION : normalizeSession(parsed);
  lastActiveQueryTab = s.activeQueryTab;
  return s;
}

export function persistSession(s: SessionState) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* 忽略寫入失敗 */
  }
}

/**
 * store 訂閱用：分頁清單 / 作用中分頁一有變動就寫回。
 * activeTabKey 為表分頁（或 null）時沿用上次記住的查詢分頁；該分頁已被關掉才退回第一個。
 */
export function saveQueryTabSession(queryTabs: string[], activeTabKey: string | null) {
  if (isQueryTabId(activeTabKey) && queryTabs.includes(activeTabKey)) {
    lastActiveQueryTab = activeTabKey;
  } else if (lastActiveQueryTab == null || !queryTabs.includes(lastActiveQueryTab)) {
    lastActiveQueryTab = queryTabs[0] ?? null;
  }
  persistSession({ queryTabs, activeQueryTab: lastActiveQueryTab });
}
