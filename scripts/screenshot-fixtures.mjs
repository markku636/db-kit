// docs/screenshots/*.png 的示範資料（虛構電商 shop，不含任何真實連線 / 資料）。
// 由 capture-screenshots.mjs 注入到 window.__TAURI_INTERNALS__ 的 invoke shim，
// 讓沒有 Tauri 後端的前端也能渲染出完整畫面。數值刻意寫得像真的，但全是假的。

export const CONNECTIONS = [
  { id: "c-mysql", name: "prod-mysql", kind: "mysql", host: "10.20.0.15", port: 3306, username: "app_ro", password: "", database: "shop", max_connections: 8 },
  { id: "c-pg", name: "analytics-pg", kind: "postgres", host: "10.20.0.31", port: 5432, username: "analyst", password: "", database: "warehouse", max_connections: 5 },
  { id: "c-mssql", name: "reporting-mssql", kind: "mssql", host: "10.20.0.44", port: 1433, username: "sa", password: "", database: "Reporting", max_connections: 5 },
  { id: "c-mongo", name: "events-mongo", kind: "mongo", host: "10.20.0.52", port: 27017, username: "app", password: "", database: "events", max_connections: 5 },
  { id: "c-redis", name: "cache-redis", kind: "redis", host: "10.20.0.60", port: 6379, username: "", password: "", max_connections: 5 },
  { id: "c-kafka", name: "stream-kafka", kind: "kafka", host: "10.20.0.71", port: 9092, username: "", password: "", max_connections: 5 },
  { id: "c-sqlite", name: "local.sqlite", kind: "sqlite", host: "", port: 0, username: "", password: "", database: "D:/data/local.sqlite", max_connections: 2 },
];

export const DATABASES = {
  "c-mysql": ["shop", "shop_archive", "information_schema", "mysql", "performance_schema", "sys"],
  "c-pg": ["warehouse", "postgres", "template1"],
  "c-mssql": ["Reporting", "master", "tempdb"],
  "c-mongo": ["events", "admin", "local"],
  "c-redis": ["0", "1"], // Redis driver 的 list_databases 回 "0".."15"
  "c-kafka": ["cluster"], // Kafka driver 回單一合成 cluster 節點
  "c-sqlite": ["main"],
};

const SHOP_TABLES = [
  "categories", "coupons", "customers", "inventory", "order_items", "orders",
  "payments", "products", "reviews", "shipments", "suppliers", "warehouses",
].map((name) => ({ name, kind: "table" }));

export const TABLES = {
  "c-mysql:shop": [...SHOP_TABLES, { name: "v_daily_sales", kind: "view" }, { name: "v_top_products", kind: "view" }],
  "c-mysql:shop_archive": [{ name: "orders_2024", kind: "table" }, { name: "orders_2023", kind: "table" }],
  "c-pg:warehouse": [
    { name: "dim_customer", kind: "table" }, { name: "dim_date", kind: "table" },
    { name: "fact_orders", kind: "table" }, { name: "fact_sessions", kind: "table" },
  ],
  "c-mongo:events": [{ name: "clickstream", kind: "table" }, { name: "sessions", kind: "table" }],
  // Redis 無表概念：driver 回一個虛擬 "keys" 節點
  "c-redis:0": [{ name: "keys", kind: "keyspace" }],
  "c-redis:1": [{ name: "keys", kind: "keyspace" }],
  // Kafka：主題直接掛在 cluster 節點下（TableInfo kind 一律 "table"）
  "c-kafka:cluster": [
    "app.logs", "inventory.updates", "notifications.email", "orders.events",
    "payments.completed", "shipments.tracking", "users.signups",
  ].map((name) => ({ name, kind: "table" })),
};

export const ORDERS_COLUMNS = [
  { name: "order_id", data_type: "bigint unsigned", nullable: false, key: "PRI", default: null, extra: "auto_increment", comment: "訂單編號" },
  { name: "customer_id", data_type: "bigint unsigned", nullable: false, key: "MUL", default: null, extra: "", comment: "下單客戶" },
  { name: "status", data_type: "enum('pending','paid','shipped','delivered','refunded')", nullable: false, key: "MUL", default: "pending", extra: "", comment: "訂單狀態" },
  { name: "total_amount", data_type: "decimal(12,2)", nullable: false, key: "", default: "0.00", extra: "", comment: "訂單總額（含稅）" },
  { name: "currency", data_type: "char(3)", nullable: false, key: "", default: "TWD", extra: "", comment: "ISO 4217 幣別" },
  { name: "coupon_code", data_type: "varchar(32)", nullable: true, key: "", default: null, extra: "", comment: "折價券代碼" },
  { name: "placed_at", data_type: "datetime", nullable: false, key: "MUL", default: "CURRENT_TIMESTAMP", extra: "", comment: "成立時間" },
  { name: "shipped_at", data_type: "datetime", nullable: true, key: "", default: null, extra: "", comment: "出貨時間" },
];

