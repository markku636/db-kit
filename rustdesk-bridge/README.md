# dbk-rustdesk-bridge

db-kit 的 RustDesk 相容連線輔助程式。

## 為什麼是獨立的程式

RustDesk 的協定定義（`protos/message.proto`）與連線邏輯以 **AGPL-3.0** 授權；db-kit 本體是 **MIT**。
為了讓 db-kit 維持 MIT，所有取自 RustDesk 的東西都放在這個獨立的執行檔裡，並以 AGPL-3.0 發行
（授權全文見 `LICENSE`，原始碼即本資料夾）。db-kit 只把它當成子程序啟動、透過 stdin / stdout
交換訊息，兩者之間沒有程式碼連結。

「RustDesk」是 RustDesk 專案的名稱；這個程式是與其相容的第三方實作，不是官方用戶端。

## 取自 RustDesk 的部分

| 檔案 | 來源 |
|---|---|
| `protos/message.proto` | `rustdesk/rustdesk` 的 `libs/base/protos/message.proto`（原樣） |
| `protos/rendezvous.proto` | `rustdesk/hbb_common` 的 `protos/rendezvous.proto`（原樣） |
| `src/codec.rs` | `rustdesk/hbb_common` 的 `src/bytes_codec.rs`（封包長度標頭的編解碼） |
| `src/session.rs` 的登入流程 | `rustdesk/rustdesk` 的 `src/client.rs`（`handle_hash` 的密碼雜湊、`create_login_msg`）與 `src/client/io_loop.rs` |
| `src/rendezvous.rs` | `rustdesk/rustdesk` 的 `src/client.rs`（`_start_inner`、`connect`、`request_relay`、`create_relay`）；位址編碼取自 `hbb_common` 的 `AddrMangle` |
| `src/crypto.rs`、`main.rs` 的 `secure_handshake` | `rustdesk/rustdesk` 的 `src/common.rs`（`create_symmetric_key_msg`、`decode_id_pk`）、`src/client.rs`（`secure_connection`）與 `hbb_common` 的 `src/tcp.rs`（`Encrypt`）；原本用 libsodium，這裡換成同演算法的純 Rust 實作 |

## 目前支援

- **用 RustDesk ID 連線**：經 ID 伺服器（hbbs，預設公開伺服器，或自架的 + Key）找到對方，先試 TCP 打洞直連，
  不行就經中繼伺服器（hbbr）。ID 伺服器簽過名的對方公鑰驗得過時，跟對方做金鑰交換（crypto_box 封 secretbox 金鑰），
  之後每個封包都加密；驗不過（沒填 Key、Key 不對）就跟官方用戶端一樣退回不加密。
- **Direct IP**：直接連對方電腦的 21118 埠（對方要在 RustDesk 設定裡開啟「允許 IP 直接存取」）。
  這個模式跟 RustDesk 官方用戶端一樣**不加密**（沒有 ID 伺服器可以驗證對方的金鑰），適合區網或搭配 SSH 轉接。
- 密碼登入（`sha256(sha256(密碼 + salt) + challenge)`）；不帶密碼時由對方在畫面上按「接受」。
- 影像：只協商 VP9 / VP8 / AV1，**不解碼**，把編碼後的畫面原封不動交給 db-kit，由 WebView 的 WebCodecs 解碼
  （所以不需要 libvpx / aom / ffmpeg 這些 C 函式庫）。
- 滑鼠、鍵盤（`KeyboardMode::Map`：db-kit 送 PC 掃描碼，依對方系統換成 Windows / Linux / macOS / Android 的鍵碼，
  對照表來自 rdev；每個按鍵帶本機 CapsLock / NumLock 狀態、滑鼠帶按著的修飾鍵，跟官方用戶端一樣）、Ctrl+Alt+Del、要求重送畫面。
- 多螢幕：切到對方的某個螢幕（`SwitchDisplay` + `CaptureDisplays`），或所有螢幕一起送（每張畫面帶螢幕編號，由 db-kit
  照排列拼成一張）；對方插拔螢幕 / 換解析度時把新的清單 / 位置大小轉給 db-kit。
- 工具列：畫質、偏好的編碼、封鎖對方輸入 / 停用剪貼簿 / 結束後鎖定（`OptionMessage`）、鎖定畫面、重新啟動對方、
  把文字打過去（`KeyEvent.seq`）、聊天、告知對方正在錄影；對方的權限、訊息框、量到的延遲轉給 db-kit。
