import { useEffect, useState } from "react";
import { api, ConnectionConfig, DbKind, KIND_META, SshAuthMethod } from "./api";
import { pickOpenFile } from "./ui";
import { Modal, Field, Input, Button, Segmented, Select } from "./ui/index";
import { Plug, FolderOpen } from "lucide-react";

interface Props {
  onClose: () => void;
  onSaved: (c: ConnectionConfig) => void;
  initial?: ConnectionConfig | null;
}

// 支援 ssl_mode 選項的類型（sqlx driver；MariaDB 與 MySQL 共用詞彙）。
const sslKinds: DbKind[] = ["mysql", "mariadb", "postgres"];

// ssl_mode 下拉選項（值即後端 options.ssl_mode；require/required 只加密不驗證憑證鏈）。
const SSL_MODE_OPTIONS: Record<string, { value: string; label: string }[]> = {
  postgres: [
    { value: "", label: "prefer（預設：可用則加密）" },
    { value: "disable", label: "disable（不加密）" },
    { value: "require", label: "require（強制加密，不驗證憑證）" },
    { value: "verify-ca", label: "verify-ca（加密 + 驗證 CA）" },
    { value: "verify-full", label: "verify-full（加密 + 驗證 CA 與主機名）" },
  ],
  mysql: [
    { value: "", label: "preferred（預設：可用則加密）" },
    { value: "disabled", label: "disabled（不加密）" },
    { value: "required", label: "required（強制加密，不驗證憑證）" },
    { value: "verify_ca", label: "verify_ca（加密 + 驗證 CA）" },
    { value: "verify_identity", label: "verify_identity（加密 + 驗證 CA 與主機名）" },
  ],
};

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
  // 外部 gateway（kind === "external"）：driver / base_url / env 等存於 options map。
  const [driver, setDriver] = useState(initial?.options?.driver ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.options?.base_url ?? "");
  const [env, setEnv] = useState(initial?.options?.env ?? "");
  const [insecure, setInsecure] = useState(initial?.options?.insecure === "1");
  const [otpSecret, setOtpSecret] = useState("");
  // Redis 連線選項（存於 options map）
  const [redisTls, setRedisTls] = useState(initial?.options?.redis_tls === "true");
  const [redisTlsInsecure, setRedisTlsInsecure] = useState(initial?.options?.redis_tls_insecure === "true");
  // Mongo 連線選項（存於 options map）
  const [mongoSrv, setMongoSrv] = useState(initial?.options?.mongo_srv === "1");
  const [mongoAuthSource, setMongoAuthSource] = useState(initial?.options?.mongo_auth_source ?? "");
  const [mongoTls, setMongoTls] = useState(initial?.options?.mongo_tls === "1");
  const [mongoReplicaSet, setMongoReplicaSet] = useState(initial?.options?.mongo_replica_set ?? "");
  const [mongoDirect, setMongoDirect] = useState(initial?.options?.mongo_direct === "1");
  // MSSQL 連線選項（存於 options map）；加密預設開啟。
  const [mssqlEncrypt, setMssqlEncrypt] = useState(initial?.options?.encrypt !== "false");
  const [mssqlTrust, setMssqlTrust] = useState(initial?.options?.trust_server_certificate === "true");
  // MySQL / PostgreSQL SSL 模式（存於 options map；空值＝沿用 driver 預設 prefer/preferred）。
  const [sslMode, setSslMode] = useState(initial?.options?.ssl_mode ?? "");
  // Oracle 連線選項（存於 options map）：database 欄的解讀方式 + Instant Client 目錄。
  const [oracleConnectType, setOracleConnectType] = useState(initial?.options?.connect_type ?? "service");
  const [oracleClientDir, setOracleClientDir] = useState(initial?.options?.client_dir ?? "");

  // 任一連線欄位變動就清掉上次測試結果，避免「連線成功」殘留成誤導的假成功訊號（改了 host 卻仍顯示舊成功）。
  useEffect(() => {
    setMsg(null);
  }, [kind, host, port, username, password, database, sshEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshKeyPath, sshPassphrase,
      redisTls, redisTlsInsecure, mongoSrv, mongoAuthSource, mongoTls, mongoReplicaSet, mongoDirect, mssqlEncrypt, mssqlTrust, sslMode,
      oracleConnectType, oracleClientDir]);

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
    options: buildOptions(),
    otp_secret: otpSecret,
  });

  // 依 kind 組 options map（連線層非機密設定）。回 undefined 表示無額外選項。
  const buildOptions = (): Record<string, string> | undefined => {
    if (kind === "external") {
      // 保留 cache_ttl_secs / max_concurrency 等「無 UI」的進階選項：回物件字面值會把未列舉的
      // 鍵一併清掉（使用者只是開對話框按存檔，進階設定就沒了）。
      const ext: Record<string, string> = { ...(initial?.options ?? {}) };
      ext.driver = driver;
      ext.base_url = baseUrl;
      ext.env = env;
      if (insecure) ext.insecure = "1";
      else delete ext.insecure; // 取消勾選要真的移除，不能靠 spread 蓋掉舊值
      return ext;
    }
    const o: Record<string, string> = {};
    if (kind === "redis") {
      if (redisTls) o.redis_tls = "true";
      if (redisTls && redisTlsInsecure) o.redis_tls_insecure = "true";
    } else if (kind === "mongo") {
      if (mongoSrv) o.mongo_srv = "1";
      if (mongoAuthSource.trim()) o.mongo_auth_source = mongoAuthSource.trim();
      if (mongoTls) o.mongo_tls = "1";
      if (mongoReplicaSet.trim()) o.mongo_replica_set = mongoReplicaSet.trim();
      if (mongoDirect) o.mongo_direct = "1";
    } else if (kind === "mssql") {
      o.encrypt = mssqlEncrypt ? "true" : "false";
      if (mssqlTrust) o.trust_server_certificate = "true";
    } else if (kind === "oracle") {
      if (oracleConnectType !== "service") o.connect_type = oracleConnectType;
      if (oracleClientDir.trim()) o.client_dir = oracleClientDir.trim();
    } else if (sslKinds.includes(kind)) {
      if (sslMode) o.ssl_mode = sslMode;
    }
    return Object.keys(o).length ? o : undefined;
  };

  const onKindChange = (k: DbKind) => {
    // 僅在使用者尚未自訂埠（仍等於前一個 kind 的預設埠）時，才覆寫為新 kind 的預設埠
    setPort((prev) => (prev === KIND_META[kind].defaultPort ? KIND_META[k].defaultPort : prev));
    // ssl_mode 詞彙 PG（require）與 MySQL 系（required）不同，跨 kind 不可沿用。
    if (k !== kind) setSslMode("");
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
      {/* 連線類型 tab：欄數固定 4，超過就換到下一排（避免長標籤如「SQL Server」在單排等寬時被壓到換行而跑版）。 */}
      <div className="grid grid-cols-4 gap-2">
        {/* 外部 gateway（external）連線類型：開源版無內建驅動，預設隱藏（__EXTERNAL__ 建置期開關）。 */}
        {(Object.keys(KIND_META) as DbKind[])
          .filter((k) => __EXTERNAL__ || k !== "external")
          .map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onKindChange(k)}
            className="h-8 rounded text-sm border transition-colors whitespace-nowrap"
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
            <Input value={driver} onChange={(e) => setDriver(e.target.value)} onKeyDown={submitOnEnter} placeholder="driver 名稱" />
          </Field>
          <Field label="Gateway 網址（base URL）">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onKeyDown={submitOnEnter} placeholder="https://gateway.internal" />
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
            <Field label={kind === "mongo" && mongoSrv ? "主機（SRV 域名）" : "主機"} className="flex-1">
              <Input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={submitOnEnter}
                placeholder={kind === "mongo" && mongoSrv ? "例如 cluster0.abcd.mongodb.net" : ""} />
            </Field>
            {/* SRV 連線由 DNS 記錄決定 port，故不顯示埠欄位。 */}
            {!(kind === "mongo" && mongoSrv) && (
              <Field label="埠" className="w-24">
                <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} onKeyDown={submitOnEnter} />
              </Field>
            )}
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
          <Field label={
            kind === "oracle"
              ? (oracleConnectType === "sid" ? "SID" : oracleConnectType === "tns" ? "TNS 別名" : "服務名稱（Service Name）")
              : "資料庫（選填）"
          }>
            <Input value={database} onChange={(e) => setDatabase(e.target.value)} onKeyDown={submitOnEnter}
              placeholder={kind === "oracle" ? "例如 ORCLPDB1 / FREEPDB1" : ""} />
          </Field>

          {kind === "redis" && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={redisTls} onChange={(e) => setRedisTls(e.target.checked)} />
                <span>使用 TLS（rediss://）</span>
              </label>
              {redisTls && (
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none pl-6">
                  <input type="checkbox" checked={redisTlsInsecure} onChange={(e) => setRedisTlsInsecure(e.target.checked)} />
                  <span>略過憑證驗證（自簽憑證用）</span>
                </label>
              )}
              {redisTls && sshEnabled && (
                <div className="text-xs text-warning pl-6">
                  透過 SSH Tunnel 時主機會改寫為 127.0.0.1，憑證主機名驗證會失敗，通常需勾「略過憑證驗證」。
                </div>
              )}
            </div>
          )}

          {kind === "mongo" && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mongoSrv} onChange={(e) => setMongoSrv(e.target.checked)} />
                <span>SRV 連線（mongodb+srv://，Atlas 等）</span>
              </label>
              <div className="flex gap-3">
                <Field label="authSource（選填）" className="flex-1">
                  <Input value={mongoAuthSource} onChange={(e) => setMongoAuthSource(e.target.value)} onKeyDown={submitOnEnter} placeholder="例如 admin" />
                </Field>
                <Field label="replicaSet（選填）" className="flex-1">
                  <Input value={mongoReplicaSet} onChange={(e) => setMongoReplicaSet(e.target.value)} onKeyDown={submitOnEnter} placeholder="例如 rs0" />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mongoTls} onChange={(e) => setMongoTls(e.target.checked)} />
                <span>使用 TLS</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mongoDirect} onChange={(e) => setMongoDirect(e.target.checked)} />
                <span>直連（directConnection，繞過拓撲探索）</span>
              </label>
            </div>
          )}

          {sslKinds.includes(kind) && (
            <div className="space-y-2">
              <Field label="SSL 模式">
                <Select selectSize="md" value={sslMode} onChange={(e) => setSslMode(e.target.value)}>
                  {(SSL_MODE_OPTIONS[kind === "postgres" ? "postgres" : "mysql"] ?? []).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </Field>
              {sshEnabled && (sslMode === "verify-full" || sslMode === "verify_identity") && (
                <div className="text-xs text-warning">
                  透過 SSH Tunnel 時主機會改寫為 127.0.0.1，憑證主機名驗證會失敗，建議改用 verify-ca 或 require。
                </div>
              )}
            </div>
          )}

          {kind === "oracle" && (
            <div className="space-y-2">
              <Segmented
                full
                ariaLabel="Oracle 連線方式"
                value={oracleConnectType}
                onChange={setOracleConnectType}
                options={[
                  { value: "service", label: "服務名稱" },
                  { value: "sid", label: "SID" },
                  { value: "tns", label: "TNS 別名" },
                ]}
              />
              <Field label="Instant Client 目錄（選填）">
                <Input value={oracleClientDir} onChange={(e) => setOracleClientDir(e.target.value)} onKeyDown={submitOnEnter}
                  placeholder="留空則用 ORACLE_HOME / PATH 偵測" />
              </Field>
              <div className="text-xs text-fg/40">
                需安裝 64 位元 Oracle Instant Client（Basic / Basic Light）。client 目錄於首個 Oracle 連線生效，之後變更需重啟應用程式。
              </div>
            </div>
          )}

          {kind === "mssql" && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mssqlEncrypt} onChange={(e) => setMssqlEncrypt(e.target.checked)} />
                <span>加密連線（encrypt）</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mssqlTrust} onChange={(e) => setMssqlTrust(e.target.checked)} />
                <span>信任伺服器憑證（自簽 / 開發用）</span>
              </label>
            </div>
          )}
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
