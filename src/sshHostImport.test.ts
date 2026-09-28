import { describe, expect, it } from "vitest";
import { candidateToSession, existingIndexes, folderLabel, hostKey } from "./sshHostImport";
import { blankSshSession, type SshImportCandidate, type SshStoredKey } from "./sshTypes";

const cand = (p: Partial<SshImportCandidate>): SshImportCandidate => ({
  name: "web-01", folder: null, host: "10.0.0.1", port: 22, username: "deploy",
  identity_file: null, certificate_file: null, xshell_key: null, term: null, notes: [], ...p,
});

describe("匯入主機", () => {
  it("同一台主機：使用者 + 主機 + 埠，不分大小寫", () => {
    expect(hostKey("Deploy", "WEB.example.com", 0)).toBe("deploy@web.example.com:22");
    const existing = [{ ...blankSshSession("a"), username: "deploy", host: "10.0.0.1", port: 22 }];
    const cands = [cand({}), cand({ port: 2222 }), cand({ username: "DEPLOY" })];
    expect([...existingIndexes(cands, existing)]).toEqual([0, 2]);
  });

  it("子資料夾對應成資料夾名稱", () => {
    expect(folderLabel("PROD/web")).toBe("PROD / web");
    expect(folderLabel(" /x/ ")).toBe("x");
    expect(folderLabel(null)).toBeNull();
  });

  it("有私鑰檔 → 私鑰認證並帶憑證；沒有 → 密碼", () => {
    const s = candidateToSession(cand({ identity_file: "C:/k/id", certificate_file: "C:/k/id-cert.pub", term: "xterm" }), "id1", "f1");
    expect([s.auth, s.private_key_path, s.certificate_path, s.folder_id, s.options.term]).toEqual(["key", "C:/k/id", "C:/k/id-cert.pub", "f1", "xterm"]);
    const p = candidateToSession(cand({ certificate_file: "C:/k/x-cert.pub", term: "weird-term" }), "id2", null);
    expect([p.auth, p.private_key_path, p.certificate_path, p.options.term]).toEqual(["password", "", "", "xterm-256color"]);
  });

  it(".xsh 參照的金鑰在金鑰庫有同名的 → 直接接上 keystore:<id>", () => {
    const keys = [{ id: "k9", name: "ID_RSA_2048" } as SshStoredKey];
    const s = candidateToSession(cand({ xshell_key: "id_rsa_2048" }), "x", null, keys);
    expect([s.auth, s.private_key_path]).toEqual(["key", "keystore:k9"]);
    expect(candidateToSession(cand({ xshell_key: "other" }), "y", null, keys).auth).toBe("password");
  });
});