- 剪貼簿（文字）：雙向；對方送來的 zstd 壓縮內容用純 Rust 的解碼器（ruzstd）解開。
- 檔案傳輸（`connect` 帶 `file_transfer: true` 的另一條連線，對方不送畫面）：列目錄、建資料夾、刪檔 / 刪空資料夾、
  改名（同一層）、列整棵檔案、單一檔案的上傳 / 下載（本機檔案由輔助程式直接讀寫，下載先寫 `.part` 完成才改名；
  對方送來的 zstd 壓縮區塊會解開）。整個資料夾的傳輸由 db-kit 展開成一個一個檔案。

尚未支援：UDP / IPv6 打洞（TCP 打洞不通就走中繼）、登入帳號（token）、剪貼簿裡的圖片與檔案、音訊、傳檔的斷點續傳。

## 與 db-kit 的訊息格式（stdin / stdout）

每則訊息：`[u32 長度（little-endian，不含這 4 bytes）][u8 型別][內容]`。

| 方向 | 型別 | 內容 |
|---|---|---|
| db-kit → bridge | 1 | JSON 指令：`connect`（有 `rendezvous: { server, relay, key, force_relay }` = 用 `peer` 這個 ID 經 ID 伺服器連；`hwid`（base64）= 本機識別碼，`trusted: true` = 之前對這台勾過「信任這台裝置」，登入就帶 hwid）/ `login`（`password`：`waiting_accept` 期間補上密碼，用同一個登入挑戰重送登入）/ `2fa`（`code`：`need_2fa` 之後送雙重驗證碼；`trust: true` = 請對方信任這台裝置，`Auth2FA` 帶 hwid）/ `mouse`（`mask` / `x` / `y`，按著的修飾鍵 `alt` / `ctrl` / `shift` / `meta`）/ `key`（`down` / `scancode`，本機鎖定鍵 `caps` / `num`）/ `ctrl_alt_del` / `refresh` / `displays`（`set`：要看的螢幕索引，一個 = 切到那個螢幕、多個 = 同時看）/ `quality`（`level`：`best` / `balanced` / `low`）/ `codec`（`prefer`：`auto` / `vp9` / `vp8` / `av1`，加上 `vp9` / `vp8` / `av1` 能不能解）/ `toggle`（`name`：`block_input` / `disable_clipboard` / `lock_after_session_end`，`on`）/ `lock_screen` / `restart` / `clipboard`（`text`）/ `type_text`（`text`）/ `chat`（`text`）/ `record`（`on`）/ `char`（`text`：翻譯模式的字）/ `os_password`（`text`：打完按 Enter）。傳檔連線：`fs_ls`（`req`、`path`，空 = 家目錄）/ `fs_all` / `fs_mkdir` / `fs_rm` / `fs_rmdir` / `fs_rename`（`new_name`）/ `fs_download`（`remote`、`local`）/ `fs_upload`（`local`、`remote`）/ `fs_cancel`；結果是事件 `fs_dir` / `fs_done` / `fs_err`，傳輸中 `fs_progress`（`done` / `total`），都帶 `req` |
| bridge → db-kit | 1 | JSON 事件：`connected`（帶 `secure`、`route` = `ip` / `direct` / `lan` / `relay`）/ `waiting_accept`（沒給密碼：已送空密碼的登入，等對方在畫面上按接受；`click_only: true` = 對方回 `No Password Access`，只能按接受、密碼沒用，連線還在）/ `need_2fa`（對方開了雙重驗證，連線還在、等驗證碼；`wrong: true` = 上一個驗證碼錯了；`trust: true` = 對方允許信任這台裝置）/ `login_error` / `error`（帶 `code`，如 `id_not_exist` / `offline` / `key_mismatch`）/ `closed` / `displays`（對方的螢幕清單變了）/ `switch_display`（`display`、`x`、`y`、`width`、`height`：切過去的螢幕、或換了解析度的螢幕）/ `permission`（`name`、`enabled`：對方開關某個權限，一開始只送被關掉的）/ `clipboard`（`text`）/ `chat`（`text`）/ `block_input`（`on`、`ok`）/ `msgbox`（`msgtype`、`title`、`text`）/ `delay`（`ms`、`bitrate`） |
| bridge → db-kit | 2 | 影像：`[u8 codec][u8 key][u8 display][u8 保留][i64 pts]` + 編碼後的資料 |

stdin 關閉（db-kit 結束或斷線）時程式自己結束。密碼只經 stdin 傳，不放在命令列（命令列別的程式看得到）。

## 建置

```
cargo build --release
```

db-kit 打包時把產出的執行檔放到 `src-tauri/binaries/dbk-rustdesk-bridge-<target-triple>[.exe]`（Tauri 的 `externalBin`）。
