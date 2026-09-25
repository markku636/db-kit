import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  stripAnsi, stripAnsiChunk, normalizeLines, looksLikePrompt, createOutputCapture, guessOs, guessShell,
} from "./sshCapture";

const enc = (s: string) => new TextEncoder().encode(s);

describe("stripAnsi", () => {
  it("CSI 色碼 / 游標序列、OSC（BEL 與 ST 終止）、兩字元 ESC 序列、nF 序列全去掉", () => {
    expect(stripAnsi("\x1b[0m\x1b[01;34mapp\x1b[0m  logs")).toBe("app  logs");
    expect(stripAnsi("\x1b[2J\x1b[H\x1b[?25lhi\x1b[?25h")).toBe("hi");
    expect(stripAnsi("\x1b]0;user@host: ~\x07prompt")).toBe("prompt");
    expect(stripAnsi("\x1b]7;file://host/tmp\x1b\\cwd")).toBe("cwd");
    expect(stripAnsi("\x1b7save\x1b8\x1b=\x1b>")).toBe("save");
    expect(stripAnsi("\x1b(Bascii\x1b#8")).toBe("ascii");
  });

  it("保留 \\t \\n \\r，丟掉其他 C0（BEL / BS / NUL）", () => {
    expect(stripAnsi("a\tb\r\nc\x07\x08\x00d")).toBe("a\tb\r\ncd");
  });

  it("CSI 終止字元不合法時只丟前面那截，該字元保留", () => {
    expect(stripAnsi("\x1b[1你好")).toBe("你好");
  });

  it("chunk 邊界切在逃逸序列中間：carry 帶到下一段", () => {
    const a = stripAnsiChunk("hello \x1b[3");
    expect(a).toEqual({ text: "hello ", carry: "\x1b[3" });
    const b = stripAnsiChunk(a.carry + "2mworld\x1b[0m");
    expect(b).toEqual({ text: "world", carry: "" });
    expect(stripAnsiChunk("x\x1b")).toEqual({ text: "x", carry: "\x1b" });
    expect(stripAnsiChunk("x\x1b]0;title")).toEqual({ text: "x", carry: "\x1b]0;title" });
    expect(stripAnsiChunk("x\x1b]0;title\x1b")).toEqual({ text: "x", carry: "\x1b]0;title\x1b" });
    expect(stripAnsiChunk("x\x1b(")).toEqual({ text: "x", carry: "\x1b(" });
  });
});

describe("normalizeLines / looksLikePrompt", () => {
  it("\\r\\n → \\n；孤立 \\r 只留最後一段非空內容", () => {
    expect(normalizeLines("a\r\nb\r\n")).toBe("a\nb\n");
    expect(normalizeLines("50%\r100%\r\ndone")).toBe("100%\ndone");
    expect(normalizeLines("x\r\r\n")).toBe("x\n");
  });

  it("提示符判定：$ # % > 結尾的短行；100% 不算", () => {
    expect(looksLikePrompt("deploy@web-01:~$ ")).toBe(true);
    expect(looksLikePrompt("root@host:/etc# ")).toBe(true);
    expect(looksLikePrompt("host ~ %")).toBe(true);
    expect(looksLikePrompt("PS C:\\Users\\me>")).toBe(true);
    expect(looksLikePrompt("Progress: 100%")).toBe(false);
    expect(looksLikePrompt("")).toBe(false);
    expect(looksLikePrompt("x".repeat(200) + "$")).toBe(false);
  });
});

