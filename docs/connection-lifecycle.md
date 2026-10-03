# 連線生命週期與資源釋放

**繁體中文** · [English](./connection-lifecycle.en.md)

連線釋放是資料庫工具最容易出問題的環節。各資料庫的連線池機制、閒置回收與關閉清理皆不同，需統一管理以避免連線洩漏與 DB 端 session 占用。

## 連線池設定

| 資料庫 | 連線池 | 關鍵參數 |
|--------|--------|----------|
| MySQL / PostgreSQL | sqlx 內建 | max_connections, min_connections, idle_timeout, max_lifetime |
| SQLite | sqlx 內建 | max_connections（檔案型，通常較小） |
| MongoDB | driver 內建 | maxPoolSize, maxIdleTime（規劃中） |
| Redis | deadpool-redis / multiplexed | pool size, idle 回收（規劃中） |

目前 sqlx 系列已設定：`idle_timeout = 300s`、`max_lifetime = 1800s`、`acquire_timeout = 10s`、`test_before_acquire = true`。

## 閒置回收與健康檢查

- 每個連線設定 idle timeout，閒置超時自動歸還或關閉，避免占用資料庫端 session。
- `test_before_acquire` 在取得連線前做健康檢查，淘汰殭屍連線（DB 端已斷但 client 仍持有）。
- ping 實作：MySQL/PG/SQLite 用 `SELECT 1`、Redis 用 `PING`、MongoDB 用 ping command。

## 應用關閉時的優雅清理（最常被忽略）

`lib.rs` 中於兩個時機 drain 全部連線池：

1. `WindowEvent::CloseRequested` — 視窗關閉時。
2. `RunEvent::Exit` — 程序退出時（保險）。

`ConnectionManager::close_all()` 會 drain 所有 driver 的 pool。配合 Rust 的 RAII / Drop，即使 panic 也能釋放。

## SSH Tunnel 生命週期連動（規劃中）

- Tunnel 與其承載的資料庫連線綁定生命週期。
- 關閉順序：先關 DB 連線 → 再關 tunnel → 最後結束程序，否則連線會卡在半開狀態。

## 防呆與保護機制

- 查詢逾時（statement timeout），避免單一慢查詢長期占用連線。
- 連線數上限保護，達上限時排隊或拒絕。
- `pool_status` 回報 size / idle / in_use，供 UI 監控。
