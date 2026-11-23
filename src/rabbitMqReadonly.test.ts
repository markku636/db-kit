import { describe, expect, it } from "vitest";
import { resolvePeekRequeue } from "./rabbitMqReadonly";

describe("resolvePeekRequeue", () => {
  it("唯讀連線即使取消勾選也強制重新入列（取消 requeue = 刪除訊息）", () => {
    expect(resolvePeekRequeue(true, false)).toBe(true);
    expect(resolvePeekRequeue(true, true)).toBe(true);
  });

  it("一般連線尊重使用者的 requeue 選擇", () => {
    expect(resolvePeekRequeue(false, true)).toBe(true);
    expect(resolvePeekRequeue(false, false)).toBe(false);
  });
});
