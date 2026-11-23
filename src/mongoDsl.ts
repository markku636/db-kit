// MongoDB 查詢編輯器用的是自訂 JSON DSL（{db, collection, filter, pipeline, insert, update, delete}）。
// 唯讀連線必須在前端先擋下會寫入的形式；後端 mongo.query() 本身不認識「唯讀模式」。

const WRITE_TOP_KEYS = ["insert", "update", "delete"];
const WRITE_STAGES = ["$out", "$merge"];

function hasWriteStage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasWriteStage);
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    // $out / $merge 會把聚合結果寫回集合，即使藏在 $facet 裡也要擋。
    if (WRITE_STAGES.includes(k)) return true;
    if (hasWriteStage(v)) return true;
  }
  return false;
}

/** Mongo 格值超過 4096 bytes 時後端會加這個後綴；這種預覽不能拿去寫回。 */
export function isTruncatedMongoCell(text: string): boolean {
  return /…⟪\+\d+ bytes⟫$/.test(text);
}

/** 這段 Mongo DSL 是否會寫入？解析失敗回 false（讓後端照常回報語法錯誤）。 */
export function isMongoWriteDsl(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const obj = parsed as Record<string, unknown>;
  if (WRITE_TOP_KEYS.some((k) => k in obj)) return true;
  return hasWriteStage(obj.pipeline);
}
