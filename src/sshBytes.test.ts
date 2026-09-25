import { describe, it, expect } from "vitest";
import { utf8ToB64, binaryToB64, b64ToBytes } from "./sshBytes";

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("utf8ToB64", () => {
  it("ASCII 與 CJK / emoji 都以 UTF-8 編碼後再 base64", () => {
    expect(utf8ToB64("ls\r")).toBe(btoa("ls\r"));
    expect(utf8ToB64("你好")).toBe("5L2g5aW9");
    expect(dec(b64ToBytes(utf8ToB64("你好 🐧")))).toBe("你好 🐧");
  });

  it("空字串 → 空字串", () => {
    expect(utf8ToB64("")).toBe("");
    expect(binaryToB64("")).toBe("");
    expect(b64ToBytes("")).toEqual(new Uint8Array(0));
  });

  it("超過單次 fromCharCode 引數上限的大字串也能來回", () => {
    const big = "x".repeat(300_000) + "好";
    expect(dec(b64ToBytes(utf8ToB64(big)))).toBe(big);
  });
});

describe("binaryToB64", () => {
  it("每個字元一個位元組，不做 UTF-8 編碼", () => {
    expect(binaryToB64("\x00\xff")).toBe("AP8=");
    expect(Array.from(b64ToBytes(binaryToB64("\x1b[M ")))).toEqual([0x1b, 0x5b, 0x4d, 0x20]);
  });

  it("超過 0xff 的字元只取低 8 位，不丟例外", () => {
    expect(() => binaryToB64("好")).not.toThrow();
    expect(Array.from(b64ToBytes(binaryToB64("Ā")))).toEqual([0]);
  });
});

describe("b64ToBytes", () => {
  it("忽略空白與換行", () => {
    expect(Array.from(b64ToBytes("aGk=\n"))).toEqual([104, 105]);
    expect(Array.from(b64ToBytes(" aG k= "))).toEqual([104, 105]);
  });
});
