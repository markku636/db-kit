// 結構 / 資料比對對話框的純函式（列狀態、語句分組、腳本組裝、DDL 並排）。
// 抽離自 CompareDialog / TableCompareView 以便單元測試（見 compareModel.test.ts），不依賴 React / Tauri。
import type { CaptureOptions, DbKind, DbSchema, DiffOptions, SchemaDiff, SyncOptions, SyncStatement, TableDiff } from "./api";
import { renderTask } from "./aiLibrary";
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
  /** 有差異的資料表：欄位 / 索引 / 外鍵各自的增刪改數（列表上的摘要徽章用）。 */
  changes?: RowChanges;
}

/** 增 / 刪 / 改 三個計數。 */
export interface ChangeCounts { add: number; del: number; chg: number }
export interface RowChanges { columns: ChangeCounts; indexes: ChangeCounts; fks: ChangeCounts; ddlOnly: boolean }

/** 一張表的差異摘要：不必點進去就知道「動了 2 個欄位、加了 1 個索引」。 */
export function tableDiffChanges(td: TableDiff): RowChanges {
  const columns = { add: td.columns_added.length, del: td.columns_removed.length, chg: td.columns_changed.length };
  const indexes = { add: td.indexes_added.length, del: td.indexes_removed.length, chg: td.indexes_changed.length };
  const fks = { add: td.fks_added.length, del: td.fks_removed.length, chg: td.fks_changed.length };
  const any = [columns, indexes, fks].some((c) => c.add + c.del + c.chg > 0);
  return { columns, indexes, fks, ddlOnly: td.ddl_differs && !any };
}

/** 列的唯一鍵（同名的表與視圖要分得開）。 */
export const rowKey = (r: Pick<CompareRow, "objType" | "name">) => `${r.objType}:${r.name}`;

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
    for (const td of schema.tables_changed) {
      const r = get(td.name, "table");
      r.schema = tableHasDiff(td) ? "changed" : "identical";
      if (r.schema === "changed") r.changes = tableDiffChanges(td);
    }
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

/**
 * 組 AI 摘要的提示詞（ai-library/prompts/compare-summary.md）：要的是「風險與執行順序」，
 * 不是把差異再唸一遍。
 */
export function buildAiSummaryPrompt(digest: string): string {
  return renderTask("compare-summary", { digest });
}

// ---- 狀態篩選（結果清單上方的晶片）----

/** 「有差異」的三種狀態；預設只看這三種，相同的先藏起來。 */
export const DIFF_STATUSES: readonly RowStatus[] = ["differs", "source_only", "target_only"];
export const FILTERABLE_STATUSES: readonly RowStatus[] = ["differs", "source_only", "target_only", "identical"];
export const STATUS_FILTER_KEY = "dbkit:compare:statusFilter";

/** 從 localStorage 讀回的狀態篩選；壞值 / 空集合一律退回預設（全藏會讓清單看起來像比對失敗）。 */
export function parseStatusFilter(raw: string | null | undefined): Set<RowStatus> {
  try {
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(arr)) {
      const s = new Set<RowStatus>(arr.filter((x): x is RowStatus => FILTERABLE_STATUSES.includes(x as RowStatus)));
      if (s.size > 0) return s;
    }
  } catch { /* 壞 JSON → 預設 */ }
  return new Set(DIFF_STATUSES);
}

/**
 * 依狀態晶片與搜尋字過濾。進行中 / 未比對的列不受狀態晶片影響（比對跑到一半就該看得到它在跑），
 * 搜尋字不分大小寫、比對子字串。
 */
export function filterRows(rows: CompareRow[], statusOn: ReadonlySet<RowStatus>, text: string): CompareRow[] {
  const f = text.trim().toLowerCase();
  return rows.filter((r) =>
    (r.status === "pending" || r.status === "running" || statusOn.has(r.status))
    && (!f || r.name.toLowerCase().includes(f)));
}

// ---- 比對選項（對話框「選項」下拉；存 localStorage）----

export interface CompareOptions {
  /** 名稱比對忽略大小寫（MySQL 在 Linux 區分表名、Windows 不分）。 */
  ignore_case: boolean;
  ignore_comments: boolean;
  ignore_defaults: boolean;
  /** 索引 / 外鍵名稱不同但定義相同 → 視為改名而非一刪一增。 */
  match_by_content: boolean;
  include_views: boolean;
  include_routines: boolean;
  /** 欄位一刪一增、型別相同且配對唯一 → 同步腳本用 RENAME COLUMN（推測，預設關）。 */
  detect_renames: boolean;
}
export const DEFAULT_COMPARE_OPTIONS: CompareOptions = {
  ignore_case: false, ignore_comments: false, ignore_defaults: false, match_by_content: true,
  include_views: true, include_routines: true, detect_renames: false,
};
export const COMPARE_OPTIONS_KEY = "dbkit:compare:options";

