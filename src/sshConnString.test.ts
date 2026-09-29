import { describe, expect, it } from "vitest";
import { applySshString, parseSshString, resolveSftpDir, type ParsedSsh, type SshFormFields } from "./sshConnString";

const pick = (p: ParsedSsh | null) =>
  p && { protocol: p.protocol, host: p.host, port: p.port, username: p.username, password: p.password, identityFile: p.identityFile, jump: p.jump, path: p.path };

describe("parseSshString：URL", () => {
  it("ssh://user@host:port", () => {
    expect(pick(parseSshString("ssh://deploy@10.0.0.12:2222"))).toEqual({
      protocol: "ssh", host: "10.0.0.12", port: 2222, username: "deploy", password: null, identityFile: null, jump: null, path: null,
    });
    expect(pick(parseSshString("ssh://web.example.com"))).toMatchObject({ host: "web.example.com", port: null, username: null });
  });

  it("帳密解碼、;fingerprint 參數略過、大小寫不拘", () => {
    expect(pick(parseSshString("SSH://a%40corp:p%3Ass@h"))).toMatchObject({ username: "a@corp", password: "p:ss", host: "h" });
    expect(pick(parseSshString("ssh://root;fingerprint=ssh-rsa-2c-3f@h:22"))).toMatchObject({ username: "root", password: null, port: 22 });
  });

  it("IPv6 要中括號", () => {
    expect(pick(parseSshString("ssh://u@[fe80::1]:2200"))).toMatchObject({ host: "fe80::1", port: 2200 });
  });

  it("sftp:// 帶路徑；/~/ 是家目錄底下；scp:// 當 sftp", () => {
    expect(pick(parseSshString("sftp://u@h/var/www/html"))).toMatchObject({ protocol: "sftp", path: "/var/www/html" });
    expect(pick(parseSshString("sftp://u@h/~/logs"))).toMatchObject({ path: "~/logs" });
    expect(pick(parseSshString("sftp://u@h/"))).toMatchObject({ path: null });
    expect(pick(parseSshString("sftp://u@h/a%20b?x=1"))).toMatchObject({ path: "/a b" });
    expect(pick(parseSshString("scp://u@h:2022/tmp"))).toMatchObject({ protocol: "sftp", port: 2022, path: "/tmp" });
    // ssh:// 的路徑沒有意義，不收
    expect(pick(parseSshString("ssh://u@h/tmp"))).toMatchObject({ protocol: "ssh", path: null });
  });

  it("引號、提示字元剝掉", () => {
    expect(pick(parseSshString('"ssh://u@h"'))).toMatchObject({ host: "h" });
    expect(pick(parseSshString("$ ssh u@h"))).toMatchObject({ host: "h", username: "u" });
  });

  it("壞的埠號 / 空主機 / 多行不收", () => {
    expect(parseSshString("ssh://u@h:99999")).toBeNull();
    expect(parseSshString("ssh://u@h:abc")).toBeNull();
    expect(parseSshString("ssh://u@")).toBeNull();
    expect(parseSshString("ssh://u@h\nssh://v@g")).toBeNull();
  });
});

