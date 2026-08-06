// 側欄連線群組：分區、拖曳移動、群組增刪改的純函式。
//
// 單一真實來源是「connections 陣列順序 + 每筆的 group_id」與「groups 陣列順序」，
// 顯示結構由 sectionize() 推導出來，不另外存一份巢狀結構——兩份會走鐘。
// 所有 move/create/delete 都回傳新陣列，由呼叫端送 api.saveConnectionLayout 落地。

import type { ConnectionConfig, ConnGroup, ConnPlacement } from "./api";

/** 側欄的一個區段：具名群組，或 group === null 的「未分組」區（永遠排在最後）。 */
export interface ConnSection {
  group: ConnGroup | null;
  conns: ConnectionConfig[];
}

/** 摺疊狀態的 localStorage 鍵（值為「已摺疊」的群組 id 陣列；未分組區用 UNGROUPED_KEY）。 */
export const COLLAPSED_KEY = "db-kit:collapsedConnGroups";
/** 未分組區在摺疊狀態中的代號（真實群組 id 不會是空字串，不會撞號）。 */
export const UNGROUPED_KEY = "";

/**
 * 依群組順序把連線分區；未分組（含 group_id 指向已不存在群組的孤兒）收在最後一區。
 * 群組即使沒有成員也會回傳空區段——空群組要看得到才有拖放目標。
 */
export function sectionize(conns: ConnectionConfig[], groups: ConnGroup[]): ConnSection[] {
  const known = new Set(groups.map((g) => g.id));
  const byGroup = new Map<string, ConnectionConfig[]>(groups.map((g) => [g.id, []]));
  const ungrouped: ConnectionConfig[] = [];
  for (const c of conns) {
    const gid = c.group_id ?? null;
    if (gid && known.has(gid)) byGroup.get(gid)!.push(c);
    else ungrouped.push(c);
  }
  return [
    ...groups.map((g) => ({ group: g, conns: byGroup.get(g.id)! })),
    { group: null, conns: ungrouped },
  ];
}

/** 分區結果壓回顯示順序的連線陣列（＝要寫回磁碟的順序）。 */
export function flatten(sections: ConnSection[]): ConnectionConfig[] {
  return sections.flatMap((s) => s.conns.map((c) => ({ ...c, group_id: s.group?.id ?? null })));
}

/** 連線陣列 → 後端 save_connection_layout 的 order 參數。 */
export function toPlacements(conns: ConnectionConfig[]): ConnPlacement[] {
  return conns.map((c) => ({ id: c.id, group_id: c.group_id ?? null }));
}

/**
 * 把連線移到某群組的指定位置。
 *
 * `index` 是「移除拖曳項之後」目標區段內的插入位置；越界會夾到合法範圍，
 * 因此呼叫端可以放心傳 conns.length 表示「接在最後」。
 */
export function moveConnection(
  conns: ConnectionConfig[],
  groups: ConnGroup[],
  dragId: string,
  toGroupId: string | null,
  index: number
): ConnectionConfig[] {
  const sections = sectionize(conns, groups);
  const dragged = conns.find((c) => c.id === dragId);
  if (!dragged) return conns;

  for (const s of sections) s.conns = s.conns.filter((c) => c.id !== dragId);
  const dest = sections.find((s) => (s.group?.id ?? null) === toGroupId);
  if (!dest) return conns;
  dest.conns.splice(Math.max(0, Math.min(index, dest.conns.length)), 0, dragged);
  return flatten(sections);
}

/** 群組排序：把 dragId 移到 targetId 之前 / 之後。targetId 為 null → 移到最後。 */
export function moveGroup(
  groups: ConnGroup[],
  dragId: string,
  targetId: string | null,
  before: boolean
): ConnGroup[] {
  if (dragId === targetId) return groups;
  const dragged = groups.find((g) => g.id === dragId);
  if (!dragged) return groups;
  const rest = groups.filter((g) => g.id !== dragId);
  if (!targetId) return [...rest, dragged];
  const at = rest.findIndex((g) => g.id === targetId);
  if (at < 0) return groups;
  rest.splice(before ? at : at + 1, 0, dragged);
  return rest;
}

/**
 * 產生不重複的群組名稱。同名群組不會壞掉（歸屬看 id），但清單上兩個「PROD」沒人分得出來，
 * 所以自動補 (2)、(3)。
 */
export function uniqueGroupName(groups: ConnGroup[], base: string, exceptId?: string): string {
  const taken = new Set(
    groups.filter((g) => g.id !== exceptId).map((g) => g.name.trim().toLowerCase())
  );
  const name = base.trim();
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** 刪除群組：群組本身移除，底下的連線移到未分組（連線不會被刪）。 */
export function deleteGroup(
  conns: ConnectionConfig[],
  groups: ConnGroup[],
  id: string
): { conns: ConnectionConfig[]; groups: ConnGroup[] } {
  const nextGroups = groups.filter((g) => g.id !== id);
  // 先算好新分區再壓平：被刪群組的成員會落進未分組區，順序維持原本的相對關係。
  return { conns: flatten(sectionize(conns, nextGroups)), groups: nextGroups };
}

/** 某群組底下的連線數（刪除前的確認訊息要用）。 */
export function groupSize(conns: ConnectionConfig[], id: string): number {
  return conns.filter((c) => (c.group_id ?? null) === id).length;
}

/** 讀取已摺疊群組集合（損毀的存檔忽略）。 */
export function loadCollapsed(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || "[]");
    if (Array.isArray(arr)) return new Set(arr.filter((x) => typeof x === "string"));
  } catch {
    /* 忽略損毀的存檔 */
  }
  return new Set();
}

export function persistCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    /* 配額滿等寫入失敗不影響功能 */
  }
}
