// 壓力測試（stress / benchmark）的前端純函式：參數池展開、CSV 參數解析、計畫驗證、
// 報告輸出與顯示格式化。與 React / Tauri 無關，由 stress.test.ts 覆蓋；UI 只負責蒐集輸入與渲染。
// SQL 生成一律借道 sql.ts 的既有跳脫（quoteIdent / sqlLiteral / substituteNamedParams）——
// 方言差異（MySQL 反斜線、mssql 的 N'…'）已在那裡實作且有測試，這裡再寫一份必然漂移成注入漏洞。
import type { DbKind, StressMode, StressPlan, StressReport, StressSample } from "./api";
import type { TsPoint } from "./ui/TimeSeriesChart";
import { extractNamedParams, substituteNamedParams } from "./sql";
import { t } from "./i18n";

// ---- 參數池：把「一條含 :param 的語句 + 多列參數值」展開成多條完整語句 ----

/**
 * 依參數列產生語句池（worker 之間輪替取用，避免整場壓測只打同一把 key 而全落在快取上）。
 * - 無具名參數、或沒有任何參數列 → 回傳原語句（單元素池），呼叫端不必特判。
 * - 某列缺該參數 → 以空字串代入（而非保留 `:name`）：把不完整的列送進資料庫至少會得到
 *   「查無資料」而非語法錯誤，壓測結果比整場報 syntax error 有意義。
 * - 欄名允許帶前導冒號（`:id`），與 parseParamCsv 產生的列一致，也容忍手寫的物件。
 */
export function expandParamPool(kind: DbKind, sql: string, rows: Record<string, string>[]): string[] {
  const names = extractNamedParams(sql);
  if (names.length === 0 || rows.length === 0) return [sql];
  return rows.map((row) => {
    // 無原型物件承接：參數名允許 `constructor` / `toString` / `__proto__`（PARAM_RE 只擋首字為數字），
    // 用一般物件字面值時 `values.toString` 會撞到 Object.prototype 的繼承成員，
    // 代進 sqlLiteral 直接 TypeError；而 `values.__proto__ = x` 是改原型不是設值。
    const values: Record<string, string> = Object.create(null);
    for (const n of names) values[n] = ownValue(row, n) ?? ownValue(row, `:${n}`) ?? "";
    return substituteNamedParams(kind, sql, values);
  });
}

// 只認自有屬性：呼叫端可能傳一般物件字面值，`row["valueOf"]` 會讀到繼承來的函式而非 undefined。
function ownValue(row: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
}

// ---- 貼上的 CSV → 參數列 ----

/**
 * 解析 RFC4180 風格 CSV 成記錄陣列。手寫而非套件：只有這一處要用，且需要「引號內含逗號 /
 * 換行」與「空白行略過」這兩個貼上場景的行為，外部套件反而要另外設定。
 */
function parseCsvRecords(text: string): string[][] {
  // 先去 BOM（Excel 匯出的 CSV 必帶，留著會混進第一個欄名）並統一換行，之後只需處理 \n。
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const src = body.replace(/\r\n?/g, "\n");
  const records: string[][] = [];
  let rec: string[] = [];
  let field = "";
  let quoted = false;
  let quotedAny = false; // 本列是否出現過加引號的欄位（用來分辨「空字串值」與「空白行」）
  const endRecord = () => {
    rec.push(field);
    field = "";
    // 空白行（整列只有一個空欄位）不成一筆——使用者貼上時尾端常多幾個換行。
    // 但 `""` 是 RFC4180 明確寫出的空字串值，不可與空白行同等丟棄；否則單欄 CSV 沒辦法
    // 表達「這一輪參數帶空字串」（多欄 CSV 因 rec.length > 1 反而留得住，行為會不一致）。
    if (quotedAny || !(rec.length === 1 && rec[0].trim() === "")) records.push(rec);
    rec = [];
    quotedAny = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      // 引號內：`""` 是跳脫的引號，單一 `"` 才是結束（逗號 / 換行在此皆為資料）。
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; continue; }
        quoted = false;
        continue;
      }
      field += ch;
      continue;
    }
    // 只有在欄位開頭的引號才啟動引號模式，`a"b` 之類的裸引號視為資料（貼上的資料常有）。
    if (ch === '"' && field === "") { quoted = true; quotedAny = true; continue; }
    if (ch === ",") { rec.push(field); field = ""; continue; }
    if (ch === "\n") { endRecord(); continue; }
    field += ch;
  }
  // 最後一列可能沒有結尾換行；quotedAny 讓結尾恰為 `""` 的單欄列也收得到。
  if (field !== "" || rec.length > 0 || quotedAny) endRecord();
  return records;
}