describe("createOutputCapture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("閒置 idleMs 後結束：去 ANSI、去指令回聲、去尾端提示符", async () => {
    const cap = createOutputCapture({ idleMs: 300, echo: "ls -la" });
    cap.push(enc("ls -la\r\n"));
    vi.advanceTimersByTime(100);
    cap.push(enc("\x1b[0m\x1b[01;34mapp\x1b[0m  logs\r\nbackup.tar.gz\r\n"));
    vi.advanceTimersByTime(299);
    let settled = false;
    void cap.promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cap.done).toBe(false);
    cap.push(enc("deploy@web-01:~$ "));
    vi.advanceTimersByTime(300);
    const r = await cap.promise;
    expect(r).toEqual({ output: "app  logs\nbackup.tar.gz", durationMs: 699, truncated: false, reason: "idle" });
    expect(cap.done).toBe(true);
    // 結束後再 push 不會炸也不會改結果
    cap.push("late");
    expect((await cap.promise).output).toBe("app  logs\nbackup.tar.gz");
  });

  it("回聲帶提示符前綴也剔除；沒有輸出的指令回空字串", async () => {
    const cap = createOutputCapture({ echo: "cd /tmp" });
    cap.push(enc("user@host:~$ cd /tmp\r\nuser@host:/tmp$ "));
    vi.advanceTimersByTime(300);
    expect((await cap.promise).output).toBe("");
  });

  it("完全沒有輸出時 idleMs 後也會結束，不必等 maxMs", async () => {
    const cap = createOutputCapture({ idleMs: 300, maxMs: 8000 });
    vi.advanceTimersByTime(300);
    const r = await cap.promise;
    expect(r.output).toBe("");
    expect(r.reason).toBe("idle");
  });

  it("逃逸序列與 UTF-8 多位元組切在 chunk 邊界都能接回來", async () => {
    const cap = createOutputCapture({ idleMs: 100 });
    const bytes = enc("\x1b[32m你好\x1b[0m\r\n");
    cap.push(bytes.subarray(0, 3)); // "\x1b[3"
    cap.push(bytes.subarray(3, 7)); // "2m" + 你 的前兩個位元組
    cap.push(bytes.subarray(7));
    vi.advanceTimersByTime(100);
    expect((await cap.promise).output).toBe("你好");
  });

  it("\\r 進度條只留最後一段", async () => {
    const cap = createOutputCapture({ idleMs: 100, stripTrailingPrompt: false });
    cap.push("downloading 10%\rdownloading 50%\rdownloading 100%\r\n");
    vi.advanceTimersByTime(100);
    expect((await cap.promise).output).toBe("downloading 100%");
  });

  it("maxBytes 到了立刻結束、truncated=true", async () => {
    const cap = createOutputCapture({ idleMs: 300, maxBytes: 1000, stripTrailingPrompt: false });
    cap.push(enc("x".repeat(600) + "\r\n"));
    expect(cap.done).toBe(false);
    cap.push(enc("y".repeat(600)));
    expect(cap.done).toBe(true);
    const r = await cap.promise;
    expect(r.truncated).toBe(true);
    expect(r.reason).toBe("max_bytes");
    expect(r.output.length).toBeLessThanOrEqual(1000);
    expect(r.output.startsWith("x".repeat(600))).toBe(true);
  });

  it("輸出一直來也會在 maxMs 結束、truncated=true", async () => {
    const cap = createOutputCapture({ idleMs: 300, maxMs: 2000, stripTrailingPrompt: false });
    for (let i = 0; i < 30; i++) {
      cap.push(enc(`line ${i}\r\n`));
      vi.advanceTimersByTime(100);
    }
    const r = await cap.promise;
    expect(r.reason).toBe("max_time");
    expect(r.truncated).toBe(true);
    expect(r.durationMs).toBe(2000);
    expect(r.output.split("\n")).toHaveLength(20);
  });

  it("cancel 帶著目前內容結束，不 reject", async () => {
    const cap = createOutputCapture({ stripTrailingPrompt: false });
    cap.push("partial");
    cap.cancel();
    const r = await cap.promise;
    expect(r).toMatchObject({ output: "partial", truncated: false, reason: "cancelled" });
  });

  it("stripTrailingPrompt=false 時保留最後一行", async () => {
    const cap = createOutputCapture({ idleMs: 100, stripTrailingPrompt: false });
    cap.push("out\r\nuser@host:~$ ");
    vi.advanceTimersByTime(100);
    expect((await cap.promise).output).toBe("out\nuser@host:~$");
  });
});

describe("guessOs", () => {
  it("常見發行版 banner / uname / os-release", () => {
    expect(guessOs("Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)")).toBe("Ubuntu 22.04");
    expect(guessOs("Linux web 5.15.0-91-generic #101-Ubuntu SMP x86_64 GNU/Linux")).toBe("Ubuntu");
    expect(guessOs("Debian GNU/Linux 12 \\n \\l")).toBe("Debian 12");
    expect(guessOs("CentOS Linux release 7.9.2009 (Core)")).toBe("CentOS 7.9");
    expect(guessOs("CentOS Stream release 9")).toBe("CentOS Stream 9");
    expect(guessOs("Rocky Linux release 9.2 (Blue Onyx)")).toBe("Rocky Linux 9.2");
    expect(guessOs("AlmaLinux 9.3 (Shamrock Pampas Cat)")).toBe("AlmaLinux 9.3");
    expect(guessOs("Fedora Linux 39 (Server Edition)")).toBe("Fedora 39");
    expect(guessOs("Welcome to Alpine!\nAlpine Linux v3.19")).toBe("Alpine Linux 3.19");
    expect(guessOs("Arch Linux x86_64")).toBe("Arch Linux");
    expect(guessOs("openSUSE Leap 15.5")).toBe("openSUSE Leap 15.5");
    expect(guessOs("FreeBSD 14.0-RELEASE releng/14.0-n265380")).toBe("FreeBSD 14.0");
    expect(guessOs("Darwin mac.local 23.2.0 Darwin Kernel Version 23.2.0")).toBe("macOS");
    expect(guessOs("Windows PowerShell\nCopyright (C) Microsoft Corporation.")).toBe("Windows");
    expect(guessOs("PS C:\\Users\\me> ")).toBe("Windows");
  });

  it("os-release 的 PRETTY_NAME 優先", () => {
    expect(guessOs('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\nID=ubuntu')).toBe("Ubuntu 22.04.3 LTS");
  });

  it("猜不到回 undefined", () => {
    expect(guessOs("")).toBeUndefined();
    expect(guessOs("total 12\ndrwxr-xr-x 2 root root 4096")).toBeUndefined();
  });
});

describe("guessShell", () => {
  it("依最後一行提示符判定", () => {
    expect(guessShell("out\ndeploy@web-01:~$ ")).toBe("bash");
    expect(guessShell("root@host:/etc# ")).toBe("bash");
    expect(guessShell("me@mac ~ % ")).toBe("zsh");
    expect(guessShell("PS C:\\Users\\me> ")).toBe("pwsh");
    expect(guessShell("C:\\Users\\me>")).toBe("cmd");
    expect(guessShell("me@host ~> ")).toBe("fish");
  });

  it("不像提示符（輸出行 / 100% / 空 / 超長）回 undefined", () => {
    expect(guessShell("")).toBeUndefined();
    expect(guessShell("total 12")).toBeUndefined();
    expect(guessShell("Progress: 100%")).toBeUndefined();
    expect(guessShell("x".repeat(200) + "$")).toBeUndefined();
  });
});
