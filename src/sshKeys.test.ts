import { describe, expect, it } from "vitest";
import {
  certForever, certTone, defaultKeyName, isKeystoreRef, keyTypeLabel, keystoreId, keystoreRef, sessionsUsingKey, shortFingerprint, sortStoredKeys,
} from "./sshKeys";
import { blankSshSession, type SshCertInfo, type SshStoredKey } from "./sshTypes";

describe("金鑰庫參照", () => {
  it("keystore:<id> 來回", () => {
    expect(keystoreRef("abc-1")).toBe("keystore:abc-1");
    expect(isKeystoreRef(" keystore:abc-1 ")).toBe(true);
    expect(keystoreId("keystore:abc-1")).toBe("abc-1");
    expect(keystoreId("keystore:")).toBeNull();
    expect(keystoreId("C:\\Users\\me\\.ssh\\id_ed25519")).toBeNull();
    expect(isKeystoreRef("")).toBe(false);
  });

  it("找出用了這把金鑰的主機（只算私鑰認證）", () => {
    const a = { ...blankSshSession("a"), auth: "key" as const, private_key_path: "keystore:k1" };
    const b = { ...blankSshSession("b"), auth: "key" as const, private_key_path: "C:/id" };
    const c = { ...blankSshSession("c"), auth: "password" as const, private_key_path: "keystore:k1" };
    expect(sessionsUsingKey([a, b, c], "k1").map((s) => s.id)).toEqual(["a"]);
  });
});

describe("顯示用標籤", () => {
  it("演算法名稱", () => {
    expect(keyTypeLabel("ssh-ed25519", 256)).toBe("Ed25519");
    expect(keyTypeLabel("ssh-rsa", 3072)).toBe("RSA 3072");
    expect(keyTypeLabel("ecdsa-sha2-nistp384", 384)).toBe("ECDSA P-384");
    expect(keyTypeLabel("sk-ssh-ed25519@openssh.com", null)).toBe("Ed25519-SK (FIDO)");
    expect(keyTypeLabel("ssh-dss", 1024)).toBe("DSA");
  });

  it("指紋縮短但保留前綴", () => {
    expect(shortFingerprint("SHA256:wTYfUbmS5bOWvt0+9QOYCFmyF6hggtSOANNC5/GPtPo")).toBe("SHA256:wTYfUbmS5bOWvt0+…");
    expect(shortFingerprint("SHA256:short")).toBe("SHA256:short");
  });

  it("匯入的預設名稱：註解優先，其次檔名去副檔名", () => {
    expect(defaultKeyName("me@laptop", "C:/k/work.ppk")).toBe("me@laptop");
    expect(defaultKeyName("", "C:\\keys\\work.ppk")).toBe("work");
    expect(defaultKeyName(null, "/home/u/.ssh/id_ed25519")).toBe("id_ed25519");
  });

  it("名稱自然排序", () => {
    const k = (name: string) => ({ name }) as SshStoredKey;
    expect(sortStoredKeys([k("key10"), k("key2"), k("Alpha")]).map((x) => x.name)).toEqual(["Alpha", "key2", "key10"]);
  });
});

describe("憑證狀態", () => {
  const now = 1_800_000_000;
  const cert = (p: Partial<SshCertInfo>): SshCertInfo => ({
    path: "id-cert.pub", key_id: "k", principals: ["deploy"], valid_after: now - 10, valid_before: now + 30 * 86400,
    cert_type: "user", ca_fingerprint: "SHA256:x", matches_key: true, validity: "valid", ...p,
  });
  it("u64::MAX 經 JSON 失真後仍當成永久有效", () => {
    expect(certForever(18446744073709552000)).toBe(true);
    expect(certForever(now)).toBe(false);
  });
  it("過期 / 不是這把 = bad；七天內到期 = warn；其餘 ok", () => {
    expect(certTone(cert({}), now)).toBe("ok");
    expect(certTone(cert({ validity: "expired" }), now)).toBe("bad");
    expect(certTone(cert({ matches_key: false }), now)).toBe("bad");
    expect(certTone(cert({ valid_before: now + 3 * 86400 }), now)).toBe("warn");
    expect(certTone(cert({ valid_before: 18446744073709552000 }), now)).toBe("ok");
    expect(certTone(cert({ matches_key: null }), now)).toBe("ok");
  });
});
