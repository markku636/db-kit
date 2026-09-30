import { describe, expect, it } from "vitest";
import { applyRdString, looksLikeRdString, parseRdString, parseRustdeskServerConfig, splitDomainUser, type ParsedRd } from "./rdConnString";
import { blankRdSession } from "./rdTypes";

const GATEWAY = "不支援 RD 閘道（gatewayhostname），已略過";

describe("parseRdString：RDP Microsoft URI", () => {
  it("full address + DOMAIN\\user + 選項", () => {
    const p = parseRdString(
      "rdp://full%20address=s:srv.corp.local:3390&username=s:CORP%5Calice&desktopwidth=i:1920&desktopheight=i:1080&session%20bpp=i:24&audiomode=i:2",
    );
    expect(p).toEqual<ParsedRd>({
      protocol: "rdp", host: "srv.corp.local", port: 3390, username: "alice", domain: "CORP", password: null, name: "",
      options: { width: 1920, height: 1080, color_depth: 24 }, viaSsh: null, warnings: [],
    });
  });

  it("沒有 rdp:// 也收；鍵名大小寫、未編碼的空白都行；scheme 不分大小寫", () => {
    expect(parseRdString("full address=s:10.0.0.5&username=s:bob")).toMatchObject({ protocol: "rdp", host: "10.0.0.5", port: 0, username: "bob" });
    expect(parseRdString("RDP://Full%20Address=s:h")).toMatchObject({ host: "h" });
    // 整組都編碼（冒號也是 %3A）
    expect(parseRdString("rdp://full%20address%3Ds%3Ah%3A4000")).toMatchObject({ host: "h", port: 4000 });
  });

  it("domain 鍵；UPN 帳號不拆", () => {
    expect(parseRdString("rdp://full%20address=s:h&username=s:bob&domain=s:ACME")).toMatchObject({ username: "bob", domain: "ACME" });
    expect(parseRdString("rdp://full%20address=s:h&username=s:bob%40acme.com")).toMatchObject({ username: "bob@acme.com", domain: "" });
  });

  it("screen mode id / NLA / 動態解析度 / smart sizing", () => {
    expect(parseRdString("rdp://full%20address=s:h&screen%20mode%20id=i:2")!.options).toEqual({ ui: { fullscreen: "1" } });
    expect(parseRdString("rdp://full%20address=s:h&screen%20mode%20id=i:1")!.options).toEqual({ ui: { fullscreen: "0" } });
    expect(parseRdString("rdp://full%20address=s:h&enablecredsspsupport=i:0")!.options).toEqual({ nla: false });
    expect(parseRdString("rdp://full%20address=s:h&smart%20sizing=i:1")!.options).toEqual({ resize_mode: "scale" });
    // 兩個都開：動態解析度優先，不管順序
    expect(parseRdString("rdp://full%20address=s:h&smart%20sizing=i:1&dynamic%20resolution=i:1")!.options.resize_mode).toBe("remote");
    expect(parseRdString("rdp://full%20address=s:h&dynamic%20resolution=i:1&smart%20sizing=i:1")!.options.resize_mode).toBe("remote");
  });

  it("gatewayhostname → 警告；gatewayusagemethod:i:0 表示不用閘道", () => {
    expect(parseRdString("rdp://full%20address=s:h&gatewayhostname=s:gw.corp.com")!.warnings).toEqual([GATEWAY]);
    expect(parseRdString("rdp://full%20address=s:h&gatewayhostname=s:")!.warnings).toEqual([]);
    expect(parseRdString("rdp://full%20address=s:h&gatewayhostname=s:gw&gatewayusagemethod=i:0")!.warnings).toEqual([]);
  });

  it("沒有 full address 不收", () => {
    expect(parseRdString("rdp://username=s:bob&audiomode=i:0")).toBeNull();
    expect(parseRdString("username=s:bob")).toBeNull();
  });
});

