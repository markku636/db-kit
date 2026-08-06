// ES Query DSL → Kibana Discover 深層連結。
//
// 設計要點：**不得靜默丟失查詢條件**。轉不成 Kibana 原生 filter pill 的子句一律原封不動
// 包成 custom DSL filter（Kibana 支援 meta.type = "custom" 的任意 DSL），所以連結打開後
// 的結果集與 db-kit 裡跑的那一份等價。寧可 filter 列上出現一顆看不懂的 pill，
// 也不要給使用者一個「看起來對、其實少了條件」的網址。
//
// 通用性：時間欄位可設定（預設 @timestamp），不預設任何欄位名、不排除任何欄位 ——
// 顯示欄位純粹取自 DSL 的 _source。

/** Discover 連結所需的輸入。 */
export interface KibanaLinkOpts {
  /** Kibana 根網址，例 https://kibana.example.com（結尾斜線會被去掉）。 */
  kibanaUrl: string;
  /** Kibana data view（index-pattern saved object）的 id。 */
  dataViewId: string;
  /** 要轉換的 ES 查詢 envelope（含 index / query / _source / sort…）。 */
  dsl: Record<string, unknown>;
  /** 時間欄位名稱；預設 @timestamp。範圍條件落在此欄位才會變成 Discover 的時間區間。 */
  timeField?: string;
}

interface PhraseFilter {
  field: string;
  value: string;
  negate: boolean;
}

/** rison 中可以不加引號的識別字。 */
const BARE_ID = /^[A-Za-z_][A-Za-z0-9_.\-/]*$/;

/**
 * rison 編碼（Kibana 的網址狀態格式，見 github.com/Nanonid/rison）。
 * 不是 JSON：字串多半不加引號、陣列寫成 !(…)、true/false/null 是 !t/!f/!n。
 */
export function rison(v: unknown): string {
  if (v === null || v === undefined) return "!n";
  if (v === true) return "!t";
  if (v === false) return "!f";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v && BARE_ID.test(v)) return v;
    return `'${v.replace(/!/g, "!!").replace(/'/g, "!'")}'`;
  }
  if (Array.isArray(v)) return `!(${v.map(rison).join(",")})`;
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>)
      // undefined 在 rison 沒有對應表示法，直接略過該鍵（與 JSON.stringify 一致）
      .filter(([, val]) => val !== undefined)
      .map(([k, val]) => {
        const key = BARE_ID.test(k) ? k : `'${k.replace(/!/g, "!!").replace(/'/g, "!'")}'`;
        return `${key}:${rison(val)}`;
      });
    return `(${parts.join(",")})`;
  }
  throw new TypeError(`rison: 不支援的型別 ${typeof v}`);
}

/** rison 之後仍要做 URL 編碼，但 rison 的結構字元必須保持原樣，否則 Kibana 解不開。 */
const RISON_SAFE = new Set("'(),:!*-_.~$@".split(""));

export function encodeRison(v: unknown): string {
  return [...rison(v)]
    .map((ch) => (RISON_SAFE.has(ch) ? ch : encodeURIComponent(ch)))
    .join("");
}

/** 純量取值：term 可寫成 {value:x} 或 x；match_phrase 可寫成 {query:x} 或 x。 */
function scalar(v: unknown, key: "value" | "query"): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    const inner = (v as Record<string, unknown>)[key];
    return inner === null || inner === undefined || typeof inner === "object" ? null : String(inner);
  }
  return String(v);
}

/**
 * 走訪 bool 子句，抽出「能變成 Discover 原生元件」的部分：
 *   - 時間欄位上的 range → 時間區間
 *   - term / match_phrase（單一純量）→ phrase filter
 * 其餘（含巢狀 bool 內轉不掉的）原樣收進 leftovers，之後包成 custom filter。
 */
