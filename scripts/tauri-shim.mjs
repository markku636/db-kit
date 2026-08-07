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
  };

  let nextCb = 1;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => nextCb++,
    unregisterCallback: () => {},
    convertFileSrc: (p) => p,
    invoke(cmd, args) {
      if (cmd.startsWith("plugin:event|")) return Promise.resolve(1);
      if (cmd.startsWith("plugin:")) return Promise.resolve(null);
      const h = handlers[cmd];
      if (!h) { unknown.push(cmd); return Promise.reject(new Error(`screenshot shim: 未實作的 command ${cmd}`)); }
      // 給一點延遲，loading 狀態才不會閃成空白
      return new Promise((res) => setTimeout(() => res(h(args ?? {})), 30));
    },
  };
}
