import { create } from "zustand";
import { t } from "./i18n";

// AI 助手的「人設」與「技能」。
//
// - 人設 = 系統提示詞：語氣、規矩、輸出格式。留白就用內建的預設人設。
// - 技能 = 可重複套用的提示詞範本：勾起來才會附在人設後面，可同時勾多個。
//
// 四種供應商共用同一份設定：CLI 走 `--append-system-prompt`（codex 沒有這個旗標，
// 由後端併進提示本文），API 供應商走 `system` 欄位 / `messages[0]`。
//
// 內建技能不可刪、也不可就地編輯（要改就「複製為自訂」）——這樣升級時內建內容才能跟著更新，
// 而使用者改過的那份不會被蓋掉。
const PERSONA_KEY = "db-kit:aiPersona";
const SKILLS_KEY = "db-kit:aiSkills";
const SELECTED_KEY = "db-kit:aiSkillsOn";

export interface AiSkill {
  id: string;
  name: string;
  body: string;
  /** 內建範本：唯讀，只能勾選或複製。 */
  builtin?: boolean;
}

/** 內建人設。字面值即翻譯 key（`t()` 查不到就回中文原文）。 */
export const DEFAULT_PERSONA_ZH =
  "你是 db-kit 內建的資料庫助手。回答簡潔、直接給結論與可執行的語句；不確定的地方要說不確定，不要編造欄位或資料表名稱。牽涉寫入或結構變更時，一律提醒風險並附上回滾方式。";

export function defaultPersona(): string {
  return t(DEFAULT_PERSONA_ZH);
}

/** 內建技能（`name` / `body` 都走 `t()`）。 */
export const BUILTIN_SKILLS: readonly AiSkill[] = [
  {
    id: "builtin:perf",
    name: "SQL 效能診斷",
    body: "先看執行計畫再下結論：指出瓶頸在哪一步、缺哪個索引、預估改善幅度，並附上建立索引的語句。沒有執行計畫時，明講你需要哪些資訊。",
    builtin: true,
  },
  {
    id: "builtin:model-review",
    name: "資料模型審查",
    body: "從正規化、鍵值設計、型別選用、索引與命名一致性五個面向檢視結構，指出問題與影響，並給出修改後的 DDL。",
    builtin: true,
  },
  {
    id: "builtin:readonly",
    name: "唯讀安全至上",
    body: "只提供查詢語句。不要產生 INSERT / UPDATE / DELETE / DDL；使用者要求寫入時，改為說明風險並提供對應的查詢來驗證影響範圍。",
    builtin: true,
  },
  {
    id: "builtin:migration",
    name: "遷移腳本",
    body: "產生可回滾的遷移：up 與 down 各一段，標註是否會鎖表、資料量大時的分批做法，以及執行前的備份指令。",
    builtin: true,
  },
];

function readPersona(): string {
  try {
    return localStorage.getItem(PERSONA_KEY) ?? "";
  } catch {
    return "";
  }
}

function readCustom(): AiSkill[] {
  try {
    const raw = localStorage.getItem(SKILLS_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => x && typeof x.id === "string" && typeof x.name === "string" && typeof x.body === "string")
      .map((x) => ({ id: x.id as string, name: x.name as string, body: x.body as string }));
  } catch {
    return [];
  }
}

function readSelected(): string[] {
  try {
    const raw = localStorage.getItem(SELECTED_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    /* 忽略寫入失敗 */
  }
}

/**
 * 組出要送給模型的系統提示詞。
 *
 * `generate` 模式（NL→SQL）只吃人設不吃技能：技能是給對話用的工作方式，
 * 套在「只回一句 SQL」的情境會把輸出帶偏。
 */
export function composeSystemPrompt(persona: string, skills: AiSkill[], withSkills = true): string {
  const parts: string[] = [];
  const p = persona.trim() || defaultPersona();
  parts.push(p);
  if (withSkills) {
    for (const s of skills) {
      const name = s.builtin ? t(s.name) : s.name;
      const body = s.builtin ? t(s.body) : s.body;
      if (body.trim()) parts.push(`[${t("技能")}：${name}]\n${body.trim()}`);
    }
  }
  return parts.join("\n\n");
}

interface AiSkillsStore {
  persona: string;
  setPersona: (v: string) => void;
  /** 使用者自訂的技能（內建的不存進來）。 */
  custom: AiSkill[];
  /** 勾選中的技能 id。 */
  selected: string[];
  toggle: (id: string) => void;
  add: (name: string, body: string) => string;
  update: (id: string, patch: Partial<Pick<AiSkill, "name" | "body">>) => void;
  remove: (id: string) => void;
  /** 全部技能 = 內建 + 自訂。 */
  all: () => AiSkill[];
  /** 勾選中的技能物件（依 all() 的順序）。 */
  activeSkills: () => AiSkill[];
}

export const useAiSkills = create<AiSkillsStore>((set, get) => ({
  persona: readPersona(),
  setPersona: (v) => {
    write(PERSONA_KEY, v);
    set({ persona: v });
  },
  custom: readCustom(),
  selected: readSelected(),
  toggle: (id) => {
    const cur = get().selected;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    write(SELECTED_KEY, next);
    set({ selected: next });
  },
  add: (name, body) => {
    const id = `skill:${Date.now().toString(36)}`;
    const next = [...get().custom, { id, name, body }];
    write(SKILLS_KEY, next);
    set({ custom: next });
    return id;
  },
  update: (id, patch) => {
    const next = get().custom.map((s) => (s.id === id ? { ...s, ...patch } : s));
    write(SKILLS_KEY, next);
    set({ custom: next });
  },
  remove: (id) => {
    const next = get().custom.filter((s) => s.id !== id);
    const sel = get().selected.filter((x) => x !== id);
    write(SKILLS_KEY, next);
    write(SELECTED_KEY, sel);
    set({ custom: next, selected: sel });
  },
  all: () => [...BUILTIN_SKILLS, ...get().custom],
  activeSkills: () => {
    const sel = get().selected;
    return get().all().filter((s) => sel.includes(s.id));
  },
}));

/** 供元件外呼叫（送出前組提示詞）。 */
export function currentSystemPrompt(withSkills = true): string {
  const s = useAiSkills.getState();
  return composeSystemPrompt(s.persona, withSkills ? s.activeSkills() : [], withSkills);
}
