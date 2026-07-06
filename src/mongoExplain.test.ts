import { describe, expect, it } from "vitest";
import { parseMongoExplain, withVerbosity } from "./mongoExplain";

// 傳統 find + executionStats（IXSCAN → FETCH）。
const FIND_IXSCAN = JSON.stringify({
  queryPlanner: {
    namespace: "shop.orders",
    winningPlan: {
      stage: "FETCH",
      inputStage: { stage: "IXSCAN", indexName: "status_1", direction: "forward" },
    },
  },
  executionStats: {
    nReturned: 42,
    executionTimeMillis: 7,
    totalKeysExamined: 42,
    totalDocsExamined: 42,
    executionStages: {
      stage: "FETCH",
      nReturned: 42,
      executionTimeMillisEstimate: 5,
      docsExamined: 42,
      inputStage: {
        stage: "IXSCAN",
        indexName: "status_1",
        nReturned: 42,
        keysExamined: 42,
      },
    },
  },
  serverInfo: { host: "db1" },
  ok: 1,
});

// queryPlanner-only 的 COLLSCAN（未執行 → 無 summary）。
const COLLSCAN_PLANNER = JSON.stringify({
  queryPlanner: {
    namespace: "shop.orders",
    winningPlan: { stage: "COLLSCAN", filter: { status: { $eq: "paid" } }, direction: "forward" },
  },
  ok: 1,
});

// SBE（MongoDB 6+）：winningPlan.queryPlan 內才是傳統計畫。
const SBE_WRAPPED = JSON.stringify({
  queryPlanner: {
    namespace: "shop.orders",
    winningPlan: {
      queryPlan: {
        stage: "FETCH",
        inputStage: { stage: "IXSCAN", indexName: "created_-1" },
      },
      slotBasedPlan: { stages: "..." },
    },
  },
  ok: 1,
});

// sharded find：winningPlan.shards[] 各自帶 winningPlan。
const SHARDED_FIND = JSON.stringify({
  queryPlanner: {
    winningPlan: {
      stage: "SHARD_MERGE",
      shards: [
        { shardName: "rs0", winningPlan: { stage: "COLLSCAN" } },
        { shardName: "rs1", winningPlan: { stage: "IXSCAN", indexName: "uid_1" } },
      ],
    },
  },
  ok: 1,
});

// aggregate：stages[]，$cursor 內含 find 計畫，其後為 $group。
const AGG_STAGES = JSON.stringify({
  stages: [
    {
      $cursor: {
        queryPlanner: { winningPlan: { stage: "COLLSCAN" } },
        executionStats: {
          nReturned: 100,
          executionTimeMillis: 3,
          executionStages: { stage: "COLLSCAN", nReturned: 100, docsExamined: 500 },
        },
      },
    },
    { $group: { _id: "$status" }, nReturned: 4, executionTimeMillisEstimate: 1 },
  ],
  serverInfo: { host: "db1" },
  ok: 1,
});

describe("parseMongoExplain", () => {
  it("find + executionStats：優先用 executionStages（帶指標），並彙整摘要", () => {
    const m = parseMongoExplain(FIND_IXSCAN)!;
    expect(m).not.toBeNull();
    expect(m.root.stage).toBe("FETCH");
    expect(m.root.children[0].stage).toBe("IXSCAN");
    expect(m.root.children[0].keysExamined).toBe(42);
    expect(m.summary).not.toBeNull();
    expect(m.summary!.nReturned).toBe(42);
    expect(m.summary!.executionTimeMillis).toBe(7);
    expect(m.summary!.indexes).toContain("status_1");
    expect(m.summary!.collscan).toBe(false);
    expect(m.ns).toBe("shop.orders");
    expect(m.server).toBe("db1");
  });

  it("queryPlanner-only：無 summary，COLLSCAN 標警訊", () => {
    const m = parseMongoExplain(COLLSCAN_PLANNER)!;
    expect(m.summary).toBeNull();
    expect(m.root.stage).toBe("COLLSCAN");
    expect(m.root.warn).toBe(true);
    expect(m.root.detail).toContain("paid");
  });

  it("SBE：解開 winningPlan.queryPlan 包裝", () => {
    const m = parseMongoExplain(SBE_WRAPPED)!;
    expect(m.root.stage).toBe("FETCH");
    expect(m.root.children[0].indexName).toBe("created_-1");
  });

  it("sharded find：每分片一子樹並帶 shard 名", () => {
    const m = parseMongoExplain(SHARDED_FIND)!;
    expect(m.root.stage).toBe("SHARD_MERGE");
    expect(m.root.children).toHaveLength(2);
    expect(m.root.children[0].shard).toBe("rs0");
    expect(m.root.children[0].stage).toBe("COLLSCAN");
    expect(m.root.children[1].indexName).toBe("uid_1");
  });

  it("aggregate stages[]：$cursor 展開內部計畫、管線階段各為節點", () => {
    const m = parseMongoExplain(AGG_STAGES)!;
    expect(m.root.stage).toBe("PIPELINE");
    expect(m.root.children[0].stage).toBe("COLLSCAN");
    expect(m.root.children[0].docsExamined).toBe(500);
    expect(m.root.children[1].stage).toBe("$group");
    expect(m.root.children[1].nReturned).toBe(4);
  });

  it("垃圾輸入回 null（呼叫端 fallback 顯示原始 JSON）", () => {
    expect(parseMongoExplain("not json")).toBeNull();
    expect(parseMongoExplain("{}")).toBeNull();
    expect(parseMongoExplain('{"ok":1}')).toBeNull();
  });
});

describe("withVerbosity", () => {
  it("注入 / 覆寫 verbosity，不動其他鍵", () => {
    const out = JSON.parse(withVerbosity('{"db":"d","collection":"c","verbosity":"executionStats"}', "queryPlanner"));
    expect(out.verbosity).toBe("queryPlanner");
    expect(out.db).toBe("d");
  });
  it("非 JSON 原樣回傳（後端負責報錯）", () => {
    expect(withVerbosity("oops", "queryPlanner")).toBe("oops");
  });
});
