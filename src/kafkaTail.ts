// Kafka live-tail 的前端過濾守門。後端每連線只有一個 tail 串流，
// 面板必須自己擋掉別的連線／主題／分區，否則切換下拉後會看到不相干的訊息。
import type { KafkaMessage } from "./api";

/** 這則 tail 訊息是否屬於目前面板。partition=null 表示「全部分區」。 */
export function matchesTailMessage(
  m: KafkaMessage,
  connId: string,
  topic: string,
  partition: number | null,
): boolean {
  return m.conn_id === connId
    && m.topic === topic
    && (partition === null || m.partition === partition);
}
