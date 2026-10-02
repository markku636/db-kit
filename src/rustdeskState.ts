// RustDesk 連線中的狀態（工具列、聊天、連線品質要的）與偏好設定（存在主機的 options.ui）。純邏輯，單元測試用。
//
// 對方的事件（bridge 轉來的 JSON）：`permission`（對方開 / 關某個權限；一開始只送被關掉的）、`chat`、
// `block_input`（封鎖輸入的結果）、`delay`（對方量到的來回延遲）。畫面 / 螢幕 / 剪貼簿的事件由 RustDeskView 處理。
import type { RdMonitors } from "./rdMonitors";

export type RdViewMode = "adaptive" | "original";
export type RdQuality = "best" | "balanced" | "low";
export type RdCodecPref = "auto" | "vp9" | "vp8" | "av1";

/** 每台主機記住的顯示偏好（官方用戶端也是每台各記各的）。 */
export interface RustDeskPrefs {
  view: RdViewMode;
  quality: RdQuality;
  codec: RdCodecPref;
  /** 顯示連線品質（畫面左上角的 FPS / 延遲 / 速率）。 */
  stats: boolean;
  /** 連線結束後鎖定對方的畫面。 */
  lockAfterEnd: boolean;
}

/** 對方的預設：畫質「平衡」、編碼由登入時宣告的決定。 */
export const DEFAULT_PREFS: RustDeskPrefs = { view: "adaptive", quality: "balanced", codec: "auto", stats: false, lockAfterEnd: false };

const UI_KEYS: Record<keyof RustDeskPrefs, string> = {
  view: "rustdesk_view",
  quality: "rustdesk_quality",
  codec: "rustdesk_codec",
  stats: "rustdesk_stats",
  lockAfterEnd: "rustdesk_lock_after_end",
};

function pick<T extends string>(v: string | undefined, allowed: readonly T[], d: T): T {
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : d;
}

export function prefsFromUi(ui: Record<string, string> | undefined): RustDeskPrefs {
  const u = ui ?? {};
  return {
    view: pick(u[UI_KEYS.view], ["adaptive", "original"] as const, DEFAULT_PREFS.view),
    quality: pick(u[UI_KEYS.quality], ["best", "balanced", "low"] as const, DEFAULT_PREFS.quality),
    codec: pick(u[UI_KEYS.codec], ["auto", "vp9", "vp8", "av1"] as const, DEFAULT_PREFS.codec),
    stats: u[UI_KEYS.stats] === "1",
    lockAfterEnd: u[UI_KEYS.lockAfterEnd] === "1",
  };
}

/** 寫回 options.ui（保留其他鍵；跟預設一樣的就拿掉，檔案裡只留改過的）。 */
export function prefsToUi(p: RustDeskPrefs, ui: Record<string, string> | undefined): Record<string, string> {
  const out = { ...(ui ?? {}) };
  for (const k of Object.keys(UI_KEYS) as (keyof RustDeskPrefs)[]) {
    const key = UI_KEYS[k];
    const v = p[k];
    if (v === DEFAULT_PREFS[k]) delete out[key];
    else out[key] = typeof v === "boolean" ? (v ? "1" : "0") : v;
  }
  return out;
}

/** 對方給這條連線的權限（`PermissionInfo`）；沒說就是有。 */
export type RdPerm = "keyboard" | "clipboard" | "audio" | "file" | "restart" | "recording" | "block_input" | "privacy_mode";
export const ALL_PERMS: RdPerm[] = ["keyboard", "clipboard", "audio", "file", "restart", "recording", "block_input", "privacy_mode"];

export interface RdChatMsg {
  from: "me" | "peer";
  text: string;
  /** Date.now()。 */
  at: number;
}

export interface RdStats {
  fps: number;
  /** 收到的影像資料，KB/s。 */
  kbps: number;
  /** 對方量到的來回延遲（毫秒）；還沒量到 = null。 */
  delay: number | null;
  codec: string;
  width: number;
  height: number;
}

export interface RustDeskState {
  monitors: RdMonitors;
  /** `Windows` / `Linux` / `Mac OS` / `Android`。 */
  platform: string;
  version: string;
  perms: Record<RdPerm, boolean>;
  /** 這個 WebView 解得了哪些編碼（WebCodecs）。 */
  codecs: { vp9: boolean; vp8: boolean; av1: boolean };
  /** 對方的鍵盤滑鼠被這端封鎖中。 */
  blockInput: boolean;
  chat: RdChatMsg[];
  stats: RdStats | null;
  recording: boolean;
}

