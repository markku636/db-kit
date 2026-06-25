import { useEffect, useState } from "react";
import { api, ConnectionConfig, DbKind, KIND_META, SshAuthMethod } from "./api";
import { pickOpenFile } from "./ui";
import { Modal, Field, Input, Button, Segmented } from "./ui/index";
import { Plug, FolderOpen } from "lucide-react";

interface Props {
  onClose: () => void;
  onSaved: (c: ConnectionConfig) => void;
  initial?: ConnectionConfig | null;
}

export default function ConnectionDialog({ onClose, onSaved, initial }: Props) {
  const editing = !!initial;
  const [kind, setKind] = useState<DbKind>(initial?.kind ?? "mysql");
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "127.0.0.1");
  const [port, setPort] = useState(initial?.port ?? KIND_META.mysql.defaultPort);
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(initial?.database ?? "");
  const [testing, setTesting] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // SSH Tunnel
  const [sshEnabled, setSshEnabled] = useState(initial?.ssh_enabled ?? false);
  const [sshHost, setSshHost] = useState(initial?.ssh_host ?? "");
  const [sshPort, setSshPort] = useState(initial?.ssh_port || 22);
  const [sshUsername, setSshUsername] = useState(initial?.ssh_username ?? "");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>(initial?.ssh_auth_method ?? "password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState(initial?.ssh_private_key_path ?? "");
  const [sshPassphrase, setSshPassphrase] = useState("");
  // 外部 gateway（kind === "external"，例：QLand）
  const [driver, setDriver] = useState(initial?.options?.driver ?? "qland");
  const [baseUrl, setBaseUrl] = useState(initial?.options?.base_url ?? "");
  const [env, setEnv] = useState(initial?.options?.env ?? "");
  const [insecure, setInsecure] = useState(initial?.options?.insecure === "1");
  const [otpSecret, setOtpSecret] = useState("");

  // 任一連線欄位變動就清掉上次測試結果，避免「連線成功」殘留成誤導的假成功訊號（改了 host 卻仍顯示舊成功）。
  useEffect(() => {
    setMsg(null);
  }, [kind, host, port, username, password, database, sshEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshKeyPath, sshPassphrase]);

  const build = (): ConnectionConfig => ({
    id: initial?.id ?? crypto.randomUUID(),
    name:
      name ||
      (KIND_META[kind].fileBased
        ? `${KIND_META[kind].label}:${database || "memory"}`
        : `${KIND_META[kind].label}@${host}`),
    kind,
    host,
    port,
    username,
    password,
    database: database || null,
    max_connections: 5,
    ssh_enabled: !KIND_META[kind].fileBased && sshEnabled,
    ssh_host: sshHost,
    ssh_port: sshPort,
    ssh_username: sshUsername,
    ssh_auth_method: sshAuthMethod,
    ssh_password: sshPassword,
    ssh_private_key_path: sshKeyPath,
    ssh_passphrase: sshPassphrase,
    options:
      kind === "external"
        ? { driver, base_url: baseUrl, env, ...(insecure ? { insecure: "1" } : {}) }
        : undefined,
    otp_secret: otpSecret,
  });

  const onKindChange = (k: DbKind) => {
    // 僅在使用者尚未自訂埠（仍等於前一個 kind 的預設埠）時，才覆寫為新 kind 的預設埠
    setPort((prev) => (prev === KIND_META[kind].defaultPort ? KIND_META[k].defaultPort : prev));
    setKind(k);
  };

  const handleTest = async () => {
    setTesting(true);
    setMsg(null);
    const t0 = performance.now();
    try {
      await api.testConnection(build());
      setMsg({ ok: true, text: `連線成功（${Math.round(performance.now() - t0)} ms）` });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? "連線失敗" });
    } finally {
      setTesting(false);
    }
  };

  const fileBased = KIND_META[kind].fileBased;
  const external = KIND_META[kind].external;
  // 檔案型路徑可留空；外部 gateway 需 base URL；伺服器型至少需要主機。
  const valid = external ? baseUrl.trim() !== "" : fileBased || host.trim() !== "";
  const handleSave = () => { if (valid) onSaved(build()); };
  // 文字輸入按 Enter 直接儲存（與其他對話框一致）。
  const submitOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && valid) { e.preventDefault(); handleSave(); }
  };

  return (
    <Modal
      onClose={onClose}
      title={editing ? "編輯連線" : "新增連線"}
      icon={Plug}
      size="md"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" loading={testing} onClick={handleTest}>
            測試連線
          </Button>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={handleSave} disabled={!valid}>儲存</Button>
        </>
      }
    >
      <div className="flex gap-2">
        {(Object.keys(KIND_META) as DbKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onKindChange(k)}
            className="flex-1 h-8 rounded text-sm border transition-colors"
            style={{
              borderColor: kind === k ? KIND_META[k].color : "rgb(var(--c-fg) / 0.12)",
              background: kind === k ? KIND_META[k].color + "22" : "transparent",
              color: kind === k ? KIND_META[k].color : "rgb(var(--c-fg) / 0.55)",
            }}
          >
            {KIND_META[k].label}
          </button>
        ))}
      </div>

      <Field label="名稱">
        <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={submitOnEnter} placeholder="選填" />
      </Field>

      {external ? (
        <>
          <Field label="驅動">
            <Input value={driver} onChange={(e) => setDriver(e.target.value)} onKeyDown={submitOnEnter} placeholder="qland" />
          </Field>
          <Field label="Gateway 網址（base URL）">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onKeyDown={submitOnEnter} placeholder="https://qland.internal" />
          </Field>
          <Field label="環境（env，選填）">
            <Input value={env} onChange={(e) => setEnv(e.target.value)} onKeyDown={submitOnEnter} placeholder="例如 n8xuat / otprod" />
          </Field>
          <div className="flex gap-3">
            <Field label="使用者" className="flex-1">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} />
            </Field>
            <Field label="密碼" className="flex-1">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={submitOnEnter} placeholder={editing ? "留空＝不變更" : ""} />
            </Field>
          </div>
          <Field label="OTP secret（2FA，選填）">
            <Input type="password" value={otpSecret} onChange={(e) => setOtpSecret(e.target.value)} onKeyDown={submitOnEnter} placeholder={editing ? "留空＝不變更" : "base32 或 otpauth:// URI"} />
          </Field>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
            <span>略過 TLS 憑證驗證（內部自簽憑證用）</span>
          </label>
        </>
      ) : fileBased ? (
        <Field label="資料庫檔案路徑">
          <div className="flex gap-2">
            <Input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              onKeyDown={submitOnEnter}
              placeholder="例如 C:\\data\\app.db（留空則用記憶體資料庫）"
            />
            <BrowseButton
              onPick={async () => {
                const p = await pickOpenFile([{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }]);
                if (p) setDatabase(p);
              }}
            />
          </div>
        </Field>
      ) : (
        <>
          <div className="flex gap-3">
            <Field label="主機" className="flex-1">
              <Input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={submitOnEnter} />
            </Field>
            <Field label="埠" className="w-24">
              <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} onKeyDown={submitOnEnter} />
            </Field>
          </div>
          <div className="flex gap-3">
            <Field label="使用者" className="flex-1">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} />
            </Field>
            <Field label="密碼" className="flex-1">
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={submitOnEnter}
                placeholder={editing ? "留空＝不變更" : ""}
              />
            </Field>
          </div>
          <Field label="資料庫（選填）">
            <Input value={database} onChange={(e) => setDatabase(e.target.value)} onKeyDown={submitOnEnter} />
          </Field>
        </>
      )}

      {!fileBased && !external && (
        <div className="border-t border-fg/10 pt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} />
            <span>透過 SSH Tunnel 連線</span>
          </label>
          {sshEnabled && (
            <>
              <div className="flex gap-3">
                <Field label="SSH 主機" className="flex-1">
                  <Input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
                </Field>
                <Field label="SSH 埠" className="w-24">
                  <Input type="number" value={sshPort} onChange={(e) => setSshPort(Number(e.target.value))} />
                </Field>
              </div>
              <Field label="SSH 使用者">
                <Input value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} />
              </Field>
              <Segmented
                full
                ariaLabel="SSH 認證方式"
                value={sshAuthMethod}
                onChange={setSshAuthMethod}
                options={[
                  { value: "password", label: "密碼認證" },
                  { value: "key", label: "私鑰認證" },
                ]}
              />
              {sshAuthMethod === "password" ? (
                <Field label="SSH 密碼">
                  <Input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={editing ? "留空＝不變更" : ""}
                  />
                </Field>
              ) : (
                <>
                  <Field label="私鑰檔路徑">
                    <div className="flex gap-2">
                      <Input
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder="例如 C:\\Users\\me\\.ssh\\id_ed25519"
                      />
                      <BrowseButton
                        onPick={async () => {
                          const p = await pickOpenFile();
                          if (p) setSshKeyPath(p);
                        }}
                      />
                    </div>
                  </Field>
                  <Field label="私鑰密語（選填）">
                    <Input
                      type="password"
                      value={sshPassphrase}
                      onChange={(e) => setSshPassphrase(e.target.value)}
                      placeholder={editing ? "留空＝不變更" : ""}
                    />
                  </Field>
                </>
              )}
            </>
          )}
        </div>
      )}

      {msg && <div className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</div>}
    </Modal>
  );
}

function BrowseButton({ onPick }: { onPick: () => void }) {
  return (
    <Button variant="secondary" icon={FolderOpen} onClick={onPick} title="瀏覽…" className="shrink-0">
      瀏覽
    </Button>
  );
}