const row = (cells) => cells.map((c) => (c === null ? null : String(c)));
const SEED_ROWS = [
  [48213, 10427, "delivered", "3480.00", "TWD", "SPRING10", "2026-07-02 09:14:22", "2026-07-03 11:02:40"],
  [48214, 10419, "shipped", "1290.00", "TWD", null, "2026-07-02 09:31:07", "2026-07-03 08:45:12"],
  [48215, 10502, "paid", "12680.00", "TWD", "VIP500", "2026-07-02 10:02:55", null],
  [48216, 10318, "delivered", "899.00", "TWD", null, "2026-07-02 10:44:19", "2026-07-03 09:20:01"],
  [48217, 10502, "refunded", "2450.00", "TWD", null, "2026-07-02 11:07:33", "2026-07-03 14:31:55"],
  [48218, 10611, "pending", "560.00", "TWD", null, "2026-07-02 11:52:48", null],
  [48219, 10427, "paid", "7320.50", "TWD", "SPRING10", "2026-07-02 12:15:02", null],
  [48220, 10745, "shipped", "4199.00", "TWD", null, "2026-07-02 13:03:41", "2026-07-03 10:12:08"],
  [48221, 10190, "delivered", "329.00", "TWD", null, "2026-07-02 13:48:16", "2026-07-03 07:55:44"],
  [48222, 10611, "paid", "15990.00", "TWD", "VIP500", "2026-07-02 14:22:59", null],
  [48223, 10883, "pending", "1080.00", "TWD", null, "2026-07-02 15:01:30", null],
  [48224, 10318, "shipped", "2760.00", "TWD", "FREESHIP", "2026-07-02 15:39:12", "2026-07-03 12:40:27"],
  [48225, 10502, "delivered", "640.00", "TWD", null, "2026-07-02 16:12:44", "2026-07-03 13:05:19"],
  [48226, 10947, "paid", "8850.00", "TWD", null, "2026-07-02 16:58:03", null],
  [48227, 10190, "pending", "199.00", "TWD", null, "2026-07-02 17:21:37", null],
  [48228, 10745, "delivered", "5320.00", "TWD", "SPRING10", "2026-07-02 18:04:55", "2026-07-03 15:22:10"],
  [48229, 11002, "paid", "3199.00", "TWD", null, "2026-07-02 18:47:21", null],
  [48230, 10883, "shipped", "760.00", "TWD", null, "2026-07-02 19:11:09", "2026-07-03 16:48:33"],
  [48231, 10427, "delivered", "22400.00", "TWD", "VIP500", "2026-07-02 19:55:46", "2026-07-03 17:30:52"],
  [48232, 11015, "pending", "1450.00", "TWD", null, "2026-07-02 20:30:14", null],
  [48233, 10611, "paid", "980.00", "TWD", null, "2026-07-02 21:02:38", null],
  [48234, 10947, "delivered", "6700.00", "TWD", null, "2026-07-02 21:44:05", "2026-07-03 18:11:29"],
].map(row);

// 分頁器寫「100 / 頁」，整頁就要真的有 100 列（否則頁尾露出「顯示 1–22」）。
// 用確定性的偽亂數延伸，不用 Math.random —— 每次重產結果要一致。
const CUSTOMERS = [10190, 10318, 10419, 10427, 10502, 10611, 10745, 10883, 10947, 11002, 11015, 11128];
const STATUSES = ["delivered", "paid", "shipped", "pending", "delivered", "paid", "delivered", "refunded"];
const COUPONS = [null, null, "SPRING10", null, "VIP500", null, "FREESHIP", null];
const pad = (n) => String(n).padStart(2, "0");
export const ORDERS_ROWS = [...SEED_ROWS];
for (let i = SEED_ROWS.length; i < 100; i++) {
  const status = STATUSES[i % STATUSES.length];
  const amount = (((i * 7919) % 24000) + 199 + ((i * 37) % 100) / 100).toFixed(2);
  const placed = `2026-07-0${2 + Math.floor(i / 50)} ${pad(9 + ((i * 13) % 12))}:${pad((i * 17) % 60)}:${pad((i * 29) % 60)}`;
  const shipped = status === "pending" ? null
    : `2026-07-0${3 + Math.floor(i / 50)} ${pad(7 + ((i * 5) % 12))}:${pad((i * 23) % 60)}:${pad((i * 11) % 60)}`;
  ORDERS_ROWS.push(row([48213 + i, CUSTOMERS[i % CUSTOMERS.length], status, amount, "TWD", COUPONS[i % COUPONS.length], placed, shipped]));
}

