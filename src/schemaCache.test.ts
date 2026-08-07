import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "./api";
import {
  fmtBytes,
  isStale,
  mergeCachedSchema,
  sameTables,
  sanitizeCachedSchema,
  schemaCacheAllowed,
  shouldCacheKind,
  STALE_DAYS,
  toSqlNamespace,
} from "./schemaCache";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-07T12:00:00Z");

function conn(options: Record<string, string>): ConnectionConfig {
  return {
    id: "c1",
    name: "c1",
    kind: "mysql",
    host: "h",
    port: 3306,
    username: "u",
    password: "",
    database: null,
    options,
  } as ConnectionConfig;
}

describe("shouldCacheKind", () => {
  it("接受有欄位結構的關聯式種類", () => {
    for (const k of ["mysql", "mariadb", "postgres", "sqlite", "oracle", "external"] as const) {
      expect(shouldCacheKind(k)).toBe(true);
    }
  });

  // 這是政策測試，不是實作細節測試：它存在的目的是擋住「順手把十一種引擎都做進去」，
  // 那只會產生一份塞滿過期 Redis 鍵名前綴的快取。
  it("拒絕沒有欄位結構的種類", () => {
    for (const k of ["mongo", "redis", "kafka", "elastic", "rabbitmq"] as const) {
      expect(shouldCacheKind(k)).toBe(false);
    }
  });

  it("undefined 視為不快取", () => {
    expect(shouldCacheKind(undefined)).toBe(false);
  });
});

describe("isStale", () => {
  it("剛更新的不算過期", () => {
    expect(isStale(NOW - 60_000, NOW)).toBe(false);
  });

  it("門檻邊界：剛好未滿天數不算過期，超過就算", () => {
    expect(isStale(NOW - STALE_DAYS * DAY + 1000, NOW)).toBe(false);
    expect(isStale(NOW - STALE_DAYS * DAY - 1000, NOW)).toBe(true);
  });

  it("沒有時間資訊一律當成過期", () => {
    expect(isStale(0, NOW)).toBe(true);
    expect(isStale(-1, NOW)).toBe(true);
    expect(isStale(NaN, NOW)).toBe(true);
  });

  it("未來時間也當成過期（時鐘不對，別假裝新鮮）", () => {
    expect(isStale(NOW + DAY, NOW)).toBe(true);
  });

  it("天數可調", () => {
    expect(isStale(NOW - 2 * DAY, NOW, 1)).toBe(true);
    expect(isStale(NOW - 2 * DAY, NOW, 30)).toBe(false);
  });
});

describe("schemaCacheAllowed", () => {
  it("非正式環境一律允許", () => {
    expect(schemaCacheAllowed(conn({}))).toBe(true);
  });

  it("正式環境預設不允許", () => {
    expect(schemaCacheAllowed(conn({ prod: "1" }))).toBe(false);
  });

  it("正式環境明確開啟後允許", () => {
    expect(schemaCacheAllowed(conn({ prod: "1", schema_cache: "on" }))).toBe(true);
  });

  it("沒有連線設定時不允許", () => {
    expect(schemaCacheAllowed(undefined)).toBe(false);
  });
});

describe("toSqlNamespace", () => {
  it("表名對應欄名清單", () => {
    const ns = toSqlNamespace([
      { table: "orders", columns: ["id", "total"] },
      { table: "users", columns: ["id", "email"] },
    ]);
    expect(ns).toEqual({ orders: ["id", "total"], users: ["id", "email"] });
  });

  // 「表名補得到、欄名還沒載好」是刻意保留的中間狀態，不能把這種表濾掉。
  it("沒有欄位的表仍要在 namespace 裡（否則 FROM 補不到）", () => {
    const ns = toSqlNamespace([{ table: "empty_yet", columns: [] }]);
    expect(ns).toEqual({ empty_yet: [] });
  });

  it("undefined / 空陣列回空 namespace", () => {
    expect(toSqlNamespace(undefined)).toEqual({});
    expect(toSqlNamespace([])).toEqual({});
  });

  it("略過壞掉的項目而不是整批爆掉", () => {
    const ns = toSqlNamespace([
      { table: "ok", columns: ["a"] },
      null as never,
      { table: "", columns: ["x"] } as never,
      { table: "loose", columns: ["a", 3 as never, null as never] },
    ]);
    expect(ns).toEqual({ ok: ["a"], loose: ["a"] });
  });
});

