import { describe, expect, it } from "vitest";
import { pullRef, registryHost, scanInProgress, scanSummary, severityTone, shortDigest } from "./registryModel";
import type { HarborScan } from "./registryTypes";

const scan = (over: Partial<HarborScan>): HarborScan => ({
  status: "Success", severity: "High", total: 0, fixable: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
  end_time: "", complete_percent: 100, scanner: "Trivy", ...over,
});

describe("registryModel", () => {
  it("registryHost 去掉預設埠、保留其他埠", () => {
    expect(registryHost("https://harbor.corp:443/sub")).toBe("harbor.corp");
    expect(registryHost("http://localhost:5000")).toBe("localhost:5000");
    expect(registryHost("http://reg:80")).toBe("reg");
    expect(registryHost("https://[fd00::1]:8443")).toBe("[fd00::1]:8443");
  });

  it("pullRef：tag 用冒號、digest 用 @（不限 sha256）", () => {
    expect(pullRef("h", "lib/app", "1.0")).toBe("h/lib/app:1.0");
    expect(pullRef("h", "app", "sha256:abc")).toBe("h/app@sha256:abc");
    expect(pullRef("h", "app", "sha512:abc")).toBe("h/app@sha512:abc");
    // 含 colon 的 tag 在 Docker 不成立，不會被當 digest 的 ref 才加冒號。
  });

  it("shortDigest 保留演算法前綴，不憑空補 sha256", () => {
    expect(shortDigest("sha256:0123456789abcdef0123")).toBe("sha256:0123456789ab");
    expect(shortDigest("sha256:ab")).toBe("sha256:ab");
    expect(shortDigest("sha512:abcdef0123456789")).toBe("sha512:abcdef012345");
    expect(shortDigest("0123456789abcdef0123")).toBe("0123456789ab");
  });

  it("嚴重度色調與摘要", () => {
    expect(severityTone("Critical")).toBe("danger");
    expect(severityTone("Medium")).toBe("warning");
    expect(severityTone("None")).toBe("success");
    expect(scanSummary(scan({ critical: 1, high: 2, low: 3 }))).toBe("C1 H2 L3");
    expect(scanSummary(scan({}))).toBe("");
    expect(scanInProgress(scan({ status: "Running" }))).toBe(true);
    // Harbor 實際回的 Queued / Scanning 之前被當成已完成，還會誤顯示綠色「無弱點」。
    expect(scanInProgress(scan({ status: "Queued" }))).toBe(true);
    expect(scanInProgress(scan({ status: "scanning" }))).toBe(true);
    expect(scanInProgress(scan({ status: "Success" }))).toBe(false);
    expect(scanInProgress(scan({ status: "Error" }))).toBe(false);
    expect(scanInProgress(null)).toBe(false);
  });
});