export const ORDERS_PAGED = {
  columns: ORDERS_COLUMNS.map((c) => c.name),
  rows: ORDERS_ROWS,
  total_rows: 128_734,
  page: 0,
  page_size: 100,
  primary_key: ["order_id"],
};

export const ORDERS_INDEXES = [
  { name: "PRIMARY", columns: ["order_id"], unique: true, primary: true },
  { name: "idx_orders_customer", columns: ["customer_id"], unique: false, primary: false },
  { name: "idx_orders_status_placed", columns: ["status", "placed_at"], unique: false, primary: false },
];

export const ORDERS_FKS = [{ name: "fk_orders_customer", column: "customer_id", ref_table: "customers", ref_column: "customer_id" }];

export const ORDERS_INFO = [
  ["引擎", "InnoDB"], ["列數（估計）", "128,734"], ["資料大小", "42.3 MB"],
  ["索引大小", "11.8 MB"], ["字元集", "utf8mb4_0900_ai_ci"], ["建立時間", "2024-11-08 03:12:41"],
];

// 查詢編輯器：兩條語句 → 兩個堆疊的結果集（SSMS 風格）
export const MULTI_RESULTS = [
  {
    columns: ["status", "orders", "revenue", "avg_ticket"],
    rows: [
      ["delivered", "48,912", "38,204,551.00", "781.09"],
      ["paid", "21,455", "19,880,310.50", "926.61"],
      ["shipped", "17,203", "12,441,067.00", "723.19"],
      ["pending", "6,884", "3,102,940.00", "450.74"],
      ["refunded", "1,290", "988,412.00", "766.21"],
    ],
    rows_affected: 0,
  },
  {
    columns: ["product_id", "name", "category", "units_sold", "revenue"],
    rows: [
      ["8841", "Aurora 機械鍵盤 87 鍵", "周邊", "3,204", "9,612,000.00"],
      ["7213", "Nimbus 降噪耳機 Pro", "音訊", "2,871", "8,613,000.00"],
      ["9052", 'Vertex 27" 4K 螢幕', "顯示器", "1,942", "23,304,000.00"],
      ["6620", "Lumen 桌上型檯燈", "家居", "1,733", "1,213,100.00"],
      ["8117", "Cobalt 無線滑鼠", "周邊", "1,508", "1,206,400.00"],
      ["7788", "Slate 筆電支架", "周邊", "1,205", "723,000.00"],
    ],
    rows_affected: 0,
  },
];

export const EXPLAIN_RESULT = {
  columns: ["id", "select_type", "table", "type", "key", "rows", "filtered", "Extra"],
  rows: [["1", "SIMPLE", "orders", "range", "idx_orders_status_placed", "24188", "100.00", "Using index condition"]],
  rows_affected: 0,
};

