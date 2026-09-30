import { describe, expect, it } from "vitest";
import type { FolderRow, RowMeta } from "./compareTypes";
import {
  buildTree, contentCandidates, countFiles, destRel, dirKeys, flatten, opsForSelection, parentKey, planSync, reaggregate,
  type TreeNode,
} from "./folderCompareModel";

const m = (rel: string, is_dir = false, size = 1, mtime: number | null = 100): RowMeta => ({
  rel, name: rel.split("/").pop()!, is_dir, size, mtime,
});
const row = (key: string, left: RowMeta | null, right: RowMeta | null, status: FolderRow["status"], newer: FolderRow["newer"] = null): FolderRow => ({
  key, left, right, status, newer,
});

// 左：src/{a.txt(同), b.txt(左新), only_l/x.txt}, docs/(同)/r.md(只在右), kind(左檔右夾)
const rows: FolderRow[] = [
  row("docs", m("docs", true), m("docs", true), "same"),
  row("docs/r.md", null, m("docs/r.md"), "right_only"),
  row("kind", m("kind"), m("kind", true), "type_mismatch"),
  row("src", m("src", true), m("src", true), "same"),
  row("src/a.txt", m("src/a.txt"), m("src/a.txt"), "same"),
  row("src/b.txt", m("src/b.txt", false, 2, 200), m("src/b.txt", false, 1, 100), "diff", "left"),
  row("src/only_l", m("src/only_l", true), null, "left_only"),
  row("src/only_l/x.txt", m("src/only_l/x.txt"), null, "left_only"),
  row("src/u.bin", m("src/u.bin", false, 5), m("src/u.bin", false, 5), "unchecked"),
];

function find(roots: TreeNode[], key: string): TreeNode {
  const walk = (ns: TreeNode[]): TreeNode | null => {
    for (const n of ns) { if (n.key === key) return n; const r = walk(n.children); if (r) return r; }
    return null;
  };
  const n = walk(roots);
  if (!n) throw new Error(key);
  return n;
}

describe("folderCompareModel", () => {
  it("builds a sorted tree with aggregated dir status", () => {
    const roots = buildTree(rows);
    expect(roots.map((n) => n.key)).toEqual(["docs", "kind", "src"]);
    expect(find(roots, "docs").status).toBe("diff");
    expect(find(roots, "src").status).toBe("diff");
    expect(find(roots, "src").children.map((n) => n.name)).toEqual(["only_l", "a.txt", "b.txt", "u.bin"]);
    expect(find(roots, "src/only_l/x.txt").depth).toBe(2);
  });

  it("parentKey ignores the collision suffix", () => {
    expect(parentKey("a/b")).toBe("a");
    expect(parentKey("a")).toBe("");
    expect(parentKey("d/x\u0001d/X")).toBe("d");
  });

  it("filters and flattens by expansion", () => {
    const roots = buildTree(rows);
    const all = new Set(dirKeys(roots));
    expect(flatten(roots, new Set(), "all").map((n) => n.key)).toEqual(["docs", "kind", "src"]);
    expect(flatten(roots, all, "right_only").map((n) => n.key)).toEqual(["docs", "docs/r.md"]);
    expect(flatten(roots, all, "same").map((n) => n.key)).toEqual(["src", "src/a.txt"]);
    expect(flatten(roots, all, "diff").map((n) => n.key)).not.toContain("src/a.txt");
    expect(dirKeys(roots, true)).toEqual(["docs", "kind", "src", "src/only_l"]);
  });

  it("counts files", () => {
    expect(countFiles(buildTree(rows))).toEqual({ same: 1, diff: 2, left_only: 1, right_only: 1, unchecked: 1 });
  });

  it("selection → ops copies only what differs", () => {
    const roots = buildTree(rows);
    const ops = opsForSelection("copy_lr", [find(roots, "src"), find(roots, "src/b.txt")]);
    expect(ops).toEqual([
      { kind: "copy_lr", src: "src/only_l", dst: "src/only_l", is_dir: true },
      { kind: "copy_lr", src: "src/b.txt", dst: "src/b.txt", is_dir: false },
      { kind: "copy_lr", src: "src/u.bin", dst: "src/u.bin", is_dir: false },
    ]);
    expect(opsForSelection("delete_right", [find(roots, "docs/r.md"), find(roots, "src/only_l")])).toEqual([
      { kind: "delete_right", src: "docs/r.md", is_dir: false },
    ]);
  });

  it("destRel follows the other side's parent names (case-insensitive alignment)", () => {
    const ci: FolderRow[] = [
      row("src", m("Src", true), m("src", true), "same"),
      row("src/new", m("Src/New", true), null, "left_only"),
      row("src/new/f.txt", m("Src/New/f.txt"), null, "left_only"),
    ];
    const roots = buildTree(ci);
    expect(destRel(find(roots, "src/new/f.txt"), true)).toBe("src/New/f.txt");
    expect(destRel(find(roots, "src"), true)).toBe("src");
  });

  it("plans mirror and update syncs", () => {
    const roots = buildTree(rows);
    const mirror = planSync(roots, "mirror_lr");
    expect(mirror.ops).toEqual([
      { kind: "delete_right", src: "docs/r.md", is_dir: false },
      { kind: "copy_lr", src: "kind", dst: "kind", is_dir: false },
      { kind: "copy_lr", src: "src/only_l", dst: "src/only_l", is_dir: true },
      { kind: "copy_lr", src: "src/b.txt", dst: "src/b.txt", is_dir: false },
      { kind: "copy_lr", src: "src/u.bin", dst: "src/u.bin", is_dir: false },
    ]);
    expect(mirror.conflicts).toEqual([]);

    const both = planSync(roots, "update_both");
    expect(both.ops.map((o) => `${o.kind}:${o.src}`)).toEqual(["copy_rl:docs/r.md", "copy_lr:src/only_l", "copy_lr:src/b.txt"]);
    expect(both.conflicts.map((n) => n.key)).toEqual(["kind", "src/u.bin"]);

    const updRight = planSync(roots, "update_rl");
    expect(updRight.ops.map((o) => `${o.kind}:${o.src}`)).toEqual(["copy_rl:docs/r.md"]);
  });

  it("content candidates and re-aggregation", () => {
    const roots = buildTree(rows);
    expect(contentCandidates(roots, false).map((n) => n.key)).toEqual(["src/u.bin"]);
    const u = find(roots, "src/u.bin");
    u.row = { ...u.row, status: "same" };
    const b = find(roots, "src/b.txt");
    b.row = { ...b.row, status: "same" };
    const x = find(roots, "src/only_l");
    x.parent!.children = x.parent!.children.filter((c) => c !== x);
    reaggregate(roots);
    expect(find(roots, "src").status).toBe("same");
  });
});
