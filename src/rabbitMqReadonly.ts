// RabbitMQ 訊息瀏覽（basic.get）的唯讀守門。
// requeue=false 會把取出的訊息永久移出佇列——即使唯讀連線也不允許，
// 前端強制 requeue=true，後端 rabbitmq_peek 也再做一層把關。

/** 唯讀連線永遠重新入列；一般連線尊重使用者的選擇。 */
export function resolvePeekRequeue(readonly: boolean, userRequeue: boolean): boolean {
  return readonly || userRequeue;
}
