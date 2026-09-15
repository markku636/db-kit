import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ConnectionConfig, DbKind, KIND_META, SshAuthMethod } from "./api";
import { applyParsedToForm, ChangedField, ConnFormFields, looksLikeConnectionString } from "./connString";
import { pickOpenFile } from "./ui";
import { askOtpCode } from "./otpGate";
import { Modal, Field, Input, Button, Segmented, Select } from "./ui/index";
import { Plug, FolderOpen, ClipboardPaste } from "lucide-react";
import { useT } from "./i18n";
import KindPicker from "./KindPicker";
import { useStore } from "./store";

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

// 匯入變動摘要要逐項列出的欄位（繁中字串即 i18n key）。只收使用者真正需要核對的主要欄位——
// 類型專屬設定有三十幾個，全列出來摘要會比表單還長，那些只報件數。
const IMPORT_SUMMARY_LABELS: Partial<Record<keyof ConnFormFields, string>> = {
  kind: "類型",
  host: "主機",
  port: "埠",
  username: "使用者",
  password: "密碼",
  database: "資料庫",
};

/** 摘要的值格式化。密碼一律遮罩；空值與布林給得出人話。 */
function fmtSummaryVal(
  key: keyof ConnFormFields,
  v: string | number | boolean,
  t: (zh: string, params?: Readonly<Record<string, string | number>>) => string,
): string {
  if (key === "password") return v === "" ? t("（空）") : "••••••";
  if (key === "kind") return KIND_META[v as DbKind]?.label ?? String(v);
  if (typeof v === "boolean") return v ? t("開") : t("關");
  return v === "" ? t("（空）") : String(v);
}

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
  // 連線字串欄（常駐；貼上即解析）。
  const [importUrl, setImportUrl] = useState("");
  // 匯入結果與測試結果分開存：套用解析結果會改欄位並觸發 msg 清除 effect，共用會讓成功訊息立刻消失。
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 本次匯入實際改動了哪些欄位（供「已填入」摘要）；null＝尚未匯入過。
  const [importChanged, setImportChanged] = useState<ChangedField[] | null>(null);
  // 匯入前的欄位快照，供單步「復原」。存 ref 而非 state：它不參與渲染決策，
  // 只在按下復原時被讀一次，放進 state 只會多一輪無意義的重繪。
  const undoRef = useRef<ConnFormFields | null>(null);
  // SSH Tunnel
  const [sshEnabled, setSshEnabled] = useState(initial?.ssh_enabled ?? false);
  const [sshHost, setSshHost] = useState(initial?.ssh_host ?? "");
  const [sshPort, setSshPort] = useState(initial?.ssh_port || 22);
  const [sshUsername, setSshUsername] = useState(initial?.ssh_username ?? "");
  const [sshAuthMethod, setSshAuthMethod] = useState<SshAuthMethod>(initial?.ssh_auth_method ?? "password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState(initial?.ssh_private_key_path ?? "");
  const [sshPassphrase, setSshPassphrase] = useState("");
  // 外部 gateway（kind === "external"）：driver / base_url 等存於 options map。
  // driver 不再讓使用者填：目前唯一的外部驅動就是 qland（見後端 db::external::connect_external），
  // 選了「QLand」類型卻還要手打 driver 名稱只會打錯。日後有第二個外部驅動再把選擇 UI 加回來。
  const driver = initial?.options?.driver || "qland";
  const [baseUrl, setBaseUrl] = useState(initial?.options?.base_url ?? "");
  const [insecure, setInsecure] = useState(initial?.options?.insecure === "1");
  const [otpSecret, setOtpSecret] = useState("");
  // 每次連線跳窗手動輸入 OTP（不儲存 TOTP secret）。新連線預設開啟：
  // gateway 帳號多半有 2FA，而把 secret 存在本機等於 2FA 只剩一道密碼。
  const [otpPrompt, setOtpPrompt] = useState(editing ? initial?.options?.otp_prompt === "1" : true);
  // 正式環境標記（所有類型共用，存 options.prod）：不改變連線 / 查詢行為，
  // 只影響防呆 UI —— 側欄掛 PROD 標記 + 執行查詢前跳確認。
  const [prod, setProd] = useState(initial?.options?.prod === "1");
  // 唯讀連線（與側欄右鍵「設為唯讀模式」同一份狀態，存 localStorage 而非連線設定檔）：
  // 擋查詢編輯器的寫入 / DDL 與資料格編輯。放進表單是因為「新增連線的當下」才是決定它能不能寫的時機，
  // 存好之後再去右鍵補設定，中間那段空窗期就是誤改正式資料的機會。
  const [readonlyConn, setReadonlyConn] = useState(() =>
    initial ? useStore.getState().readonlyConns[initial.id] === true : KIND_META[kind].external === true);
  // 使用者自己動過勾選之後就別再自動改：換類型的自動預設只在「還沒表態」時生效。
  const [readonlyTouched, setReadonlyTouched] = useState(false);
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
  // Kibana Discover 連結：根網址 + 時間欄位。認證沿用同一份 ES 設定，不另外填。
  const [esKibanaUrl, setEsKibanaUrl] = useState(initial?.options?.es_kibana_url ?? "");
  const [esTimeField, setEsTimeField] = useState(initial?.options?.es_time_field ?? "");
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
    // 手動輸入模式不留 secret：送空字串＝維持 keychain 現況（後端「空＝不變更」語意），
    // 驅動端則因 otp_prompt=1 而直接忽略任何既存 secret。
    otp_secret: otpPrompt ? "" : otpSecret,
  });

  // 依 kind 組 options map（連線層非機密設定）。回 undefined 表示無額外選項。
  const buildOptions = (): Record<string, string> | undefined => {
    if (kind === "external") {
      // 保留 cache_ttl_secs / max_concurrency 等「無 UI」的進階選項：回物件字面值會把未列舉的
      // 鍵一併清掉（使用者只是開對話框按存檔，進階設定就沒了）。
      const ext: Record<string, string> = { ...(initial?.options ?? {}) };
      ext.driver = driver;
      ext.base_url = baseUrl;
      // env 已移除：它從來沒有任何讀取端（驅動與前端都不看），只是個會誤導人的空欄位。
      // 分環境請用側欄群組。存檔時順手清掉舊連線殘留的鍵，別讓死資料一直留在設定檔。
      delete ext.env;
      if (insecure) ext.insecure = "1";
      else delete ext.insecure; // 取消勾選要真的移除，不能靠 spread 蓋掉舊值
      if (otpPrompt) ext.otp_prompt = "1";
      else delete ext.otp_prompt;
      if (prod) ext.prod = "1";
      else delete ext.prod;
      // 一次性驗證碼由後端在連線當下注入 options，絕不隨設定存檔（spread 保險起見再清一次）。
      delete ext.otp_code;
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
      if (esKibanaUrl.trim()) o.es_kibana_url = esKibanaUrl.trim().replace(/\/+$/, "");
      if (esTimeField.trim()) o.es_time_field = esTimeField.trim();
    } else if (kind === "rabbitmq") {
      if (rabbitVhost.trim() && rabbitVhost.trim() !== "/") o.rabbitmq_vhost = rabbitVhost.trim();
      if (rabbitTls) o.rabbitmq_tls = "1";
      if (rabbitMgmtUrl.trim()) o.rabbitmq_mgmt_url = rabbitMgmtUrl.trim();
    } else if (sslKinds.includes(kind)) {
      if (sslMode) o.ssl_mode = sslMode;
      // CA 只在 verify-* 模式生效（require/required 不驗證憑證，sqlx 會忽略）。
      if (VERIFY_SSL_MODES.includes(sslMode) && sslCa.trim()) o.ssl_ca = sslCa.trim();
    }
    // 正式環境標記與 kind 無關（每種 DB 都可能是 prod），故放在各 kind 分支之外。
    if (prod) o.prod = "1";
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
    // 新連線的「唯讀」預設跟著類型走：external（QLand gateway）指到的是共用的 UAT / PROD，
    // 預設鎖起來，真要改的人得自己來取消勾選。編輯既有連線不動它（那是使用者已經決定過的事）。
    if (!editing && !readonlyTouched) setReadonlyConn(KIND_META[k].external === true);
    setKind(k);
  };

  // 匯入的快照 / 還原。本元件有約 40 個 useState，改寫成單一 reducer 動到的範圍太大、風險遠大於
  // 收益；改以一份 ConnFormFields 型別同時服務三件事：快照（復原用）、純映射的輸入與輸出、
  // 以及變動摘要的 diff 來源。少寫一個欄位 TS 就會報錯，不會默默漏掉。
  const snapshotForm = (): ConnFormFields => ({
    kind, host, port, username, password, database,
    sslMode, sslCa,
    redisTls, redisTlsInsecure,
    mongoSrv, mongoAuthSource, mongoTls, mongoReplicaSet, mongoDirect, mongoTlsCa, mongoTlsInsecure,
    mssqlEncrypt, mssqlTrust, mssqlCaPath,
    oracleConnectType, oracleClientDir,
    kafkaProtocol, kafkaSaslMech, kafkaCaPath, kafkaSkipVerify,
    esAuth, esTls, esSslCa, esSslInsecure, esKibanaUrl,
    rabbitVhost, rabbitTls, rabbitMgmtUrl,
  });

  const restoreForm = (f: ConnFormFields) => {
    setKind(f.kind); setHost(f.host); setPort(f.port); setUsername(f.username);
    setPassword(f.password); setDatabase(f.database);
    setSslMode(f.sslMode); setSslCa(f.sslCa);
    setRedisTls(f.redisTls); setRedisTlsInsecure(f.redisTlsInsecure);
    setMongoSrv(f.mongoSrv); setMongoAuthSource(f.mongoAuthSource); setMongoTls(f.mongoTls);
    setMongoReplicaSet(f.mongoReplicaSet); setMongoDirect(f.mongoDirect);
    setMongoTlsCa(f.mongoTlsCa); setMongoTlsInsecure(f.mongoTlsInsecure);
    setMssqlEncrypt(f.mssqlEncrypt); setMssqlTrust(f.mssqlTrust); setMssqlCaPath(f.mssqlCaPath);
    setOracleConnectType(f.oracleConnectType); setOracleClientDir(f.oracleClientDir);
    setKafkaProtocol(f.kafkaProtocol); setKafkaSaslMech(f.kafkaSaslMech);
    setKafkaCaPath(f.kafkaCaPath); setKafkaSkipVerify(f.kafkaSkipVerify);
    setEsAuth(f.esAuth); setEsTls(f.esTls); setEsSslCa(f.esSslCa);
    setEsSslInsecure(f.esSslInsecure); setEsKibanaUrl(f.esKibanaUrl);
    setRabbitVhost(f.rabbitVhost); setRabbitTls(f.rabbitTls); setRabbitMgmtUrl(f.rabbitMgmtUrl);
  };

  // 解析連線字串並填表。後端 parse_connection_url（與 dbk --url 同一套邏輯）負責解析，
  // 前端只負責把結果映射進欄位（純函式在 connString.ts，可單測）。
  // 先套用、再顯示變動摘要、留一顆「復原」——而不是套用前再插一層確認：
  // 這個對話框已經十幾欄還要捲動，modal-in-modal 只會更難用。
  const doImport = async (raw: string) => {
    const url = raw.trim();
    if (!url) return;
    setImportMsg(null);
    setImportChanged(null);
    try {
      // 傳當下選的類型當提示：Oracle EZConnect / 裸 host:port / sqlite 路徑都不帶類型資訊，
      // 沒提示的話後端只能報「無法解析」。後端對有提示的輸入會多做一道結構檢查（looks_structured），
      // 所以隨手貼一段文字仍然會被擋下來，不會靜默塞進主機欄。
      const p = await api.parseConnectionUrl(url, kind);
      const before = snapshotForm();
      const { next, changed } = applyParsedToForm(p, before);
      undoRef.current = before;
      restoreForm(next);
      setImportChanged(changed);
      setImportUrl("");
      setPickerOpen(false);
      setImportMsg({
        ok: true,
        text: t("已依連線字串填入 {kind} 設定，請確認後測試連線", { kind: p.kind ? KIND_META[p.kind].label : "—" }),
      });
    } catch (e: any) {
      // 失敗時保留 importUrl，讓使用者看得到自己貼了什麼（常見是複製被截斷）。
      setImportUrl(url);
      setImportMsg({ ok: false, text: e?.message ?? t("無法解析連線字串") });
    }
  };

  const undoImport = () => {
    const snap = undoRef.current;
    if (!snap) return;
    restoreForm(snap);
    undoRef.current = null;
    setImportChanged(null);
    setImportMsg(null);
  };

  // 主機 / 名稱欄的貼上攔截：若貼進來的是連線字串就改走解析，而不是把整串倒進欄位。
  // 這條才是「直接貼上就會動」的關鍵——多數人不會先去找上面那個連線字串欄。
  // looksLikeConnectionString 刻意保守（見 connString.ts），不是連線字串就完全不介入。
  const onFieldPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!looksLikeConnectionString(text)) return;
    e.preventDefault();
    setImportUrl(text.trim());
    void doImport(text);
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
    const cfg = build();
    // 手動 OTP 模式：測試連線也要走同一道關卡（後端無 secret 可用，不先問就必定失敗）。
    const gate = await askOtpCode(cfg);
    if (gate.cancelled) return;
    setTesting(true);
    setMsg(null);
    const t0 = performance.now();
    try {
      await api.testConnection(cfg, gate.code);
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
  const handleSave = () => {
    if (!valid) return;
    const cfg = build();
    // 先寫唯讀旗標再回報存檔：onSaved 可能立刻開連線 / 重繪側欄，旗標晚一步會閃到「可寫」狀態。
    useStore.getState().setConnReadonly(cfg.id, readonlyConn);
    onSaved(cfg);
  };
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
        // 選類型階段（pickerOpen）只留「取消」：此時尚未進表單，測試 / 儲存無意義（host 有預設值會讓
        // valid 為真而誤導可存）。選定類型後才顯示完整動作列。
        pickerOpen ? (
          <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
        ) : (
          <>
            <Button variant="secondary" className="mr-auto" loading={testing} onClick={handleTest}>
              {t("測試連線")}
            </Button>
            <Button variant="secondary" onClick={onClose}>{t("取消")}</Button>
            <Button variant="primary" onClick={handleSave} disabled={!valid}>{t("儲存")}</Button>
          </>
        )
      }
    >
      {/* 連線字串：常駐欄位，不再藏在按鈕後面。貼雲端控制台給的 URI（Supabase / Atlas / Upstash /
          Confluent / Azure…）一次填完整張表。貼上即解析；手打則按 Enter 或右側按鈕。
          刻意不做「輸入中 debounce 自動解析」——每個按鍵都會重寫類型並清掉類型專屬欄位，會抖動。 */}
      <Field
        label={t("連線字串")}
        hint={t("貼上即自動解析。支援 URL（postgres:// mysql:// mongodb+srv:// rediss://）、libpq（host=… port=…）、JDBC、ADO.NET / Npgsql")}
      >
        <div className="flex gap-2">
          <Input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            onPaste={(e) => {
              // 自己接手剪貼簿原文：不讓它先進欄位再等使用者按按鈕（那就是原本被抱怨的多餘步驟）。
              const text = e.clipboardData.getData("text");
              if (!text.trim()) return;
              e.preventDefault();
              setImportUrl(text.trim());
              void doImport(text);
            }}
            placeholder="postgresql://user:pass@localhost:5432/dbname"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void doImport(importUrl); }
            }}
          />
          <Button
            variant="secondary"
            icon={ClipboardPaste}
            onClick={() => void doImport(importUrl)}
            className="shrink-0"
            disabled={!importUrl.trim()}
          >
            {t("解析並填入")}
          </Button>
        </div>
      </Field>

      {/* 匯入結果 + 變動摘要 + 復原。摘要只列使用者需要核對的主要欄位（密碼一律遮罩——
          這塊會留在畫面上，截圖與共享畫面都看得到），其餘類型專屬設定只報件數。 */}
      {importMsg && (
        <div className={`text-sm ${importMsg.ok ? "text-success" : "text-danger"}`}>
          <div className="flex items-start gap-2">
            <span className="flex-1">{importMsg.text}</span>
            {importMsg.ok && undoRef.current && (
              <button
                type="button"
                onClick={undoImport}
                className="shrink-0 underline text-fg/60 hover:text-fg"
              >
                {t("復原")}
              </button>
            )}
          </div>
          {importMsg.ok && importChanged && importChanged.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg/50">
              {importChanged
                .filter((c) => c.key in IMPORT_SUMMARY_LABELS)
                .map((c) => (
                  <span key={c.key} className="whitespace-nowrap">
                    {t(IMPORT_SUMMARY_LABELS[c.key]!)} {fmtSummaryVal(c.key, c.from, t)} → {fmtSummaryVal(c.key, c.to, t)}
                  </span>
                ))}
              {(() => {
                const rest = importChanged.filter((c) => !(c.key in IMPORT_SUMMARY_LABELS)).length;
                return rest > 0 ? <span className="whitespace-nowrap">{t("其他 {n} 項設定", { n: rest })}</span> : null;
              })()}
            </div>
          )}
        </div>
      )}

      <KindPicker
        value={kind}
        collapsed={!pickerOpen}
        onChange={(k) => { onKindChange(k); setPickerOpen(false); }}
        onExpand={() => setPickerOpen(true)}
      />

      {/* 兩步流程：先選類型（pickerOpen＝只顯示上方類型選擇器），選定後才展開表單，避免類型格與
          十餘欄輸入同屏擠壓、逼使用者捲動。狀態常駐在本元件，收合不會遺失已填內容。 */}
      {!pickerOpen && (
      <>
      <Field label={t("名稱")}>
        <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={submitOnEnter}
          onPaste={onFieldPaste} placeholder={t("選填")} />
      </Field>

      {/* 正式環境標記：與 kind 無關，放在名稱下方讓它在任何類型都第一眼看得到。 */}
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input type="checkbox" checked={prod} onChange={(e) => setProd(e.target.checked)} />
        <span>{t("正式環境（production）：側欄標記 PROD，執行查詢前跳確認")}</span>
      </label>

      {/* 唯讀 / 可編輯：與 prod 同層級的防呆開關，兩者互相獨立（UAT 也可能想鎖唯讀）。 */}
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input type="checkbox" checked={readonlyConn}
          onChange={(e) => { setReadonlyTouched(true); setReadonlyConn(e.target.checked); }} />
        <span>{t("唯讀連線：擋寫入 / DDL 語句與資料格編輯（取消勾選＝可編輯）")}</span>
      </label>

      {external ? (
        <>
          <Field label={t("Gateway 網址（base URL）")} hint={t("只填根網址，登入路徑（/account/login 等）由驅動自己接")}>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} onKeyDown={submitOnEnter} placeholder="https://gateway.internal" />
          </Field>
          <div className="flex gap-3">
            <Field label={t("使用者")} className="flex-1">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={submitOnEnter} />
            </Field>
            <Field label={t("密碼")} className="flex-1">
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={submitOnEnter} placeholder={editing ? t("留空＝不變更") : ""} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input type="checkbox" checked={otpPrompt} onChange={(e) => setOtpPrompt(e.target.checked)} />
            <span>{t("每次連線跳窗手動輸入 OTP（不儲存 secret）")}</span>
          </label>
          {otpPrompt ? (
            <div className="text-xs text-fg/40">
              {t("每次連線 / 測試連線都會要求輸入驗證器當下的 6 碼；本機不留 TOTP secret。連線期間 session 過期需重新連線。")}
            </div>
          ) : (
            <Field label={t("OTP secret（2FA，選填）")} hint={t("存 OS keychain，由 db-kit 自動算出驗證碼")}>
              <Input type="password" value={otpSecret} onChange={(e) => setOtpSecret(e.target.value)} onKeyDown={submitOnEnter} placeholder={editing ? t("留空＝不變更") : t("base32 或 otpauth:// URI")} />
            </Field>
          )}
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
              {/* 貼上攔截：直覺動作是把整串連線字串貼進「主機」，原本會把整串倒進欄位。 */}
              <Input value={host} onChange={(e) => setHost(e.target.value)} onKeyDown={submitOnEnter}
                onPaste={onFieldPaste}
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
          {/* 無資料庫概念的類型（KIND_META.noDatabase：kafka 等）不顯示 database 欄。
              Redis 的「資料庫」是數字索引（0..CONFIG GET databases，通常 16）而非名稱；
              連線前拿不到實際上限，故維持文字輸入而非下拉。 */}
          {!KIND_META[kind].noDatabase && (
            <Field label={
              kind === "oracle"
                ? (oracleConnectType === "sid" ? "SID" : oracleConnectType === "tns" ? t("TNS 別名") : t("服務名稱（Service Name）"))
                : kind === "redis" ? t("資料庫索引（選填）")
                : t("資料庫（選填）")
            }>
              <Input value={database} onChange={(e) => setDatabase(e.target.value)} onKeyDown={submitOnEnter}
                placeholder={kind === "oracle" ? t("例如 ORCLPDB1 / FREEPDB1") : kind === "redis" ? "0" : ""} />
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
              <Field label={t("Kibana 網址（選填）")}
                hint={t("填了才能從查詢結果產生 Kibana Discover 連結；認證沿用上面的設定，不必重填")}>
                <Input value={esKibanaUrl} onChange={(e) => setEsKibanaUrl(e.target.value)} onKeyDown={submitOnEnter}
                  placeholder="https://kibana.example.com" />
              </Field>
              <Field label={t("時間欄位（選填）")}
                hint={t("Discover 連結的時間區間依此欄位換算；留空為 @timestamp")}>
                <Input value={esTimeField} onChange={(e) => setEsTimeField(e.target.value)} onKeyDown={submitOnEnter}
                  placeholder="@timestamp" />
              </Field>
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
      </>
      )}
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