const col = (name, data_type, pk = false, fk = false) => ({ name, data_type, pk, fk });
export const ER_MODEL = {
  tables: [
    { name: "customers", columns: [col("customer_id", "bigint", true), col("email", "varchar(255)"), col("name", "varchar(120)"), col("tier", "varchar(16)"), col("created_at", "datetime")] },
    { name: "orders", columns: [col("order_id", "bigint", true), col("customer_id", "bigint", false, true), col("status", "enum"), col("total_amount", "decimal(12,2)"), col("placed_at", "datetime")] },
    { name: "order_items", columns: [col("item_id", "bigint", true), col("order_id", "bigint", false, true), col("product_id", "bigint", false, true), col("qty", "int"), col("unit_price", "decimal(10,2)")] },
    { name: "products", columns: [col("product_id", "bigint", true), col("category_id", "bigint", false, true), col("supplier_id", "bigint", false, true), col("name", "varchar(200)"), col("price", "decimal(10,2)")] },
    { name: "categories", columns: [col("category_id", "bigint", true), col("name", "varchar(80)"), col("parent_id", "bigint")] },
    { name: "suppliers", columns: [col("supplier_id", "bigint", true), col("name", "varchar(160)"), col("country", "char(2)")] },
    { name: "payments", columns: [col("payment_id", "bigint", true), col("order_id", "bigint", false, true), col("method", "varchar(24)"), col("amount", "decimal(12,2)"), col("paid_at", "datetime")] },
    { name: "shipments", columns: [col("shipment_id", "bigint", true), col("order_id", "bigint", false, true), col("carrier", "varchar(40)"), col("tracking_no", "varchar(64)")] },
    { name: "reviews", columns: [col("review_id", "bigint", true), col("product_id", "bigint", false, true), col("customer_id", "bigint", false, true), col("rating", "tinyint"), col("body", "text")] },
    { name: "inventory", columns: [col("inventory_id", "bigint", true), col("product_id", "bigint", false, true), col("warehouse_id", "bigint", false, true), col("on_hand", "int")] },
  ],
  relations: [
    { from_table: "orders", from_column: "customer_id", to_table: "customers", to_column: "customer_id" },
    { from_table: "order_items", from_column: "order_id", to_table: "orders", to_column: "order_id" },
    { from_table: "order_items", from_column: "product_id", to_table: "products", to_column: "product_id" },
    { from_table: "products", from_column: "category_id", to_table: "categories", to_column: "category_id" },
    { from_table: "products", from_column: "supplier_id", to_table: "suppliers", to_column: "supplier_id" },
    { from_table: "payments", from_column: "order_id", to_table: "orders", to_column: "order_id" },
    { from_table: "shipments", from_column: "order_id", to_table: "orders", to_column: "order_id" },
    { from_table: "reviews", from_column: "product_id", to_table: "products", to_column: "product_id" },
    { from_table: "reviews", from_column: "customer_id", to_table: "customers", to_column: "customer_id" },
    { from_table: "inventory", from_column: "product_id", to_table: "products", to_column: "product_id" },
  ],
};

export const REDIS_KEYS = {
  keys: [
    "session:web:8f21c4", "session:web:a37b19", "session:web:c05e77", "session:mobile:2b91da",
    "cart:10427", "cart:10502", "cart:10611",
    "product:8841:stock", "product:7213:stock", "product:9052:stock",
    "leaderboard:sales:2026-07", "leaderboard:sales:2026-06",
    "queue:email:pending", "queue:webhook:retry",
    "rate:ip:203.0.113.7", "rate:ip:198.51.100.22",
    "feature:checkout_v2", "config:shipping:rates",
  ],
  truncated: false,
};

export const REDIS_KEY_PAGE = {
  type_: "hash", ttl: 1_742, total: 6, cursor: 0,
  fields: ["items", "subtotal", "currency", "coupon", "updated_at", "locale"],
  members: ["3", "12680.00", "TWD", "VIP500", "2026-07-02 10:02:55", "zh-TW"],
  scores: [], value_bytes: -1, truncated: false,
};

export const REDIS_INFO = [
  { name: "Server", items: [["redis_version", "7.2.5"], ["uptime_in_days", "43"], ["os", "Linux 5.15.0 x86_64"], ["tcp_port", "6379"]] },
  { name: "Clients", items: [["connected_clients", "38"], ["blocked_clients", "0"], ["maxclients", "10000"]] },
  { name: "Memory", items: [["used_memory_human", "412.66M"], ["used_memory_peak_human", "588.19M"], ["maxmemory_human", "2.00G"], ["mem_fragmentation_ratio", "1.08"]] },
  { name: "Stats", items: [["total_connections_received", "1284551"], ["instantaneous_ops_per_sec", "2847"], ["keyspace_hits", "88214005"], ["keyspace_misses", "1204889"]] },
  { name: "Keyspace", items: [["db0", "keys=18,expires=9,avg_ttl=1742000"]] },
];

// ---- Kafka（orders.events 主題的訊息瀏覽器）----
export const KAFKA_PARTITIONS = [
  { partition: 0, leader: 1, replicas: [1, 2, 3], isr: [1, 2, 3], low: 0, high: 84_127 },
  { partition: 1, leader: 2, replicas: [2, 3, 1], isr: [2, 3, 1], low: 0, high: 83_902 },
  { partition: 2, leader: 3, replicas: [3, 1, 2], isr: [3, 1, 2], low: 0, high: 84_455 },
];

