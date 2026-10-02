import { describe, expect, it } from "vitest";
import {
  classifyInput, entryHost, isSecretPrompt, logicalEnd, logicalStart, pickLater, rangeFor, readSpan, redactSecrets,
  stripPrompt, textBeforeCursor, toCsv, type BufLike, type SshOpEntry,
} from "./sshOpLog";

/** 假的 xterm buffer：每列固定寬度（補空白），`wrapped` = 這列是上一列自動折下來的。 */
function fakeBuf(rows: { text: string; wrapped?: boolean }[], cols = 20): BufLike {
  return {
    length: rows.length,
    getLine: (y) => {
      const r = rows[y];
      if (!r) return undefined;
      const full = r.text.padEnd(cols, " ");
      return {
        isWrapped: !!r.wrapped,
        translateToString: (trimRight?: boolean, start = 0, end = cols) => {
          const s = full.slice(start, end);
          return trimRight ? s.replace(/\s+$/, "") : s;
        },
      };
    },
  };
}

describe("isSecretPrompt", () => {
  it.each([
    "[sudo] password for mark: ",
    "mark@web01's password: ",
    "Password:",
    "Enter passphrase for key '/home/mark/.ssh/id_ed25519': ",
    "Enter PEM pass phrase:",
    "Password for user postgres: ",
    "Enter password: ",
    "New password: ",
    "Retype new password: ",
    "(current) UNIX password: ",
    "Vault password: ",
    "Verification code: ",
    "Enter PIN for 'yubikey':",
    "請輸入密碼：",
    "密码：",
    "Password: ****",
    "Enter host password for user 'bob':",
  ])("認得：%s", (s) => expect(isSecretPrompt(s)).toBe(true));

  it.each([
    "mark@web01:~$ ",
    "[root@db ~]# ",
    "mysql> ",
    "Username: ",
    "Do you want to continue? [Y/n] ",
    "Last password change: Jan 01, 2026",
    "user@pinbox:~$ ",
    "~/secret-project$ ",
    "Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
  ])("不是密碼提示：%s", (s) => expect(isSecretPrompt(s)).toBe(false));
});

