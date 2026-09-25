import { describe, it, expect } from "vitest";
import { isSshTabKey, newSshTabKey, tabOrder, landingKey, neighborSshKey, SSH_TAB_PREFIX } from "./sshTabs";

const T = (key: string) => ({ key });

describe("isSshTabKey / newSshTabKey", () => {
  it("只認得帶前綴且非空尾碼的鍵", () => {
    expect(isSshTabKey(newSshTabKey())).toBe(true);
    expect(isSshTabKey(SSH_TAB_PREFIX)).toBe(false);
    expect(isSshTabKey("__query__")).toBe(false);
    expect(isSshTabKey("c1:db:t")).toBe(false);
    expect(isSshTabKey(null)).toBe(false);
  });

  it("每次產生的鍵都不同（同一台主機可開多個分頁）", () => {
    expect(newSshTabKey()).not.toBe(newSshTabKey());
  });
});

describe("tabOrder", () => {
  it("表 → 查詢 → SSH", () => {
    expect(tabOrder([T("a"), T("b")], ["__query__"], [T("__ssh__:1")])).toEqual(["a", "b", "__query__", "__ssh__:1"]);
  });
});

describe("landingKey", () => {
  it("preferred 仍存在（任一種分頁）就留在原地", () => {
    expect(landingKey([T("a")], ["__query__"], [T("__ssh__:1")], "__ssh__:1")).toBe("__ssh__:1");
    expect(landingKey([T("a")], ["__query__"], [T("__ssh__:1")], "__query__")).toBe("__query__");
    expect(landingKey([T("a")], ["__query__"], [T("__ssh__:1")], "a")).toBe("a");
  });

  it("退位順序：最後一個表分頁 → 第一個查詢分頁 → 最後一個 SSH 分頁 → null", () => {
    expect(landingKey([T("a"), T("b")], ["__query__"], [T("__ssh__:1")], "gone")).toBe("b");
    expect(landingKey([], ["__query__", "__query__:2"], [T("__ssh__:1")], "gone")).toBe("__query__");
    expect(landingKey([], [], [T("__ssh__:1"), T("__ssh__:2")], "gone")).toBe("__ssh__:2");
    expect(landingKey([], [], [], null)).toBeNull();
  });
});

describe("neighborSshKey", () => {
  const tabs = [T("__ssh__:1"), T("__ssh__:2"), T("__ssh__:3")];
  it("關中間的落到右邊那個；關最後一個落到左邊", () => {
    expect(neighborSshKey(tabs, "__ssh__:2")).toBe("__ssh__:3");
    expect(neighborSshKey(tabs, "__ssh__:3")).toBe("__ssh__:2");
    expect(neighborSshKey(tabs, "__ssh__:1")).toBe("__ssh__:2");
  });
  it("沒有其他 SSH 分頁或鍵不存在 → null", () => {
    expect(neighborSshKey([T("__ssh__:1")], "__ssh__:1")).toBeNull();
    expect(neighborSshKey(tabs, "nope")).toBeNull();
  });
});
