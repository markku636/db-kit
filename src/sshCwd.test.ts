import { describe, expect, it } from "vitest";
import { absTerminalDir, cwdFromTitle, expandHome, terminalDir } from "./sshCwd";

describe("cwdFromTitle", () => {
  it("Debian / Ubuntu 預設標題（冒號後有空白）", () => {
    expect(cwdFromTitle("mark.ku@vl-tokenmon: ~")).toBe("~");
    expect(cwdFromTitle("deploy@web-01: ~/app/logs")).toBe("~/app/logs");
    expect(cwdFromTitle("root@db1: /var/lib/mysql")).toBe("/var/lib/mysql");
  });
  it("RHEL / oh-my-zsh（冒號後沒有空白）", () => {
    expect(cwdFromTitle("deploy@web-01:~")).toBe("~");
    expect(cwdFromTitle("deploy@web-01:/etc/nginx")).toBe("/etc/nginx");
  });
  it("路徑裡的空白保留、結尾斜線去掉（根目錄除外）", () => {
    expect(cwdFromTitle("u@h: /srv/my site/")).toBe("/srv/my site");
    expect(cwdFromTitle("u@h: /")).toBe("/");
  });
  it("認不出來的標題回 null", () => {
    for (const t of [null, "", "vim server.js", "htop", "u@h: ~other/x", "u@h: …/a/b", "tmux", "u@h"]) {
      expect(cwdFromTitle(t)).toBeNull();
    }
  });
});

describe("terminalDir", () => {
  it("OSC 7 優先於標題", () => {
    expect(terminalDir({ cwd: "/opt/app", title: "u@h: ~" })).toBe("/opt/app");
    expect(terminalDir({ cwd: null, title: "u@h: ~/x" })).toBe("~/x");
    expect(terminalDir({ cwd: null, title: "vim" })).toBeNull();
    expect(terminalDir(undefined)).toBeNull();
  });
});

describe("absTerminalDir", () => {
  it("有家目錄才解 ~；絕對路徑不必等", () => {
    expect(absTerminalDir("~/logs", "/home/deploy")).toBe("/home/deploy/logs");
    expect(absTerminalDir("~/logs", null)).toBeNull();
    expect(absTerminalDir("/var/log", null)).toBe("/var/log");
    expect(absTerminalDir(null, "/home/deploy")).toBeNull();
  });
});

describe("expandHome", () => {
  it("接上家目錄", () => {
    expect(expandHome("~", "/home/deploy")).toBe("/home/deploy");
    expect(expandHome("~/logs", "/home/deploy")).toBe("/home/deploy/logs");
    expect(expandHome("~/logs", "/home/deploy/")).toBe("/home/deploy/logs");
    expect(expandHome("/etc", "/home/deploy")).toBe("/etc");
    expect(expandHome("~", "")).toBe("/");
  });
});