describe("redactSecrets", () => {
  it.each([
    ["mysql -uroot -pS3cr3t! shop", "mysql -uroot -p*** shop"],
    ["mysqldump -h db -u app -pabc --all-databases", "mysqldump -h db -u app -p*** --all-databases"],
    ["mysql --password=hunter2 -h db", "mysql --password=*** -h db"],
    ["mysql --password hunter2 -h db", "mysql --password *** -h db"],
    ["PGPASSWORD=pg123 psql -h db -U app", "PGPASSWORD=*** psql -h db -U app"],
    ["export MYSQL_PWD='a b c'", "export MYSQL_PWD=***"],
    ["export API_TOKEN=abcd1234", "export API_TOKEN=***"],
    ["AWS_SECRET_ACCESS_KEY=xyz aws s3 ls", "AWS_SECRET_ACCESS_KEY=*** aws s3 ls"],
    ["psql postgresql://app:pg%40pw@db:5432/shop", "psql postgresql://app:***@db:5432/shop"],
    ["redis-cli -u redis://:r3d1s@cache:6379 ping", "redis-cli -u redis://:***@cache:6379 ping"],
    ["git clone https://bob:ghp_short@github.com/x/y.git", "git clone https://bob:***@github.com/x/y.git"],
    ["curl -u admin:adm1n https://api/x", "curl -u admin:*** https://api/x"],
    ["curl -H 'Authorization: Bearer eyJhbGciOi.abc' https://api", "curl -H 'Authorization: Bearer ***' https://api"],
    ["curl -H \"X-Api-Key: k123\" https://api", "curl -H \"X-Api-Key: ***\" https://api"],
    ["curl -d '{\"user\":\"a\",\"password\":\"b\"}' https://api", "curl -d '{\"user\":\"a\",\"password\":\"***\"}' https://api"],
    ["curl -d 'user=a&password=b' https://api", "curl -d 'user=a&password=***' https://api"],
    ["wget 'https://x/dl?token=abc&id=1'", "wget 'https://x/dl?token=***&id=1'"],
    ["sshpass -p 'pa ss' ssh bob@h", "sshpass -p *** ssh bob@h"],
    ["sshpass -ppass ssh bob@h", "sshpass -p *** ssh bob@h"],
    ["redis-cli -h cache -a r3d1s get k", "redis-cli -h cache -a *** get k"],
    ["mongosh -u admin -p m0ng0 --host db", "mongosh -u admin -p *** --host db"],
    ["docker login -u bob -p dk123 registry.lan", "docker login -u bob -p *** registry.lan"],
    ["echo 'S3cr3t' | sudo -S apt update", "echo *** | sudo -S apt update"],
    ["echo 'bob:pw' | chpasswd", "echo *** | chpasswd"],
    ["echo pw | passwd --stdin bob", "echo *** | passwd --stdin bob"],
    ["htpasswd -b /etc/nginx/.htpasswd bob s3cret", "htpasswd -b /etc/nginx/.htpasswd bob ***"],
    ["keytool -list -keystore k.jks -storepass changeit", "keytool -list -keystore k.jks -storepass ***"],
    ["openssl pkcs12 -in a.p12 -passin pass:abc", "openssl pkcs12 -in a.p12 -passin pass:***"],
    ["openssl enc -aes256 -pass pass:'a b' -in x", "openssl enc -aes256 -pass *** -in x"],
    ["mysql -uroot -p'my pw' shop", "mysql -uroot -p*** shop"],
    ["kubectl create secret generic db --from-literal=password=abc", "kubectl create secret generic db --from-literal=password=***"],
    ["export GH=ghp_abcdefghijklmnopqrstuvwx1234", "export GH=***"],
    ["claude --key sk-ant-api03-abcdefghijklmnopqrstuv", "claude --key ***"],
  ])("%s", (input, want) => expect(redactSecrets(input)).toBe(want));

  it.each([
    "ls -la /var/www",
    "ssh -p 2222 bob@h",
    "mkdir -p /opt/app/logs",
    "cp -p a b",
    "mysql -uroot -p",
    "mysql -h db -P 3306 -p shop",
    "passwd bob",
    "grep -r password /etc/app.conf",
    "git commit -m 'update password docs'",
    "docker login --password-stdin -u bob",
    "systemctl restart nginx",
    "ssh://bob@host:22",
    "curl http://host:8080/path@x",
    "echo hello | grep h",
    "tar -czf backup.tar.gz /srv --exclude=*.tmp",
    "cd ~/secret-project",
    "./bypass=1",
  ])("不動：%s", (s) => expect(redactSecrets(s)).toBe(s));

  it("多行逐行處理", () => {
    expect(redactSecrets("db.password=abc\nlog.level=info")).toBe("db.password=***\nlog.level=info");
  });

  it("長行（大量輸出）不會跑很久", () => {
    const nasty = [
      "a.".repeat(20000),
      "-".repeat(40000),
      `mysql ${"x ".repeat(20000)}`,
      `${"password".repeat(4000)}`,
      `${"=".repeat(40000)}`,
      `${"a=".repeat(20000)}`,
      `echo ${"a ".repeat(20000)}`,
    ];
    for (const s of nasty) {
      const t0 = performance.now();
      redactSecrets(s);
      expect(performance.now() - t0).toBeLessThan(300);
    }
  });
});

describe("從畫面讀指令", () => {
  it("logicalStart / logicalEnd 跨自動折行", () => {
    const b = fakeBuf([{ text: "out" }, { text: "$ echo aaaaaaaaaaaaaa" }, { text: "bbbb", wrapped: true }, { text: "next" }]);
    expect(logicalStart(b, 2)).toBe(1);
    expect(logicalStart(b, 1)).toBe(1);
    expect(logicalEnd(b, 1)).toBe(2);
    expect(logicalEnd(b, 3)).toBe(3);
  });

  it("readSpan：從提示符後面讀，折行接起來、真換行用 \\n", () => {
    // 20 欄：`$ echo 1234567890123` 剛好滿、下一列折下來
    const b = fakeBuf([{ text: "$ echo 1234567890123" }, { text: "45", wrapped: true }]);
    expect(readSpan(b, 0, 2, logicalEnd(b, 0))).toBe("echo 123456789012345");
    // 中文放不進最後一格：xterm 留空那一格、字折到下一列——不是空白
    const cjk = fakeBuf([{ text: "$ 中文中" }, { text: "文 ok", wrapped: true }], 6);
    expect(readSpan(cjk, 0, 2, 1)).toBe("中文中文 ok");
    // 折行處剛好是空白也不會被吃掉
    const b2 = fakeBuf([{ text: "$ ls -la /very/long" }, { text: " /second", wrapped: true }], 19);
    expect(readSpan(b2, 0, 2, 1)).toBe("ls -la /very/long /second");
    // bracketed paste 的多行：每列一行
    const b3 = fakeBuf([{ text: "$ for i in 1 2; do" }, { text: "> echo $i" }, { text: "> done" }]);
    expect(readSpan(b3, 0, 2, 2)).toBe("for i in 1 2; do\n> echo $i\n> done");
  });

  it("textBeforeCursor 拿游標前面的提示", () => {
    const b = fakeBuf([{ text: "[sudo] password for" }, { text: " mark: ", wrapped: true }]);
    expect(isSecretPrompt(textBeforeCursor(b, 1, 7))).toBe(true);
  });

  it.each([
    ["mark@web01:~/app$ git pull", "git pull"],
    ["[root@db ~]# systemctl status mysqld", "systemctl status mysqld"],
    ["PS C:\\Users\\mark> dir", "dir"],
    ["mysql> select 1;", "select 1;"],
    [">>> print(1)", "print(1)"],
    ["$ echo a > b", "echo a > b"],
    ["mark@h:~$ ", ""],
    ["SELECT 1;", "SELECT 1;"],
  ])("stripPrompt(%s)", (line, want) => expect(stripPrompt(line)).toBe(want));

  it("pickLater：晚到的回顯補齊才採用", () => {
    expect(pickLater("l", "ls -la")).toBe("ls -la");
    expect(pickLater("", "ls")).toBe("ls");
    expect(pickLater("ls -la", "")).toBe("ls -la");
    expect(pickLater("clear", "mark@h:~$")).toBe("clear");
    expect(pickLater("ls", null)).toBe("ls");
  });
});

