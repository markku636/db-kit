import { describe, it, expect } from "vitest";
import {
  applyEol, canOpenInEditor, defaultMode, detectEol, EDITABLE_MAX, hasPerm, languageForFile, parseOctal,
  remoteChanged, toOctal, togglePerm,
} from "./sftpText";

describe("換行符號：CodeMirror 一律用 \\n 接回去，存檔要換回原檔的慣例", () => {
  it("偵測：沒有 CRLF → LF；多數決", () => {
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\r\nb\nc\n")).toBe("\n"); // 1 CRLF vs 2 LF
    expect(detectEol("a\r\nb\r\nc\n")).toBe("\r\n");
    expect(detectEol("")).toBe("\n");
  });

  it("套用：LF 原樣；CRLF 逐行換回，且不會把貼上的 \\r\\n 疊成 \\r\\r\\n", () => {
    expect(applyEol("a\nb\n", "\n")).toBe("a\nb\n");
    expect(applyEol("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(applyEol("a\r\nb\n", "\r\n")).toBe("a\r\nb\r\n");
    expect(applyEol("a\r\nb", "\n")).toBe("a\nb");
    expect(applyEol("old\rmac", "\n")).toBe("old\nmac");
  });

  it("來回一趟不變（讀進來的原文 → 編輯器 → 存回去）", () => {
    for (const original of ["x\r\ny\r\n", "x\ny\n", "單行沒換行", "\r\n"]) {
      const eol = detectEol(original);
      const inEditor = original.replace(/\r\n/g, "\n");
      expect(applyEol(inEditor, eol)).toBe(original);
    }
  });
});

describe("languageForFile", () => {
  it("只對應專案裡有的語言包，其餘純文字", () => {
    expect(languageForFile("package.json")).toBe("json");
    expect(languageForFile("tsconfig.JSONC")).toBe("json");
    expect(languageForFile(".eslintrc")).toBe("json");
    expect(languageForFile("server.js")).toBe("javascript");
    expect(languageForFile("app.tsx")).toBe("javascript");
    expect(languageForFile("init.sql")).toBe("sql");
    expect(languageForFile("nginx.conf")).toBeNull();
    expect(languageForFile("Makefile")).toBeNull();
    expect(languageForFile(".bashrc")).toBeNull();
  });
});

describe("canOpenInEditor / remoteChanged", () => {
  it("1 MiB 以內可開，更大的改成下載", () => {
    expect(canOpenInEditor(0)).toBe(true);
    expect(canOpenInEditor(EDITABLE_MAX)).toBe(true);
    expect(canOpenInEditor(EDITABLE_MAX + 1)).toBe(false);
  });

  it("mtime 或大小變了才算衝突；伺服器沒給 mtime 時只看大小", () => {
    expect(remoteChanged({ mtime: 10, size: 5 }, { mtime: 10, size: 5 })).toBe(false);
    expect(remoteChanged({ mtime: 10, size: 5 }, { mtime: 11, size: 5 })).toBe(true);
    expect(remoteChanged({ mtime: 10, size: 5 }, { mtime: 10, size: 6 })).toBe(true);
    expect(remoteChanged({ mtime: null, size: 5 }, { mtime: 99, size: 5 })).toBe(false);
    expect(remoteChanged({ mtime: null, size: 5 }, { mtime: null, size: 7 })).toBe(true);
  });
});

describe("權限位元", () => {
  it("hasPerm / togglePerm 對應 rwx × owner / group / other", () => {
    const m = 0o640;
    expect(hasPerm(m, "owner", "r")).toBe(true);
    expect(hasPerm(m, "owner", "x")).toBe(false);
    expect(hasPerm(m, "group", "r")).toBe(true);
    expect(hasPerm(m, "other", "r")).toBe(false);
    expect(togglePerm(m, "owner", "x")).toBe(0o740);
    expect(togglePerm(togglePerm(m, "other", "r"), "other", "r")).toBe(m);
  });

  it("toOctal：型別位元丟掉；特殊位元時四位數", () => {
    expect(toOctal(0o100644)).toBe("0644");
    expect(toOctal(0o40755)).toBe("0755");
    expect(toOctal(0o4755)).toBe("4755");
    expect(toOctal(0o1777)).toBe("1777");
    expect(toOctal(0)).toBe("0000");
  });

  it("parseOctal 只收 3～4 位 0～7", () => {
    expect(parseOctal("644")).toBe(0o644);
    expect(parseOctal(" 0755 ")).toBe(0o755);
    expect(parseOctal("4755")).toBe(0o4755);
    for (const bad of ["", "64", "12345", "648", "rwx", "0x1ff", "-644"]) expect(parseOctal(bad)).toBeNull();
  });

  it("defaultMode：沒有權限資訊時檔案 0644、目錄 0755", () => {
    expect(defaultMode(0o100600, false)).toBe(0o600);
    expect(defaultMode(null, false)).toBe(0o644);
    expect(defaultMode(null, true)).toBe(0o755);
  });
});
