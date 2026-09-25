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
    save_connection: () => null,
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
    save_text_file: () => null,
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
      const chunks = mode === "review" && fx.AI_REVIEW_CHUNKS ? fx.AI_REVIEW_CHUNKS
        : /SSH 終端機/.test(p) && /刪除/.test(p) && fx.AI_SHELL_DANGER_CHUNKS ? fx.AI_SHELL_DANGER_CHUNKS
        : /SSH 終端機/.test(p) && fx.AI_SHELL_CHUNKS ? fx.AI_SHELL_CHUNKS
        : fx.AI_SUMMARY_CHUNKS;
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

    // ── SSH 終端機 / SFTP ──────────────────────────────────────────────
    // 假 shell：逐字回聲、Enter 跑幾個固定指令（ls / pwd / echo / systemctl status nginx），其餘回 command not found。
    // 輸出走 Channel（見 channelSender），與真後端一樣是 raw bytes → ArrayBuffer。
    ssh_sessions_list: () => fx.SSH_SESSIONS ?? { version: 1, folders: [], sessions: [] },
    ssh_session_save: () => null,
    ssh_session_remove: () => null,
    ssh_sessions_layout_save: () => null,
    ssh_has_stored_password: () => true,
    ssh_connect: ({ connId, target }) => {
      const sessions = fx.SSH_SESSIONS?.sessions ?? [];
      const s = target?.kind === "session" ? sessions.find((x) => x.id === target.id)
        : target?.kind === "ad_hoc" ? target.session
        : { host: "db-bastion.internal", port: 22, username: "tunnel" };
      const info = { conn_id: connId, host: s?.host ?? "web-01", port: s?.port ?? 22, username: s?.username ?? "deploy" };
      sshConns.set(connId, info);
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
      const term = { send, prompt: `${user}@${hostShort}:~$ `, line: "" };
      sshTerms.set(termId, term);
      setTimeout(() => send(`Welcome to Ubuntu 22.04.4 LTS (GNU/Linux 5.15.0-107-generic x86_64)\r\n\r\nLast login: Tue Sep 23 09:12:44 2026 from 10.0.0.8\r\n${term.prompt}`), 40);
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
    ssh_sftp_open: () => ({ sftp_id: `sftp-${++sshSeq}`, home: "/home/deploy" }),
    ssh_sftp_close: () => null,
    ssh_sftp_list: ({ path }) => (fx.SFTP_LISTING?.[path] ?? []).map(sftpWithMeta),
    ssh_sftp_stat: ({ path }) => sftpFind(path) ?? Promise.reject(new Error("找不到檔案或目錄")),
    ssh_sftp_mkdir: () => null,
    ssh_sftp_rename: () => null,
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
    ssh_sftp_download: ({ remote }) => sshTransfer(remote),
    ssh_sftp_upload: ({ local }) => sshTransfer(local),
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
  };

  // ── SSH 假 shell 的狀態與工具 ──────────────────────────────────────────
  let sshSeq = 0;
  const sshConns = new Map(); // connId → { host, port, username }
  const sshTerms = new Map(); // termId → { send, prompt, line }
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
  function sshRun(cmd) {
    const c = cmd.trim();
    if (!c) return "";
    if (c === "ls" || c.startsWith("ls ")) return "app  backup.tar.gz  logs";
    if (c === "pwd") return "/home/deploy";
    if (c.startsWith("echo ")) return c.slice(5).replace(/^["']|["']$/g, "");
    if (/^systemctl status nginx/.test(c)) return "● nginx.service - A high performance web server\r\n     Active: active (running) since Mon 2026-09-22 08:00:11 UTC; 1 day 3h ago";
    if (/^(cd\b|clear$)/.test(c)) return "";
    return `bash: ${c.split(/\s+/)[0]}: command not found`;
  }
  function sshFeed(t, ch) {
    if (ch === "\r" || ch === "\n") {
      const out = sshRun(t.line);
      t.line = "";
      t.send(`\r\n${out ? `${out}\r\n` : ""}${t.prompt}`);
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
    [0.25, 0.6, 1].forEach((p, i) => setTimeout(() => emit("ssh-sftp-progress", {
      transfer_id: id, done: Math.round(total * p), total, state: p === 1 ? "done" : "running", message: null,
    }), 80 + i * 90));
    void name;
    return id;
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
    invoke(cmd, args) {
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
      if (cmd.startsWith("plugin:event|")) return Promise.resolve(1);
      // 檔案對話框：回一個假路徑，開 / 存檔的後續流程（載入快照、匯出報告）才走得完。
      // 回 null 等於「使用者按取消」，那條路徑在截圖與冒煙檢查裡都驗不到東西。
      // 情境可用 window.__DBKIT_DIALOG_OPEN__ 換掉「選到的東西」（例如 SFTP 批次下載要的是資料夾）。
      if (cmd === "plugin:dialog|open") return Promise.resolve(window.__DBKIT_DIALOG_OPEN__ ?? fx.PICKED_OPEN_PATH);
      if (cmd === "plugin:dialog|save") return Promise.resolve(fx.PICKED_SAVE_PATH);
      if (cmd.startsWith("plugin:")) return Promise.resolve(null);
      const h = handlers[cmd];
      if (!h) { unknown.push(cmd); return Promise.reject(new Error(`screenshot shim: 未實作的 command ${cmd}`)); }
      // 給一點延遲，loading 狀態才不會閃成空白
      return new Promise((res) => setTimeout(() => res(h(args ?? {})), 30));
    },
  };
}