describe("parseRdString：rdp:// URL", () => {
  it("rdp://host、rdp://user:pass@host:port", () => {
    expect(parseRdString("rdp://10.0.0.8")).toMatchObject({ protocol: "rdp", host: "10.0.0.8", port: 0, username: "", password: null });
    expect(parseRdString("rdp://admin:p%40ss%3Aw@win-01:3390/")).toMatchObject({ host: "win-01", port: 3390, username: "admin", password: "p@ss:w" });
  });

  it("DOMAIN\\user、DOMAIN%5Cuser、UPN", () => {
    expect(parseRdString("rdp://CORP\\alice@h")).toMatchObject({ domain: "CORP", username: "alice", host: "h" });
    expect(parseRdString("rdp://CORP%5Calice:pw@h")).toMatchObject({ domain: "CORP", username: "alice", password: "pw" });
    expect(parseRdString("rdp://alice%40corp.com@h")).toMatchObject({ domain: "", username: "alice@corp.com" });
    expect(parseRdString("rdp://alice@corp.com@h")).toMatchObject({ username: "alice@corp.com", host: "h" });
  });

  it("IPv6", () => {
    expect(parseRdString("rdp://[::1]:3390")).toMatchObject({ host: "::1", port: 3390 });
    expect(parseRdString("rdp://u@[fe80::1]")).toMatchObject({ host: "fe80::1", port: 0, username: "u" });
  });

  it("壞的埠號 / 空主機", () => {
    expect(parseRdString("rdp://h:99999")).toBeNull();
    expect(parseRdString("rdp://h:abc")).toBeNull();
    expect(parseRdString("rdp://u@")).toBeNull();
    expect(parseRdString("rdp://")).toBeNull();
  });
});

describe("parseRdString：mstsc 指令", () => {
  it("/v:host:port、/v host、/f、/w /h", () => {
    expect(parseRdString("mstsc /v:srv01:3390")).toMatchObject({ protocol: "rdp", host: "srv01", port: 3390, options: {} });
    expect(parseRdString("mstsc.exe /v 10.1.1.1 /f")).toMatchObject({ host: "10.1.1.1", port: 0, options: { ui: { fullscreen: "1" } } });
    expect(parseRdString("MSTSC /V:h /w:1280 /h:720 /admin")!.options).toEqual({ width: 1280, height: 720 });
    expect(parseRdString("mstsc /v:[::1]:4000")).toMatchObject({ host: "::1", port: 4000 });
  });

  it("完整路徑、提示字元、引號、/g 閘道警告", () => {
    expect(parseRdString("C:\\Windows\\System32\\mstsc.exe /v:h")).toMatchObject({ host: "h" });
    expect(parseRdString("> mstsc /v:h")).toMatchObject({ host: "h" });
    expect(parseRdString('mstsc /v:"h"')).toMatchObject({ host: "h" });
    expect(parseRdString("mstsc /v:h /g:gw.corp.com")!.warnings).toEqual(["不支援 RD 閘道（/g），已略過"]);
  });

  it("沒有 /v 不收（例如只開 .rdp 檔）", () => {
    expect(parseRdString("mstsc")).toBeNull();
    expect(parseRdString("mstsc work.rdp")).toBeNull();
    expect(parseRdString("mstsc /v")).toBeNull();
    expect(parseRdString("mstsc /v /f")).toBeNull();
    expect(parseRdString("http://x/mstsc /v:h")).toBeNull();
  });
});

