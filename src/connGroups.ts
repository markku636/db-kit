// 側欄連線群組：資料庫連線專用的包裝與遷移。演算法本體在 sidebarGroups.ts（三個側欄區塊共用）。
//
// 單一真實來源是「connections 陣列順序 + 每筆的 group_id」與「groups 陣列順序」。
// 側欄依連線種類分區（PostgreSQL、MySQL…各一區），群組屬於某一個種類（ConnGroup.kind）。
// 所有 move/create/delete 都回傳新陣列，由呼叫端送 api.saveConnectionLayout 落地。

import type { ConnectionConfig, ConnGroup, ConnPlacement, DbKind } from "./api";
import {
  applyPlacementsTo, deleteGroupFrom, moveGroup as moveGroupGeneric, moveItem, sectionize as sectionizeGeneric,
  uniqueGroupName as uniqueGroupNameGeneric, type Placement,
} from "./sidebarGroups";

/** 側欄的一個區段：具名群組，或 group === null 的「未分組」區（永遠排在最後）。 */
export interface ConnSection {
  group: ConnGroup | null;
  conns: ConnectionConfig[];
}

/** 摺疊狀態的 localStorage 鍵（值為「已摺疊」的群組 id 陣列）。 */
export const COLLAPSED_KEY = "db-kit:collapsedConnGroups";

const groupOf = (c: ConnectionConfig) => c.group_id ?? null;

/**
 * 依群組順序把連線分區；未分組（含 group_id 指向已不存在群組的孤兒）收在最後一區。
 * 群組即使沒有成員也會回傳空區段——空群組要看得到才有拖放目標。
 */
export function sectionize(conns: ConnectionConfig[], groups: ConnGroup[]): ConnSection[] {
  return sectionizeGeneric(conns, groups, groupOf).map((s) => ({ group: s.group, conns: s.items }));
}

/** 分區結果壓回顯示順序的連線陣列（＝要寫回磁碟的順序）。 */
export function flatten(sections: ConnSection[]): ConnectionConfig[] {
  return sections.flatMap((s) => s.conns.map((c) => ({ ...c, group_id: s.group?.id ?? null })));
}

/** 連線陣列 → 後端 save_connection_layout 的 order 參數。 */
export function toPlacements(conns: ConnectionConfig[]): ConnPlacement[] {
  return conns.map((c) => ({ id: c.id, group_id: c.group_id ?? null }));
}

/** 連線 → 共用演算法用的 placement。 */
export function connPlacements(conns: ConnectionConfig[]): Placement[] {
  return conns.map((c) => ({ id: c.id, groupId: c.group_id ?? null }));
}

/** 把 placement 的順序與群組套回連線陣列（placement 裡沒有的連線維持原樣、排在後面）。 */
export function applyPlacements(conns: ConnectionConfig[], placements: Placement[]): ConnectionConfig[] {
  return applyPlacementsTo(conns, placements, (c, groupId) => ({ ...c, group_id: groupId }));
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
  const before = connPlacements(conns);
  const next = moveItem(before, groups, dragId, toGroupId, index);
  return next === before ? conns : applyPlacements(conns, next);
}

/** 群組排序：把 dragId 移到 targetId 之前 / 之後。targetId 為 null → 移到最後。 */
export function moveGroup(groups: ConnGroup[], dragId: string, targetId: string | null, before: boolean): ConnGroup[] {
  return moveGroupGeneric(groups, dragId, targetId, before);
}

/**
 * 產生不重複的群組名稱。同名群組不會壞掉（歸屬看 id），但清單上兩個「PROD」沒人分得出來，
 * 所以自動補 (2)、(3)。
 */
export function uniqueGroupName(groups: ConnGroup[], base: string, exceptId?: string): string {
  return uniqueGroupNameGeneric(groups, base, exceptId);
}

