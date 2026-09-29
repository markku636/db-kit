import { describe, it, expect, beforeEach } from "vitest";
import {
  builtinSnapshot,
  classifyPath,
  entriesOf,
  findEntry,
  personaInfo,
  personas,
  personaSystemPrompt,
  renderTaskWith,
  resolveVariant,
  taskMeta,
  useAiLibrary,
  type LibEntry,
} from "./aiLibrary";
import { useLang } from "./i18n";
import { fieldList, fieldStr, referencedVars, sectionProblem, usesVar } from "./promptTemplate";

beforeEach(() => {
  useLang.setState({ lang: "zh-TW", catalog: {}, fallback: {} });
  useAiLibrary.setState({ snapshot: builtinSnapshot(), loaded: false });
});

describe("classifyPath", () => {
  it("認得四種資源與語言變體", () => {
    expect(classifyPath("prompts/fix.md")).toEqual({ kind: "prompt", group: "prompts/fix", lang: "", stem: "fix" });
    expect(classifyPath("prompts/fix.en.md")).toMatchObject({ kind: "prompt", group: "prompts/fix", lang: "en" });
    expect(classifyPath("skills/lock-risk/SKILL.zh-CN.md")).toMatchObject({ kind: "skill", group: "skills/lock-risk", lang: "zh-CN" });
    expect(classifyPath("agents/team/dba-x.md")).toMatchObject({ kind: "agent", group: "agents/team/dba-x" });
    expect(classifyPath("contracts/verdict.md")).toMatchObject({ kind: "contract" });
  });

  it("不認得的路徑回 null（技能只認 SKILL.md、範本不收子資料夾）", () => {
    expect(classifyPath("skills/x/README.md")).toBeNull();
    expect(classifyPath("prompts/sub/x.md")).toBeNull();
    expect(classifyPath("other/x.md")).toBeNull();
    expect(classifyPath("prompts/x.txt")).toBeNull();
  });

  it("不是語言碼的點不算變體（v1.2 不是語言）", () => {
    expect(classifyPath("prompts/review.v1.md")).toMatchObject({ lang: "", stem: "review.v1" });
  });
});

describe("resolveVariant", () => {
  const entry = (): LibEntry => findEntry("prompt", "fix")!;

  it("語言鏈：en → 英文變體；ja / ko / vi 沒有變體時退到英文", () => {
    expect(resolveVariant(entry(), "en").lang).toBe("en");
    expect(resolveVariant(entry(), "ja").lang).toBe("en");
    expect(resolveVariant(entry(), "zh-CN").lang).toBe("zh-CN");
  });

  it("zh-TW 用基底；基底宣告 dbkit-lang 時回報該語言", () => {
    expect(resolveVariant(entry(), "zh-TW").lang).toBe("zh-TW");
    expect(resolveVariant(findEntry("prompt", "review-pre-exec")!, "zh-TW").lang).toBe("en");
  });

  it("變體欄位疊在基底上（說明可翻譯，任務登錄仍來自基底）", () => {
    const r = resolveVariant(entry(), "en");
    expect(fieldStr(r.fields, "dbkit-title")).toBe("Fix error");
    expect(fieldStr(r.fields, "dbkit-contract")).toBe("sql-edit");
  });
});

