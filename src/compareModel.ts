// 結構 / 資料比對對話框的純函式（列狀態、語句分組、腳本組裝、DDL 並排）。
// 抽離自 CompareDialog / TableCompareView 以便單元測試（見 compareModel.test.ts），不依賴 React / Tauri。
import type { DbKind, DbSchema, SchemaDiff, SyncStatement, TableDiff } from "./api";
import type { DiffLine } from "./diff";

/** 比對的目標側：即時連線或結構快照檔。 */
export type CompareTarget =
  | { mode: "live"; connId: string; db: string; table?: string }
  | { mode: "snapshot"; path: string; schema: DbSchema | null };

/** 整庫結果列的狀態。 */
export type RowStatus = "identical" | "differs" | "source_only" | "target_only" | "pending" | "running";
export type SchemaStatus = "identical" | "changed" | "source_only" | "target_only";

export interface CompareRow {
  name: string;
  objType: "table" | "view" | "routine";
  status: RowStatus;
  /** 結構比對結果（未比對時為 undefined）。 */
  schema?: SchemaStatus;
  /** 補充說明。 */
  detail?: string;
}

// MariaDB 為 MySQL fork，DDL 相容：視為同族可互比 / 互產 DDL。
const fam = (k: DbKind) => (k === "mariadb" ? "mysql" : k);
export const sameFamily = (a: DbKind, b: DbKind) => fam(a) === fam(b);

export function tableHasDiff(td: TableDiff): boolean {
  return td.columns_added.length > 0 || td.columns_removed.length > 0 || td.columns_changed.length > 0
    || td.indexes_added.length > 0 || td.indexes_removed.length > 0 || td.indexes_changed.length > 0
    || td.fks_added.length > 0 || td.fks_removed.length > 0 || td.fks_changed.length > 0
    || td.ddl_differs;
}

/**
 * 把結構差異攤成一列一物件。狀態優先序：僅一側有 > 進行中 > 有差異 > 相同 > 待比對。
 * `picked` 有給時只列這些表（視圖 / 程序不受篩選）。
 */
export function buildCompareRows(
  schema: SchemaDiff | null,
  picked: Set<string> | null,
  running: string | null,
): CompareRow[] {
  const rows = new Map<string, CompareRow>();
  const get = (name: string, objType: CompareRow["objType"]) => {
    const key = `${objType}:${name}`;
    let r = rows.get(key);
    if (!r) {
      r = { name, objType, status: "pending" };
      rows.set(key, r);
    }
    return r;
  };
  if (schema) {
    for (const n of schema.tables_added) get(n, "table").schema = "source_only";
    for (const n of schema.tables_removed) get(n, "table").schema = "target_only";
    for (const td of schema.tables_changed) get(td.name, "table").schema = tableHasDiff(td) ? "changed" : "identical";
    for (const n of schema.tables_identical) get(n, "table").schema = "identical";
    for (const n of schema.views_added) get(n, "view").schema = "source_only";
    for (const n of schema.views_removed) get(n, "view").schema = "target_only";
    for (const v of schema.views_changed) get(v.name, "view").schema = "changed";
    for (const r of schema.routines_added) get(r.name, "routine").schema = "source_only";
    for (const r of schema.routines_removed) get(r.name, "routine").schema = "target_only";
    for (const r of schema.routines_changed) get(r.name, "routine").schema = "changed";
  }
  const out: CompareRow[] = [];
  for (const r of rows.values()) {
    // picked 是「來源資料表」的子集，而僅目標有的表本來就不在裡面——不能因此被濾掉，
    // 否則它只會出現在同步腳本的 DROP，列表上卻完全看不到（使用者無從得知要刪什麼）。
    if (picked && r.objType === "table" && r.schema !== "target_only" && !picked.has(r.name)) continue;
    if (r.schema === "source_only" || r.schema === "target_only") r.status = r.schema;
    else if (running && r.objType === "table" && r.name === running) r.status = "running";
    else if (r.schema === "changed") r.status = "differs";
    else if (r.schema === "identical") r.status = "identical";
    else r.status = "pending";
    out.push(r);
  }
  const order: Record<CompareRow["objType"], number> = { table: 0, view: 1, routine: 2 };
  out.sort((a, b) => order[a.objType] - order[b.objType] || a.name.localeCompare(b.name));
  return out;
}

