import { describe, expect, it } from "vitest";
import type { ConnectionConfig } from "./api";
import { mergeSavedConnections } from "./connFileSync";

const conn = (id: string, extra: Partial<ConnectionConfig> = {}) =>
  ({ id, name: id, kind: "mysql", host: "h", port: 3306, username: "u", ...extra }) as ConnectionConfig;

describe("mergeSavedConnections", () => {
  it("以磁碟為準：CLI 新增的出現、刪掉的消失、順序跟檔案走", () => {
    const mem = [conn("a"), conn("b")];
    const saved = [conn("b"), conn("c")];
    expect(mergeSavedConnections(mem, saved).map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("記憶體中的密碼等 secret 保留，非機密欄位用磁碟的新值", () => {
    const mem = [conn("a", { password: "typed", ssh_password: "sp", host: "old" } as Partial<ConnectionConfig>)];
    const saved = [conn("a", { host: "new" })];
    const [m] = mergeSavedConnections(mem, saved);
    expect(m.password).toBe("typed");
    expect((m as ConnectionConfig & { ssh_password?: string }).ssh_password).toBe("sp");
    expect(m.host).toBe("new");
  });

  it("磁碟上已沒有群組的連線，記憶體的舊 group_id 不殘留", () => {
    const [m] = mergeSavedConnections([conn("a", { group_id: "g1" })], [conn("a")]);
    expect(m.group_id).toBeNull();
  });

  it("新連線的 password 補成空字串（store 慣例）", () => {
    const [m] = mergeSavedConnections([], [conn("x")]);
    expect(m.password).toBe("");
  });
});
