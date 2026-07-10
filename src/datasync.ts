// 資料比對 / 同步（致敬 Navicat Data Synchronization）：以主鍵比對來源 / 目標兩表的列，
// 算出「目標缺少 → INSERT、值有差 → UPDATE、目標多出 → DELETE」並產生同步 DML。
// 純函式、可單元測試；UI 載入兩表資料後呼叫，產生的 DML 供檢視後執行（不自動套用）。
import { DbKind } from "./api";
import { quoteIdent, sqlLiteral, qualifiedName, buildInsertValues } from "./sql";
import { t } from "./i18n";

export interface RowSet {
  columns: string[];
  pk: string[];
  rows: (string | null)[][];
}

export interface RowDiff {
  inserts: (string | null)[][]; // 來源整列（src.columns 順序）
  updates: (string | null)[][]; // 來源整列（值有差者）
  deletes: (string | null)[][]; // 目標多出列的主鍵值元組（src.pk 順序）
}

// 由列 + 欄索引組主鍵鍵值。以 JSON 編碼，明確區分 NULL 與空字串，且複合主鍵不會串接碰撞
// （如 ["1","2"] vs ["12",""] 的 JSON 不同）。
function keyByIdx(row: (string | null)[], idxs: number[]): string {
  return JSON.stringify(idxs.map((i) => row[i] ?? null));
}

export function diffRowsByPk(src: RowSet, dst: RowSet): RowDiff {
  const srcPkIdx = src.pk.map((c) => src.columns.indexOf(c)).filter((i) => i >= 0);
  if (srcPkIdx.length !== src.pk.length || src.pk.length === 0) {
    throw new Error(t("來源缺主鍵，無法以主鍵比對"));
  }
  const dstPkIdx = src.pk.map((c) => dst.columns.indexOf(c));
  if (dstPkIdx.some((i) => i < 0)) throw new Error(t("目標缺少對應主鍵欄位"));
  // 來源欄 → 目標欄索引（比對非主鍵欄值用）。
  const dstColIdx = src.columns.map((c) => dst.columns.indexOf(c));

  const dstMap = new Map<string, (string | null)[]>();
  for (const r of dst.rows) dstMap.set(keyByIdx(r, dstPkIdx), r);

  const inserts: (string | null)[][] = [];
  const updates: (string | null)[][] = [];
  const seen = new Set<string>();
  const pkSet = new Set(src.pk);
  for (const sr of src.rows) {
    const k = keyByIdx(sr, srcPkIdx);
    const dr = dstMap.get(k);
    if (!dr) { inserts.push(sr); continue; }
    seen.add(k);
    let differs = false;
    for (let i = 0; i < src.columns.length; i++) {
      if (pkSet.has(src.columns[i])) continue;
      const di = dstColIdx[i];
      if (di < 0) continue; // 目標無此欄 → 不比
      if ((sr[i] ?? null) !== (dr[di] ?? null)) { differs = true; break; }
    }
    if (differs) updates.push(sr);
  }
  const deletes: (string | null)[][] = [];
  for (const dr of dst.rows) {
    if (!seen.has(keyByIdx(dr, dstPkIdx))) deletes.push(dstPkIdx.map((i) => dr[i]));
  }
  return { inserts, updates, deletes };
}

// 主鍵條件（NULL → IS NULL）。
function pkCond(kind: DbKind, col: string, v: string | null): string {
  return v === null ? `${quoteIdent(kind, col)} IS NULL` : `${quoteIdent(kind, col)} = ${sqlLiteral(kind, v)}`;
}

// 由 diff 產生同步 DML（套用於目標表）。includeDeletes=false 時略過刪除（較保守）。
// targetColumns：目標實有欄位；只對「來源 ∩ 目標」欄位產生 INSERT / UPDATE，避免引用目標沒有的欄位而失敗。
export function buildSyncDml(
  kind: DbKind,
  db: string,
  table: string,
  src: RowSet,
  diff: RowDiff,
  includeDeletes: boolean,
  targetColumns?: string[],
): string {
  const qtbl = qualifiedName(kind, db, table);
  // 同步欄位 = 來源 ∩ 目標（未提供 targetColumns 時即全部來源欄）。
  const tset = targetColumns ? new Set(targetColumns) : null;
  const cols = tset ? src.columns.filter((c) => tset.has(c)) : src.columns;
  const colIdx = (c: string) => src.columns.indexOf(c);
  const lines: string[] = [];

  if (diff.inserts.length) {
    const projected = diff.inserts.map((row) => cols.map((c) => row[colIdx(c)]));
    lines.push(buildInsertValues(kind, db, table, cols, projected));
  }
  const setCols = cols.filter((c) => !src.pk.includes(c));
  for (const row of diff.updates) {
    const setClause = setCols
      .map((c) => `${quoteIdent(kind, c)} = ${sqlLiteral(kind, row[colIdx(c)])}`)
      .join(", ");
    const where = src.pk.map((c) => pkCond(kind, c, row[colIdx(c)])).join(" AND ");
    lines.push(`UPDATE ${qtbl} SET ${setClause} WHERE ${where};`);
  }
  if (includeDeletes) {
    for (const pkVals of diff.deletes) {
      const where = src.pk.map((c, i) => pkCond(kind, c, pkVals[i])).join(" AND ");
      lines.push(`DELETE FROM ${qtbl} WHERE ${where};`);
    }
  }
  return lines.join("\n");
}