/** 刪除群組：群組本身移除，底下的連線移到未分組（連線不會被刪）。 */
export function deleteGroup(
  conns: ConnectionConfig[],
  groups: ConnGroup[],
  id: string
): { conns: ConnectionConfig[]; groups: ConnGroup[] } {
  const next = deleteGroupFrom(connPlacements(conns), groups, id);
  return { conns: applyPlacements(conns, next.items), groups: next.groups };
}

/** 某群組底下的連線數（刪除前的確認訊息要用）。 */
export function groupSize(conns: ConnectionConfig[], id: string): number {
  return conns.filter((c) => (c.group_id ?? null) === id).length;
}

/**
 * 舊版群組沒有 kind（一個群組可以混放 MySQL 與 PostgreSQL）。側欄改成「種類 > 群組」後，
 * 群組必須屬於一個種類，所以依成員種類拆開：
 * - 成員只有一種 → 補上那個 kind；
 * - 成員有多種 → 第一個成員的種類沿用原 id，其他種類各生一個同名的新群組（id 由 newId 給），成員搬過去；
 *   `copied` 記下 [新 id, 原 id]，讓呼叫端複製摺疊狀態；
 * - 空的舊群組 → 歸到連線最多的種類（一條連線都沒有就先不動，等有連線再遷移）。
 * 沒有需要遷移的群組時回傳 null（呼叫端據此決定要不要落地）。
 */
export function splitGroupsByKind(
  conns: ConnectionConfig[],
  groups: ConnGroup[],
  newId: () => string
): { conns: ConnectionConfig[]; groups: ConnGroup[]; copied: [string, string][] } | null {
  if (groups.every((g) => g.kind)) return null;
  const counts = new Map<DbKind, number>();
  for (const c of conns) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  let busiest: DbKind | undefined;
  for (const [k, n] of counts) if (!busiest || n > counts.get(busiest)!) busiest = k;

  let nextConns = conns;
  const nextGroups: ConnGroup[] = [];
  const copied: [string, string][] = [];
  let changed = false;
  for (const g of groups) {
    if (g.kind) { nextGroups.push(g); continue; }
    const kinds = [...new Set(conns.filter((c) => c.group_id === g.id).map((c) => c.kind))];
    if (kinds.length === 0) {
      if (busiest) { nextGroups.push({ ...g, kind: busiest }); changed = true; }
      else nextGroups.push(g);
      continue;
    }
    changed = true;
    nextGroups.push({ ...g, kind: kinds[0] });
    for (const k of kinds.slice(1)) {
      const id = newId();
      nextGroups.push({ id, name: g.name, kind: k });
      copied.push([id, g.id]);
      nextConns = nextConns.map((c) => (c.group_id === g.id && c.kind === k ? { ...c, group_id: id } : c));
    }
  }
  return changed ? { conns: nextConns, groups: nextGroups, copied } : null;
}

/** 某種類的群組（陣列順序＝顯示順序）。 */
export function groupsOfKind(groups: ConnGroup[], kind: DbKind): ConnGroup[] {
  return groups.filter((g) => g.kind === kind);
}

/**
 * 某種類區塊的排版變更合併回全域陣列：其他種類的連線與群組原封不動，
 * 這個種類的連線依 placements 重排後放回它們原本佔的那些位置，群組換成 kindGroups。
 */
export function mergeKindLayout(
  conns: ConnectionConfig[],
  groups: ConnGroup[],
  kind: DbKind,
  placements: Placement[],
  kindGroups: ConnGroup[]
): { conns: ConnectionConfig[]; groups: ConnGroup[] } {
  const ofKind = applyPlacements(conns.filter((c) => c.kind === kind), placements);
  let i = 0;
  const nextConns = conns.map((c) => (c.kind === kind ? ofKind[i++] : c));
  const nextGroups = [...groups.filter((g) => g.kind !== kind), ...kindGroups.map((g) => ({ ...g, kind }))];
  return { conns: nextConns, groups: nextGroups };
}
