// 發佈流量模式的隨機模板渲染。以 `{{token args}}` 佔位符產生測試資料。
//
// 支援佔位符：
//   {{uuid}}                隨機 UUID v4
//   {{seq}}                 目前序號（由呼叫端遞增傳入）
//   {{int min max}}         [min, max] 整數
//   {{float min max dec}}   [min, max] 浮點，dec 位小數（預設 2）
//   {{now}}                 epoch 毫秒
//   {{nowIso}}              ISO 8601 字串
//   {{bool}}                true / false
//   {{oneOf a|b|c}}         從清單隨機挑一
//   {{word n}}              n 個隨機小寫字母（預設 6）
//   {{name}} / {{email}}    隨機姓名 / email
//
// 非法或未知佔位符原樣保留（方便使用者發現拼錯）。

const FIRST = ["alex", "sam", "jordan", "casey", "riley", "morgan", "taylor", "jamie"];
const LAST = ["lee", "chen", "wang", "smith", "kim", "wu", "lin", "brown"];

function randInt(min: number, max: number): number {
  if (max < min) [min, max] = [max, min];
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randWord(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return s;
}

function uuid(): string {
  // RFC4122 v4（crypto 可用時優先）。
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && "randomUUID" in c) return c.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** 渲染一段模板；seq 為呼叫端提供的目前序號。 */
export function renderTemplate(tpl: string, seq: number): string {
  return tpl.replace(/\{\{\s*([a-zA-Z]+)([^}]*)\}\}/g, (whole, token: string, rawArgs: string) => {
    const args = rawArgs.trim();
    switch (token) {
      case "uuid":
        return uuid();
      case "seq":
        return String(seq);
      case "now":
        return String(Date.now());
      case "nowIso":
        return new Date().toISOString();
      case "bool":
        return Math.random() < 0.5 ? "true" : "false";
      case "int": {
        const [a, b] = args.split(/\s+/).map(Number);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return whole;
        return String(randInt(a, b));
      }
      case "float": {
        const parts = args.split(/\s+/).map(Number);
        const [a, b] = parts;
        const dec = Number.isFinite(parts[2]) ? parts[2] : 2;
        if (!Number.isFinite(a) || !Number.isFinite(b)) return whole;
        return (a + Math.random() * (b - a)).toFixed(dec);
      }
      case "oneOf": {
        const opts = args.split("|").map((s) => s.trim()).filter(Boolean);
        return opts.length ? opts[randInt(0, opts.length - 1)] : whole;
      }
      case "word": {
        const n = Number(args) || 6;
        return randWord(n);
      }
      case "name":
        return `${FIRST[randInt(0, FIRST.length - 1)]} ${LAST[randInt(0, LAST.length - 1)]}`;
      case "email":
        return `${randWord(5)}${randInt(1, 999)}@example.com`;
      default:
        return whole; // 未知佔位符原樣保留
    }
  });
}

/** 模板是否含任何佔位符（決定是否需要每 tick 重新渲染）。 */
export function hasTemplate(s: string): boolean {
  return /\{\{\s*[a-zA-Z]+[^}]*\}\}/.test(s);
}
