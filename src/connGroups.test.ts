import { describe, expect, it } from "vitest";
import type { ConnectionConfig, ConnGroup } from "./api";
import {
  deleteGroup,
  flatten,
  groupSize,
  moveConnection,
  moveGroup,
  sectionize,
  toPlacements,
  uniqueGroupName,
} from "./connGroups";

const c = (id: string, group_id: string | null = null): ConnectionConfig =>
  ({ id, name: id, kind: "sqlite", host: "", port: 0, username: "", password: "", group_id }) as ConnectionConfig;
const g = (id: string, name = id.toUpperCase()): ConnGroup => ({ id, name });

/** 顯示順序的簡寫，方便斷言。 */
const ids = (cs: ConnectionConfig[]) => cs.map((x) => x.id);
const layout = (cs: ConnectionConfig[], gs: ConnGroup[]) =>
  sectionize(cs, gs).map((s) => [s.group?.id ?? "-", ids(s.conns)] as const);

describe("sectionize", () => {
  it("依群組順序分區，未分組永遠在最後", () => {
    const conns = [c("a", "g2"), c("b"), c("c", "g1")];
    expect(layout(conns, [g("g1"), g("g2")])).toEqual([
      ["g1", ["c"]],
      ["g2", ["a"]],
      ["-", ["b"]],
    ]);
  });

  it("空群組仍要出現（要有拖放目標）", () => {
    expect(layout([c("a")], [g("empty")])).toEqual([
      ["empty", []],
      ["-", ["a"]],
    ]);
  });

  it("group_id 指向不存在的群組 → 當作未分組，不憑空生出區段", () => {
    expect(layout([c("a", "ghost")], [g("g1")])).toEqual([
      ["g1", []],
      ["-", ["a"]],
    ]);
  });
});

describe("moveConnection", () => {
  const groups = [g("g1"), g("g2")];

  it("跨群組移動並落在指定位置", () => {
    const conns = [c("a", "g1"), c("b", "g1"), c("x", "g2")];
    const next = moveConnection(conns, groups, "a", "g2", 1);
    expect(layout(next, groups)).toEqual([
      ["g1", ["b"]],
      ["g2", ["x", "a"]],
      ["-", []],
    ]);
  });

  it("同群組內往後移：index 以「移除自己之後」計算", () => {
    const conns = [c("a", "g1"), c("b", "g1"), c("d", "g1")];
    // 移除 a 後為 [b, d]；插在 index 2 → 最後。
    expect(ids(moveConnection(conns, groups, "a", "g1", 2))).toEqual(["b", "d", "a"]);
  });

  it("移到未分組區", () => {
    const conns = [c("a", "g1")];
    const next = moveConnection(conns, groups, "a", null, 0);
    expect(next[0].group_id).toBeNull();
  });

  it("index 越界夾到合法範圍，不丟資料", () => {
    const conns = [c("a", "g1"), c("b", "g1")];
    expect(ids(moveConnection(conns, groups, "b", "g1", 99))).toEqual(["a", "b"]);
    expect(ids(moveConnection(conns, groups, "b", "g1", -5))).toEqual(["b", "a"]);
  });

  it("不存在的連線 / 群組 → 原樣回傳", () => {
    const conns = [c("a", "g1")];
    expect(moveConnection(conns, groups, "nope", "g1", 0)).toBe(conns);
    expect(moveConnection(conns, groups, "a", "ghost", 0)).toBe(conns);
  });
});

describe("moveGroup", () => {
  const groups = [g("g1"), g("g2"), g("g3")];
  const names = (gs: ConnGroup[]) => gs.map((x) => x.id);

  it("移到目標之前 / 之後", () => {
    expect(names(moveGroup(groups, "g3", "g1", true))).toEqual(["g3", "g1", "g2"]);
    expect(names(moveGroup(groups, "g1", "g2", false))).toEqual(["g2", "g1", "g3"]);
  });

  it("targetId 為 null → 移到最後；拖到自己身上 → 不動", () => {
    expect(names(moveGroup(groups, "g1", null, true))).toEqual(["g2", "g3", "g1"]);
    expect(moveGroup(groups, "g1", "g1", true)).toBe(groups);
  });
});

describe("deleteGroup", () => {
  it("群組消失，成員落到未分組且連線不減少", () => {
    const conns = [c("a", "g1"), c("b"), c("x", "g2")];
    const groups = [g("g1"), g("g2")];
    const next = deleteGroup(conns, groups, "g1");

    expect(next.groups.map((x) => x.id)).toEqual(["g2"]);
    expect(next.conns).toHaveLength(3);
    expect(next.conns.find((x) => x.id === "a")!.group_id).toBeNull();
    expect(layout(next.conns, next.groups)).toEqual([
      ["g2", ["x"]],
      ["-", ["a", "b"]],
    ]);
  });
});

describe("uniqueGroupName", () => {
  it("撞名自動補序號，大小寫與前後空白不算不同名", () => {
    const groups = [g("g1", "PROD"), g("g2", "UAT")];
    expect(uniqueGroupName(groups, "DEV")).toBe("DEV");
    expect(uniqueGroupName(groups, "prod")).toBe("prod (2)");
    expect(uniqueGroupName(groups, "  PROD  ")).toBe("PROD (2)");
  });

  it("重新命名自己時不跟自己撞名", () => {
    const groups = [g("g1", "PROD")];
    expect(uniqueGroupName(groups, "PROD", "g1")).toBe("PROD");
  });
});

describe("flatten / toPlacements / groupSize", () => {
  it("壓平後每筆帶上所屬群組，供後端寫回", () => {
    const sections = sectionize([c("a", "g1"), c("b")], [g("g1")]);
    expect(toPlacements(flatten(sections))).toEqual([
      { id: "a", group_id: "g1" },
      { id: "b", group_id: null },
    ]);
  });

  it("groupSize 只算該群組的成員", () => {
    const conns = [c("a", "g1"), c("b", "g1"), c("x", "g2"), c("y")];
    expect(groupSize(conns, "g1")).toBe(2);
    expect(groupSize(conns, "none")).toBe(0);
  });
});
