// 資料夾比對的純邏輯（可在 node 下單元測試）：後端給的扁平列 → 樹、資料夾的彙總狀態、篩選、
// 選取項目 → 同步操作、同步規則（鏡像 / 更新）→ 操作清單。
import type { FolderRow, RowMeta, RowStatus, SyncOp, SyncOpKind } from "./compareTypes";

/** 資料夾的彙總狀態只有三種意義：整個只在一邊、底下全相同、底下有不同。 */
export type NodeStatus = RowStatus;

export interface TreeNode {
  key: string;
  name: string;
  depth: number;
  isDir: boolean;
  row: FolderRow;
  /** 檔案 = 自己的狀態；資料夾 = 依子項目彙總（見 aggregate）。 */
  status: NodeStatus;
  parent: TreeNode | null;
  children: TreeNode[];
}

export type FolderFilter = "all" | "diff" | "left_only" | "right_only" | "same";

/** 後端撞鍵時的後綴（見 diff.rs 的 collision_key）：父節點要從後綴之前算。 */
const COLLISION = "\u0001";

export function parentKey(key: string): string {
  const base = key.includes(COLLISION) ? key.slice(0, key.indexOf(COLLISION)) : key;
  const i = base.lastIndexOf("/");
  return i < 0 ? "" : base.slice(0, i);
}

function nodeName(r: FolderRow): string {
  return r.left?.name ?? r.right?.name ?? r.key;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 資料夾在前、名稱自然排序（file2 < file10）。 */
function sortNodes(ns: TreeNode[]) {
  ns.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : collator.compare(a.name, b.name)));
  for (const n of ns) sortNodes(n.children);
}

/** 資料夾狀態：只在一邊 / 型別不同照原樣；兩邊都有 → 子項目全相同才是 same，有未比過內容的算 unchecked。 */
function aggregate(n: TreeNode): NodeStatus {
  for (const c of n.children) c.status = c.isDir ? aggregate(c) : c.row.status;
  if (!n.isDir || n.row.status !== "same") return n.row.status;
  let unchecked = false;
  for (const c of n.children) {
    if (c.status === "unchecked") unchecked = true;
    else if (c.status !== "same") return "diff";
  }
  return unchecked ? "unchecked" : "same";
}