describe("parseSshString：指令", () => {
  it("ssh -p / -l / -i / -J", () => {
    expect(pick(parseSshString("ssh -p 2222 -i ~/.ssh/id_ed25519 -J bastion deploy@10.0.0.5"))).toEqual({
      protocol: "ssh", host: "10.0.0.5", port: 2222, username: "deploy", password: null, identityFile: "~/.ssh/id_ed25519", jump: "bastion", path: null,
    });
    expect(pick(parseSshString("ssh -l admin h"))).toMatchObject({ username: "admin", host: "h" });
  });

  it("選項黏著寫、旗標合併、寫在目的地後面、後面接遠端指令", () => {
    expect(pick(parseSshString("ssh -p2222 -AXt u@h"))).toMatchObject({ port: 2222, host: "h" });
    expect(pick(parseSshString("ssh -tp 2200 u@h"))).toMatchObject({ port: 2200 });
    expect(pick(parseSshString("ssh u@h -p 2222"))).toMatchObject({ port: 2222 });
    expect(pick(parseSshString("ssh u@h sudo -i"))).toMatchObject({ host: "h", identityFile: null });
    expect(pick(parseSshString("ssh -L 8080:localhost:80 u@h"))).toMatchObject({ host: "h", port: null });
  });

  it("-o Port / User / IdentityFile / ProxyJump", () => {
    expect(pick(parseSshString('ssh -o Port=2022 -o "User ops" -oIdentityFile=C:\\Users\\me\\.ssh\\id_rsa -o ProxyJump=a,ops@b:2200 h'))).toMatchObject({
      port: 2022, username: "ops", identityFile: "C:\\Users\\me\\.ssh\\id_rsa", jump: "ops@b:2200",
    });
  });

  it("Windows 路徑的反斜線原樣保留；引號可包空白", () => {
    expect(pick(parseSshString('ssh.exe -i "C:\\My Keys\\id" u@h'))).toMatchObject({ identityFile: "C:\\My Keys\\id" });
  });

  it("ssh host:port 的手誤照字面接下來", () => {
    expect(pick(parseSshString("ssh root@10.0.0.1:2222"))).toMatchObject({ host: "10.0.0.1", port: 2222 });
  });

  it("sftp：-P 是埠、-l 是頻寬、host:path 是路徑", () => {
    expect(pick(parseSshString("sftp -P 2022 -l 800 u@h:/srv/data"))).toEqual({
      protocol: "sftp", host: "h", port: 2022, username: "u", password: null, identityFile: null, jump: null, path: "/srv/data",
    });
    expect(pick(parseSshString("sftp u@h:logs"))).toMatchObject({ path: "~/logs" });
    expect(pick(parseSshString("sftp sftp://u@h:2022/x"))).toMatchObject({ port: 2022, path: "/x" });
  });

  it("沒有目的地 / 選項缺參數 / 引號沒關不收", () => {
    expect(parseSshString("ssh -v")).toBeNull();
    expect(parseSshString("ssh -p")).toBeNull();
    expect(parseSshString("ssh -p x u@h")).toBeNull();
    expect(parseSshString('ssh -i "C:\\k u@h')).toBeNull();
  });
});

describe("parseSshString：沒有 scheme 的主機字串", () => {
  it("預設不收（新增連線對話框不能猜）", () => {
    expect(parseSshString("root@10.0.0.1")).toBeNull();
    expect(parseSshString("10.0.0.1:2222")).toBeNull();
  });

  it("bare：user@host[:port]、host:port、[v6]:port", () => {
    expect(pick(parseSshString("root@10.0.0.1:2222", { bare: true }))).toMatchObject({ protocol: "ssh", host: "10.0.0.1", port: 2222, username: "root" });
    expect(pick(parseSshString("web-01:2200", { bare: true }))).toMatchObject({ host: "web-01", port: 2200, username: null });
    expect(pick(parseSshString("[::1]:22", { bare: true }))).toMatchObject({ host: "::1", port: 22 });
  });

  it("bare 也不攔：單純主機名、裸 IPv6、git 遠端、帳密寫法、句子", () => {
    for (const s of ["10.0.0.1", "web.example.com", "fe80::1", "git@github.com:org/repo.git", "u:p@h", "some text", ""]) {
      expect(parseSshString(s, { bare: true })).toBeNull();
    }
  });

  it("ftp:// 不加密、ftpes:// explicit TLS、ftps:// implicit TLS；都帶路徑", () => {
    expect(pick(parseSshString("ftp://anonymous@ftp.example.com/pub"))).toMatchObject({ protocol: "ftp", host: "ftp.example.com", username: "anonymous", path: "/pub" });
    expect(pick(parseSshString("FTPES://u:p%40ss@h:2121"))).toMatchObject({ protocol: "ftpes", password: "p@ss", port: 2121, path: null });
    expect(pick(parseSshString("ftps://h/"))).toMatchObject({ protocol: "ftps", port: null, path: null });
    expect(parseSshString("ftp://")).toBeNull();
  });

  it("資料庫連線字串不是 SSH", () => {
    for (const s of ["postgres://u:p@h/db", "mysql://u@h:3306", "host=h port=5432", "Server=h;Database=d"]) {
      expect(parseSshString(s)).toBeNull();
      expect(parseSshString(s, { bare: true })).toBeNull();
    }
  });
});

