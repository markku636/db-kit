// 側欄分組的共用純函式：資料庫連線、SSH 主機、遠端桌面三個區塊都用這一套。
//
// 單一真實來源是「項目陣列順序 + 每筆的群組 id」與「群組陣列順序」，顯示結構由 sectionize()
// 推導出來，不另外存一份巢狀結構——兩份會走鐘。項目本身的型別各區塊不同（ConnectionConfig /
// SshSession / RdSession），這裡只看 Placement（id + 群組），由呼叫端把結果套回自己的資料。

/** 一個項目落在哪個群組（null = 未分組）。 */
export interface Placement {
  id: string;
  groupId: string | null;
}

export interface GroupLike {
  id: string;
  name: string;
}

/** 側欄的一個區段：具名群組，或 group === null 的「未分組」區（永遠排在最後）。 */
export interface Section<T, G extends GroupLike = GroupLike> {
  group: G | null;
  items: T[];
}

/**
 * 依群組順序把項目分區；未分組（含群組 id 指向已不存在群組的孤兒）收在最後一區。
 * 群組即使沒有成員也會回傳空區段——空群組要看得到才有拖放目標。組內維持輸入陣列的順序。
 */
export function sectionize<T, G extends GroupLike>(items: T[], groups: G[], groupOf: (t: T) => string | null | undefined): Section<T, G>[] {
  const byGroup = new Map<string, T[]>(groups.map((g) => [g.id, []]));
  const ungrouped: T[] = [];
  for (const it of items) {
    const gid = groupOf(it) ?? null;
    const bucket = gid ? byGroup.get(gid) : undefined;
    if (bucket) bucket.push(it);
    else ungrouped.push(it);
  }
  return [...groups.map((g) => ({ group: g, items: byGroup.get(g.id)! })), { group: null, items: ungrouped }];
}

/** 分區結果壓回顯示順序的 placement 陣列（＝要寫回磁碟的順序；孤兒的群組 id 一併清成 null）。 */
export function flattenSections<G extends GroupLike>(sections: Section<Placement, G>[]): Placement[] {
  return sections.flatMap((s) => s.items.map((p) => ({ id: p.id, groupId: s.group?.id ?? null })));
}

/**
 * 把項目移到某群組的指定位置。
 *
 * `index` 是「移除拖曳項之後」目標區段內的插入位置；越界會夾到合法範圍，
 * 因此呼叫端可以放心傳 Number.MAX_SAFE_INTEGER 表示「接在最後」。
 * 找不到拖曳項或目標群組 → 原樣回傳。
 */
export function moveItem(items: Placement[], groups: GroupLike[], dragId: string, toGroupId: string | null, index: number): Placement[] {
  const dragged = items.find((p) => p.id === dragId);
  if (!dragged) return items;
  const sections = sectionize(items, groups, (p) => p.groupId);
  for (const s of sections) s.items = s.items.filter((p) => p.id !== dragId);
  const dest = sections.find((s) => (s.group?.id ?? null) === toGroupId);
  if (!dest) return items;
  dest.items.splice(Math.max(0, Math.min(index, dest.items.length)), 0, dragged);
  return flattenSections(sections);
}

/** 插在某項目之前 / 之後，落在該項目所屬的群組（拖到另一列上放開）。 */
export function moveItemNextTo(items: Placement[], groups: GroupLike[], dragId: string, targetId: string, before: boolean): Placement[] {
  if (dragId === targetId) return items;
  const target = items.find((p) => p.id === targetId);
  if (!target) return items;
  const gid = target.groupId && groups.some((g) => g.id === target.groupId) ? target.groupId : null;
  const list = sectionize(items, groups, (p) => p.groupId)
    .find((s) => (s.group?.id ?? null) === gid)!
    .items.filter((p) => p.id !== dragId);
  const found = list.findIndex((p) => p.id === targetId);
  const index = found < 0 ? list.length : found + (before ? 0 : 1);
  return moveItem(items, groups, dragId, gid, index);
}

/**
 * 把 placement 的順序與群組套回項目陣列：依 placements 的順序排、群組換成 placement 的，
 * placements 裡沒有的項目維持原樣接在後面（不會因為排版而弄丟項目）。
 */
export function applyPlacementsTo<T extends { id: string }>(items: T[], placements: Placement[], withGroup: (t: T, groupId: string | null) => T): T[] {
  const byId = new Map(items.map((it) => [it.id, it]));
  const out: T[] = [];
  for (const p of placements) {
    const it = byId.get(p.id);
    if (!it) continue;
    out.push(withGroup(it, p.groupId));
    byId.delete(p.id);
  }
  return [...out, ...byId.values()];
}

/** 群組排序：把 dragId 移到 targetId 之前 / 之後。targetId 為 null → 移到最後。 */
export function moveGroup<G extends GroupLike>(groups: G[], dragId: string, targetId: string | null, before: boolean): G[] {
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

/** 刪除群組：群組本身移除，底下的項目移到未分組（項目不會被刪），順序維持原本的相對關係。 */
export function deleteGroupFrom<G extends GroupLike>(items: Placement[], groups: G[], id: string): { items: Placement[]; groups: G[] } {
  const nextGroups = groups.filter((g) => g.id !== id);
  return { items: flattenSections(sectionize(items, nextGroups, (p) => p.groupId)), groups: nextGroups };
}

/**
 * 產生不重複的群組名稱。同名群組不會壞掉（歸屬看 id），但清單上兩個「PROD」沒人分得出來，
 * 所以自動補 (2)、(3)。不分大小寫；exceptId = 改名時排除自己。
 */
export function uniqueGroupName(groups: GroupLike[], base: string, exceptId?: string): string {
  const taken = new Set(groups.filter((g) => g.id !== exceptId).map((g) => g.name.trim().toLowerCase()));
  const name = base.trim();
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) {
    const candidate = `${name} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** localStorage 裡的字串集合（摺疊狀態用）；損毀的存檔視為空集合。 */
export function loadSet(key: string): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || "[]") as unknown;
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    /* 忽略損毀的存檔 */
  }
  return new Set();
}

export function saveSet(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* 配額滿等寫入失敗不影響功能 */
  }
}
