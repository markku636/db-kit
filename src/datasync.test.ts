import { describe, it, expect } from "vitest";
import { diffRowsByPk, buildSyncDml, type RowSet } from "./datasync";

const src: RowSet = {
  columns: ["id", "name", "qty"],
  pk: ["id"],
  rows: [
    ["1", "apple", "5"],   // 兩邊都有、值同 → 不變
    ["2", "banana", "9"],  // 兩邊都有、qty 不同 → UPDATE
    ["3", "cherry", "1"],  // 目標沒有 → INSERT
  ],
};
const dst: RowSet = {
  columns: ["id", "name", "qty"],
  pk: ["id"],
  rows: [
    ["1", "apple", "5"],
    ["2", "banana", "7"],  // qty 不同
    ["9", "old", "0"],     // 來源沒有 → DELETE
  ],
};

describe("diffRowsByPk", () => {
  it("分類 INSERT / UPDATE / DELETE", () => {
    const d = diffRowsByPk(src, dst);
    expect(d.inserts).toEqual([["3", "cherry", "1"]]);
    expect(d.updates).toEqual([["2", "banana", "9"]]);
    expect(d.deletes).toEqual([["9"]]); // 主鍵值元組
  });
  it("無主鍵 → 丟錯", () => {
    expect(() => diffRowsByPk({ ...src, pk: [] }, dst)).toThrow();
  });
  it("複合主鍵不串接碰撞（[1,2] 與 [12,''] 視為不同列）", () => {
    const cols = ["a", "b", "v"];
    const s = { columns: cols, pk: ["a", "b"], rows: [["1", "2", "x"], ["12", "", "y"]] };
    const t = { columns: cols, pk: ["a", "b"], rows: [["1", "2", "x"], ["12", "", "y"]] };
    const d = diffRowsByPk(s, t);
    // 兩列在兩邊都精確配對 → 無新增 / 更新 / 刪除（若鍵碰撞會誤判）。
    expect(d.inserts).toEqual([]);
    expect(d.updates).toEqual([]);
    expect(d.deletes).toEqual([]);
  });
  it("NULL 主鍵值正確配對（不誤判為新增）", () => {
    const s: RowSet = { columns: ["k", "v"], pk: ["k"], rows: [[null, "a"]] };
    const t: RowSet = { columns: ["k", "v"], pk: ["k"], rows: [[null, "a"]] };
    const d = diffRowsByPk(s, t);
    expect(d.inserts).toEqual([]);
    expect(d.updates).toEqual([]);
    expect(d.deletes).toEqual([]);
  });
});

describe("buildSyncDml", () => {
  it("產生 INSERT / UPDATE / DELETE（identifier / 值跳脫，方言感知）", () => {
    const d = diffRowsByPk(src, dst);
    const sql = buildSyncDml("mysql", "shop", "fruit", src, d, true);
    expect(sql).toContain("INSERT INTO `shop`.`fruit` (`id`, `name`, `qty`) VALUES ('3', 'cherry', '1');");
    expect(sql).toContain("UPDATE `shop`.`fruit` SET `name` = 'banana', `qty` = '9' WHERE `id` = '2';");
    expect(sql).toContain("DELETE FROM `shop`.`fruit` WHERE `id` = '9';");
  });
  it("includeDeletes=false 時不產生 DELETE", () => {
    const d = diffRowsByPk(src, dst);
    const sql = buildSyncDml("mysql", "shop", "fruit", src, d, false);
    expect(sql).not.toContain("DELETE");
  });
  it("targetColumns 限定：只同步交集欄位（目標缺 qty → INSERT/UPDATE 不含 qty）", () => {
    const d = diffRowsByPk(src, dst);
    // 目標只有 id, name（無 qty）。
    const sql = buildSyncDml("mysql", "shop", "fruit", src, d, true, ["id", "name"]);
    expect(sql).toContain("INSERT INTO `shop`.`fruit` (`id`, `name`) VALUES ('3', 'cherry');");
    expect(sql).toContain("UPDATE `shop`.`fruit` SET `name` = 'banana' WHERE `id` = '2';");
    expect(sql).not.toContain("qty");
  });
});
