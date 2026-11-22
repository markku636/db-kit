import type { KeyPage } from "./api";

// Redis 鍵詳情 / 複製的純函式（從 TableView 抽出來，方便單測與共用）。

const SUPPORTED_TYPES = new Set(["none", "string", "list", "set", "hash", "zset", "stream"]);

/** 後端 key_page 只認這幾種 TYPE；RedisJSON / RedisTimeSeries 這類模組型別會被當成空集合。 */
export function isSupportedRedisKeyType(type: string): boolean {
  return SUPPORTED_TYPES.has(type);
}

/** 匯出單鍵為可讀 JSON（仿 ARDM 的 Export keys）；型別不同用不同欄位名，不混淆 field / member。 */
export function buildRedisKeyExport(
  key: string,
  p: Pick<KeyPage, "type_" | "ttl" | "total" | "fields" | "members" | "scores" | "cursor">,
): string {
  let value: unknown;
  switch (p.type_) {
    case "string": value = p.members[0] ?? ""; break;
    case "hash": value = p.fields.map((f, i) => ({ field: f, value: p.members[i] ?? "" })); break;
    case "zset": value = p.members.map((m, i) => ({ member: m, score: p.scores[i] ?? 0 })); break;
    case "stream": value = p.members.map((m, i) => ({ id: p.fields[i] ?? "", fields: m })); break;
    default: value = p.members;
  }
  return JSON.stringify({
    key, type: p.type_, ttl: p.ttl, value,
    exported: Array.isArray(value) ? value.length : 1,
    total: p.total,
    partial: p.cursor !== 0 && p.type_ !== "string",
  }, null, 2);
}

/** 鍵詳情頁尾的提示：過濾後整頁都沒符合、但後面還有資料時要講清楚，不能只顯示「已載入 0 筆」。 */
export function redisPageHint(filtered: boolean, count: number, hasMore: boolean): string {
  if (filtered && count === 0 && hasMore) {
    return "此頁沒有符合的項目，但還有更多未掃描；繼續載入或清除過濾。";
  }
  return "已載入 {count} 筆";
}

export interface RedisCopyText {
  text: string;
  /** 已顯示的資料筆數（hash 算欄位、stream 算項目；string 不算）。 */
  shown: number;
  /** 只複製到第一頁、實際還有更多。 */
  partial: boolean;
}

/**
 * 鍵值複製成可讀文字。stream 要帶 ID（後端把 ID 放在 fields、JSON 內容放在 members），
 * 少了 ID 就只是一堆沒有身份的 JSON，既不能貼回去也無從對照。
 */
export function formatRedisKeyForCopy(
  p: Pick<KeyPage, "type_" | "total" | "fields" | "members" | "scores">,
): RedisCopyText {
  let text: string;
  let shown: number;
  switch (p.type_) {
    case "string":
      text = p.members[0] ?? "";
      shown = 0;
      break;
    case "hash":
      text = p.fields.map((f, i) => `${f}=${p.members[i] ?? ""}`).join("\n");
      shown = p.fields.length;
      break;
    case "zset":
      text = p.members.map((m, i) => `${p.scores[i] ?? 0} ${m}`).join("\n");
      shown = p.members.length;
      break;
    case "stream":
      text = p.members.map((m, i) => `${p.fields[i] ?? ""} ${m}`).join("\n");
      shown = p.members.length;
      break;
    default:
      text = p.members.join("\n");
      shown = p.members.length;
  }
  return { text, shown, partial: p.type_ !== "string" && p.total > shown };
}
