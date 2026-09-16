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

    // ── AI 助手 ──────────────────────────────────────────────────────────
    app_lock_status: () => ({ locked: false, has_password: false, idle_minutes: 0 }),
    agent_detect: () => ({ available: true, provider: "claude", version: "2.0.0", path: "claude", models: [], note: null }),
    agent_cancel: () => { aiCancelled = true; return null; },
    // 串流回覆：一小段一小段 emit，讓截圖 / 冒煙檢查看到的是真的串流渲染路徑。
    agent_send: ({ reqId }) => {
      aiCancelled = false;
      let i = 0;
      const tick = () => {
        if (aiCancelled || i >= fx.AI_SUMMARY_CHUNKS.length) {
          emit("agent-stream", { req_id: reqId, kind: "done", text: null });
          return;
        }
        emit("agent-stream", { req_id: reqId, kind: "text", text: fx.AI_SUMMARY_CHUNKS[i++] });
        setTimeout(tick, 60);
      };
      setTimeout(tick, 80);
      return null;
    },
  };

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
      if (cmd === "plugin:dialog|open") return Promise.resolve(fx.PICKED_OPEN_PATH);
      if (cmd === "plugin:dialog|save") return Promise.resolve(fx.PICKED_SAVE_PATH);
      if (cmd.startsWith("plugin:")) return Promise.resolve(null);
      const h = handlers[cmd];
      if (!h) { unknown.push(cmd); return Promise.reject(new Error(`screenshot shim: 未實作的 command ${cmd}`)); }
      // 給一點延遲，loading 狀態才不會閃成空白
      return new Promise((res) => setTimeout(() => res(h(args ?? {})), 30));
    },
  };
}
