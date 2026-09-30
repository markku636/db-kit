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
  // 遠端桌面：存檔、連線 / 斷線、送出的位元組 / 輸入紀錄 / ack / resize / 組合鍵 / 全螢幕切換、提示的答案。
  window.__DBKIT_RD_SESSION_SAVES__ = [];
  window.__DBKIT_RD_CONNECTS__ = [];
  window.__DBKIT_RD_DISCONNECTS__ = [];
  window.__DBKIT_RD_WRITES__ = [];
  window.__DBKIT_RD_INPUTS__ = [];
  window.__DBKIT_RD_ACKS__ = [];
  window.__DBKIT_RD_RESIZES__ = [];
  window.__DBKIT_RD_KEYS__ = [];
  window.__DBKIT_RD_FULLSCREEN__ = [];
  window.__DBKIT_RD_ANSWERS__ = [];
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
    if (s.startsWith("use ")) return [];
    return [one(["result"], ["ok"])];
  };

  const isMysql = ({ id }) => id === "c-mysql";
  const cachedAt = () => Date.now() - fx.SCHEMA_CACHE_AGE_MS;
  const handlers = {
    has_startup_password: () => false,
    // 假資料的連線不帶明文密碼；回 true＝keychain 裡有，連線前的「缺帳密」防呆才不會擋住
    has_stored_password: () => true,
    list_saved_connections: () => fx.CONNECTIONS,
    // 側欄分組（v0.20 起）。預設無群組＝扁平清單，與截圖情境一致；情境可用 fx 覆寫。
    list_connection_groups: () => fx.CONN_GROUPS ?? [],
    save_connection_layout: () => null,
    set_query_guard: () => null,
    connect: () => null,
    disconnect: () => null,
    test_connection: () => null,
    clear_cache: () => null,
    save_connection: ({ config }) => { (window.__DBKIT_CONN_SAVES__ ||= []).push(config); return null; },
    open_external: () => null,
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
          return { conn_id: connId, protocol, width: 0, height: 0, security: "vnc-auth", encrypted: false };
        }
        if (protocol === "rustdesk") {
          // 輔助程式的「登入成功」事件（[型別 1][JSON]）；影像是 VP9 位元流，假後端做不出來，不送。
          const hello = new TextEncoder().encode(JSON.stringify({
            type: "connected",
            peer: { hostname: "office-pc", displays: [{ x: 0, y: 0, width: 1280, height: 720, name: "" }], current_display: 0 },
          }));
          setTimeout(() => send(new Uint8Array([1, ...hello])), 20);
          // 真的 RustDesk 錄下來的 VP9 關鍵畫面（見 screenshot-fixtures.mjs）：前端要用 WebCodecs 解出 1024×768。
          if (fx.RUSTDESK_VP9_KEYFRAME_B64) {
            const bin = atob(fx.RUSTDESK_VP9_KEYFRAME_B64);
            const frame = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) frame[i] = bin.charCodeAt(i);
            setTimeout(() => send(frame), 60);
          }
          return { conn_id: connId, protocol, width: 1280, height: 720, security: "rustdesk-direct", encrypted: false };
        }
        setTimeout(() => send(rdpDemoFrame(320, 200, 1)), 30);
        window.__DBKIT_RD_PUSH__ = (bytes) => send(new Uint8Array(bytes)); // 情境直接塞後端訊息（例如遠端剪貼簿）
        return { conn_id: connId, protocol, width: 320, height: 200, security: "nla", encrypted: true };
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
      window.__DBKIT_SSH_LAST_CONN__ = connId; // 測試用：模擬斷線要知道是哪條
      return info;
    },
    ssh_test: () => new Promise((r) => setTimeout(() => r(null), 200)),
    ssh_disconnect: ({ connId }) => { sshConns.delete(connId); return null; },
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
    ssh_sftp_open: ({ connId }) => { window.__DBKIT_SFTP_OPENS__.push(connId); return { sftp_id: `sftp-${++sshSeq}`, home: "/home/deploy" }; },
    ssh_sftp_close: () => null,
    ssh_sftp_list: ({ path }) => (fx.SFTP_LISTING?.[path] ?? []).map(sftpWithMeta),
    ssh_sftp_stat: ({ path }) => sftpFind(path) ?? Promise.reject(new Error("找不到檔案或目錄")),
    ssh_sftp_mkdir: () => null,
    ssh_sftp_rename: ({ from, to }) => { window.__DBKIT_SFTP_RENAMES__.push({ from, to }); return null; },
    ssh_sftp_remove: ({ path, recursive }) => { window.__DBKIT_SFTP_REMOVES__.push({ path, recursive }); return null; },
    ssh_sftp_read_text: ({ path }) => { const text = sftpFiles.get(path) ?? ""; return { text, truncated: false, size: new TextEncoder().encode(text).length, lossy: false, binary: false }; },
    ssh_sftp_write_text: ({ path, content, createNew }) => {
      window.__DBKIT_SFTP_WRITES__.push({ path, content, createNew });
      sftpFiles.set(path, content);
      sftpMeta.set(path, { ...(sftpMeta.get(path) ?? {}), size: new TextEncoder().encode(content).length, mtime: Math.floor(Date.now() / 1000) });
      return sftpFind(path) ?? { name: path.split("/").pop(), path, is_dir: false, is_symlink: false, link_target_is_dir: null, size: content.length, mtime: Math.floor(Date.now() / 1000), permissions: 0o100644, mode: "-rw-r--r--", uid: 1000, gid: 1000, owner: "deploy", group: "deploy" };
    },
    ssh_sftp_chmod: ({ path, mode }) => {
      window.__DBKIT_SFTP_CHMOD__.push({ path, mode });
      const base = sftpFind(path);
      const type = base?.is_dir ? 0o40000 : 0o100000;
      sftpMeta.set(path, { ...(sftpMeta.get(path) ?? {}), permissions: type | mode });
      return sftpFind(path);
    },
    ssh_sftp_download: ({ remote, local, resume }) => {
      window.__DBKIT_SFTP_TRANSFERS__.push({ kind: "download", remote, local, resume: !!resume });
      return sshTransfer(remote);
    },
    ssh_sftp_upload: ({ local, remote, resume }) => {
      window.__DBKIT_SFTP_TRANSFERS__.push({ kind: "upload", local, remote, resume: !!resume });
      return sshTransfer(local);
    },
    ssh_sftp_download_many: ({ remotes, localDir, onConflict }) => {
      window.__DBKIT_SFTP_BATCH__.push({ kind: "download", remotes, localDir, onConflict });
      return sshTransfer(remotes[0]);
    },
    ssh_sftp_upload_many: ({ locals, remoteDir, onConflict }) => {
      window.__DBKIT_SFTP_BATCH__.push({ kind: "upload", locals, remoteDir, onConflict });
      return sshTransfer(locals[0]);
    },
    // 本機「已經有」哪些名稱由情境自己設（window.__DBKIT_LOCAL_EXISTING__），預設都沒有。
    ssh_sftp_local_conflicts: ({ names }) => names.filter((n) => (window.__DBKIT_LOCAL_EXISTING__ ?? []).includes(n)),
    ssh_sftp_cancel: () => null,
    // SFTP 獨立視窗：瀏覽器裡開不了第二個視窗，只記下呼叫（回 true = 新開的）。視窗那一側由情境直接開 sftp.html 驗。
    ssh_sftp_window_open: ({ tabKey, title }) => { window.__DBKIT_SFTP_WINDOWS__.push({ op: "open", tabKey, title }); return true; },
    ssh_sftp_window_close: ({ tabKey }) => { window.__DBKIT_SFTP_WINDOWS__.push({ op: "close", tabKey }); return null; },
    show_main_window: () => null,
  };

  // ── Docker 假容器 / exec 的狀態 ──────────────────────────────────────────
  let dockerSeq = 0;
  const dockerExecs = new Map(); // streamId → { send, line, host }
  window.__DBKIT_DOCKER_ACTIONS__ = [];
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
    if (c === "ls" || c.startsWith("ls ")) return "app  backup.tar.gz  logs";
    if (c === "pwd") return t.cwd;
    if (c.startsWith("echo ")) return c.slice(5).replace(/^["']|["']$/g, "");
    if (/^systemctl status nginx/.test(c)) return "● nginx.service - A high performance web server\r\n     Active: active (running) since Mon 2026-09-22 08:00:11 UTC; 1 day 3h ago";
    if (/^cd\b/.test(c)) return sshCd(t, c.slice(2).trim());
    if (c === "clear") return "";
    return `bash: ${c.split(/\s+/)[0]}: command not found`;
  }
  function sshFeed(t, ch) {
    if (ch === "\r" || ch === "\n") {
      const out = sshRun(t, t.line);
      t.line = "";
      t.send(`\r\n${out ? `${out}\r\n` : ""}${sshTitle(t)}${t.prompt}`);
    } else if (ch === "\x7f" || ch === "\b") {
      if (t.line) { t.line = t.line.slice(0, -1); t.send("\b \b"); }
    } else if (ch === "\x03") {
      t.line = "";
      t.send(`^C\r\n${t.prompt}`);
    } else if (ch >= " ") {
      t.line += ch;
      t.send(ch);
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
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = x < w / 2;
      px[i] = left ? 30 : 240; px[i + 1] = left ? 90 : 140; px[i + 2] = left ? 200 : 20; px[i + 3] = 255;
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
    const frame = () => {
      const v = new DataView(new ArrayBuffer(4 + 12 + W * H * 4));
      v.setUint8(0, 0); v.setUint16(2, 1);
      v.setUint16(4, 0); v.setUint16(6, 0); v.setUint16(8, W); v.setUint16(10, H); v.setInt32(12, 0);
      const out = new Uint8Array(v.buffer);
      // noVNC 設的像素格式是 32bpp little-endian、red shift 0 / green 8 / blue 16 → 記憶體順序 R G B X。
      for (let i = 0; i < W * H; i++) { out[16 + i * 4] = 20; out[16 + i * 4 + 1] = 200; out[16 + i * 4 + 2] = 60; }
      return out;
    };
    const LEN = { 0: 20, 3: 10, 4: 8, 5: 6, 150: 10 };
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
        take(n);
        if (type === 3 && !sentFrame) { sentFrame = true; setTimeout(() => send(frame()), 10); }
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
