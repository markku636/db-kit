import { create } from "zustand";
import type { AgentProvider } from "./api";

// AI 助手的供應商偏好與各供應商的連線設定。
// 右側助手面板與查詢面板的「AI 生成」列共用同一份選擇，切一次兩邊都跟著換。
// 與 assistant.ts 一致用 localStorage 記住偏好；預設 claude（既有使用者升級後行為不變）。
//
// 兩類供應商：
// - cli：claude / codex，用使用者自己的訂閱登入，App 只負責找執行檔。
// - api：anthropic-api / openai-api，直接打相容端點；Base URL 與模型存這裡（非機密），
//   金鑰在 OS keychain（見 api.ts 的 llmKeySet / llmKeyStatus）。
const PROVIDER_KEY = "db-kit:aiProvider";
const BASE_URL_KEY = "db-kit:aiBaseUrls";
const MODEL_KEY = "db-kit:aiModels";
// v0.27 之前模型偏好夾在助手面板的對話存檔裡，移出來時順手接過來。
const LEGACY_CHAT_KEY = "db-kit:assistantChat";

export type ProviderKind = "cli" | "api";

export interface ProviderMeta {
  id: AgentProvider;
  /** 下拉選單顯示名稱（產品名，不翻譯）。 */
  label: string;
  kind: ProviderKind;
  /** 執行檔名稱，用於「找不到 xxx CLI」提示（僅 cli）。 */
  cli: string;
  /** 官方安裝說明頁（僅 cli）。實際的安裝指令依平台而異，由後端 agent_detect 回報。 */
  installDocs: string;
  /** 登入指令（僅 cli）。 */
  loginCmd: string;
}

export const PROVIDERS: readonly ProviderMeta[] = [
  {
    id: "claude",
    label: "Claude Code",
    kind: "cli",
    cli: "claude",
    installDocs: "https://code.claude.com/docs/en/setup",
    loginCmd: "claude",
  },
  {
    id: "codex",
    label: "OpenAI Codex",
    kind: "cli",
    cli: "codex",
    installDocs: "https://github.com/openai/codex#quickstart",
    loginCmd: "codex login",
  },
  { id: "anthropic-api", label: "Anthropic API", kind: "api", cli: "", installDocs: "", loginCmd: "" },
  { id: "openai-api", label: "OpenAI API", kind: "api", cli: "", installDocs: "", loginCmd: "" },
];

export function providerMeta(id: AgentProvider): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

export function isApiProvider(id: AgentProvider): boolean {
  return providerMeta(id).kind === "api";
}

/**
 * 把存檔裡的字串還原成 AgentProvider；認不得的一律回 null。
 *
 * 落地的對話會記下它是用哪個供應商問的（見 chatSessions.ChatConversation.agentProvider），
 * 而那份存檔可能來自改過名的舊版、或被手動編輯過。`providerMeta` 對未知 id 會**退回第一個**
 * 供應商（讓 UI 不必到處防呆），拿它來判斷「這串該切到哪個供應商」就會把未知值默默當成 Claude，
 * 於是切過去之後 session 對不上、上文整個不見。要判斷「認不認得」只能用這支。
 */
export function asAgentProvider(v: string | null | undefined): AgentProvider | null {
  return PROVIDERS.some((p) => p.id === v) ? (v as AgentProvider) : null;
}

/** 常見服務的 Base URL 一鍵帶入。清單會過期，所以模型名一律自己填 / 現抓，不寫死。 */
export interface ApiPreset {
  id: string;
  label: string;
  provider: AgentProvider;
  baseUrl: string;
  /** 地端端點不需要金鑰。 */
  local?: boolean;
}

