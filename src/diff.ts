// 輕量 LCS 行 diff（供 Schema Registry 版本比對）。純函式、無依賴。
// 回傳每行的狀態：same / add（僅在 b）/ del（僅在 a）。schema 文字小，O(n·m) 可接受。

export type DiffType = "same" | "add" | "del";
export interface DiffLine { type: DiffType; text: string }

export function diffLines(a: string, b: string): DiffLine[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = al.length;
  const m = bl.length;
  // LCS 長度表。
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = al[i] === bl[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  // 回溯產生 diff。
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push({ type: "same", text: al[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: al[i] });
      i++;
    } else {
      out.push({ type: "add", text: bl[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: al[i++] });
  while (j < m) out.push({ type: "add", text: bl[j++] });
  return out;
}

// ---- 字詞級 diff（同一行的兩個版本）----
// 行 diff 只能說「這一行變了」；DDL 一行常常只改了型別或長度，整行標紅綠使用者還得自己逐字找。
// 以識別字 / 數字為一個 token、空白為一個 token、其餘標點各自一個 token 做 LCS，
// 就能把 `varchar(50)` → `varchar(200)` 裡真正變動的 `50` / `200` 標出來。

export type DiffToken = DiffLine;

/** 切 token：識別字（含 Unicode 字母）與數字為一組、連續空白為一組、其餘每個字元自成一組。 */
export function tokenize(s: string): string[] {
  return s.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? [];
}

/** token 級 LCS diff；行內 token 通常只有幾十個，O(n·m) 綽綽有餘。 */
export function diffTokens(a: string, b: string): DiffToken[] {
  const at = tokenize(a);
  const bt = tokenize(b);
  const n = at.length;
  const m = bt.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = at[i] === bt[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (at[i] === bt[j]) { out.push({ type: "same", text: at[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: "del", text: at[i++] }); }
    else { out.push({ type: "add", text: bt[j++] }); }
  }
  while (i < n) out.push({ type: "del", text: at[i++] });
  while (j < m) out.push({ type: "add", text: bt[j++] });
  return out;
}

/**
 * 兩行相似到值得做字詞級標示嗎？相同 token 的字元數佔兩邊總量的比例。
 * 太低（整行重寫）時字詞級標示只會變成紅綠碎片，不如整行上色。
 */
export function tokenSimilarity(tokens: DiffToken[]): number {
  let same = 0;
  let total = 0;
  for (const t of tokens) {
    const w = t.text.trim().length;
    total += t.type === "same" ? w * 2 : w;
    if (t.type === "same") same += w * 2;
  }
  return total === 0 ? 1 : same / total;
}
