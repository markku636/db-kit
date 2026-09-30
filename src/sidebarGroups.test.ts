import { describe, expect, it } from "vitest";
import {
  applyPlacementsTo, deleteGroupFrom, moveGroup, moveItem, moveItemNextTo, sectionize, uniqueGroupName,
  type GroupLike, type Placement,
} from "./sidebarGroups";

const p = (id: string, groupId: string | null = null): Placement => ({ id, groupId });
const g = (id: string, name = id.toUpperCase()): GroupLike => ({ id, name });
const layout = (items: Placement[], groups: GroupLike[]) =>
  sectionize(items, groups, (x) => x.groupId).map((s) => [s.group?.id ?? "-", s.items.map((x) => x.id)] as const);

describe("sectionize（泛型）", () => {
  it("依群組順序分區、組內維持輸入順序、未分組最後、空群組保留、孤兒算未分組", () => {
    const items = [p("a", "g2"), p("b"), p("c", "g1"), p("d", "gone"), p("e", "g2")];
    expect(layout(items, [g("g1"), g("g2"), g("g3")])).toEqual([
      ["g1", ["c"]],
      ["g2", ["a", "e"]],
      ["g3", []],
      ["-", ["b", "d"]],
    ]);
  });
});

describe("moveItem / moveItemNextTo", () => {
  const groups = [g("g1"), g("g2")];
  const items = [p("a", "g1"), p("b", "g1"), p("c", "g2"), p("d")];

  it("移到另一群組末端（index 越界夾到最後）", () => {
    expect(layout(moveItem(items, groups, "a", "g2", Number.MAX_SAFE_INTEGER), groups)).toEqual([
      ["g1", ["b"]], ["g2", ["c", "a"]], ["-", ["d"]],
    ]);
  });

  it("移出群組", () => {
    expect(layout(moveItem(items, groups, "c", null, 0), groups)).toEqual([
      ["g1", ["a", "b"]], ["g2", []], ["-", ["c", "d"]],
    ]);
  });

  it("找不到拖曳項或目標群組 → 原樣回傳同一個陣列", () => {
    expect(moveItem(items, groups, "zz", "g1", 0)).toBe(items);
    expect(moveItem(items, groups, "a", "nope", 0)).toBe(items);
  });

  it("插在某列前 / 後，落在該列的群組", () => {
    expect(layout(moveItemNextTo(items, groups, "d", "b", true), groups)).toEqual([
      ["g1", ["a", "d", "b"]], ["g2", ["c"]], ["-", []],
    ]);
    expect(layout(moveItemNextTo(items, groups, "a", "b", false), groups)).toEqual([
      ["g1", ["b", "a"]], ["g2", ["c"]], ["-", ["d"]],
    ]);
  });

  it("拖到自己身上不動", () => {
    expect(moveItemNextTo(items, groups, "a", "a", true)).toBe(items);
  });
});

describe("moveGroup / deleteGroupFrom / uniqueGroupName", () => {
  it("群組換位", () => {
    const gs = [g("a"), g("b"), g("c")];
    expect(moveGroup(gs, "c", "a", true).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(moveGroup(gs, "a", "c", false).map((x) => x.id)).toEqual(["b", "c", "a"]);
    expect(moveGroup(gs, "a", null, false).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("刪群組：成員移到未分組、順序不變", () => {
    const items = [p("a", "g1"), p("b"), p("c", "g1")];
    const next = deleteGroupFrom(items, [g("g1")], "g1");
    expect(next.groups).toEqual([]);
    expect(next.items).toEqual([p("a"), p("b"), p("c")]);
  });

  it("名稱撞名（不分大小寫）補 (2)、(3)，改名時排除自己", () => {
    const gs = [g("1", "PROD"), g("2", "prod (2)")];
    expect(uniqueGroupName(gs, "prod")).toBe("prod (3)");
    expect(uniqueGroupName(gs, " Dev ")).toBe("Dev");
    expect(uniqueGroupName(gs, "PROD", "1")).toBe("PROD");
  });
});

describe("applyPlacementsTo", () => {
  it("依 placements 排序並換群組；沒列到的接在後面，不會弄丟", () => {
    const items = [{ id: "a", g: null as string | null }, { id: "b", g: null }, { id: "c", g: "x" }];
    const out = applyPlacementsTo(items, [p("c", null), p("a", "x")], (it, gid) => ({ ...it, g: gid }));
    expect(out).toEqual([{ id: "c", g: null }, { id: "a", g: "x" }, { id: "b", g: null }]);
  });
});
