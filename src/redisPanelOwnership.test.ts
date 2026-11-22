import { describe, it, expect } from "vitest";
import { acquireRedisPanel, hasOtherRedisPanel, releaseRedisPanel } from "./redisPanelOwnership";

describe("redisPanelOwnership", () => {
  it("同一連線開兩個面板，關掉一個不會停掉後端任務", () => {
    const conn = `c-${Math.random()}`;
    const a = `a-${Math.random()}`;
    const b = `b-${Math.random()}`;
    expect(acquireRedisPanel(conn, a)).toBe(1);
    expect(acquireRedisPanel(conn, b)).toBe(2);
    expect(hasOtherRedisPanel(conn, a)).toBe(true); // explicit stop 不該停掉共用任務
    expect(releaseRedisPanel(conn, a)).toBe(1); // 不能 stop
    expect(releaseRedisPanel(conn, b)).toBe(0); // 最後一個關掉才 stop
  });
  it("Pub/Sub 與 MONITOR 是不同的後端任務，不能互相算成別的面板", () => {
    const conn = `c-${Math.random()}`;
    expect(acquireRedisPanel(`pubsub:${conn}`, "p")).toBe(1);
    expect(hasOtherRedisPanel(`monitor:${conn}`, "m")).toBe(false);
    expect(acquireRedisPanel(`monitor:${conn}`, "m")).toBe(1);
    expect(releaseRedisPanel(`pubsub:${conn}`, "p")).toBe(0);
  });

  it("不同連線各自獨立", () => {
    const c1 = `c1-${Math.random()}`;
    const c2 = `c2-${Math.random()}`;
    expect(acquireRedisPanel(c1, "x")).toBe(1);
    expect(acquireRedisPanel(c2, "x")).toBe(1);
    expect(releaseRedisPanel(c1, "x")).toBe(0);
  });
});