export function initialState(): RustDeskState {
  return {
    monitors: { displays: [], shown: [0], multi: true },
    platform: "",
    version: "",
    perms: Object.fromEntries(ALL_PERMS.map((p) => [p, true])) as Record<RdPerm, boolean>,
    codecs: { vp9: true, vp8: true, av1: false },
    blockInput: false,
    chat: [],
    stats: null,
    recording: false,
  };
}

/** 聊天最多留幾則（太舊的丟掉）。 */
export const MAX_CHAT = 500;

/**
 * 套用對方的事件；回傳新的狀態（沒變就回原物件）與要提示使用者的話（`notice`：封鎖輸入失敗等）。
 * `connected` 只換對方資訊與權限（螢幕清單由 RustDeskView 管）。
 */
export function applyEvent(s: RustDeskState, ev: Record<string, unknown>, now = Date.now()): { state: RustDeskState; notice?: "block_on_failed" | "block_off_failed" } {
  switch (ev.type) {
    case "connected": {
      const peer = (ev.peer ?? {}) as Record<string, unknown>;
      return {
        state: {
          ...s,
          platform: typeof peer.platform === "string" ? peer.platform : "",
          version: typeof peer.version === "string" ? peer.version : "",
          perms: initialState().perms,
          blockInput: false,
        },
      };
    }
    case "permission": {
      const name = ev.name as RdPerm;
      if (!ALL_PERMS.includes(name) || typeof ev.enabled !== "boolean") return { state: s };
      if (s.perms[name] === ev.enabled) return { state: s };
      return { state: { ...s, perms: { ...s.perms, [name]: ev.enabled } } };
    }
    case "chat": {
      if (typeof ev.text !== "string" || !ev.text) return { state: s };
      return { state: { ...s, chat: [...s.chat, { from: "peer" as const, text: ev.text, at: now }].slice(-MAX_CHAT) } };
    }
    case "block_input": {
      const on = ev.on === true;
      if (ev.ok === true) return { state: { ...s, blockInput: on } };
      return { state: s, notice: on ? "block_on_failed" : "block_off_failed" };
    }
    case "delay": {
      if (typeof ev.ms !== "number" || !s.stats) return { state: s };
      return { state: { ...s, stats: { ...s.stats, delay: ev.ms } } };
    }
  }
  return { state: s };
}

export function addMyChat(s: RustDeskState, text: string, now = Date.now()): RustDeskState {
  return { ...s, chat: [...s.chat, { from: "me" as const, text, at: now }].slice(-MAX_CHAT) };
}

/** 對方是 Windows（封鎖輸入只有 Windows 對方支援，官方工具列也只在這時顯示）。 */
export function isWindowsPeer(s: Pick<RustDeskState, "platform">): boolean {
  return s.platform === "Windows";
}

/** 重新啟動：官方只對 Windows / Linux / macOS 對方顯示。 */
export function canRestart(s: Pick<RustDeskState, "platform" | "perms">): boolean {
  return s.perms.restart && ["Windows", "Linux", "Mac OS"].includes(s.platform);
}

/** WebCodecs 的 codec 字串（跟 RustDeskView 解碼用的一樣）。 */
export const WEBCODECS: Record<"vp9" | "vp8" | "av1", string> = {
  vp9: "vp09.00.10.08",
  vp8: "vp8",
  av1: "av01.0.08M.08",
};

/** 這個 WebView 能解哪些（`VideoDecoder.isConfigSupported`）；不支援 WebCodecs → 全部 false。 */
export async function probeCodecs(): Promise<RustDeskState["codecs"]> {
  if (typeof VideoDecoder === "undefined") return { vp9: false, vp8: false, av1: false };
  const one = async (codec: string) => {
    try {
      return (await VideoDecoder.isConfigSupported({ codec })).supported === true;
    } catch {
      return false;
    }
  };
  const [vp9, vp8, av1] = await Promise.all([one(WEBCODECS.vp9), one(WEBCODECS.vp8), one(WEBCODECS.av1)]);
  return { vp9, vp8, av1 };
}
