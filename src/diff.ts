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
