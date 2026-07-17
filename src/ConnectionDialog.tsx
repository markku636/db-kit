import { useEffect, useState, type ReactNode } from "react";
import { api, ConnectionConfig, DbKind, KIND_META, ParsedUrl, SshAuthMethod } from "./api";
import { pickOpenFile } from "./ui";
import { Modal, Field, Input, Button, Segmented, Select } from "./ui/index";
import { Plug, FolderOpen, ClipboardPaste } from "lucide-react";
import { useT } from "./i18n";
import KindPicker from "./KindPicker";

interface Props {
  onClose: () => void;
  onSaved: (c: ConnectionConfig) => void;
  initial?: ConnectionConfig | null;
}

// 支援 ssl_mode 選項的類型（sqlx driver；MariaDB 與 MySQL 共用詞彙）。
const sslKinds: DbKind[] = ["mysql", "mariadb", "postgres"];

// 會驗證憑證鏈的 ssl_mode 值（PG 與 MySQL 系詞彙合併）；只有這些模式下 CA 憑證才有作用，
// require/required 模式 sqlx 不驗證憑證，常駐顯示 CA 欄會誤導。
const VERIFY_SSL_MODES = ["verify-ca", "verify-full", "verify_ca", "verify_identity"];

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
  const t = useT();
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
  // 類型選擇器展開狀態：新增模式先選類型（展開）；編輯模式直達表單（收合成 chip）。
  const [pickerOpen, setPickerOpen] = useState(!editing);
  // 「從連線字串匯入」列（貼雲端服務給的 URI 一鍵填表）。
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  // 匯入結果與測試結果分開存：applyParsed 改欄位會觸發 msg 清除 effect，共用會讓成功訊息立刻消失。
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
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
  // Mongo TLS 進階（AWS DocumentDB 等需自訂 CA；值格式沿 mongo 系 "1"）。
  const [mongoTlsCa, setMongoTlsCa] = useState(initial?.options?.mongo_tls_ca ?? "");
  const [mongoTlsInsecure, setMongoTlsInsecure] = useState(initial?.options?.mongo_tls_insecure === "1");
  // MSSQL 連線選項（存於 options map）；加密預設開啟。
  const [mssqlEncrypt, setMssqlEncrypt] = useState(initial?.options?.encrypt !== "false");
  const [mssqlTrust, setMssqlTrust] = useState(initial?.options?.trust_server_certificate === "true");
  const [mssqlCaPath, setMssqlCaPath] = useState(initial?.options?.trust_cert_ca ?? "");
  // MySQL / PostgreSQL SSL 模式（存於 options map；空值＝沿用 driver 預設 prefer/preferred）。
  const [sslMode, setSslMode] = useState(initial?.options?.ssl_mode ?? "");
  // verify-* 模式的 CA 憑證檔（AWS RDS 等雲端服務的 CA bundle）。
  const [sslCa, setSslCa] = useState(initial?.options?.ssl_ca ?? "");
  // Oracle 連線選項（存於 options map）：database 欄的解讀方式 + Instant Client 目錄。
  const [oracleConnectType, setOracleConnectType] = useState(initial?.options?.connect_type ?? "service");
  const [oracleClientDir, setOracleClientDir] = useState(initial?.options?.client_dir ?? "");
  // Kafka 連線選項（存於 options map；SASL 帳密沿用 username/password；SR 帳密亦存 options）。
  const [kafkaProtocol, setKafkaProtocol] = useState(initial?.options?.kafka_security_protocol ?? "PLAINTEXT");
  const [kafkaSaslMech, setKafkaSaslMech] = useState(initial?.options?.kafka_sasl_mechanism ?? "PLAIN");
  const [kafkaCaPath, setKafkaCaPath] = useState(initial?.options?.kafka_ssl_ca ?? "");
  const [kafkaSkipVerify, setKafkaSkipVerify] = useState(initial?.options?.kafka_ssl_insecure === "1");
  const [srUrl, setSrUrl] = useState(initial?.options?.kafka_sr_url ?? "");
  const [srUser, setSrUser] = useState(initial?.options?.kafka_sr_user ?? "");
  const [srPass, setSrPass] = useState(initial?.options?.kafka_sr_password ?? "");
  const [connectUrl, setConnectUrl] = useState(initial?.options?.kafka_connect_url ?? "");
  const [connectUser, setConnectUser] = useState(initial?.options?.kafka_connect_user ?? "");
  const [connectPass, setConnectPass] = useState(initial?.options?.kafka_connect_password ?? "");
  // Elasticsearch / OpenSearch 連線選項（存於 options map）。認證方式：none（無）/ basic（帳密）/ apikey（password 存 API key）。
  const [esAuth, setEsAuth] = useState(initial?.options?.es_auth ?? (initial?.username ? "basic" : "none"));
  const [esTls, setEsTls] = useState(initial?.options?.es_tls === "1");
  const [esSslCa, setEsSslCa] = useState(initial?.options?.es_ssl_ca ?? "");
  const [esSslInsecure, setEsSslInsecure] = useState(initial?.options?.es_ssl_insecure === "1");
  const [esShowHidden, setEsShowHidden] = useState(initial?.options?.es_show_hidden === "1");
  const [esCloudId, setEsCloudId] = useState("");
  // RabbitMQ 連線選項（存於 options map）；帳密沿用 username/password（預設 guest/guest）。
  const [rabbitVhost, setRabbitVhost] = useState(initial?.options?.rabbitmq_vhost ?? "/");
  const [rabbitTls, setRabbitTls] = useState(initial?.options?.rabbitmq_tls === "1");
  const [rabbitMgmtUrl, setRabbitMgmtUrl] = useState(initial?.options?.rabbitmq_mgmt_url ?? "");

  // 任一連線欄位變動就清掉上次測試結果，避免「連線成功」殘留成誤導的假成功訊號（改了 host 卻仍顯示舊成功）。
  useEffect(() => {
    setMsg(null);
  }, [kind, host, port, username, password, database, sshEnabled, sshHost, sshPort, sshUsername, sshAuthMethod, sshPassword, sshKeyPath, sshPassphrase,
      redisTls, redisTlsInsecure, mongoSrv, mongoAuthSource, mongoTls, mongoReplicaSet, mongoDirect, mongoTlsCa, mongoTlsInsecure,
      mssqlEncrypt, mssqlTrust, mssqlCaPath, sslMode, sslCa,
      oracleConnectType, oracleClientDir,
      kafkaProtocol, kafkaSaslMech, kafkaCaPath, kafkaSkipVerify, srUrl, srUser, srPass, connectUrl, connectUser, connectPass,
      esAuth, esTls, esSslCa, esSslInsecure, esShowHidden,
      rabbitVhost, rabbitTls, rabbitMgmtUrl]);

  // Elastic：host 為完整 URL 時 TLS 由 URL 決定（勾選不顯示/停用）。
  const esHostIsUrl = /^https?:\/\//i.test(host.trim());

  // 帳密使用情境依 kind：Kafka 僅 SASL 協定；Elastic 依認證方式（none 不用）；其餘一律使用。
  // 非使用情境存檔時清空 username/password，避免把預設 root / 舊密碼誤存進設定與 keychain。
  const usesAuth =
    kind === "kafka" ? kafkaProtocol.startsWith("SASL")
    : kind === "elastic" ? esAuth !== "none"
    : true;
  // Elastic API Key 模式：password 存 API key，username 不使用（存檔清空）。
  const usesUsername = usesAuth && !(kind === "elastic" && esAuth === "apikey");

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
    username: usesUsername ? username : "",
    password: usesAuth ? password : "",
    database: KIND_META[kind].noDatabase ? null : database || null,
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
      if (mongoTls && mongoTlsCa.trim()) o.mongo_tls_ca = mongoTlsCa.trim();
      if (mongoTls && mongoTlsInsecure) o.mongo_tls_insecure = "1";
    } else if (kind === "mssql") {
      o.encrypt = mssqlEncrypt ? "true" : "false";
      if (mssqlTrust) o.trust_server_certificate = "true";
      // 自訂 CA 只在「加密且未信任任意憑證」時有意義（tiberius trust_cert_ca）。
      if (mssqlEncrypt && !mssqlTrust && mssqlCaPath.trim()) o.trust_cert_ca = mssqlCaPath.trim();
    } else if (kind === "oracle") {
      if (oracleConnectType !== "service") o.connect_type = oracleConnectType;
      if (oracleClientDir.trim()) o.client_dir = oracleClientDir.trim();
    } else if (kind === "kafka") {
      o.kafka_security_protocol = kafkaProtocol;
      if (kafkaProtocol.startsWith("SASL")) o.kafka_sasl_mechanism = kafkaSaslMech;
      if (kafkaProtocol.endsWith("SSL")) {
        if (kafkaCaPath.trim()) o.kafka_ssl_ca = kafkaCaPath.trim();
        if (kafkaSkipVerify) o.kafka_ssl_insecure = "1";
      }
      if (srUrl.trim()) o.kafka_sr_url = srUrl.trim();
      if (srUrl.trim() && srUser.trim()) o.kafka_sr_user = srUser.trim();
      if (srUrl.trim() && srPass.trim()) o.kafka_sr_password = srPass.trim();
      if (connectUrl.trim()) o.kafka_connect_url = connectUrl.trim();
      if (connectUrl.trim() && connectUser.trim()) o.kafka_connect_user = connectUser.trim();
      if (connectUrl.trim() && connectPass.trim()) o.kafka_connect_password = connectPass.trim();
    } else if (kind === "elastic") {
      o.es_auth = esAuth; // none / basic / apikey
      if (!esHostIsUrl && esTls) o.es_tls = "1";
      if (esTls && esSslCa.trim()) o.es_ssl_ca = esSslCa.trim();
      if (esTls && esSslInsecure) o.es_ssl_insecure = "1";
      if (esShowHidden) o.es_show_hidden = "1";
    } else if (kind === "rabbitmq") {
      if (rabbitVhost.trim() && rabbitVhost.trim() !== "/") o.rabbitmq_vhost = rabbitVhost.trim();
      if (rabbitTls) o.rabbitmq_tls = "1";
      if (rabbitMgmtUrl.trim()) o.rabbitmq_mgmt_url = rabbitMgmtUrl.trim();
    } else if (sslKinds.includes(kind)) {
      if (sslMode) o.ssl_mode = sslMode;
      // CA 只在 verify-* 模式生效（require/required 不驗證憑證，sqlx 會忽略）。
      if (VERIFY_SSL_MODES.includes(sslMode) && sslCa.trim()) o.ssl_ca = sslCa.trim();
    }
    return Object.keys(o).length ? o : undefined;
  };

  // 無 root 帳號慣例的類型（Kafka / Elastic）：切入時清掉預設 root、切出且留空時補回。
  const noRootKind = (k: DbKind) => k === "kafka" || k === "elastic";

  const onKindChange = (k: DbKind) => {
    // 僅在使用者尚未自訂埠（仍等於前一個 kind 的預設埠）時，才覆寫為新 kind 的預設埠
    setPort((prev) => (prev === KIND_META[kind].defaultPort ? KIND_META[k].defaultPort : prev));
    // 預設帳號：kafka/elastic 無 root 慣例（清空）；rabbitmq 慣例為 guest；其餘為 root。
    if (noRootKind(k) && username === "root") setUsername("");
    else if (k === "rabbitmq" && username === "root") setUsername("guest");
    else if (kind === "rabbitmq" && k !== "rabbitmq" && username === "guest") setUsername("root");
    else if (noRootKind(kind) && !noRootKind(k) && username === "") setUsername("root");
    // ssl_mode 詞彙 PG（require）與 MySQL 系（required）不同，跨 kind 不可沿用；CA 路徑一併清除。
    if (k !== kind) { setSslMode(""); setSslCa(""); }
    setKind(k);
  };

  // 「從連線字串匯入」：後端 parse_connection_url 解析（與 dbk --url 同一套邏輯），前端只負責填表。
  // options 布林值的兩種既有編碼（mongo 系 "1" / redis 系 "true"）統一在這判讀。
  const optBool = (v: string | undefined) => v === "1" || v === "true";
  const applyParsed = (p: ParsedUrl) => {
    // 後端可能先於前端認識新 kind（分階段上線）；未知 kind 不索引 KIND_META，僅填主機等欄位。
    const knownKind = p.kind && p.kind !== "external" && p.kind in KIND_META ? p.kind : null;
    if (knownKind) {
      if (knownKind !== kind) { setSslMode(""); setSslCa(""); }
      // 與 onKindChange 的無 root 慣例對齊（匯入路徑繞過 onKindChange）：
      // URL 未帶帳號時，切到 kafka/elastic 清掉預設 root；離開時留空則補回 root。
      if (p.username == null) {
        if (noRootKind(knownKind) && username === "root") setUsername("");
        else if (noRootKind(kind) && !noRootKind(knownKind) && username === "") setUsername("root");
      }
      setKind(knownKind);
      // port 用解析值，缺省補該 kind 預設；不走 onKindChange 的「跟隨前一 kind 預設埠」啟發式。
      setPort(p.port ?? KIND_META[knownKind].defaultPort);
    } else if (p.port != null) {
      setPort(p.port);
    }
    if (p.host) setHost(p.host);
    if (p.username != null) setUsername(p.username);
    if (p.password != null) setPassword(p.password);
    if (p.database != null) setDatabase(p.database);
    const o = p.options ?? {};
    if (o.ssl_mode != null) setSslMode(o.ssl_mode);
    if (o.ssl_ca != null) setSslCa(o.ssl_ca);
    if (o.redis_tls != null) setRedisTls(optBool(o.redis_tls));
    if (o.redis_tls_insecure != null) setRedisTlsInsecure(optBool(o.redis_tls_insecure));
    if (o.mongo_srv != null) setMongoSrv(optBool(o.mongo_srv));
    if (o.mongo_auth_source != null) setMongoAuthSource(o.mongo_auth_source);
    if (o.mongo_replica_set != null) setMongoReplicaSet(o.mongo_replica_set);
    if (o.mongo_direct != null) setMongoDirect(optBool(o.mongo_direct));
    if (o.mongo_tls_ca != null) setMongoTlsCa(o.mongo_tls_ca);
    if (o.mongo_tls_insecure != null) setMongoTlsInsecure(optBool(o.mongo_tls_insecure));
    // tlsCAFile / tlsAllowInvalidCertificates 隱含 TLS（Atlas / DocumentDB 字串常不帶 tls=true）——
    // 不連動 mongo_tls 的話 CA 欄位會被 gate 隱藏、buildOptions 會把匯入值靜默剔除。
    if (o.mongo_tls != null || o.mongo_tls_ca != null || o.mongo_tls_insecure != null)
      setMongoTls(o.mongo_tls != null ? optBool(o.mongo_tls) : true);
    if (o.encrypt != null) setMssqlEncrypt(o.encrypt !== "false");
    if (o.trust_server_certificate != null) setMssqlTrust(optBool(o.trust_server_certificate));
    if (o.trust_cert_ca != null) setMssqlCaPath(o.trust_cert_ca);
    if (o.rabbitmq_vhost != null) setRabbitVhost(o.rabbitmq_vhost);
    if (o.rabbitmq_tls != null) setRabbitTls(optBool(o.rabbitmq_tls));
    if (o.rabbitmq_mgmt_url != null) setRabbitMgmtUrl(o.rabbitmq_mgmt_url);
  };

  const doImport = async () => {
    const url = importUrl.trim();
    if (!url) return;
    setImportMsg(null);
    try {
      const p = await api.parseConnectionUrl(url);
      applyParsed(p);
      setImportOpen(false);
      setImportUrl("");
      setPickerOpen(false);
      setImportMsg({
        ok: true,
        text: t("已依連線字串填入 {kind} 設定，請確認後測試連線", { kind: p.kind ? KIND_META[p.kind].label : "—" }),
      });
    } catch (e: any) {
      setImportMsg({ ok: false, text: e?.message ?? t("無法解析連線字串") });
    }
  };

  // Elastic Cloud ID：`deployment-name:base64(host$es_uuid$kibana_uuid)` → 節點 URL `https://{es_uuid}.{host}`。
  // 純前端一次性展開（不入 options），解析失敗不阻擋、留給使用者自行填主機。
  const onCloudIdChange = (v: string) => {
    setEsCloudId(v);
    const raw = v.trim();
    const colon = raw.indexOf(":");
    if (colon <= 0) return;
    try {
      const decoded = atob(raw.slice(colon + 1));
      const [cloudHost, esUuid] = decoded.split("$");
      if (cloudHost && esUuid) {
        setHost(`https://${esUuid}.${cloudHost}`);
        setEsTls(true);
      }
    } catch {
      /* 非合法 base64：忽略，讓使用者手動填 */
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMsg(null);
    const t0 = performance.now();
    try {
      await api.testConnection(build());
      setMsg({ ok: true, text: t("連線成功（{round} ms）", { round: Math.round(performance.now() - t0) }) });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? t("連線失敗") });
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
      title={editing ? t("編輯連線") : t("新增連線")}
      icon={Plug}
      size="lg"
      zClass="z-50"
      bodyClassName="p-5 space-y-3 overflow-auto"
      footer={
        <>
          <Button variant="secondary" className="mr-auto" loading={testing} onClick={handleTest}>
            {t("測試連線")}
          </Button>
          <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!valid}>{t("儲存")}</Button>
        </>
      }
    >
      {/* 從連線字串匯入：貼雲端服務控制台給的 URI（Supabase / Atlas / Upstash / Azure…）一鍵填表。 */}
      {!importOpen ? (
        <Button variant="secondary" icon={ClipboardPaste} onClick={() => { setImportOpen(true); setImportMsg(null); }}>
          {t("從連線字串匯入")}
        </Button>
      ) : (
        <Field hint={t("支援 mysql:// postgres:// mongodb+srv:// rediss:// sqlserver:// 及 Azure ADO.NET 格式")}>
          <div className="flex gap-2">
            <Input
              autoFocus
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="postgres://user:pass@db.xxx.supabase.co:5432/postgres?sslmode=require"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void doImport(); }
                if (e.key === "Escape") { setImportOpen(false); setImportMsg(null); }
              }}
            />
            <Button variant="secondary" onClick={() => void doImport()} className="shrink-0">{t("解析並填入")}</Button>
          </div>
        </Field>
      )}
      {importMsg && <div className={`text-sm ${importMsg.ok ? "text-success" : "text-danger"}`}>{importMsg.text}</div>}

      <KindPicker
        value={kind}
        collapsed={!pickerOpen}
        onChange={(k) => { onKindChange(k); setPickerOpen(false); }}
        onExpand={() => setPickerOpen(true)}
      />

      <Field label={t("名稱")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("選填")} />
      </Field>

      {external ? (
        <>
          <Field label={t("驅動")}>
            <Input value={driver} onChange={(e) => setDriver(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("driver 名稱")} />
          </Field>
          <Field label={t("Gateway 網址（base URL）")}>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onKeyDown={submitOnEnter} placeholder="https://gateway.internal" />
          </Field>
          <Field label={t("環境（env，選填）")}>
            <Input value={env} onChange={(e) => setEnv(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("例如 n8xuat / otprod")} />
          </Field>
          <div className="flex gap-3">
            <Field label={t("使用者")} className="flex-1">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} />
            </Field>
            <Field label={t("密碼")} className="flex-1">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={submitOnEnter} placeholder={editing ? t("留空＝不變更") : ""} />
            </Field>
          </div>
          <Field label={t("OTP secret（2FA，選填）")}>
            <Input type="password" value={otpSecret} onChange={(e) => setOtpSecret(e.target.value)} onKeyDown={submitOnEnter} placeholder={editing ? t("留空＝不變更") : t("base32 或 otpauth:// URI")} />
          </Field>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={insecure} onChange={(e) => setInsecure(e.target.checked)} />
            <span>{t("略過 TLS 憑證驗證（內部自簽憑證用）")}</span>
          </label>
        </>
      ) : fileBased ? (
        <Field label={t("資料庫檔案路徑")}>
          <div className="flex gap-2">
            <Input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              onKeyDown={submitOnEnter}
              placeholder={t("例如 C:\\\\data\\\\app.db（留空則用記憶體資料庫）")}
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
            <Field label={kind === "mongo" && mongoSrv ? t("主機（SRV 域名）") : kind === "kafka" ? t("Bootstrap servers") : kind === "elastic" ? t("節點 URL / 主機") : t("主機")} className="flex-1">
              <Input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={submitOnEnter}
                placeholder={kind === "mongo" && mongoSrv ? t("例如 cluster0.abcd.mongodb.net") : kind === "kafka" ? t("host1:9092,host2:9092") : kind === "elastic" ? t("https://es.example.com:9243 或 localhost") : ""} />
            </Field>
            {/* SRV 連線由 DNS 記錄決定 port；Elastic 貼完整 URL 時 port 內含於 URL，皆不顯示埠欄位。 */}
            {!(kind === "mongo" && mongoSrv) && !(kind === "elastic" && esHostIsUrl) && (
              <Field label={t("埠")} className="w-24">
                <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} onKeyDown={submitOnEnter} />
              </Field>
            )}
          </div>
          {/* Kafka / Elastic 無共用帳密（各有專屬認證區塊），不顯示這排。 */}
          {kind !== "kafka" && kind !== "elastic" && (
            <div className="flex gap-3">
              <Field label={t("使用者")} className="flex-1">
                <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} />
              </Field>
              <Field label={t("密碼")} className="flex-1">
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={submitOnEnter}
                  placeholder={editing ? t("留空＝不變更") : ""}
                />
              </Field>
            </div>
          )}
          {/* 無資料庫概念的類型（KIND_META.noDatabase：kafka 等）不顯示 database 欄。 */}
          {!KIND_META[kind].noDatabase && (
            <Field label={
              kind === "oracle"
                ? (oracleConnectType === "sid" ? "SID" : oracleConnectType === "tns" ? t("TNS 別名") : t("服務名稱（Service Name）"))
                : t("資料庫（選填）")
            }>
              <Input value={database} onChange={(e) => setDatabase(e.target.value)} onKeyDown={submitOnEnter}
                placeholder={kind === "oracle" ? t("例如 ORCLPDB1 / FREEPDB1") : ""} />
            </Field>
          )}

          {kind === "redis" && (
            <Section>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={redisTls} onChange={(e) => setRedisTls(e.target.checked)} />
                <span>{t("使用 TLS（rediss://）")}</span>
              </label>
              {redisTls && (
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none pl-6">
                  <input type="checkbox" checked={redisTlsInsecure} onChange={(e) => setRedisTlsInsecure(e.target.checked)} />
                  <span>{t("略過憑證驗證（自簽憑證用）")}</span>
                </label>
              )}
              {redisTls && sshEnabled && (
                <div className="text-xs text-warning pl-6">
                  {t("透過 SSH Tunnel 時主機會改寫為 127.0.0.1，憑證主機名驗證會失敗，通常需勾「略過憑證驗證」。")}
                </div>
              )}
            </Section>
          )}

          {kind === "mongo" && (
            <Section>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mongoSrv} onChange={(e) => setMongoSrv(e.target.checked)} />
                <span>{t("SRV 連線（mongodb+srv://，Atlas 等）")}</span>
              </label>
              <div className="flex gap-3">
                <Field label={t("authSource（選填）")} className="flex-1">
                  <Input value={mongoAuthSource} onChange={(e) => setMongoAuthSource(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("例如 admin")} />
                </Field>
                <Field label={t("replicaSet（選填）")} className="flex-1">
                  <Input value={mongoReplicaSet} onChange={(e) => setMongoReplicaSet(e.target.value)} onKeyDown={submitOnEnter} placeholder={t("例如 rs0")} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mongoTls} onChange={(e) => setMongoTls(e.target.checked)} />
                <span>{t("使用 TLS")}</span>
              </label>
              {mongoTls && (
                <>
                  <CaPathField value={mongoTlsCa} onChange={setMongoTlsCa} onKeyDown={submitOnEnter}
                    hint={t("AWS DocumentDB 等服務需指定服務商 CA bundle")} />
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none pl-6">
                    <input type="checkbox" checked={mongoTlsInsecure} onChange={(e) => setMongoTlsInsecure(e.target.checked)} />
                    <span>{t("略過憑證驗證（自簽憑證用）")}</span>
                  </label>
                </>
              )}
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mongoDirect} onChange={(e) => setMongoDirect(e.target.checked)} />
                <span>{t("直連（directConnection，繞過拓撲探索）")}</span>
              </label>
            </Section>
          )}

          {sslKinds.includes(kind) && (
            <Section>
              <Field label={t("SSL 模式")}>
                <Select selectSize="md" value={sslMode} onChange={(e) => setSslMode(e.target.value)}>
                  {(SSL_MODE_OPTIONS[kind === "postgres" ? "postgres" : "mysql"] ?? []).map((o) => (
                    <option key={o.value} value={o.value}>{t(o.label)}</option>
                  ))}
                </Select>
              </Field>
              {VERIFY_SSL_MODES.includes(sslMode) && (
                <CaPathField value={sslCa} onChange={setSslCa} onKeyDown={submitOnEnter}
                  hint={t("AWS RDS 等服務需下載服務商 CA bundle（如 global-bundle.pem）")} />
              )}
              {sshEnabled && (sslMode === "verify-full" || sslMode === "verify_identity") && (
                <div className="text-xs text-warning">
                  {t("透過 SSH Tunnel 時主機會改寫為 127.0.0.1，憑證主機名驗證會失敗，建議改用 verify-ca 或 require。")}
                </div>
              )}
            </Section>
          )}

          {kind === "oracle" && (
            <Section>
              <Segmented
                full
                ariaLabel={t("Oracle 連線方式")}
                value={oracleConnectType}
                onChange={setOracleConnectType}
                options={[
                  { value: "service", label: t("服務名稱") },
                  { value: "sid", label: "SID" },
                  { value: "tns", label: t("TNS 別名") },
                ]}
              />
              <Field label={t("Instant Client 目錄（選填）")}>
                <Input value={oracleClientDir} onChange={(e) => setOracleClientDir(e.target.value)} onKeyDown={submitOnEnter}
                  placeholder={t("留空則用 ORACLE_HOME / PATH 偵測")} />
              </Field>
              <div className="text-xs text-fg/40">
                {t("需安裝 64 位元 Oracle Instant Client（Basic / Basic Light）。client 目錄於首個 Oracle 連線生效，之後變更需重啟應用程式。")}
              </div>
            </Section>
          )}

          {kind === "mssql" && (
            <Section>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mssqlEncrypt} onChange={(e) => setMssqlEncrypt(e.target.checked)} />
                <span>{t("加密連線（encrypt）")}</span>
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={mssqlTrust} onChange={(e) => setMssqlTrust(e.target.checked)} />
                <span>{t("信任伺服器憑證（自簽 / 開發用）")}</span>
              </label>
              {mssqlEncrypt && !mssqlTrust && (
                <CaPathField value={mssqlCaPath} onChange={setMssqlCaPath} onKeyDown={submitOnEnter}
                  hint={t("自簽 / 私有 CA 環境可指定 CA 憑證，避免整個信任任意憑證")} />
              )}
            </Section>
          )}

          {kind === "kafka" && (
            <Section>
              <Field label={t("安全協定")}>
                <Select selectSize="md" value={kafkaProtocol} onChange={(e) => setKafkaProtocol(e.target.value)}>
                  {["PLAINTEXT", "SASL_PLAINTEXT", "SSL", "SASL_SSL"].map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </Select>
              </Field>
              {/* 帳密僅 SASL 需要（仿 Conduktor / kafka-ui：選了 SASL 協定才出現認證欄位）。 */}
              {kafkaProtocol.startsWith("SASL") && (
                <>
                  <Field label={t("SASL 機制")}>
                    <Select selectSize="md" value={kafkaSaslMech} onChange={(e) => setKafkaSaslMech(e.target.value)}>
                      {["PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </Select>
                  </Field>
                  <div className="flex gap-3">
                    <Field label={t("SASL 使用者")} className="flex-1">
                      <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} />
                    </Field>
                    <Field label={t("SASL 密碼")} className="flex-1">
                      <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={submitOnEnter}
                        placeholder={editing ? t("留空＝不變更") : ""} />
                    </Field>
                  </div>
                </>
              )}
              {kafkaProtocol.endsWith("SSL") && (
                <>
                  <CaPathField value={kafkaCaPath} onChange={setKafkaCaPath} onKeyDown={submitOnEnter} />
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input type="checkbox" checked={kafkaSkipVerify} onChange={(e) => setKafkaSkipVerify(e.target.checked)} />
                    <span>{t("略過憑證驗證（自簽憑證用）")}</span>
                  </label>
                </>
              )}
              {kafkaProtocol !== "PLAINTEXT" && (
                <div className="text-xs text-warning">
                  {t("TLS / SCRAM 需以 kafka-tls feature（含 OpenSSL）建置；預設建置僅支援 PLAINTEXT / SASL_PLAINTEXT + PLAIN。")}
                </div>
              )}
              <Section title="Schema Registry">
                <Field label={t("Schema Registry URL（選填）")}>
                  <Input value={srUrl} onChange={(e) => setSrUrl(e.target.value)} onKeyDown={submitOnEnter} placeholder="http://localhost:8081" />
                </Field>
                {srUrl.trim() && (
                  <div className="flex gap-3">
                    <Field label={t("SR 使用者（選填）")} className="flex-1">
                      <Input value={srUser} onChange={(e) => setSrUser(e.target.value)} onKeyDown={submitOnEnter} />
                    </Field>
                    <Field label={t("SR 密碼（選填）")} className="flex-1">
                      <Input type="password" value={srPass} onChange={(e) => setSrPass(e.target.value)} onKeyDown={submitOnEnter} />
                    </Field>
                  </div>
                )}
              </Section>
              <Section title="Kafka Connect">
                <Field label={t("Kafka Connect URL（選填）")}>
                  <Input value={connectUrl} onChange={(e) => setConnectUrl(e.target.value)} onKeyDown={submitOnEnter} placeholder="http://localhost:8083" />
                </Field>
                {connectUrl.trim() && (
                  <div className="flex gap-3">
                    <Field label={t("Connect 使用者（選填）")} className="flex-1">
                      <Input value={connectUser} onChange={(e) => setConnectUser(e.target.value)} onKeyDown={submitOnEnter} />
                    </Field>
                    <Field label={t("Connect 密碼（選填）")} className="flex-1">
                      <Input type="password" value={connectPass} onChange={(e) => setConnectPass(e.target.value)} onKeyDown={submitOnEnter} />
                    </Field>
                  </div>
                )}
              </Section>
              <div className="text-xs text-fg/40">{t("Bootstrap servers 可逗號分隔多個 broker。")}</div>
            </Section>
          )}

          {kind === "elastic" && (
            <Section>
              <Field label={t("貼上 Elastic Cloud ID（選填）")} hint={t("Elastic Cloud 主控台複製，貼上後自動解出節點 URL")}>
                <Input value={esCloudId} onChange={(e) => onCloudIdChange(e.target.value)} onKeyDown={submitOnEnter}
                  placeholder="deployment-name:dXMtZWFzdC0xLmF3cy4uLg==" />
              </Field>
              <Field label={t("認證方式")}>
                <Segmented
                  full
                  ariaLabel={t("認證方式")}
                  value={esAuth}
                  onChange={setEsAuth}
                  options={[
                    { value: "none", label: t("無") },
                    { value: "basic", label: "Basic" },
                    { value: "apikey", label: "API Key" },
                  ]}
                />
              </Field>
              {esAuth === "basic" && (
                <div className="flex gap-3">
                  <Field label={t("使用者")} className="flex-1">
                    <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} />
                  </Field>
                  <Field label={t("密碼")} className="flex-1">
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={submitOnEnter}
                      placeholder={editing ? t("留空＝不變更") : ""} />
                  </Field>
                </div>
              )}
              {esAuth === "apikey" && (
                <Field label="API Key" hint={t("Elastic Cloud 的 encoded API key，或 id:key 兩段式（自動編碼）")}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={submitOnEnter}
                    placeholder={editing ? t("留空＝不變更") : ""} />
                </Field>
              )}
              {esHostIsUrl ? (
                <div className="text-xs text-fg/40">{t("TLS 由節點 URL 的 https/http 決定。")}</div>
              ) : (
                <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                  <input type="checkbox" checked={esTls} onChange={(e) => setEsTls(e.target.checked)} />
                  <span>{t("使用 TLS（https）")}</span>
                </label>
              )}
              {(esTls || esHostIsUrl) && (
                <>
                  <CaPathField value={esSslCa} onChange={setEsSslCa} onKeyDown={submitOnEnter}
                    hint={t("自簽 / 內網憑證可指定 CA；企業 CA 已進系統信任庫則免填")} />
                  <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                    <input type="checkbox" checked={esSslInsecure} onChange={(e) => setEsSslInsecure(e.target.checked)} />
                    <span>{t("略過憑證驗證（自簽憑證用）")}</span>
                  </label>
                </>
              )}
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={esShowHidden} onChange={(e) => setEsShowHidden(e.target.checked)} />
                <span>{t("顯示系統索引（. 開頭）")}</span>
              </label>
              {(esTls || esHostIsUrl) && sshEnabled && (
                <div className="text-xs text-warning">
                  {t("透過 SSH Tunnel 時主機會改寫為 127.0.0.1，憑證主機名驗證會失敗，通常需勾「略過憑證驗證」。")}
                </div>
              )}
            </Section>
          )}

          {kind === "rabbitmq" && (
            <Section>
              <Field label={t("Virtual host（vhost）")} hint={t("預設 /；CloudAMQP 的 vhost 通常等於使用者名稱")}>
                <Input value={rabbitVhost} onChange={(e) => setRabbitVhost(e.target.value)} onKeyDown={submitOnEnter} placeholder="/" />
              </Field>
              <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                <input type="checkbox" checked={rabbitTls}
                  onChange={(e) => {
                    setRabbitTls(e.target.checked);
                    // 勾 TLS 時若埠仍是預設 5672 → 改 5671（amqps）；取消則還原。
                    setPort((p) => (e.target.checked ? (p === 5672 ? 5671 : p) : (p === 5671 ? 5672 : p)));
                  }} />
                <span>{t("使用 TLS（amqps）")}</span>
              </label>
              <Field label={t("Management API URL（選填）")}
                hint={t("留空＝ http(s)://{host}:15672；佇列清單 / 總覽需要此 API。帳密沿用上方 AMQP 帳密")}>
                <Input value={rabbitMgmtUrl} onChange={(e) => setRabbitMgmtUrl(e.target.value)} onKeyDown={submitOnEnter}
                  placeholder={rabbitTls ? "https://host:15672" : "http://host:15672"} />
              </Field>
            </Section>
          )}
        </>
      )}

      {!fileBased && !external && (
        <Section>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} />
            <span>{t("透過 SSH Tunnel 連線")}</span>
          </label>
          {sshEnabled && (
            <>
              <div className="flex gap-3">
                <Field label={t("SSH 主機")} className="flex-1">
                  <Input value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
                </Field>
                <Field label={t("SSH 埠")} className="w-24">
                  <Input type="number" value={sshPort} onChange={(e) => setSshPort(Number(e.target.value))} />
                </Field>
              </div>
              <Field label={t("SSH 使用者")}>
                <Input value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} />
              </Field>
              <Segmented
                full
                ariaLabel={t("SSH 認證方式")}
                value={sshAuthMethod}
                onChange={setSshAuthMethod}
                options={[
                  { value: "password", label: t("密碼認證") },
                  { value: "key", label: t("私鑰認證") },
                ]}
              />
              {sshAuthMethod === "password" ? (
                <Field label={t("SSH 密碼")}>
                  <Input
                    type="password"
                    value={sshPassword}
                    onChange={(e) => setSshPassword(e.target.value)}
                    placeholder={editing ? t("留空＝不變更") : ""}
                  />
                </Field>
              ) : (
                <>
                  <Field label={t("私鑰檔路徑")}>
                    <div className="flex gap-2">
                      <Input
                        value={sshKeyPath}
                        onChange={(e) => setSshKeyPath(e.target.value)}
                        placeholder={t("例如 C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519")}
                      />
                      <BrowseButton
                        onPick={async () => {
                          const p = await pickOpenFile();
                          if (p) setSshKeyPath(p);
                        }}
                      />
                    </div>
                  </Field>
                  <Field label={t("私鑰密語（選填）")}>
                    <Input
                      type="password"
                      value={sshPassphrase}
                      onChange={(e) => setSshPassphrase(e.target.value)}
                      placeholder={editing ? t("留空＝不變更") : ""}
                    />
                  </Field>
                </>
              )}
            </>
          )}
        </Section>
      )}

      {msg && <div className={`text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</div>}
    </Modal>
  );
}

function BrowseButton({ onPick }: { onPick: () => void }) {
  const t = useT();
  return (
    <Button variant="secondary" icon={FolderOpen} onClick={onPick} title={t("瀏覽…")} className="shrink-0">
      {t("瀏覽")}
    </Button>
  );
}

// 各 kind 專屬選項的視覺分組（上緣分隔線 + 可選小標）。新 kind 的專屬區塊一律用它，不手刻 border-t。
function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="border-t border-fg/10 pt-3 space-y-2.5">
      {title && <div className="text-xs font-medium text-fg/50">{title}</div>}
      {children}
    </div>
  );
}

// CA 憑證路徑欄（Input + 瀏覽鈕 + PEM filter）。mongo / mysql-pg / mssql / kafka 共用，
// 新 kind 的 TLS 區塊直接用，避免每處重抄同一段 JSX 與副檔名清單。
function CaPathField({
  value,
  onChange,
  onKeyDown,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: React.KeyboardEventHandler;
  hint?: ReactNode;
}) {
  const t = useT();
  return (
    <Field label={t("CA 憑證路徑（選填）")} hint={hint}>
      <div className="flex gap-2">
        <Input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
        <BrowseButton
          onPick={async () => {
            const p = await pickOpenFile([{ name: "PEM", extensions: ["pem", "crt", "cer"] }]);
            if (p) onChange(p);
          }}
        />
      </div>
    </Field>
  );
}
