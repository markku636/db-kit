import { describe, expect, it } from "vitest";
import { isRetryableClose, MAX_RETRY_DELAY, nextRetryDelay, shouldAutoRetry } from "./rdRetry";

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

  it("VNC：非使用者斷線就重連，獨佔模式不重連；RDP 不重連", () => {
    expect(shouldAutoRetry("vnc", "遠端主機關閉了連線", true)).toBe(true);
    expect(shouldAutoRetry("vnc", "Connection lost: connection reset", true)).toBe(true);
    expect(shouldAutoRetry("vnc", null, true)).toBe(false);
    expect(shouldAutoRetry("vnc", "遠端主機關閉了連線", false)).toBe(false);
    expect(shouldAutoRetry("rustdesk", "Closed manually by the peer", true)).toBe(false);
    expect(shouldAutoRetry("rustdesk", "remote closed the connection", false)).toBe(true);
    expect(shouldAutoRetry("rdp", "connection reset", true)).toBe(false);
  });

  it("等待時間 1、2、4… 加倍，最多 30 秒", () => {
    const seq: number[] = [];
    let d = 0;
    for (let i = 0; i < 8; i++) seq.push((d = nextRetryDelay(d)));
    expect(seq).toEqual([1, 2, 4, 8, 16, 30, 30, 30]);
    expect(Math.max(...seq)).toBe(MAX_RETRY_DELAY);
  });
});