// 訊息時間戳一律由固定字串推導（截圖需可重現，禁 Date.now）。
const kts = (s) => Date.parse(s);
const kmsg = (partition, offset, ts, orderId, event, extra) => ({
  conn_id: "c-kafka",
  topic: "orders.events",
  partition,
  offset,
  timestamp: kts(ts),
  key: `order-${orderId}`,
  value: JSON.stringify({ order_id: orderId, event, ...extra }),
  headers: [{ key: "source", value: "checkout-api" }, { key: "trace_id", value: `tr-${(orderId * 2654435761 % 0xffffff).toString(16)}` }],
  key_encoding: "string",
  value_encoding: "json",
  value_bytes: 0,
  truncated: false,
  schema_id: null,
});
const KAFKA_MESSAGES = [
  kmsg(0, 84_112, "2026-07-02T20:41:07+08:00", 48219, "order.paid", { amount: 7320.5, currency: "TWD", method: "credit_card" }),
  kmsg(2, 84_440, "2026-07-02T20:42:33+08:00", 48220, "order.shipped", { carrier: "black-cat", tracking_no: "BC-8842-1107" }),
  kmsg(1, 83_889, "2026-07-02T20:44:02+08:00", 48221, "order.delivered", { signed_by: "customer", pod: true }),
  kmsg(0, 84_113, "2026-07-02T20:46:19+08:00", 48222, "order.paid", { amount: 15990, currency: "TWD", method: "line_pay", coupon: "VIP500" }),
  kmsg(2, 84_441, "2026-07-02T20:48:55+08:00", 48223, "order.created", { amount: 1080, currency: "TWD", items: 2 }),
  kmsg(1, 83_890, "2026-07-02T20:50:31+08:00", 48217, "order.refunded", { amount: 2450, currency: "TWD", reason: "damaged" }),
  kmsg(0, 84_114, "2026-07-02T20:52:08+08:00", 48224, "order.shipped", { carrier: "sf-express", tracking_no: "SF-3391-0725" }),
  kmsg(2, 84_442, "2026-07-02T20:53:47+08:00", 48225, "order.delivered", { signed_by: "front-desk", pod: true }),
  kmsg(1, 83_891, "2026-07-02T20:55:26+08:00", 48226, "order.paid", { amount: 8850, currency: "TWD", method: "apple_pay" }),
  kmsg(0, 84_115, "2026-07-02T20:56:50+08:00", 48227, "order.created", { amount: 199, currency: "TWD", items: 1 }),
  kmsg(2, 84_443, "2026-07-02T20:58:12+08:00", 48228, "order.delivered", { signed_by: "customer", pod: false }),
  kmsg(1, 83_892, "2026-07-02T20:59:03+08:00", 48229, "order.paid", { amount: 3199, currency: "TWD", method: "credit_card" }),
  kmsg(0, 84_116, "2026-07-02T20:59:41+08:00", 48230, "order.shipped", { carrier: "black-cat", tracking_no: "BC-8901-2216" }),
  kmsg(2, 84_444, "2026-07-02T21:00:00+08:00", 48231, "order.delivered", { signed_by: "customer", pod: true, rating_prompt: true }),
].map((m) => ({ ...m, value_bytes: new TextEncoder().encode(m.value).length }));

export const KAFKA_CONSUME = {
  messages: KAFKA_MESSAGES,
  scanned: KAFKA_MESSAGES.length,
  matched: KAFKA_MESSAGES.length,
  reached_end: true,
  eval_errors: 0,
  elapsed_ms: 212,
};