describe("classifyInput", () => {
  it("Enter / 按鍵 / 貼上", () => {
    expect(classifyInput("\r")).toEqual({ kind: "enter" });
    expect(classifyInput("a")).toEqual({ kind: "other" });
    expect(classifyInput("\x1b[A")).toEqual({ kind: "other" });
    expect(classifyInput("\x1b\r")).toEqual({ kind: "other" });
    expect(classifyInput("ls -la")).toEqual({ kind: "other" });
    expect(classifyInput("ls\rpwd\rcd /x")).toEqual({ kind: "paste", bracketed: false, lines: ["ls", "pwd"], rest: "cd /x" });
    expect(classifyInput("ls\r")).toEqual({ kind: "paste", bracketed: false, lines: ["ls"], rest: "" });
    expect(classifyInput("\x1b[200~a\rb\x1b[201~")).toEqual({ kind: "paste", bracketed: true, lines: ["a"], rest: "b" });
    expect(classifyInput("\x1b[200~one line\x1b[201~")).toEqual({ kind: "paste", bracketed: true, lines: [], rest: "one line" });
  });

  it("終端機自己的回報不算按鍵", () => {
    for (const s of ["\x1b[12;1R", "\x1b[?1;2c", "\x1b[0n", "\x1b[I", "\x1b[O", "\x1b[<0;10;5M", "\x1b[<0;10;5m", "\x1b]11;rgb:0000/0000/0000\x07", "\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1bP>|xterm.js(6.0.0)\x1b\\"]) {
      expect(classifyInput(s)).toEqual({ kind: "report" });
    }
    // 方向鍵、Home / End、F 鍵照常
    for (const s of ["\x1b[A", "\x1b[H", "\x1bOP", "\x1b[3~"]) expect(classifyInput(s)).toEqual({ kind: "other" });
  });
});

describe("顯示 / 匯出", () => {
  const base: SshOpEntry = {
    ts: new Date(2026, 9, 2, 14, 3, 5).getTime(), kind: "command", proto: "ssh", conn_id: "c", host: "web-01", port: 22,
    user: "deploy", detail: "ls -la", result: "ok",
  };

  it("entryHost 只在非預設 port 時加 :port", () => {
    expect(entryHost(base)).toBe("deploy@web-01");
    expect(entryHost({ ...base, port: 2222 })).toBe("deploy@web-01:2222");
    expect(entryHost({ ...base, proto: "ftp", port: 21 })).toBe("deploy@web-01");
    expect(entryHost({ ...base, user: "" })).toBe("web-01");
  });

  it("toCsv：BOM、跳脫引號 / 逗號 / 換行、擋公式", () => {
    const csv = toCsv(
      [base, { ...base, kind: "upload", detail: "a,b.txt\nc \"d\".txt", target: "/srv", result: "error", message: "=HYPERLINK()" }],
      { header: ["t", "name", "host", "proto", "kind", "detail", "target", "cwd", "source", "result", "message"], kind: (k) => k, result: (r) => r, source: (s) => s },
      () => "Web",
    );
    expect(csv.startsWith("\uFEFFt,name,host")).toBe(true);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("2026-10-02 14:03:05,Web,deploy@web-01,ssh,command,ls -la,,,,ok,");
    expect(csv).toContain('"a,b.txt\nc ""d"".txt"');
    expect(csv).toContain(`"'=HYPERLINK()"`);
  });

  it("rangeFor：今天 / 最近 N 天 / 全部", () => {
    const now = new Date(2026, 9, 2, 15, 0, 0);
    expect(rangeFor(1, now).from).toBe(new Date(2026, 9, 2).getTime());
    expect(rangeFor(7, now).from).toBe(new Date(2026, 8, 26).getTime());
    expect(rangeFor(null, now)).toEqual({ from: null, to: null });
  });
});