export function buildTree(rows: readonly FolderRow[]): TreeNode[] {
  const byKey = new Map<string, TreeNode>();
  for (const r of rows) {
    const isDir = !!(r.left?.is_dir ?? r.right?.is_dir);
    byKey.set(r.key, { key: r.key, name: nodeName(r), depth: 0, isDir: r.status === "type_mismatch" ? true : isDir, row: r, status: r.status, parent: null, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const n of byKey.values()) {
    const p = byKey.get(parentKey(n.key));
    if (p && p !== n) { n.parent = p; p.children.push(n); } else roots.push(n);
  }
  const setDepth = (ns: TreeNode[], d: number) => { for (const n of ns) { n.depth = d; setDepth(n.children, d + 1); } };
  setDepth(roots, 0);
  sortNodes(roots);
  for (const r of roots) r.status = aggregate(r);
  return roots;
}

/** 重新彙總（內容比對更新了檔案狀態之後）。 */
export function reaggregate(roots: TreeNode[]) {
  for (const r of roots) r.status = r.isDir ? aggregate(r) : r.row.status;
}

function leafMatches(n: TreeNode, f: FolderFilter): boolean {
  switch (f) {
    case "all": return true;
    case "same": return n.status === "same";
    case "left_only": return n.row.status === "left_only";
    case "right_only": return n.row.status === "right_only";
    case "diff": return n.status !== "same";
  }
}

/** 節點在篩選下是否該出現：自己符合，或底下有符合的。 */
export function visible(n: TreeNode, f: FolderFilter): boolean {
  if (f === "all") return true;
  if (!n.isDir || n.row.status === "left_only" || n.row.status === "right_only") return leafMatches(n, f);
  if (f === "same" && n.status === "same") return true;
  return n.children.some((c) => visible(c, f));
}

/** 攤平成畫面上的列（依展開狀態與篩選）。 */
export function flatten(roots: readonly TreeNode[], expanded: ReadonlySet<string>, f: FolderFilter): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ns: readonly TreeNode[]) => {
    for (const n of ns) {
      if (!visible(n, f)) continue;
      out.push(n);
      if (n.isDir && expanded.has(n.key)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/** 所有資料夾的鍵（全部展開）。只展開有差異的：`onlyDiff`。 */
export function dirKeys(roots: readonly TreeNode[], onlyDiff = false): string[] {
  const out: string[] = [];
  const walk = (ns: readonly TreeNode[]) => {
    for (const n of ns) {
      if (!n.isDir) continue;
      if (!onlyDiff || n.status !== "same") out.push(n.key);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

export interface Counts { same: number; diff: number; left_only: number; right_only: number; unchecked: number }

/** 檔案層級的統計（資料夾不算；只在一邊的資料夾把底下的檔案算進去）。 */
export function countFiles(roots: readonly TreeNode[]): Counts {
  const c: Counts = { same: 0, diff: 0, left_only: 0, right_only: 0, unchecked: 0 };
  const walk = (ns: readonly TreeNode[]) => {
    for (const n of ns) {
      if (n.isDir && n.row.status !== "type_mismatch") { walk(n.children); continue; }
      const s = n.row.status;
      if (s === "type_mismatch") c.diff++;
      else c[s]++;
    }
  };
  walk(roots);
  return c;
}

// ---- 操作 ----

function metaOf(n: TreeNode, left: boolean): RowMeta | null {
  return left ? n.row.left : n.row.right;
}
/** 往某方向複製時的來源 / 目的那一邊。 */
const srcMeta = (n: TreeNode, toRight: boolean) => metaOf(n, toRight);
const dstMeta = (n: TreeNode, toRight: boolean) => metaOf(n, !toRight);

/** 某節點在另一邊該叫什麼：最近一個另一邊也有的祖先的路徑 + 其後的名稱。 */
export function destRel(n: TreeNode, toRight: boolean): string {
  const own = dstMeta(n, toRight);
  if (own) return own.rel;
  const segs: string[] = [];
  let cur: TreeNode | null = n;
  while (cur && !dstMeta(cur, toRight)) {
    segs.unshift((srcMeta(cur, toRight) ?? { name: cur.name }).name);
    cur = cur.parent;
  }
  const base = cur ? dstMeta(cur, toRight)!.rel : "";
  return base ? `${base}/${segs.join("/")}` : segs.join("/");
}

function copyOp(n: TreeNode, toRight: boolean): SyncOp {
  const src = srcMeta(n, toRight)!;
  return { kind: toRight ? "copy_lr" : "copy_rl", src: src.rel, dst: destRel(n, toRight), is_dir: src.is_dir };
}

/**
 * 把一個節點往某個方向複製需要的操作：只在來源那邊 / 型別不同 → 整個複製；
 * 兩邊都是資料夾 → 往下找真正不同的；兩邊相同的檔 → 不動。
 */
function collectCopy(n: TreeNode, toRight: boolean, out: SyncOp[]) {
  const src = srcMeta(n, toRight);
  if (!src) return;
  const dst = dstMeta(n, toRight);
  if (!dst || n.row.status === "type_mismatch") { out.push(copyOp(n, toRight)); return; }
  if (n.isDir) { for (const c of n.children) collectCopy(c, toRight, out); return; }
  if (n.row.status !== "same") out.push(copyOp(n, toRight));
}

/** 選取的節點去掉「祖先也被選了」的那些（整個資料夾已經涵蓋）。 */
export function topmost(nodes: readonly TreeNode[]): TreeNode[] {
  const set = new Set(nodes.map((n) => n.key));
  return nodes.filter((n) => {
    for (let p = n.parent; p; p = p.parent) if (set.has(p.key)) return false;
    return true;
  });
}

/** 工具列的「複製 → / ← 複製 / 刪除左 / 刪除右」對選取項目的操作。 */
export function opsForSelection(kind: SyncOpKind, selected: readonly TreeNode[]): SyncOp[] {
  const out: SyncOp[] = [];
  for (const n of topmost(selected)) {
    if (kind === "copy_lr" || kind === "copy_rl") collectCopy(n, kind === "copy_lr", out);
    else {
      const m = metaOf(n, kind === "delete_left");
      if (m) out.push({ kind, src: m.rel, is_dir: m.is_dir });
    }
  }
  return out;
}

export type SyncRule = "mirror_lr" | "mirror_rl" | "update_lr" | "update_rl" | "update_both";

export interface SyncPlan {
  ops: SyncOp[];
  /** 規則下無法決定方向的項目（更新兩邊時兩邊都改過 / 時間相同但內容不同 / 型別不同）。 */
  conflicts: TreeNode[];
}

/**
 * 同步規則 → 操作清單。
 * - 鏡像（mirror）：讓目的地變得跟來源一模一樣——來源沒有的刪掉、不同的覆蓋。
 * - 更新（update）：只把來源有、目的地沒有或比較舊的複製過去，不刪任何東西。
 * - 兩邊更新（update_both）：各自補上對方沒有的，不同的以較新的一邊為準；分不出新舊的列為衝突。
 */
export function planSync(roots: readonly TreeNode[], rule: SyncRule): SyncPlan {
  const ops: SyncOp[] = [];
  const conflicts: TreeNode[] = [];
  const visit = (n: TreeNode) => {
    const s = n.row.status;
    const mirrorTo = rule === "mirror_lr" ? true : rule === "mirror_rl" ? false : null;
    if (mirrorTo !== null) {
      const srcHas = !!srcMeta(n, mirrorTo);
      if (!srcHas) {
        const m = dstMeta(n, mirrorTo)!;
        ops.push({ kind: mirrorTo ? "delete_right" : "delete_left", src: m.rel, is_dir: m.is_dir });
        return;
      }
      if (s === "left_only" || s === "right_only" || s === "type_mismatch") { ops.push(copyOp(n, mirrorTo)); return; }
      if (n.isDir) { n.children.forEach(visit); return; }
      if (s !== "same") ops.push(copyOp(n, mirrorTo));
      return;
    }
    if (s === "type_mismatch") { conflicts.push(n); return; }
    const toRightAllowed = rule === "update_lr" || rule === "update_both";
    const toLeftAllowed = rule === "update_rl" || rule === "update_both";
    if (s === "left_only") { if (toRightAllowed) ops.push(copyOp(n, true)); return; }
    if (s === "right_only") { if (toLeftAllowed) ops.push(copyOp(n, false)); return; }
    if (n.isDir) { n.children.forEach(visit); return; }
    if (s === "same") return;
    const newer = n.row.newer;
    if (newer === "left" && toRightAllowed) ops.push(copyOp(n, true));
    else if (newer === "right" && toLeftAllowed) ops.push(copyOp(n, false));
    // 分不出新舊（時間相同但大小不同、伺服器沒給時間、還沒比過內容）：不猜，列為衝突讓使用者自己決定。
    else if (newer === null) conflicts.push(n);
  };
  roots.forEach(visit);
  return { ops, conflicts };
}

/** 需要比對內容的檔：選取的（或全部）兩邊都有、大小相同、還不確定的。 */
export function contentCandidates(nodes: readonly TreeNode[], includeMetaDiff: boolean): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (ns: readonly TreeNode[]) => {
    for (const n of ns) {
      if (n.isDir) { walk(n.children); continue; }
      const { left, right, status } = n.row;
      if (!left || !right || left.is_dir || right.is_dir || left.size !== right.size) continue;
      if (status === "unchecked" || (includeMetaDiff && status === "diff")) out.push(n);
    }
  };
  walk(nodes);
  return out;
}
