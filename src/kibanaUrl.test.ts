import { describe, expect, it } from "vitest";
import { buildDiscoverUrl, countRawClauses, encodeRison, rison } from "./kibanaUrl";

const BASE = { kibanaUrl: "https://kibana.example.com", dataViewId: "dv-1" };

/** 從產生的網址取回 _a / _g 的 rison 原文，供斷言。 */
const parts = (url: string) => {
  const q = url.slice(url.indexOf("#/?") + 3);
  const g = /_g=([^&]*)/.exec(q)?.[1] ?? "";
  const a = /_a=(.*)$/.exec(q)?.[1] ?? "";
  return { g: decodeURIComponent(g), a: decodeURIComponent(a) };
};

describe("rison", () => {
  it("純量與識別字", () => {
    expect(rison(true)).toBe("!t");
    expect(rison(false)).toBe("!f");
    expect(rison(null)).toBe("!n");
    expect(rison(42)).toBe("42");
    expect(rison("@timestamp")).toBe("'@timestamp'"); // @ 不是 bare id 開頭字元
    expect(rison("MessageTemplate")).toBe("MessageTemplate");
  });

  it("需要引號的字串會跳脫 ! 與 '", () => {
    expect(rison("a b")).toBe("'a b'");
    expect(rison("it's")).toBe("'it!'s'");
    expect(rison("bang!")).toBe("'bang!!'");
  });

  it("陣列與物件", () => {
    expect(rison([1, "a", true])).toBe("!(1,a,!t)");
    expect(rison({ from: "now-15m", to: "now" })).toBe("(from:now-15m,to:now)");
  });

  it("undefined 值的鍵略過，不寫成 !n", () => {
    expect(rison({ a: 1, b: undefined })).toBe("(a:1)");
  });

  it("URL 編碼保留 rison 結構字元", () => {
    // 括號 / 冒號 / 驚嘆號 / 單引號不可被編碼，否則 Kibana 解不開
    expect(encodeRison({ time: { from: "now-15m" } })).toBe("(time:(from:now-15m))");
    // 空白等一般字元仍要編碼
    expect(encodeRison("a b")).toBe("'a%20b'");
  });
});

describe("buildDiscoverUrl", () => {
  it("時間欄位的 range 變成 Discover 時間區間", () => {
    const url = buildDiscoverUrl({
      ...BASE,
      dsl: { query: { bool: { filter: [{ range: { "@timestamp": { gte: "now-1h", lte: "now" } } }] } } },
    });
    expect(parts(url).g).toContain("time:(from:now-1h,to:now)");
  });

  it("沒有時間條件時給預設區間，不是空的", () => {
    const url = buildDiscoverUrl({ ...BASE, dsl: { query: { match_all: {} } } });
    expect(parts(url).g).toContain("time:(from:now-15m,to:now)");
  });

  it("term / match_phrase 變成 phrase filter，.keyword 後綴在顯示名去掉", () => {
    const url = buildDiscoverUrl({
      ...BASE,
      dsl: {
        query: {
          bool: {
            filter: [
              { term: { "Level.keyword": "Error" } },
              { match_phrase: { MessageTemplate: "boom" } },
            ],
          },
        },
      },
    });
    const { a } = parts(url);
    expect(a).toContain("key:Level");
    expect(a).toContain("key:MessageTemplate");
    expect(a).toContain("type:phrase");
    expect(a).not.toContain("type:custom");
  });

  it("must_not 的 term 變成 negate 的 pill", () => {
    const url = buildDiscoverUrl({
      ...BASE,
      dsl: { query: { bool: { must_not: [{ term: { Level: "Debug" } }] } } },
    });
    expect(parts(url).a).toContain("negate:!t");
  });

  it("_source 成為顯示欄位，時間欄位不重複列入", () => {
    const url = buildDiscoverUrl({
      ...BASE,
      dsl: { _source: ["@timestamp", "MessageTemplate", "TraceId"] },
    });
    expect(parts(url).a).toContain("columns:!(MessageTemplate,TraceId)");
  });

  it("沒給 _source 時欄位留空（Discover 顯示 _source 摘要）", () => {
    expect(parts(buildDiscoverUrl({ ...BASE, dsl: {} })).a).toContain("columns:!()");
  });

  it("時間欄位可自訂", () => {
    const url = buildDiscoverUrl({
      ...BASE,
      timeField: "event_time",
      dsl: { query: { bool: { filter: [{ range: { event_time: { gte: "now-2d" } } }] } } },
    });
    const { g, a } = parts(url);
    expect(g).toContain("from:now-2d");
    expect(a).toContain("sort:!(!(event_time,desc))");
  });

  it("結尾斜線不會產生雙斜線", () => {
    const url = buildDiscoverUrl({ ...BASE, kibanaUrl: "https://kibana.example.com//", dsl: {} });
    expect(url.startsWith("https://kibana.example.com/app/discover#/?")).toBe(true);
  });
});

// 這組是本模組最重要的保證：連結打開後的結果集必須與原查詢等價。
// 轉不成原生 pill 的條件若被靜默丟掉，使用者會拿到一個「看起來對、其實少條件」的網址。
describe("不遺失查詢條件", () => {
  it("wildcard 這類無對應元件的子句包成 custom DSL filter", () => {
    const dsl = { query: { bool: { filter: [{ wildcard: { path: "/api/*" } }] } } };
    const { a } = parts(buildDiscoverUrl({ ...BASE, dsl }));
    expect(a).toContain("type:custom");
    expect(a).toContain("wildcard");
    expect(countRawClauses(dsl)).toBe(1);
  });

  it("should（OR 語意）整包保留，不拆成多個 AND pill", () => {
    const dsl = {
      query: { bool: { should: [{ term: { a: 1 } }, { term: { b: 2 } }], minimum_should_match: 1 } },
    };
    const { a } = parts(buildDiscoverUrl({ ...BASE, dsl }));
    expect(a).toContain("type:custom");
    expect(a).toContain("should");
    expect(a).not.toContain("type:phrase");
  });

  it("可轉與不可轉混在一起：各自歸位，總數不減", () => {
    const dsl = {
      query: {
        bool: {
          filter: [
            { range: { "@timestamp": { gte: "now-1h" } } },
            { term: { Level: "Error" } },
            { wildcard: { path: "/api/*" } },
          ],
        },
      },
    };
    const { g, a } = parts(buildDiscoverUrl({ ...BASE, dsl }));
    expect(g).toContain("from:now-1h");
    expect(a).toContain("type:phrase");
    expect(a).toContain("type:custom");
    expect(countRawClauses(dsl)).toBe(1);
  });

  it("must_not 的時間範圍不當成時間選擇器（語意相反），改走 custom filter", () => {
    const dsl = { query: { bool: { must_not: [{ range: { "@timestamp": { gte: "now-1h" } } }] } } };
    const { g, a } = parts(buildDiscoverUrl({ ...BASE, dsl }));
    expect(g).toContain("time:(from:now-15m,to:now)"); // 維持預設，未被誤用
    expect(a).toContain("type:custom");
    expect(a).toContain("must_not");
  });

  it("term 值是複雜物件（非純量）時不硬轉成 pill", () => {
    const dsl = { query: { bool: { filter: [{ term: { f: { value: { nested: 1 } } } }] } } };
    expect(countRawClauses(dsl)).toBe(1);
  });

  it("完全沒有 query 就不產生任何 filter", () => {
    expect(parts(buildDiscoverUrl({ ...BASE, dsl: {} })).a).toContain("filters:!()");
    expect(countRawClauses({})).toBe(0);
  });
});
