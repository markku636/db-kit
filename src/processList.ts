import type { DbKind } from "./api";

// 列出目前連線 / 工作階段（致敬 Navicat 的伺服器監控）。沿用既有 runQuery（清單）+ execDdl（終止），免後端改動。
// MySQL / MariaDB / PostgreSQL / SQL Server / Oracle。
export const LIST_SQL: Partial<Record<DbKind, string>> = {
  mysql: "SHOW FULL PROCESSLIST",
  mariadb: "SHOW FULL PROCESSLIST",
  postgres:
    "SELECT pid, usename, client_addr::text, datname, state, " +
    "EXTRACT(EPOCH FROM (now() - query_start))::int AS sec, query " +
    "FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND state IS NOT NULL ORDER BY query_start NULLS LAST",
  // 使用者工作階段（排除自己）：執行中的請求排前面、跑最久的在上；blocked_by 看誰卡住誰。
  mssql:
    "SELECT s.session_id, s.login_name, s.host_name, DB_NAME(COALESCE(r.database_id, s.database_id)) AS db, " +
    "COALESCE(r.status, s.status) AS status, r.command, r.wait_type, r.blocking_session_id AS blocked_by, " +
    "DATEDIFF(SECOND, COALESCE(r.start_time, s.last_request_start_time), SYSDATETIME()) AS sec, st.text AS query " +
    "FROM sys.dm_exec_sessions s LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id " +
    "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) st " +
    "WHERE s.is_user_process = 1 AND s.session_id <> @@SPID " +
    "ORDER BY CASE WHEN r.session_id IS NULL THEN 1 ELSE 0 END, sec DESC",
  // 需要能讀 V$SESSION / V$SQL（SELECT_CATALOG_ROLE）。前兩欄 sid、serial 是終止時要的識別。
  oracle:
    "SELECT s.sid, s.serial# AS serial, s.username, s.machine, s.program, s.status, s.event, " +
    "s.last_call_et AS sec, q.sql_text AS query FROM v$session s " +
    "LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = s.sql_child_number " +
    "WHERE s.type = 'USER' AND s.sid <> TO_NUMBER(SYS_CONTEXT('USERENV', 'SID')) " +
    "ORDER BY s.status, s.last_call_et DESC",
};

/** 這些種類能「只取消目前查詢、保留連線」；SQL Server 只能 KILL 整個工作階段。 */
export const CAN_CANCEL_QUERY: Partial<Record<DbKind, true>> = { mysql: true, mariadb: true, postgres: true, oracle: true };

/** 終止 / 取消用的語句；工作階段識別不合法（非純數字）時回 null（防注入）。 */
export function killSql(kind: DbKind, row: (string | null)[], queryOnly: boolean): { id: string; sql: string } | null {
  const id = (row[0] ?? "").trim();
  if (!/^\d+$/.test(id)) return null;
  if (kind === "postgres") return { id, sql: `SELECT pg_${queryOnly ? "cancel" : "terminate"}_backend(${id})` };
  if (kind === "mssql") return { id, sql: `KILL ${id}` };
  if (kind === "oracle") {
    const serial = (row[1] ?? "").trim();
    if (!/^\d+$/.test(serial)) return null;
    return {
      id: `${id},${serial}`,
      sql: queryOnly ? `ALTER SYSTEM CANCEL SQL '${id}, ${serial}'` : `ALTER SYSTEM KILL SESSION '${id},${serial}' IMMEDIATE`,
    };
  }
  return { id, sql: `KILL ${queryOnly ? "QUERY " : ""}${id}` };
}