/** 讀回選項：只接受布林欄位，缺的補預設，多的丟掉（舊版存的 key 不會把新版弄壞）。 */
export function parseCompareOptions(raw: string | null | undefined): CompareOptions {
  const out = { ...DEFAULT_COMPARE_OPTIONS };
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (o && typeof o === "object") {
      for (const k of Object.keys(DEFAULT_COMPARE_OPTIONS) as (keyof CompareOptions)[]) {
        if (typeof o[k] === "boolean") out[k] = o[k] as boolean;
      }
    }
  } catch { /* 壞 JSON → 預設 */ }
  return out;
}

export const toDiffOptions = (o: CompareOptions): DiffOptions =>
  ({ ignore_case: o.ignore_case, ignore_comments: o.ignore_comments, ignore_defaults: o.ignore_defaults, match_by_content: o.match_by_content });
export const toCaptureOptions = (o: CompareOptions, tables?: string[]): CaptureOptions =>
  ({ include_ddl: true, include_views: o.include_views, include_routines: o.include_routines, tables: tables ?? null });
export const toSyncOptions = (o: CompareOptions): SyncOptions =>
  ({ include_drops: true, include_indexes: true, include_fks: true, include_views: o.include_views, include_routines: o.include_routines, detect_renames: o.detect_renames });

/** 與預設不同的選項數（工具列上「選項」鈕的徽章）。 */
export function countNonDefaultOptions(o: CompareOptions): number {
  return (Object.keys(DEFAULT_COMPARE_OPTIONS) as (keyof CompareOptions)[]).filter((k) => o[k] !== DEFAULT_COMPARE_OPTIONS[k]).length;
}

// ---- 語句 ↔ 物件的歸屬（清單上的物件勾選框驅動同步腳本）----

const VIEW_KINDS = new Set<SyncStatement["kind"]>(["create_view", "drop_view"]);
const ROUTINE_KINDS = new Set<SyncStatement["kind"]>(["create_routine", "drop_routine"]);

/**
 * 一句同步語句屬於清單上的哪一列。語句的 `object` 是 `table` 或 `table.child`（欄位 / 索引 / 外鍵），
 * 而 SQL Server 的表名本身可以帶 schema（`sales.orders`），所以不能切第一個點——
 * 改成在同類型的列裡找「等於或以 `name.` 開頭」的最長者。找不到回 null（一律視為包含）。
 */
export function statementOwner(s: SyncStatement, rows: readonly CompareRow[]): string | null {
  const type: CompareRow["objType"] = VIEW_KINDS.has(s.kind) ? "view" : ROUTINE_KINDS.has(s.kind) ? "routine" : "table";
  let best: CompareRow | null = null;
  for (const r of rows) {
    if (r.objType !== type) continue;
    if (s.object === r.name || s.object.startsWith(`${r.name}.`)) {
      if (!best || r.name.length > best.name.length) best = r;
    }
  }
  return best ? rowKey(best) : null;
}

// ---- 並排 DDL：行號、差異段落、摺疊相同行 ----

export interface SidePair { left: DiffLine | null; right: DiffLine | null }
export interface NumberedPair extends SidePair {
  /** 來源 / 目標各自的行號（該側沒有這行時為 null）。 */
  ln: number | null;
  rn: number | null;
  changed: boolean;
}

/** 補上兩側行號與「這一列是否為差異」。 */
export function numberPairs(pairs: SidePair[]): NumberedPair[] {
  let l = 0;
  let r = 0;
  return pairs.map((p) => {
    const ln = p.left ? ++l : null;
    const rn = p.right ? ++r : null;
    const changed = !(p.left && p.right && p.left.type === "same");
    return { ...p, ln, rn, changed };
  });
}

/** 每一段連續差異的起始列索引（上一個 / 下一個差異用）。 */
export function hunkStarts(pairs: readonly { changed: boolean }[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].changed && (i === 0 || !pairs[i - 1].changed)) out.push(i);
  }
  return out;
}

export type FoldItem = { kind: "row"; index: number } | { kind: "fold"; from: number; to: number };

/**
 * 「只看差異」：差異前後各留 `context` 行，其餘相同行縮成一個可展開的摺疊。
 * `expanded` 是使用者點開過的摺疊（以起始索引記）；短到不值得摺（≤ 2 行）的直接攤開。
 */
export function foldUnchanged(pairs: readonly { changed: boolean }[], context: number, expanded: ReadonlySet<number>): FoldItem[] {
  const keep = new Array<boolean>(pairs.length).fill(false);
  for (let i = 0; i < pairs.length; i++) {
    if (!pairs[i].changed) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(pairs.length - 1, i + context); k++) keep[k] = true;
  }
  const out: FoldItem[] = [];
  let i = 0;
  while (i < pairs.length) {
    if (keep[i]) { out.push({ kind: "row", index: i }); i++; continue; }
    let j = i;
    while (j < pairs.length && !keep[j]) j++;
    if (j - i <= 2 || expanded.has(i)) for (let k = i; k < j; k++) out.push({ kind: "row", index: k });
    else out.push({ kind: "fold", from: i, to: j });
    i = j;
  }
  return out;
}