describe("parseRdString：VNC（RFC 7869）", () => {
  it("vnc://host、user:pass@host:port", () => {
    expect(parseRdString("vnc://10.0.0.9")).toEqual<ParsedRd>({
      protocol: "vnc", host: "10.0.0.9", port: 0, username: "", domain: "", password: null, name: "", options: {}, viaSsh: null, warnings: [],
    });
    expect(parseRdString("vnc://u:s%20ecret@h:5901")).toMatchObject({ host: "h", port: 5901, username: "u", password: "s ecret" });
  });

  it("macOS vnc://user@mac.local；帳號不拆網域、不設 vnc_security", () => {
    const p = parseRdString("vnc://alice@mac.local")!;
    expect(p).toMatchObject({ protocol: "vnc", host: "mac.local", port: 0, username: "alice", domain: "" });
    expect(p.options.vnc_security).toBeUndefined();
    expect(parseRdString("vnc://CORP\\bob@h")).toMatchObject({ username: "CORP\\bob", domain: "" });
  });

  it("埠 < 100 是顯示編號；host::port 是字面埠", () => {
    expect(parseRdString("vnc://h:1")!.port).toBe(5901);
    expect(parseRdString("vnc://h:0")!.port).toBe(5900);
    expect(parseRdString("vnc://h:99")!.port).toBe(5999);
    expect(parseRdString("vnc://h:100")!.port).toBe(100);
    expect(parseRdString("vnc://h::1")!.port).toBe(1);
    expect(parseRdString("vnc://h::5902")).toMatchObject({ host: "h", port: 5902 });
    expect(parseRdString("vnc://[::1]:2")).toMatchObject({ host: "::1", port: 5902 });
    expect(parseRdString("vnc://[::1]::22")).toMatchObject({ host: "::1", port: 22 });
    expect(parseRdString("vnc://[fe80::5]")).toMatchObject({ host: "fe80::5", port: 0 });
    expect(parseRdString("vnc://h::0")).toBeNull();
    expect(parseRdString("vnc://h:70000")).toBeNull();
    expect(parseRdString("vnc://h:x")).toBeNull();
  });

  it("查詢參數（鍵不分大小寫）", () => {
    const p = parseRdString(
      "vnc://h:5900?VncUsername=bob&VncPassword=p%26w&connectionname=Lab%20Mac&SecurityType=30&viewonly=true",
    )!;
    expect(p).toMatchObject({ username: "bob", password: "p&w", name: "Lab Mac", options: { vnc_security: "ard", view_only: true } });
    expect(parseRdString("vnc://h?ViewOnly=0")!.options.view_only).toBe(false);
  });

  it("SecurityType 對映；認不得就警告、不設", () => {
    const sec = (v: string) => parseRdString(`vnc://h?SecurityType=${v}`)!.options.vnc_security;
    expect(sec("1")).toBe("none");
    expect(sec("2")).toBe("vnc");
    expect(sec("30")).toBe("ard");
    expect(sec("19")).toBe("plain");
    expect(sec("VeNCrypt")).toBe("plain");
    const p = parseRdString("vnc://h?SecurityType=16")!;
    expect(p.options.vnc_security).toBeUndefined();
    expect(p.warnings).toEqual(["不支援的 VNC 安全類型（SecurityType=16），改用自動"]);
  });

  it("SshHost / SshPort / SshUsername → viaSsh（SshPort 預設 22）", () => {
    expect(parseRdString("vnc://localhost:5901?SshHost=bastion.example.com&SshUsername=ops")!.viaSsh)
      .toEqual({ host: "bastion.example.com", port: 22, username: "ops" });
    expect(parseRdString("vnc://localhost?sshhost=b&SSHPORT=2222")!.viaSsh).toEqual({ host: "b", port: 2222, username: "" });
    expect(parseRdString("vnc://localhost?SshPort=2222")!.viaSsh).toBeNull();
  });

  it("尾端斜線、fragment 略過；空主機不收", () => {
    expect(parseRdString("vnc://h:2/#x")).toMatchObject({ host: "h", port: 5902 });
    expect(parseRdString("vnc://?VncPassword=x")).toBeNull();
    expect(parseRdString("vnc://")).toBeNull();
  });
});

