import { useEffect, useState } from "react";
import { api, ConnectionConfig, DbKind, KIND_META, SshAuthMethod } from "./api";
import { pickOpenFile } from "./ui";

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

  // Esc 關閉對話框。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  });

  const onKindChange = (k: DbKind) => {
    setKind(k);
    setPort(KIND_META[k].defaultPort);
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

  const handleSave = () => onSaved(build());

  const fileBased = KIND_META[kind].fileBased;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[#1a212b] w-[460px] rounded-lg border border-white/10 shadow-2xl">
        <div className="px-5 py-3 border-b border-white/10 font-medium">{editing ? "編輯連線" : "新增連線"}</div>
        <div className="p-5 space-y-3">
          <div className="flex gap-2">
            {(Object.keys(KIND_META) as DbKind[]).map((k) => (
              <button
                key={k}
                onClick={() => onKindChange(k)}
                className="flex-1 py-1.5 rounded text-sm border transition"
                style={{
                  borderColor: kind === k ? KIND_META[k].color : "rgba(255,255,255,0.1)",
                  background: kind === k ? KIND_META[k].color + "22" : "transparent",
                  color: kind === k ? KIND_META[k].color : "#aaa",
                }}
              >
                {KIND_META[k].label}
              </button>
            ))}
          </div>

          <Field label="名稱">
            <input className={input} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="選填" />
          </Field>

          {fileBased ? (
            // SQLite：檔案路徑
            <Field label="資料庫檔案路徑">
              <div className="flex gap-2">
                <input className={input} value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  placeholder="例如 C:\\data\\app.db（留空則用記憶體資料庫）" />
                <BrowseButton onPick={async () => {
                  const p = await pickOpenFile([{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }]);
                  if (p) setDatabase(p);
                }} />
              </div>
            </Field>
          ) : (
            <>
              <div className="flex gap-3">
                <Field label="主機" className="flex-1">
                  <input className={input} value={host} onChange={(e) => setHost(e.target.value)} />
                </Field>
                <Field label="埠" className="w-24">
                  <input className={input} type="number" value={port}
                    onChange={(e) => setPort(Number(e.target.value))} />
                </Field>
              </div>
              <div className="flex gap-3">
                <Field label="使用者" className="flex-1">
                  <input className={input} value={username}
                    onChange={(e) => setUsername(e.target.value)} />
                </Field>
                <Field label="密碼" className="flex-1">
                  <input className={input} type="password" value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing ? "留空＝不變更" : ""} />
                </Field>
              </div>
              <Field label="資料庫（選填）">
                <input className={input} value={database}
                  onChange={(e) => setDatabase(e.target.value)} />
              </Field>
            </>
          )}

          {!fileBased && (
            <div className="border-t border-white/10 pt-3 space-y-3">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={sshEnabled}
                  onChange={(e) => setSshEnabled(e.target.checked)} />
                <span>透過 SSH Tunnel 連線</span>
              </label>
              {sshEnabled && (
                <>
                  <div className="flex gap-3">
                    <Field label="SSH 主機" className="flex-1">
                      <input className={input} value={sshHost}
                        onChange={(e) => setSshHost(e.target.value)} />
                    </Field>
                    <Field label="SSH 埠" className="w-24">
                      <input className={input} type="number" value={sshPort}
                        onChange={(e) => setSshPort(Number(e.target.value))} />
                    </Field>
                  </div>
                  <Field label="SSH 使用者">
                    <input className={input} value={sshUsername}
                      onChange={(e) => setSshUsername(e.target.value)} />
                  </Field>
                  <div className="flex gap-2">
                    {(["password", "key"] as SshAuthMethod[]).map((m) => (
                      <button key={m} type="button" onClick={() => setSshAuthMethod(m)}
                        className="flex-1 py-1 rounded text-sm border"
                        style={{
                          borderColor: sshAuthMethod === m ? "#3b82f6" : "rgba(255,255,255,0.1)",
                          background: sshAuthMethod === m ? "#3b82f622" : "transparent",
                          color: sshAuthMethod === m ? "#3b82f6" : "#aaa",
                        }}>
                        {m === "password" ? "密碼認證" : "私鑰認證"}
                      </button>
                    ))}
                  </div>
                  {sshAuthMethod === "password" ? (
                    <Field label="SSH 密碼">
                      <input className={input} type="password" value={sshPassword}
                        onChange={(e) => setSshPassword(e.target.value)}
                        placeholder={editing ? "留空＝不變更" : ""} />
                    </Field>
                  ) : (
                    <>
                      <Field label="私鑰檔路徑">
                        <div className="flex gap-2">
                          <input className={input} value={sshKeyPath}
                            onChange={(e) => setSshKeyPath(e.target.value)}
                            placeholder="例如 C:\\Users\\me\\.ssh\\id_ed25519" />
                          <BrowseButton onPick={async () => {
                            const p = await pickOpenFile();
                            if (p) setSshKeyPath(p);
                          }} />
                        </div>
                      </Field>
                      <Field label="私鑰密語（選填）">
                        <input className={input} type="password" value={sshPassphrase}
                          onChange={(e) => setSshPassphrase(e.target.value)}
                          placeholder={editing ? "留空＝不變更" : ""} />
                      </Field>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {msg && (
            <div className={`text-sm ${msg.ok ? "text-green-400" : "text-red-400"}`}>
              {msg.text}
            </div>
          )}
        </div>
        <div className="px-5 py-3 border-t border-white/10 flex justify-between">
          <button onClick={handleTest} disabled={testing}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5 disabled:opacity-50">
            {testing ? "測試中…" : "測試連線"}
          </button>
          <div className="flex gap-2">
            <button onClick={onClose}
              className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">
              取消
            </button>
            <button onClick={handleSave}
              className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500">
              儲存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const input =
  "w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500";

function Field({ label, children, className = "" }: {
  label: string; children: React.ReactNode; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs text-white/50 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function BrowseButton({ onPick }: { onPick: () => void }) {
  return (
    <button type="button" onClick={onPick} title="瀏覽…"
      className="shrink-0 px-3 rounded border border-white/15 hover:bg-white/5 text-sm">
      瀏覽…
    </button>
  );
}
