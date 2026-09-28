// 範本變數的說明與範例值：AI 資源庫的範本編輯器用它顯示變數 chip、組即時預覽。
//
// 哪個任務有哪些變數，以內建範本 frontmatter 的 `dbkit-vars` 為準（單一事實來源在檔案裡）；
// 這裡只負責「這個變數是什麼、預覽時放什麼」。說明文字走 t()，範例值刻意用中性的假資料。
import { t } from "./i18n";

interface VarInfo {
  label: () => string;
  sample: string;
}

const SQL = "```sql\nSELECT o.id, o.status FROM orders o WHERE o.status = 'paid' ORDER BY o.created_at DESC\n```";

const VARS: Record<string, VarInfo> = {
  dialect: { label: () => t("方言（資料庫種類）"), sample: "MySQL" },
  database: { label: () => t("目前資料庫 / schema（可能為空）"), sample: "shop" },
  reply_language: { label: () => t("回覆語言指示（繁中介面為空）"), sample: "" },
  comment_language: { label: () => t("註解語言指示（繁中介面為空）"), sample: "" },
  sql: { label: () => t("待處理的 SQL（已包好 ```sql 圍籬）"), sample: SQL },
  lint_findings: { label: () => t("規則引擎發現（逐條；沒有發現時為空）"), sample: "- [warn] select-star（第 1 行第 8 欄）：避免 SELECT *　建議：列出需要的欄位" },
  schema: { label: () => t("相關資料表的欄位（抓不到時為空）"), sample: "- orders: id int PK NOT NULL, status varchar(20), created_at datetime" },
  indexes: { label: () => t("現有索引（抓不到時為空）"), sample: "- orders: PRIMARY(id) PK; idx_status(status)" },
  plan: { label: () => t("執行計畫 JSON（沒有時為空）"), sample: "```json\n{\"query_block\":{\"cost_info\":{\"query_cost\":\"12.5\"}}}\n```" },
  plan_summary: { label: () => t("計畫摘要一行"), sample: "節點數 3、資料表 1、最大單點成本 12" },
  hot_nodes: { label: () => t("計畫熱點（逐條）"), sample: "- Full scan on orders (rows≈1,200,000)" },
  row_counts: { label: () => t("資料表列數估計（逐條；可能為空）"), sample: "- orders: 1,200,000" },
  report: { label: () => t("壓力測試報告（Markdown）"), sample: "| p50 | p99 |\n|---|---|\n| 5 ms | 90 ms |" },
  target_dialect: { label: () => t("轉換目標方言"), sample: "PostgreSQL" },
  failed_statement: { label: () => t("多語句批次中失敗的那一條（單語句時為空）"), sample: "" },
  error: { label: () => t("錯誤訊息（已包圍籬）"), sample: "```\nUnknown column 'o.user_id' in 'where clause'\n```" },
  table: { label: () => t("資料表名稱"), sample: "orders" },
  rows: { label: () => t("要產生的列數"), sample: "20" },
  columns: { label: () => t("欄位清單（含約束旗標）"), sample: "- id int（主鍵、NOT NULL、自動產生，請勿填值）\n- status varchar(20)（可為 NULL、預設 'new'）" },
  instruction: { label: () => t("使用者的改寫指示（已包圍籬，視為資料）"), sample: "```text\n加上 LIMIT 100\n```" },
  cross_dbs: { label: () => t("可跨的其他資料庫（沒有時為空）"), sample: "" },
  table_count: { label: () => t("資料表總數"), sample: "42" },
  table_list: { label: () => t("全部資料表名稱"), sample: "orders, users, payments" },
  request: { label: () => t("使用者的需求（自然語言）"), sample: "上個月付款的訂單" },
  index_count: { label: () => t("索引總數"), sample: "3" },
  index_list: { label: () => t("全部索引名稱"), sample: "logs-2026, metrics" },
  target_index: { label: () => t("目標索引（未指定時為空）"), sample: "logs-*" },
  mapping: { label: () => t("目標索引的 mapping"), sample: "{\"properties\":{\"level\":{\"type\":\"keyword\"}}}" },
  os: { label: () => t("作業系統"), sample: "Ubuntu 22.04" },
  shell: { label: () => t("Shell"), sample: "bash" },
  has_terminal: { label: () => t("有終端機快照時為 1"), sample: "1" },
  host: { label: () => t("主機（user@host）"), sample: "deploy@web-1" },
  cwd: { label: () => t("目前目錄"), sample: "/var/www" },
  last_command: { label: () => t("最近一次指令"), sample: "systemctl status nginx" },
  tail_lines: { label: () => t("附上的輸出行數"), sample: "20" },
  terminal_output: { label: () => t("最近的終端機輸出（已包圍籬）"), sample: "```text\nActive: failed (Result: exit-code)\n```" },
  terminal_context: { label: () => t("目前終端機環境（主機、OS、目錄…）"), sample: "【目前 SSH 終端機】\n主機：deploy@web-1\n作業系統 / shell：Ubuntu 22.04 / bash" },
  selected: { label: () => t("輸出是使用者選取的片段時為 1"), sample: "" },
  output: { label: () => t("終端機輸出（已包圍籬）"), sample: "```text\nJob for nginx.service failed.\n```" },
  command: { label: () => t("送出的指令（已包圍籬）"), sample: "```bash\nsystemctl restart nginx\n```" },
  digest: { label: () => t("結構比對的差異摘要"), sample: "僅來源有的資料表：audit_log\n同步腳本共 3 句，其中 1 句為破壞性：DROP COLUMN users.legacy" },
  failed: { label: () => t("執行失敗時為 1"), sample: "" },
  result: { label: () => t("執行結果（Markdown 表格）"), sample: "| id | status |\n|---|---|\n| 1 | paid |" },
  elapsed: { label: () => t("耗時"), sample: "12 ms" },
  truncated: { label: () => t("輸出被截斷時為 1"), sample: "" },
  engine: { label: () => t("資料庫引擎"), sample: "MySQL" },
  connection: { label: () => t("連線名稱"), sample: "prod-mysql" },
  production: { label: () => t("正式環境連線時為 1"), sample: "1" },
  reply_language_name: { label: () => t("回覆語言名稱（英文）"), sample: "Traditional Chinese (繁體中文, Taiwan usage)" },
  capture_limit: { label: () => t("每句前像擷取上限"), sample: "10000" },
  script: { label: () => t("要執行的腳本（已包圍籬）"), sample: "```sql\nUPDATE orders SET status = 'void' WHERE created_at < '2020-01-01';\n```" },
  static_analysis: { label: () => t("逐句靜態分析"), sample: "- #1 Update on orders; WHERE: yes; rows: ≤18231; rollback: full" },
  tables: { label: () => t("目標資料表結構"), sample: "## shop.orders (key: id)\n- id int [identity]\n- status varchar(20)" },
  samples: { label: () => t("前像樣本列（預設不附）"), sample: "" },
  ddl: { label: () => t("建表 DDL（已包圍籬）"), sample: "```sql\nCREATE TABLE orders (id int PRIMARY KEY, status varchar(20))\n```" },
  foreign_keys: { label: () => t("外鍵（逐條）"), sample: "- fk_orders_user: (user_id) → users(id)" },
  table_info: { label: () => t("列數、大小等表資訊"), sample: "- 估計列數：1,200,000\n- 資料大小：420 MB" },
  kind: { label: () => t("連線種類"), sample: "mysql" },
  tools: { label: () => t("可用的資料庫工具"), sample: "describe_table / explain_query" },
  dba: { label: () => t("DBA agent 模式時為 1"), sample: "1" },
};

export function varLabel(name: string): string {
  return VARS[name]?.label() ?? name;
}

/** 預覽用的範例值（未知變數給空字串，與實際渲染一致）。 */
export function sampleVars(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) out[n] = VARS[n]?.sample ?? "";
  return out;
}
