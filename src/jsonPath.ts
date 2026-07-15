// 輕量 JSON 路徑投影（訊息瀏覽器的欄位投影用）。純前端、無 eval。
//
// 語法：`.a.b`、`[0]`、`.a[2].b`；逗號分隔多路徑（輸出以 `path=值` 併排）。
// 開頭的 `.` 可省。找不到的路徑回 `∅`。

type Json = unknown;

/** 解析單一路徑為 token 陣列。`.a`→"a"、`[0]`→0。非法回 null。 */
function parsePath(expr: string): (string | number)[] | null {
  const tokens: (string | number)[] = [];
  let i = 0;
  const s = expr.trim();
  // 允許開頭省略 '.'
  while (i < s.length) {
    const c = s[i];
    if (c === ".") {
      i++;
      let name = "";
      while (i < s.length && s[i] !== "." && s[i] !== "[") name += s[i++];
      if (name === "") return null;
      tokens.push(name);
    } else if (c === "[") {
      const close = s.indexOf("]", i);
      if (close === -1) return null;
      const idx = Number(s.slice(i + 1, close));
      if (!Number.isInteger(idx)) return null;
      tokens.push(idx);
      i = close + 1;
    } else if (tokens.length === 0) {
      // 開頭非 . / [ → 當作第一個欄位名
      let name = "";
      while (i < s.length && s[i] !== "." && s[i] !== "[") name += s[i++];
      tokens.push(name);
    } else {
      return null;
    }
  }
  return tokens.length ? tokens : null;
}

function getPath(value: Json, tokens: (string | number)[]): Json | undefined {
  let cur: Json = value;
  for (const tok of tokens) {
    if (cur == null) return undefined;
    if (typeof tok === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[tok];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, Json>)[tok];
    }
  }
  return cur;
}

function fmt(v: Json): string {
  if (v === undefined) return "∅";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * 對一個已解析的 JSON 值套用投影表達式（逗號分隔多路徑）。
 * 單一路徑輸出值本身；多路徑輸出 `path=值 · path=值`。
 */
export function projectJson(value: Json, expr: string): string {
  const parts = expr.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const results = parts.map((p) => {
    const tokens = parsePath(p);
    if (!tokens) return `${p}=?`;
    const v = getPath(value, tokens);
    return parts.length === 1 ? fmt(v) : `${p}=${fmt(v)}`;
  });
  return results.join(" · ");
}

/** 便利版：value 為 JSON 字串時先解析再投影；非 JSON 回 null（呼叫端顯示原值）。 */
export function projectText(text: string | null, expr: string): string | null {
  if (text == null) return null;
  let parsed: Json;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return projectJson(parsed, expr);
}
