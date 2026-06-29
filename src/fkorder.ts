// 依外鍵相依關係排序資料表（被參照者在前）。供整庫傳輸「自動建表」時，先建被參照的表，
// 避免 `CREATE TABLE` 因外鍵指向尚未建立的表而失敗。純函式、可單元測試。

export interface FkEdge {
  from_table: string; // 含外鍵的表（參照者）
  to_table: string;   // 被參照的表
}

// 拓樸排序：被參照的表排在參照它的表之前。含環時就地打破（剩餘維持原順序），確保輸出涵蓋全部輸入。
export function topoSortByFk(tables: string[], relations: FkEdge[]): string[] {
  const set = new Set(tables);
  // deps：table → 它所參照（須先建立）的表集合。
  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const r of relations) {
    if (r.from_table !== r.to_table && set.has(r.from_table) && set.has(r.to_table)) {
      deps.get(r.from_table)!.add(r.to_table);
    }
  }
  const out: string[] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0=未訪 1=訪問中 2=完成
  const visit = (t: string) => {
    const s = state.get(t) ?? 0;
    if (s !== 0) return; // 已完成或環中（訪問中再遇到即打破環）
    state.set(t, 1);
    for (const d of deps.get(t)!) visit(d);
    state.set(t, 2);
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}
