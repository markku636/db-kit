// SFTP 獨立視窗與主視窗之間的橋。
//
// SSH 連線、終端機與分頁都活在主視窗；獨立視窗是另一個 JS 環境（另一份 store），自己開一條 sftp 通道
// （同一條 SSH 連線，不再問密碼），但連線 id / 狀態、終端機所在的資料夾只有主視窗知道——由主視窗用
// 事件推過去；「在終端機 cd 到此」再推回來。事件全域廣播、payload 帶 tabKey，兩邊各自過濾：
//
//   sftp-win-hello  視窗 → 主視窗：我開好了（或重新載入了），給我目前的狀態
//   sftp-win-state  主視窗 → 視窗：SftpWinState（有變動才送）
//   sftp-win-cd     視窗 → 主視窗：在終端機 cd 到這個資料夾
//   sftp-win-bye    視窗 → 主視窗：我關了
import { create } from "zustand";
import { emit, listen } from "@tauri-apps/api/event";
import { api } from "./api";
import { DEFAULT_RUNTIME, termRegistry, useSshTerminals } from "./sshTerminals";
import { useStore } from "./store";
import { useSshSessions } from "./sshSessions";
import { shellQuote } from "./sshCwd";
import type { SshStatus } from "./sshTypes";

export const EV_HELLO = "sftp-win-hello";
export const EV_STATE = "sftp-win-state";
export const EV_CD = "sftp-win-cd";
export const EV_BYE = "sftp-win-bye";

export interface SftpWinState {
  tabKey: string;
  /** null = 主視窗已經沒有這個分頁。 */
  connId: string | null;
  status: SshStatus;
  /** OSC 0/2 視窗標題與 OSC 7 目錄：視窗靠它們知道終端機在哪個資料夾。 */
  title: string | null;
  cwd: string | null;
  host: string;
  user: string;
  /** 主機設定的 SFTP 起始資料夾（options.ui.sftp_dir）。 */
  startDir: string | null;
  /** 從側邊面板「移到獨立視窗」時面板所在的資料夾：視窗第一次開通道時從這裡開始。 */
  initialDir: string | null;
  /** App 閒置自動鎖定了：視窗蓋上遮罩，到主視窗解鎖後才能用。 */
  locked: boolean;
}

// ---- 主視窗這一側 ----

/** 哪些分頁開著 SFTP 視窗（工具列的 SFTP 按鈕畫成「開著」用）。 */
export const useSftpWindows = create<{ open: Record<string, true> }>(() => ({ open: {} }));

const setOpen = (tabKey: string, on: boolean) =>
  useSftpWindows.setState((s) => {
    if (on === !!s.open[tabKey]) return s;
    const open = { ...s.open };
    if (on) open[tabKey] = true;
    else delete open[tabKey];
    return { open };
  });

const pendingInitialDir = new Map<string, string>();
const lastSent = new Map<string, string>();
let locked = false;
let hostReady: Promise<void> | null = null;

function snapshot(tabKey: string): Omit<SftpWinState, "initialDir"> {
  const rt = useSshTerminals.getState().rt[tabKey];
  const sid = useStore.getState().sshTabs.find((x) => x.key === tabKey)?.sessionId;
  const startDir = sid ? useSshSessions.getState().sessions.find((s) => s.id === sid)?.options.ui?.sftp_dir ?? null : null;
  return {
    tabKey,
    connId: rt ? rt.connId || null : null,
    status: rt?.status ?? "disconnected",
    title: rt?.title ?? null,
    cwd: rt?.cwd ?? null,
    host: rt?.host ?? "",
    user: rt?.user ?? "",
    startDir,
    locked,
  };
}

/** 把狀態推給那個分頁的視窗；`force` = 視窗剛打招呼，就算沒變也要送。 */
function push(tabKey: string, force = false) {
  const snap = snapshot(tabKey);
  const json = JSON.stringify(snap);
  if (!force && lastSent.get(tabKey) === json) return;
  lastSent.set(tabKey, json);
  const initialDir = force ? pendingInitialDir.get(tabKey) ?? null : null;
  if (force) pendingInitialDir.delete(tabKey);
  void emit(EV_STATE, { ...snap, initialDir } satisfies SftpWinState).catch(() => undefined);
}

