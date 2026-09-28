import { describe, it, expect } from "vitest";
import cases from "../src-tauri/tests/fixtures/ai-render-cases.json";
import {
  composeSystem,
  composeTask,
  fieldBool,
  fieldList,
  parseFrontmatter,
  referencedVars,
  renderTemplate,
  sectionProblem,
  usesVar,
} from "./promptTemplate";

// 共用案例：後端 render.rs / frontmatter.rs 的測試跑的是同一份檔案。這裡綠、那裡紅，就是兩個實作分岔了。
describe("共用案例（與後端一致）", () => {
  for (const c of cases.render) {
    it(`render: ${c.name}`, () => {
      expect(renderTemplate(c.tpl, c.vars)).toBe(c.out);
    });
  }
  for (const c of cases.compose) {
    it(`compose: ${c.name}`, () => {
      const r = composeTask({ body: c.body, vars: c.vars, contract: c.contract, required: c.required });
      expect(r.text).toBe(c.out);
      expect(r.missing).toEqual(c.missing);
    });
  }
  for (const c of cases.frontmatter) {
    it(`frontmatter: ${c.name}`, () => {
      const d = parseFrontmatter(c.text);
      expect(d.fields).toEqual(c.fields);
      expect(d.body).toBe(c.body);
      expect(d.hasFrontmatter).toBe(c.has_frontmatter);
    });
  }
  for (const c of cases.system) {
    it(`system: ${c.name}`, () => {
      expect(composeSystem(c.persona, c.skills, c.fragments, c.label)).toBe(c.out);
    });
  }
});

describe("欄位存取", () => {
  it("清單欄位同時接受 YAML 清單與逗號字串（Claude Code 的 tools 是後者）", () => {
    const { fields } = parseFrontmatter("---\ntools: Read, Grep\nskills: [a, b]\n---\n");
    expect(fieldList(fields, "tools")).toEqual(["Read", "Grep"]);
    expect(fieldList(fields, "skills")).toEqual(["a", "b"]);
    expect(fieldList(fields, "missing")).toEqual([]);
  });

  it("布林欄位：true / yes / 1 / on 為真；缺席用預設值", () => {
    const { fields } = parseFrontmatter("---\na: true\nb: no\nc: YES\n---\n");
    expect(fieldBool(fields, "a")).toBe(true);
    expect(fieldBool(fields, "b", true)).toBe(false);
    expect(fieldBool(fields, "c")).toBe(true);
    expect(fieldBool(fields, "d", true)).toBe(true);
  });
});

describe("範本分析（lint 用）", () => {
  it("usesVar 只認直接輸出，不認區段標籤", () => {
    expect(usesVar("{{#sql}}x{{/sql}}", "sql")).toBe(false);
    expect(usesVar("a {{ sql }} b", "sql")).toBe(true);
  });

  it("referencedVars 依出現順序去重，含區段", () => {
    expect(referencedVars("{{#a}}{{b}}{{/a}}{{b}}{{^c}}{{/c}}")).toEqual(["a", "b", "c"]);
  });

  it("sectionProblem 找出沒配對的區段", () => {
    expect(sectionProblem("{{#a}}{{/a}}")).toBeNull();
    expect(sectionProblem("{{#a}}")).toBe("{{#a}}");
    expect(sectionProblem("{{#a}}{{/b}}")).toBe("{{/b}}");
  });
});
