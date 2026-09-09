import { create } from "zustand";
import type { AgentProvider } from "./api";

// AI 助手的 CLI 供應商偏好（Claude Code / OpenAI Codex）。
// 右側助手面板與查詢面板的「AI 生成」列共用同一個選擇，切一次兩邊都跟著換。
// 與 assistant.ts 一致用 localStorage 記住偏好；預設 claude（既有使用者升級後行為不變）。
const PROVIDER_KEY = "db-kit:aiProvider";

export interface ProviderMeta {
  id: AgentProvider;
  /** 下拉選單顯示名稱（產品名，不翻譯）。 */
  label: string;
  /** 執行檔名稱，用於「找不到 xxx CLI」提示。 */
  cli: string;
  /** 安裝方式（提示用一行字，非可執行指令）。 */
  install: string;
  /** 登入指令。 */
  loginCmd: string;
}

export const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: "claude",
    label: "Claude Code",
    cli: "claude",
    install: "claude.ai/install",
    loginCmd: "claude",
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    cli: "codex",
    install: "npm i -g @openai/codex",
    loginCmd: "codex login",
  },
];

export function providerMeta(id: AgentProvider): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/**
 * Claude 的模型別名固定（opus / sonnet / haiku），可安全寫死成下拉。
 * Codex 的模型名稱換得很勤（gpt-5-codex → gpt-5.x-…），寫死只會過期，
 * 故 UI 對 Codex 改用自由輸入，留白即用 codex 自己的預設。
 */
export const CLAUDE_MODELS: readonly { value: string; label: string }[] = [
  { value: "", label: "預設模型" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

function isProvider(v: unknown): v is AgentProvider {
  return v === "claude" || v === "codex";
}

function readProvider(): AgentProvider {
  try {
    const v = localStorage.getItem(PROVIDER_KEY);
    if (isProvider(v)) return v;
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return "claude";
}

interface AiProviderStore {
  provider: AgentProvider;
  setProvider: (v: AgentProvider) => void;
}

export const useAiProvider = create<AiProviderStore>((set) => ({
  provider: readProvider(),
  setProvider: (v) => {
    try {
      localStorage.setItem(PROVIDER_KEY, v);
    } catch {
      /* 忽略寫入失敗 */
    }
    set({ provider: v });
  },
}));