describe("applySshString", () => {
  const cur: SshFormFields = {
    protocol: "ssh", ftpTls: "explicit", host: "", port: 2222, username: "keep", auth: "agent", password: "", keyPath: "", jumpId: "", openSftp: false, sftpDir: "",
  };
  const hosts = [{ id: "j1", name: "bastion", host: "10.0.0.1", username: "ops", port: 22 }];

  it("字串沒提到的欄位保留現值", () => {
    const { next } = applySshString(parseSshString("ssh://h")!, cur, []);
    expect(next).toEqual({ ...cur, host: "h" });
  });

  it("密碼 → 密碼認證；私鑰檔 → 私鑰認證", () => {
    expect(applySshString(parseSshString("ssh://u:pw@h")!, cur, []).next).toMatchObject({ auth: "password", password: "pw", username: "u" });
    expect(applySshString(parseSshString("ssh -i /k/id u@h")!, cur, []).next).toMatchObject({ auth: "key", keyPath: "/k/id" });
  });

  it("跳板機對到已存主機（名稱或 user@host）；對不到就回報、保留原值", () => {
    expect(applySshString(parseSshString("ssh -J bastion u@h")!, cur, hosts)).toMatchObject({ next: { jumpId: "j1" }, jumpMissing: null });
    expect(applySshString(parseSshString("ssh -J ops@10.0.0.1 u@h")!, cur, hosts).next.jumpId).toBe("j1");
    expect(applySshString(parseSshString("ssh -J nobody@x u@h")!, { ...cur, jumpId: "old" }, hosts)).toMatchObject({ next: { jumpId: "old" }, jumpMissing: "nobody@x" });
  });

  it("sftp → 開啟時展開 SFTP，帶路徑就當起始資料夾；ssh 不會把 SFTP 關掉", () => {
    expect(applySshString(parseSshString("sftp://u@h/srv")!, cur, []).next).toMatchObject({ openSftp: true, sftpDir: "/srv" });
    expect(applySshString(parseSshString("ssh://u@h")!, { ...cur, openSftp: true }, []).next.openSftp).toBe(true);
  });
});

describe("applySshString：FTP", () => {
  const ssh: SshFormFields = {
    protocol: "ssh", ftpTls: "explicit", host: "", port: 22, username: "", auth: "password", password: "", keyPath: "", jumpId: "", openSftp: false, sftpDir: "",
  };

  it("有 scheme 的字串決定協定；沒帶埠號就換成新協定的預設埠", () => {
    expect(applySshString(parseSshString("ftp://h")!, ssh, []).next).toMatchObject({ protocol: "ftp", ftpTls: "none", port: 21 });
    expect(applySshString(parseSshString("ftps://h")!, ssh, []).next).toMatchObject({ protocol: "ftp", ftpTls: "implicit", port: 990 });
    expect(applySshString(parseSshString("ftpes://h:2121/srv")!, ssh, []).next).toMatchObject({ protocol: "ftp", ftpTls: "explicit", port: 2121, sftpDir: "/srv" });
    const ftp = { ...ssh, protocol: "ftp" as const, port: 21 };
    expect(applySshString(parseSshString("ssh://h")!, ftp, []).next).toMatchObject({ protocol: "ssh", port: 22 });
    expect(applySshString(parseSshString("ftpes://h")!, ftp, []).next.port, "協定與加密都沒變 → 埠不動").toBe(21);
  });

  it("主機欄的 user@host:port 看不出協定：不改協定", () => {
    const ftp = { ...ssh, protocol: "ftp" as const, ftpTls: "none" as const, port: 21 };
    expect(applySshString(parseSshString("u@h:2121", { bare: true })!, ftp, []).next).toMatchObject({ protocol: "ftp", ftpTls: "none", port: 2121, username: "u" });
    expect(applySshString(parseSshString("u@h", { bare: true })!, ftp, []).next.protocol).toBe("ftp");
  });
});

describe("resolveSftpDir", () => {
  it("空 / ~ = 家目錄；~/x 與相對路徑接在家目錄下；絕對路徑原樣", () => {
    expect(resolveSftpDir("", "/home/u")).toBe("/home/u");
    expect(resolveSftpDir(null, "")).toBe("/");
    expect(resolveSftpDir("~", "/home/u")).toBe("/home/u");
    expect(resolveSftpDir("~/logs", "/home/u")).toBe("/home/u/logs");
    expect(resolveSftpDir("logs", "/")).toBe("/logs");
    expect(resolveSftpDir(" /srv/www ", "/home/u")).toBe("/srv/www");
  });
});
