import { describe, it, expect, beforeEach, vi } from "vitest";

// node 測試環境無 localStorage，提供最小記憶體實作（須在 import 受測模組前備妥）。
const mem: Record<string, string> = {};
globalThis.localStorage = {
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => { mem[k] = String(v); },
  removeItem: (k: string) => { delete mem[k]; },
  clear: () => { for (const k of Object.keys(mem)) delete mem[k]; },
  key: () => null,
  length: 0,
} as unknown as Storage;

// 後端只 mock 資源庫的兩支寫入：存設定就把設定換掉、存檔就把那一筆放進快照（模擬後端重讀）。
const saved: any[] = [];
vi.mock("./api", async () => {
  const lib = await import("./aiLibrary");
  return {
    api: {
      aiLibrarySettingsSet: vi.fn(async (settingsValue: any) => ({ ...lib.useAiLibrary.getState().snapshot, settings: settingsValue })),
      aiLibrarySave: vi.fn(async (req: any) => {
        saved.push(req);
        const snap = lib.useAiLibrary.getState().snapshot;
        const entry = {
          kind: req.kind,
          name: req.name,
          layer: "personal",
          layerLabel: "個人",
          writable: true,
          variants: { "": { fields: { name: req.name, ...req.fields }, body: req.body ?? "", raw: "", path: `/p/${req.name}` } },
          shadowed: [],
          builtin: null,
        };
        return { ...snap, entries: [...snap.entries, entry] };
      }),
    },
  };
});

const { builtinSnapshot, useAiLibrary } = await import("./aiLibrary");
const { currentSystemPrompt, migrateLegacySkills, useAiSkills, assistantPersonaName } = await import("./aiSkills");
const { useLang } = await import("./i18n");

beforeEach(() => {
  localStorage.clear();
  saved.length = 0;
  useLang.setState({ lang: "zh-TW", catalog: {}, fallback: {} });
  useAiLibrary.setState({ snapshot: builtinSnapshot(), loaded: true, error: null });
  useAiSkills.setState({ selected: [] });
});

describe("人設與技能（資源庫轉接層）", () => {
  it("預設人設是內建 assistant", () => {
    expect(assistantPersonaName()).toBe("assistant");
    expect(currentSystemPrompt()).toMatch(/^你是 db-kit 內建的資料庫助手/);
  });

  it("設定指到不存在的人設時退回 assistant（打錯設定值不該讓 AI 失能）", () => {
    const snap = useAiLibrary.getState().snapshot;
    useAiLibrary.setState({ snapshot: { ...snap, settings: { ...snap.settings, assistant_persona: "nope" } } });
    expect(assistantPersonaName()).toBe("assistant");
  });

  it("勾選技能會附在人設後面；withSkills=false（一次性生成）完全不附", async () => {
    useAiSkills.getState().toggle("sql-perf");
    expect(useAiSkills.getState().selected).toEqual(["sql-perf"]);
    expect(currentSystemPrompt(true)).toContain("[技能：SQL 效能診斷]");
    expect(currentSystemPrompt(false)).not.toContain("[技能：");
    // 選取寫進資源庫設定檔
    await vi.waitFor(() => expect(useAiLibrary.getState().snapshot.settings.active_skills).toEqual(["sql-perf"]));
  });

  it("all()：資源庫的技能，內建標為 builtin", () => {
    const all = useAiSkills.getState().all();
    expect(all.find((s) => s.id === "lock-risk")).toMatchObject({ name: "鎖與併發風險", builtin: true });
  });
});

describe("migrateLegacySkills", () => {
  it("舊人設 / 自訂技能 / 勾選一次搬進個人層並設好設定", async () => {
    localStorage.setItem("db-kit:aiPersona", "  你是我的助手  ");
    localStorage.setItem("db-kit:aiSkills", JSON.stringify([{ id: "skill:abc", name: "Team Rules", body: "禁止 SELECT *" }, { id: "skill:def", name: "中文名稱", body: "x" }]));
    localStorage.setItem("db-kit:aiSkillsOn", JSON.stringify(["builtin:perf", "skill:abc", "builtin:gone"]));
    await migrateLegacySkills();
    expect(saved.map((r) => `${r.kind}:${r.name}`)).toEqual(["agent:my-assistant", "skill:team-rules", "skill:my-skill"]);
    expect(saved[0]).toMatchObject({ layer: "personal", body: "你是我的助手", fields: { "dbkit-role": "assistant" } });
    const s = useAiLibrary.getState().snapshot.settings;
    expect(s.migrated_local_v1).toBe(true);
    expect(s.assistant_persona).toBe("my-assistant");
    expect(s.active_skills).toEqual(["sql-perf", "team-rules"]);
    expect(currentSystemPrompt(false)).toBe("你是我的助手");
  });

  it("已遷移或沒有快照時不動作", async () => {
    localStorage.setItem("db-kit:aiPersona", "x");
    useAiLibrary.setState({ loaded: false });
    await migrateLegacySkills();
    const snap = useAiLibrary.getState().snapshot;
    useAiLibrary.setState({ loaded: true, snapshot: { ...snap, settings: { ...snap.settings, migrated_local_v1: true } } });
    await migrateLegacySkills();
    expect(saved).toEqual([]);
  });

  it("沒有舊資料：只寫旗標，人設維持預設", async () => {
    await migrateLegacySkills();
    expect(saved).toEqual([]);
    expect(useAiLibrary.getState().snapshot.settings).toMatchObject({ migrated_local_v1: true, assistant_persona: "assistant", active_skills: [] });
  });
});
