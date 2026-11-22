import { describe, it, expect } from "vitest";
import { pubSubErrorForConn } from "./pubSubFormat";

describe("pubSubErrorForConn", () => {
  it("只收自己這條連線的錯誤，並去掉 connId 前綴", () => {
    expect(pubSubErrorForConn("conn-a: connection refused", "conn-a")).toBe("connection refused");
    expect(pubSubErrorForConn("conn-b: subscribe news 失敗", "conn-b")).toBe("subscribe news 失敗");
  });
  it("別的連線的錯誤不該出現在這個面板", () => {
    expect(pubSubErrorForConn("conn-b: boom", "conn-a")).toBeNull();
  });
  it("連線 id 是另一個 id 的前綴時也不會誤收", () => {
    expect(pubSubErrorForConn("ab: boom", "a")).toBeNull();
    expect(pubSubErrorForConn("a-longer-id: boom", "a")).toBeNull();
  });
});
