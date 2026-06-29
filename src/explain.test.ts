import { describe, it, expect } from "vitest";
import { buildExplainJsonSql, parseExplainPlan, planSummary } from "./explain";

describe("buildExplainJsonSql", () => {
  it("wraps per dialect and strips trailing semicolon", () => {
    expect(buildExplainJsonSql("mysql", "SELECT 1;")).toBe("EXPLAIN FORMAT=JSON SELECT 1");
    expect(buildExplainJsonSql("external", "SELECT 1")).toBe("EXPLAIN FORMAT=JSON SELECT 1");
    expect(buildExplainJsonSql("postgres", "SELECT 1 ; ")).toBe("EXPLAIN (FORMAT JSON) SELECT 1");
  });
  it("returns null for unsupported kinds / empty", () => {
    expect(buildExplainJsonSql("sqlite", "SELECT 1")).toBeNull();
    expect(buildExplainJsonSql("redis", "GET k")).toBeNull();
    expect(buildExplainJsonSql("mysql", "  ")).toBeNull();
  });
});

describe("parseExplainPlan — MySQL", () => {
  const json = JSON.stringify({
    query_block: {
      select_id: 1,
      cost_info: { query_cost: "1238.20" },
      nested_loop: [
        { table: { table_name: "film", access_type: "ALL", rows_produced_per_join: 1000, cost_info: { prefix_cost: "38.00" }, key: null } },
        { table: { table_name: "category", access_type: "ref", key: "PRIMARY", rows_produced_per_join: 16, cost_info: { prefix_cost: "69.14" } } },
      ],
    },
  });
  it("normalizes query_block + nested_loop into a join tree", () => {
    const plan = parseExplainPlan("mysql", json)!;
    expect(plan.kind).toBe("query_block");
    expect(plan.cost).toBe(1238.2);
    expect(plan.children).toHaveLength(1);
    const join = plan.children[0];
    expect(join.kind).toBe("join");
    expect(join.children.map((c) => c.label)).toEqual(["film", "category"]);
    expect(join.children[1].detail).toContain("key: PRIMARY");
    expect(join.children[0].rows).toBe(1000);
  });
  it("collapses a single-table block (no extra wrapper)", () => {
    const single = JSON.stringify({ query_block: { table: { table_name: "t", access_type: "ALL", cost_info: { prefix_cost: "1.0" } } } });
    const plan = parseExplainPlan("mysql", single)!;
    expect(plan.kind).toBe("table");
    expect(plan.label).toBe("t");
  });
});

describe("parseExplainPlan — MySQL cost & robustness fixes", () => {
  it("uses per-step cost (read+eval) for the table node, keeps prefix in detail", () => {
    const j = JSON.stringify({ query_block: { cost_info: { query_cost: "100" }, table: { table_name: "t", access_type: "ALL", cost_info: { read_cost: "8", eval_cost: "2", prefix_cost: "90" }, rows_produced_per_join: 5 } } });
    const plan = parseExplainPlan("mysql", j)!;
    const tbl = plan.kind === "table" ? plan : plan.children[0];
    expect(tbl.cost).toBe(10); // read+eval, NOT cumulative prefix(90)
    expect(tbl.detail).toContain("prefix 90");
  });
  it("excludes the query_block total from maxCost so a leaf is the hotspot", () => {
    const plan = parseExplainPlan("mysql", JSON.stringify({ query_block: { cost_info: { query_cost: "999" }, table: { table_name: "t", cost_info: { read_cost: "5", eval_cost: "1" }, rows_produced_per_join: 3 } } }))!;
    expect(planSummary(plan).maxCost).toBe(6); // table step cost, not 999
  });
  it("surfaces the optimizer message (e.g. 'No tables used')", () => {
    const plan = parseExplainPlan("mysql", JSON.stringify({ query_block: { select_id: 1, message: "No tables used" } }))!;
    expect(plan.detail).toContain("No tables used");
  });
  it("drops a malformed union branch instead of nulling the whole plan", () => {
    const j = JSON.stringify({ query_block: { union_result: { query_specifications: [
      { query_block: { table: { table_name: "a", cost_info: { prefix_cost: "1" } } } },
      { /* malformed: no query_block */ },
    ] } } });
    const plan = parseExplainPlan("mysql", j);
    expect(plan).not.toBeNull();
    expect(plan!.label).toBe("Union");
    expect(plan!.children).toHaveLength(1);
  });
});

describe("parseExplainPlan — PostgreSQL", () => {
  const json = JSON.stringify([
    {
      Plan: {
        "Node Type": "Hash Join",
        "Total Cost": 1238.2,
        "Plan Rows": 200,
        "Join Type": "Inner",
        Plans: [
          { "Node Type": "Seq Scan", "Relation Name": "film", "Total Cost": 38.0, "Plan Rows": 1000 },
          { "Node Type": "Hash", "Total Cost": 33.01, "Plan Rows": 1000, Plans: [{ "Node Type": "Seq Scan", "Relation Name": "category", "Total Cost": 1.16, "Plan Rows": 16 }] },
        ],
      },
    },
  ]);
  it("normalizes Plan tree with relations and costs", () => {
    const plan = parseExplainPlan("postgres", json)!;
    expect(plan.label).toBe("Hash Join");
    expect(plan.cost).toBe(1238.2);
    expect(plan.rows).toBe(200);
    expect(plan.children).toHaveLength(2);
    expect(plan.children[0].label).toBe("Seq Scan");
    expect(plan.children[0].detail).toContain("rel: film");
    expect(plan.children[1].children[0].label).toBe("Seq Scan");
  });
});

describe("parseExplainPlan — robustness", () => {
  it("returns null on invalid / empty / unexpected JSON", () => {
    expect(parseExplainPlan("mysql", "not json")).toBeNull();
    expect(parseExplainPlan("mysql", "")).toBeNull();
    expect(parseExplainPlan("mysql", "{}")).toBeNull();
    expect(parseExplainPlan("postgres", "[]")).toBeNull();
  });
});

describe("planSummary", () => {
  it("counts nodes / tables and finds max cost", () => {
    const plan = parseExplainPlan("postgres", JSON.stringify([
      { Plan: { "Node Type": "Hash Join", "Total Cost": 100, Plans: [
        { "Node Type": "Seq Scan", "Relation Name": "a", "Total Cost": 40 },
        { "Node Type": "Seq Scan", "Relation Name": "b", "Total Cost": 30 },
      ] } },
    ]))!;
    const s = planSummary(plan);
    expect(s.nodes).toBe(3);
    expect(s.tables).toBe(2);
    expect(s.maxCost).toBe(100);
  });
});
