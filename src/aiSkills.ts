import { create } from "zustand";
import {
  entriesOf,
  findEntry,
  libSettings,
  personaSystemPrompt,
  personas,
  saveLibraryEntry,
  skillInfo,
  updateLibrarySettings,
  useAiLibrary,
  type LibEntry,
} from "./aiLibrary";
import { t } from "./i18n";

// AI 助手的「人設」與「技能」——現在是 AI 資源庫（ai-library/）的轉接層。
//
// - 人設 = 資源庫 agents/ 裡 `dbkit-role: assistant` 的那一份（預設內建 `assistant`），由
//   ai-library.json 的 `assistant_persona` 決定用哪一個。
// - 技能 = 資源庫 skills/（Agent Skills 標準的 SKILL.md）；助手對話勾選的清單存在 `active_skills`。
//
// 早期版本把人設與自訂技能存在 localStorage。第一次拿到後端快照時 `migrateLegacySkills` 會把它們
// 寫成個人層的檔案（agents/my-assistant.md、skills/<名>/SKILL.md）並設好選取；舊鍵保留一個版本，
// 萬一要退版還拿得回來。
const PERSONA_KEY = "db-kit:aiPersona";
const SKILLS_KEY = "db-kit:aiSkills";
const SELECTED_KEY = "db-kit:aiSkillsOn";

export interface AiSkill {
  /** 資源庫裡的技能名稱（`name`）。 */
  id: string;
  /** 顯示名稱（`dbkit-title`）。 */
  name: string;
  body: string;
  /** 內建技能（唯讀；要改就在資源庫「複製為自訂」）。 */
  builtin?: boolean;
}

/** 舊 id（localStorage 時代的內建技能）→ 資源庫名稱。 */
const LEGACY_IDS: Record<string, string> = {
  "builtin:perf": "sql-perf",
  "builtin:model-review": "model-review",
  "builtin:readonly": "readonly-first",
  "builtin:migration": "migration",
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function readLegacyPersona(): string {
  try {
    return localStorage.getItem(PERSONA_KEY) ?? "";
  } catch {
    return "";
  }
}

function readLegacyCustom(): { id: string; name: string; body: string }[] {
  const v = readJson<unknown>(SKILLS_KEY, []);
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x && typeof x.id === "string" && typeof x.name === "string" && typeof x.body === "string");
}

function readLegacySelected(): string[] {
  const v = readJson<unknown>(SELECTED_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function toSkill(e: LibEntry): AiSkill {
  const info = skillInfo(e);
  return { id: e.name, name: info.title, body: info.body, builtin: e.layer === "builtin" };
}

/** 目前勾選中的技能名稱：已遷移讀設定檔，否則沿用舊 localStorage 的選取（對應成新名稱）。 */
function selectedNow(): string[] {
  const s = libSettings().active_skills;
  if (s) return s;
  return readLegacySelected().map((id) => LEGACY_IDS[id] ?? id);
}

interface AiSkillsStore {
  /** 助手對話勾選中的技能名稱。 */
  selected: string[];
  toggle: (id: string) => void;
  /** 全部技能（資源庫勝出的版本）。 */
  all: () => AiSkill[];
  /** 勾選中的技能（依 all() 的順序）。 */
  activeSkills: () => AiSkill[];
}

export const useAiSkills = create<AiSkillsStore>((set, get) => ({
  selected: selectedNow(),
  toggle: (id) => {
    const cur = get().selected;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set({ selected: next });
    // 樂觀更新：寫檔失敗就退回（store 的 error 會顯示在資源庫對話框）。
    void updateLibrarySettings({ active_skills: next }).catch(() => set({ selected: cur }));
  },
  all: () => entriesOf("skill").map(toSkill),
  activeSkills: () => {
    const sel = get().selected;
    return get().all().filter((s) => sel.includes(s.id));
  },
}));

// 資源庫快照換了（載入 / 其他視窗改了設定）→ 選取跟著設定檔走。
useAiLibrary.subscribe((s, prev) => {
  if (s.snapshot.settings.active_skills !== prev.snapshot.settings.active_skills) {
    useAiSkills.setState({ selected: selectedNow() });
  }
});

/** 助手（對話 / 一次性生成）目前的人設名稱。 */
export function assistantPersonaName(): string {
  const n = libSettings().assistant_persona?.trim();
  return n && findEntry("agent", n) ? n : "assistant";
}

/**
 * 組出要送給模型的系統提示詞（助手人設 + 勾選的技能）。
 *
 * 一次性模式（NL→SQL、編輯器改寫）只吃人設不吃技能：技能是給對話用的工作方式，
 * 套在「只回一句 SQL」的情境會把輸出帶偏。
 */
export function currentSystemPrompt(withSkills = true): string {
  return personaSystemPrompt(assistantPersonaName(), { extraSkills: withSkills ? useAiSkills.getState().selected : [] });
}

/** 助手人設的候選（資源庫裡 dbkit-role: assistant 的人設）。 */
export function assistantPersonas(): LibEntry[] {
  return personas("assistant");
}

// ---------------------------------------------------------------------------
// 舊版 localStorage → 資源庫
// ---------------------------------------------------------------------------

function slugify(name: string, taken: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "my-skill";
  let s = base;
  for (let i = 2; taken.has(s) || findEntry("skill", s); i++) s = `${base}-${i}`;
  taken.add(s);
  return s;
}

/**
 * 一次性遷移：舊人設（非空才搬）→ `agents/my-assistant.md`；自訂技能 → `skills/<名>/SKILL.md`；
 * 勾選 → `active_skills`。最後寫入 `migrated_local_v1`，之後不再執行。
 * 任何一步失敗都不寫旗標——下次啟動再試，不會半途而廢地把使用者的東西弄丟。
 */
export async function migrateLegacySkills(): Promise<void> {
  const { loaded, snapshot } = useAiLibrary.getState();
  if (!loaded || snapshot.settings.migrated_local_v1) return;
  const persona = readLegacyPersona().trim();
  const custom = readLegacyCustom();
  const idMap: Record<string, string> = { ...LEGACY_IDS };
  const taken = new Set<string>();
  let assistant = snapshot.settings.assistant_persona;
  if (persona && !findEntry("agent", "my-assistant")) {
    await saveLibraryEntry({
      kind: "agent",
      name: "my-assistant",
      layer: "personal",
      fields: {
        description: t("從舊版 AI 設定搬過來的助手人設。"),
        "dbkit-title": t("我的助手人設"),
        "dbkit-role": "assistant",
      },
      body: persona,
    });
    assistant = "my-assistant";
  }
  for (const s of custom) {
    const slug = slugify(s.name, taken);
    await saveLibraryEntry({
      kind: "skill",
      name: slug,
      layer: "personal",
      fields: { description: s.name, "dbkit-title": s.name },
      body: s.body,
    });
    idMap[s.id] = slug;
  }
  const active = readLegacySelected().map((id) => idMap[id] ?? id).filter((n) => !!findEntry("skill", n));
  await updateLibrarySettings({ migrated_local_v1: true, assistant_persona: assistant, active_skills: active });
}
