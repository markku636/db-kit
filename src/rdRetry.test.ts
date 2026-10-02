import { describe, expect, it } from "vitest";
import { isRetryableClose, MAX_RETRY_DELAY, nextRetryDelay } from "./rdRetry";

describe("rdRetry", () => {
  it("對方那邊斷的才自動重連（官方 check_if_retry）", () => {
    expect(isRetryableClose("remote closed the connection")).toBe(true);
    expect(isRetryableClose("Connection reset by peer (os error 10054)")).toBe(true);
    expect(isRetryableClose("RustDesk 連線元件意外結束")).toBe(true);
    expect(isRetryableClose("Closed manually by the peer")).toBe(false);
    expect(isRetryableClose("Connection not allowed")).toBe(false);
    expect(isRetryableClose("Remote desktop is offline")).toBe(false);
    expect(isRetryableClose(null)).toBe(false); // 使用者自己斷的
    expect(isRetryableClose("")).toBe(false);
  });

  it("等待時間 1、2、4… 加倍，最多 30 秒", () => {
    const seq: number[] = [];
    let d = 0;
    for (let i = 0; i < 8; i++) seq.push((d = nextRetryDelay(d)));
    expect(seq).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
    expect(Math.max(...seq)).toBe(MAX_RETRY_DELAY);
  });
});
