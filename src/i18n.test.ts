import { describe, it, expect, beforeEach, vi } from "vitest";

// vitest 在 node 環境跑（本專案無 jsdom），先補一個 in-memory localStorage 再 import 受測模組
// —— i18n.ts 的 useLang 初始化會在 import 期讀取它。
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.get(k) ?? null; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  removeItem(k: string) { this.map.delete(k); }
  setItem(k: string, v: string) { this.map.set(k, v); }
}
vi.stubGlobal("localStorage", new MemoryStorage());

const { interpolate, readStoredLang, t, useLang } = await import("./i18n");
type Catalog = import("./i18n").Catalog;

// 直接塞 catalog，不走 dynamic import —— 這些測試驗的是 t() 的解析規則，不是 vite 的 chunk 載入。
function setCatalog(catalog: Catalog, lang: "zh-TW" | "en" = "en") {
  useLang.setState({ lang, catalog });
}

beforeEach(() => {
  localStorage.clear();
  setCatalog({}, "zh-TW");
});

describe("interpolate", () => {
  it("以 {name} 取代同名參數", () => {
    expect(interpolate("已匯出 {n} 列", { n: 3 })).toBe("已匯出 3 列");
    expect(interpolate("{a} 到 {b}", { a: "A", b: "B" })).toBe("A 到 B");
  });

  it("無對應參數時原樣保留佔位符（寧可露出 {x} 也不要靜默吃掉）", () => {
    expect(interpolate("缺 {x}", { y: 1 })).toBe("缺 {x}");
  });

  it("無參數時原樣回傳", () => {
    expect(interpolate("純文字")).toBe("純文字");
  });
});

describe("t — identity fallback", () => {
  it("zh-TW 下回傳原文（catalog 恆空）", () => {
    expect(t("連線")).toBe("連線");
  });

  it("en 下查無 key 時回傳原文，而非空字串或佔位符", () => {
    setCatalog({ 連線: "Connect" });
    expect(t("尚未翻譯的字串")).toBe("尚未翻譯的字串");
  });

  it("這正是「未遷移的檔案照常渲染中文」與「既有測試零修改」的依據", () => {
    setCatalog({}, "zh-TW");
    expect(t("帳號或密碼錯誤（MySQL 1045）")).toBe("帳號或密碼錯誤（MySQL 1045）");
  });
});

describe("t — 查表與插值", () => {
  it("命中 catalog 時回傳譯文", () => {
    setCatalog({ 連線: "Connect" });
    expect(t("連線")).toBe("Connect");
  });

  it("譯文中的佔位符同樣被插值", () => {
    setCatalog({ "已匯出 {n} 列": "Exported {n} rows" });
    expect(t("已匯出 {n} 列", { n: 12 })).toBe("Exported 12 rows");
  });

  it("zh-TW 下未命中也會插值原文", () => {
    setCatalog({}, "zh-TW");
    expect(t("已匯出 {n} 列", { n: 12 })).toBe("已匯出 12 列");
  });
});

describe("t — 單複數", () => {
  const catalog: Catalog = {
    "{m} 分鐘前": { one: "{m} minute ago", other: "{m} minutes ago" },
  };

  it("n === 1 取 one", () => {
    setCatalog(catalog);
    expect(t("{m} 分鐘前", { n: 1, m: 1 })).toBe("1 minute ago");
  });

  it("其餘取 other（含 0 與負數）", () => {
    setCatalog(catalog);
    expect(t("{m} 分鐘前", { n: 5, m: 5 })).toBe("5 minutes ago");
    expect(t("{m} 分鐘前", { n: 0, m: 0 })).toBe("0 minutes ago");
  });

  it("未傳 n 時退回 other（中文無複數，本來就只有一種寫法）", () => {
    setCatalog(catalog);
    expect(t("{m} 分鐘前", { m: 3 })).toBe("3 minutes ago");
  });
});

describe("readStoredLang", () => {
  it("無設定時預設 zh-TW（既有使用者升級後不會突然變英文）", () => {
    expect(readStoredLang()).toBe("zh-TW");
  });

  it("讀得到已存的合法語言", () => {
    localStorage.setItem("dbkit:lang", "en");
    expect(readStoredLang()).toBe("en");
  });

  it("不合法值退回 zh-TW", () => {
    localStorage.setItem("dbkit:lang", "klingon");
    expect(readStoredLang()).toBe("zh-TW");
  });

  it("localStorage 拋錯時退回 zh-TW", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    expect(readStoredLang()).toBe("zh-TW");
    spy.mockRestore();
  });
});
