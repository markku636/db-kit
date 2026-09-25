// SSH 終端機的執行期狀態（每個分頁一份）與 xterm 實例登錄。
//
// 為何不放進 useStore：xterm 實例不可序列化、輸出每秒可能上百次更新，進全域 store 會讓整個 app 跟著
// re-render。這裡的 `rt` 只放「狀態點 / 標題 / 最近指令」這類低頻欄位；xterm 實例與資料流掛在
// 非反應式的 termRegistry，AI 助手要讀畫面尾端時按需從 xterm buffer 取，不另外維護一份副本。
import { create } from "zustand";
import type { Terminal } from "@xterm/xterm";
import { api } from "./api";
import { t } from "./i18n";
import { useStore } from "./store";
import { isSshTabKey } from "./sshTabs";
import type { SshStatus } from "./sshTypes";
import { createOutputCapture } from "./sshCapture";

export interface SshTermRuntime {
  /** 前端產生的連線 id（每次重連換一個）。 */
  connId: string;
  termId: string | null;
  sftpId: string | null;
  status: SshStatus;
  /** 斷線 / 失敗原因（顯示在疊層）。 */
  error: string | null;
  /** OSC 0/2 設定的視窗標題（shell 通常放 user@host:cwd）。 */
  title: string | null;
  host: string;
  user: string;
  /** OSC 7 回報的目前目錄（需 shell 支援；沒有就 null）。 */
  cwd: string | null;
  lastCommand: string | null;
  lastOutput: string | null;
  /** SFTP 分割面板是否展開。 */
  sftpOpen: boolean;
}

export interface CaptureResult {
  output: string;
  durationMs: number;
  truncated: boolean;
}

/** xterm 實例與資料流的非反應式登錄（key = tabKey）。由 SshTerminalPane 掛載 / 卸載時維護。 */
export interface TermRegistryEntry {
  term: Terminal;
  /** 送一整行（後端補 Enter）。未連線時 reject。 */
  sendLine: (line: string) => Promise<void>;
  /** 監聽從後端來的原始 bytes（AI「執行並回饋」擷取輸出用）；回傳取消函式。 */
  tapData: (fn: (bytes: Uint8Array) => void) => () => void;
  focus: () => void;
  reconnect: () => void;
}
export const termRegistry = new Map<string, TermRegistryEntry>();

/** SFTP 面板每個分頁上次停在哪個資料夾（面板關掉再打開要回到原處）。放這裡而不是 SftpPanel：那支是延遲載入的。 */
export const sftpLastPath = new Map<string, string>();

interface SshTerminalsStore {
  rt: Record<string, SshTermRuntime>;
  /** 命令列輸入條的內容（受控；AI「送到終端機」會附加進來）。 */
  compose: Record<string, string>;
  patch: (tabKey: string, p: Partial<SshTermRuntime>) => void;
  remove: (tabKey: string) => void;
  setCompose: (tabKey: string, text: string) => void;
  /** 附加（非取代）：使用者可能正在打字，AI 建議接在後面、以換行隔開。 */
  insertCompose: (tabKey: string, text: string) => void;
  /**
   * 送一行指令並擷取輸出直到閒置（預設 300 ms）／上限（8 s / 8 KB）。
   * 多行以 \r 隔開一次送出（PTY 把 CR 當 Enter）。未連線時 reject，不會掛住。
   */
  sendCommand: (tabKey: string, line: string, opts?: { idleMs?: number; maxMs?: number; maxBytes?: number }) => Promise<CaptureResult>;
}

export const DEFAULT_RUNTIME: Omit<SshTermRuntime, "connId" | "host" | "user"> = {
  termId: null,
  sftpId: null,
  status: "connecting",
  error: null,
  title: null,
  cwd: null,
  lastCommand: null,
  lastOutput: null,
  sftpOpen: false,
};