function collect(
  dsl: Record<string, unknown>,
  timeField: string
): { from: string; to: string; phrases: PhraseFilter[]; leftovers: unknown[]; hasTime: boolean } {
  let from = "now-15m";
  let to = "now";
  let hasTime = false;
  const phrases: PhraseFilter[] = [];
  const leftovers: unknown[] = [];

  const walk = (clauses: unknown, negate: boolean) => {
    if (!Array.isArray(clauses)) return;
    for (const c of clauses) {
      if (!c || typeof c !== "object") continue;
      const clause = c as Record<string, unknown>;

      const range = clause.range as Record<string, unknown> | undefined;
      // 時間區間只認非 negate 的情形；must_not 的時間範圍語意是「排除這段」，
      // 塞進 Discover 的時間選擇器會變成完全相反的意思，故留給 custom filter。
      if (range && timeField in range && !negate) {
        const r = range[timeField] as Record<string, unknown>;
        const lo = r.gte ?? r.gt;
        const hi = r.lte ?? r.lt;
        if (lo !== undefined) from = String(lo);
        if (hi !== undefined) to = String(hi);
        hasTime = true;
        continue;
      }

      const term = clause.term as Record<string, unknown> | undefined;
      if (term && Object.keys(term).length === 1) {
        const [k, v] = Object.entries(term)[0];
        const val = scalar(v, "value");
        if (val !== null) {
          // .keyword 是索引層的子欄位；Discover 的 pill 顯示主欄位名較易讀，
          // 但底下的 match_phrase 仍打在原欄位，語意不變。
          phrases.push({ field: k.replace(/\.keyword$/, ""), value: val, negate });
          continue;
        }
      }

      const mp = clause.match_phrase as Record<string, unknown> | undefined;
      if (mp && Object.keys(mp).length === 1) {
        const [k, v] = Object.entries(mp)[0];
        const val = scalar(v, "query");
        if (val !== null) {
          phrases.push({ field: k, value: val, negate });
          continue;
        }
      }

      const bool = clause.bool as Record<string, unknown> | undefined;
      if (bool) {
        const before = leftovers.length;
        const keys = Object.keys(bool);
        // 只拆「純粹是 filter/must/must_not 組合」的 bool；帶 should / minimum_should_match
        // 的語意是 OR，拆成獨立 pill（AND）會改變結果，整包留給 custom filter。
        if (keys.every((k) => k === "filter" || k === "must" || k === "must_not")) {
          walk(bool.filter, negate);
          walk(bool.must, negate);
          walk(bool.must_not, !negate);
          if (leftovers.length === before) continue;
          // 子句有部分轉不掉時，上面已把轉得掉的收走、轉不掉的進 leftovers，不重複收整包。
          continue;
        }
      }

      leftovers.push(negate ? { bool: { must_not: [clause] } } : clause);
    }
  };

  const query = dsl.query as Record<string, unknown> | undefined;
  const bool = query?.bool as Record<string, unknown> | undefined;
  if (bool) {
    const keys = Object.keys(bool);
    if (keys.every((k) => k === "filter" || k === "must" || k === "must_not")) {
      walk(bool.filter, false);
      walk(bool.must, false);
      walk(bool.must_not, true);
    } else if (query) {
      leftovers.push(query);
    }
  } else if (query && Object.keys(query).length > 0 && !("match_all" in query)) {
    leftovers.push(query);
  }

  return { from, to, phrases, leftovers, hasTime };
}

/** Discover 的 filter 物件（phrase pill）。 */
function phrasePill(f: PhraseFilter, dataViewId: string) {
  return {
    $state: { store: "appState" },
    meta: {
      alias: null,
      disabled: false,
      index: dataViewId,
      key: f.field,
      negate: f.negate,
      params: { query: f.value },
      type: "phrase",
    },
    query: { match_phrase: { [f.field]: f.value } },
  };
}

/** 轉不掉的子句：包成 Kibana 的 custom DSL filter，條件不遺失。 */
function customPill(clauses: unknown[], dataViewId: string) {
  const query = clauses.length === 1 ? clauses[0] : { bool: { filter: clauses } };
  return {
    $state: { store: "appState" },
    meta: {
      alias: "db-kit: raw DSL",
      disabled: false,
      index: dataViewId,
      negate: false,
      type: "custom",
    },
    query,
  };
}

/** 產生 Kibana Discover 連結。 */
export function buildDiscoverUrl(opts: KibanaLinkOpts): string {
  const timeField = opts.timeField?.trim() || "@timestamp";
  const { from, to, phrases, leftovers } = collect(opts.dsl, timeField);

  const filters: unknown[] = phrases.map((f) => phrasePill(f, opts.dataViewId));
  if (leftovers.length > 0) filters.push(customPill(leftovers, opts.dataViewId));

  const _g = {
    filters: [],
    refreshInterval: { pause: true, value: 0 },
    time: { from, to },
  };

  // 顯示欄位取自 _source；時間欄位不列（Discover 本來就固定有時間欄）。
  // 沒指定就留空 → Discover 顯示 _source 摘要，這是通用且不會猜錯的預設。
  const source = Array.isArray(opts.dsl._source) ? (opts.dsl._source as unknown[]) : [];
  const columns = source.filter((c): c is string => typeof c === "string" && c !== timeField);

  const _a = {
    columns,
    filters,
    index: opts.dataViewId,
    interval: "auto",
    query: { language: "kuery", query: "" },
    sort: [[timeField, "desc"]],
  };

  const base = opts.kibanaUrl.trim().replace(/\/+$/, "");
  return `${base}/app/discover#/?_g=${encodeRison(_g)}&_a=${encodeRison(_a)}`;
}

/** 這份 DSL 有幾個子句無法轉成原生 pill（UI 據此提示使用者連結含原始 DSL filter）。 */
export function countRawClauses(dsl: Record<string, unknown>, timeField = "@timestamp"): number {
  return collect(dsl, timeField).leftovers.length;
}
