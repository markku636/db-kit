import { describe, expect, it } from "vitest";
import { dockerItemMenu } from "./dockerMenus";
import { t } from "./i18n";
import type { ConnectionConfig } from "./api";

function containerMenu(objKind: string) {
  const nodes = dockerItemMenu({
    conn: {} as ConnectionConfig,
    db: "containers",
    name: "c1",
    objKind,
    readonly: false,
    open: () => {},
    refresh: () => {},
    pull: () => {},
  });
  return nodes.filter((n) => n.kind === "item").map((n) => (n as { label: string }).label);
}

describe("dockerItemMenu", () => {
  it("restarting 容器不提供無法執行的 Shell / 暫停，但可停止與重啟", () => {
    const labels = containerMenu("container-restarting");
    expect(labels).not.toContain(t("Shell…"));
    expect(labels).not.toContain(t("暫停"));
    expect(labels).toContain(t("停止"));
    expect(labels).toContain(t("重新啟動"));
    expect(labels).toContain(t("強制終止"));
  });

  it("running 容器仍提供 Shell 與暫停", () => {
    const labels = containerMenu("container-running");
    expect(labels).toContain(t("Shell…"));
    expect(labels).toContain(t("暫停"));
  });
});
