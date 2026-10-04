// 注入到頁面的 Tauri invoke shim（假後端）：讓沒有 Tauri 執行期的瀏覽器也能跑完整前端。
// 由 capture-screenshots.mjs（產 README 截圖）與 verify-ui.mjs（UI 冒煙檢查）共用——
// 兩者必須跑在同一份假資料上，否則會各自漂移（一邊補了 command、另一邊沒有）。
//
// 注意：此函式會被序列化後在瀏覽器內執行，不能引用模組作用域的任何東西，
// 假資料一律由 fx 參數帶進去（見 screenshot-fixtures.mjs）。

export function installShim(fx) {
  try { sessionStorage.setItem("dbkit:splashed", "1"); } catch { /* 略過開場動畫 */ }
  try {
    for (const [k, v] of Object.entries(fx.STORAGE_SEED)) localStorage.setItem(k, JSON.stringify(v));
    localStorage.setItem("db-kit:queryHistory", JSON.stringify([
      { sql: "SELECT status, COUNT(*) FROM orders GROUP BY status;", at: fx.now - 60_000, ms: 42, conn: "prod-mysql" },
      { sql: "SELECT * FROM customers WHERE tier = 'gold' LIMIT 50;", at: fx.now - 900_000, ms: 18, conn: "prod-mysql" },
    ]));
  } catch { /* localStorage 不可用時就用預設值 */ }

  const unknown = [];
  window.__DBKIT_UNKNOWN__ = unknown;
  // 經「指令列 / AI 送到終端機」送進假 shell 的整行指令（冒煙檢查驗「取消確認框後什麼都沒送」用）。
  window.__DBKIT_SSH_WRITES__ = [];
  // SFTP 編輯器存檔 / chmod 的紀錄（冒煙檢查驗「存了什麼、改成幾號權限」用）。
  window.__DBKIT_SFTP_WRITES__ = [];
  window.__DBKIT_SFTP_CHMOD__ = [];
  // SFTP 刪除與多選批次傳輸的紀錄（驗「刪了哪些、批次帶了哪些路徑與同名策略」用）。
  window.__DBKIT_SFTP_REMOVES__ = [];
  window.__DBKIT_SFTP_BATCH__ = [];
  // 單檔上下傳（驗「續傳有帶 resume」）與改名 / 移動的紀錄。
  window.__DBKIT_SFTP_TRANSFERS__ = [];
  window.__DBKIT_SFTP_RENAMES__ = [];
  // 接下來幾個傳輸要失敗（傳到一半斷線）：情境設成 1，下一個傳輸就會回 error。
  window.__DBKIT_SFTP_FAIL_NEXT__ = 0;
  // 設成 true：假傳輸慢慢跑（約 30 秒），「還有傳輸在跑」的情境才來得及操作。
  window.__DBKIT_SFTP_SLOW__ = false;
  // SFTP 獨立視窗：開 / 關視窗的呼叫、開過幾次 sftp 通道（重新連線後要在新連線上重開）、
  // 前端 emit 的事件（主視窗 ↔ SFTP 視窗的橋）、視窗外掛命令（destroy 之類）。
  window.__DBKIT_SFTP_WINDOWS__ = [];
  window.__DBKIT_SFTP_OPENS__ = [];
  window.__DBKIT_EMITTED__ = [];
  window.__DBKIT_WINDOW_CALLS__ = [];
  // AI 資源庫設定的寫入（ai_library_settings_set 送出的完整設定）。
  window.__DBKIT_AI_SETTINGS_SET__ = [];
  // SSH 主機儲存與金鑰匯入 / 產生的紀錄（驗「存下去的是 keystore:<id>」「匯入帶了哪個密語」用）。
  window.__DBKIT_SSH_SESSION_SAVES__ = [];
  // 終端機工作階段記錄與「另存文字檔」的紀錄。
  window.__DBKIT_SSH_LOG__ = [];
  window.__DBKIT_SAVED_FILES__ = [];
  // SSH 操作紀錄（假後端存的全部紀錄）與假 shell 在 sudo 密碼提示下收到的字（驗「密碼沒有進紀錄」用）。
  window.__DBKIT_SSH_OPLOG__ = [];
  window.__DBKIT_SSH_SECRETS__ = [];
  // 遠端桌面：存檔、連線 / 斷線、送出的位元組 / 輸入紀錄 / ack / resize / 組合鍵 / 全螢幕切換、提示的答案。
  window.__DBKIT_RD_SESSION_SAVES__ = [];
  window.__DBKIT_RD_CONNECTS__ = [];
  window.__DBKIT_RD_DISCONNECTS__ = [];
  window.__DBKIT_RD_WRITES__ = [];
  window.__DBKIT_RD_INPUTS__ = [];
  window.__DBKIT_RD_ACKS__ = [];
  window.__DBKIT_RD_RESIZES__ = [];
  window.__DBKIT_RD_KEYS__ = [];
  // RustDesk「輸入作業系統密碼」：存的密碼（主機 id → 密碼）與打過去的紀錄（{ connId, password }；用存的時 password 是存的那組）。
  window.__DBKIT_RD_OS_PASSWORDS__ = {};
  window.__DBKIT_RD_OS_INPUTS__ = [];
  // RustDesk 檔案傳輸：rd_files_connect / rd_files_disconnect 的紀錄（{ op, connId, via }）。之後的檔案操作走 ssh_sftp_*（同一套假檔案）。
  window.__DBKIT_RD_FILES__ = [];
  // 檔案傳輸的本機窗格（local_list_dir）：路徑 → 項目；情境可換。
  window.__DBKIT_LOCAL_FS__ = {
    "C:\\Users\\me": [
      { name: "Documents", is_dir: true, size: 0, mtime: 1790000000 },
      { name: "report.pdf", is_dir: false, size: 245760, mtime: 1790000100 },
      { name: "notes.txt", is_dir: false, size: 512, mtime: 1790000200 },
    ],
    "C:\\Users\\me\\Documents": [{ name: "plan.docx", is_dir: false, size: 40960, mtime: 1790000300 }],
  };
  window.__DBKIT_RD_FULLSCREEN__ = [];
  window.__DBKIT_RD_ANSWERS__ = [];
  window.__DBKIT_UPDATE_INSTALLS__ = [];
  window.__DBKIT_EXTERNAL_OPENS__ = [];
  window.__DBKIT_RD_CLIPBOARD__ = [];
  window.__DBKIT_RD_GRAB__ = [];
  window.__DBKIT_RD_CLIP_WRITES__ = [];
  window.__DBKIT_KEY_IMPORTS__ = [];
  const one = (columns, cells) => ({ columns, rows: [cells], rows_affected: 0 });

  const queryFor = (sql) => {
    const s = String(sql || "").toLowerCase();
    if (s.includes("version()")) return [one(["VERSION()", "@@character_set_server", "@@collation_server"], ["8.0.36", "utf8mb4", "utf8mb4_0900_ai_ci"])];
    if (s.includes("default_character_set_name")) return [one(["cs", "coll"], ["utf8mb4", "utf8mb4_0900_ai_ci"])];
    if (s.includes("data_length + index_length")) return [one(["mb"], ["54.13"])];
    if (s.includes("explain")) return [fx.EXPLAIN_RESULT];
    if (s.includes("group by status")) return [fx.MULTI_RESULTS[0]];
    if (s.includes("order_items")) return [fx.MULTI_RESULTS[1]];
    // 儲存格檢視器情境：一格 JSON、一格 base64 PNG（1×1）。
    if (s.includes("cell_views")) return [{ columns: ["payload", "avatar"], rows: [['{"order":{"items":[{"sku":"A-1","qty":2}]},"paid":true}', "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="]], rows_affected: 0 }];
    // 大結果集（列虛擬化情境）：2 萬列。
    if (s.includes("big_rows")) return [{ columns: ["id", "name", "amount"], rows: Array.from({ length: 20_000 }, (_, i) => [String(i + 1), `row-${i + 1}`, (i * 1.5).toFixed(2)]), rows_affected: 0 }];
    if (s.startsWith("use ")) return [];
    return [one(["result"], ["ok"])];
  };

  // ── 比對的假本機檔案系統與資料夾比對結果 ──
  window.__DBKIT_CMP_WRITES__ = [];
  window.__DBKIT_CMP_SESSION_SAVES__ = [];
  window.__DBKIT_FCMP_SCANS__ = [];
  window.__DBKIT_FCMP_SYNCS__ = [];
  const enc = (s) => new TextEncoder().encode(s ?? "");
  const CMP_MTIME = 1_790_000_000;
  const cmpFiles = () => {
    if (!(window.__DBKIT_CMP_FILES__ instanceof Map)) {
      window.__DBKIT_CMP_FILES__ = new Map(Object.entries({
        "C:\\work\\old\\app.conf": "host = db.internal\nport = 5432\npool = 10\ntimeout = 30\nlog = info\n",
        "C:\\work\\new\\app.conf": "host = db.internal\nport = 6432\npool = 10\ntimeout = 30\nlog = debug\nretry = 3\n",
        ...(window.__DBKIT_CMP_FILES__ ?? {}),
      }));
    }
    return window.__DBKIT_CMP_FILES__;
  };
  const cm = (rel, is_dir, size, mtime) => ({ rel, name: rel.split("/").pop(), is_dir, size, mtime });
  const CMP_FOLDER_DIFF = {
    rows: [
      { key: "conf", left: cm("conf", true, 0, CMP_MTIME), right: cm("conf", true, 0, CMP_MTIME), status: "same", newer: null },
      { key: "conf/app.conf", left: cm("conf/app.conf", false, 120, CMP_MTIME + 60), right: cm("conf/app.conf", false, 98, CMP_MTIME), status: "diff", newer: "left" },
      { key: "conf/db.conf", left: cm("conf/db.conf", false, 40, CMP_MTIME), right: cm("conf/db.conf", false, 40, CMP_MTIME), status: "same", newer: null },
      { key: "README.md", left: cm("README.md", false, 900, CMP_MTIME), right: cm("README.md", false, 900, CMP_MTIME), status: "same", newer: null },
      { key: "new.txt", left: cm("new.txt", false, 12, CMP_MTIME), right: null, status: "left_only", newer: null },
      { key: "old.log", left: null, right: cm("old.log", false, 3000, CMP_MTIME), status: "right_only", newer: null },
    ],
    left_count: 5, right_count: 5, skipped: 0, errors: [],
  };
  const isMysql = ({ id }) => id === "c-mysql";
  const cachedAt = () => Date.now() - fx.SCHEMA_CACHE_AGE_MS;
  const handlers = {
    has_startup_password: () => false,
    // 假資料的連線不帶明文密碼；回 true＝keychain 裡有，連線前的「缺帳密」防呆才不會擋住
    has_stored_password: () => true,
    // 進階匯出：留下對話框送出的範圍給情境斷言，回報的筆數照範圍算。
    export_connections_encrypted: ({ path, scope }) => {
      window.__DBKIT_CONN_EXPORT__ = { path, scope };
      return { count: scope?.ids?.length ?? 0, redacted: 0, groups: 0, ssh: scope?.ssh_ids?.length ?? 0, rd: scope?.rd_ids?.length ?? 0 };
    },
    list_saved_connections: () => fx.CONNECTIONS,
    // 側欄分組（v0.20 起）。預設無群組＝扁平清單，與截圖情境一致；情境可用 fx 覆寫。
    list_connection_groups: () => fx.CONN_GROUPS ?? [],
    // 側欄排版（群組 + 連線順序 / 歸屬）：寫回記憶體裡的假資料，並留一份最後的呼叫給情境斷言。
    save_connection_layout: ({ groups, order }) => {
      window.__DBKIT_CONN_LAYOUT__ = { groups, order };
      fx.CONN_GROUPS = groups ?? [];
      const pos = new Map((order ?? []).map((o, i) => [o.id, [i, o.group_id]]));
      fx.CONNECTIONS = fx.CONNECTIONS
        .map((c) => (pos.has(c.id) ? { ...c, group_id: pos.get(c.id)[1] } : c))
        .sort((x, y) => (pos.get(x.id)?.[0] ?? 1e9) - (pos.get(y.id)?.[0] ?? 1e9));
      return null;
    },
    set_query_guard: () => null,
    connect: () => null,
    disconnect: () => null,
    test_connection: () => null,
    clear_cache: () => null,
    save_connection: ({ config }) => { (window.__DBKIT_CONN_SAVES__ ||= []).push(config); return null; },
    open_external: ({ url }) => { window.__DBKIT_EXTERNAL_OPENS__.push(url); return null; },
    // 自動更新：情境用 window.__DBKIT_UPDATE_SUPPORT__ 指定安裝方式（預設 null = 不支援自動安裝）；
    // 安裝時照真後端送兩則下載進度，再回成功（真後端此時已啟動安裝程式、準備關閉 App）。
    update_support: () => window.__DBKIT_UPDATE_SUPPORT__ ?? null,
    update_install: ({ version, onProgress }) => {
      window.__DBKIT_UPDATE_INSTALLS__.push(version);
      if (window.__DBKIT_UPDATE_FAIL__) return Promise.reject({ kind: "update", code: "ERR_UPDATE", message: window.__DBKIT_UPDATE_FAIL__ });
      const cb = callbacks.get(onProgress?.id);
      const total = 37 * 1024 * 1024;
      cb?.({ message: { downloaded: 0, total }, index: 0 });
      cb?.({ message: { downloaded: total / 2, total }, index: 1 });
      return new Promise((resolve) => setTimeout(() => { cb?.({ message: { downloaded: total, total }, index: 2 }); resolve(null); }, 300));
    },
    claude_detect: () => ({ installed: true, version: "2.1.0", logged_in: true, path: "/usr/local/bin/claude" }),
    pool_status: () => ({ size: 3, idle: 2, in_use: 1 }),
    ping_connection: () => 12,
    list_databases: ({ id }) => fx.DATABASES[id] ?? [],
    list_tables: ({ id, database }) => fx.TABLES[`${id}:${database}`] ?? [],
    list_routines: (a) => (isMysql(a) ? fx.ROUTINES : []),
    schema_columns: (a) => (isMysql(a) ? Object.entries(fx.SCHEMA_COLUMNS).map(([table, columns]) => ({ table, columns })) : []),
    // 結構快取。時間由「固定年齡」推出（cachedAt），不是寫死的絕對時刻——徽章顯示相對時間，
    // 而它算的是瀏覽器真正的 Date.now()，寫死絕對時刻的話畫面會隨日期漂掉（見 fixtures 的說明）。
    get_schema_cache: (a) =>
      isMysql(a)
        ? {
            database: a.database ?? "shop",
            updated_at_ms: cachedAt(),
            tables: Object.entries(fx.SCHEMA_COLUMNS).map(([table, columns]) => ({ table, columns })),
          }
        : null,
    refresh_schema_cache: (a) => ({
      database: a.database ?? "shop",
      updated_at_ms: cachedAt(),
      tables: isMysql(a) ? Object.entries(fx.SCHEMA_COLUMNS).map(([table, columns]) => ({ table, columns })) : [],
    }),
    clear_schema_cache: () => null,
    schema_cache_stats: () => ({
      dir: fx.SCHEMA_CACHE_STATS.dir,
      entries: fx.SCHEMA_CACHE_STATS.entries.map((e) => ({ ...e, updated_at_ms: cachedAt() })),
    }),
    // 停止查詢：v0.21 工作區加的按鈕會打這個，漏了它「停止」一按就是頁面錯誤。
    cancel_query: () => 1,
    // 結構類只對 MySQL 連線回 orders 的資料，Redis / 其他連線回空，右側「詳細資料」才不會串味
    table_columns: (a) => (isMysql(a) ? fx.ORDERS_COLUMNS : []),
    table_indexes: (a) => (isMysql(a) ? fx.ORDERS_INDEXES : []),
    list_foreign_keys: (a) => (isMysql(a) ? fx.ORDERS_FKS : []),
    table_info: (a) => (isMysql(a) ? fx.ORDERS_INFO : []),
    table_data: () => fx.ORDERS_PAGED,
    table_ddl: () => "CREATE TABLE `orders` (\n  `order_id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  ...\n) ENGINE=InnoDB",
    er_model: () => fx.ER_MODEL,
    search_objects: () => fx.SEARCH_HITS,
    routine_definition: () => "CREATE PROCEDURE sp_close_order(IN p_order_id BIGINT)\nBEGIN\n  UPDATE orders SET status = 'delivered' WHERE order_id = p_order_id;\nEND",
    explain_query: () => fx.EXPLAIN_RESULT,
    redis_keys: () => fx.REDIS_KEYS,
    redis_key_page: () => fx.REDIS_KEY_PAGE,
    kafka_topic_partitions: () => fx.KAFKA_PARTITIONS,
    kafka_consume: () => fx.KAFKA_CONSUME,
    kafka_tail_stop: () => null,
    // ---- 容器與映像（Docker / Registry / Harbor）：資料在 fixtures 的 DOCKER_* / REGISTRY_* / HARBOR_* ----
    docker_overview: () => ({
      endpoint: "npipe:////./pipe/docker_engine", server_version: "27.3.1", api_version: "1.47", os: "Docker Desktop", os_type: "linux",
      arch: "x86_64", kernel: "6.6.32-linuxkit", name: "docker-desktop", ncpu: 8, mem_total: 16 * 1024 ** 3, driver: "overlayfs",
      root_dir: "/var/lib/docker", containers: 4, running: 2, paused: 1, stopped: 1, images: 4, warnings: [],
    }),
    docker_disk_usage: () => ({
      images_count: 4, images_size: 865000000, images_reclaimable: 98000000, containers_count: 4, containers_size: 12000000,
      volumes_count: 2, volumes_size: 310000000, volumes_reclaimable: 4000000, build_cache_count: 12, build_cache_size: 540000000,
    }),
    docker_prune: ({ target }) => { window.__DBKIT_DOCKER_ACTIONS__.push(`prune:${target}`); return { deleted: 1, space_reclaimed: 98000000 }; },
    docker_containers: () => fx.DOCKER_CONTAINERS ?? [],
    docker_container_inspect: ({ container }) => dockerDetail(container),
    docker_container_action: ({ container, action }) => { window.__DBKIT_DOCKER_ACTIONS__.push(`${action}:${container}`); return null; },
    docker_container_remove: ({ container }) => { window.__DBKIT_DOCKER_ACTIONS__.push(`remove:${container}`); return null; },
    docker_container_rename: () => null,
    docker_container_stats: () => ({
      cpu_percent: 3.2, online_cpus: 8, mem_usage: 96 * 1024 ** 2, mem_limit: 16 * 1024 ** 3, mem_percent: 0.6,
      net_rx: 1200000, net_tx: 800000, blk_read: 40000000, blk_write: 12000000, pids: 9,
    }),
    docker_container_top: () => ({ titles: ["PID", "USER", "CMD"], processes: [["1", "postgres", "postgres"], ["57", "postgres", "postgres: checkpointer"]] }),
    docker_logs_open: ({ onOutput }) => {
      const send = channelSender(onOutput);
      setTimeout(() => send(fx.DOCKER_LOG_TEXT ?? ""), 30);
      return `log-${++dockerSeq}`;
    },
    docker_exec_open: ({ container, onOutput }) => {
      const send = channelSender(onOutput);
      const id = `exec-${++dockerSeq}`;
      dockerExecs.set(id, { send, line: "", host: container });
      setTimeout(() => send("/ # "), 30);
      return id;
    },
    // 假 shell：回顯輸入；Enter 後 hostname 回容器名，其餘回 not found。
    docker_exec_write: ({ streamId, dataB64 }) => {
      const e = dockerExecs.get(streamId);
      if (!e) return null;
      for (const ch of atob(dataB64)) {
        if (ch === "\r") {
          const out = e.line === "hostname" ? e.host : e.line ? `sh: ${e.line}: not found` : "";
          e.send(`\r\n${out ? `${out}\r\n` : ""}/ # `);
          e.line = "";
        } else {
          e.line += ch;
          e.send(ch);
        }
      }
      return null;
    },
    docker_exec_resize: () => null,
    docker_stream_close: ({ streamId }) => { dockerExecs.delete(streamId); return null; },
    // ── Kubernetes ──
    k8s_kubeconfig_contexts: () => fx.K8S_CONTEXTS ?? { files: [], current_context: "", contexts: [] },
    k8s_default_kubeconfig: () => ["C:/Users/dev/.kube/config"],
    k8s_overview: () => ({
      label: "dev", server: "https://127.0.0.1:6443", version: "v1.33.4+k3s1", platform: "linux/amd64", namespaces: 3, pods: 2,
      pod_phases: { Running: 2 }, metrics_available: true, errors: [],
      nodes: [{ name: "node-1", state: "ready", roles: ["control-plane"], version: "v1.33.4+k3s1", os_image: "K3s", arch: "amd64", internal_ip: "172.18.0.2",
        cpu_capacity_milli: 8000, memory_capacity_bytes: 17179869184, cpu_usage_milli: 412, memory_usage_bytes: 1610612736, pods: 2, created: "2026-09-20T08:00:00Z" }],
      warnings: [{ namespace: "demo", kind: "Warning", reason: "BackOff", message: "Back-off restarting failed container", count: 3, first: "2026-09-29T08:00:00Z", last: "2026-09-29T08:05:00Z", object_kind: "Pod", object_name: "redis-7c9d8-abcde", source: "kubelet" }],
    }),
    k8s_namespaces: () => (fx.K8S_NAMESPACES ?? []).filter((n) => n !== "(cluster)"),
    k8s_discovery: () => [
      { group: "", version: "v1", plural: "pods", kind: "Pod", namespaced: true, verbs: ["get", "list", "delete"], short_names: ["po"] },
      { group: "apps", version: "v1", plural: "deployments", kind: "Deployment", namespaced: true, verbs: ["get", "list"], short_names: ["deploy"] },
      { group: "", version: "v1", plural: "nodes", kind: "Node", namespaced: false, verbs: ["get", "list"], short_names: ["no"] },
    ],
    k8s_events: () => [{ namespace: "demo", kind: "Normal", reason: "Pulled", message: "Container image already present on machine", count: 1, first: "2026-09-29T08:00:00Z", last: "2026-09-29T08:00:30Z", object_kind: "Pod", object_name: "pg-0", source: "kubelet" }],
    k8s_pod_metrics: ({ name }) => [{ namespace: "demo", name: name ?? "pg-0", cpu_milli: 3.2, memory_bytes: 41943040, containers: [{ name: "pg", cpu_milli: 3.2, memory_bytes: 41943040 }] }],
    k8s_node_metrics: () => [{ name: "node-1", cpu_milli: 412, memory_bytes: 1610612736 }],
    k8s_table: ({ res }) => ({
      columns: [{ name: "Name", kind: "string", priority: 0, description: "" }, { name: "Status", kind: "string", priority: 0, description: "" }, { name: "Age", kind: "string", priority: 0, description: "" }],
      rows: Object.entries(fx.K8S_OBJECTS ?? {}).filter(([k]) => k.startsWith(res.plural + "/")).map(([, o]) => ({ name: o.metadata.name, namespace: o.metadata.namespace ?? "", cells: [o.metadata.name, o.status?.phase ?? "", "1d"] })),
    }),
    k8s_list: ({ res, labelSelector }) => Object.entries(fx.K8S_OBJECTS ?? {})
      .filter(([k, o]) => k.startsWith(res.plural + "/") && (!labelSelector || labelSelector.split(",").every((kv) => { const [a, b] = kv.split("="); return o.metadata.labels?.[a] === b; })))
      .map(([, o]) => o),
    k8s_get: ({ res, name }) => fx.K8S_OBJECTS?.[`${res.plural}/${name}`] ?? Promise.reject(new Error(`Kubernetes 404：${res.plural} "${name}" not found`)),
    k8s_get_yaml: ({ res, name }) => {
      const o = fx.K8S_OBJECTS?.[`${res.plural}/${name}`];
      if (!o) return Promise.reject(new Error("Kubernetes 404"));
      return `apiVersion: ${o.apiVersion}
kind: ${o.kind}
metadata:
  name: ${o.metadata.name}
  namespace: ${o.metadata.namespace ?? ""}
`;
    },
    k8s_replace_yaml: ({ res, name, dryRun }) => { window.__DBKIT_K8S_ACTIONS__.push(`${dryRun ? "dry-replace" : "replace"}:${res.plural}/${name}`); return fx.K8S_OBJECTS?.[`${res.plural}/${name}`] ?? {}; },
    k8s_apply_yaml: ({ yaml, dryRun }) => { window.__DBKIT_K8S_ACTIONS__.push(`${dryRun ? "dry-apply" : "apply"}`); return [{ kind: "ConfigMap", name: (/name:s*(S+)/.exec(yaml) ?? [])[1] ?? "x", namespace: "demo", action: "created", error: null }]; },
    k8s_delete: ({ res, name }) => { window.__DBKIT_K8S_ACTIONS__.push(`delete:${res.plural}/${name}`); return null; },
    k8s_scale: ({ name, replicas }) => { window.__DBKIT_K8S_ACTIONS__.push(`scale:${name}:${replicas}`); return null; },
    k8s_restart: ({ name }) => { window.__DBKIT_K8S_ACTIONS__.push(`restart:${name}`); return null; },
    k8s_cronjob_suspend: ({ name, suspend }) => { window.__DBKIT_K8S_ACTIONS__.push(`suspend:${name}:${suspend}`); return null; },
    k8s_cronjob_trigger: ({ name }) => { window.__DBKIT_K8S_ACTIONS__.push(`trigger:${name}`); return `${name}-manual-abcde`; },
    k8s_node_cordon: ({ name, cordon }) => { window.__DBKIT_K8S_ACTIONS__.push(`cordon:${name}:${cordon}`); return null; },
    k8s_secret_data: () => ({ DB_PASSWORD: "secret", API_KEY: "abc123" }),
    k8s_pod_env: ({ pod }) => (pod === "pg-0"
      ? [{ container: "pg", name: "POSTGRES_USER", value: "app", secret: false }, { container: "pg", name: "POSTGRES_DB", value: "appdb", secret: false }, { container: "pg", name: "POSTGRES_PASSWORD", value: "secret", secret: true }]
      : []),
    k8s_resolve_target: ({ target, port }) => [target.includes("pg") ? "pg-0" : "redis-7c9d8-abcde", target.startsWith("svc/") ? 5432 : port],
    k8s_logs_open: ({ onOutput }) => {
      const send = channelSender(onOutput);
      setTimeout(() => send(fx.K8S_LOG_TEXT ?? ""), 30);
      return `k8s-log-${++dockerSeq}`;
    },
    k8s_exec_open: ({ pod, onOutput }) => {
      const send = channelSender(onOutput);
      const id = `k8s-exec-${++dockerSeq}`;
      dockerExecs.set(id, { send, line: "", host: pod });
      setTimeout(() => send("/ # "), 30);
      return id;
    },
    k8s_exec_write: (a) => handlers.docker_exec_write(a),
    k8s_exec_resize: () => null,
    k8s_stream_close: ({ streamId }) => { dockerExecs.delete(streamId); return null; },
    k8s_forward_open: ({ id, ns, target, remotePort, localPort }) => {
      const f = { id: `fwd-${++dockerSeq}`, conn_id: id, namespace: ns, target, pod: "pg-0", remote_port: remotePort, local_port: localPort || 54321, active: 0, started: new Date().toISOString(), last_error: null };
      window.__DBKIT_K8S_FORWARDS__.push(f);
      return f;
    },
    k8s_forward_list: () => window.__DBKIT_K8S_FORWARDS__,
    k8s_forward_close: ({ forwardId }) => { window.__DBKIT_K8S_FORWARDS__ = window.__DBKIT_K8S_FORWARDS__.filter((f) => f.id !== forwardId); return null; },
    docker_images: () => fx.DOCKER_IMAGES ?? [],
    docker_image_inspect: ({ image }) => {
      const i = (fx.DOCKER_IMAGES ?? []).find((x) => x.reference === image);
      if (!i) return Promise.reject(new Error(`Docker 404：No such image: ${image}`));
      return {
        id: i.id, repo_tags: i.repo_tags, repo_digests: i.repo_digests, created: "2026-06-30T10:00:00Z", arch: "amd64", os: "linux",
        size: i.size, author: "", entrypoint: ["docker-entrypoint.sh"], cmd: ["postgres"], env: ["PATH=/usr/local/bin:/usr/bin"],
        exposed_ports: ["5432/tcp"], working_dir: "", user: "", labels: {}, layers: 12,
        history: [{ created: 1782000000, created_by: "/bin/sh -c #(nop)  CMD [\"postgres\"]", size: 0, comment: "" }], raw: "{}",
      };
    },
    docker_image_remove: ({ image }) => { window.__DBKIT_DOCKER_ACTIONS__.push(`rmi:${image}`); return []; },
    docker_image_tag: () => null,
    docker_image_pull: ({ id, image, credConn }) => { window.__DBKIT_DOCKER_PULLS__.push({ id, image, credConn }); return null; },
    docker_volumes: () => fx.DOCKER_VOLUMES ?? [],
    docker_volume_remove: () => null,
    docker_networks: () => fx.DOCKER_NETWORKS ?? [],
    docker_network_inspect: ({ network }) =>
      (fx.DOCKER_NETWORKS ?? []).find((n) => n.name === network) ?? Promise.reject(new Error(`Docker 404：network ${network} not found`)),
    docker_network_remove: () => null,
    registry_info: () => ({ base_url: "https://registry.example.test:443", api_version: "registry/2.0", auth: "bearer", catalog: true }),
    registry_manifest: ({ repo, reference }) => ({ ...fx.REGISTRY_MANIFEST, repository: repo, reference }),
    registry_delete: ({ repo, reference }) => { window.__DBKIT_DOCKER_ACTIONS__.push(`registry-delete:${repo}:${reference}`); return null; },
    harbor_overview: () => ({
      base_url: "https://harbor.example.test:443", harbor_version: "v2.11.1", auth_mode: "db_auth", registry_url: "harbor.example.test",
      health: "healthy", components: [{ name: "core", status: "healthy", error: "" }, { name: "trivy", status: "healthy", error: "" }],
      private_projects: 1, public_projects: 1, private_repos: 2, public_repos: 1, storage_used: -1, user: "robot$ci", is_admin: false,
    }),
    harbor_project: ({ project }) => ({
      name: project, project_id: 2, public: project === "library", repo_count: (fx.HARBOR_REPOS?.[project] ?? []).length, owner: "admin",
      creation_time: "2026-01-01T00:00:00Z", auto_scan: true, prevent_vul: false, severity: "", quota_hard: 10 * 1024 ** 3, quota_used: 2 * 1024 ** 3, registry_name: "",
    }),
    harbor_repositories: ({ project }) => fx.HARBOR_REPOS?.[project] ?? [],
    harbor_artifacts: () => ({ items: fx.HARBOR_ARTIFACTS ?? [], total: (fx.HARBOR_ARTIFACTS ?? []).length }),
    harbor_scan: ({ digest }) => { window.__DBKIT_DOCKER_ACTIONS__.push(`harbor-scan:${digest}`); return null; },
    harbor_vulnerabilities: () => fx.HARBOR_VULNS,
    harbor_delete_artifact: () => null,
    harbor_delete_tag: () => null,
    harbor_delete_repository: () => null,
    server_info: () => fx.REDIS_INFO,
    redis_slowlog: () => [],
    redis_clients: () => [],
    list_schedules: () => [],
    list_backup_history: () => [],
    run_query: ({ sql }) => queryFor(sql)[0] ?? { columns: [], rows: [], rows_affected: 0 },
    run_query_multi: ({ sql }) => queryFor(sql),
    // DDL 執行（結構比對「直接執行」會打；早於 v0.30 就缺這個 handler）。
    exec_ddl: () => null,
    // 寫檔類：對話框 handler 會回假路徑，所以這些後續步驟也要有回應，否則匯出一按就是紅字。
    save_text_file: ({ path, content }) => { window.__DBKIT_SAVED_FILES__.push({ path, content }); return null; },
    save_base64_file: ({ path, data }) => { window.__DBKIT_SAVED_FILES__.push({ path, base64: data }); return null; },
    export_rows: ({ outPath }) => ({ path: outPath, rows: 3, bytes: 256 }),
    export_rows_multi: ({ outPath }) => ({ path: outPath, rows: 3, bytes: 256 }),
    export_query: ({ outPath }) => ({ path: outPath, rows: 3, bytes: 256 }),
    export_table: ({ outPath }) => ({ path: outPath, rows: 3, bytes: 256 }),
    // ---- 結構 / 資料比對（v0.30）：回固定形狀的假結果，讓兩個對話框能開、能點、能匯出 ----
    capture_schema: ({ id, database }) => ({
      kind: id === "c-pg" ? "postgres" : "mysql",
      database: database ?? "shop",
      captured_at_ms: fx.now,
      label: `${id} / ${database}`,
      tables: (fx.TABLES[`${id}:${database}`] ?? []).filter((x) => x.kind === "table").map((x) => ({
        name: x.name, kind: "table",
        columns: x.name === "orders" ? fx.ORDERS_COLUMNS : (fx.SCHEMA_COLUMNS[x.name] ?? ["id"]).map((c) => ({ name: c, data_type: "int", nullable: false, key: c === "id" ? "PRI" : "", default: null, extra: "", comment: "" })),
        indexes: x.name === "orders" ? fx.ORDERS_INDEXES : [],
        foreign_keys: x.name === "orders" ? fx.ORDERS_FKS : [],
        ddl: `CREATE TABLE \`${x.name}\` (\n  \`id\` int NOT NULL\n) ENGINE=InnoDB`,
        ddl_synthesized: false, warnings: [],
      })),
      views: (fx.TABLES[`${id}:${database}`] ?? []).filter((x) => x.kind === "view").map((x) => ({ name: x.name, kind: "view", columns: [], indexes: [], foreign_keys: [], ddl: `CREATE VIEW \`${x.name}\` AS SELECT 1`, ddl_synthesized: false, warnings: [] })),
      routines: [], warnings: [],
    }),
    diff_schema: ({ src }) => {
      const names = src.tables.map((x) => x.name);
      const changed = names.includes("orders") ? [{
        name: "orders",
        columns_added: [{ name: "coupon_code", data_type: "varchar(32)", nullable: true, key: "", default: null, extra: "", comment: "折價券代碼" }],
        columns_removed: [], columns_changed: [{ name: "total_amount", src: fx.ORDERS_COLUMNS[3], dst: { ...fx.ORDERS_COLUMNS[3], data_type: "decimal(10,2)" }, attrs: ["data_type"] }],
        indexes_added: [fx.ORDERS_INDEXES[2]], indexes_removed: [], indexes_changed: [], fks_added: [], fks_removed: [], fks_changed: [], ddl_differs: false,
      }] : [];
      const identical = names.filter((n) => n !== "orders" && n !== "payments");
      return {
        src_kind: src.kind, dst_kind: src.kind, src_db: src.database, dst_db: src.database, cross_engine: false,
        tables_added: names.includes("payments") ? ["payments"] : [], tables_removed: ["legacy_log"], tables_changed: changed, tables_identical: identical,
        views_added: [], views_removed: [], views_changed: [], routines_added: [], routines_removed: [], routines_changed: [],
        summary: { tables_added: 1, tables_removed: 1, tables_changed: changed.length, views_added: 0, views_removed: 0, views_changed: 0, routines_added: 0, routines_removed: 0, routines_changed: 0, total: 2 + changed.length },
      };
    },
    // 語句一律限定到「目標」資料庫（真的引擎就是這樣產的；寫死來源庫名會讓截圖看起來像 bug）。
    generate_schema_sync: ({ dst }) => {
      const q = `\`${dst.database}\``;
      return {
        target_kind: dst.kind, target_db: dst.database, destructive_count: 2,
        statements: [
          { sql: `ALTER TABLE ${q}.\`orders\` ADD COLUMN \`coupon_code\` varchar(32) NULL COMMENT '折價券代碼'`, kind: "add_column", object: "orders.coupon_code", destructive: false, note: null },
          { sql: `ALTER TABLE ${q}.\`orders\` MODIFY COLUMN \`total_amount\` decimal(12,2) NOT NULL DEFAULT '0.00'`, kind: "alter_column", object: "orders.total_amount", destructive: true, note: null },
          { sql: `CREATE INDEX \`idx_orders_status_placed\` ON ${q}.\`orders\` (\`status\`, \`placed_at\`)`, kind: "create_index", object: "orders.idx_orders_status_placed", destructive: false, note: null },
          { sql: `DROP TABLE ${q}.\`legacy_log\``, kind: "drop_table", object: "legacy_log", destructive: true, note: null },
        ],
        skipped: [],
      };
    },
    save_schema_snapshot: ({ path }) => ({ path, bytes: 48_213, tables: 5, views: 2, routines: 0, captured_at_ms: fx.now }),
    // 快照載入：回一份「上個月的 shop」——沿用 capture_schema 的形狀，這樣以快照為目標比對時
    // 走的是跟即時連線完全相同的路徑，選擇器上的「12 表」也才不是 0。
    load_schema_snapshot: () => ({
      ...handlers.capture_schema({ id: "c-mysql", database: "shop" }),
      captured_at_ms: fx.now - 31 * 86_400_000,
      label: "snapshot",
    }),
    compare_data_table: ({ src, dst, options }) => ({
      src: `${src.database}.${src.table}`, dst: `${dst.database}.${dst.table}`, pk: ["order_id"], columns: ["order_id", "status", "total_amount"],
      skipped_src_columns: [], skipped_dst_columns: ["legacy_flag"],
      summary: { inserts: 3, updates: 2, deletes: 1, compared_rows: 128_728, src_rows: 128_733, dst_rows: 128_731, strategy_used: "merge_join", truncated_reason: null, deletes_suppressed: false, cancelled: false, elapsed_ms: 1840, warnings: [] },
      samples: {
        inserts: [["128735", "pending", "1200.00"], ["128736", "paid", "88.50"], ["128737", "paid", "3400.00"]],
        updates: [{ src: ["1001", "shipped", "560.00"], dst: ["1001", "paid", "560.00"], changed: ["status"] }, { src: ["1002", "paid", "99.00"], dst: ["1002", "paid", "90.00"], changed: ["total_amount"] }],
        deletes: [["999", "refunded", "0.00"]],
      },
      sql: options?.mode === "report" ? null : "UPDATE `shop`.`orders` SET `status` = 'shipped' WHERE `order_id` = '1001';\nINSERT INTO `shop`.`orders` (`order_id`, `status`, `total_amount`) VALUES ('128735', 'pending', '1200.00');\n",
      apply: options?.mode === "apply" ? { applied: 5, failed: 0, batches: 1, transactional: true, errors: [] } : null,
    }),
    compare_data_database: ({ src, dst, options }) => {
      const one = handlers.compare_data_table({ src: { ...src, table: "orders" }, dst: { ...dst, table: "orders" }, options });
      return {
        tables: [
          { table: "orders", status: "compared", reason: null, precheck: null, report: one },
          { table: "customers", status: "skipped", reason: "預檢相同（筆數 / 主鍵範圍一致）", precheck: { src_count: 4210, dst_count: 4210, src_min: "1", src_max: "4210", dst_min: "1", dst_max: "4210", likely_identical: true }, report: null },
          { table: "order_items", status: "skipped", reason: "無主鍵", precheck: null, report: null },
        ],
        totals: { ...one.summary, compared_rows: 128_728 }, only_in_src: ["payments"], only_in_dst: ["legacy_log"], cancelled: false,
      };
    },
    compare_data_cancel: () => null,

    // ── 審查並執行 ───────────────────────────────────────────────────────
    review_run_prepare: () => fx.REVIEW_PREPARED,
    run_sql_file: ({ path, options }) => ({
      total: 12, executed: options?.continue_on_error ? 11 : 6, failed: 1, skipped_meta: 0, cancelled: false,
      stopped_on_error: !options?.continue_on_error, elapsed_ms: 840, errors_omitted: 0,
      errors: [{ index: 6, line: 18, sql: "INSERT INTO missing_table VALUES (1)", message: `Table 'shop.missing_table' doesn't exist (${String(path).split(/[\\/]/).pop()})` }],
    }),
    run_sql_file_cancel: () => null,
    import_preview: ({ path }) => (/\.(json|jsonl|ndjson)$/i.test(String(path))
      ? { columns: ["order_id", "status", "total_amount"], rows: [["9001", "paid", "12.50"], ["9002", "NULL", "8.00"], ["9003", "pending", "NULL"]], total_rows: 3 }
      : { columns: ["order_id", "status"], rows: [["9001", "paid"]], total_rows: 1 }),
    import_csv: ({ path }) => ({ imported: /\.json/i.test(String(path)) ? 3 : 1, failed: 0, errors: [] }),
    preview_dml: ({ script }) => ({
      database: "shop",
      blockers: [],
      statements: [
        { index: 0, sql: String(script).split(";")[0], op: "update", write: true, targets: ["shop.orders"], estimated_rows: 2, estimate_exact: true, method: "predicate",
          table: "orders", columns: ["order_id", "status", "total_amount"], rows: [["1001", "paid", "560.00"], ["1002", null, "99.00"]], truncated: false, detail: null, notes: [] },
        { index: 1, sql: "SELECT 1", op: "read", write: false, targets: [], estimated_rows: null, estimate_exact: true, method: "none",
          table: null, columns: [], rows: [], truncated: false, detail: null, notes: [] },
      ],
    }),
    review_run_start: ({ runId, mode }) => {
      // 先打幾個進度事件，再回結果：對話框的進度列與結果分頁兩條路徑都跑得到。
      const outcome = mode === "execute" && fx.REVIEW_OUTCOME_EXECUTED ? fx.REVIEW_OUTCOME_EXECUTED : fx.REVIEW_OUTCOME;
      const total = outcome.manifest.statements.length;
      for (let i = 0; i < total; i++) {
        emit("review-run-progress", { run_id: runId, phase: "capture_before", index: i, total, detail: "" });
      }
      return new Promise((res) => setTimeout(() => {
        emit("review-run-progress", { run_id: runId, phase: "done", index: total, total, detail: "" });
        res(outcome);
      }, 250));
    },
    review_run_cancel: () => null,
    review_run_reveal: () => null,
    // 預存程序整合測試
    // 存檔記在 window 上，下一次 load_dir 會列出來（「新檔」→ 重新載入 → 選到新檔 的流程才走得通）。
    sp_test_load_dir: () => {
      const saved = window.__DBKIT_SPTEST_SAVED__ ?? {};
      const base = fx.SP_TEST_FILES.filter((f) => !(f.path in saved));
      const extra = Object.entries(saved).map(([path, text]) => ({ name: path.split(/[\\/]/).pop(), path, text, errors: [] }));
      return [...base, ...extra].sort((a, b) => a.name.localeCompare(b.name));
    },
    sp_test_save_file: ({ path, text }) => {
      window.__DBKIT_SPTEST_SAVED__ = { ...(window.__DBKIT_SPTEST_SAVED__ ?? {}), [path]: text };
      return [];
    },
    sp_test_validate: () => [],
    sp_test_inspect: () => fx.SP_TEST_INSPECT,
    sp_test_testgen_prompt: () => "generate scenarios",
    sp_test_scaffold: () => fx.SP_TEST_SCAFFOLD,
    sp_test_run: ({ runId, only }) => {
      window.__DBKIT_SPTEST_RUNS__ = [...(window.__DBKIT_SPTEST_RUNS__ ?? []), { only: only ?? null }];
      emit("sp-test-progress", { run_id: runId, file: "usp_place_order.json", scenario: "place_then_cancel", phase: "done", verdict: "pass", index: 0, total: 2 });
      // 只重跑某些情境（only）：回那幾列且改成通過——模擬「改好程序後再跑一次就綠了」。
      const out = only && only.length
        ? fx.SP_TEST_REPORTS.map((r) => ({
          ...r,
          scenarios: r.scenarios
            .filter((s) => only.includes(s.case ? `${s.id}/${s.case}` : s.id) || only.includes(s.id))
            .map((s) => ({ ...s, verdict: "pass", steps: s.steps.map((st) => ({ ...st, differences: [] })) })),
        }))
        : fx.SP_TEST_REPORTS;
      return new Promise((res) => setTimeout(() => res(out), 30));
    },
    sp_test_cancel: () => null,
    sp_test_export: () => ["C:/sptests/reports/run.junit.xml", "C:/sptests/reports/run.md"],

    // ── 壓力測試 ─────────────────────────────────────────────────────────
    // 先打一筆進度事件再回整份報表（fx.STRESS_REPORT），報表區、折線圖、錯誤分組都畫得出來。
    stress_run: ({ runId }) => {
      const r = fx.STRESS_REPORT;
      if (!r) return Promise.reject(new Error("screenshot shim: 沒有壓測假資料"));
      emit("stress-progress", { run_id: runId, elapsed_ms: r.elapsed_ms, completed: r.completed, errors: r.errors, rps: r.rps, avg_ms: r.avg_ms, p95_ms: r.p95_ms, in_flight: 0 });
      return new Promise((res) => setTimeout(() => res(r), 200));
    },
    stress_cancel: () => null,

    // ── AI 資源庫 ────────────────────────────────────────────────────────
    // 讀取刻意失敗：前端會退回打包進 bundle 的內建資源庫（與後端讀不到設定目錄時同一條路徑）。
    ai_library_load: () => Promise.reject(new Error("screenshot shim: 資源庫用內建 fallback")),
    // 不真的寫設定（快照仍用內建 fallback），但記下送出的內容給 verify-ui 檢查。
    ai_library_settings_set: ({ settingsValue }) => { window.__DBKIT_AI_SETTINGS_SET__.push(settingsValue); return Promise.reject(new Error("screenshot shim: 不寫設定")); },
    ai_library_reveal: () => null,
    ai_library_sync_plan: () => ({
      items: [
        { target: "Claude Code", path: "C:\\Users\\demo\\.claude\\agents\\dba-senior.md", action: "create", source: "agent:dba-senior" },
        { target: "Codex", path: "C:\\Users\\demo\\.codex\\agents\\dba-senior.toml", action: "conflict", source: "agent:dba-senior" },
      ],
      mcp_hint: "claude mcp add dbkit -- dbk --conn <連線名稱> mcp",
    }),
    ai_library_sync_apply: () => ({ written: 1, deleted: 0, skipped: 1, errors: [] }),

    // ── AI 助手 ──────────────────────────────────────────────────────────
    app_lock_status: () => ({ locked: false, has_password: false, idle_minutes: 0 }),
    // 設定對話框的 App 鎖定小節會問；瀏覽器裡沒有 Windows Hello / Touch ID（與前端讀不到時的退路相同）。
    biometric_status: () => ({ available: false, kind: "none", reason: "unsupported_platform" }),
    agent_detect: () => ({ available: true, provider: "claude", version: "2.0.0", path: "claude", models: [], note: null }),
    agent_cancel: () => { aiCancelled = true; return null; },
    // 串流回覆：一小段一小段 emit，讓截圖 / 冒煙檢查看到的是真的串流渲染路徑。
    agent_send: ({ reqId, mode, prompt }) => {
      aiCancelled = false;
      let i = 0;
      // 審查並執行的審查（mode = review）回一份帶 VERDICT 的審查；SSH 終端機情境（prompt 帶終端機上下文）
      // 回 bash 建議——提到「刪除」就回危險版（rm -rf，驗確認框）；其餘沿用比對報告的總結。
      const p = String(prompt ?? "");
      const reviewing = mode === "review" || mode === "dba";
      const chunks = reviewing && fx.AI_REVIEW_CHUNKS ? fx.AI_REVIEW_CHUNKS
        : /SSH 終端機/.test(p) && /刪除/.test(p) && fx.AI_SHELL_DANGER_CHUNKS ? fx.AI_SHELL_DANGER_CHUNKS
        : /SSH 終端機/.test(p) && fx.AI_SHELL_CHUNKS ? fx.AI_SHELL_CHUNKS
        : fx.AI_SUMMARY_CHUNKS;
      // DBA agent 模式：先「查一次資料庫」（工具呼叫稽核清單要看得到），再開始回覆。
      if (mode === "dba") {
        setTimeout(() => emit("agent-stream", { req_id: reqId, kind: "tool", tool: "mcp__dbkit__explain_query", tool_id: "t1", tool_input: '{"query":"EXPLAIN UPDATE orders SET status = \'cancelled\' WHERE status = \'pending\'"}' }), 20);
        setTimeout(() => emit("agent-stream", { req_id: reqId, kind: "tool_result", tool: "mcp__dbkit__explain_query", tool_id: "t1", tool_output_preview: "type=ALL rows≈120000", tool_rows: 1, tool_ms: 12 }), 40);
      }
      const tick = () => {
        if (aiCancelled || i >= chunks.length) {
          emit("agent-stream", { req_id: reqId, kind: "done", text: null });
          return;
        }
        emit("agent-stream", { req_id: reqId, kind: "text", text: chunks[i++] });
        setTimeout(tick, 60);
      };
      setTimeout(tick, 80);
      return null;
    },

    // ── 遠端桌面（RDP / VNC）─────────────────────────────────────────────
    // 主機清單有狀態（同 SSH）。連線：RDP 送一張合成畫面（rdFrames 的 record），VNC 起一台假 RFB 伺服器（見 rdVncServer），
    // 讓真的 noVNC 走完握手、畫出像素。高頻命令（rd_write / rd_input）是 raw body + x-rd-conn header。
    rd_sessions_list: () => JSON.parse(JSON.stringify(rdSessionsState)),
    rd_session_save: ({ session, password }) => {
      window.__DBKIT_RD_SESSION_SAVES__.push({ session, password });
      const i = rdSessionsState.sessions.findIndex((x) => x.id === session.id);
      if (i >= 0) rdSessionsState.sessions[i] = session;
      else rdSessionsState.sessions.push(session);
      return null;
    },
    rd_session_remove: ({ id }) => { rdSessionsState.sessions = rdSessionsState.sessions.filter((x) => x.id !== id); return null; },
    rd_sessions_layout_save: ({ folders, order }) => {
      rdSessionsState.folders = folders;
      const pos = new Map(order.map((p, i) => [p.id, [i, p.folder_id]]));
      rdSessionsState.sessions = rdSessionsState.sessions
        .map((s) => (pos.has(s.id) ? { ...s, folder_id: pos.get(s.id)[1] } : s))
        .sort((a, b) => (pos.get(a.id)?.[0] ?? 1e9) - (pos.get(b.id)?.[0] ?? 1e9));
      return null;
    },
    rd_has_stored_password: () => false,
    // 傳檔連線：情境可設 window.__DBKIT_RD_FILES_FAIL__（錯誤訊息）讓它連不上。家目錄同假 SFTP。
    rd_files_connect: ({ connId, via }) => {
      window.__DBKIT_RD_FILES__.push({ op: "connect", connId, via });
      if (window.__DBKIT_RD_FILES_FAIL__) return Promise.reject({ kind: "rd", code: "ERR_RD", message: window.__DBKIT_RD_FILES_FAIL__ });
      return "/home/deploy";
    },
    rd_files_disconnect: ({ connId }) => { window.__DBKIT_RD_FILES__.push({ op: "disconnect", connId }); return null; },
    local_list_dir: ({ path }) => {
      const p = path ?? "C:\\Users\\me";
      const items = window.__DBKIT_LOCAL_FS__[p];
      if (!items) return Promise.reject({ kind: "rd", code: "ERR_RD", message: `無法讀取資料夾 ${p}` });
      const i = p.lastIndexOf("\\");
      return {
        path: p,
        parent: i > 2 ? p.slice(0, i) : "",
        entries: items.map((e) => ({ ...e, path: `${p}\\${e.name}` })),
      };
    },
    rd_has_os_password: ({ id }) => !!window.__DBKIT_RD_OS_PASSWORDS__[id],
    rd_os_password_set: ({ id, password }) => {
      if (password) window.__DBKIT_RD_OS_PASSWORDS__[id] = password;
      else delete window.__DBKIT_RD_OS_PASSWORDS__[id];
      return null;
    },
    rd_input_os_password: ({ connId, password }) => {
      const conn = window.__DBKIT_RD_CONNECTS__.find((c) => c.connId === connId);
      const saved = conn?.target?.kind === "session" ? window.__DBKIT_RD_OS_PASSWORDS__[conn.target.id] : undefined;
      const p = password || saved;
      if (!p) return Promise.reject({ kind: "rd", code: "ERR_RD", message: "這台主機沒有存作業系統密碼" });
      window.__DBKIT_RD_OS_INPUTS__.push({ connId, password: p });
      return null;
    },
    rd_read_rdp_file: () => fx.RDP_FILE_BYTES ?? [],
    rd_connect: ({ connId, target, onOutput }) => {
      const sessions = rdSessionsState.sessions;
      const s = target?.kind === "session" ? sessions.find((x) => x.id === target.id) : target?.session;
      const protocol = s?.protocol ?? "rdp";
      window.__DBKIT_RD_LAST_CONN__ = connId;
      window.__DBKIT_RD_CONNECTS__.push({ connId, target });
      const send = channelBytes(onOutput);
      const finish = () => {
        if (protocol === "vnc") {
          rdVnc.set(connId, rdVncServer(send));
          // 情境可改後端報的安全層（window.__DBKIT_RD_VNC_SEC__ = { security, encrypted }，例如 VeNCrypt 匿名 TLS）。
          const sec = window.__DBKIT_RD_VNC_SEC__ ?? { security: "vnc-auth", encrypted: false };
          return { conn_id: connId, protocol, width: 0, height: 0, ...sec };
        }
        if (protocol === "rustdesk") {
          // 輔助程式的「登入成功」事件（[型別 1][JSON]）；影像是 VP9 位元流，假後端做不出來，不送。
          // 情境可給對方好幾個螢幕（window.__DBKIT_RD_DISPLAYS__）、改對方資訊（window.__DBKIT_RD_PEER__，例如 platform）。
          const displays = window.__DBKIT_RD_DISPLAYS__ ?? [{ x: 0, y: 0, width: 1280, height: 720, name: "" }];
          const hello = new TextEncoder().encode(JSON.stringify({
            type: "connected",
            peer: { hostname: "office-pc", version: "1.4.9", displays, current_display: 0, ...(window.__DBKIT_RD_PEER__ ?? {}) },
          }));
          setTimeout(() => send(new Uint8Array([1, ...hello])), 20);
          // 真的 RustDesk 錄下來的 VP9 關鍵畫面（見 screenshot-fixtures.mjs）：前端要用 WebCodecs 解出 1024×768。
          // 情境可再塞事件 / 畫面：__DBKIT_RD_PUSH__(bytes)；__DBKIT_RD_KEYFRAME__(display) = 那個螢幕的關鍵畫面。
          window.__DBKIT_RD_PUSH__ = (bytes) => send(new Uint8Array(bytes));
          if (fx.RUSTDESK_VP9_KEYFRAME_B64) {
            const bin = atob(fx.RUSTDESK_VP9_KEYFRAME_B64);
            const frame = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) frame[i] = bin.charCodeAt(i);
            window.__DBKIT_RD_KEYFRAME__ = (display) => { const f = frame.slice(); f[3] = display; send(f); };
            setTimeout(() => send(frame), 60);
          }
          return { conn_id: connId, protocol, width: 1280, height: 720, security: "rustdesk-direct", encrypted: false };
        }
        const fw = fx.RDP_DEMO_FRAME?.width ?? 320, fh = fx.RDP_DEMO_FRAME?.height ?? 200;
        setTimeout(() => send(rdpDemoFrame(fw, fh, 1)), 30);
        window.__DBKIT_RD_PUSH__ = (bytes) => send(new Uint8Array(bytes)); // 情境直接塞後端訊息（例如遠端剪貼簿）
        return { conn_id: connId, protocol, width: fw, height: fh, security: "nla", encrypted: true };
      };
      // 情境可要求先問憑證（window.__DBKIT_RD_PROMPT__ = "cert"）：等使用者回答才回來，拒絕 = 取消。
      if (window.__DBKIT_RD_PROMPT__ === "cert") {
        return new Promise((resolve, reject) => {
          const promptId = `rdp-${++sshSeq}`;
          rdPrompts.set(promptId, (d) => (d === "reject" ? reject({ kind: "rd_cancelled", code: "ERR_RD_CANCELLED", message: "cancelled" }) : resolve(finish())));
          setTimeout(() => emit("rd-cert-prompt", {
            prompt_id: promptId, conn_id: connId, host_id: `${s?.host ?? "host"}:3389`,
            fingerprint: "SHA256:0Rd3mOCertFpXq1zW9vB7nK5jH3gF1dS8aP6oI4uY2t", subject: "CN=WIN-SRV01", status: "new", old_fingerprint: null,
          }), 20);
        });
      }
      // 情境可要求「只能等 RustDesk 對方按接受」（window.__DBKIT_RD_PROMPT__ = "wait"）：只能取消；
      // 情境呼叫 window.__DBKIT_RD_ACCEPT__() = 對方按了接受（連上）。
      if (window.__DBKIT_RD_PROMPT__ === "wait") {
        return new Promise((resolve, reject) => {
          const promptId = `rd-wait-${++sshSeq}`;
          rdPrompts.set(promptId, (a) => { if (!a) reject({ kind: "rd_cancelled", code: "ERR_RD_CANCELLED", message: "cancelled" }); });
          window.__DBKIT_RD_ACCEPT__ = () => { rdPrompts.delete(promptId); resolve(finish()); };
          setTimeout(() => emit("rd-auth-prompt", {
            prompt_id: promptId, conn_id: connId, need_username: false, username: "", error: null, otp: false, can_trust: false, wait: true,
            notice: "對方的 RustDesk 設定為只能在畫面上按「接受」，不能用密碼登入：已請對方按接受，按了就會連上。",
          }), 20);
        });
      }
      // 情境可要求 RustDesk 對方的雙重驗證碼（window.__DBKIT_RD_PROMPT__ = "otp"）：123456 才對，錯了帶錯誤再問。
      // window.__DBKIT_RD_TRUST__ = true → 對方允許「信任這台裝置」。
      if (window.__DBKIT_RD_PROMPT__ === "otp") {
        return new Promise((resolve, reject) => {
          const ask = (error) => {
            const promptId = `rd-otp-${++sshSeq}`;
            rdPrompts.set(promptId, (a) => {
              if (!a) reject({ kind: "rd_cancelled", code: "ERR_RD_CANCELLED", message: "cancelled" });
              else if (a.password.replace(/\s/g, "") === "123456") resolve(finish());
              else ask("驗證碼錯誤：請輸入驗證器 App 上目前顯示的那組（每 30 秒會換一組）");
            });
            setTimeout(() => emit("rd-auth-prompt", {
              prompt_id: promptId, conn_id: connId, need_username: false, username: "", error, otp: true,
              can_trust: !!window.__DBKIT_RD_TRUST__, wait: false,
              notice: "對方的 RustDesk 開啟了雙重驗證（2FA）：請輸入對方綁定的驗證器 App（如 Google Authenticator）上顯示的 6 位數驗證碼。",
            }), 20);
          };
          ask(null);
        });
      }
      if (window.__DBKIT_RD_FAIL__) return Promise.reject({ kind: "rd", code: "ERR_RD", message: window.__DBKIT_RD_FAIL__ });
      return finish();
    },
    rd_disconnect: ({ connId }) => { window.__DBKIT_RD_DISCONNECTS__.push(connId); rdVnc.delete(connId); return null; },
    rd_cert_answer: ({ promptId, decision }) => { window.__DBKIT_RD_ANSWERS__.push(decision); rdPrompts.get(promptId)?.(decision); rdPrompts.delete(promptId); return null; },
    rd_auth_answer: ({ promptId, answer }) => { window.__DBKIT_RD_ANSWERS__.push(answer); rdPrompts.get(promptId)?.(answer); rdPrompts.delete(promptId); return null; },
    rd_write: (bytes, opts) => {
      const id = opts?.headers?.["x-rd-conn"];
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      window.__DBKIT_RD_WRITES__.push(Array.from(u8));
      rdVnc.get(id)?.(u8);
      return null;
    },
    rd_input: (bytes) => { window.__DBKIT_RD_INPUTS__.push(Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []))); return null; },
    rd_frame_ack: ({ seq }) => { window.__DBKIT_RD_ACKS__.push(seq); return null; },
    rd_resize: ({ width, height }) => { window.__DBKIT_RD_RESIZES__.push([width, height]); return null; },
    rd_refresh: () => null,
    rd_send_keys: ({ combo }) => { window.__DBKIT_RD_KEYS__.push(combo); return null; },
    rd_clipboard_set: ({ text }) => { window.__DBKIT_RD_CLIPBOARD__.push(text); return null; },
    rd_keyboard_grab: ({ connId }) => { window.__DBKIT_RD_GRAB__.push(connId); return null; },
    // 本機系統剪貼簿：情境可設 window.__DBKIT_RD_LOCAL_CLIP__ 模擬「本機剛複製了文字」。
    rd_clipboard_read: () => window.__DBKIT_RD_LOCAL_CLIP__ ?? null,
    rd_clipboard_write: ({ text }) => { window.__DBKIT_RD_CLIP_WRITES__.push(text); return null; },
    // 錄影：記下開了哪些檔、每段多大；結束回傳路徑（一段都沒寫 → null，跟後端一樣）。
    rd_record_start: ({ name }) => {
      const id = `rec-${++sshSeq}`;
      const path = `C:\\Users\\demo\\Videos\\db-kit\\${name}_20261002-120000.webm`;
      (window.__DBKIT_RD_RECORDINGS__ ??= {})[id] = { name, path, bytes: 0, chunks: 0, stopped: false };
      return { id, path };
    },
    rd_record_write: (bytes, opts) => {
      const r = window.__DBKIT_RD_RECORDINGS__?.[opts?.headers?.["x-rec-id"]];
      if (!r || r.stopped) return Promise.reject({ kind: "rd", code: "ERR_RD", message: "錄影已經結束" });
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      // 檔頭前 4 bytes（WebM 的 EBML 開頭 1A 45 DF A3；MediaRecorder 的第一段可能只有 1 byte，跨段接起來）
      r.head = [...(r.head ?? []), ...Array.from(u8.slice(0, Math.max(0, 4 - (r.head?.length ?? 0))))];
      r.bytes += u8.length;
      r.chunks++;
      // 情境要驗「錄出來的檔播得動」時（window.__DBKIT_RD_KEEP_REC__）把每段留下來
      if (window.__DBKIT_RD_KEEP_REC__) (r.data ??= []).push(u8.slice());
      return null;
    },
    rd_record_stop: ({ id }) => {
      const r = window.__DBKIT_RD_RECORDINGS__?.[id];
      if (!r) return null;
      r.stopped = true;
      return r.bytes ? r.path : null;
    },
    rd_record_reveal: ({ path }) => { (window.__DBKIT_RD_REVEALS__ ??= []).push(path); return null; },
    // 截圖：記下主機名稱（header 是 encodeURIComponent 過的）與 PNG 檔頭，回傳路徑。
    rd_screenshot_save: (bytes, opts) => {
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      const name = decodeURIComponent(opts?.headers?.["x-shot-name"] ?? "");
      const path = `C:\\Users\\demo\\Pictures\\db-kit\\${name}_20261002-120000.png`;
      (window.__DBKIT_RD_SHOTS__ ??= []).push({ name, path, bytes: u8.length, head: Array.from(u8.slice(0, 8)) });
      return path;
    },
    rd_set_fullscreen: ({ on }) => { window.__DBKIT_RD_FULLSCREEN__.push(on); return null; },

    // ── SSH 終端機 / SFTP ──────────────────────────────────────────────
    // 假 shell：逐字回聲、Enter 跑幾個固定指令（ls / pwd / echo / systemctl status nginx），其餘回 command not found。
    // 輸出走 Channel（見 channelSender），與真後端一樣是 raw bytes → ArrayBuffer。
    // 主機清單有狀態：存了再讀要讀得到（App 存檔後會重新載入清單，靜態 fixture 會把剛存的蓋回去）。
    ssh_sessions_list: () => JSON.parse(JSON.stringify(sshSessionsState)),
    ssh_session_save: ({ session }) => {
      window.__DBKIT_SSH_SESSION_SAVES__.push(session);
      const i = sshSessionsState.sessions.findIndex((x) => x.id === session.id);
      if (i >= 0) sshSessionsState.sessions[i] = session;
      else sshSessionsState.sessions.push(session);
      return null;
    },
    // ── SSH 金鑰庫（假的：內容看起來像加密的就要密語，密語 "wrong" 算錯；以 ssh- 開頭的是公鑰）──
    ssh_keys_list: () => sshKeys.map((k) => ({ ...k })),
    ssh_session_log_write: ({ path, text, truncate }) => { window.__DBKIT_SSH_LOG__.push({ path, text, truncate }); return null; },
    ssh_oplog_command: ({ entry }) => {
      if (!entry?.detail?.trim()) return null;
      sshOplogPush(entry.conn_id, "command", { detail: entry.detail, ts: entry.ts ?? Date.now(), cwd: entry.cwd ?? null, source: entry.source ?? null });
      return null;
    },
    ssh_oplog_query: ({ query }) => {
      const q = query ?? {};
      const host = (q.host ?? "").trim().toLowerCase();
      const text = (q.text ?? "").trim().toLowerCase();
      const hits = sshOplog.filter((e) => (q.from == null || e.ts >= q.from) && (q.to == null || e.ts < q.to)
        && (!q.kinds?.length || q.kinds.includes(e.kind)) && (!q.session_id || e.session_id === q.session_id)
        && (!host || `${e.user}@${e.host}:${e.port}`.toLowerCase().includes(host))
        && (!text || [e.detail, e.target, e.cwd, e.message].some((s) => s && s.toLowerCase().includes(text))))
        .sort((a, b) => b.ts - a.ts);
      const limit = q.limit || 1000;
      return { entries: hits.slice(0, limit).map((e) => ({ ...e })), more: hits.length > limit };
    },
    ssh_oplog_config: () => ({ config: { ...sshOplogConfig }, dir: SSH_OPLOG_DIR }),
    ssh_oplog_config_set: ({ config }) => {
      sshOplogConfig = { enabled: !!config.enabled, retention_days: Math.min(3650, config.retention_days ?? 90) };
      return { config: { ...sshOplogConfig }, dir: SSH_OPLOG_DIR };
    },
    ssh_oplog_clear: () => { sshOplog.length = 0; return null; },
    ssh_oplog_reveal: () => null,
    ssh_import_default_path: ({ kind }) => (kind === "xsh" ? fx.SSH_IMPORT_XSH?.path : fx.SSH_IMPORT_CONFIG?.path) ?? null,
    ssh_import_scan: ({ kind }) => (kind === "xsh" ? fx.SSH_IMPORT_XSH : fx.SSH_IMPORT_CONFIG) ?? { path: "", hosts: [], skipped: 0 },
    ssh_key_inspect: ({ source, passphrase }) => sshInspect(source, passphrase),
    ssh_key_import: ({ source, passphrase, newPassphrase, name }) => {
      const r = sshInspect(source, passphrase);
      if (r.status !== "ok") return Promise.reject(new Error(r.message ?? "cannot import"));
      window.__DBKIT_KEY_IMPORTS__.push({ source, passphrase, newPassphrase, name });
      const existing = sshKeys.find((k) => k.fingerprint === r.info.fingerprint);
      if (existing) return { key: existing, existed: true };
      const key = {
        id: `key-${++sshSeq}`, name: name || r.info.comment || "imported", algorithm: r.info.algorithm, bits: r.info.bits,
        fingerprint: r.info.fingerprint, comment: r.info.comment, encrypted: r.info.encrypted || !!newPassphrase,
        source_format: r.info.format, created_at: Math.floor(Date.now() / 1000), has_cert: false,
      };
      sshKeys.push(key);
      return { key, existed: false };
    },
    ssh_key_generate: ({ algorithm, comment, passphrase, name }) => {
      const n = ++sshSeq;
      const key = {
        id: `key-${n}`, name: name || comment || `${algorithm} ${n}`, algorithm: algorithm.startsWith("rsa") ? "ssh-rsa" : algorithm === "ed25519" ? "ssh-ed25519" : "ecdsa-sha2-nistp256",
        bits: algorithm === "rsa-4096" ? 4096 : algorithm === "rsa-3072" ? 3072 : 256, fingerprint: `SHA256:generated${n}Xq9vT2pLmNc8RfYw`,
        comment: comment || "", encrypted: !!passphrase, source_format: "", created_at: Math.floor(Date.now() / 1000), has_cert: false,
      };
      sshKeys.push(key);
      return key;
    },
    ssh_key_public: ({ id }) => {
      const k = sshKeys.find((x) => x.id === id);
      return k ? `${k.algorithm} AAAAC3NzaC1lZDI1NTE5AAAAIDbkitFakePublicKeyForScreenshotsOnly ${k.comment}`.trim() : Promise.reject(new Error("not found"));
    },
    ssh_key_rename: ({ id, name }) => { const k = sshKeys.find((x) => x.id === id); if (k) k.name = name; return null; },
    ssh_key_remove: ({ id }) => { const i = sshKeys.findIndex((x) => x.id === id); if (i >= 0) sshKeys.splice(i, 1); return null; },
    ssh_key_export: () => null,
    ssh_key_attach_cert: ({ id }) => {
      const k = sshKeys.find((x) => x.id === id);
      if (k) k.has_cert = true;
      return { path: "", key_id: "demo", principals: ["deploy"], valid_after: 0, valid_before: 4102444800, cert_type: "user", ca_fingerprint: "SHA256:ca", matches_key: true, validity: "valid" };
    },
    ssh_session_remove: ({ id }) => { sshSessionsState.sessions = sshSessionsState.sessions.filter((x) => x.id !== id); return null; },
    ssh_sessions_layout_save: ({ folders, order }) => {
      sshSessionsState.folders = folders ?? sshSessionsState.folders;
      const pos = new Map((order ?? []).map((o, i) => [o.id, [i, o.folder_id]]));
      sshSessionsState.sessions = sshSessionsState.sessions
        .map((x) => (pos.has(x.id) ? { ...x, folder_id: pos.get(x.id)[1] } : x))
        .sort((a, b) => (pos.get(a.id)?.[0] ?? 1e9) - (pos.get(b.id)?.[0] ?? 1e9));
      return null;
    },
    ssh_has_stored_password: () => true,
    ssh_connect: ({ connId, target }) => {
      const sessions = fx.SSH_SESSIONS?.sessions ?? [];
      const s = target?.kind === "session" ? sessions.find((x) => x.id === target.id)
        : target?.kind === "ad_hoc" ? target.session
        : { host: "db-bastion.internal", port: 22, username: "tunnel" };
      const info = { conn_id: connId, host: s?.host ?? "web-01", port: s?.port ?? 22, username: s?.username ?? "deploy" };
      sshConns.set(connId, info);
      sshOplogWho.set(connId, {
        proto: s?.protocol === "ftp" ? "ftp" : "ssh", host: info.host, port: info.port, user: info.username,
        session_id: target?.kind === "session" ? target.id : undefined,
      });
      sshOplogPush(connId, "connect");
      window.__DBKIT_SSH_LAST_CONN__ = connId; // 測試用：模擬斷線要知道是哪條
      return info;
    },
    ssh_test: () => new Promise((r) => setTimeout(() => r(null), 200)),
    ssh_disconnect: ({ connId }) => { if (sshConns.delete(connId)) sshOplogPush(connId, "disconnect"); return null; },
    ssh_term_open: ({ connId, onOutput }) => {
      const send = channelSender(onOutput);
      const info = sshConns.get(connId);
      const user = info?.username ?? "deploy";
      const named = (fx.SSH_SESSIONS?.sessions ?? []).find((x) => x.host === info?.host);
      const hostShort = named?.name || String(info?.host ?? "web-01").split(".")[0];
      const termId = `term-${++sshSeq}`;
      const term = { send, user, host: hostShort, home: `/home/${user}`, cwd: "", prompt: "", line: "" };
      sshSetCwd(term, term.home);
      sshTerms.set(termId, term);
      setTimeout(() => send(`Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-107-generic x86_64)\r\n\r\nLast login: Tue Sep 23 09:12:44 2026 from 10.0.0.8\r\n${sshTitle(term)}${term.prompt}`), 40);
      return termId;
    },
    ssh_term_write: ({ termId, dataB64 }) => { const t = sshTerms.get(termId); if (t) for (const ch of atob(dataB64)) sshFeed(t, ch); return null; },
    ssh_term_send_line: ({ termId, line }) => {
      const t = sshTerms.get(termId);
      if (!t) return null;
      window.__DBKIT_SSH_WRITES__.push(line);
      for (const ch of `${line}\r`) sshFeed(t, ch);
      return null;
    },
    ssh_term_resize: () => null,
    ssh_term_close: ({ termId }) => { sshTerms.delete(termId); return null; },
    ssh_hostkey_answer: () => null,
    ssh_auth_answer: () => null,
    ssh_sftp_open: ({ connId }) => {
      window.__DBKIT_SFTP_OPENS__.push(connId);
      const sftpId = `sftp-${++sshSeq}`;
      sftpConnOf.set(sftpId, connId);
      return { sftp_id: sftpId, home: "/home/deploy" };
    },
    ssh_sftp_close: () => null,
    ssh_sftp_list: ({ path }) => (fx.SFTP_LISTING?.[path] ?? []).map(sftpWithMeta),
    ssh_sftp_stat: ({ path }) => sftpFind(path) ?? Promise.reject(new Error("找不到檔案或目錄")),
    ssh_sftp_mkdir: ({ sftpId, path }) => { sftpOp(sftpId, "mkdir", { detail: path }); return null; },
    ssh_sftp_rename: ({ sftpId, from, to }) => { window.__DBKIT_SFTP_RENAMES__.push({ from, to }); sftpOp(sftpId, "rename", { detail: from, target: to }); return null; },
    ssh_sftp_remove: ({ sftpId, path, recursive }) => { window.__DBKIT_SFTP_REMOVES__.push({ path, recursive }); sftpOp(sftpId, "delete", { detail: path }); return null; },
    ssh_sftp_read_text: ({ path }) => { const text = sftpFiles.get(path) ?? ""; return { text, truncated: false, size: new TextEncoder().encode(text).length, lossy: false, binary: false }; },
    ssh_sftp_write_text: ({ sftpId, path, content, createNew }) => {
      window.__DBKIT_SFTP_WRITES__.push({ path, content, createNew });
      sftpOp(sftpId, createNew ? "create" : "save", { detail: path });
      sftpFiles.set(path, content);
      sftpMeta.set(path, { ...(sftpMeta.get(path) ?? {}), size: new TextEncoder().encode(content).length, mtime: Math.floor(Date.now() / 1000) });
      return sftpFind(path) ?? { name: path.split("/").pop(), path, is_dir: false, is_symlink: false, link_target_is_dir: null, size: content.length, mtime: Math.floor(Date.now() / 1000), permissions: 0o100644, mode: "-rw-r--r--", uid: 1000, gid: 1000, owner: "deploy", group: "deploy" };
    },
    ssh_sftp_chmod: ({ sftpId, path, mode }) => {
      window.__DBKIT_SFTP_CHMOD__.push({ path, mode });
      sftpOp(sftpId, "chmod", { detail: path, target: (mode & 0o7777).toString(8).padStart(4, "0") });
      const base = sftpFind(path);
      const type = base?.is_dir ? 0o40000 : 0o100000;
      sftpMeta.set(path, { ...(sftpMeta.get(path) ?? {}), permissions: type | mode });
      return sftpFind(path);
    },
    ssh_sftp_download: ({ sftpId, remote, local, resume }) => {
      window.__DBKIT_SFTP_TRANSFERS__.push({ kind: "download", remote, local, resume: !!resume });
      sftpOp(sftpId, "download", { detail: remote, target: local });
      return sshTransfer(remote);
    },
    ssh_sftp_upload: ({ sftpId, local, remote, resume }) => {
      window.__DBKIT_SFTP_TRANSFERS__.push({ kind: "upload", local, remote, resume: !!resume });
      sftpOp(sftpId, "upload", { detail: local, target: remote });
      return sshTransfer(local);
    },
    ssh_sftp_download_many: ({ sftpId, remotes, localDir, onConflict }) => {
      window.__DBKIT_SFTP_BATCH__.push({ kind: "download", remotes, localDir, onConflict });
      sftpOp(sftpId, "download", { detail: remotes.join("\n"), target: localDir });
      return sshTransfer(remotes[0]);
    },
    ssh_sftp_upload_many: ({ sftpId, locals, remoteDir, onConflict }) => {
      window.__DBKIT_SFTP_BATCH__.push({ kind: "upload", locals, remoteDir, onConflict });
      sftpOp(sftpId, "upload", { detail: locals.join("\n"), target: remoteDir });
      return sshTransfer(locals[0]);
    },
    // 本機「已經有」哪些名稱由情境自己設（window.__DBKIT_LOCAL_EXISTING__），預設都沒有。
    ssh_sftp_local_conflicts: ({ names }) => names.filter((n) => (window.__DBKIT_LOCAL_EXISTING__ ?? []).includes(n)),
    ssh_sftp_cancel: () => null,
    // SFTP 獨立視窗：瀏覽器裡開不了第二個視窗，只記下呼叫（回 true = 新開的）。視窗那一側由情境直接開 sftp.html 驗。
    ssh_sftp_window_open: ({ tabKey, title }) => { window.__DBKIT_SFTP_WINDOWS__.push({ op: "open", tabKey, title }); return true; },
    ssh_sftp_window_close: ({ tabKey }) => { window.__DBKIT_SFTP_WINDOWS__.push({ op: "close", tabKey }); return null; },
    // ── 檔案 / 資料夾 / 二進位比對（commands/filecmp.rs）──
    // 本機檔案系統是 cmpFiles（路徑 → 文字）；情境可先改 window.__DBKIT_CMP_FILES__ 再開比對。
    cmp_local_stat: ({ path }) => { const s = cmpFiles().get(path); return s == null ? { exists: false, is_dir: false, size: 0, mtime: null } : { exists: true, is_dir: false, size: enc(s).length, mtime: CMP_MTIME }; },
    cmp_local_read_text: ({ path }) => {
      const text = cmpFiles().get(path);
      if (text == null) return Promise.reject({ kind: "compare", code: "ERR_COMPARE", message: `找不到檔案：${path}` });
      return { text, truncated: false, size: enc(text).length, mtime: CMP_MTIME, lossy: false, binary: text.includes("\u0000") };
    },
    cmp_local_write_text: ({ path, content, expectedMtime }) => {
      window.__DBKIT_CMP_WRITES__.push({ path, content, expectedMtime });
      cmpFiles().set(path, content);
      return { exists: true, is_dir: false, size: enc(content).length, mtime: CMP_MTIME };
    },
    cmp_fetch: ({ remote }) => {
      const local = `tmp:${remote}`;
      cmpFiles().set(local, sftpFiles.get(remote) ?? cmpFiles().get(remote) ?? "");
      return { local, size: enc(cmpFiles().get(local)).length, mtime: CMP_MTIME };
    },
    cmp_put: ({ local, remote }) => {
      const content = cmpFiles().get(local) ?? "";
      window.__DBKIT_CMP_WRITES__.push({ path: remote, content, remote: true });
      sftpFiles.set(remote, content);
      return { exists: true, is_dir: false, size: enc(content).length, mtime: CMP_MTIME };
    },
    cmp_release: () => null,
    cmp_sessions_load: () => ({ version: 1, sessions: window.__DBKIT_CMP_SESSIONS__ ?? [] }),
    cmp_sessions_save: ({ file }) => { window.__DBKIT_CMP_SESSIONS__ = file.sessions; window.__DBKIT_CMP_SESSION_SAVES__.push(file); return null; },
    fcmp_scan: ({ left, right, opts }) => { window.__DBKIT_FCMP_SCANS__.push({ left, right, opts }); return window.__DBKIT_FCMP_DIFF__ ?? CMP_FOLDER_DIFF; },
    fcmp_content_check: ({ pairs }) => pairs.map((p) => ({ key: p.key, equal: !(window.__DBKIT_FCMP_CONTENT_DIFF__ ?? []).includes(p.key), error: null })),
    fcmp_sync: ({ ops }) => {
      window.__DBKIT_FCMP_SYNCS__.push(ops);
      const copied = ops.filter((o) => o.kind.startsWith("copy")).length;
      return { copied, deleted: ops.length - copied, failed: [], mtime_not_kept: 0 };
    },
    fcmp_cancel: () => null,
    fcmp_binary_diff: ({ a, b }) => {
      const x = enc(cmpFiles().get(a) ?? ""), y = enc(cmpFiles().get(b) ?? "");
      const ranges = [];
      let open = -1, diffBytes = 0;
      const n = Math.max(x.length, y.length);
      for (let i = 0; i <= n; i++) {
        const d = i < n && x[i] !== y[i];
        if (d) { diffBytes++; if (open < 0) open = i; } else if (open >= 0) { ranges.push([open, i - open]); open = -1; }
      }
      return { size_a: x.length, size_b: y.length, ranges, diff_bytes: diffBytes, truncated: false };
    },
    fcmp_read_bytes: ({ path, offset, len }) => enc(cmpFiles().get(path) ?? "").slice(offset, offset + len).buffer,
    show_main_window: () => null,
  };

  // ── Docker 假容器 / exec 的狀態 ──────────────────────────────────────────
  let dockerSeq = 0;
  const dockerExecs = new Map(); // streamId → { send, line, host }
  window.__DBKIT_DOCKER_ACTIONS__ = [];
  window.__DBKIT_K8S_ACTIONS__ = [];
  window.__DBKIT_K8S_FORWARDS__ = [];
  window.__DBKIT_DOCKER_PULLS__ = [];
  function dockerDetail(name) {
    const c = (fx.DOCKER_CONTAINERS ?? []).find((x) => x.name === name);
    if (!c) return Promise.reject(new Error(`Docker 404：No such container: ${name}`));
    const up = c.state === "running" || c.state === "paused";
    return {
      id: c.id, name: c.name, image: c.image, image_id: "sha256:1111aaaa2222bbbb", created: "2026-07-02T18:00:00Z", state: c.state,
      running: up, paused: c.state === "paused", restarting: false, oom_killed: false, pid: up ? 42 : 0, exit_code: c.state === "exited" ? 1 : 0,
      error: "", started_at: "2026-07-02T18:00:00Z", finished_at: "0001-01-01T00:00:00Z", restart_count: 0, restart_policy: "unless-stopped",
      health: c.status.includes("healthy") ? "healthy" : "", health_log: [], tty: false, hostname: c.id.slice(0, 12), user: "", working_dir: "",
      entrypoint: ["docker-entrypoint.sh"], cmd: c.command.split(" ").slice(1), env: fx.DOCKER_ENV?.[c.name] ?? [],
      labels: c.compose_project ? { "com.docker.compose.project": c.compose_project } : {}, ports: c.ports, mounts: [],
      networks: [{ name: "shop_default", ip: "172.20.0.2", gateway: "172.20.0.1", mac: "02:42:ac:14:00:02", aliases: [c.compose_service].filter(Boolean) }],
      network_mode: "shop_default", raw: JSON.stringify({ Id: c.id, Name: `/${c.name}` }, null, 2),
    };
  }

  // ── SSH 假 shell 的狀態與工具 ──────────────────────────────────────────
  let sshSeq = 0;
  const sshKeys = (fx.SSH_KEYS ?? []).map((k) => ({ ...k }));
  const sshSessionsState = JSON.parse(JSON.stringify(fx.SSH_SESSIONS ?? { version: 1, folders: [], sessions: [] }));
  function sshInspect(source, passphrase) {
    const text = source?.kind === "text" ? source.text : "";
    const path = source?.kind === "path" ? source.path : "";
    const stored = path.startsWith("keystore:") ? sshKeys.find((k) => `keystore:${k.id}` === path) : null;
    if (path.startsWith("keystore:") && !stored) {
      return { status: "invalid", format: null, info: null, message: "金鑰庫裡找不到這把金鑰（可能已刪除）", cert: null };
    }
    if (/^\s*(ssh-|ecdsa-)/.test(text)) {
      return { status: "unsupported", format: null, info: null, message: "這是公鑰，不是私鑰。請選對應的私鑰檔（通常是同名、沒有 .pub 的那個）。", cert: null };
    }
    const encrypted = stored ? stored.encrypted : /ENCRYPTED|aes256|_enc/i.test(text + path);
    const info = stored
      ? { format: "OpenSSH", algorithm: stored.algorithm, bits: stored.bits, fingerprint: stored.fingerprint, comment: stored.comment, encrypted, public_openssh: "" }
      : { format: text.includes("PuTTY") ? "PuTTY PPK v3" : "OpenSSH", algorithm: "ssh-ed25519", bits: 256, fingerprint: "SHA256:pasted0kLx3VbQ9nZr7TfYwHc2Jm5Ud8Ae1Gs4Ki6Po", comment: "pasted@demo", encrypted, public_openssh: "" };
    const cert = stored?.has_cert
      ? { path: "", key_id: "demo", principals: ["deploy"], valid_after: 0, valid_before: 4102444800, cert_type: "user", ca_fingerprint: "SHA256:ca", matches_key: true, validity: "valid" }
      : null;
    if (encrypted && !stored && !passphrase) return { status: "need_passphrase", format: info.format, info, message: "這把私鑰受密語保護，請輸入密語", cert };
    if (encrypted && !stored && passphrase === "wrong") return { status: "bad_passphrase", format: info.format, info, message: "密語不正確（或不支援這種加密方式）：decrypt", cert };
    return { status: "ok", format: info.format, info, message: null, cert };
  }
  const sshConns = new Map(); // connId → { host, port, username }
  const sshTerms = new Map(); // termId → { send, user, host, home, cwd, prompt, line }
  // SSH 操作紀錄（假後端）：連線 / 檔案動作在這裡自己記（同真的後端），指令由前端送來。
  const sshOplog = window.__DBKIT_SSH_OPLOG__;
  for (const e of fx.SSH_OPLOG ?? []) sshOplog.push({ ...e });
  const sshOplogWho = new Map(); // connId → { proto, host, port, user, session_id }
  const sftpConnOf = new Map(); // sftpId → connId
  let sshOplogConfig = { enabled: true, retention_days: 90 };
  const SSH_OPLOG_DIR = "C:\\Users\\demo\\AppData\\Roaming\\com.dbkit.app\\ssh-oplog";
  function sshOplogPush(connId, kind, fields = {}, fileOp = false) {
    const w = sshOplogWho.get(connId);
    if (!w || !sshOplogConfig.enabled) return;
    sshOplog.push({
      ts: Date.now(), kind, proto: fileOp && w.proto === "ssh" ? "sftp" : w.proto, conn_id: connId, host: w.host, port: w.port,
      user: w.user, session_id: w.session_id, detail: "", result: "ok", ...fields,
    });
  }
  const sftpOp = (sftpId, kind, fields) => sshOplogPush(sftpConnOf.get(sftpId), kind, fields, true);
  // SFTP 假檔案：內容（read_text / write_text）與被改過的屬性（大小 / 時間 / 權限）疊在 fixtures 上。
  const sftpFiles = new Map(Object.entries(fx.SFTP_FILES ?? {}));
  const sftpMeta = new Map();
  const rwx = (m) => [6, 3, 0].map((sh) => ["r", "w", "x"].map((c, i) => ((m >> sh) & (4 >> i)) ? c : "-").join("")).join("");
  function sftpWithMeta(e) {
    const m = sftpMeta.get(e.path);
    if (!m) return e;
    const permissions = m.permissions ?? e.permissions;
    return { ...e, ...m, permissions, mode: (e.is_dir ? "d" : "-") + rwx(permissions) };
  }
  function sftpFind(path) {
    const e = Object.values(fx.SFTP_LISTING ?? {}).flat().find((x) => x.path === path);
    return e ? sftpWithMeta(e) : null;
  }
  // @tauri-apps/api 的 Channel 建構時已透過 transformCallback 把回呼登錄進 callbacks（id 在 ch.id）；
  // 真後端送 { message, index }，index 遞增讓 Channel 端保序，這裡照同一形狀餵。
  function channelSender(ch) {
    const cb = callbacks.get(ch?.id);
    let index = 0;
    return (text) => { if (cb) cb({ message: new TextEncoder().encode(text).buffer, index: index++ }); };
  }
  // Ubuntu 預設的 bash：提示符 `user@host:~/dir$ `，每個提示符前用 OSC 0 把視窗標題設成 `user@host: ~/dir`。
  function sshSetCwd(t, dir) {
    t.cwd = dir;
    const shown = dir === t.home ? "~" : dir.startsWith(`${t.home}/`) ? `~${dir.slice(t.home.length)}` : dir;
    t.shown = shown;
    t.prompt = `${t.user}@${t.host}:${shown}$ `;
  }
  function sshTitle(t) {
    return `\x1b]0;${t.user}@${t.host}: ${t.shown}\x07`;
  }
  // `cd` 只認得 fixtures 裡有的資料夾（SFTP_LISTING 的鍵，或列表裡的資料夾）。
  function sshCd(t, arg) {
    const a = arg.replace(/^'(.*)'$/s, "$1").replace(/'\\''/g, "'");
    let dir = !a || a === "~" ? t.home : a.startsWith("~/") ? `${t.home}${a.slice(1)}` : a.startsWith("/") ? a : `${t.cwd}/${a}`;
    const parts = [];
    for (const seg of dir.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop(); else parts.push(seg);
    }
    dir = `/${parts.join("/")}`;
    const listing = fx.SFTP_LISTING ?? {};
    const known = dir in listing || Object.values(listing).some((es) => es.some((e) => e.path === dir && e.is_dir));
    if (!known) return `bash: cd: ${a}: No such file or directory`;
    sshSetCwd(t, dir);
    return "";
  }
  function sshRun(t, cmd) {
    const c = cmd.trim();
    if (!c) return "";
    // 截圖用：長格式清單與幾個常見的唯讀指令，讓終端機畫面像一段真的工作階段。
    if (c === "ls -l" || c === "ls -la") {
      const dir = (n) => `\x1b[1;34m${n}\x1b[0m`;
      return [
        "total 47108",
        `drwxr-xr-x 4 deploy deploy     4096 Sep 22 08:00 ${dir("app")}`,
        "-rw-r--r-- 1 deploy deploy 48213120 Sep 21 23:10 \x1b[1;31mbackup.tar.gz\x1b[0m",
        `drwxr-xr-x 2 deploy deploy     4096 Sep 23 09:12 ${dir("logs")}`,
      ].join("\r\n");
    }
    if (c === "ls" || c.startsWith("ls ")) return "app  backup.tar.gz  logs";
    if (c === "uptime") return " 09:14:02 up 27 days,  3:41,  1 user,  load average: 0.21, 0.18, 0.12";
    if (c === "df -h /") return "Filesystem      Size  Used Avail Use% Mounted on\r\n/dev/sda1        80G   31G   46G  41% /";
    if (/^tail\b.*app\.log/.test(c)) {
      return [
        "2026-09-23 09:13:41 INFO  GET /api/orders?page=2 200 18ms",
        "2026-09-23 09:13:44 INFO  POST /api/cart 201 42ms",
        "\x1b[33m2026-09-23 09:13:52 WARN  slow query 812ms: SELECT * FROM orders WHERE note LIKE '%gift%'\x1b[0m",
        "2026-09-23 09:13:58 INFO  GET /healthz 200 1ms",
      ].join("\r\n");
    }
    if (c === "pwd") return t.cwd;
    if (c.startsWith("echo ")) return c.slice(5).replace(/^["']|["']$/g, "");
    if (/^systemctl status nginx/.test(c)) return "● nginx.service - A high performance web server\r\n     Active: active (running) since Mon 2026-09-22 08:00:11 UTC; 1 day 3h ago";
    if (/^cd\b/.test(c)) return sshCd(t, c.slice(2).trim());
    if (c === "clear") return "";
    return `bash: ${c.split(/\s+/)[0]}: command not found`;
  }
  function sshFeed(t, ch) {
    if (ch === "\r" || ch === "\n") {
      if (t.sudo) {
        // 回答 sudo 的密碼提示：跟真的一樣不回顯，Enter 之後才跑那條指令。
        window.__DBKIT_SSH_SECRETS__.push(t.line);
        const cmd = t.sudo;
        t.sudo = null;
        t.line = "";
        const out = sshRun(t, cmd);
        t.send(`\r\n${out ? `${out}\r\n` : ""}${sshTitle(t)}${t.prompt}`);
        return;
      }
      const sudo = /^sudo\s+(.+)$/.exec(t.line.trim());
      if (sudo) {
        t.sudo = sudo[1];
        t.line = "";
        t.send(`\r\n[sudo] password for ${t.user}: `);
        return;
      }
      const out = sshRun(t, t.line);
      t.line = "";
      t.send(`\r\n${out ? `${out}\r\n` : ""}${sshTitle(t)}${t.prompt}`);
    } else if (ch === "\x7f" || ch === "\b") {
      if (t.line) { t.line = t.line.slice(0, -1); if (!t.sudo) t.send("\b \b"); }
    } else if (ch === "\x03") {
      t.line = "";
      t.sudo = null;
      t.send(`^C\r\n${t.prompt}`);
    } else if (ch >= " ") {
      t.line += ch;
      if (!t.sudo) t.send(ch);
    }
  }
  function sshTransfer(name) {
    const id = `tr-${++sshSeq}`;
    const total = 4096;
    // 情境要求「下一個傳輸失敗」：傳到六成時斷線（真的後端會留著已傳的部分給續傳）。
    const fail = window.__DBKIT_SFTP_FAIL_NEXT__ > 0;
    if (fail) window.__DBKIT_SFTP_FAIL_NEXT__ -= 1;
    const steps = fail ? [0.25, 0.6] : [0.25, 0.6, 1];
    const slow = window.__DBKIT_SFTP_SLOW__ ? 100 : 1;
    steps.forEach((p, i) => setTimeout(() => emit("ssh-sftp-progress", {
      transfer_id: id, done: Math.round(total * p), total,
      state: fail && i === steps.length - 1 ? "error" : p === 1 ? "done" : "running",
      message: fail && i === steps.length - 1 ? "SFTP 連線已中斷" : null,
    }), (80 + i * 90) * slow));
    void name;
    return id;
  }

  // ── 遠端桌面的假後端 ───────────────────────────────────────────────────
  const rdSessionsState = JSON.parse(JSON.stringify(fx.RD_SESSIONS ?? { version: 1, folders: [], sessions: [] }));
  const rdVnc = new Map(); // connId → (clientBytes: Uint8Array) => void
  const rdPrompts = new Map(); // promptId → (answer) => void
  // 同 channelSender，但送原始位元組（RDP record / RFB）。
  function channelBytes(ch) {
    const cb = callbacks.get(ch?.id);
    let index = 0;
    return (u8) => { if (cb) cb({ message: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength), index: index++ }); };
  }
  // RDP：RESIZE + 一整塊 RECT（左半藍、右半橘，驗像素用）+ FRAME_END（格式見 src/rdFrames.ts）。
  function rdpDemoFrame(w, h, seq) {
    const hdr = (ty, a, b, c, d, s) => {
      const v = new DataView(new ArrayBuffer(16));
      v.setUint8(0, ty); v.setUint16(4, a, true); v.setUint16(6, b, true); v.setUint16(8, c, true); v.setUint16(10, d, true); v.setUint32(12, s, true);
      return new Uint8Array(v.buffer);
    };
    let px;
    if (fx.RDP_DEMO_FRAME) {
      // 截圖用：capture-screenshots.mjs 先畫好一張示範桌面（RGBA，base64）。
      const bin = atob(fx.RDP_DEMO_FRAME.rgba_b64);
      px = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i);
    } else {
      px = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const left = x < w / 2;
        px[i] = left ? 30 : 240; px[i + 1] = left ? 90 : 140; px[i + 2] = left ? 200 : 20; px[i + 3] = 255;
      }
    }
    const parts = [hdr(2, w, h, 0, 0, 0), hdr(1, 0, 0, w, h, seq), px, hdr(6, 0, 0, 0, 0, seq)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  // VNC：假 RFB 3.8 伺服器（None 認證 → 64×48 桌面 → 第一次 FramebufferUpdateRequest 回一塊 Raw 綠色畫面）。
  // 跟後端的假握手（rd::vnc::synth）送的位元組一樣，所以 noVNC 走的是跟真 App 同一條路。
  function rdVncServer(send) {
    const W = 64, H = 48;
    let state = "version";
    let buf = new Uint8Array(0);
    let sentFrame = false;
    setTimeout(() => send(new TextEncoder().encode("RFB 003.008\n")), 10);
    const take = (n) => { const out = buf.slice(0, n); buf = buf.slice(n); return out; };
    const serverInit = () => {
      const name = new TextEncoder().encode("demo-mac");
      const v = new DataView(new ArrayBuffer(24 + name.length));
      v.setUint16(0, W); v.setUint16(2, H);
      v.setUint8(4, 32); v.setUint8(5, 24); v.setUint8(6, 0); v.setUint8(7, 1);
      v.setUint16(8, 255); v.setUint16(10, 255); v.setUint16(12, 255);
      v.setUint8(14, 16); v.setUint8(15, 8); v.setUint8(16, 0);
      v.setUint32(20, name.length);
      const out = new Uint8Array(v.buffer);
      out.set(name, 24);
      return out;
    };
    const frame = ([r, g, b] = [20, 200, 60]) => {
      const v = new DataView(new ArrayBuffer(4 + 12 + W * H * 4));
      v.setUint8(0, 0); v.setUint16(2, 1);
      v.setUint16(4, 0); v.setUint16(6, 0); v.setUint16(8, W); v.setUint16(10, H); v.setInt32(12, 0);
      const out = new Uint8Array(v.buffer);
      // noVNC 設的像素格式是 32bpp little-endian、red shift 0 / green 8 / blue 16 → 記憶體順序 R G B X。
      for (let i = 0; i < W * H; i++) { out[16 + i * 4] = r; out[16 + i * 4 + 1] = g; out[16 + i * 4 + 2] = b; }
      return out;
    };
    // 情境可再塞一張整片同色的畫面（錄影期間要有畫面更新）：__DBKIT_RD_VNC_FRAME__([r, g, b])。
    window.__DBKIT_RD_VNC_FRAME__ = (rgb) => send(frame(rgb));
    // 250 = XVP（電源操作：[250, 0, 版本, 操作]）。
    const LEN = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10, 250: 4 };
    // 收到的用戶端訊息照順序記下來（SetEncodings / FramebufferUpdateRequest / XVP…），情境用來驗畫質、重新整理、電源。
    const msgs = (window.__DBKIT_RD_VNC_MSGS__ = []);
    return (u8) => {
      const next = new Uint8Array(buf.length + u8.length);
      next.set(buf); next.set(u8, buf.length); buf = next;
      for (;;) {
        if (state === "version") { if (buf.length < 12) return; take(12); send(new Uint8Array([1, 1])); state = "sec"; continue; }
        if (state === "sec") { if (buf.length < 1) return; take(1); send(new Uint8Array([0, 0, 0, 0])); state = "init"; continue; }
        if (state === "init") { if (buf.length < 1) return; take(1); send(serverInit()); state = "normal"; continue; }
        if (!buf.length) return;
        const type = buf[0];
        let n = LEN[type];
        if (type === 2) { if (buf.length < 4) return; n = 4 + 4 * ((buf[2] << 8) | buf[3]); }
        else if (type === 6) { if (buf.length < 8) return; n = 8 + new DataView(buf.buffer, buf.byteOffset + 4, 4).getUint32(0); }
        else if (n === undefined) { buf = new Uint8Array(0); return; } // 不認得的擴充訊息：丟掉
        if (buf.length < n) return;
        const m = take(n);
        msgs.push(Array.from(m));
        // 第一個請求、以及之後的非增量請求（工具列的「重新整理畫面」）回一張完整畫面。
        if (type === 3 && (!sentFrame || m[1] === 0)) { sentFrame = true; setTimeout(() => send(frame()), 10); }
        // 情境要伺服器支援電源操作（window.__DBKIT_RD_VNC_XVP__）：收到 SetEncodings 後回 XVP_INIT。
        if (type === 2 && window.__DBKIT_RD_VNC_XVP__) send(new Uint8Array([250, 0, 1, 1]));
      }
    };
  }

  // ── 事件投遞 ───────────────────────────────────────────────────────────
  // 真的 Tauri 會把 handler 存起來、由 Rust 端呼叫；這裡自己記一份，
  // 好讓 agent-stream / compare-progress 這類「命令觸發事件」的路徑在瀏覽器裡也能跑。
  let aiCancelled = false;
  let nextCb = 1;
  const callbacks = new Map();
  const listeners = new Map(); // event -> Set<fn>
  let nextEventId = 1;
  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of [...set]) { try { fn({ event, id: nextEventId++, payload }); } catch { /* 單一監聽器壞掉不影響其他 */ } }
  }
  window.__DBKIT_EMIT__ = emit; // 測試腳本可直接打事件
  function unregisterListener(event, eventId) {
    const fn = callbacks.get(eventId);
    if (fn) listeners.get(event)?.delete(fn);
    callbacks.delete(eventId);
    return Promise.resolve();
  }
  // @tauri-apps/api v2 的 unlisten 走這個全域，不是 invoke —— 少了它每次卸載都會噴 TypeError。
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener };

  window.__TAURI_INTERNALS__ = {
    transformCallback: (cb) => { const id = nextCb++; callbacks.set(id, cb); return id; },
    unregisterCallback: (id) => { callbacks.delete(id); },
    convertFileSrc: (p) => p,
    // getCurrentWindow() / getCurrentWebview() 讀這裡：sftp.html 當成 SFTP 獨立視窗，其餘是主視窗。
    metadata: (() => {
      const label = location.pathname.endsWith("sftp.html") ? "sftp-test" : "main";
      return { currentWindow: { label }, currentWebview: { windowLabel: label, label } };
    })(),
    invoke(cmd, args, options) {
      if (cmd === "plugin:event|listen") {
        const fn = callbacks.get(args?.handler);
        if (fn) {
          const set = listeners.get(args.event) ?? new Set();
          set.add(fn);
          listeners.set(args.event, set);
        }
        return Promise.resolve(args?.handler ?? 1);
      }
      if (cmd === "plugin:event|unlisten") return unregisterListener(args?.event, args?.eventId).then(() => null);
      // emit：真的 Tauri 會送給所有監聽者（包含自己這個視窗），這裡照樣回送，並記下來給情境驗「推了什麼給另一個視窗」。
      if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
        window.__DBKIT_EMITTED__.push({ event: args?.event, payload: args?.payload });
        setTimeout(() => emit(args?.event, args?.payload), 0);
        return Promise.resolve(null);
      }
      if (cmd.startsWith("plugin:event|")) return Promise.resolve(1);
      if (cmd.startsWith("plugin:window|")) window.__DBKIT_WINDOW_CALLS__.push(cmd);
      // 檔案對話框：回一個假路徑，開 / 存檔的後續流程（載入快照、匯出報告）才走得完。
      // 回 null 等於「使用者按取消」，那條路徑在截圖與冒煙檢查裡都驗不到東西。
      // 情境可用 window.__DBKIT_DIALOG_OPEN__ 換掉「選到的東西」（例如 SFTP 批次下載要的是資料夾）。
      if (cmd === "plugin:dialog|open") return Promise.resolve(window.__DBKIT_DIALOG_OPEN__ ?? fx.PICKED_OPEN_PATH);
      if (cmd === "plugin:dialog|save") return Promise.resolve(fx.PICKED_SAVE_PATH);
      if (cmd.startsWith("plugin:")) return Promise.resolve(null);
      const h = handlers[cmd];
      if (!h) { unknown.push(cmd); return Promise.reject(new Error(`screenshot shim: 未實作的 command ${cmd}`)); }
      // 給一點延遲，loading 狀態才不會閃成空白
      // options：raw body 的命令（rd_write / rd_input）把 conn id 放在 headers。
      return new Promise((res, rej) => setTimeout(() => {
        try { Promise.resolve(h(args ?? {}, options)).then(res, rej); } catch (e) { rej(e); }
      }, 30));
    },
  };
}