export function summarizeRows(rows: CompareRow[]): Record<RowStatus, number> {
  const c: Record<RowStatus, number> = { identical: 0, differs: 0, source_only: 0, target_only: 0, pending: 0, running: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

/** 安全 / 破壞性分組（順序不變）。 */
export function splitStatements(stmts: SyncStatement[]): { safe: SyncStatement[]; destructive: SyncStatement[] } {
  return { safe: stmts.filter((s) => !s.destructive), destructive: stmts.filter((s) => s.destructive) };
}

/** 組成可貼到編輯器的腳本：每句以 `;` 結尾（已有者不重複），破壞性語句前加註解。 */
export function buildSyncScript(stmts: SyncStatement[], header?: string): string {
  const parts: string[] = [];
  if (header) parts.push(header.split("\n").map((l) => `-- ${l}`).join("\n"), "");
  for (const s of stmts) {
    if (s.destructive) parts.push("-- [destructive]");
    if (s.note) parts.push(`-- ${s.note}`);
    parts.push(s.sql.replace(/;?\s*$/, ";"));
    parts.push("");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}

/** 供並排 DDL 文字 diff 前的正規化：統一換行、去尾空白、去 MySQL AUTO_INCREMENT=n。 */
export function normalizeDdl(ddl: string): string {
  return ddl
    .replace(/\r\n?/g, "\n")
    .replace(/\s+AUTO_INCREMENT=\d+/gi, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/** 把行 diff 配成左右兩欄：連續的 del / add 段落逐行對齊，多出的一側補空。 */
export function pairSideBySide(lines: DiffLine[]): { left: DiffLine | null; right: DiffLine | null }[] {
  const out: { left: DiffLine | null; right: DiffLine | null }[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === "same") {
      out.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type !== "same") {
      (lines[i].type === "del" ? dels : adds).push(lines[i]);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) out.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** 快照預設檔名：`{db}-schema-YYYYMMDD-HHmm.json`（檔名不可含 : / 等字元）。 */
export function snapshotFileName(db: string, at: Date): string {
  const safe = db.replace(/[^\w.-]+/g, "_");
  const stamp = `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}-${pad2(at.getHours())}${pad2(at.getMinutes())}`;
  return `${safe}-schema-${stamp}.json`;
}

/** 單表 drill-in 時，目標表名與來源不同 → 把目標快照裡那張表改名，讓 diff 以同名配對。 */
export function renameTableInSchema(schema: DbSchema, from: string, to: string): DbSchema {
  if (from === to) return schema;
  return {
    ...schema,
    tables: schema.tables.map((t) => (t.name === from ? { ...t, name: to } : t)),
    views: schema.views.map((t) => (t.name === from ? { ...t, name: to } : t)),
  };
}

/**
 * 給 AI 摘要用的差異摘要文字：只給「有差異的部分」，且逐項寫清楚，
 * 不附完整 DDL（token 省下來留給模型講重點，也避免把整個 schema 送出去）。
 */
export function describeDiffForAi(diff: SchemaDiff, srcLabel: string, dstLabel: string, statements: SyncStatement[], skipped: string[]): string {
  const L: string[] = [];
  L.push(`來源：${srcLabel}（${diff.src_kind}）`);
  L.push(`目標：${dstLabel}（${diff.dst_kind}）`);
  if (diff.cross_engine) L.push("注意：兩側資料庫種類不同，型別僅以家族比對，且不產生同步 DDL。");
  if (diff.tables_added.length) L.push(`僅來源有的資料表（目標需新增）：${diff.tables_added.join(", ")}`);
  if (diff.tables_removed.length) L.push(`僅目標有的資料表（目標多出）：${diff.tables_removed.join(", ")}`);
  for (const td of diff.tables_changed) {
    const parts: string[] = [];
    if (td.columns_added.length) parts.push(`新增欄位 ${td.columns_added.map((c) => `${c.name} ${c.data_type}`).join("、")}`);
    if (td.columns_removed.length) parts.push(`移除欄位 ${td.columns_removed.map((c) => c.name).join("、")}`);
    for (const c of td.columns_changed) parts.push(`欄位 ${c.name} 的 ${c.attrs.join("/")} 不同（來源 ${c.src.data_type}${c.src.nullable ? "" : " NOT NULL"} → 目標 ${c.dst.data_type}${c.dst.nullable ? "" : " NOT NULL"}）`);
    if (td.indexes_added.length) parts.push(`新增索引 ${td.indexes_added.map((i) => i.name).join("、")}`);
    if (td.indexes_removed.length) parts.push(`移除索引 ${td.indexes_removed.map((i) => i.name).join("、")}`);
    if (td.indexes_changed.length) parts.push(`索引變更 ${td.indexes_changed.map((i) => i.name).join("、")}`);
    if (td.fks_added.length) parts.push(`新增外鍵 ${td.fks_added.map((f) => f.name).join("、")}`);
    if (td.fks_removed.length) parts.push(`移除外鍵 ${td.fks_removed.map((f) => f.name).join("、")}`);
    if (td.fks_changed.length) parts.push(`外鍵變更 ${td.fks_changed.map((f) => f.name).join("、")}`);
    if (td.ddl_differs && !parts.length) parts.push("欄位 / 索引 / 外鍵相同，但建表 DDL 仍有差異（字元集 / 引擎 / 註解等）");
    if (parts.length) L.push(`資料表 ${td.name}：${parts.join("；")}`);
  }
  if (diff.views_added.length) L.push(`僅來源有的視圖：${diff.views_added.join(", ")}`);
  if (diff.views_removed.length) L.push(`僅目標有的視圖：${diff.views_removed.join(", ")}`);
  if (diff.views_changed.length) L.push(`定義不同的視圖：${diff.views_changed.map((v) => v.name).join(", ")}`);
  const rn = (x: { name: string; routine_type: string | null }) => `${x.name}(${x.routine_type ?? "routine"})`;
  if (diff.routines_added.length) L.push(`僅來源有的程序 / 函式 / 觸發器：${diff.routines_added.map(rn).join(", ")}`);
  if (diff.routines_removed.length) L.push(`僅目標有的程序 / 函式 / 觸發器：${diff.routines_removed.map(rn).join(", ")}`);
  if (diff.routines_changed.length) L.push(`定義不同的程序 / 函式 / 觸發器：${diff.routines_changed.map(rn).join(", ")}`);
  const destructive = statements.filter((s) => s.destructive);
  L.push(`同步腳本共 ${statements.length} 句，其中 ${destructive.length} 句為破壞性：${destructive.map((s) => `${s.kind} ${s.object}`).join("、") || "無"}`);
  if (skipped.length) L.push(`無法自動產生語句的變更：${skipped.join("；")}`);
  return L.join("\n");
}

/** 組 AI 摘要的提示詞：要的是「風險與執行順序」，不是把差異再唸一遍。 */
export function buildAiSummaryPrompt(digest: string): string {
  return [
    "你是資料庫結構同步的審查者。以下是一次結構比對的差異摘要（方向：讓『目標』變成『來源』）。",
    "請用繁體中文寫一份簡短總結給準備執行同步的人看，控制在 200 字內，用條列：",
    "1. 這次同步的整體性質（例如：純新增、含破壞性變更、跨引擎無法自動同步）。",
    "2. 最需要注意的風險，特別是會遺失資料或鎖表的操作（DROP、改型別、改 NOT NULL、卸唯一索引）。",
    "3. 建議的執行順序或前置動作（例如先備份哪些表、是否該在離峰時段執行）。",
    "只講判斷與建議，不要把差異清單重述一遍，也不要輸出 SQL。",
    "",
    "--- 差異摘要 ---",
    digest,
  ].join("\n");
}
