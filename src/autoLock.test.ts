import { describe, expect, it } from "vitest";

import { isIdle } from "./autoLock";

const MIN = 60_000;

describe("isIdle", () => {
  it("尚未到期不鎖", () => {
    expect(isIdle(0, 4 * MIN, 5)).toBe(false);
  });

  it("剛好到期就鎖（>= 而非 >）", () => {
    expect(isIdle(0, 5 * MIN, 5)).toBe(true);
  });

  it("超過門檻鎖", () => {
    expect(isIdle(0, 6 * MIN, 5)).toBe(true);
  });

  // 這是用 wall-clock 而非 setTimeout 的理由：闔蓋兩小時回來必須算閒置。
  // 若改用 timer，休眠期間 timer 不前進，回來反而還沒到期。
  it("休眠兩小時後回來一定算閒置", () => {
    expect(isIdle(0, 120 * MIN, 30)).toBe(true);
  });

  it("minutes 為 0 表示關閉，永遠不鎖", () => {
    expect(isIdle(0, 999 * MIN, 0)).toBe(false);
  });

  it("負數 / NaN 一律當成關閉，不要意外鎖死使用者", () => {
    expect(isIdle(0, 999 * MIN, -5)).toBe(false);
    expect(isIdle(0, 999 * MIN, Number.NaN)).toBe(false);
  });
});
