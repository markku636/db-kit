import { describe, it, expect } from "vitest";
import { sessionLabel, groupSessions, filterSessions, uniqueFolderName, sessionsToPlacements } from "./sshSessions";
import { blankSshSession, type SshFolder, type SshSession } from "./sshTypes";

const mk = (id: string, patch: Partial<SshSession>): SshSession => ({ ...blankSshSession(id), ...patch });
const folder = (id: string, name: string, parent_id: string | null = null): SshFolder => ({ id, name, parent_id });

describe("sessionLabel", () => {
  it("有名稱用名稱，否則 user@host；沒有 user 就只有 host", () => {
    expect(sessionLabel(mk("a", { name: "prod-web", username: "deploy", host: "10.0.0.1" }))).toBe("prod-web");
    expect(sessionLabel(mk("a", { name: "  ", username: "deploy", host: "10.0.0.1" }))).toBe("deploy@10.0.0.1");
    expect(sessionLabel(mk("a", { name: "", username: "", host: "10.0.0.1" }))).toBe("10.0.0.1");
  });
});

describe("groupSessions", () => {
  const folders = [folder("f2", "Staging"), folder("f1", "PROD"), folder("empty", "Empty")];
  const sessions = [
    mk("s1", { name: "web-10", folder_id: "f1" }),
    mk("s2", { name: "web-2", folder_id: "f1" }),
    mk("s3", { name: "Bastion", folder_id: null }),
    mk("s4", { name: "api", folder_id: "f2" }),
    mk("s5", { name: "", username: "root", host: "zeta", folder_id: "gone" }),
    mk("s6", { name: "alpha", folder_id: null }),
  ];

  it("資料夾順序照 folders；組內依顯示名稱不分大小寫、數字自然序；空資料夾保留", () => {
    const g = groupSessions(folders, sessions);
    expect(g.groups.map((x) => x.folder.id)).toEqual(["f2", "f1", "empty"]);
    expect(g.groups[1].sessions.map((s) => s.name)).toEqual(["web-2", "web-10"]);
    expect(g.groups[0].sessions.map((s) => s.id)).toEqual(["s4"]);
    expect(g.groups[2].sessions).toEqual([]);
  });

  it("folder_id 為 null 或指到不存在的資料夾 → 未分類", () => {
    const g = groupSessions(folders, sessions);
    expect(g.loose.map((s) => s.id)).toEqual(["s6", "s3", "s5"]);
  });

  it("不改動輸入陣列", () => {
    const copy = sessions.map((s) => ({ ...s }));
    groupSessions(folders, sessions);
    expect(sessions).toEqual(copy);
  });
});

describe("filterSessions", () => {
  const sessions = [
    mk("a", { name: "prod-web", host: "10.0.0.1", username: "deploy" }),
    mk("b", { name: "Bastion", host: "bastion.example.com", username: "ops" }),
    mk("c", { name: "", host: "192.168.1.5", username: "root" }),
  ];

  it("比對名稱 / 主機 / 使用者，不分大小寫、忽略前後空白", () => {
    expect(filterSessions(sessions, "PROD").map((s) => s.id)).toEqual(["a"]);
    expect(filterSessions(sessions, "  example ").map((s) => s.id)).toEqual(["b"]);
    expect(filterSessions(sessions, "root").map((s) => s.id)).toEqual(["c"]);
    expect(filterSessions(sessions, "192.168").map((s) => s.id)).toEqual(["c"]);
    expect(filterSessions(sessions, "nope")).toEqual([]);
  });

  it("空查詢回原陣列", () => {
    expect(filterSessions(sessions, "")).toBe(sessions);
    expect(filterSessions(sessions, "   ")).toBe(sessions);
  });
});

describe("uniqueFolderName", () => {
  const folders = [folder("1", "PROD"), folder("2", "prod 2"), folder("3", "Staging")];

  it("沒撞名就用原名（去前後空白）", () => {
    expect(uniqueFolderName(folders, " Dev ")).toBe("Dev");
    expect(uniqueFolderName([], "PROD")).toBe("PROD");
  });

  it("撞名（不分大小寫）就補 2、3…並跳過已被佔用的", () => {
    expect(uniqueFolderName(folders, "prod")).toBe("prod 3");
    expect(uniqueFolderName(folders, "Staging")).toBe("Staging 2");
  });

  it("空名稱給預設", () => {
    expect(uniqueFolderName(folders, "  ")).toBe("新資料夾");
  });
});

describe("sessionsToPlacements", () => {
  it("每個 session 對應 { id, folder_id }（undefined 視為 null）", () => {
    const s = [mk("a", { folder_id: "f1" }), mk("b", { folder_id: null })];
    (s[1] as unknown as { folder_id?: string | null }).folder_id = undefined;
    expect(sessionsToPlacements(s)).toEqual([
      { id: "a", folder_id: "f1" },
      { id: "b", folder_id: null },
    ]);
  });
});
