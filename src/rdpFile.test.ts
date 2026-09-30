import { describe, expect, it } from "vitest";
import { parseRdString } from "./rdConnString";
import { decodeRdpFileBytes, parseRdpFile } from "./rdpFile";

/** mstsc 存檔的格式：UTF-16LE 帶 BOM。手動編碼（TextEncoder 只會 UTF-8）。 */
function utf16(s: string, le: boolean, bom = true): Uint8Array {
  const off = bom ? 2 : 0;
  const b = new Uint8Array(off + s.length * 2);
  if (bom) { b[0] = le ? 0xff : 0xfe; b[1] = le ? 0xfe : 0xff; }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[off + 2 * i] = le ? c & 0xff : c >> 8;
    b[off + 2 * i + 1] = le ? c >> 8 : c & 0xff;
  }
  return b;
}

const MSTSC_FILE = [
  "screen mode id:i:2",
  "use multimon:i:0",
  "desktopwidth:i:2560",
  "desktopheight:i:1440",
  "session bpp:i:32",
  "winposstr:s:0,3,0,0,800,600",
  "full address:s:win-srv.corp.local:3390",
  "alternate full address:s:other-host",
  "authentication level:i:2",
  "enablecredsspsupport:i:1",
  "prompt for credentials:i:0",
  "gatewayhostname:s:",
  "gatewayusagemethod:i:4",
  "username:s:CORP\\王小明",
  "",
  "password 51:b:01000000D08C9DDF0115D1118C7A00C04FC297EB0100000045",
  "dynamic resolution:i:1",
  "",
].join("\r\n");

describe("decodeRdpFileBytes", () => {
  it("UTF-16LE 帶 BOM（mstsc 的預設）", () => {
    expect(decodeRdpFileBytes(utf16("full address:s:h\r\nusername:s:中文", true))).toBe("full address:s:h\r\nusername:s:中文");
  });

  it("UTF-16BE 帶 BOM、沒 BOM 的 UTF-16LE / BE", () => {
    expect(decodeRdpFileBytes(utf16("full address:s:h", false))).toBe("full address:s:h");
    expect(decodeRdpFileBytes(utf16("full address:s:h", true, false))).toBe("full address:s:h");
    expect(decodeRdpFileBytes(utf16("full address:s:h", false, false))).toBe("full address:s:h");
  });

  it("UTF-8 有無 BOM", () => {
    const body = new TextEncoder().encode("full address:s:主機");
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expect(decodeRdpFileBytes(withBom)).toBe("full address:s:主機");
    expect(decodeRdpFileBytes(body)).toBe("full address:s:主機");
  });

  it("空檔、奇數長度不炸", () => {
    expect(decodeRdpFileBytes(new Uint8Array())).toBe("");
    expect(decodeRdpFileBytes(new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42]))).toBe("A");
  });

  it("大檔（超過分段大小）", () => {
    const s = "a:s:" + "x".repeat(20000);
    expect(decodeRdpFileBytes(utf16(s, true))).toBe(s);
  });
});

describe("parseRdpFile", () => {
  it("mstsc 存的檔（UTF-16LE、CRLF）", () => {
    const p = parseRdpFile(decodeRdpFileBytes(utf16(MSTSC_FILE, true)))!;
    expect(p).toEqual({
      protocol: "rdp", host: "win-srv.corp.local", port: 3390, username: "王小明", domain: "CORP", password: null,
      name: "win-srv.corp.local",
      options: { ui: { fullscreen: "1" }, width: 2560, height: 1440, color_depth: 32, nla: true, resize_mode: "remote" },
      viaSsh: null,
      warnings: ["未匯入 .rdp 內的加密密碼（只有原電腦能解開）"],
    });
  });

  it("server port：full address 沒寫埠才用；full address 的埠優先（不管順序）", () => {
    expect(parseRdpFile("full address:s:h\nserver port:i:3391")!.port).toBe(3391);
    expect(parseRdpFile("server port:i:3391\nfull address:s:h")!.port).toBe(3391);
    expect(parseRdpFile("server port:i:3391\nfull address:s:h:4000")!.port).toBe(4000);
    expect(parseRdpFile("full address:s:h:4000\nserver port:i:3391")!.port).toBe(4000);
  });

  it("IPv6、domain 鍵、UPN、NLA 關閉、smart sizing", () => {
    const p = parseRdpFile("full address:s:[fe80::1]:3390\r\nusername:s:bob@corp.com\r\ndomain:s:CORP\r\nenablecredsspsupport:i:0\r\nsmart sizing:i:1\r\n")!;
    expect(p).toMatchObject({ host: "fe80::1", port: 3390, username: "bob@corp.com", domain: "CORP", options: { nla: false, resize_mode: "scale" } });
  });

  it("閘道警告；鍵名大小寫、行首尾空白、BOM 字元、單獨的 CR 都行", () => {
    const p = parseRdpFile("﻿  Full Address:s:h  \rGatewayHostname:s:gw.corp.com\r")!;
    expect(p.host).toBe("h");
    expect(p.warnings).toEqual(["不支援 RD 閘道（gatewayhostname），已略過"]);
  });

  it("認不得的鍵、壞行、壞值都略過", () => {
    const p = parseRdpFile("garbage line\nfoo:s:bar\nfull address:s:h\ndesktopwidth:i:abc\nsession bpp:i:8\nscreen mode id:i:9\n")!;
    expect(p).toMatchObject({ host: "h", port: 0, options: {} });
  });

  it("沒有 full address / 空檔 → null", () => {
    expect(parseRdpFile("")).toBeNull();
    expect(parseRdpFile("username:s:bob\r\nscreen mode id:i:2")).toBeNull();
    expect(parseRdpFile("full address:s:")).toBeNull();
    expect(parseRdpFile("full address:s:bad host")).toBeNull();
  });

  it("跟 Microsoft rdp:// URI 同一套鍵對映", () => {
    const keys = ["full address:s:h:3390", "username:s:CORP\\a", "desktopwidth:i:800", "desktopheight:i:600", "session bpp:i:16", "enablecredsspsupport:i:0", "smart sizing:i:1"];
    const fromFile = parseRdpFile(keys.join("\r\n"))!;
    const fromUri = parseRdString("rdp://" + keys.map((k) => encodeURIComponent(k.replace(":", "="))).join("&"))!;
    expect({ ...fromUri, name: fromFile.name }).toEqual(fromFile);
  });
});