describe("renderTaskWith", () => {
  it("契約語言跟著範本：英文基底的執行前審查配英文結論契約", () => {
    const r = renderTaskWith("review-pre-exec", { script: "S", static_analysis: "A", engine: "MySQL" });
    expect(r.lang).toBe("en");
    expect(r.text).toContain("The FIRST line of your reply must be exactly one of:");
  });

  it("以指定本文渲染（預覽 / 編輯本次提示）：漏掉必要變數會附在最後並回報", () => {
    const r = renderTaskWith("fix", { sql: "```sql\nX\n```", error: "E" }, { body: "只剩一行" });
    expect(r.missing).toEqual(["sql", "error"]);
    expect(r.text).toContain("只剩一行\n\n```sql\nX\n```\n\nE");
    // 契約不在本文裡 → 附在最後
    expect(r.text).toMatch(/1\. 只輸出一個 ```sql 程式碼區塊[\s\S]*$/);
  });

  it("未知任務丟錯（寫錯任務名要在開發時就炸出來）", () => {
    expect(() => renderTaskWith("no-such-task", {})).toThrow(/unknown AI task/);
  });
});

describe("人設", () => {
  it("DBA 人設清單與預設值對得上", () => {
    const names = personas("dba").map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["dba-senior", "dba-prod-gatekeeper", "dba-performance", "dba-security"]));
    expect(personas("assistant").map((e) => e.name)).toContain("assistant");
  });

  it("personaInfo：工具白名單去掉 mcp__dbkit__ 前綴；守門員不給 run_query / sample_rows", () => {
    const g = personaInfo(findEntry("agent", "dba-prod-gatekeeper")!);
    expect(g.dbTools).toBe(true);
    expect(g.toolAllow).toEqual(["list_databases", "list_tables", "describe_table", "explain_query"]);
    expect(g.maxTurns).toBe(10);
    const a = personaInfo(findEntry("agent", "assistant")!);
    expect(a.toolAllow).toBeNull();
  });

  it("personaSystemPrompt：人設本文 + 預載技能 + 片段；找不到人設退回 assistant", () => {
    const sp = personaSystemPrompt("dba-prod-gatekeeper", { fragments: ["【片段】"] });
    expect(sp.startsWith("你是負責正式環境變更核准的 DBA 守門員")).toBe(true);
    expect(sp).toContain("[技能：鎖與併發風險]");
    expect(sp).toContain("[技能：線上 DDL]");
    expect(sp.endsWith("【片段】")).toBe(true);
    expect(personaSystemPrompt("nope")).toContain("你是 db-kit 內建的資料庫助手");
  });
});

// 內建資源庫的健全性檢查：新增 / 修改 ai-library/ 的檔案時，這一段就是 lint。
describe("內建資源庫", () => {
  const snap = builtinSnapshot();
  const prompts = entriesOf("prompt", snap);

  it("每個範本：引用的變數都在 dbkit-vars 裡、區段配對、必要變數都有直接輸出", () => {
    for (const p of prompts) {
      const meta = taskMeta(p);
      for (const [lang, v] of Object.entries(p.variants)) {
        const where = `${p.name}${lang ? `.${lang}` : ""}`;
        expect(sectionProblem(v.body), where).toBeNull();
        for (const name of referencedVars(v.body)) {
          if (name === "contract") continue;
          expect(meta.vars, `${where} 用了未宣告的變數 {{${name}}}`).toContain(name);
        }
        for (const r of meta.required) expect(usesVar(v.body, r), `${where} 沒輸出必要變數 ${r}`).toBe(true);
        if (meta.contract) expect(usesVar(v.body, "contract"), `${where} 沒放 {{contract}}`).toBe(true);
      }
    }
  });

  it("範本宣告的契約都存在；每個語言變體都有對應的基底", () => {
    for (const p of prompts) {
      const c = taskMeta(p).contract;
      if (c) expect(findEntry("contract", c, snap), `${p.name} → ${c}`).not.toBeNull();
    }
    for (const e of snap.entries) expect(e.variants[""], e.name).toBeDefined();
  });

  it("人設預載的技能都存在；名稱符合 Claude Code / Agent Skills（小寫、數字、連字號）", () => {
    for (const e of snap.entries.filter((x) => x.kind === "agent" || x.kind === "skill")) {
      expect(e.name, e.name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(fieldStr(e.variants[""].fields, "description")?.trim(), `${e.name} 缺 description`).toBeTruthy();
    }
    for (const a of entriesOf("agent", snap)) {
      for (const s of fieldList(a.variants[""].fields, "skills")) {
        expect(findEntry("skill", s, snap), `${a.name} → ${s}`).not.toBeNull();
      }
    }
  });

  it("語言變體不帶任務登錄欄位（一律取自基底，避免兩份漂移）", () => {
    for (const e of snap.entries) {
      for (const [lang, v] of Object.entries(e.variants)) {
        if (!lang) continue;
        for (const k of ["dbkit-mode", "dbkit-contract", "dbkit-vars", "dbkit-required", "tools", "skills", "maxTurns"]) {
          expect(v.fields[k], `${e.name}.${lang} 不該有 ${k}`).toBeUndefined();
        }
      }
    }
  });
});
