import { describe, expect, it } from "vitest";
import { bufferLinesToText, createRecorder, defaultLogName, fmtDuration } from "./sshSessionLog";

const enc = (s: string) => new TextEncoder().encode(s);

describe("createRecorder", () => {
  it("去 ANSI，色碼切在封包邊界也不漏", () => {
    const r = createRecorder();
    r.push(enc("\x1b[3"));
    r.push(enc("2mok\x1b[0m\r\n"));
    expect(r.take()).toBe("ok\n");
  });

  it("UTF-8 字元切在封包邊界照樣接回來", () => {
    const r = createRecorder();
    const bytes = enc("中文\n");
    r.push(bytes.slice(0, 2));
    r.push(bytes.slice(2));
    expect(r.take()).toBe("中文\n");
  });

  it("進度條的 \\r 重寫只留最後一次；最後一行要等換行或 flush 才寫出", () => {
    const r = createRecorder();
    r.push(enc("download 10%\r"));
    r.push(enc("download 60%\r"));
    expect(r.take()).toBe("");
    r.push(enc("download 100%\r\nnext"));
    expect(r.take()).toBe("download 100%\n");
    expect(r.flush()).toBe("next\n");
    expect(r.flush()).toBe("");
  });
});

describe("fmtDuration / defaultLogName / bufferLinesToText", () => {
  it("連線時間", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(307_000)).toBe("5:07");
    expect(fmtDuration(3_723_000)).toBe("1:02:03");
  });

  it("檔名：主機 + 時間，不能用的字元換掉", () => {
    expect(defaultLogName("deploy@web-01", new Date(2026, 8, 28, 15, 4, 5))).toBe("deploy@web-01-20260928-150405.log");
    expect(defaultLogName("a/b: c", new Date(2026, 0, 2, 3, 4, 5), "txt")).toBe("a_b_c-20260102-030405.txt");
    expect(defaultLogName("", new Date(2026, 0, 2, 3, 4, 5))).toBe("ssh-20260102-030405.log");
  });

  it("畫面內容：折行接回同一行、去行尾空白與尾端空行", () => {
    const text = bufferLinesToText([
      { text: "$ ls   ", wrapped: false },
      { text: "a-very-long-", wrapped: false },
      { text: "file-name", wrapped: true },
      { text: "", wrapped: false },
      { text: "   ", wrapped: false },
    ]);
    expect(text).toBe("$ ls\na-very-long-file-name\n");
    expect(bufferLinesToText([])).toBe("");
  });
});