/**
 * 解析使用者貼上的參數 CSV：第一列為欄名（對應具名參數，可寫 `id` 或 `:id`），其餘為值。
 * 回傳的 rows 以欄名為 key，供 expandParamPool 直接代入；缺的欄位補空字串。
 */
export function parseParamCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { headers: [], rows: [] };
  // 欄名去掉前導冒號：使用者常直接從 SQL 複製 `:id` 當標題。
  const raw = records[0].map((h) => h.trim().replace(/^:/, ""));
  const headers = raw.filter((h) => h !== "");
  const rows = records.slice(1).map((r) => {
    // 同樣用無原型物件：欄名來自使用者貼上的文字，叫 `__proto__` 時一般物件的
    // `row["__proto__"] = v` 是設原型（字串還會被忽略），值會無聲蒸發成空字串。
    const row: Record<string, string> = Object.create(null);
    raw.forEach((h, i) => { if (h) row[h] = r[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

// ---- 計畫驗證 ----

// 上限與後端 stress.rs 的夾擠一致（threads 1..=64）；其餘為前端保護，避免使用者手滑打出
// 一個要跑三小時或塞爆記憶體的計畫，並在送出前就給出可讀訊息（而非等後端報錯）。
const MAX_THREADS = 64;
const MAX_WARMUP = 10000;
const MAX_DELAY_MS = 60000;

/**
 * 非負且「安全」的整數——UI 的 number input 可能吐出 NaN / 小數 / 負值。
 * 用 isSafeInteger 而非 isInteger：type=number 收得下 `1e30` 或 20 位數字，兩者 isInteger 皆為 true，
 * 但 JSON.stringify 會寫成 `1e+30`（serde 的 u64 / usize 直接反序列化失敗）或超過 u64::MAX 而溢位——
 * 使用者只會看到一句看不懂的後端錯誤，這裡先擋下才有可讀訊息。
 */
function isNonNegInt(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

// 模式相關的規則獨立成函式：兩種模式的欄位互斥，混在主流程會讓分支數翻倍且難以逐條測試。
function validateMode(mode: StressMode): string | null {
  if (mode.kind === "iterations") {
    return !isNonNegInt(mode.per_thread) || mode.per_thread < 1 ? t("每執行緒次數需至少 1 次") : null;
  }
  if (!isNonNegInt(mode.secs) || mode.secs < 1) return t("持續時間需至少 1 秒");
  if (!isNonNegInt(mode.ramp_secs)) return t("爬升時間需為非負整數");
  // 爬升期用來逐步放行 worker；長過總時長代表壓測還沒滿載就結束了。
  if (mode.ramp_secs > mode.secs) return t("爬升時間不可超過持續時間");
  return null;
}

/**
 * 驗證壓測計畫，回傳第一個問題的訊息；全部合法回 null。
 * 只回第一個問題（而非清單）：表單一次只需引導使用者修一處，逐條列出反而讓人不知從何改起。
 */
export function validatePlan(plan: StressPlan): string | null {
  if (!plan.statements.some((s) => s.trim())) return t("請至少提供一條要壓測的語句");
  if (!isNonNegInt(plan.threads) || plan.threads < 1 || plan.threads > MAX_THREADS) {
    return t("執行緒數需為 1 到 64 之間的整數");
  }
  const modeErr = validateMode(plan.mode);
  if (modeErr) return modeErr;
  if (!isNonNegInt(plan.warmup_iterations) || plan.warmup_iterations > MAX_WARMUP) {
    return t("暖機次數需為 0 到 10000 之間的整數");
  }
  if (!isNonNegInt(plan.delay_ms) || plan.delay_ms > MAX_DELAY_MS) {
    return t("每次查詢間隔需為 0 到 60000 毫秒之間的整數");
  }
  if (!isNonNegInt(plan.row_cap)) return t("列數上限需為非負整數（0 表示不截斷）");
  if (!isNonNegInt(plan.query_timeout_ms)) return t("查詢逾時需為非負整數（0 表示不逾時）");
  return null;
}

// ---- 顯示格式化 ----

/**
 * 延遲的顯示格式：次毫秒查詢（走快取 / 本機 SQLite）用三位小數才看得出差異；
 * 破秒的延遲以秒呈現，免得讀者要自己數位數。
 */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  const abs = Math.abs(ms);
  if (abs < 1) return `${ms.toFixed(3)} ms`;
  if (abs < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/**
 * TPS 顯示：加千分位（壓測動輒上萬，沒有分隔很難一眼比大小）。
 * 刻意不用 toLocaleString——它會隨執行環境的 ICU / 語系吐出不同分隔符，報告貼出去就不一致了。
 */
export function fmtRps(n: number): string {
  if (!Number.isFinite(n)) return "-";
  const fixed = Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1);
  const neg = fixed.startsWith("-");
  const [int, frac] = (neg ? fixed.slice(1) : fixed).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+$)/g, ",");
  return `${neg ? "-" : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

// ---- 圖表 ----

/**
 * 後端 series 的 t_ms 是「自壓測開始的相對毫秒」，圖表吃的是絕對時間戳，
 * 故需呼叫端提供該場壓測的起始 epoch ms（baseTs）才能對齊時間軸。
 */
export function seriesToPoints(series: StressSample[], field: "rps" | "p95_ms", baseTs: number): TsPoint[] {
  // 非有限值（後端在零樣本區間可能算出 NaN）壓成 0：丟掉點會讓時間軸出現看不見的斷裂，
  // 留著 NaN 則會讓 SVG path 整條消失。
  return series.map((s) => ({ t: baseTs + s.t_ms, v: Number.isFinite(s[field]) ? s[field] : 0 }));
}

// ---- 報告 ----

// Markdown 表格儲存格：跳脫 |、換行收成空白（錯誤訊息常是多行的 driver 輸出）。
const mdCell = (v: string) => v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

const MAX_ERROR_GROUPS = 10;

/**
 * 產生可直接貼進 Jira / 丟給 AI 的 Markdown 報告。刻意用 Markdown 而非 JSON：
 * 人看得懂、LLM 也吃得下，兩種用途一份輸出。
 */
export function reportToMarkdown(report: StressReport, sql: string): string {
  const out: string[] = [];
  const kv = (k: string, v: string) => `| ${k} | ${v} |`;

  out.push(t("# 壓力測試報告"), "");

  out.push(t("## 設定"), "");
  out.push(t("| 項目 | 值 |"), "| --- | --- |");
  out.push(kv(t("執行緒"), String(report.threads)));
  out.push(kv(t("模式"), report.mode));
  out.push(kv(t("暖機次數（每執行緒）"), String(report.warmup_iterations)));
  out.push(kv(t("中途取消"), report.cancelled ? t("是") : t("否")));
  out.push("");

  out.push(t("## 總覽"), "");
  out.push(t("| 指標 | 值 |"), "| --- | --- |");
  out.push(kv(t("總耗時"), fmtMs(report.elapsed_ms)));
  out.push(kv(t("完成查詢數"), String(report.completed)));
  out.push(kv(t("錯誤數"), String(report.errors)));
  out.push(kv(t("回傳列數"), String(report.rows_total)));
  out.push(kv(t("TPS（每秒查詢數）"), fmtRps(report.rps)));
  out.push("");

  out.push(t("## 延遲"), "");
  out.push(t("| 統計 | 延遲 |"), "| --- | --- |");
  out.push(kv(t("平均"), fmtMs(report.avg_ms)));
  out.push(kv(t("最小"), fmtMs(report.min_ms)));
  out.push(kv("P50", fmtMs(report.p50_ms)));
  out.push(kv("P90", fmtMs(report.p90_ms)));
  out.push(kv("P95", fmtMs(report.p95_ms)));
  out.push(kv("P99", fmtMs(report.p99_ms)));
  out.push(kv(t("最大"), fmtMs(report.max_ms)));
  out.push(kv(t("標準差"), fmtMs(report.stddev_ms)));
  out.push("");

  out.push(t("## 錯誤"), "");
  const groups = report.error_groups;
  if (groups.length === 0) {
    out.push(t("無錯誤。"), "");
  } else {
    out.push(t("| 次數 | 訊息 |"), "| --- | --- |");
    for (const g of groups.slice(0, MAX_ERROR_GROUPS)) out.push(`| ${g.count} | ${mdCell(g.message)} |`);
    const rest = groups.length - MAX_ERROR_GROUPS;
    if (rest > 0) out.push("", t("（另有 {n} 組錯誤未列出）", { n: rest }));
    out.push("");
  }

  out.push(t("## 語句"), "");
  // 圍籬取「比 SQL 內最長的反引號串再多一個」，否則含 ``` 的語句（例如註解裡貼了程式碼）會提早收掉區塊。
  const fence = "`".repeat(Math.max(3, ...(sql.match(/`+/g) ?? []).map((s) => s.length + 1)));
  out.push(`${fence}sql`, sql.trim(), fence, "");

  return out.join("\n");
}