describe("parseRdString：RustDesk", () => {
  it("rustdesk://<id>（空白剝掉）", () => {
    expect(parseRdString("rustdesk://123456789")).toEqual<ParsedRd>({
      protocol: "rustdesk", host: "123456789", port: 0, username: "", domain: "", password: null, name: "", options: {}, viaSsh: null, warnings: [],
    });
    expect(parseRdString("rustdesk://123%20456%20789")!.host).toBe("123456789");
    expect(parseRdString("RustDesk://123 456 789/")!.host).toBe("123456789");
  });

  it("/r 中繼、@server、/r@server", () => {
    expect(parseRdString("rustdesk://123456789/r")).toMatchObject({ host: "123456789", options: { rustdesk_relay: true } });
    expect(parseRdString("rustdesk://123456789@rd.example.com")).toMatchObject({ host: "123456789", options: { rustdesk_server: "rd.example.com" } });
    expect(parseRdString("rustdesk://123456789/r@rd.example.com:21116")).toMatchObject({
      host: "123456789", options: { rustdesk_relay: true, rustdesk_server: "rd.example.com:21116" },
    });
  });

  it("connect/<id>?password=&relay=&key=（鍵不分大小寫）", () => {
    expect(parseRdString("rustdesk://connect/123456789?password=s3cr%26t&Relay=1&KEY=abc%3D")).toMatchObject({
      host: "123456789", password: "s3cr&t", options: { rustdesk_relay: true, rustdesk_key: "abc=" },
    });
    expect(parseRdString("rustdesk://123456789?relay")!.options.rustdesk_relay).toBe(true);
    expect(parseRdString("rustdesk://123456789?relay=false")!.options.rustdesk_relay).toBeUndefined();
    expect(parseRdString("rustdesk://123456789?key=k")!.options).toEqual({ rustdesk_key: "k" });
  });

  it("connection/new/<id>（舊版）", () => {
    expect(parseRdString("rustdesk://connection/new/987654321?password=pw")).toMatchObject({ host: "987654321", password: "pw" });
    expect(parseRdString("rustdesk://connection/987654321")).toBeNull();
  });

  it("Direct IP 拆出埠", () => {
    expect(parseRdString("rustdesk://192.168.1.5:21118")).toMatchObject({ host: "192.168.1.5", port: 21118 });
    expect(parseRdString("rustdesk://192.168.1.5")).toMatchObject({ host: "192.168.1.5", port: 0 });
  });

  it("其他動作、太短、多段路徑、沒有 ID 不收", () => {
    for (const s of [
      "rustdesk://file-transfer/123456789", "rustdesk://port-forward/123456789", "rustdesk://config/abc",
      "rustdesk://12", "rustdesk://123456789/x/y", "rustdesk://connect/", "rustdesk://", "rustdesk:123456789",
      "rustdesk://123@", "rustdesk:///123",
    ]) {
      expect(parseRdString(s)).toBeNull();
    }
  });
});

describe("parseRdString：不是遠端桌面字串", () => {
  it("回 null", () => {
    for (const s of [
      "", "   ", "ssh://u@h", "sftp://u@h/x", "http://h", "https://h/rdp", "mysql://u@h:3306", "postgres://u:p@h/db",
      "host=h port=5432", "Server=h;Database=d", "10.0.0.1", "123456789", "123 456 789", "some text", "rdp://a\nrdp://b",
    ]) {
      expect(parseRdString(s)).toBeNull();
    }
  });
});

describe("looksLikeRdString", () => {
  it("scheme / mstsc / MS 格式", () => {
    for (const s of ["rdp://h", " VNC://h", "rustdesk://1234", "mstsc /v:h", "mstsc.exe", "full address=s:h", "a=i:1&full%20address=s:h", '"rdp://h"']) {
      expect(looksLikeRdString(s)).toBe(true);
    }
    for (const s of ["", "ssh://h", "h:3389", "123456789", "mstscx /v:h", "http://h?full address"]) {
      expect(looksLikeRdString(s)).toBe(false);
    }
  });
});

describe("splitDomainUser", () => {
  it("DOMAIN\\user、.\\user、UPN", () => {
    expect(splitDomainUser("CORP\\alice")).toEqual({ domain: "CORP", username: "alice" });
    expect(splitDomainUser(".\\admin")).toEqual({ domain: ".", username: "admin" });
    expect(splitDomainUser("a@b.com")).toEqual({ domain: "", username: "a@b.com" });
  });
});