function forget(tabKey: string) {
  setOpen(tabKey, false);
  lastSent.delete(tabKey);
  pendingInitialDir.delete(tabKey);
}

/** 主視窗第一次開 SFTP 視窗時掛上監聽（之後常駐：成本是三個 listener 與一個 store 訂閱）。 */
function ensureHost(): Promise<void> {
  if (hostReady) return hostReady;
  hostReady = (async () => {
    await listen<{ tabKey: string }>(EV_HELLO, (e) => {
      const k = e.payload?.tabKey;
      if (!k) return;
      setOpen(k, true);
      push(k, true);
    });
    await listen<{ tabKey: string; path: string }>(EV_CD, (e) => {
      const { tabKey, path } = e.payload ?? {};
      if (!tabKey || !path) return;
      void termRegistry.get(tabKey)?.sendLine(`cd ${shellQuote(path)}`).catch(() => undefined);
    });
    await listen<{ tabKey: string }>(EV_BYE, (e) => { if (e.payload?.tabKey) forget(e.payload.tabKey); });
    // 連線 / 標題 / 目錄一變就轉過去；分頁關掉（rt 沒了）視窗也會被收掉，這裡跟著忘掉。
    useSshTerminals.subscribe((s) => {
      for (const k of Object.keys(useSftpWindows.getState().open)) {
        if (!s.rt[k]) forget(k);
        else push(k);
      }
    });
  })().catch((e) => {
    hostReady = null;
    throw e;
  });
  return hostReady;
}

/**
 * 用獨立視窗開這個分頁的 SFTP（已經開著就叫到最前面）。`initialDir`：從側邊面板移過去時，
 * 視窗從面板所在的資料夾開始；沒給就跟側邊面板一樣——終端機所在的資料夾、主機設定的起始資料夾、家目錄。
 */
export async function openSftpWindow(tabKey: string, opts: { title: string; initialDir?: string }): Promise<void> {
  await ensureHost();
  if (opts.initialDir) pendingInitialDir.set(tabKey, opts.initialDir);
  setOpen(tabKey, true);
  try {
    const created = await api.sshSftpWindowOpen(tabKey, `${opts.title} — SFTP`);
    // 叫到前面的是已經開著的視窗：它不會再打招呼，起始資料夾也用不到了。
    if (!created) pendingInitialDir.delete(tabKey);
  } catch (e) {
    forget(tabKey);
    throw e;
  }
}

/** App 鎖定 / 解鎖：開著的 SFTP 視窗跟著蓋上 / 拿掉遮罩。 */
export function setSftpWindowsLocked(v: boolean) {
  if (locked === v) return;
  locked = v;
  for (const k of Object.keys(useSftpWindows.getState().open)) push(k);
}

// ---- SFTP 視窗這一側 ----

/** 聽主視窗推來的狀態（只收自己分頁的）。 */
export function listenHostState(tabKey: string, cb: (s: SftpWinState) => void): Promise<() => void> {
  return listen<SftpWinState>(EV_STATE, (e) => { if (e.payload?.tabKey === tabKey) cb(e.payload); });
}
export const sayHello = (tabKey: string) => emit(EV_HELLO, { tabKey });
export const sayBye = (tabKey: string) => emit(EV_BYE, { tabKey });
export const requestCd = (tabKey: string, path: string) => emit(EV_CD, { tabKey, path });

/**
 * 主視窗的狀態寫進這個視窗自己的 useSshTerminals，SftpPanel 就能照在主視窗裡一樣運作。
 * sftpId 是這個視窗自己開的通道：連線 id 沒換就留著；換了（重新連線）清掉，面板會在新連線上重開。
 */
export function applyHostState(s: SftpWinState) {
  useSshTerminals.setState((st) => {
    const cur = st.rt[s.tabKey];
    const connId = s.connId ?? "";
    return {
      rt: {
        ...st.rt,
        [s.tabKey]: {
          ...DEFAULT_RUNTIME,
          ...cur,
          connId,
          status: s.connId ? s.status : "disconnected",
          title: s.title,
          cwd: s.cwd,
          host: s.host,
          user: s.user,
          sftpId: cur && cur.connId === connId ? cur.sftpId : null,
          sftpOpen: true,
        },
      },
    };
  });
}
