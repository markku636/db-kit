import type { KeyPage } from "./api";

// Redis 鍵詳情 / 複製的純函式（從 TableView 抽出來，方便單測與共用）。

const SUPPORTED_TYPES = new Set(["none", "string", "list", "set", "hash", "zset", "stream"]);

/** 後端 key_page 只認這幾種 TYPE；RedisJSON / RedisTimeSeries 這類模組型別會被當成空集合。 */
export function isSupportedRedisKeyType(type: string): boolean {
  return SUPPORTED_TYPES.has(type);
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
