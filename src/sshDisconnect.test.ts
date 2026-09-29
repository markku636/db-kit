import { describe, it, expect } from "vitest";
import { disconnectKind } from "./sshDisconnect";

describe("disconnectKind", () => {
  it("Windows 的英文 / 中文訊息都認得（靠 os error 碼，也靠字面）", () => {
    expect(disconnectKind("An existing connection was forcibly closed by the remote host. (os error 10054)")).toBe("reset");
    expect(disconnectKind("遠端主機已強制關閉一個現存的連線。 (os error 10054)")).toBe("reset");
    expect(disconnectKind("A connection attempt failed because the connected party did not properly respond (os error 10060)")).toBe("timeout");
    expect(disconnectKind("No connection could be made because the target machine actively refused it. (os error 10061)")).toBe("refused");
    expect(disconnectKind("A socket operation was attempted to an unreachable host. (os error 10065)")).toBe("unreachable");
  });

  it("Linux / macOS 的 errno", () => {
    expect(disconnectKind("Connection reset by peer (os error 104)")).toBe("reset");
    expect(disconnectKind("Connection reset by peer (os error 54)")).toBe("reset");
    expect(disconnectKind("Connection timed out (os error 110)")).toBe("timeout");
    expect(disconnectKind("Connection refused (os error 111)")).toBe("refused");
    expect(disconnectKind("No route to host (os error 113)")).toBe("unreachable");
  });

  it("認不得、空的都歸 other；錯誤碼要整個對上，不會拿 1054 當 10054", () => {
    expect(disconnectKind("shell 已結束")).toBe("other");
    expect(disconnectKind("")).toBe("other");
    expect(disconnectKind(null)).toBe("other");
    expect(disconnectKind(undefined)).toBe("other");
    expect(disconnectKind("weird (os error 1054)")).toBe("other");
  });
});
