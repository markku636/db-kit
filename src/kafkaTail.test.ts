import { describe, expect, it } from "vitest";
import { matchesTailMessage } from "./kafkaTail";
import type { KafkaMessage } from "./api";

const msg = (over: Partial<KafkaMessage> = {}): KafkaMessage => ({
  conn_id: "conn-a", topic: "orders", partition: 0, offset: 1, timestamp: 123,
  key: null, value: null, headers: [], key_encoding: "string", value_encoding: "string",
  value_bytes: 0, truncated: false, ...over,
});

describe("matchesTailMessage", () => {
  it("連線 / 主題 / 分區都要符合", () => {
    expect(matchesTailMessage(msg(), "conn-a", "orders", null)).toBe(true);
    expect(matchesTailMessage(msg(), "conn-a", "orders", 0)).toBe(true);
    expect(matchesTailMessage(msg(), "conn-a", "orders", 2)).toBe(false);
    expect(matchesTailMessage(msg({ partition: 2 }), "conn-a", "orders", 2)).toBe(true);
    expect(matchesTailMessage(msg({ conn_id: "conn-b" }), "conn-a", "orders", null)).toBe(false);
    expect(matchesTailMessage(msg({ topic: "events" }), "conn-a", "orders", null)).toBe(false);
  });
});