export const useSshTerminals = create<SshTerminalsStore>((set, get) => ({
  rt: {},
  compose: {},
  patch: (tabKey, p) =>
    set((s) => {
      const cur = s.rt[tabKey];
      if (!cur) return {};
      return { rt: { ...s.rt, [tabKey]: { ...cur, ...p } } };
    }),
  remove: (tabKey) =>
    set((s) => {
      const rt = { ...s.rt };
      const compose = { ...s.compose };
      delete rt[tabKey];
      delete compose[tabKey];
      return { rt, compose };
    }),
  setCompose: (tabKey, text) => set((s) => ({ compose: { ...s.compose, [tabKey]: text } })),
  insertCompose: (tabKey, text) =>
    set((s) => {
      const cur = s.compose[tabKey] ?? "";
      const joined = cur.trim() ? `${cur.replace(/\s+$/, "")}\n${text}` : text;
      return { compose: { ...s.compose, [tabKey]: joined } };
    }),
  sendCommand: async (tabKey, line, opts) => {
    const reg = termRegistry.get(tabKey);
    const rt = get().rt[tabKey];
    if (!reg || !rt || rt.status !== "connected" || !rt.termId) {
      throw new Error(t("終端機尚未連線"));
    }
    // 多行 → 逐行 Enter；尾端不留換行（後端會補）。
    const normalized = line.replace(/\r\n?/g, "\n").replace(/\n+$/, "").replace(/\n/g, "\r");
    const firstLine = normalized.split("\r")[0] ?? normalized;
    const cap = createOutputCapture({
      idleMs: opts?.idleMs ?? 300,
      maxMs: opts?.maxMs ?? 8000,
      maxBytes: opts?.maxBytes ?? 8192,
      echo: firstLine,
    });
    const untap = reg.tapData((b) => cap.push(b));
    try {
      await reg.sendLine(normalized);
      const r = await cap.promise;
      get().patch(tabKey, { lastCommand: line, lastOutput: r.output });
      return r;
    } catch (e) {
      cap.cancel();
      throw e;
    } finally {
      untap();
    }
  },
}));

/** 目前作用中的分頁是 SSH 分頁才回其鍵（AI 自動上下文與「送到終端機」的預設目標）。 */
export function activeSshTabKey(): string | null {
  const k = useStore.getState().activeTabKey;
  return isSshTabKey(k) ? k : null;
}

export function isSshOpen(tabKey: string): boolean {
  return useSshTerminals.getState().rt[tabKey]?.status === "connected";
}

/** 已連線的 SSH 分頁鍵清單（依分頁列順序）。 */
export function connectedSshTabKeys(): string[] {
  const rt = useSshTerminals.getState().rt;
  return useStore.getState().sshTabs.map((t) => t.key).filter((k) => rt[k]?.status === "connected");
}

/**
 * 從 xterm buffer 讀畫面尾端（最多 lines 行，已是純文字：xterm 早就處理掉游標移動 / 進度條重繪）。
 * 自動換行的長行併回同一行；尾端空行去掉。
 */
export function sshTail(tabKey: string, lines = 200): string {
  const reg = termRegistry.get(tabKey);
  if (!reg) return "";
  const buf = reg.term.buffer.active;
  const out: string[] = [];
  // 從尾往前取，遇到 wrapped 行要併到它的上一行，故多抓一些再裁。
  const start = Math.max(0, buf.length - lines * 2);
  for (let i = start; i < buf.length; i++) {
    const l = buf.getLine(i);
    if (!l) continue;
    const text = l.translateToString(true);
    if (l.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.slice(-lines).join("\n");
}

/** 取消某分頁所有等待中的動作並釋放後端資源（分頁關閉時由 pane 呼叫）。 */
export async function teardownSshTab(tabKey: string): Promise<void> {
  const rt = useSshTerminals.getState().rt[tabKey];
  useSshTerminals.getState().remove(tabKey);
  termRegistry.delete(tabKey);
  sftpLastPath.delete(tabKey);
  if (!rt) return;
  // 順序：sftp → term → conn；任一失敗都繼續，後端 disconnect 會把殘留的 channel 一併收掉。
  if (rt.sftpId) await api.sshSftpClose(rt.sftpId).catch(() => undefined);
  if (rt.termId) await api.sshTermClose(rt.termId).catch(() => undefined);
  await api.sshDisconnect(rt.connId).catch(() => undefined);
}

/**
 * 從 `api.sshTermSendLine` 送出前先把多行正規化成 CR 分隔；命令列輸入條與 AI 走同一條路。
 * 回傳 false 代表沒送（未連線）。
 */
export async function sendLineToTab(tabKey: string, line: string): Promise<boolean> {
  const rt = useSshTerminals.getState().rt[tabKey];
  if (!rt?.termId || rt.status !== "connected") return false;
  const normalized = line.replace(/\r\n?/g, "\n").replace(/\n+$/, "").replace(/\n/g, "\r");
  await api.sshTermSendLine(rt.termId, normalized);
  useSshTerminals.getState().patch(tabKey, { lastCommand: line });
  return true;
}
