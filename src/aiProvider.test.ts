import { describe, it, expect, beforeEach } from "vitest";

// node 測試環境無 localStorage，提供最小記憶體實作（須在 import 受測模組前備妥：
// aiProvider / aiSkills 的 store 在模組載入時就會讀取偏好）。
const __mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in __mem ? __mem[k] : null),
  setItem: (k: string, v: string) => { __mem[k] = String(v); },
  removeItem: (k: string) => { delete __mem[k]; },
  clear: () => { for (const k of Object.keys(__mem)) delete __mem[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

const { API_PRESETS, baseUrlOf, DEFAULT_BASE_URL, isApiProvider, presetsFor, PROVIDERS, providerMeta } = await import("./aiProvider");
const { BUILTIN_SKILLS, composeSystemPrompt, defaultPersona, useAiSkills } = await import("./aiSkills");

describe("AI 供應商清單", () => {
  it("四個供應商：兩個 CLI、兩個 API", () => {
    expect(PROVIDERS.map((p) => p.id)).toEqual(["claude", "codex", "anthropic-api", "openai-api"]);
    expect(PROVIDERS.filter((p) => p.kind === "api").map((p) => p.id)).toEqual(["anthropic-api", "openai-api"]);
    expect(isApiProvider("claude")).toBe(false);
    expect(isApiProvider("openai-api")).toBe(true);
  });

  it("未知供應商退回第一個（設錯字串不該讓 UI 壞掉）", () => {
    expect(providerMeta("nope" as never).id).toBe("claude");
  });

  it("預設清單只列出屬於該供應商的項目，且 Base URL 都是絕對網址", () => {
    for (const p of API_PRESETS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      // 地端端點才允許 http
      if (p.baseUrl.startsWith("http://")) expect(p.local).toBe(true);
    }
    expect(presetsFor("anthropic-api").every((p) => p.provider === "anthropic-api")).toBe(true);
    expect(presetsFor("openai-api").some((p) => p.id === "ollama")).toBe(true);
    expect(presetsFor("claude")).toEqual([]);
  });

  it("baseUrlOf：沒設定用預設值、CLI 供應商一律空字串", () => {
    expect(baseUrlOf("openai-api", {})).toBe(DEFAULT_BASE_URL["openai-api"]);
    expect(baseUrlOf("anthropic-api", { "anthropic-api": " https://proxy.example/v1 " })).toBe("https://proxy.example/v1");
    // 只填空白 = 沒填
    expect(baseUrlOf("anthropic-api", { "anthropic-api": "   " })).toBe(DEFAULT_BASE_URL["anthropic-api"]);
    expect(baseUrlOf("claude", { claude: "https://x" })).toBe("");
  });
});

describe("人設與技能", () => {
  beforeEach(() => {
    localStorage.clear();
    useAiSkills.setState({ persona: "", custom: [], selected: [] });
  });

  it("人設留白時用內建預設；填了就用填的", () => {
    expect(composeSystemPrompt("", [])).toBe(defaultPersona());
    expect(composeSystemPrompt("  只講中文  ", [])).toBe("只講中文");
  });

  it("技能接在人設後面，withSkills=false 則完全不附（NL→SQL 用）", () => {
    const skill = { id: "s1", name: "只讀", body: "只給查詢" };
    const withSkill = composeSystemPrompt("人設", [skill]);
    expect(withSkill.startsWith("人設")).toBe(true);
    expect(withSkill).toContain("只讀");
    expect(withSkill).toContain("只給查詢");
    expect(composeSystemPrompt("人設", [skill], false)).toBe("人設");
  });

  it("空 body 的技能不佔位（新增後還沒寫內容時）", () => {
    expect(composeSystemPrompt("人設", [{ id: "s1", name: "空的", body: "   " }])).toBe("人設");
  });

  it("自訂技能：新增 / 修改 / 勾選 / 刪除，且刪除會一併取消勾選", () => {
    const s = useAiSkills.getState();
    const id = s.add("我的技能", "內容");
    expect(useAiSkills.getState().custom).toHaveLength(1);

    useAiSkills.getState().update(id, { body: "新內容" });
    expect(useAiSkills.getState().custom[0].body).toBe("新內容");

    useAiSkills.getState().toggle(id);
    expect(useAiSkills.getState().activeSkills().map((x) => x.id)).toEqual([id]);

    useAiSkills.getState().remove(id);
    expect(useAiSkills.getState().custom).toHaveLength(0);
    expect(useAiSkills.getState().selected).toEqual([]);
  });

  it("all()：內建在前、自訂在後；內建不可被刪除", () => {
    useAiSkills.getState().add("我的", "x");
    const all = useAiSkills.getState().all();
    expect(all.slice(0, BUILTIN_SKILLS.length).every((x) => x.builtin)).toBe(true);
    expect(all[all.length - 1].builtin).toBeUndefined();
    useAiSkills.getState().remove(BUILTIN_SKILLS[0].id);
    expect(useAiSkills.getState().all().filter((x) => x.builtin)).toHaveLength(BUILTIN_SKILLS.length);
  });
});