export const SEARCH_HITS = [
  { database: "shop", object_type: "table", object_name: "orders", parent: null, matched_in: "name", snippet: null, extra: null },
  { database: "shop", object_type: "table", object_name: "order_items", parent: null, matched_in: "name", snippet: null, extra: null },
  { database: "shop", object_type: "column", object_name: "order_id", parent: "orders", matched_in: "name", snippet: null, extra: "bigint unsigned" },
  { database: "shop", object_type: "column", object_name: "order_id", parent: "payments", matched_in: "name", snippet: null, extra: "bigint unsigned" },
  { database: "shop", object_type: "column", object_name: "order_id", parent: "shipments", matched_in: "name", snippet: null, extra: "bigint unsigned" },
  { database: "shop", object_type: "index", object_name: "idx_orders_status_placed", parent: "orders", matched_in: "name", snippet: null, extra: "status, placed_at" },
  { database: "shop", object_type: "foreign_key", object_name: "fk_orders_customer", parent: "orders", matched_in: "name", snippet: null, extra: "customer_id → customers.customer_id" },
  {
    database: "shop", object_type: "procedure", object_name: "sp_close_order", parent: null, matched_in: "definition",
    snippet: "UPDATE orders SET status = 'delivered', shipped_at = NOW()\n  WHERE order_id = p_order_id AND status = 'shipped';", extra: null,
  },
  {
    database: "shop", object_type: "function", object_name: "fn_order_total", parent: null, matched_in: "definition",
    snippet: "SELECT SUM(qty * unit_price) INTO v_total FROM order_items\n  WHERE order_id = p_order_id;", extra: "(p_order_id BIGINT) RETURNS DECIMAL(12,2)",
  },
  {
    database: "shop", object_type: "trigger", object_name: "trg_orders_audit", parent: "orders", matched_in: "definition",
    snippet: "INSERT INTO audit_log(entity, entity_id, action)\n  VALUES ('orders', NEW.order_id, 'update');", extra: null,
  },
  { database: "shop", object_type: "view", object_name: "v_daily_sales", parent: null, matched_in: "definition", snippet: "SELECT DATE(placed_at) AS d, COUNT(*) AS orders, SUM(total_amount) AS revenue\n  FROM orders GROUP BY 1", extra: null },
  { database: "shop_archive", object_type: "table", object_name: "orders_2024", parent: null, matched_in: "name", snippet: null, extra: null },
  { database: "shop_archive", object_type: "table", object_name: "orders_2023", parent: null, matched_in: "name", snippet: null, extra: null },
  { database: "shop", object_type: "column", object_name: "orders_count", parent: "customers", matched_in: "comment", snippet: "累計 orders 筆數（每日排程回填）", extra: "int" },
];

export const ROUTINES = [
  { name: "sp_close_order", routine_type: "procedure", parent: null, signature: null, modified: "2026-06-18 14:02:11", deterministic: false, comment: null },
  { name: "sp_rebuild_inventory", routine_type: "procedure", parent: null, signature: null, modified: "2026-05-30 09:41:07", deterministic: false, comment: null },
  { name: "fn_order_total", routine_type: "function", parent: null, signature: null, modified: "2026-06-02 17:20:33", deterministic: true, comment: null },
  { name: "trg_orders_audit", routine_type: "trigger", parent: "orders", signature: null, modified: null, deterministic: null, comment: null },
];

export const SCHEMA_COLUMNS = {
  orders: ORDERS_COLUMNS.map((c) => c.name),
  customers: ["customer_id", "email", "name", "tier", "created_at"],
  order_items: ["item_id", "order_id", "product_id", "qty", "unit_price"],
  products: ["product_id", "category_id", "supplier_id", "name", "price"],
  payments: ["payment_id", "order_id", "method", "amount", "paid_at"],
};

// localStorage 種子：連線色標 / 唯讀 / 釘選 / 查詢歷史 / 收藏查詢
export const STORAGE_SEED = {
  "db-kit:connColors": { "c-mysql": "#ef4444", "c-pg": "#22c55e" },
  "db-kit:readonlyConns": { "c-mysql": true },
  "db-kit:pinnedTables": [{ connId: "c-mysql", db: "shop", table: "orders", kind: "table" }],
  "db-kit:savedQueries": [
    { name: "每日營收", sql: "SELECT DATE(placed_at) d, SUM(total_amount) revenue\nFROM orders GROUP BY 1 ORDER BY 1 DESC;", group: "報表" },
    { name: "熱銷商品 Top 10", sql: "SELECT p.name, SUM(oi.qty) units\nFROM order_items oi JOIN products p USING (product_id)\nGROUP BY 1 ORDER BY 2 DESC LIMIT 10;", group: "報表" },
    { name: "待出貨訂單", sql: "SELECT * FROM orders WHERE status = 'paid' ORDER BY placed_at;", group: "維運" },
  ],
};

export const DEMO_SQL =
  "SELECT status, COUNT(*) AS orders, SUM(total_amount) AS revenue,\n" +
  "ROUND(AVG(total_amount), 2) AS avg_ticket\nFROM orders\nWHERE placed_at >= '2026-01-01'\nGROUP BY status ORDER BY revenue DESC;\n\n" +
  "SELECT p.product_id, p.name, c.name AS category,\n  SUM(oi.qty) AS units_sold, SUM(oi.qty * oi.unit_price) AS revenue\n" +
  "FROM order_items oi\n  JOIN products p USING (product_id)\n  JOIN categories c USING (category_id)\nGROUP BY 1, 2, 3 ORDER BY revenue DESC LIMIT 6;";
