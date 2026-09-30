import { describe, it, expect, vi } from "vitest";
import { VncChannel, type VncCloseEvent, type VncChannelIo } from "./vncChannel";

// 可手動控制完成時機的假 I/O：每次 write 記下內容並回一個還沒 resolve 的 promise。
function deferredIo() {
  const writes: { bytes: number[]; resolve: () => void; reject: (e: unknown) => void }[] = [];
  const closes: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  const io: VncChannelIo = {
    write: (bytes) =>
      new Promise<void>((resolve, reject) => {
        writes.push({ bytes: Array.from(bytes), resolve, reject });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        closes.push({ resolve, reject });
      }),
  };
  return { io, writes, closes };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const bytesOf = (...n: number[]) => new Uint8Array(n);

describe("VncChannel：noVNC 需要的介面", () => {
  it("attach 檢查的屬性都在（含原型上的 onmessage accessor）", () => {
    const ch = new VncChannel(deferredIo().io);
    for (const p of ["send", "close", "binaryType", "onerror", "onmessage", "onopen", "protocol", "readyState", "onclose"]) {
      expect(p in ch, p).toBe(true);
    }
    expect(ch.binaryType).toBe("arraybuffer");
    expect(ch.protocol).toBe("");
    expect(ch.readyState).toBe("connecting");
  });
});

describe("VncChannel：送出", () => {
  it("send 當場複製：送出後改來源，寫出去的內容不變", () => {
    const { io, writes } = deferredIo();
    const ch = new VncChannel(io);
    ch.markOpen();
    // 模擬 noVNC flush：同一塊 buffer 的視圖，送完就被下一則訊息覆蓋。
    const sQ = new Uint8Array(16);
    sQ.set([1, 2, 3]);
    ch.send(new Uint8Array(sQ.buffer, 0, 3));
    sQ.set([9, 9, 9]);
    expect(writes.map((w) => w.bytes)).toEqual([[1, 2, 3]]);
  });

  it("在途寫入期間 send 的內容也是複本", async () => {
    const { io, writes } = deferredIo();
    const ch = new VncChannel(io);
    ch.markOpen();
    ch.send(bytesOf(1));
    const sQ = new Uint8Array([4, 5]);
    ch.send(sQ);
    sQ.fill(0);
    writes[0].resolve();
    await tick();
    expect(writes[1].bytes).toEqual([4, 5]);
  });

  it("接受 ArrayBuffer", () => {
    const { io, writes } = deferredIo();
    const ch = new VncChannel(io);
    ch.markOpen();
    const ab = new Uint8Array([7, 8]).buffer;
    ch.send(ab);
    new Uint8Array(ab).fill(0);
    expect(writes[0].bytes).toEqual([7, 8]);
  });

  it("同時只有一個 write 在路上；期間的 send 併成一塊、照順序送", async () => {
    const { io, writes } = deferredIo();
    const ch = new VncChannel(io);
    ch.markOpen();
    ch.send(bytesOf(1));
    ch.send(bytesOf(2, 3));
    ch.send(bytesOf(4));
    expect(writes.length).toBe(1);
    expect(writes[0].bytes).toEqual([1]);

    writes[0].resolve();
    await tick();
    expect(writes.length).toBe(2);
    expect(writes[1].bytes).toEqual([2, 3, 4]);

    ch.send(bytesOf(5));
    await tick();
    expect(writes.length).toBe(2); // 第二個還沒完成
    writes[1].resolve();
    await tick();
    expect(writes.map((w) => w.bytes)).toEqual([[1], [2, 3, 4], [5]]);
  });

  it("空的 send 不產生寫入", () => {
    const { io, writes } = deferredIo();
    const ch = new VncChannel(io);
    ch.markOpen();
    ch.send(new Uint8Array(0));
    expect(writes.length).toBe(0);
  });

  it("寫入失敗 → onerror + onclose（不乾淨），後續 send 無效", async () => {
    const { io, writes } = deferredIo();
    const ch = new VncChannel(io);
    const events: string[] = [];
    ch.onerror = (e) => events.push(`error:${e.message}`);
    ch.onclose = (e) => events.push(`close:${e.code}:${e.wasClean}:${e.reason}`);
    ch.markOpen();
    ch.send(bytesOf(1));
    ch.send(bytesOf(2));
    writes[0].reject(new Error("pipe broken"));
    await tick();
    expect(events).toEqual(["error:pipe broken", "close:1006:false:pipe broken"]);
    expect(ch.readyState).toBe("closed");
    ch.send(bytesOf(3));
    await tick();
    expect(writes.length).toBe(1); // 待送的 [2] 被丟棄，關閉後的也不送
  });

  it("io.write 同步丟例外也當寫入失敗", async () => {
    const io: VncChannelIo = {
      write: () => {
        throw new Error("boom");
      },
      close: () => Promise.resolve(),
    };
    const ch = new VncChannel(io);
    const closed = vi.fn();
    ch.onclose = closed;
    ch.markOpen();
    expect(() => ch.send(bytesOf(1))).not.toThrow();
    await tick();
    expect(closed).toHaveBeenCalledWith(expect.objectContaining({ wasClean: false, reason: "boom" }));
  });
});

describe("VncChannel：接收", () => {
  it("open 之後直接交給 onmessage，data 是 ArrayBuffer", () => {
    const ch = new VncChannel(deferredIo().io);
    const got: ArrayBuffer[] = [];
    ch.onmessage = (e) => got.push(e.data);
    ch.markOpen();
    const ab = new Uint8Array([1, 2]).buffer;
    ch.deliver(ab);
    expect(got).toEqual([ab]);
  });

  it("open 之前到的資料先暫存，open 時在 onopen 之後照順序補送", () => {
    const ch = new VncChannel(deferredIo().io);
    const log: string[] = [];
    ch.onopen = () => log.push("open");
    ch.onmessage = (e) => log.push(`msg:${new Uint8Array(e.data)[0]}`);
    ch.deliver(new Uint8Array([1]).buffer);
    ch.deliver(new Uint8Array([2]).buffer);
    expect(log).toEqual([]);
    ch.markOpen();
    ch.deliver(new Uint8Array([3]).buffer);
    expect(log).toEqual(["open", "msg:1", "msg:2", "msg:3"]);
  });

  it("已 open 但還沒掛 onmessage（RFB 延後 attach）：掛上後在 microtask 補送", async () => {
    const ch = new VncChannel(deferredIo().io);
    ch.markOpen();
    ch.deliver(new Uint8Array([1]).buffer);
    ch.deliver(new Uint8Array([2]).buffer);
    const got: number[] = [];
    ch.onmessage = (e) => got.push(new Uint8Array(e.data)[0]);
    expect(got).toEqual([]); // 不在 setter 裡同步送
    await Promise.resolve();
    expect(got).toEqual([1, 2]);
    ch.deliver(new Uint8Array([3]).buffer);
    expect(got).toEqual([1, 2, 3]);
  });

  it("handler 裡又 deliver 仍維持順序", () => {
    const ch = new VncChannel(deferredIo().io);
    const got: number[] = [];
    ch.onmessage = (e) => {
      const v = new Uint8Array(e.data)[0];
      got.push(v);
      if (v === 1) ch.deliver(new Uint8Array([3]).buffer);
    };
    ch.deliver(new Uint8Array([1]).buffer);
    ch.deliver(new Uint8Array([2]).buffer);
    ch.markOpen();
    expect(got).toEqual([1, 2, 3]);
  });

  it("關閉後 deliver 丟棄；沒 open 就關閉，暫存也丟棄", () => {
    const ch = new VncChannel(deferredIo().io);
    const got = vi.fn();
    ch.onmessage = got;
    ch.deliver(new Uint8Array([1]).buffer);
    ch.markClosed("gone");
    ch.markOpen();
    ch.deliver(new Uint8Array([2]).buffer);
    expect(got).not.toHaveBeenCalled();
    expect(ch.readyState).toBe("closed");
  });
});

describe("VncChannel：關閉", () => {
  it("markClosed 只觸發一次；乾淨關閉不觸發 onerror", () => {
    const ch = new VncChannel(deferredIo().io);
    const closes: VncCloseEvent[] = [];
    const errors = vi.fn();
    ch.onclose = (e) => closes.push(e);
    ch.onerror = errors;
    ch.markOpen();
    ch.markClosed("bye");
    ch.markClosed("again", false);
    expect(closes).toEqual([{ type: "close", code: 1000, reason: "bye", wasClean: true }]);
    expect(errors).not.toHaveBeenCalled();
  });

  it("不乾淨：先 onerror 再 onclose(1006)", () => {
    const ch = new VncChannel(deferredIo().io);
    const log: string[] = [];
    ch.onerror = () => log.push("error");
    ch.onclose = (e) => log.push(`close:${e.code}`);
    ch.markClosed("reset", false);
    expect(log).toEqual(["error", "close:1006"]);
  });

  it("close()：狀態轉 closing，等 io.close 完成才 onclose；重複呼叫無效", async () => {
    const { io, closes } = deferredIo();
    const ch = new VncChannel(io);
    const onclose = vi.fn();
    ch.onclose = onclose;
    ch.markOpen();
    ch.close();
    ch.close();
    expect(ch.readyState).toBe("closing");
    expect(closes.length).toBe(1);
    expect(onclose).not.toHaveBeenCalled();
    closes[0].resolve();
    await tick();
    expect(ch.readyState).toBe("closed");
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledWith(expect.objectContaining({ wasClean: true, code: 1000 }));
    ch.close();
    expect(closes.length).toBe(1);
  });

  it("close() 先把在途與待送的寫完再關後端；closing 之後的 send 無效", async () => {
    const { io, writes, closes } = deferredIo();
    const ch = new VncChannel(io);
    ch.markOpen();
    ch.send(bytesOf(1));
    ch.send(bytesOf(2));
    ch.close();
    ch.send(bytesOf(3));
    expect(closes.length).toBe(0);
    writes[0].resolve();
    await tick();
    expect(writes.map((w) => w.bytes)).toEqual([[1], [2]]);
    expect(closes.length).toBe(0);
    writes[1].resolve();
    await tick();
    expect(closes.length).toBe(1);
  });

  it("io.close 失敗 → 不乾淨關閉", async () => {
    const { io, closes } = deferredIo();
    const ch = new VncChannel(io);
    const onclose = vi.fn();
    ch.onclose = onclose;
    ch.close();
    closes[0].reject(new Error("already gone"));
    await tick();
    expect(onclose).toHaveBeenCalledWith(expect.objectContaining({ wasClean: false, reason: "already gone" }));
  });

  it("closing 期間後端先回報斷線：只觸發一次 onclose", async () => {
    const { io, closes } = deferredIo();
    const ch = new VncChannel(io);
    const onclose = vi.fn();
    ch.onclose = onclose;
    ch.markOpen();
    ch.close();
    ch.markClosed("remote closed");
    closes[0].resolve();
    await tick();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(onclose).toHaveBeenCalledWith(expect.objectContaining({ reason: "remote closed" }));
  });

  it("在途寫入於關閉後才完成，不會再觸發寫入或 onclose", async () => {
    const { io, writes } = deferredIo();
    const ch = new VncChannel(io);
    const onclose = vi.fn();
    ch.onclose = onclose;
    ch.markOpen();
    ch.send(bytesOf(1));
    ch.send(bytesOf(2));
    ch.markClosed("gone");
    writes[0].resolve();
    await tick();
    expect(writes.length).toBe(1);
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});
