# Connection Lifecycle and Resource Release

[繁體中文](./connection-lifecycle.md) · **English**

Releasing connections is the part of a database tool most prone to problems. Each database differs in its connection pool mechanism, idle reclamation, and shutdown cleanup, so they need to be managed uniformly to avoid connection leaks and sessions being held open on the database side.

## Connection pool settings

| Database | Connection pool | Key parameters |
|--------|--------|----------|
| MySQL / PostgreSQL | Built into sqlx | max_connections, min_connections, idle_timeout, max_lifetime |
| SQLite | Built into sqlx | max_connections (file-based, usually smaller) |
| MongoDB | Built into the driver | maxPoolSize, maxIdleTime (planned) |
| Redis | deadpool-redis / multiplexed | pool size, idle reclamation (planned) |

The sqlx-based drivers are currently configured with `idle_timeout = 300s`, `max_lifetime = 1800s`, `acquire_timeout = 10s`, and `test_before_acquire = true`.

## Idle reclamation and health checks

- Every connection has an idle timeout; once it has been idle too long it is automatically returned or closed, so it doesn't hold a session on the database side.
- `test_before_acquire` runs a health check before a connection is handed out, weeding out zombie connections (the DB side has disconnected but the client still holds the connection).
- Ping implementation: MySQL/PG/SQLite use `SELECT 1`, Redis uses `PING`, and MongoDB uses the ping command.

## Graceful cleanup on application shutdown (the most often overlooked)

`lib.rs` drains every connection pool at two points:

1. `WindowEvent::CloseRequested` — when the window is closed.
2. `RunEvent::Exit` — when the process exits (as a safety net).

`ConnectionManager::close_all()` drains the pools of all drivers. Combined with Rust's RAII / Drop, resources are released even on panic.

## SSH tunnel lifecycle coupling (planned)

- A tunnel's lifecycle is bound to the database connections it carries.
- Shutdown order: close the DB connections first → then close the tunnel → finally exit the process; otherwise connections get stuck half-open.

## Safeguards and protection mechanisms

- Query timeout (statement timeout), so a single slow query can't hold a connection for a long time.
- A cap on the number of connections; when the cap is reached, requests are queued or rejected.
- `pool_status` reports size / idle / in_use for monitoring in the UI.
