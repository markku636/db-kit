import { describe, expect, it } from "vitest";
import { kindFromHint, mergeDataGripLocal, parseDataGrip, parseDbeaver, parseNcx, parseToolConnections } from "./connImport";

describe("connImport", () => {
  it("DBeaver data-sources.json：欄位、資料夾、SSH 通道", () => {
    const json = JSON.stringify({
      folders: { Prod: {} },
      connections: {
        "mysql8-1": {
          provider: "mysql", driver: "mysql8", name: "shop-prod", folder: "Prod",
          configuration: {
            host: "10.0.0.5", port: "3306", database: "shop", user: "app", type: "prod",
            handlers: { ssh_tunnel: { enabled: true, properties: { host: "bastion", port: 2222, user: "ops" } } },
          },
        },
        "pg-1": { provider: "postgresql", driver: "postgres-jdbc", name: "pg", configuration: { url: "jdbc:postgresql://db:5432/app" } },
        "lite-1": { provider: "generic", driver: "sqlite_jdbc", name: "local", configuration: { database: "C:/data/a.db" } },
      },
    });
    const d = parseDbeaver(json);
    expect(d[0]).toMatchObject({ name: "shop-prod", kind: "mysql", host: "10.0.0.5", port: 3306, username: "app", database: "shop", folder: "Prod" });
    expect(d[0].ssh).toEqual({ host: "bastion", port: 2222, username: "ops" });
    expect(d[1]).toMatchObject({ kind: "postgres", url: "jdbc:postgresql://db:5432/app" });
    expect(d[2]).toMatchObject({ kind: "sqlite", database: "C:/data/a.db" });
  });

  it("DataGrip dataSources.xml + local.xml 的帳號", () => {
    const xml = `<?xml version="1.0"?><project><component name="DataSourceManagerImpl">
      <data-source source="LOCAL" name="reporting &amp; bi" uuid="u-1" group-name="Work">
        <driver-ref>sqlserver.ms</driver-ref><jdbc-url>jdbc:sqlserver://sql01:1433;databaseName=Reporting</jdbc-url>
      </data-source>
      <data-source source="LOCAL" name="maria" uuid="u-2"><driver-ref>mariadb</driver-ref><jdbc-url>jdbc:mariadb://m:3306/x</jdbc-url></data-source>
    </component></project>`;
    const d = parseDataGrip(xml);
    expect(d.map((x) => [x.name, x.kind, x.folder])).toEqual([["reporting & bi", "mssql", "Work"], ["maria", "mariadb", undefined]]);
    const local = `<project><component><data-source name="x" uuid="u-1"><user-name>sa</user-name></data-source></component></project>`;
    expect(mergeDataGripLocal(d, local)[0].username).toBe("sa");
  });

  it(".ncx：種類對照、SQLite 檔案路徑、SSH", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Connections Ver="1.5">
      <Connection ConnectionName="erp" ConnType="MYSQL" Host="erp.local" Port="3307" UserName="root" Password="ABCDEF" SSH="true" SSH_Host="jump" SSH_Port="22" SSH_UserName="me"/>
      <Connection ConnectionName="lite" ConnType="SQLITE" DatabaseFileName="D:\\a.db"/>
    </Connections>`;
    const d = parseNcx(xml);
    expect(d[0]).toMatchObject({ name: "erp", kind: "mysql", host: "erp.local", port: 3307, username: "root", ssh: { host: "jump", port: 22, username: "me" } });
    expect(d[0]).not.toHaveProperty("password");
    expect(d[1]).toMatchObject({ kind: "sqlite", database: "D:\\a.db" });
  });

  it("parseToolConnections 依內容判斷格式；認不得丟錯", () => {
    expect(parseToolConnections("x.ncx", "<Connections></Connections>").source).toBe("ncx");
    expect(parseToolConnections("dataSources.xml", "<project><data-source name='a'></data-source></project>").source).toBe("datagrip");
    expect(parseToolConnections("data-sources.json", '{"connections":{}}').source).toBe("dbeaver");
    expect(() => parseToolConnections("a.txt", "hello")).toThrow();
    expect(kindFromHint(undefined, "jdbc:oracle:thin:@h:1521/svc")).toBe("oracle");
  });
});