describe("applyRdString", () => {
  const base = () => {
    const s = blankRdSession("id1", "rdp", "f1");
    s.username = "keep";
    s.domain = "OLD";
    s.port = 4000;
    s.via_ssh_session_id = "ssh1";
    s.options.ui = { theme: "x", fullscreen: "1" };
    return s;
  };

  it("協定 / 主機 / 埠用字串的；密碼不進 session；id / 資料夾 / via_ssh 保留", () => {
    const next = applyRdString(base(), parseRdString("rdp://u:pw@h")!);
    expect(next).toMatchObject({ id: "id1", folder_id: "f1", via_ssh_session_id: "ssh1", protocol: "rdp", host: "h", port: 0, username: "u", domain: "" });
    expect(JSON.stringify(next)).not.toContain("pw");
  });

  it("沒帶帳號：同協定保留帳號 / 網域；換協定就清掉", () => {
    expect(applyRdString(base(), parseRdString("rdp://h")!)).toMatchObject({ username: "keep", domain: "OLD" });
    expect(applyRdString(base(), parseRdString("vnc://h")!)).toMatchObject({ protocol: "vnc", username: "", domain: "" });
    expect(applyRdString(base(), parseRdString("rdp://CORP%5Cbob@h")!)).toMatchObject({ username: "bob", domain: "CORP" });
  });

  it("名稱只在還沒取名時填", () => {
    const p = parseRdString("vnc://h?ConnectionName=Lab")!;
    expect(applyRdString(base(), p).name).toBe("Lab");
    expect(applyRdString({ ...base(), name: "Mine" }, p).name).toBe("Mine");
  });

  it("選項只覆寫提到的；ui 逐鍵合併；不改 base", () => {
    const b = base();
    const next = applyRdString(b, parseRdString("rdp://full%20address=s:h&screen%20mode%20id=i:1&session%20bpp=i:16")!);
    expect(next.options).toEqual({ ...b.options, color_depth: 16, ui: { theme: "x", fullscreen: "0" } });
    expect(b.options.ui).toEqual({ theme: "x", fullscreen: "1" });
    expect(b.host).toBe("");
  });

  it("RustDesk 選項", () => {
    const next = applyRdString(base(), parseRdString("rustdesk://123456789/r@srv?key=K")!);
    expect(next).toMatchObject({ protocol: "rustdesk", host: "123456789", username: "", domain: "" });
    expect(next.options).toMatchObject({ rustdesk_relay: true, rustdesk_server: "srv", rustdesk_key: "K" });
  });
});

describe("parseRustdeskServerConfig", () => {
  // 照 RustDesk 的 ServerConfig.encode：base64Url(JSON)，再整串倒過來。
  const encode = (o: object) => [...btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_")].reverse().join("");
  const cfg = { host: "proxy.example.com", relay: "relay.example.com:21117", api: "", key: "mpTh+jqLYRIiUxay7yPv9Mo+1eB7MIxHRbyRSe0000=" };

  it("解開匯出字串（倒過來的 base64，含 URL-safe 字元與 =）", () => {
    const s = encode(cfg);
    expect(s.endsWith("Jye")).toBe(true); // 倒過來的 `{"` = eyJ
    expect(parseRustdeskServerConfig(s)).toEqual(cfg);
    expect(parseRustdeskServerConfig(`  ${s}\n`)).toEqual(cfg);
    expect(parseRustdeskServerConfig(s.replace(/^=+/, ""))).toEqual(cfg);
  });

  it("也收 JSON 本身（舊版格式）", () => {
    expect(parseRustdeskServerConfig(JSON.stringify({ host: "h", key: "k" }))).toEqual({ host: "h", relay: "", api: "", key: "k" });
  });

  it("不是設定就回 null（一般主機名、ID、亂碼、沒有 host 的 JSON）", () => {
    for (const s of ["proxy.example.com", "123456789", "", "!!!", "abc def", encode({ foo: 1 }), JSON.stringify({ host: "", key: "" }), "[1]"]) {
      expect(parseRustdeskServerConfig(s)).toBeNull();
    }
  });
});