export const API_PRESETS: readonly ApiPreset[] = [
  { id: "anthropic", label: "Anthropic", provider: "anthropic-api", baseUrl: "https://api.anthropic.com" },
  { id: "kimi-anthropic", label: "Moonshot Kimi", provider: "anthropic-api", baseUrl: "https://api.moonshot.cn/anthropic" },
  { id: "glm-anthropic", label: "智譜 GLM", provider: "anthropic-api", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
  { id: "deepseek-anthropic", label: "DeepSeek", provider: "anthropic-api", baseUrl: "https://api.deepseek.com/anthropic" },
  { id: "openai", label: "OpenAI", provider: "openai-api", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", provider: "openai-api", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek", label: "DeepSeek", provider: "openai-api", baseUrl: "https://api.deepseek.com/v1" },
  { id: "groq", label: "Groq", provider: "openai-api", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "ollama", label: "Ollama", provider: "openai-api", baseUrl: "http://localhost:11434/v1", local: true },
  { id: "lmstudio", label: "LM Studio", provider: "openai-api", baseUrl: "http://localhost:1234/v1", local: true },
  { id: "vllm", label: "vLLM", provider: "openai-api", baseUrl: "http://localhost:8000/v1", local: true },
];

export function presetsFor(provider: AgentProvider): ApiPreset[] {
  return API_PRESETS.filter((p) => p.provider === provider);
}

/** 各 API 供應商的預設 Base URL（沒設定時用）。 */
export const DEFAULT_BASE_URL: Partial<Record<AgentProvider, string>> = {
  "anthropic-api": "https://api.anthropic.com",
  "openai-api": "https://api.openai.com/v1",
};

/**
 * Claude 的模型別名固定（opus / sonnet / haiku），可安全寫死成下拉。
 * Codex 的模型名稱換得很勤（gpt-5-codex → gpt-5.x-…），寫死只會過期，
 * 故 UI 對 Codex 改用自由輸入，留白即用 codex 自己的預設。
 * API 供應商的模型清單改用 `api.llmListModels` 現抓，抓不到就手填。
 */
export const CLAUDE_MODELS: readonly { value: string; label: string }[] = [
  { value: "", label: "預設模型" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

function isProvider(v: unknown): v is AgentProvider {
  return v === "claude" || v === "codex" || v === "anthropic-api" || v === "openai-api";
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

type ByProvider = Partial<Record<AgentProvider, string>>;

function readMap(key: string): ByProvider {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as ByProvider) : {};
  } catch {
    return {};
  }
}

/** 舊版把模型偏好存在助手對話存檔裡；只在新 key 不存在時接過來一次。 */
function readModels(): ByProvider {
  const cur = readMap(MODEL_KEY);
  if (Object.keys(cur).length > 0) return cur;
  try {
    const raw = localStorage.getItem(LEGACY_CHAT_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v.models === "object" ? (v.models as ByProvider) : {};
  } catch {
    return {};
  }
}

function writeMap(key: string, v: ByProvider): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* 忽略寫入失敗 */
  }
}

interface AiProviderStore {
  provider: AgentProvider;
  setProvider: (v: AgentProvider) => void;
  /** 各 API 供應商的 Base URL（cli 供應商用不到）。 */
  baseUrls: ByProvider;
  setBaseUrl: (p: AgentProvider, v: string) => void;
  /** 各供應商各記一個模型：別名（claude）與完整模型名（API）不能互餵。 */
  models: ByProvider;
  setModel: (p: AgentProvider, v: string) => void;
}

export const useAiProvider = create<AiProviderStore>((set, get) => ({
  provider: readProvider(),
  setProvider: (v) => {
    try {
      localStorage.setItem(PROVIDER_KEY, v);
    } catch {
      /* 忽略寫入失敗 */
    }
    set({ provider: v });
  },
  baseUrls: readMap(BASE_URL_KEY),
  setBaseUrl: (p, v) => {
    const next = { ...get().baseUrls, [p]: v };
    writeMap(BASE_URL_KEY, next);
    set({ baseUrls: next });
  },
  models: readModels(),
  setModel: (p, v) => {
    const next = { ...get().models, [p]: v };
    writeMap(MODEL_KEY, next);
    set({ models: next });
  },
}));

/** 目前這個供應商該用的 Base URL（沒設定就用預設；cli 供應商回空字串）。 */
export function baseUrlOf(provider: AgentProvider, baseUrls: ByProvider): string {
  if (!isApiProvider(provider)) return "";
  const v = (baseUrls[provider] ?? "").trim();
  return v || DEFAULT_BASE_URL[provider] || "";
}