describe("sanitizeCachedSchema", () => {
  it("正常物件原樣通過", () => {
    const got = sanitizeCachedSchema({
      database: "shop",
      updated_at_ms: 123,
      tables: [{ table: "t", columns: ["a"] }],
    });
    expect(got).toEqual({ database: "shop", updated_at_ms: 123, tables: [{ table: "t", columns: ["a"] }] });
  });

  it("null / 非物件 / 缺 database 回 null", () => {
    expect(sanitizeCachedSchema(null)).toBeNull();
    expect(sanitizeCachedSchema("nope")).toBeNull();
    expect(sanitizeCachedSchema({ tables: [] })).toBeNull();
  });

  it("tables 不是陣列時退成空陣列", () => {
    expect(sanitizeCachedSchema({ database: "d", tables: "x" })?.tables).toEqual([]);
  });

  it("時間欄位壞掉時歸零（於是 isStale 會判過期）", () => {
    expect(sanitizeCachedSchema({ database: "d", updated_at_ms: "yesterday" })?.updated_at_ms).toBe(0);
    expect(sanitizeCachedSchema({ database: "d", updated_at_ms: Infinity })?.updated_at_ms).toBe(0);
  });
});

describe("mergeCachedSchema", () => {
  const good = { database: "d", updated_at_ms: 100, tables: [{ table: "t", columns: ["a"] }] };
  const empty = { database: "d", updated_at_ms: 200, tables: [] };

  it("有新資料就用新的", () => {
    const next = { database: "d", updated_at_ms: 300, tables: [{ table: "t", columns: ["a", "b"] }] };
    expect(mergeCachedSchema(good, next)).toBe(next);
  });

  // 刷新失敗常表現為「成功回傳 0 張表」；照單全收會把好用的提示清成空白。
  it("空的不覆蓋非空的", () => {
    expect(mergeCachedSchema(good, empty)).toBe(good);
  });

  it("本來就是空的話，空的可以進來", () => {
    expect(mergeCachedSchema(null, empty)).toBe(empty);
  });

  it("next 為 null 時保留舊的", () => {
    expect(mergeCachedSchema(good, null)).toBe(good);
  });
});

describe("sameTables", () => {
  it("內容相同視為相同（即使是不同物件）", () => {
    const a = [{ table: "t", columns: ["a", "b"] }];
    const b = [{ table: "t", columns: ["a", "b"] }];
    expect(sameTables(a, b)).toBe(true);
  });

  it("表數 / 表名 / 欄數 / 欄名任一不同就不同", () => {
    const base = [{ table: "t", columns: ["a"] }];
    expect(sameTables(base, [])).toBe(false);
    expect(sameTables(base, [{ table: "u", columns: ["a"] }])).toBe(false);
    expect(sameTables(base, [{ table: "t", columns: ["a", "b"] }])).toBe(false);
    expect(sameTables(base, [{ table: "t", columns: ["b"] }])).toBe(false);
  });

  it("順序敏感（欄序就是 ordinal_position，不該被當成無關）", () => {
    expect(sameTables([{ table: "t", columns: ["a", "b"] }], [{ table: "t", columns: ["b", "a"] }])).toBe(false);
  });

  it("undefined 只與自己相同", () => {
    expect(sameTables(undefined, undefined)).toBe(true);
    expect(sameTables(undefined, [])).toBe(false);
  });
});

describe("fmtBytes", () => {
  it("分級顯示", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("負數 / NaN 不產生亂碼", () => {
    expect(fmtBytes(-1)).toBe("0 B");
    expect(fmtBytes(NaN)).toBe("0 B");
  });
});
