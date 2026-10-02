//! 繁中原文 → 英文對照表。
//!
//! - key 為 `t!` / `tf!` 傳入的**繁中原字面值**（含 `{name}` 佔位符），查無回 `None`（identity fallback）。
//! - clap 的 `about` / 參數說明字面值（`src/cli/args.rs`）也收錄於此，供 dbk `--help` 執行期覆寫。
//! - 新增使用者可見字串時，於對應分類補一行即可；不需維護排序。
#![allow(clippy::match_same_arms)]

/// 查表：找到回英文，否則 `None`（由 `i18n::lookup` 做 identity fallback）。
pub fn lookup(zh: &str) -> Option<&'static str> {
    Some(match zh {
        // ---- error.rs：AppError 外層包裝（序列化時產生）----
        "找不到連線：{detail}" => "Connection not found: {detail}",
        "連線失敗：{detail}" => "Connection failed: {detail}",
        "查詢失敗：{detail}" => "Query failed: {detail}",
        "不支援的資料庫種類：{detail}" => "Unsupported database kind: {detail}",
        "連線池已耗盡或關閉" => "The connection pool is exhausted or closed",
        "儲存錯誤：{detail}" => "Storage error: {detail}",
        "SSH 通道錯誤：{detail}" => "SSH tunnel error: {detail}",
        "查詢逾時（{ms} ms）；伺服器端查詢可能仍在執行，可從行程清單手動終止" => {
            "Query timed out after {ms} ms; the server-side query may still be running and can be terminated manually from the process list"
        }

        // ---- store.rs：設定 / keychain ----
        "無法取得使用者設定目錄" => "Unable to determine the user config directory",
        "無法取得設定目錄：{e}" => "Unable to determine the config directory: {e}",
        "建立設定目錄失敗：{e}" => "Failed to create the config directory: {e}",
        "讀取連線設定失敗：{e}" => "Failed to read connection settings: {e}",
        "序列化連線設定失敗：{e}" => "Failed to serialize connection settings: {e}",
        "寫入連線設定失敗：{e}" => "Failed to write connection settings: {e}",
        "更新連線設定失敗：{e}" => "Failed to update connection settings: {e}",
        "解析 {file} 失敗：{e}" => "Failed to parse {file}: {e}",
        "讀取 {file} 失敗：{e}" => "Failed to read {file}: {e}",
        "序列化 {file} 失敗：{e}" => "Failed to serialize {file}: {e}",
        "寫入 {file} 失敗：{e}" => "Failed to write {file}: {e}",
        "更新 {file} 失敗：{e}" => "Failed to update {file}: {e}",
        "keychain 開啟失敗：{e}" => "Failed to open the keychain: {e}",
        "keychain 寫入失敗：{e}" => "Failed to write to the keychain: {e}",

        // ---- commands/mod.rs ----
        "salt 產生失敗：{e}" => "Failed to generate salt: {e}",
        "密碼雜湊失敗：{e}" => "Failed to hash the password: {e}",
        "密碼不可為空" => "Password must not be empty",
        "目前密碼不正確" => "Current password is incorrect",
        // 啟動鎖定：生物辨識（Windows Hello / Touch ID）。第一句會出現在 OS 的驗證對話框上。
        "驗證以解鎖 DB Kit" => "Verify to unlock DB Kit",
        "此裝置無法使用生物辨識" => "Biometrics are not available on this device",
        "驗證未通過，尚未啟用生物辨識解鎖" => {
            "Verification failed; biometric unlock was not enabled"
        }
        "驗證未通過；若已設定啟動密碼，可改以密碼關閉" => {
            "Verification failed; if a startup password is set, you can turn this off with the password instead"
        }
        "驗證執行緒異常結束：{e}" => "The verification thread ended unexpectedly: {e}",
        // ---- biometric.rs ----
        "無法取得 Windows Hello 狀態：{e}" => "Could not read Windows Hello status: {e}",
        "無法建立驗證介面：{e}" => "Could not create the verification interface: {e}",
        "無法顯示驗證提示：{e}" => "Could not show the verification prompt: {e}",
        "驗證過程發生錯誤：{e}" => "The verification failed with an error: {e}",
        "請提供 passphrase" => "A passphrase is required",
        "序列化失敗：{e}" => "Serialization failed: {e}",
        "寫入失敗：{e}" => "Write failed: {e}",
        "讀取失敗：{e}" => "Read failed: {e}",
        "解密成功但內容格式不符（檔案可能來自不同版本）" => {
            "Decryption succeeded but the contents are malformed (the file may be from a different version)"
        }
        "檔案過大（上限 8 MiB）" => "File is too large (8 MiB limit)",
        "檔案過大（約 {mb} MB），CSV 匯入上限 100 MB；請先分割檔案" => {
            "File is too large (~{mb} MB); the CSV import limit is 100 MB. Please split the file first"
        }
        "檔案非 UTF-8 編碼；請在試算表以「另存新檔 → CSV UTF-8」重新匯出後再試" => {
            "The file is not UTF-8 encoded. Re-export it from your spreadsheet as \"Save As -> CSV UTF-8\" and try again"
        }
        "讀取檔案失敗：{e}" => "Failed to read the file: {e}",
        "檔案過大（約 {mb} MB），Excel 匯入上限 100 MB" => {
            "File is too large (~{mb} MB); the Excel import limit is 100 MB"
        }
        "{id2}: subscribe {c} 失敗：{e}" => "{id2}: subscribe {c} failed: {e}",
        "{id2}: psubscribe {p} 失敗：{e}" => "{id2}: psubscribe {p} failed: {e}",
        "此筆為失敗紀錄，無法還原" => "This entry is a failed backup and cannot be restored",

        // ---- db/conn_url/：連線字串解析（GUI parse_connection_url / CLI --url 共用）----
        "無法解析連線字串" => "Unable to parse the connection string",
        "不支援的連線字串格式：{scheme}" => "Unsupported connection string format: {scheme}",

        // ---- CLI 執行期輸出（cli/*.rs）----
        "連線成功" => "Connected successfully",
        "已備份：{path}（{bytes} bytes，方式 {method}）" => "Backed up: {path} ({bytes} bytes, method {method})",
        "(無欄位；{n} 列受影響)" => "(no columns; {n} rows affected)",
        "(結果已截斷於 {cap} 列；用 --max-rows 0 取完整結果)" => {
            "(results truncated at {cap} rows; use --max-rows 0 for the full result)"
        }
        "資料表：{tables}　關係：{relations}" => "Tables: {tables}   Relations: {relations}",
        "(第 {page} 頁，每頁 {page_size}，共 {total} 列)" => "(page {page}, {page_size} per page, {total} rows total)",
        "(已達上限 {limit}，可能仍有更多鍵)" => "(reached the limit of {limit}; there may be more keys)",
        "(鍵不存在)" => "(key does not exist)",
        "已匯出 {rows} 列到 {path}（{bytes} bytes，{format} 格式）" => {
            "Exported {rows} rows to {path} ({bytes} bytes, {format} format)"
        }
        "請提供 --passphrase" => "--passphrase is required",
        "已加密匯出 {count} 筆連線到 {path}" => "Encrypted and exported {count} connections to {path}",
        "其中 {n} 筆是 PROD 連線，一律不含帳號與密碼" => {
            "{n} of them are PROD connections and never carry a username or password"
        }
        "沒有可匯出的連線" => "There are no connections to export",
        "含 {n} 個側欄群組" => "Including {n} sidebar groups",
        "含 {ssh} 台 SSH 主機、{rd} 台遠端桌面" => "Including {ssh} SSH hosts and {rd} remote desktops",
        "篩選格式錯誤（應為 col:op[:value]）：{spec}" => "Invalid filter format (expected col:op[:value]): {spec}",
        "不支援的篩選運算子：{op}" => "Unsupported filter operator: {op}",
        "排序格式錯誤（應為 col:asc|desc）：{spec}" => "Invalid sort format (expected col:asc|desc): {spec}",
        "排序方向需為 asc/desc：{other}" => "Sort direction must be asc/desc: {other}",
        "(空結果)" => "(empty result)",
        "({n} 列)" => "({n} rows)",
        "json 序列化失敗：{e}" => "JSON serialization failed: {e}",
        "CLI 為唯讀模式，僅允許查詢語句（偵測到 `{kw}`）" => {
            "The CLI is read-only; only query statements are allowed (detected `{kw}`)"
        }
        "CLI 為唯讀模式，偵測到可寫 CTE（含 `{w}`）" => {
            "The CLI is read-only; a writable CTE was detected (contains `{w}`)"
        }
        "CLI 不支援外部 gateway（External）連線" => "The CLI does not support external gateway (External) connections",
        "請以 --conn <名稱> 指定已存連線，或以 --kind / --url 指定臨時連線" => {
            "Specify a saved connection with --conn <name>, or an ad-hoc connection with --kind / --url"
        }
        "無法判斷連線種類（請加 --kind 或於 --url 指定 scheme）" => {
            "Cannot determine the connection kind (add --kind or specify a scheme in --url)"
        }

        "CLI 不支援 Kafka 連線（請用 GUI）" => "The CLI does not support Kafka connections (use the GUI)",
        "CLI 不支援 RabbitMQ 連線（請用 GUI）" => "The CLI does not support RabbitMQ connections (use the GUI)",
        "CLI 不支援容器 / 映像倉庫連線（請用 GUI）" => {
            "The CLI does not support container / image registry connections (use the GUI)"
        }

        // ---- db/k8s、commands/k8s.rs：Kubernetes ----
        "CronJob 沒有 jobTemplate" => "The CronJob has no jobTemplate",
        "Kubernetes 連線不支援此操作（請從連線樹開啟資源）" => "Kubernetes connections don't support this operation (open resources from the connection tree)",
        "Pod「{pod}」沒有名為「{p}」的容器埠" => "Pod \"{pod}\" has no container port named \"{p}\"",
        "Service「{name}」沒有 selector，無法找到後端 Pod" => "Service \"{name}\" has no selector, so its backend pods can't be found",
        "Service「{name}」沒有埠 {port}" => "Service \"{name}\" has no port {port}",
        "WebSocket 交握失敗：伺服器回應的 Sec-WebSocket-Accept 不正確" => "WebSocket handshake failed: the server's Sec-WebSocket-Accept is wrong",
        "API server 不支援串流子協定 {p}（回應：{got}）；叢集版本可能太舊" => "The API server doesn't support the streaming subprotocol {p} (got: {got}); the cluster may be too old",
        "YAML 格式不正確：{e}" => "Invalid YAML: {e}",
        "YAML 裡沒有任何資源" => "The YAML contains no resources",
        "cluster「{c}」沒有設定 server" => "Cluster \"{c}\" has no server",
        "context「{ctx}」指向的 cluster「{c}」不存在" => "Context \"{ctx}\" refers to cluster \"{c}\", which doesn't exist",
        "exec plugin 沒有回傳 token 或用戶端憑證" => "The exec plugin returned neither a token nor a client certificate",
        "exec plugin 的輸出不是 ExecCredential JSON：{e}" => "The exec plugin's output isn't ExecCredential JSON: {e}",
        "kubeconfig 格式不正確：{e}" => "Invalid kubeconfig: {e}",
        "kubeconfig 沒有設定 current-context，請在連線設定選擇 context" => "The kubeconfig has no current-context; pick a context in the connection settings",
        "kubeconfig 裡找不到 context「{name}」" => "Context \"{name}\" isn't in the kubeconfig",
        "port-forward 指定的連線不是 Kubernetes 連線" => "The connection chosen for port-forward isn't a Kubernetes connection",
        "proxy-url 不正確：{e}" => "Invalid proxy-url: {e}",
        "{what} 不是有效的 base64：{e}" => "{what} isn't valid base64: {e}",
        "「{name}」目前沒有執行中的 Pod" => "\"{name}\" has no running pods",
        "不支援的轉發目標種類：{k}（可用 pod / svc / deploy / sts）" => "Unsupported forward target type: {k} (use pod / svc / deploy / sts)",
        "叢集不認得 {av} {kind}（CRD 尚未安裝？）" => "The cluster doesn't know {av} {kind} (is the CRD installed?)",
        "同時開啟的 Kubernetes 串流太多，請先關閉一些 log / 終端分頁" => "Too many Kubernetes streams are open; close some log / terminal tabs first",
        "找不到 kubeconfig（{paths}）" => "kubeconfig not found ({paths})",
        "找不到這個連線指定的 Kubernetes 連線（可能已被刪除）" => "The Kubernetes connection this connection uses can't be found (it may have been deleted)",
        "本機埠 {port} 無法監聽：{e}" => "Can't listen on local port {port}: {e}",
        "無法執行認證指令「{cmd}」：{e}" => "Can't run the credential command \"{cmd}\": {e}",
        "認證指令執行失敗：{e}" => "The credential command failed: {e}",
        "認證指令「{cmd}」失敗（{status}）：{err}" => "The credential command \"{cmd}\" failed ({status}): {err}",
        "認證指令「{cmd}」超過 {s} 秒沒有結束（是否在等待登入？）" => "The credential command \"{cmd}\" didn't finish within {s} seconds (is it waiting for a sign-in?)",
        "找不到 kubeconfig 指定的認證指令「{cmd}」；請先安裝它並確認在 PATH 上{hint}" => "Can't find the credential command \"{cmd}\" from the kubeconfig; install it and make sure it's on PATH{hint}",
        "不支援 auth-provider「{name}」（kubectl 1.26 起已移除）；請改用 exec plugin（例如 gke-gcloud-auth-plugin、kubelogin）" => "auth-provider \"{name}\" isn't supported (removed in kubectl 1.26); use an exec plugin instead (for example gke-gcloud-auth-plugin or kubelogin)",
        "第 {n} 份文件不是物件" => "Document {n} isn't an object",
        "第 {n} 份文件的 YAML 格式不正確：{e}" => "Document {n} has invalid YAML: {e}",
        "終端機已關閉" => "The terminal is closed",
        "缺少 apiVersion / kind / metadata.name" => "Missing apiVersion / kind / metadata.name",
        "請填入 API server 網址（例如 https://10.0.0.1:6443）" => "Enter the API server URL (for example https://10.0.0.1:6443)",
        "請指定 port-forward 的目標（例如 svc/postgres）" => "Specify the port-forward target (for example svc/postgres)",
        "請指定 port-forward 的遠端埠" => "Specify the port-forward remote port",
        "讀取 kubeconfig 失敗（{path}）：{e}" => "Failed to read the kubeconfig ({path}): {e}",
        "讀取 tokenFile 失敗（{path}）：{e}" => "Failed to read tokenFile ({path}): {e}",
        "（認證失敗：token 過期或無效？）" => " (authentication failed: is the token expired or invalid?)",
        "{m}\n沒有列出 namespace 的權限：請在連線設定的「限定 namespace」填入可存取的 namespace" => "{m}\nNo permission to list namespaces: enter the namespaces you can access under \"Limit namespaces\" in the connection settings",
        "metadata.name 不能改（原本是「{name}」，YAML 裡是「{got}」）；要建立新資源請用「套用 YAML」" => "metadata.name can't change (it was \"{name}\", the YAML has \"{got}\"); use Apply YAML to create a new resource",
        "容器類連線不能經由 Kubernetes port-forward" => "Container connections can't go through Kubernetes port-forward",
        "此連線不是 Kubernetes" => "This connection isn't Kubernetes",

        // ---- db/http_tls.rs、db/docker、db/registry、db/harbor：容器與映像 ----
        "CA 憑證" => "CA certificate",
        "用戶端憑證" => "client certificate",
        "用戶端私鑰" => "client key",
        "讀取{what}失敗（{path}）：{e}" => "Failed to read the {what} ({path}): {e}",
        "CA 憑證格式不正確：{e}" => "The CA certificate is not valid: {e}",
        "CA 憑證檔裡沒有任何憑證" => "The CA certificate file contains no certificates",
        "用戶端憑證或私鑰格式不正確：{e}" => "The client certificate or key is not valid: {e}",
        "已指定用戶端憑證，但缺少私鑰" => "A client certificate was given but the key is missing",
        "已指定用戶端私鑰，但缺少憑證" => "A client key was given but the certificate is missing",
        "此作業系統不支援 unix socket；Windows 請用 npipe:// 或 TCP" => {
            "Unix sockets are not supported on this OS; on Windows use npipe:// or TCP"
        }
        "named pipe 只在 Windows 可用；請改用 unix:// 或 TCP" => "Named pipes are only available on Windows; use unix:// or TCP",
        "（Docker daemon 是否在執行？Docker Desktop 需先啟動）" => " (Is the Docker daemon running? Docker Desktop must be started first)",
        "不支援的清理目標：{t}" => "Unsupported cleanup target: {t}",
        "不支援的容器操作：{a}" => "Unsupported container action: {a}",
        "Docker 沒有回傳 exec id" => "Docker did not return an exec ID",
        "Docker 未切換成互動串流（HTTP {code}）" => "Docker did not switch to an interactive stream (HTTP {code})",
        "同時開啟的 Docker 串流太多，請先關閉一些 log / 終端分頁" => {
            "Too many Docker streams are open; close some log / terminal tabs first"
        }
        "Docker 連線不支援此操作（請從連線樹開啟容器 / 映像）" => {
            "Docker connections do not support this operation (open a container / image from the connection tree)"
        }
        "本機 socket / named pipe 型的 Docker 連線不能走 SSH 通道；請改用 TCP（daemon 需監聽 TCP 埠）" => {
            "Docker connections over a local socket / named pipe cannot use an SSH tunnel; use TCP instead (the daemon must listen on a TCP port)"
        }
        "此連線不是容器 / 映像倉庫連線" => "This connection is not a container / image registry connection",
        "此連線不是 Docker" => "This connection is not a Docker connection",
        "此連線不是 Registry" => "This connection is not a registry connection",
        "此連線不是 Harbor" => "This connection is not a Harbor connection",
        "此版本未編入容器 / 映像倉庫支援（請以 --features docker 建置）" => {
            "This build does not include container / image registry support (build with --features docker)"
        }
        "容器 / 映像倉庫連線不支援備份" => "Container / image registry connections do not support backup",
        "容器 / 映像倉庫連線不支援還原" => "Container / image registry connections do not support restore",
        "此類連線不支援資料傳輸" => "This kind of connection does not support data transfer",
        "此 registry 需要帳號密碼（Basic 認證）" => "This registry requires a username and password (Basic auth)",
        "向 token 服務換發權杖失敗（HTTP {code}）：{body}" => "Failed to get a token from the token service (HTTP {code}): {body}",
        "token 服務沒有回傳權杖" => "The token service did not return a token",
        "registry 沒有回傳 digest，無法依 tag 刪除" => "The registry did not return a digest, so the tag cannot be deleted",
        "此 registry 未啟用刪除（registry:2 需設 REGISTRY_STORAGE_DELETE_ENABLED=true）" => {
            "Deletion is not enabled on this registry (registry:2 needs REGISTRY_STORAGE_DELETE_ENABLED=true)"
        }
        "此 registry 不開放 repository 清單（_catalog）：{m}\n請在連線設定的「Repository 清單」填入要瀏覽的 repository" => {
            "This registry does not list its repositories (_catalog): {m}\nFill in the repositories to browse under “Repository list” in the connection settings"
        }
        "Registry 連線不支援此操作（請從連線樹開啟 tag）" => {
            "Registry connections do not support this operation (open a tag from the connection tree)"
        }
        "Harbor 帳號或密碼錯誤：{m}" => "Wrong Harbor username or password: {m}",
        "Harbor 連線不支援此操作（請從連線樹開啟 repository）" => {
            "Harbor connections do not support this operation (open a repository from the connection tree)"
        }

        // ---- cli/guard.rs、cli/dispatch.rs：寫入確認與寫入結果 ----
        "此為寫入指令，未執行：{action}。確認無誤請加 --yes{extra}" => {
            "This is a write command and was not executed: {action}. Add --yes{extra} once you have checked it"
        }
        "此為高破壞動作，未執行：{action}。請再加 --force 確認" => {
            "This is a highly destructive action and was not executed: {action}. Add --force as well to confirm"
        }
        "執行：{sql}" => "Execute: {sql}",
        "完成（{n} 列受影響）" => "Done ({n} rows affected)",
        "新增{noun}「{name}」" => "Create {noun} \"{name}\"",
        "已新增{noun}「{name}」" => "Created {noun} \"{name}\"",
        "刪除{noun}「{name}」（含其所有物件）" => "Drop {noun} \"{name}\" (including all objects in it)",
        "已刪除{noun}「{name}」" => "Dropped {noun} \"{name}\"",
        "刪除{noun}「{table}」" => "Drop {noun} \"{table}\"",
        "已刪除{noun}「{table}」" => "Dropped {noun} \"{table}\"",
        "清空資料表「{table}」的所有資料列" => "Delete all rows in table \"{table}\"",
        "已清空「{table}」（{n} 列）" => "Emptied \"{table}\" ({n} rows)",
        "Mongo 不支援 truncate（請用 dbk table drop 刪除集合，或以 query 帶明確 filter 刪除）" => {
            "Mongo does not support truncate (use `dbk table drop` to drop the collection, or delete with an explicit filter)"
        }
        "設定鍵「{key}」的值" => "Set the value of key \"{key}\"",
        "--ttl 需為正整數秒數（0 或負數在 Redis 等同立刻刪除該鍵；不設 TTL 請省略此旗標）" => {
            "--ttl must be a positive number of seconds (0 or negative deletes the key immediately in Redis; omit the flag for no TTL)"
        }
        "秒數需為正整數（0 或負數在 Redis 等同立刻刪除該鍵；要改為永不過期請用 dbk redis persist）" => {
            "Seconds must be positive (0 or negative deletes the key immediately in Redis; use `dbk redis persist` to remove the expiry)"
        }
        "前綴不可為空（要清空整個 DB 請用 dbk redis flush-db）" => {
            "The prefix cannot be empty (use `dbk redis flush-db` to clear the whole DB)"
        }
        "已設定鍵「{key}」（TTL {s} 秒）" => "Set key \"{key}\" (TTL {s}s)",
        "已設定鍵「{key}」" => "Set key \"{key}\"",
        "刪除 {n} 個鍵" => "Delete {n} keys",
        "已刪除 {n} 個鍵" => "Deleted {n} keys",
        "(掃描已達上限 {limit}；請縮小前綴或調高 --limit 後再執行)" => {
            "(the scan hit the {limit} cap; narrow the prefix or raise --limit before running)"
        }
        "刪除前綴「{prefix}」底下的 {n} 個鍵" => "Delete the {n} keys under prefix \"{prefix}\"",
        "設定鍵「{key}」存活 {seconds} 秒" => "Set key \"{key}\" to expire in {seconds}s",
        "已設定 TTL：{key}" => "TTL set: {key}",
        "移除鍵「{key}」的存活時間" => "Remove the expiry of key \"{key}\"",
        "已改為永不過期：{key}" => "Now persistent: {key}",
        "(鍵不存在或本就無 TTL)" => "(the key does not exist or had no TTL)",
        "將鍵「{key}」改名為「{new_key}」" => "Rename key \"{key}\" to \"{new_key}\"",
        "已改名：{key} → {new_key}" => "Renamed: {key} -> {new_key}",
        "清空 DB {target} 的所有鍵（FLUSHDB）" => "Flush all keys in DB {target} (FLUSHDB)",
        "已清空 DB {target}" => "Flushed DB {target}",
        "資料表" => "table",
        "集合" => "collection",

        // ---- clap 說明（cli/args.rs：about / 參數 / 子指令）----
        "db-kit CLI — 查詢、匯出與寫入（重用 GUI 已存連線 / 臨時連線；寫入需 --yes）" => {
            "db-kit CLI — query, export and write (reuses GUI saved connections / ad-hoc connections; writes require --yes)"
        }
        "使用已存連線（名稱或 id；讀 GUI 的 connections.json + keychain）" => {
            "Use a saved connection (name or id; reads the GUI's connections.json + keychain)"
        }
        "臨時連線：資料庫種類" => "Ad-hoc connection: database kind",
        "臨時連線：主機（預設 127.0.0.1）" => "Ad-hoc connection: host (default 127.0.0.1)",
        "臨時連線：連接埠（預設依種類）" => "Ad-hoc connection: port (default depends on kind)",
        "臨時連線：帳號" => "Ad-hoc connection: username",
        "臨時連線：密碼（亦可用環境變數 DBKIT_PASSWORD，避免出現在 argv）" => {
            "Ad-hoc connection: password (can also use the DBKIT_PASSWORD env var to keep it out of argv)"
        }
        "臨時連線：連線字串 / DSN（如 mysql://user:pass@host:3306/db；sqlite 給檔案路徑）" => {
            "Ad-hoc connection: connection string / DSN (e.g. mysql://user:pass@host:3306/db; for sqlite give a file path)"
        }
        "預設資料庫 / schema（sqlite=檔案路徑、redis=db index）" => {
            "Default database / schema (sqlite = file path, redis = db index)"
        }
        "輸出格式" => "Output format",
        "介面語言（zh-TW | zh-CN | en | ja | ko | vi；亦可用環境變數 DBKIT_LANG）" => {
            "Interface language (zh-TW | zh-CN | en | ja | ko | vi; can also use the DBKIT_LANG env var)"
        }
        "確認執行寫入指令（修改 / 刪除）。未加時只印出將執行的動作並以錯誤結束（等同預演）" => {
            "Confirm a write command (modify / delete). Without it, the action is only printed and the command exits with an error (dry run)"
        }
        "額外確認高破壞動作（DROP / TRUNCATE / FLUSHDB / 無 WHERE 的 UPDATE·DELETE），需與 --yes 併用" => {
            "Extra confirmation for highly destructive actions (DROP / TRUNCATE / FLUSHDB / UPDATE·DELETE without WHERE); use together with --yes"
        }
        "執行寫入語句（INSERT / UPDATE / DELETE / DDL）。需 --yes；高破壞動作另需 --force" => {
            "Run a write statement (INSERT / UPDATE / DELETE / DDL). Requires --yes; destructive actions also require --force"
        }
        "新增資料庫 / schema（PostgreSQL 為 schema）。需 --yes" => {
            "Create a database / schema (schema on PostgreSQL). Requires --yes"
        }
        "刪除資料庫 / schema（含其所有物件，不可復原）。需 --yes --force" => {
            "Drop a database / schema and everything in it (irreversible). Requires --yes --force"
        }
        "刪除資料表 / 集合（DROP TABLE / dropCollection）。需 --yes --force" => {
            "Drop a table / collection (DROP TABLE / dropCollection). Requires --yes --force"
        }
        "清空資料表（TRUNCATE；Mongo 為刪除所有文件）。需 --yes --force" => {
            "Empty a table (TRUNCATE). Requires --yes --force"
        }
        "設定 string 鍵的值（SET；可同時設 TTL）。需 --yes" => {
            "Set the value of a string key (SET; can also set a TTL). Requires --yes"
        }
        "同時設定存活秒數（省略 = 不動既有 TTL）" => "Also set the TTL in seconds (omit to leave the existing TTL untouched)",
        "刪除鍵（DEL，可一次多個）。需 --yes" => "Delete keys (DEL; accepts several at once). Requires --yes",
        "依前綴批次刪除鍵（先 SCAN 出鍵名再 DEL；預設只預覽，加 --yes 才真刪）。需 --yes --force" => {
            "Delete keys by prefix (SCAN for key names, then DEL; previews only by default). Requires --yes --force"
        }
        "掃描鍵數上限（保護大型實例）" => "Maximum number of keys to scan (protects large instances)",
        "設定鍵的存活秒數（EXPIRE）。需 --yes" => "Set a key's TTL in seconds (EXPIRE). Requires --yes",
        "移除鍵的存活時間，使其永不過期（PERSIST）。需 --yes" => {
            "Remove a key's TTL so it never expires (PERSIST). Requires --yes"
        }
        "重新命名鍵（RENAME；目標已存在會被擋下）。需 --yes" => {
            "Rename a key (RENAME; blocked if the target already exists). Requires --yes"
        }
        "清空目前 DB 的所有鍵（FLUSHDB，不可復原）。需 --yes --force" => {
            "Flush every key in the current DB (FLUSHDB, irreversible). Requires --yes --force"
        }
        "連線管理（唯讀 + 加密匯出）" => "Connection management (read-only + encrypted export)",
        "列出資料庫 / schema" => "List databases / schemas",
        "資料表瀏覽" => "Browse tables",
        "執行查詢（唯讀；非查詢語句會被擋下）" => "Run a query (read-only; non-query statements are blocked)",
        "結果列數上限（0 = 不限；預設沿用全域 1000）。截斷時於 stderr 提示。" => {
            "Maximum result rows (0 = unlimited; defaults to the global 1000). A note is printed to stderr when truncated."
        }
        "查詢計畫（EXPLAIN）" => "Query plan (EXPLAIN)",
        "欄位統計（總數 / 非空 / 相異 / 範圍）" => "Column statistics (total / non-null / distinct / range)",
        "預存程序 / 函式 / 觸發器" => "Stored procedures / functions / triggers",
        "全資料庫物件搜尋" => "Search objects across the database",
        "匯出資料庫結構（所有表 DDL）" => "Export the database schema (DDL of all tables)",
        "匯出資料表資料（csv/tsv/json/sql/markdown）" => "Export table data (csv/tsv/json/sql/markdown)",
        "備份（dump → 檔案；唯讀產出，不還原）" => "Backup (dump to file; read-only output, no restore)",
        "ER 模型（表 + 外鍵關係）" => "ER model (tables + foreign key relations)",
        "伺服器資訊" => "Server info",
        "Redis 唯讀操作" => "Redis read-only operations",
        "Redis 操作（掃描 / 檢視 + 修改 / 刪除）" => "Redis operations (scan / inspect + modify / delete)",
        "列出已存連線" => "List saved connections",
        "測試連線（不保留）" => "Test the connection (not persisted)",
        "Ping（量測 RTT）" => "Ping (measure RTT)",
        "加密匯出所有已存連線（含密碼，需 passphrase）" => {
            "Encrypt and export all saved connections (includes passwords; requires a passphrase)"
        }
        "列出資料表 / 視圖 / 集合" => "List tables / views / collections",
        "欄位定義" => "Column definitions",
        "分頁讀取資料" => "Read data with pagination",
        "篩選 col:op[:value]（op: = != > >= < <= like is_null is_not_null），可重複" => {
            "Filter col:op[:value] (op: = != > >= < <= like is_null is_not_null); repeatable"
        }
        "排序 col:asc|desc，可重複" => "Sort col:asc|desc; repeatable",
        "多個篩選以 OR 連接（預設 AND）" => "Combine multiple filters with OR (default AND)",
        "資料表統計" => "Table statistics",
        "建表 DDL" => "CREATE TABLE DDL",
        "索引清單" => "Index list",
        "外鍵清單" => "Foreign key list",
        "列出預存程序 / 函式 / 觸發器" => "List stored procedures / functions / triggers",
        "取得單一 routine 的 DDL" => "Get the DDL of a single routine",
        "搜尋字串（子字串）" => "Search string (substring)",
        "限定資料庫 / schema（可重複；預設全部）" => "Restrict to databases / schemas (repeatable; default all)",
        "限定物件型別（可重複；如 table view procedure …）" => {
            "Restrict to object types (repeatable; e.g. table view procedure ...)"
        }
        "比對名稱（若三個比對範圍皆未指定，預設比對名稱）" => {
            "Match names (if none of the three match scopes is set, names are matched by default)"
        }
        "比對定義內文" => "Match definition bodies",
        "比對註解" => "Match comments",
        "區分大小寫" => "Case sensitive",
        "僅比對整個單字" => "Match whole words only",
        "啟用萬用字元 * 與 ?" => "Enable wildcards * and ?",
        "結果上限" => "Result limit",
        "輸出檔路徑" => "Output file path",
        "匯出格式：csv | tsv | xlsx | json | sql | markdown" => "Export format: csv | tsv | xlsx | json | sql | markdown",
        "不輸出表頭列" => "Do not output the header row",
        "CSV/TSV 自訂分隔字元" => "Custom delimiter for CSV/TSV",
        "NULL 在 CSV/TSV 的呈現（預設空字串）" => "How NULL is rendered in CSV/TSV (default empty string)",
        "檔首寫 UTF-8 BOM（方便 Excel）" => "Write a UTF-8 BOM at the start of the file (for Excel)",
        "篩選 col:op[:value]，可重複" => "Filter col:op[:value]; repeatable",
        "篩選以 OR 連接" => "Combine filters with OR",
        "要備份的資料庫名" => "Name of the database to back up",
        "掃描鍵名" => "Scan key names",
        "取得單一鍵的內容" => "Get the contents of a single key",
        "慢查詢日誌（SLOWLOG）" => "Slow query log (SLOWLOG)",
        "用戶端連線清單（CLIENT LIST）" => "Client connection list (CLIENT LIST)",
        "大鍵掃描（取樣 + MEMORY USAGE）" => "Big-key scan (sampling + MEMORY USAGE)",

        // ---- backup.rs ----
        "外部 gateway 連線不支援備份" => "External gateway connections do not support backup",
        "SQL Server 備份尚未支援（規劃以 sqlpackage 匯出 .bacpac）" => {
            "SQL Server backup is not supported yet (planned via sqlpackage export to .bacpac)"
        }
        "Oracle 備份尚未支援（規劃以 Data Pump expdp 匯出 .dmp）" => {
            "Oracle backup is not supported yet (planned via Data Pump expdp export to .dmp)"
        }
        "SQLite 連線未指定檔案路徑" => "The SQLite connection did not specify a file path",
        "複製 SQLite 檔失敗：{e}" => "Failed to copy the SQLite file: {e}",
        "找不到 {tool} 工具，請先安裝後再備份（或改用支援內建匯出的格式）" => {
            "The {tool} tool was not found; install it before backing up (or use a format with built-in export)"
        }
        "備份指令執行失敗，請檢查連線與權限" => "The backup command failed; check the connection and permissions",
        "備份檔不存在" => "The backup file does not exist",
        "還原 SQLite 檔失敗：{e}" => "Failed to restore the SQLite file: {e}",
        "找不到 mysql 客戶端，請先安裝" => "The mysql client was not found; install it first",
        "MySQL 還原失敗" => "MySQL restore failed",
        "PostgreSQL 還原失敗" => "PostgreSQL restore failed",
        "找不到 mongorestore，請先安裝" => "mongorestore was not found; install it first",
        "MongoDB 還原失敗" => "MongoDB restore failed",
        "Redis 自動還原暫未支援；請以 redis-cli 手動匯入 RDB" => {
            "Automatic Redis restore is not supported yet; import the RDB manually with redis-cli"
        }
        "SQL Server 還原尚未支援（規劃以 sqlpackage 匯入 .bacpac）" => {
            "SQL Server restore is not supported yet (planned via sqlpackage import from .bacpac)"
        }
        "Oracle 還原尚未支援（規劃以 Data Pump impdp 匯入 .dmp）" => {
            "Oracle restore is not supported yet (planned via Data Pump impdp import from .dmp)"
        }
        "外部 gateway 連線不支援還原" => "External gateway connections do not support restore",
        "建立輸出檔失敗：{e}" => "Failed to create the output file: {e}",
        "開啟備份檔失敗：{e}" => "Failed to open the backup file: {e}",
        "找不到 psql，請先安裝" => "psql was not found; install it first",
        "建立 mongo 工具設定暫存檔失敗：{e}" => "Failed to create the temp config file for the mongo tools: {e}",
        "備份檔過小或無法讀取" => "The backup file is too small or unreadable",
        "備份檔不是有效的 SQLite 資料庫檔" => "The backup file is not a valid SQLite database file",

        // ---- ssh.rs ----
        "找不到設定目錄" => "config directory not found",
        "SQLite 不支援 SSH Tunnel" => "SQLite does not support SSH tunneling",
        "未填寫 SSH 主機" => "SSH host is empty",
        "SSH 連線逾時" => "SSH connection timed out",
        "SSH 連線失敗：{e}" => "SSH connection failed: {e}",
        "SSH 認證逾時" => "SSH authentication timed out",
        "SSH 認證失敗：{e}" => "SSH authentication failed: {e}",
        "讀取 SSH 私鑰失敗：{e}" => "Failed to read the SSH private key: {e}",
        "SSH 認證被拒（帳號 / 密碼 / 金鑰不正確）" => "SSH authentication rejected (incorrect username / password / key)",
        "本地監聽失敗：{e}" => "Local listen failed: {e}",
        "取得本地埠失敗：{e}" => "Failed to obtain the local port: {e}",

        // ---- conn_crypto.rs ----
        "金鑰派生失敗：{e}" => "Key derivation failed: {e}",
        "金鑰派生參數錯誤：{e}" => "Invalid key-derivation parameters: {e}",
        "passphrase 至少 {min} 碼（匯出檔可離線暴力破解，弱口令保護不了機密）" => {
            "The passphrase must be at least {min} characters (the export file can be brute-forced offline; a weak passphrase cannot protect the secrets)"
        }
        "加密失敗" => "Encryption failed",
        "非 db-kit 加密連線檔（檔頭不符）" => "Not a db-kit encrypted connection file (header mismatch)",
        "解密失敗（passphrase 錯誤或檔案損毀）" => "Decryption failed (wrong passphrase or corrupted file)",

        // ---- import.rs / export.rs ----
        "讀取 Excel 失敗：{e}" => "Failed to read the Excel file: {e}",
        "Excel 沒有任何工作表" => "The Excel file has no worksheets",
        "讀取工作表「{sheet}」失敗：{e}" => "Failed to read worksheet \"{sheet}\": {e}",
        "沒有任何資料列" => "No data rows",
        "未提供欄名（無表頭時必填 columns）" => "No column names provided (columns is required when there is no header)",
        "欄名為空" => "Column names are empty",
        "第 {line_no} 列欄數 {got} 與表頭 {want} 不符" => {
            "Row {line_no} has {got} columns, which does not match the {want} header columns"
        }
        "第 {line_no} 列：{e}" => "Row {line_no}: {e}",
        "寫入檔案失敗：{e}" => "Failed to write the file: {e}",
        "沒有可匯出的結果集" => "No result set to export",
        "結果 {n}" => "Result {n}",
        "不支援的匯出格式：{other}" => "Unsupported export format: {other}",
        "沒有可匯出的結構（此資料庫無資料表或不支援建表 SQL）" => {
            "No schema to export (this database has no tables or does not support CREATE SQL)"
        }
        "產生 Excel 失敗：{e}" => "Failed to generate the Excel file: {e}",
        "結果{n}" => "Result{n}",
        "寫入 Excel 失敗：{e}" => "Failed to write to the Excel file: {e}",
        "結果 {n}：{e}" => "Result {n}: {e}",
        "欄數 {n} 超過 Excel 上限（16384）" => "Column count {n} exceeds the Excel limit (16384)",
        "列數 {n} 超過 Excel 上限（1048576）" => "Row count {n} exceeds the Excel limit (1048576)",

        // ---- transfer.rs / scheduler.rs / agent.rs / manager.rs / db/external.rs ----
        "無法解析來源建表 DDL（找不到 CREATE TABLE）" => "Unable to parse the source table DDL (no CREATE TABLE found)",
        "來源建表 DDL 無欄位定義" => "The source table DDL has no column definitions",
        "來源與目標是同一張表，無法傳輸" => "Source and destination are the same table; cannot transfer",
        "自動建表僅支援相同資料庫種類；請先在目標手動建立資料表" => {
            "Auto table creation is only supported between the same database kind; create the destination table manually first"
        }
        "來源與目標沒有同名欄位可傳輸；請確認目標表結構" => {
            "Source and destination share no columns with matching names; verify the destination table structure"
        }
        "建立輸出目錄失敗：{e}" => "Failed to create the output directory: {e}",
        // 註：「無法取得設定目錄：{e}」已於 store.rs 分類收錄（agent.rs 共用同一 key）。
        "建立助手工作目錄失敗：{e}" => "Failed to create the assistant working directory: {e}",
        "僅允許開啟 http / https 連結" => "Only http / https links may be opened",
        "找不到 {cli} CLI，請先安裝並以你的訂閱帳號登入" => {
            "{cli} CLI not found; install it and sign in with your subscription first"
        }
        "這個供應商不需要在終端機安裝或登入" => "This provider has nothing to install or sign in to in a terminal",
        "指令已結束。沒有錯誤的話，回到 DB Kit 就會自動重新偵測；這個視窗可以關掉。" => {
            "The command has finished. If there were no errors, switch back to DB Kit and it will detect again automatically. You can close this window."
        }
        "無法開啟終端機（{e}），請自行在終端機執行：{cmd}" => {
            "Could not open a terminal ({e}). Run this in a terminal yourself: {cmd}"
        }
        "啟動 {cli} 失敗：{e}" => "Failed to start {cli}: {e}",
        "{cli} 以結束碼 {c} 退出" => "{cli} exited with code {c}",
        "Codex 回合失敗" => "The Codex turn failed",
        "此連線不是 Redis" => "This connection is not Redis",
        "此連線不是 MongoDB" => "This connection is not MongoDB",
        "External 連線未指定 options.driver" => "The External connection did not specify options.driver",
        "此 build 未編入外部驅動「{other}」" => "This build does not include the external driver \"{other}\"",

        // ---- db/mod.rs：trait 預設 Unsupported + 欄位驗證 ----
        "此連線不支援取消執行中的查詢" => "This connection does not support cancelling a running query",
        "此資料庫不支援鍵結構編輯" => "This database does not support key structure editing",
        "此資料庫不支援查詢計畫分析" => "This database does not support query plan analysis",
        "此資料庫不支援欄位統計" => "This database does not support column statistics",
        "此資料庫不支援建立集合（請用設計表結構建表）" => {
            "This database does not support creating collections (use table design instead)"
        }
        "此資料庫不支援新增資料庫" => "This database does not support creating databases",
        "此資料庫不支援刪除集合" => "This database does not support dropping collections",
        "此資料庫不支援刪除資料庫" => "This database does not support dropping databases",
        "此資料庫不支援預存程序 / 觸發器" => "This database does not support stored procedures / triggers",
        "此資料庫不支援物件搜尋" => "This database does not support object search",
        "此資料庫不支援此操作" => "This database does not support this operation",
        "此資料庫不支援語法驗證" => "This database does not support syntax validation",
        "此資料庫不支援結構編輯" => "This database does not support schema editing",
        "此資料庫不支援 ER 圖" => "This database does not support ER diagrams",
        "此資料庫不支援建表 DDL" => "This database does not support table DDL",
        "此資料庫不支援刪除索引" => "This database does not support dropping indexes",
        "此資料庫不支援建立索引" => "This database does not support creating indexes",
        "此資料庫不支援伺服器狀態" => "This database does not support server status",
        "此資料庫不支援鍵掃描" => "This database does not support key scanning",
        "此資料庫不支援文件檢視" => "This database does not support document viewing",
        "此資料庫不支援文件取代" => "This database does not support document replacement",
        "請指定欄位型別" => "Please specify a column type",
        "欄位型別含不允許的字元（; -- /* 或換行）" => "The column type contains disallowed characters (; -- /* or line breaks)",
        "預設值含不允許的字元（; -- /* 或換行）" => "The default value contains disallowed characters (; -- /* or line breaks)",

        // ---- 各驅動共用：資料列編輯 / 結構 ----
        "欄位與值數量不符" => "Column and value counts do not match",
        "此表無主鍵，無法安全更新" => "The table has no primary key; cannot update safely",
        "此表無主鍵，無法安全刪除" => "The table has no primary key; cannot delete safely",
        "主鍵欄位與值數量不符" => "Primary key column and value counts do not match",
        "主鍵值為 NULL，無法定位該列" => "The primary key value is NULL; cannot locate the row",
        "主鍵值為 NULL，無法安全定位列" => "The primary key value is NULL; cannot safely locate the row",
        "主鍵值為 NULL，無法安全定位該列" => "The primary key value is NULL; cannot safely locate this row",
        "未提供任何欄位" => "No columns provided",
        "請至少選擇一個欄位" => "Please select at least one column",
        "不支援的運算子：{op}" => "Unsupported operator: {op}",
        "找不到該表的建表語句" => "Could not find the CREATE statement for this table",
        "找不到觸發器「{name}」" => "Trigger \"{name}\" not found",
        "SQLite 不支援直接修改欄位型別（需重建資料表）" => {
            "SQLite does not support altering a column type directly (the table must be rebuilt)"
        }
        "SQLite 不支援直接修改欄位預設值（需重建資料表）" => {
            "SQLite does not support altering a column default directly (the table must be rebuilt)"
        }

        // ---- db/mssql.rs ----
        "取不到定義（可能無權限或物件不存在）" => "Could not retrieve the definition (possibly no permission or the object does not exist)",
        "找不到資料表欄位" => "No table columns found",
        "欄位統計無結果" => "Column statistics returned no results",
        "列數（估計）" => "Row count (estimated)",
        "資料大小" => "Data size",
        "系統資料庫「{name}」不可刪除" => "The system database \"{name}\" cannot be dropped",
        "缺少主鍵，無法定位列" => "Missing primary key; cannot locate the row",

        // ---- db/mysql.rs ----
        "拒絕刪除 MySQL 系統資料庫「{name}」" => "Refusing to drop the MySQL system database \"{name}\"",
        "「{name}」是此連線使用中的預設資料庫，無法刪除；請改用其他連線或先變更連線預設庫" => {
            "\"{name}\" is the default database in use by this connection and cannot be dropped; use another connection or change the connection's default database first"
        }
        "未知的程序類型「{routine_type}」" => "Unknown routine type \"{routine_type}\"",
        "無法取得定義（可能權限不足）" => "Could not retrieve the definition (possibly insufficient permission)",
        "無法辨識的 MySQL DDL，已略過伺服器驗證（僅前端結構檢查）。" => {
            "Unrecognized MySQL DDL; server-side validation was skipped (front-end structure check only)."
        }
        "MySQL 觸發器需掛載於真實資料表，無法安全試建驗證；已略過伺服器驗證（僅前端結構檢查）。" => {
            "MySQL triggers must attach to a real table and cannot be safely trial-created for validation; server-side validation was skipped (front-end structure check only)."
        }
        "MySQL 事件無法安全試建驗證；已略過伺服器驗證（僅前端結構檢查）。" => {
            "MySQL events cannot be safely trial-created for validation; server-side validation was skipped (front-end structure check only)."
        }
        "未知的 MySQL routine 類型，已略過伺服器驗證。" => "Unknown MySQL routine type; server-side validation was skipped.",
        "未指定資料庫，MySQL 無法試建驗證；已略過伺服器驗證（僅前端結構檢查）。" => {
            "No database specified, so MySQL cannot trial-create for validation; server-side validation was skipped (front-end structure check only)."
        }
        "目前帳號缺少建立 routine 的權限，無法在伺服器驗證（僅前端結構檢查）。" => {
            "The current account lacks permission to create routines, so server-side validation is not possible (front-end structure check only)."
        }
        "函式需宣告 DETERMINISTIC / READS SQL DATA（或具備權限）才能試建，已略過伺服器驗證。" => {
            "The function must declare DETERMINISTIC / READS SQL DATA (or have permission) to be trial-created; server-side validation was skipped."
        }
        "引擎" => "Engine",
        "排序規則" => "Collation",
        "建立時間" => "Created",
        "索引大小" => "Index size",
        "註解" => "Comment",
        "無法取得建表語句" => "Could not retrieve the CREATE statement",

        // ---- db/postgres.rs ----
        "拒絕刪除 PostgreSQL 系統 schema「{name}」" => "Refusing to drop the PostgreSQL system schema \"{name}\"",
        "找不到「{name}」的定義" => "Could not find the definition of \"{name}\"",
        "總大小" => "Total size",
        "找不到該表的欄位" => "No columns found for this table",

        // ---- db/oracle.rs ----
        "Oracle client 已以「{dir}」初始化；變更 client 目錄需重新啟動應用程式" => {
            "The Oracle client was already initialized with \"{dir}\"; changing the client directory requires restarting the application"
        }
        "client 目錄無效：{e}" => "Invalid client directory: {e}",
        "Oracle 連線需在「資料庫」欄填入服務名稱（Service Name）/ SID / TNS 別名" => {
            "Oracle connections require a Service Name / SID / TNS alias in the \"Database\" field"
        }
        "此表無主鍵，拒絕就地編輯（避免影響多列）" => {
            "The table has no primary key; in-place editing is refused (to avoid affecting multiple rows)"
        }
        "背景執行緒失敗：{e}" => "Background thread failed: {e}",
        "Oracle 連線逾時（30 秒）" => "Oracle connection timed out (30 seconds)",
        "至少需一個欄位" => "At least one column is required",
        "索引至少需一個欄位" => "An index requires at least one column",
        "取得 DDL 失敗（需物件擁有者或 SELECT_CATALOG_ROLE）：{e}" => {
            "Failed to retrieve DDL (requires the object owner or SELECT_CATALOG_ROLE): {e}"
        }
        "找不到原始碼（權限不足或物件不存在）" => "Source not found (insufficient permission or the object does not exist)",
        "沒有可解釋的語句" => "No statement to explain",
        "列數（統計估計）" => "Row count (statistics estimate)",
        "統計時間" => "Statistics time",
        "表空間" => "Tablespace",
        "Oracle DDL 隱式提交，無法安全試行驗證；將直接執行" => {
            "Oracle DDL commits implicitly and cannot be safely trial-validated; it will be executed directly"
        }
        "Oracle 尚未支援此結構操作" => "Oracle does not support this schema operation yet",
        "Oracle 的資料庫＝schema（使用者帳號）；請由 DBA 以 CREATE USER 管理" => {
            "In Oracle a database equals a schema (user account); have a DBA manage it with CREATE USER"
        }
        "Oracle 的 schema 即使用者帳號，請由 DBA 以 DROP USER 管理（本工具不代理此高風險操作）" => {
            "In Oracle a schema is a user account; have a DBA manage it with DROP USER (this tool does not proxy this high-risk operation)"
        }
        "找不到 Oracle Instant Client（或架構不符，需 64 位元）。\n請安裝 Instant Client Basic / Basic Light 並將其目錄加入 PATH，或在連線設定的「Instant Client 目錄」填入路徑後重試。\n下載：{url}\n（{msg}）" => {
            "Oracle Instant Client not found (or architecture mismatch; 64-bit required).\nInstall Instant Client Basic / Basic Light and add its directory to PATH, or set the path in the connection's \"Instant Client directory\" field and retry.\nDownload: {url}\n({msg})"
        }

        // ---- db/redis.rs ----
        "非預期的 PING 回應：{pong}" => "Unexpected PING response: {pong}",
        "秒；-1 表示無到期" => "seconds; -1 means no expiry",
        "空命令" => "Empty command",
        "TTL 必須為整數" => "TTL must be an integer",
        "不支援直接改 key 名稱，請用 RENAME" => "Renaming a key directly is not supported; use RENAME",
        "type 欄為唯讀，無法編輯" => "The type field is read-only and cannot be edited",
        "缺少 key" => "Missing key",
        "key 為空" => "The key is empty",
        "目標鍵「{new_key}」已存在，為避免覆蓋而取消改名" => {
            "The target key \"{new_key}\" already exists; the rename was cancelled to avoid overwriting"
        }

        // ---- db/mongo.rs：錯誤 ----
        "MongoDB 查詢請提供 JSON：{\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}" => {
            "For a MongoDB query, provide JSON: {\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}"
        }
        "缺少 db" => "Missing db",
        "缺少 collection" => "Missing collection",
        "pipeline 必須是陣列" => "pipeline must be an array",
        "pipeline 每個階段必須是物件" => "Each pipeline stage must be an object",
        "insert 必須是陣列" => "insert must be an array",
        "insert 每個元素必須是物件" => "Each insert element must be an object",
        "update 需要 set 物件" => "update requires a set object",
        "update 的 set 不可為空" => "The set object of update must not be empty",
        "update 需要非空 filter（避免誤改整個集合；要全改請用明確條件如 {\"_id\":{\"$exists\":true}}）" => {
            "update requires a non-empty filter (to avoid modifying the whole collection; to update everything use an explicit condition like {\"_id\":{\"$exists\":true}})"
        }
        "delete 必須是 filter 物件" => "delete must be a filter object",
        "delete 需要非空 filter（避免誤刪整個集合）" => "delete requires a non-empty filter (to avoid deleting the whole collection)",
        "此欄為巢狀結構，需輸入合法 JSON：{e}" => "This field is a nested structure; valid JSON is required: {e}",
        "JSON 轉 BSON 失敗：{e}" => "Failed to convert JSON to BSON: {e}",
        "缺少 _id，無法刪除" => "Missing _id; cannot delete",
        "_id 為空，無法刪除" => "_id is empty; cannot delete",
        "拒絕刪除 MongoDB 系統資料庫「{name}」" => "Refusing to drop the MongoDB system database \"{name}\"",
        "找不到文件" => "Document not found",
        "文件需為合法 JSON：{e}" => "The document must be valid JSON: {e}",
        "文件必須是 JSON 物件" => "The document must be a JSON object",
        "MongoDB 執行計畫請提供與查詢相同的 JSON：{\"db\":\"..\",\"collection\":\"..\",\"filter\":{}}（可加 \"verbosity\"）" => {
            "For a MongoDB execution plan, provide the same JSON as a query: {\"db\":\"..\",\"collection\":\"..\",\"filter\":{}} (an optional \"verbosity\" may be added)"
        }
        "索引規格無效：{other}（可用 1 / -1 / text / 2dsphere / hashed）" => {
            "Invalid index spec: {other} (allowed: 1 / -1 / text / 2dsphere / hashed)"
        }
        "partialFilterExpression 需為合法 JSON：{e}" => "partialFilterExpression must be valid JSON: {e}",
        "partialFilterExpression 必須是非空 JSON 物件" => "partialFilterExpression must be a non-empty JSON object",
        "拒絕修改系統集合的驗證規則" => "Refusing to modify the validation rules of a system collection",
        "validationLevel 無效：{level}" => "Invalid validationLevel: {level}",
        "validationAction 無效：{action}" => "Invalid validationAction: {action}",
        "validator 需為合法 JSON：{e}" => "validator must be valid JSON: {e}",
        "validator 必須是 JSON 物件" => "validator must be a JSON object",
        "profiler level 需為 0 / 1 / 2" => "profiler level must be 0 / 1 / 2",
        "缺少 _id，無法定位文件" => "Missing _id; cannot locate the document",
        "_id 為空" => "_id is empty",
        "verbosity 無效：{other}（可用 queryPlanner / executionStats / allPlansExecution）" => {
            "Invalid verbosity: {other} (allowed: queryPlanner / executionStats / allPlansExecution)"
        }
        "執行計畫僅支援 find / aggregate（pipeline）" => "Execution plans are only supported for find / aggregate (pipeline)",

        // ---- db/mongo.rs：dbStats / collStats / serverStatus 標籤 ----
        "文件數" => "Documents",
        "大小" => "Size",
        "儲存大小" => "Storage size",
        "索引數" => "Indexes",
        "平均文件大小" => "Average document size",
        "集合數" => "Collections",
        "版本" => "Version",
        "主機" => "Host",
        "程序" => "Process",
        "運行時間" => "Uptime",
        "伺服器" => "Server",
        "目前" => "Current",
        "可用" => "Available",
        "活躍" => "Active",
        "累計建立" => "Total created",
        "連線" => "Connections",
        "操作計數" => "Operation counts",
        "常駐記憶體" => "Resident memory",
        "虛擬記憶體" => "Virtual memory",
        "WT 快取使用" => "WT cache used",
        "WT 快取上限" => "WT cache limit",
        "記憶體" => "Memory",
        "流入" => "Bytes in",
        "流出" => "Bytes out",
        "請求數" => "Requests",
        "網路" => "Network",
        "角色" => "Role",
        "成員" => "Members",
        "複寫" => "Replication",
        "{d} 天 {hms}" => "{d}d {hms}",

        // ---- stress.rs：壓力測試守門 ----
        "壓力測試至少需要一條 SQL 語句" => "A stress test needs at least one SQL statement",
        "壓力測試的並行執行緒數至少為 1" => "A stress test needs at least 1 concurrent thread",
        "壓力測試的每執行緒迭代次數至少為 1" => {
            "A stress test needs at least 1 iteration per thread"
        }
        "壓力測試的持續時間至少為 1 秒" => "A stress test must run for at least 1 second",
        "壓力測試的持續時間上限為 {max} 秒" => {
            "A stress test may run for at most {max} seconds"
        }
        "壓力測試會反覆執行語句，已拒絕高破壞語句（DROP / TRUNCATE 或無 WHERE 的 UPDATE / DELETE）：{sql}" => {
            "A stress test replays statements repeatedly, so highly destructive statements are refused (DROP / TRUNCATE, or UPDATE / DELETE without WHERE): {sql}"
        }
        "壓力測試會反覆執行語句，已拒絕 EXPLAIN ANALYZE 寫入語句（它會真的執行，不只產生執行計畫）：{sql}" => {
            "A stress test replays statements repeatedly, so EXPLAIN ANALYZE on a write statement is refused (it really executes the statement, not just plans it): {sql}"
        }

        // ---- db/kafka ----
        "群組仍有活躍成員，無法重設位移（請先停掉消費者）" => {
            "The group still has active members; stop the consumers before resetting offsets"
        }
        "重設逾時：無法取得群組分區指派" => {
            "Reset timed out: unable to obtain the group's partition assignment"
        }
        "主題含無法讀取的敏感設定，整組覆寫會遺失該值，已拒絕編輯" => {
            "The topic has sensitive config values that cannot be read; a full-set overwrite would silently drop them, so the edit was refused"
        }
        "新分區數必須大於目前的 {n}" => "The new partition count must be greater than the current {n}",
        "內部主題不可清空" => "Internal topics cannot be emptied",
        "沒有符合的分區" => "No matching partitions",
        "沒有可套用的分區（皆無已提交位移）" => "No partitions to apply (none have committed offsets)",
        "群組仍有活躍成員，無法刪除（請先停掉消費者）" => {
            "The group still has active members; stop the consumers before deleting it"
        }
        "（此連線未設定 Schema Registry，無法以 Avro 解碼）" => {
            "(No Schema Registry configured for this connection; cannot decode as Avro)"
        }
        "（非 Confluent wire format，無法以 Avro 解碼）" => {
            "(Not Confluent wire format; cannot decode as Avro)"
        }
        "此連線未設定 Kafka Connect" => "This connection has no Kafka Connect configured",
        "連接器正在重新平衡，請稍後再試" => "The connector is rebalancing; please try again shortly",
        "叢集未啟用授權器（authorizer），無法管理 ACL" => {
            "The cluster has no authorizer enabled; ACLs cannot be managed"
        }
        "此連線未設定 Schema Registry，無法以 Avro 發佈" => {
            "No Schema Registry configured for this connection; cannot produce as Avro"
        }
        "僅支援以 Avro 序列化發佈（此 subject 非 AVRO）" => {
            "Only Avro serialization is supported for producing (this subject is not AVRO)"
        }
        "Avro 編碼失敗" => "Avro encoding failed",

        // ---- Elasticsearch / OpenSearch（elastic feature）----
        "此連線不是 Elasticsearch" => "This connection is not Elasticsearch",
        "此版本未編入 Elasticsearch 支援（請以 --features elastic 建置）" => {
            "This build does not include Elasticsearch support (build with --features elastic)"
        }
        "Elasticsearch 查詢請提供含 index 的 JSON 物件" => {
            "Provide a JSON object with an \"index\" field for the Elasticsearch query"
        }
        "Elasticsearch 查詢需為 JSON：{e}" => "The Elasticsearch query must be JSON: {e}",
        "Elasticsearch 連線第一版為唯讀，不支援直接編輯文件（請以 DSL 查詢瀏覽）" => {
            "Elasticsearch connections are read-only in this version; documents cannot be edited directly (use DSL queries to browse)"
        }
        "Elasticsearch 深度分頁超過 max_result_window（10000）；請改用 DSL 查詢（search_after）或縮小頁數" => {
            "Deep pagination exceeds max_result_window (10000); use a DSL query (search_after) or reduce the page number"
        }
        "文件不存在：{id}" => "Document not found: {id}",
        "Elastic Cloud cloud_id 格式無法解析" => "Could not parse the Elastic Cloud cloud_id",
        "讀取 CA 憑證檔失敗：{e}" => "Failed to read the CA certificate file: {e}",
        "搜尋引擎類連線不支援資料傳輸" => "Search-engine connections do not support data transfer",
        "Elasticsearch 連線不支援備份" => "Elasticsearch connections do not support backup",
        "Elasticsearch 連線不支援還原" => "Elasticsearch connections do not support restore",
        "CLI 不支援 Elasticsearch 連線（請用 GUI）" => {
            "The CLI does not support Elasticsearch connections (use the GUI)"
        }


        // ---- llm/：Anthropic / OpenAI 相容供應商 ----
        "尚未設定 API Base URL" => "No API base URL configured",
        "尚未指定模型" => "No model specified",
        "未知的供應商：{kind}" => "Unknown provider: {kind}",
        "（金鑰無效或沒有權限）" => " (invalid key or insufficient permission)",
        "（Base URL 可能不對，或這個服務沒有這個端點）" => " (the base URL may be wrong, or this service has no such endpoint)",
        "（額度或速率上限）" => " (quota or rate limit)",
        "串流中斷：{e}" => "Stream interrupted: {e}",
        "連線失敗：{e}" => "Connection failed: {e}",
        "回應不是 JSON：{e}" => "The response is not JSON: {e}",
        "端點連續拒絕請求（已嘗試相容性調整）" => "The endpoint kept rejecting the request (compatibility adjustments were already tried)",
        "（回應長度達上限，內容可能不完整）" => "(Reached the length limit; the answer may be incomplete.)",
        "模型重複呼叫同一支工具且沒有進展，已中止" => "The model kept calling the same tool without progress, so the run was stopped",
        "超過 {n} 回合仍未收斂，已中止" => "Stopped after {n} turns without converging",
        "讀取助手工作資料夾裡的一個檔案（相對路徑）。" => "Read one file inside the assistant workspace folder (relative path).",
        "列出助手工作資料夾裡的檔案，可用 * 與 ? 萬用字元過濾。" => "List files in the assistant workspace folder; * and ? wildcards are supported.",
        "在助手工作資料夾的文字檔中搜尋字串，回傳檔名、行號與該行內容。" => "Search text files in the assistant workspace folder and return file, line number and the matching line.",
        "把內容寫進助手工作資料夾裡的檔案（會覆蓋同名檔，可建立子目錄）。" => "Write content to a file in the assistant workspace folder (overwrites an existing file; subdirectories are created).",
        "path 不可為空" => "path must not be empty",
        "只能使用相對路徑（限助手工作資料夾內）" => "Only relative paths are allowed (inside the assistant workspace folder)",
        "路徑不可包含 .. 或磁碟前綴（限助手工作資料夾內）" => "The path must not contain .. or a drive prefix (inside the assistant workspace folder)",
        "建立目錄失敗：{e}" => "Failed to create the directory: {e}",
        "query 不可為空" => "query must not be empty",
        "目前是唯讀模式（advise），要寫檔請切到 agent 模式" => "This is read-only mode (advise); switch to agent mode to write files",
        "未知的工具：{name}" => "Unknown tool: {name}",
        "（找不到「{query}」）" => "(no match for “{query}”)",
        "（工作資料夾裡沒有符合的檔案）" => "(no matching file in the workspace folder)",
        "已寫入 {path}（{n} 位元組）" => "Wrote {path} ({n} bytes)",

        // ---- compare/：結構 / 資料比對（schema.rs / ddl.rs / snapshot.rs）----
        "此資料庫種類不支援結構比對" => "This database kind does not support schema comparison",
        "無法取得 {name} 的定義：{err}" => "Unable to fetch the definition of {name}: {err}",
        "無法列出程序 / 函式：{err}" => "Unable to list routines: {err}",
        "欄位：{err}" => "columns: {err}",
        "索引：{err}" => "indexes: {err}",
        "外鍵：{err}" => "foreign keys: {err}",
        "DDL：{err}" => "DDL: {err}",
        "找不到視圖定義" => "View definition not found",
        "來源與目標資料庫種類不同，無法產生同步 DDL" => "Source and target are different database kinds; cannot generate sync DDL",
        "資料表 {name}：來源無 DDL，無法產生 CREATE TABLE" => "Table {name}: the source has no DDL, so CREATE TABLE cannot be generated",
        "Oracle DDL 含儲存子句（TABLESPACE 等），目標環境可能需調整" => "Oracle DDL includes storage clauses (TABLESPACE etc.) that may need adjusting for the target",
        "資料表 {name}：{err}" => "Table {name}: {err}",
        "資料表 {name}：目標多出（未含 DROP）" => "Table {name}: only in target (DROP not included)",
        "{table}：主鍵變更請手動處理" => "{table}: primary key changes must be handled manually",
        "SQLite 無 DEFAULT 的 NOT NULL 欄無法新增，已改為允許 NULL" => "SQLite cannot add a NOT NULL column without a DEFAULT; changed to nullable",
        "{obj}：identity / generated 屬性變更（{src} → {dst}）請手動處理" => "{obj}: identity / generated attribute change ({src} → {dst}) must be handled manually",
        "{obj}：SQLite 無法修改欄位型別 / NULL / 預設值（需重建資料表）" => "{obj}: SQLite cannot alter column type / nullability / default (table rebuild required)",
        "{obj}：SQL Server 預設值為具名約束，請手動處理" => "{obj}: SQL Server defaults are named constraints; handle manually",
        "{obj}：identity 屬性變更請手動處理" => "{obj}: identity attribute change must be handled manually",
        "{obj}：此引擎不支援欄位變更" => "{obj}: this engine does not support column changes",
        "{obj}：目標多出的欄位（未含 DROP）" => "{obj}: column only in target (DROP not included)",
        "需 SQLite 3.35+" => "Requires SQLite 3.35+",
        "若此唯一索引由 UNIQUE 約束建立，請改用 DROP CONSTRAINT" => "If this unique index backs a UNIQUE constraint, use DROP CONSTRAINT instead",
        "{table}.{fk}：SQLite 無法新增外鍵（需重建資料表）" => "{table}.{fk}: SQLite cannot add foreign keys (table rebuild required)",
        "{table}.{fk}：SQLite 無法刪除外鍵（需重建資料表）" => "{table}.{fk}: SQLite cannot drop foreign keys (table rebuild required)",
        "視圖 {name}：目標多出（未含 DROP）" => "View {name}: only in target (DROP not included)",
        "視圖 {name}：來源無定義" => "View {name}: the source has no definition",
        "視圖本體引用的表未限定資料庫，請在目標資料庫的連線環境下執行" => "Tables referenced in the view body are not database-qualified; run this while connected to the target database",
        "{rtype} {name}：目標多出（未含 DROP）" => "{rtype} {name}: only in target (DROP not included)",
        "{name}：來源無定義" => "{name}: the source has no definition",
        "定義沿用來源（{src}），若內含 schema 限定名請改為 {dst}" => "Definition taken from the source ({src}); change any schema-qualified names to {dst}",
        "請在目標資料庫的連線環境下執行" => "Run while connected to the target database",
        "快照路徑無效" => "Invalid snapshot path",
        "目錄不存在：{dir}" => "Directory does not exist: {dir}",
        "讀取快照失敗：{err}" => "Failed to read the snapshot: {err}",
        "快照格式錯誤：{err}" => "Invalid snapshot format: {err}",
        "快照版本 {v} 高於本程式支援的 {max}，請更新 db-kit" => "Snapshot version {v} is newer than the supported {max}; please update db-kit",

        // ---- cli/compare.rs ----
        "請以 -d 指定要擷取的資料庫 / schema" => "Specify the database / schema to capture with -d",
        "擷取結構中… {done}/{total}" => "Capturing schema… {done}/{total}",
        "已存快照：{path}（{tables} 表 / {views} 視圖 / {routines} 程序，{bytes} bytes）" => "Snapshot saved: {path} ({tables} tables / {views} views / {routines} routines, {bytes} bytes)",
        "種類" => "kind",
        "標籤" => "label",
        "擷取時間" => "captured at",
        "資料表數" => "tables",
        "視圖數" => "views",
        "程序 / 函式 / 觸發器數" => "routines",
        "快照版本" => "snapshot version",
        "產生程式版本" => "app version",
        "{role}未指定資料庫 / schema" => "No database / schema specified for the {role}",
        "擷取{role}結構中… {done}/{total}" => "Capturing {role} schema… {done}/{total}",
        "來源" => "source",
        "目標" => "target",
        "目標為快照檔，無法套用同步 SQL" => "The target is a snapshot file; sync SQL cannot be applied",
        "結構一致，無需同步。" => "Schemas match; nothing to sync.",
        "在目標「{db}」執行 {n} 句同步 DDL（{d} 句為高破壞）" => "Run {n} sync DDL statements on target \"{db}\" ({d} destructive)",
        "套用中… {i}/{n}" => "Applying… {i}/{n}",
        "第 {i} 句失敗（{obj}）：{err}\n{sql}" => "Statement {i} failed ({obj}): {err}\n{sql}",
        "已套用 {n} 句同步 DDL" => "Applied {n} sync DDL statements",
        "{n} 句（{d} 句高破壞，{s} 項未能自動產生）" => "{n} statements ({d} destructive, {s} could not be generated)",
        "結構一致，無差異。" => "Schemas match; no differences.",
        "發現 {n} 項結構差異" => "Found {n} schema differences",

        // ---- cli/args.rs：ConnArgs 與 stress 的 help（v0.29 起漏收，害 `dbk --lang en` 在 debug build
        //      直接觸發 cli/mod.rs 的 debug_assert 而 panic）----
        "全域連線與輸出旗標（flatten 到所有子指令；`global = true` 讓它們可放在子指令前後）。" => {
            "Global connection and output flags (flattened into every subcommand; `global = true` lets them appear before or after the subcommand)."
        }
        "壓力測試：多執行緒重複執行同一段查詢，量測 TPS 與延遲分佈（唯讀；寫入語句會被擋下）" => {
            "Stress test: replay one statement from multiple threads and measure TPS and latency distribution (read-only; writes are blocked)"
        }
        "並行執行緒數（1..64）" => "Number of concurrent threads (1..64)",
        "每執行緒迭代次數。與 --seconds 互斥；兩者皆未給時預設跑 100 次" => {
            "Iterations per thread. Mutually exclusive with --seconds; defaults to 100 when neither is given"
        }
        "改以「持續時間」計：跑滿 N 秒（含暖機與爬升）" => {
            "Measure by duration instead: run for N seconds (including warmup and ramp-up)"
        }
        "執行緒逐步進場的爬升秒數（僅 --seconds 模式有意義）" => {
            "Seconds over which threads ramp up (only meaningful with --seconds)"
        }
        "每執行緒暖機次數（不計入統計）" => "Warmup iterations per thread (excluded from the statistics)",
        "每次迭代之間的間隔（毫秒）" => "Delay between iterations (milliseconds)",
        "每次查詢的取列上限（0 = 完整取回）" => "Row cap per query (0 = fetch everything)",
        "單次查詢逾時（毫秒；0 = 不逾時）" => "Timeout per query (milliseconds; 0 = no timeout)",

        // ---- cli/args.rs：schema / compare 子命令 help ----
        "結構快照（擷取整庫結構為 JSON 檔，供日後比對）" => "Schema snapshots (capture a whole database schema to a JSON file for later comparison)",
        "比對來源與目標（結構 / 資料列），可輸出或套用同步 SQL" => "Compare source and target (schema / rows); print or apply sync SQL",
        "擷取目前連線 / 資料庫的結構為 JSON 快照檔" => "Capture the current connection / database schema to a JSON snapshot file",
        "輸出檔路徑（.json）" => "Output file path (.json)",
        "不含建表 DDL（檔案較小；無法比對 charset / engine 等 DDL 層差異）" => "Exclude CREATE TABLE DDL (smaller file; DDL-level differences such as charset / engine cannot be compared)",
        "不含預存程序 / 函式 / 觸發器" => "Exclude stored procedures / functions / triggers",
        "顯示快照檔摘要（種類 / 資料庫 / 表數 / 擷取時間）" => "Show a snapshot file summary (kind / database / table count / captured time)",
        "結構比對：表 / 欄位 / 索引 / 外鍵 / 視圖 / 程序；可輸出同步 DDL" => "Schema comparison: tables / columns / indexes / foreign keys / views / routines; can print sync DDL",
        "目標：已存連線名稱 / id、連線字串，或 .json 快照檔路徑" => "Target: saved connection name / id, connection string, or .json snapshot path",
        "來源（省略 = 全域連線旗標 --conn / --url）；同樣接受連線或快照檔" => "Source (omit = global --conn / --url); also accepts a connection or snapshot file",
        "來源資料庫 / schema（預設沿用 -d）" => "Source database / schema (defaults to -d)",
        "目標資料庫 / schema（預設同來源）" => "Target database / schema (defaults to the source's)",
        "名稱比對忽略大小寫" => "Ignore case when matching names",
        "忽略欄位註解差異" => "Ignore column comment differences",
        "忽略欄位預設值差異" => "Ignore column default differences",
        "不比對預存程序 / 函式 / 觸發器" => "Skip stored procedures / functions / triggers",
        "輸出同步 SQL（使目標與來源一致）而非差異表" => "Print sync SQL (make the target match the source) instead of a diff table",
        "同步 SQL 含 DROP 語句（刪除目標多出的表 / 欄 / 視圖）" => "Include DROP statements in sync SQL (remove tables / columns / views only in target)",
        "同步 SQL 含程序 / 函式 / 觸發器" => "Include routines in sync SQL",
        "直接在目標執行同步 SQL。需 --yes；含高破壞語句時另需 --force" => "Apply sync SQL on the target directly. Requires --yes; --force too when destructive statements are included",
        "有差異時以非零結束碼結束（腳本 / CI 用）" => "Exit non-zero when differences are found (for scripts / CI)",

        // ---- compare/data.rs + cli compare data ----
        "目標缺少對應主鍵欄位 {col}" => "The target lacks primary-key column {col}",
        "來源與目標沒有同名欄位可比對" => "Source and target share no columns to compare",
        "寫入暫存檔失敗：{err}" => "Failed to write the temp file: {err}",
        "建立暫存檔失敗：{err}" => "Failed to create the temp file: {err}",
        "讀取暫存檔失敗：{err}" => "Failed to read the temp file: {err}",
        "此資料庫種類不支援資料比對" => "This database kind does not support data comparison",
        "來源資料表沒有主鍵，無法以主鍵比對" => "The source table has no primary key; cannot compare by key",
        "來源與目標是同一張表" => "Source and target are the same table",
        "目標連線標記為正式環境，未允許套用同步" => "The target connection is marked as production; applying sync is not allowed",
        "含二進位欄位，以原字串比對（跨引擎可能不可比）" => "Binary columns are compared as raw strings (may not be comparable across engines)",
        "兩側主鍵排序與比較器不一致，已改用雜湊比對" => "Primary-key ordering differs from the comparer; switched to hash comparison",
        "無主鍵" => "no primary key",
        "預檢相同（筆數 / 主鍵範圍一致）" => "precheck identical (row count / key range match)",
        "預檢有差異（僅預檢）" => "precheck differs (precheck only)",
        "預檢失敗：{err}" => "precheck failed: {err}",
        "請以 -d 指定來源資料庫 / schema" => "Specify the source database / schema with -d",
        "資料比對的目標必須是連線，不能是快照檔" => "The target of a data comparison must be a connection, not a snapshot file",
        "比對中… {table} {i}/{n} · 來源 {s} 列 / 目標 {d} 列 · +{ins} ~{upd} -{del}" => "Comparing… {table} {i}/{n} · source {s} rows / target {d} rows · +{ins} ~{upd} -{del}",
        "資料一致，無需同步。" => "Data match; nothing to sync.",
        "套用同步到目標「{db}」：{i} INSERT / {u} UPDATE / {d} DELETE（{t} 表）" => "Apply sync to target \"{db}\": {i} INSERT / {u} UPDATE / {d} DELETE ({t} tables)",
        "{n} 句同步 SQL 失敗" => "{n} sync SQL statements failed",
        "+{ins} ~{upd} -{del}" => "+{ins} ~{upd} -{del}",
        "套用同步到目標「{dst}」：{i} INSERT / {u} UPDATE / {d} DELETE" => "Apply sync to target \"{dst}\": {i} INSERT / {u} UPDATE / {d} DELETE",
        "同步 SQL 超過文字上限，請改用 --apply 或縮小範圍" => "Sync SQL exceeds the text limit; use --apply or narrow the scope",
        "新增（目標缺）" => "inserts (missing in target)",
        "更新（值不同）" => "updates (values differ)",
        "刪除（目標多出）" => "deletes (only in target)",
        "相同" => "identical",
        "來源列數" => "source rows",
        "目標列數" => "target rows",
        "策略" => "strategy",
        "耗時（ms）" => "elapsed (ms)",
        "截斷原因" => "truncated",
        "DELETE 已停用" => "DELETE suppressed",
        "比對被截斷，為安全不輸出 DELETE" => "The comparison was truncated; DELETE is withheld for safety",
        "主鍵" => "primary key",
        "來源獨有欄位（忽略）" => "source-only columns (ignored)",
        "目標獨有欄位（不受影響）" => "target-only columns (untouched)",
        "已套用" => "applied",
        "失敗" => "failed",
        "已套用 {a}，失敗 {f}" => "applied {a}, failed {f}",
        "僅來源有：{list}" => "Only in source: {list}",
        "僅目標有：{list}" => "Only in target: {list}",
        "合計 +{ins} ~{upd} -{del}" => "Total +{ins} ~{upd} -{del}",
        "已取消" => "Cancelled",
        "資料列比對：以主鍵逐列比對兩表（或整庫），可輸出 / 套用同步 SQL" => "Row comparison: compare two tables (or a whole database) row by row on the primary key; print or apply sync SQL",
        "來源表名（與 --all 互斥）" => "Source table name (mutually exclusive with --all)",
        "目標：已存連線名稱 / id 或連線字串（省略 = 與來源同一連線）" => "Target: saved connection name / id or connection string (omit = same connection as the source)",
        "目標表名（預設同來源）" => "Target table name (defaults to the source's)",
        "比對整庫（來源 ∩ 目標的資料表；略過視圖與無主鍵表）" => "Compare the whole database (tables in both source and target; views and tables without a primary key are skipped)",
        "先以 COUNT / MIN / MAX 預檢，看起來相同的表直接略過（僅 --all）" => "Precheck with COUNT / MIN / MAX first and skip tables that look identical (--all only)",
        "只做預檢，不逐列比對（僅 --all）" => "Precheck only, no row-by-row comparison (--all only)",
        "將同步 SQL 輸出到 stdout（不執行）" => "Print sync SQL to stdout (do not execute)",
        "在目標直接執行同步 SQL。需 --yes；含 --include-deletes 時另需 --force" => "Execute sync SQL on the target directly. Requires --yes; --force too with --include-deletes",
        "同步 SQL 含 DELETE（刪除目標多出的列）" => "Include DELETE in sync SQL (remove rows only in target)",
        "每側最多掃描列數（0 = 不限）" => "Maximum rows to scan per side (0 = unlimited)",
        "每類差異保留的樣本列數" => "Sample rows kept per difference category",
        "忽略的欄位（可重複）" => "Columns to ignore (repeatable)",
        "忽略字串尾端空白" => "Ignore trailing whitespace in strings",
        "比對策略：auto（排序合併，失敗自動退雜湊）| merge | hash" => "Comparison strategy: auto (sort-merge, falls back to hash) | merge | hash",
        "套用時任一批失敗即中止（預設：該批改逐句重放，隔離壞列後繼續）" => "Stop when any batch fails while applying (default: replay that batch statement by statement, isolating bad rows, then continue)",
        "允許對標記為正式環境（prod）的目標連線套用" => "Allow applying to a target connection marked as production (prod)",
        // ---- cli/args.rs：dbk sp-test ----
        "預存程序整合測試：情境 / 斷言 / 基線回歸 / 跨引擎差分（JUnit 報表，可進 CI）" => {
            "Stored-procedure integration tests: scenarios / assertions / golden regression / cross-engine diff (JUnit report for CI)"
        }
        "執行測試檔（assert：比對期望；golden：另比基線；record：錄製基線）" => {
            "Run test files (assert: check expectations; golden: also compare with the baseline; record: capture the baseline)"
        }
        "跨引擎差分：同一組測試檔在 --dst 的第二個連線上再跑一次並逐步互比（遷移驗證）" => {
            "Cross-engine diff: run the same test files on the second connection given by --dst and compare step by step (migration verification)"
        }
        "盤點預存程序：簽名、寫入目標與本文（JSON；給 AI 產生情境用）" => {
            "Inspect a stored procedure: signature, write targets and body (JSON; feed it to AI to generate scenarios)"
        }
        "檢查測試檔格式與引用（不連線）" => "Validate test file format and references (no connection)",
        "程序名（可帶 schema）" => "Routine name (schema prefix allowed)",
        "測試檔或資料夾（資料夾 = 底下所有 *.json，略過 golden/ 與 runs/）" => {
            "Test files or folders (folder = every *.json inside, skipping golden/ and runs/)"
        }
        "執行模式" => "Execution mode",
        "基線資料夾（golden / record 模式必填）" => "Baseline folder (required for golden / record)",
        "只跑這些情境 id（逗號分隔）" => "Run only these scenario ids (comma-separated)",
        "只跑帶任一標籤的情境（逗號分隔）" => "Run only scenarios carrying any of these tags (comma-separated)",
        "另寫 JUnit XML 報表到此路徑" => "Also write a JUnit XML report to this path",
        "任一情境未通過時以非零 exit code 結束（CI 用）" => "Exit non-zero when any scenario does not pass (for CI)",
        "每個結果集 / 快照的列數上限（0 = 不限）" => "Row cap per result set / snapshot (0 = unlimited)",
        "第二個目標：已存連線名 / id 或連線字串" => "Second target: saved connection name / id or connection string",
        "第二個目標的資料庫 / schema（省略 = 與 -d 相同）" => "Database / schema of the second target (default: same as -d)",
        // ---- cli/sptest.rs ----
        "沒有找到測試檔" => "No test files found",
        "{file} 解析失敗：{e}" => "Failed to parse {file}: {e}",
        "{file}：{errs}" => "{file}: {errs}",
        "請以 -d 指定資料庫 / schema" => "Specify the database / schema with -d",
        "差分的目標必須是連線，不能是快照檔" => "The diff target must be a connection, not a snapshot file",
        "{n} 個情境未通過" => "{n} scenario(s) did not pass",
        "已寫入 JUnit 報表：{path}" => "JUnit report written: {path}",
        "測試檔路徑必須是絕對路徑且以 .json 結尾" => "The test file path must be absolute and end with .json",
        "capture 的值必須是 >>符號（{v}）" => "capture values must be >>symbols (got {v})",
        "結果集沒有欄位 {col}，無法擷取" => "The result set has no column {col} to capture",
        "開場失敗：{e}" => "Opening the scenario failed: {e}",
        "SAVEPOINT 失敗：{e}" => "SAVEPOINT failed: {e}",
        "引擎沒回傳這個欄，無法擷取" => "The engine did not return this column, nothing to capture",
        "compare 的兩個符號都必須是結果集" => "Both compare symbols must be result sets",
        "沒有基線：{path}（先用 record 模式錄一次）" => "No baseline: {path} (record one with record mode first)",
        "isolated 模式尚未支援（程序內含 COMMIT / ROLLBACK 的情境請先略過）" => "isolated mode is not supported yet (skip scenarios whose routine contains COMMIT / ROLLBACK)",
        "只有一邊跑到這一步" => "Only one side reached this step",
        "沒有這個 OUT 參數" => "No such OUT parameter",
        "這張表不在快照清單裡（snapshot 設定或盤點沒抓到）" => "This table is not in the snapshot list (snapshot setting or inspection missed it)",
        "effects_strict：這張表有變化但期望沒列出" => "effects_strict: this table changed but is not listed in the expectation",
        "預期出錯但沒有錯誤" => "An error was expected but none occurred",
        "{side} 沒有這個 OUT 參數" => "{side} has no such OUT parameter",
        "{side} 沒有這張表的快照" => "{side} has no snapshot of this table",
        "結果集沒有這個欄（有：{cols}）" => "The result set has no such column (has: {cols})",
        "MySQL 的 insert 只能擷取一個自動產生欄（LAST_INSERT_ID）" => "A MySQL insert can capture only one generated column (LAST_INSERT_ID)",
        "陣列不能當 SQL 字面值" => "An array cannot be used as a SQL literal",
        "bytes 必須是 base64" => "bytes must be base64",
        "未知的型別標記 {t}" => "Unknown type tag {t}",
        "{v} 不是數字" => "{v} is not a number",
        "參數 {name} 不是 OUT 參數，不能擷取" => "Parameter {name} is not an OUT parameter and cannot be captured",
        "簽名裡沒有參數 {name}" => "The signature has no parameter {name}",
        "符號 {name} 沒有欄位 {col}" => "Symbol {name} has no column {col}",
        "符號 {name} 不是結果集，不能取欄位 {col}" => "Symbol {name} is not a result set; cannot take column {col}",
        "找不到測試檔或資料夾：{path}" => "Test file or folder not found: {path}",
        // ---- sptest 核心 ----
        "預存程序測試尚不支援 {kind}" => "Stored-procedure tests do not support {kind} yet",
        "找不到預存程序 {name}" => "Stored procedure {name} not found",
        "未定義的符號 {name}" => "Undefined symbol {name}",
        "沒有指定目標連線" => "No target connection given",
        "diff 模式需要恰好兩個目標" => "diff mode needs exactly two targets",
        "record / golden 模式需要基線資料夾" => "record / golden mode needs a baseline folder",
        "測試檔有誤：{errs}" => "Invalid test file: {errs}",
        "正式環境連線只能用 wrapped 模式" => "A production connection can only run in wrapped mode",
        "此連線不是 SQL Server" => "This connection is not SQL Server",
        "此連線不是 PostgreSQL" => "This connection is not PostgreSQL",
        "此連線不是 MySQL" => "This connection is not MySQL",

        // ---- cli/args.rs：dbk mcp ----
        "以 MCP（stdio JSON-RPC）伺服器模式啟動，把唯讀資料庫工具提供給 AI 用戶端（Claude Code / Codex）" => {
            "Start as an MCP (stdio JSON-RPC) server exposing read-only database tools to AI clients (Claude Code / Codex)"
        }
        // ---- cli/mcp.rs ----
        "這些工具唯讀地存取使用者在 db-kit 選定的資料庫連線。寫查詢前先用 describe_table 確認欄名；查詢一律加 LIMIT；不要猜測不存在的表或欄位。" => {
            "These tools give read-only access to the database connection the user selected in db-kit. Call describe_table before writing a query; always add LIMIT; never guess tables or columns that you have not listed."
        }
        "MCP 伺服器已啟動（stdio）；等待用戶端 initialize…" => "MCP server started (stdio); waiting for the client to initialize…",

        // ---- dbtools/mod.rs：AI 助手的唯讀資料庫工具 ----
        "資料庫 / schema 名稱；省略則用目前對話的資料庫" => "Database / schema name; defaults to the current database of this conversation",
        "此為正式環境連線，請保持查詢輕量（小 LIMIT、避免全表掃描）。" => "This is a production connection: keep queries light (small LIMIT, avoid full scans).",
        "列出此連線上的資料庫 / schema。" => "List the databases / schemas on this connection.",
        "列出資料庫裡的 {noun}（含視圖）。" => "List the {noun}s in a database (including views).",
        "取得一個 {noun} 的欄位（名稱 / 型別 / 可空 / 主鍵 / 預設值 / 註解）、索引與外鍵。寫查詢前請先用它確認欄名。" => {
            "Get the columns (name / type / nullable / primary key / default / comment), indexes and foreign keys of a {noun}. Use it to confirm column names before writing a query."
        }
        "抓取一個 {noun} 的前幾列樣本（最多 {max} 列），用來了解資料長相。{prod}" => {
            "Fetch the first few sample rows of a {noun} (at most {max}) to see what the data looks like.{prod}"
        }
        "預設 {n}" => "Default {n}",
        "對目前連線執行**唯讀** MongoDB 查詢。參數 query 為 JSON：find 用 {\"collection\":\"..\",\"filter\":{},\"sort\":{},\"projection\":{},\"limit\":N}；聚合用 {\"collection\":\"..\",\"pipeline\":[…]}（省略 db 則用目前資料庫）。禁止 $out / $merge 與任何寫入。結果最多 {max} 列、{kb} KB。{prod}" => {
            "Run a **read-only** MongoDB query on the current connection. `query` is JSON: find with {\"collection\":\"..\",\"filter\":{},\"sort\":{},\"projection\":{},\"limit\":N}; aggregate with {\"collection\":\"..\",\"pipeline\":[…]} (db defaults to the current database). $out / $merge and any write are forbidden. At most {max} rows / {kb} KB.{prod}"
        }
        "對目前連線執行**唯讀** Redis 命令（如 GET k、HGETALL h、SCAN 0 MATCH user:* COUNT 100；可用 \"2:GET k\" 指定 DB index）。只放行讀取類命令；KEYS 會全庫掃描，請改用 SCAN。{prod}" => {
            "Run a **read-only** Redis command on the current connection (e.g. GET k, HGETALL h, SCAN 0 MATCH user:* COUNT 100; prefix \"2:GET k\" to pick the DB index). Only read commands are allowed; KEYS scans the whole keyspace, prefer SCAN.{prod}"
        }
        "對目前連線執行**唯讀** SQL（單一語句）。寫 SQL 前請先用 describe_table 確認欄名；一律加 LIMIT（結果最多 {max} 列、{kb} KB）。禁止 INSERT / UPDATE / DELETE / DDL；可寫 CTE 與 EXPLAIN ANALYZE 寫入語句也會被擋。{prod}" => {
            "Run a **read-only** SQL statement (one statement) on the current connection. Call describe_table first to confirm column names; always add LIMIT (at most {max} rows / {kb} KB). INSERT / UPDATE / DELETE / DDL are rejected, as are writable CTEs and EXPLAIN ANALYZE over writes.{prod}"
        }
        "MongoDB 查詢 JSON" => "MongoDB query JSON",
        "Redis 命令列" => "Redis command line",
        "要執行的 SQL（單一語句）" => "The SQL to run (one statement)",
        "結果列數上限，預設 {n}" => "Maximum rows to return, default {n}",
        "取得一條唯讀查詢的執行計畫（EXPLAIN），用來判斷索引是否用上、哪個節點最貴。不會執行寫入語句。" => {
            "Get the execution plan (EXPLAIN) of a read-only query to see whether indexes are used and which node is the most expensive. Never runs write statements."
        }
        "要解釋的查詢（單一語句）" => "The query to explain (one statement)",
        "一次只能執行一條語句；請拆成多次呼叫" => "Only one statement per call; split it into several calls",
        "唯讀工具只允許查詢語句（偵測到 `{kw}`）；不要嘗試寫入" => "Read-only tool: only query statements are allowed (detected `{kw}`); do not attempt writes",
        "唯讀工具不允許可寫 CTE（含 `{w}`）" => "Read-only tool: writable CTEs are not allowed (contains `{w}`)",
        "唯讀工具不允許 EXPLAIN 寫入語句（含 `{w}`；EXPLAIN ANALYZE 會真的執行）" => {
            "Read-only tool: EXPLAIN over a write statement is not allowed (contains `{w}`; EXPLAIN ANALYZE really executes it)"
        }
        "MongoDB 查詢必須是 JSON 物件：{e}" => "The MongoDB query must be a JSON object: {e}",
        "MongoDB 查詢必須是 JSON 物件" => "The MongoDB query must be a JSON object",
        "不允許的鍵：{k}（只接受 db / collection / filter / sort / projection / limit / pipeline）" => {
            "Key not allowed: {k} (only db / collection / filter / sort / projection / limit / pipeline)"
        }
        "唯讀工具不允許 {k} 階段" => "Read-only tool: the {k} stage is not allowed",
        "唯讀工具不允許 Redis 命令 `{cmd}`；只放行讀取類命令（GET / HGETALL / SCAN / TTL …）" => {
            "Read-only tool: Redis command `{cmd}` is not allowed; only read commands (GET / HGETALL / SCAN / TTL …) are permitted"
        }
        "此連線種類不支援 run_query；請改用 list_tables / describe_table / sample_rows" => {
            "run_query is not supported for this connection kind; use list_tables / describe_table / sample_rows instead"
        }
        " | …（另有 {n} 欄未列出）" => " | …({n} more columns not shown)",
        "…（文字達 {kb} KB 上限，只顯示前 {shown} 列，共取回 {total} 列）" => "…(text hit the {kb} KB cap; showing the first {shown} of {total} fetched rows)",
        "（無結果集；rows_affected = {n}）" => "(no result set; rows_affected = {n})",
        "{label}：{n} 欄" => "{label}: {n} columns",
        "（無欄位資訊：資料表可能不存在，請用 list_tables 確認名稱）" => "(no column info: the table may not exist; confirm the name with list_tables)",
        "（另有 {n} 欄未列出）" => "({n} more columns not shown)",
        "索引：" => "Indexes:",
        "（無索引）" => "(no indexes)",
        "（無法取得索引資訊；請勿假設任何索引存在）" => "(index info unavailable; do not assume any index exists)",
        "外鍵：" => "Foreign keys:",
        "（無外鍵）" => "(no foreign keys)",
        "（無法取得外鍵資訊）" => "(foreign key info unavailable)",
        "…（內容過長，其餘已截斷）" => "…(content too long; the rest was truncated)",
        "…（共 {total} 筆，只列前 {n} 筆）" => "…({total} in total; only the first {n} listed)",
        "未指定 database：請先呼叫 list_databases，再以 database 參數指定" => "No database given: call list_databases first, then pass the database parameter",
        "工具逾時（{ms} ms）；請縮小查詢範圍或加 LIMIT" => "Tool timed out ({ms} ms); narrow the query or add LIMIT",
        "（此連線沒有可列出的資料庫）" => "(this connection has no databases to list)",
        "（此資料庫沒有資料表）" => "(this database has no tables)",
        "缺少 table" => "Missing table",
        "\n（樣本 {n} 列）" => "\n({n} sample rows)",
        "缺少 query" => "Missing query",
        "\n（顯示 {n} 列；結果已在 {cap} 列處截斷，需要更多請縮小範圍或加條件）" => "\n({n} rows shown; the result was cut at {cap} rows — narrow the query or add conditions for more)",
        "\n（共 {n} 列）" => "\n({n} rows)",
        "此連線種類不支援 explain_query" => "explain_query is not supported for this connection kind",

        // ---- llm/tools.rs ----
        "此對話未附帶資料庫連線，無法使用資料庫工具" => "No database connection is attached to this conversation, so database tools are unavailable",

        // ---- agent.rs：資料庫工具指引 ----
        "{kind} 連線，目前資料庫：{db}" => "{kind} connection, current database: {db}",
        "{kind} 連線" => "{kind} connection",
        "【資料庫工具】你可以用這些工具直接讀取使用者目前在 db-kit 的 {target}：{names}。全部唯讀。寫查詢前先用 describe_table 確認欄名與型別；查詢一律加 LIMIT；不要猜測不存在的表或欄位，先 list_tables。需要看資料時直接呼叫工具，不要請使用者代跑；回答時附上你實際執行的查詢。" => {
            "[Database tools] You can use these tools to read the user's current {target} in db-kit directly: {names}. All read-only. Call describe_table to confirm column names and types before writing a query; always add LIMIT; never guess tables or columns — list_tables first. When you need data, call the tools yourself instead of asking the user to run queries; include the queries you actually ran in your answer."
        }
        "此連線是正式環境：查詢保持輕量（小 LIMIT、避免全表掃描、不要重複同一條查詢）。" => {
            "This connection is production: keep queries light (small LIMIT, no full scans, do not repeat the same query)."
        }

        // ---- review_run/ + cli/run_script.rs：審查並執行 ----
        "此連線種類不支援審查並執行" => "Review & run is not supported for this connection type",
        "無法判斷目前的資料庫，請先選擇資料庫" => "Unable to determine the current database; please select one first",
        "擷取查詢未通過唯讀檢查，已中止：{sql}" => "The capture query failed the read-only check and was aborted: {sql}",
        "讀不到資料表 {table} 的欄位" => "Unable to read the columns of table {table}",
        "擷取查詢回傳的欄數不符（預期 {want}，實得 {got}）" => "The capture query returned an unexpected number of columns (expected {want}, got {got})",
        "主鍵最大值不是整數：{v}" => "The maximum key value is not an integer: {v}",
        "無法解讀列數：{v}" => "Unable to parse the row count: {v}",
        "含交易控制語句（BEGIN / COMMIT / ROLLBACK）。本流程逐句自動提交，交易控制會落在連線池的不同連線上，請移除後再執行。" => "Contains transaction control (BEGIN / COMMIT / ROLLBACK). This flow autocommits statement by statement, so transaction control would land on different pooled connections. Remove it and try again.",
        "含切換 session 狀態的語句（USE / SET / DECLARE / 暫存表 / LOCK）。連線池不保證下一句用同一條連線，請移除或改在查詢分頁執行。" => "Contains session-state statements (USE / SET / DECLARE / temporary tables / LOCK). The connection pool does not guarantee the next statement uses the same connection. Remove them or run the script in a query tab.",
        "含程序 / 函式 / 觸發器本體，逐句切分不可靠。請改在查詢分頁執行。" => "Contains a procedure / function / trigger body, which cannot be split into statements reliably. Run it in a query tab instead.",
        "仍含未代入的具名參數（:name）。" => "Still contains unresolved named parameters (:name).",
        "DROP DATABASE / SCHEMA 無法以本流程備份，請先用「備份」做完整傾印。" => "DROP DATABASE / SCHEMA cannot be backed up by this flow. Take a full dump with Backup first.",
        "呼叫預存程序：程序內容無法分析，這句沒有回滾。" => "Calls a stored procedure: its body cannot be analyzed, so this statement has no rollback.",
        "可寫 CTE（WITH … DELETE / UPDATE / INSERT）：無法安全擷取前像，這句沒有回滾。" => "Writable CTE (WITH … DELETE / UPDATE / INSERT): the before-image cannot be captured safely, so this statement has no rollback.",
        "一句同時改動多張表（或 CASCADE 連帶影響其他表），只涵蓋主要目標表。" => "The statement changes several tables (or cascades to other tables); only the main target table is covered.",
        "無法解析這句的目標與條件，這句沒有回滾。" => "Unable to parse this statement's target and condition, so it has no rollback.",
        "權限 / 使用者 / 序列等變更不會自動產生反向語句，需手動回復。" => "No reverse statement is generated for permission / user / sequence changes; revert them manually.",
        "沒有可執行的語句" => "No executable statements",
        "前面第 {n} 句也改動了 {table}：列數估算以目前狀態為準，實際執行時會在這句前重新擷取。" => "Statement {n} also changes {table}: the row estimate reflects the current state; the before-image is re-captured right before this statement runs.",
        "探測失敗：{err}" => "Probe failed: {err}",
        "{table} 的欄位 {cols} 型別無法以字面值無損還原；這些欄位有值的列不會自動回滾。" => "Columns {cols} of {table} have types that cannot be restored losslessly as literals; rows with values in them are not rolled back automatically.",
        "找不到資料表 {table}（資料庫 {db}）" => "Table {table} not found (database {db})",
        "{table} 受影響約 {rows} 列，超過擷取上限 {cap} 列：前像無法完整備份。" => "About {rows} rows of {table} are affected, over the capture limit of {cap}: the before-image cannot be fully backed up.",
        "{table} 沒有主鍵或唯一鍵：無法定位被修改的列，這句沒有回滾。" => "{table} has no primary or unique key: changed rows cannot be located, so this statement has no rollback.",
        "這句修改了鍵欄位 {cols}：執行後無法依原鍵找回這些列，這句沒有回滾。" => "This statement changes key columns {cols}: the rows cannot be found by their old keys afterwards, so it has no rollback.",
        "{table} 沒有主鍵且語句含 JOIN：同一列可能被重複擷取。" => "{table} has no primary key and the statement joins other tables: the same row may be captured more than once.",
        "新增的列以「{key} 大於執行前最大值」認定；若執行期間有其他連線同時新增，回滾腳本會把那些列標為需人工確認。" => "Inserted rows are identified as \"{key} greater than the maximum before execution\"; if another connection inserts at the same time, the rollback script marks those rows for manual review.",
        "無法從語句判斷新增了哪些列，而 {table} 有 {rows} 列、超過擷取上限 {cap}：這句沒有回滾。" => "The inserted rows cannot be determined from the statement, and {table} has {rows} rows, over the capture limit of {cap}: this statement has no rollback.",
        "{table} 沒有主鍵或唯一鍵：新增的列無法精確刪除。" => "{table} has no primary or unique key: inserted rows cannot be deleted precisely.",
        "{table} 沒有主鍵或唯一鍵：只能還原被刪除的列，修改與新增無法精確還原。" => "{table} has no primary or unique key: only deleted rows can be restored; updates and inserts cannot be reverted precisely.",
        "無法判斷索引屬於哪張表，而資料庫有 {n} 張表（上限 {cap}）：這句沒有回滾。" => "Unable to tell which table the index belongs to, and the database has {n} tables (limit {cap}): this statement has no rollback.",
        "無法從語句判斷索引屬於哪張表，會擷取整個資料庫（{n} 張表）的結構。" => "Unable to tell from the statement which table the index belongs to; the structure of the whole database ({n} tables) will be captured.",
        "{table} 有 {rows} 列，超過擷取上限 {cap}：結構可以還原，資料不行。" => "{table} has {rows} rows, over the capture limit of {cap}: the structure can be restored, the data cannot.",
        "{table} 沒有主鍵或唯一鍵：結構變更造成的資料改變無法逐列還原。" => "{table} has no primary or unique key: data changes caused by the structure change cannot be restored row by row.",
        "不需要" => "Not needed",
        "完整" => "Full",
        "部分" => "Partial",
        "無" => "None",
        "只產生備份（未執行）" => "Backup only (not executed)",
        "已完成" => "Completed",
        "執行失敗" => "Execution failed",
        "已中止" => "Stopped",
        "未執行" => "Not run",
        "成功" => "Succeeded",
        "可以執行" => "Safe to run",
        "注意風險後再執行" => "Run after reviewing the risks",
        "不建議執行" => "Not recommended",
        "審查並執行報告" => "Review & Run Report",
        "項目" => "Item",
        "內容" => "Value",
        "狀態" => "Status",
        "原因" => "Reason",
        "資料庫種類" => "Engine",
        "資料庫" => "Database",
        "正式環境" => "Production",
        "是" => "Yes",
        "否" => "No",
        "開始" => "Started",
        "結束" => "Finished",
        "擷取上限（列 / 句）" => "Capture limit (rows / statement)",
        "AI 審查結論" => "AI review verdict",
        "語句" => "Statement",
        "影響列數" => "Rows affected",
        "回滾" => "Rollback",
        "前後差異" => "Before / after",
        "{table}：改 {u} / 增 {i} / 刪 {d}" => "{table}: {u} updated / {i} inserted / {d} deleted",
        "注意事項" => "Notes",
        "檔案" => "Files",
        "rollback.sql 依「最後一句先還原」排列；被註解掉的語句代表無法確定能安全還原，請人工確認後再取消註解。" => "rollback.sql is ordered last statement first; commented-out statements could not be confirmed safe to restore — review them before uncommenting.",
        "執行前後差異" => "Before / After Differences",
        "連線 {conn} · 資料庫 {db} · {at}" => "Connection {conn} · Database {db} · {at}",
        "（沒有擷取到任何差異）" => "(No differences captured)",
        "狀態：{status}，影響 {n} 列" => "Status: {status}, {n} rows affected",
        "結構變更（回滾用的反向 DDL）" => "Structure changes (reverse DDL for rollback)",
        "修改 {u}、新增 {i}、刪除 {d}、未變 {n}" => "{u} updated, {i} inserted, {d} deleted, {n} unchanged",
        "前像或後像超過擷取上限，差異不完整。" => "The before- or after-image exceeded the capture limit; the differences are incomplete.",
        "此表沒有主鍵或唯一鍵，只能以整列內容比對增刪，無法判斷哪一列被修改。" => "This table has no primary or unique key: rows are compared by their full contents, so inserts and deletes are detected but not which row was updated.",
        "執行後已不存在的欄位：{cols}" => "Columns that no longer exist after execution: {cols}",
        "執行後新增的欄位：{cols}" => "Columns added by execution: {cols}",
        "鍵" => "Key",
        "欄位" => "Column",
        "執行前" => "Before",
        "執行後" => "After",
        "欄位已刪除" => "column dropped",
        "…另有 {n} 列修改未列出，完整內容見 snapshots/ 目錄。" => "…{n} more updated rows not listed; see snapshots/ for the full data.",
        "刪除的列" => "Deleted rows",
        "新增的列" => "Inserted rows",
        "…另有 {n} 列未列出，完整內容見 snapshots/ 目錄。" => "…{n} more rows not listed; see snapshots/ for the full data.",
        "欄位 {col} 的值無法以 SQL 字面值無損還原（型別 {ty}）" => "The value of column {col} cannot be restored losslessly as a SQL literal (type {ty})",
        "此表有 GENERATED ALWAYS 的 identity 欄，Oracle 不接受明確值；以下 INSERT 可能被拒絕，屆時請改用 BY DEFAULT 或手動處理。" => "This table has a GENERATED ALWAYS identity column and Oracle rejects explicit values; the INSERTs below may fail — switch it to BY DEFAULT or handle them manually.",
        "（此列的 INSERT 無法產生）" => "(Unable to generate the INSERT for this row)",
        "警告：前像或後像超過擷取上限而被截斷，以下回滾只涵蓋已擷取到的列。" => "Warning: the before- or after-image was truncated at the capture limit; the rollback below only covers the captured rows.",
        "此表沒有主鍵或唯一鍵，無法精確定位要刪除的列" => "This table has no primary or unique key, so the rows to delete cannot be located precisely",
        "（此列的 DELETE 無法產生）" => "(Unable to generate the DELETE for this row)",
        "（此列的 UPDATE 無法產生）" => "(Unable to generate the UPDATE for this row)",
        "UPDATE 之後依主鍵找不到這列（主鍵可能被改掉，或被觸發器刪除），補回可能造成重複資料" => "This row cannot be found by its primary key after the UPDATE (the key may have changed, or a trigger deleted it); re-inserting it may create duplicates",
        "警告：符合的列超過擷取上限，只備份了前 {n} 列；以下回滾不完整。" => "Warning: the matching rows exceed the capture limit and only the first {n} were backed up; the rollback below is incomplete.",
        "此表沒有主鍵或唯一鍵，無法定位要還原的列" => "This table has no primary or unique key, so the rows to restore cannot be located",
        "整表還原：先清空，再寫回備份當下的所有列。" => "Whole-table restore: clear the table, then write back every row from the backup.",
        "（這句不需要或無法產生回滾語句）" => "(This statement needs no rollback, or none could be generated)",
        "需人工確認" => "Review manually",
        "請指定輸出目錄" => "Please specify an output folder",
        "無法建立輸出目錄 {dir}：{e}" => "Unable to create the output folder {dir}: {e}",
        "目標：{target}　回滾：{level}" => "Target: {target}  Rollback: {level}",
        "新增了哪些列要執行後才知道；這段回滾會在執行後產生。" => "Which rows get inserted is only known after execution; this part of the rollback is generated afterwards.",
        "這句沒有自動產生的回滾，請依上方說明手動處理。" => "No rollback was generated for this statement; handle it manually as described above.",
        "無法自動產生：{what}" => "Could not be generated automatically: {what}",
        "{name} 是這句新建的程序 / 函式，請手動刪除。" => "{name} is a procedure / function created by this statement; drop it manually.",
        "結構變更的精確反向 DDL 要執行後才能產生；以下是執行前的定義，供手動還原參考。" => "The exact reverse DDL can only be generated after execution; the definitions before execution are listed below for manual restore.",
        "{name} 執行前的定義" => "Definition of {name} before execution",
        "{table} 的資料前像（{n} 列）已存於 snapshots/；精確的資料還原語句會在執行後產生。" => "The before-image of {table} ({n} rows) is saved in snapshots/; exact data restore statements are generated after execution.",
        "此表沒有主鍵或唯一鍵：假設前像中的列全部受到影響。" => "This table has no primary or unique key: all rows in the before-image are assumed to be affected.",
        "前像的鍵值無法還原成字面值，改用執行前的預估回滾。" => "The key values in the before-image cannot be turned into literals; using the pre-execution estimated rollback instead.",
        "此表沒有主鍵或唯一鍵，無法比對修改。" => "This table has no primary or unique key, so updates cannot be compared.",
        "這句回報新增 {n} 列，但依主鍵範圍找到 {found} 列：可能混入其他連線同時新增的列" => "The statement reported {n} inserted rows but {found} were found by key range: rows inserted concurrently by other connections may be included",
        "腳本含本流程不支援的語句，未執行任何動作：\n{list}" => "The script contains statements this flow does not support; nothing was run:\n{list}",
        "db-kit 回滾腳本" => "db-kit rollback script",
        "連線：{conn}　資料庫：{db}　種類：{kind}　產生時間：{at}" => "Connection: {conn}  Database: {db}  Engine: {kind}  Generated: {at}",
        "依執行前後的前後像比對產生；某句若拿不到後像，該段改用執行前的預估。" => "Generated by comparing before- and after-images; where an after-image could not be captured, that part falls back to the pre-execution estimate.",
        "依執行前的前像產生（腳本尚未執行）：UPDATE 整列寫回、DELETE 補回；前後相依的語句請人工確認。" => "Generated from before-images (the script has not run): UPDATEs write whole rows back and DELETEs are re-inserted; review statements that depend on each other manually.",
        "【執行中】這是執行過程中的暫存版本，只涵蓋到目前這句為止。" => "[IN PROGRESS] Interim version written during execution; it only covers statements up to the current one.",
        "最後一句排在最前面，請由上往下執行。被註解掉的語句需人工確認後再取消註解。" => "The last statement comes first; run from top to bottom. Review commented-out statements before uncommenting them.",
        "這是正式環境連線，需要明確確認才能執行。" => "This is a production connection; explicit confirmation is required to run.",
        "有語句沒有完整回滾，需要明確確認才能執行。" => "Some statements have no complete rollback; explicit confirmation is required to run.",
        "執行到第 {n} 句時，它的回滾等級降為「{level}」，已停在這句之前。" => "When execution reached statement {n}, its rollback level dropped to \"{level}\"; stopped before it.",
        "擷取前像失敗：{err}" => "Failed to capture the before-image: {err}",
        "第 {n} 句：{msg}" => "Statement {n}: {msg}",
        "第 {n} 句的前像超過擷取上限 {cap} 列，已停在這句之前。" => "The before-image of statement {n} exceeds the capture limit of {cap} rows; stopped before it.",
        "這句執行失敗，資料庫沒有套用它的變更，不需要回滾。" => "This statement failed and the database did not apply its changes; no rollback is needed.",
        "第 {n} 句執行失敗：{err}" => "Statement {n} failed: {err}",
        "擷取後像失敗，這句的回滾改用執行前的預估：{err}" => "Failed to capture the after-image; this statement's rollback falls back to the pre-execution estimate: {err}",
        "輸出目錄必須是絕對路徑" => "The output folder must be an absolute path",
        "不是審查並執行的輸出目錄：{path}" => "Not a review & run output folder: {path}",
        "讀取 stdin 失敗：{e}" => "Failed to read stdin: {e}",
        "讀取腳本 {path} 失敗：{e}" => "Failed to read script {path}: {e}",
        "無法啟動審查指令：{e}" => "Unable to start the review command: {e}",
        "無法把提示寫給審查指令：{e}" => "Unable to write the prompt to the review command: {e}",
        "審查指令結束碼 {code}" => "The review command exited with code {code}",
        "資料庫：{db}　語句：{n}　擷取上限：{cap} 列 / 句" => "Database: {db}  Statements: {n}  Capture limit: {cap} rows / statement",
        "約 {rows} 列" => "~{rows} rows",
        "✗ 第 {n} 句：{msg}" => "✗ Statement {n}: {msg}",
        "腳本含本流程不支援的語句，未執行任何動作" => "The script contains statements this flow does not support; nothing was run",
        "AI 審查中…" => "AI review in progress…",
        "AI 審查結論：{v}" => "AI review verdict: {v}",
        "審查指令沒有輸出任何內容" => "The review command produced no output",
        "執行腳本" => "run the script",
        "AI 審查結論為 STOP：只產生備份、不執行（確定要執行請加 --ignore-verdict）" => "The AI review verdict is STOP: backup only, not executed (add --ignore-verdict to run anyway)",
        "未加 --yes：只產生審查與備份，不執行。" => "No --yes: generating the review and backup only, not executing.",
        "目標連線標記為正式環境，請再加 --allow-prod 確認" => "The target connection is marked as production; add --allow-prod to confirm",
        "有 {n} 句沒有完整回滾，未執行。確認可以接受請再加 --allow-incomplete" => "{n} statements have no complete rollback; not executed. Add --allow-incomplete if that is acceptable",
        "#{n} 擷取前像 {detail}" => "#{n} capturing before-image {detail}",
        "#{n} 執行" => "#{n} executing",
        "#{n} 擷取後像" => "#{n} capturing after-image",
        "輸出目錄：{dir}" => "Output folder: {dir}",
        "審查並執行 SQL 腳本：逐句擷取前後像、產生回滾腳本與差異報告到輸出目錄。未加 --yes 只產生審查與備份" => "Review and run a SQL script: capture before/after images per statement and write a rollback script and diff report to the output folder. Without --yes, only the review and backup are generated",
        "SQL 腳本檔（- = 從 stdin 讀）" => "SQL script file (- = read from stdin)",
        "輸出目錄：每次在底下建立一個子目錄，放腳本、審查、回滾腳本、前後像與報告" => "Output folder: each run creates a subfolder with the script, review, rollback script, before/after images and reports",
        "AI 審查指令：審查提示從 stdin 餵入、stdout 存成 review.md（如 \"claude -p\"）" => "AI review command: the review prompt is fed on stdin and stdout is saved as review.md (e.g. \"claude -p\")",
        "附給 AI 的前像樣本列數（0 = 不附資料，只給結構與列數）" => "Sample rows from the before-image to include for the AI (0 = no data, only structure and row counts)",
        "只把審查提示印到 stdout 後結束（不擷取、不執行）" => "Print the review prompt to stdout and exit (no capture, no execution)",
        "每句前像的擷取上限（列）" => "Before-image capture limit per statement (rows)",
        "接受「有語句沒有完整回滾」仍執行" => "Run even if some statements have no complete rollback",
        "目標連線標記為正式環境時，執行需加上此旗標" => "Required to run when the target connection is marked as production",
        "AI 審查結論為 STOP 時仍執行（預設只產生備份）" => "Run even if the AI review verdict is STOP (default: backup only)",

        // ---- ssh/（終端機 / SFTP / 認證）+ commands/ssh.rs ----
        "SSH 認證失敗：{detail}" => "SSH authentication failed: {detail}",
        "SSH 主機金鑰驗證失敗：{detail}" => "SSH host key verification failed: {detail}",
        "使用者已取消 SSH 連線" => "The SSH connection was cancelled by the user",
        "SFTP 錯誤：{detail}" => "SFTP error: {detail}",
        "此連線未啟用 SSH" => "SSH is not enabled for this connection",
        "未填寫 SSH 使用者名稱" => "SSH username is empty",
        "找不到 SSH 主機：{id}" => "SSH host not found: {id}",
        "SSH 連線不存在或已關閉" => "The SSH connection does not exist or has been closed",
        "終端機不存在或已關閉" => "The terminal does not exist or has been closed",
        "SFTP 工作階段不存在或已關閉" => "The SFTP session does not exist or has been closed",
        "同時開啟的 SSH 連線已達上限（{n}）" => "The limit of concurrent SSH connections ({n}) has been reached",
        "同時開啟的終端機已達上限（{n}）" => "The limit of concurrent terminals ({n}) has been reached",
        "找不到待回答的 SSH 提示（可能已逾時）" => "No pending SSH prompt found (it may have timed out)",
        "無法讀取 known_hosts，為防中間人而拒絕連線：{e}" => "Cannot read known_hosts; connection refused to prevent a man-in-the-middle attack: {e}",
        "無法保存 host key 指紋：{e}" => "Failed to save the host key fingerprint: {e}",
        "{host} 的主機金鑰與已記錄的指紋不符，已拒絕連線（可能遭中間人攻擊）" => "The host key of {host} does not match the recorded fingerprint; connection refused (possible man-in-the-middle attack)",
        "未信任 {host} 的主機金鑰" => "The host key of {host} was not trusted",
        "ssh-agent" => "ssh-agent",
        "公鑰" => "public key",
        "密碼" => "Password",
        "鍵盤互動" => "keyboard-interactive",
        "沒有可用的認證方式" => "No usable authentication method",
        "沒有可用的認證方式（{detail}）" => "No usable authentication method ({detail})",
        "伺服器接受了 {methods} 但要求進一步認證" => "The server accepted {methods} but requires further authentication",
        "伺服器拒絕了 {methods} 認證（帳號 / 密碼 / 金鑰不正確）" => "The server rejected {methods} authentication (incorrect username / password / key)",
        "找不到 ssh-agent" => "ssh-agent not found",
        "ssh-agent 讀取金鑰清單失敗：{e}" => "Failed to list keys from ssh-agent: {e}",
        "ssh-agent 沒有任何金鑰" => "ssh-agent holds no keys",
        "私鑰 {path} 受密語保護" => "The private key {path} is protected by a passphrase",
        "私鑰密語" => "Private key passphrase",
        "請輸入 {label} 的密碼" => "Enter the password for {label}",
        "伺服器要求互動輸入，但目前模式無法詢問使用者" => "The server requires interactive input, but the current mode cannot prompt the user",
        "等待 OpenSSH agent named pipe 逾時" => "Timed out waiting for the OpenSSH agent named pipe",
        "OpenSSH agent：{a}；Pageant：{b}" => "OpenSSH agent: {a}; Pageant: {b}",
        "開啟 SSH 通道失敗：{e}" => "Failed to open an SSH channel: {e}",
        "要求 PTY 失敗：{e}" => "PTY request failed: {e}",
        "伺服器拒絕配置 PTY" => "The server refused to allocate a PTY",
        "要求 shell 失敗：{e}" => "Shell request failed: {e}",
        "伺服器拒絕開啟 shell" => "The server refused to start a shell",
        "送出啟動指令失敗：{e}" => "Failed to send the startup command: {e}",
        "寫入終端機失敗：{e}" => "Failed to write to the terminal: {e}",
        "調整終端機大小失敗：{e}" => "Failed to resize the terminal: {e}",
        "SSH 通道已被伺服器關閉" => "The SSH channel was closed by the server",
        "等待伺服器回覆逾時" => "Timed out waiting for the server's reply",
        "無效的 base64 輸入" => "Invalid base64 input",
        "要求 sftp 子系統失敗：{e}" => "sftp subsystem request failed: {e}",
        "拒絕刪除根目錄或目前目錄" => "Refusing to delete the root or current directory",
        "資料夾內的項目超過 {max} 個，請改用終端機（例如 tar）處理" => "The folder contains more than {max} items; use the terminal (for example tar) instead",
        "遠端已有同名檔案，無法建立資料夾：{path}" => "A file with the same name exists on the remote, so the folder cannot be created: {path}",
        "遠端已有同名項目：{path}" => "An item with the same name already exists on the remote: {path}",
        "本機已有同名資料夾：{path}" => "A local folder with the same name already exists: {path}",
        "寫入記錄檔 {path} 失敗：{e}" => "Failed to write the log file {path}: {e}",
        "寫入 SSH 操作紀錄失敗（{path}）：{e}" => "Failed to write the SSH activity log ({path}): {e}",
        "跳板機設定形成迴圈（A 經 B、B 又經 A），請檢查主機設定" => "The jump host settings form a loop (A via B, B via A); check the host settings",
        "跳板機超過 {n} 層（可能設定成互相跳轉）" => "More than {n} levels of jump hosts (they may point at each other)",
        "找不到設定的跳板機（可能已刪除），請到主機設定重新選擇" => "The configured jump host was not found (it may have been deleted); choose it again in the host settings",
        "跳板機無法轉送到 {host}:{port}（跳板機可能不允許 TCP 轉送，或連不到目標）：{e}" => "The jump host cannot forward to {host}:{port} (it may not allow TCP forwarding, or cannot reach the target): {e}",
        "經跳板機連線逾時" => "Connecting through the jump host timed out",
        "多層跳板機（{via}）：只接最後一台，前面幾層請到那台主機的設定裡設跳板機" => "Multi-hop jump ({via}): only the last host is linked; set the earlier hops in that host's settings",
        "有 ProxyJump（{via}）：跳板機目前還不支援，匯入後直連可能連不上" => "Uses ProxyJump ({via}): jump hosts aren't supported yet, a direct connection may fail",
        "有 ProxyCommand：目前還不支援，匯入後直連可能連不上" => "Uses ProxyCommand: not supported yet, a direct connection may fail",
        "有連接埠轉送設定：目前還不支援，不會一起匯入" => "Has port forwarding: not supported yet, not imported",
        "沒有設定 User，先用本機帳號 {user}" => "No User set; using the local account {user}",
        "Port 設定看不懂，先用 22" => "Unreadable Port; using 22",
        "設定了 {n} 把私鑰，先用第一把" => "{n} private keys configured; using the first",
        "讀不到 {path}：{e}" => "Cannot read {path}: {e}",
        "工作階段沒有存使用者名稱，匯入後請補上" => "The session has no user name; fill it in after importing",
        "用的是原軟體金鑰庫裡的金鑰「{key}」：請先在原本的軟體把它匯出成 OpenSSH 格式，再匯入 db-kit 的金鑰庫（同名的金鑰匯入時會自動對上）" => "Uses the key \"{key}\" from the original tool's key store: export it from that tool as OpenSSH, then import it into the db-kit key store (a key with the same name is matched automatically)",
        "找不到預設的 .xsh 工作階段資料夾，請手動選擇" => "Default .xsh sessions folder not found; choose it manually",
        "不是資料夾：{path}" => "Not a folder: {path}",
        "讀不到憑證 {path}：{e}" => "Cannot read certificate {path}: {e}",
        "{detail}；另外略過：{skipped}" => "{detail}; also skipped: {skipped}",
        "密語不正確，請再輸入一次（{path}）" => "Wrong passphrase, please try again ({path})",
        "PEM 標示為加密，卻沒有 DEK-Info" => "The PEM is marked as encrypted but has no DEK-Info",
        "不支援的 PEM 加密方式：{name}（可支援 DES-EDE3-CBC、DES-CBC、AES-128/192/256-CBC）" => "Unsupported PEM encryption: {name} (supported: DES-EDE3-CBC, DES-CBC, AES-128/192/256-CBC)",
        "PEM 的 DEK-Info IV 格式錯誤" => "Malformed DEK-Info IV in the PEM",
        "DSA（ssh-dss）金鑰：OpenSSH 7.0 起預設停用、9.8 起移除，多數伺服器已不接受。請改用 ed25519 或 RSA 3072 以上的金鑰。" => "DSA (ssh-dss) key: disabled by default since OpenSSH 7.0 and removed in 9.8; most servers no longer accept it. Use an ed25519 key or RSA 3072 or larger.",
        "SSH.COM（SECSH）格式的私鑰：請先轉成 OpenSSH 格式，例如 ssh-keygen -i -f <檔案> > id_key，或用 PuTTYgen 的 Import 再 Export OpenSSH key。" => "SSH.COM (SECSH) private key: convert it to OpenSSH format first, e.g. ssh-keygen -i -f <file> > id_key, or PuTTYgen Import then Export OpenSSH key.",
        "這是公鑰，不是私鑰。請選對應的私鑰檔（通常是同名、沒有 .pub 的那個）。" => "This is a public key, not a private key. Choose the matching private key file (usually the same name without .pub).",
        "這是 OpenSSH 憑證（-cert.pub），不是私鑰。請選對應的私鑰；憑證放在私鑰旁邊（<私鑰>-cert.pub）或在主機設定指定，連線時會一起使用。" => "This is an OpenSSH certificate (-cert.pub), not a private key. Choose the matching private key; put the certificate next to it (<key>-cert.pub) or set it on the host, and it is used when connecting.",
        "這是 X.509（SSL / TLS）憑證，不是 SSH 金鑰。SSH 要用的是私鑰檔（例如 id_ed25519、.ppk、.pem）。" => "This is an X.509 (SSL / TLS) certificate, not an SSH key. SSH needs a private key file (e.g. id_ed25519, .ppk, .pem).",
        "看起來是 PKCS#12（.pfx / .p12）憑證包或加密的二進位私鑰。請先轉出 PEM 私鑰，例如 openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem。" => "This looks like a PKCS#12 (.pfx / .p12) bundle or an encrypted binary key. Export a PEM private key first, e.g. openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem.",
        "認不得的金鑰格式。支援 OpenSSH、PuTTY PPK、PKCS#8、PEM（PKCS#1 RSA / SEC1 EC，含 OpenSSL 加密）與 DER；Xshell / SecureCRT 的金鑰請先在該軟體裡匯出成 OpenSSH 格式。" => "Unrecognised key format. Supported: OpenSSH, PuTTY PPK, PKCS#8, PEM (PKCS#1 RSA / SEC1 EC, including OpenSSL encryption) and DER; export Xshell / SecureCRT keys as OpenSSH first.",
        "這把私鑰受密語保護，請輸入密語" => "This private key is passphrase-protected; enter the passphrase",
        "密語不正確（或不支援這種加密方式）：{e}" => "Wrong passphrase (or unsupported encryption): {e}",
        "無法解析私鑰：{e}" => "Cannot parse the private key: {e}",
        "解密後的內容不正確" => "The decrypted content is invalid",
        "憑證格式錯誤：{e}" => "Invalid certificate: {e}",
        "無效的金鑰 id：{id}" => "Invalid key id: {id}",
        "金鑰庫裡找不到這把金鑰（可能已刪除）：{id}" => "Key not found in the key store (it may have been deleted): {id}",
        "加密私鑰失敗：{e}" => "Failed to encrypt the private key: {e}",
        "轉成 OpenSSH 格式失敗：{e}" => "Failed to convert to OpenSSH format: {e}",
        "產生金鑰失敗：{e}" => "Failed to generate the key: {e}",
        "名稱不能是空的" => "The name cannot be empty",
        "讀不到公鑰" => "Cannot read the public key",
        "這張憑證簽的不是這把金鑰" => "This certificate was not issued for this key",
        "本機已有同名項目：{path}" => "An item with the same name already exists locally: {path}",
        "略過 {n} 個同名項目" => "Skipped {n} existing items",
        "略過 {n} 個連結或特殊檔案" => "Skipped {n} links or special files",
        "略過 {a} 個同名項目、{b} 個連結或特殊檔案" => "Skipped {a} existing items and {b} links or special files",
        "內容太大，無法在編輯器存檔（上限 {max} MiB）" => "The content is too large to save from the editor (limit {max} MiB)",
        "伺服器回傳可疑的檔名，已中止刪除：{name}" => "The server returned a suspicious file name; deletion aborted: {name}",
        "本機檔案已存在：{path}" => "The local file already exists: {path}",
        "遠端檔案已存在：{path}" => "The remote file already exists: {path}",
        "無效的檔名：{name}" => "Invalid file name: {name}",
        "找不到檔案或目錄" => "No such file or directory",
        "權限不足" => "Permission denied",
        "伺服器不支援此操作" => "The server does not support this operation",
        "SFTP 連線已中斷" => "The SFTP connection was lost",
        "已到檔案結尾" => "End of file reached",
        "SFTP 協定錯誤" => "SFTP protocol error",
        "操作失敗（伺服器未說明原因；常見為檔案已存在或目錄非空）" => "Operation failed (the server gave no reason; commonly the file already exists or the directory is not empty)",
        "SFTP 操作逾時" => "SFTP operation timed out",
        "SFTP I/O 錯誤：{e}" => "SFTP I/O error: {e}",
        "SFTP 錯誤：{e}" => "SFTP error: {e}",
        "本機檔案錯誤：{e}" => "Local file error: {e}",
        // ---- ai_library / DBA 審查 ----
        "DBA agent 審查需要已連線的資料庫連線；請先連線，或改用一次性審查" => "A DBA agent review needs a connected database connection; connect first, or use a one-shot review",
        "找不到資源庫層：{id}" => "Library layer not found: {id}",
        "「{label}」是唯讀的，請改存到個人或可寫的團隊資料夾" => "\"{label}\" is read-only; save to the personal layer or a writable team folder instead",
        "建立資料夾失敗：{e}" => "Failed to create the folder: {e}",
        "名稱「{name}」不合法：只能用英數、連字號、底線與點，且以英數開頭" => "Invalid name \"{name}\": use only letters, digits, hyphens, underscores and dots, starting with a letter or digit",
        "不支援的語言：{lang}" => "Unsupported language: {lang}",
        "輸出契約不能修改（解析器依賴它）" => "Output contracts cannot be changed (parsers depend on them)",
        "檔案已存在：{path}" => "File already exists: {path}",
        "輸出契約不能複製（解析器依賴它）" => "Output contracts cannot be copied (parsers depend on them)",
        "找不到：{name}" => "Not found: {name}",
        "「{label}」裡沒有 {name}" => "\"{label}\" has no {name}",
        "刪除失敗：{e}" => "Delete failed: {e}",
        "內建" => "Built-in",
        "檔案超過 {n} 個，其餘未載入" => "More than {n} files; the rest were not loaded",
        "檔案過大（超過 512 KB），已略過" => "File too large (over 512 KB); skipped",
        "不是 UTF-8 文字檔，已略過" => "Not a UTF-8 text file; skipped",
        "缺少 frontmatter（--- 包起來的 name / description）" => "Missing frontmatter (name / description between --- lines)",
        "同一層重複的檔案，已略過" => "Duplicate file in the same layer; skipped",
        "只有語言變體、沒有基底檔，已略過" => "Only language variants and no base file; skipped",
        "技能名稱「{name}」與資料夾名稱「{dir}」不同；Agent Skills 標準要求兩者一致" => "Skill name \"{name}\" differs from its folder name \"{dir}\"; the Agent Skills standard requires them to match",
        "同一層有兩個同名的項目，後者已略過" => "Two items with the same name in one layer; the later one was skipped",
        "資料夾不存在" => "Folder does not exist",
        "輸出契約只認內建版本（解析器依賴它），這個檔案不會生效" => "Only the built-in output contract is used (parsers depend on it); this file has no effect",
        "名稱建議只用小寫英數與連字號（Claude Code / Agent Skills 慣例）；否則同步到外部工具時可能被略過" => "Use only lowercase letters, digits and hyphens in names (Claude Code / Agent Skills convention); otherwise external tools may skip it after syncing",
        "缺少 description；Claude Code 與 Codex 會略過沒有說明的項目" => "Missing description; Claude Code and Codex skip items without one",
        "預載的技能「{s}」不存在" => "Preloaded skill \"{s}\" does not exist",
        "沒有任何功能使用這個範本（名稱不是內建的任務）" => "No feature uses this template (its name is not a built-in task)",
        "區段沒有配對好：{tag}" => "Unbalanced section: {tag}",
        "未知的變數 {tag}（這個任務不提供它，會輸出空字串）" => "Unknown variable {tag} (this task does not provide it; it renders as an empty string)",
        "沒有輸出必要變數 {tag}，送出時會自動附在最後" => "Required variable {tag} is not output; it will be appended at the end when sending",
        "範本沒放 {{contract}}，輸出契約會自動附在最後" => "The template has no {{contract}}; the output contract will be appended at the end",
        "技能" => "Skills",
        "個人" => "Personal",
        "團隊 {n}" => "Team {n}",
        "專案 {dir}" => "Project {dir}",
        "同步過去的 DBA 人設使用 mcp__dbkit__* 資料庫工具。要在 Claude Code / Codex 裡直接使用，先把 dbk 的 MCP 伺服器註冊進去：Claude Code 執行 `claude mcp add dbkit -- dbk --conn <連線名稱> mcp`；Codex 在 ~/.codex/config.toml 加上 [mcp_servers.dbkit]，command = \"dbk\"、args = [\"--conn\", \"<連線名稱>\", \"mcp\"]。" => "Synced DBA personas use the mcp__dbkit__* database tools. To use them directly in Claude Code / Codex, register dbk's MCP server first: in Claude Code run `claude mcp add dbkit -- dbk --conn <connection name> mcp`; in Codex add [mcp_servers.dbkit] to ~/.codex/config.toml with command = \"dbk\" and args = [\"--conn\", \"<connection name>\", \"mcp\"].",
        "請用「種類/名稱」指定，例如 agent/dba-senior、prompt/review-sql" => "Use \"kind/name\", for example agent/dba-senior or prompt/review-sql",
        "未知的種類：{k}（agent | skill | prompt | contract）" => "Unknown kind: {k} (agent | skill | prompt | contract)",
        "設定檔" => "Settings file",
        "資料夾不存在：{dir}" => "Folder does not exist: {dir}",
        "{e} 個錯誤、{w} 個警告" => "{e} errors, {w} warnings",
        "資源庫有 {n} 個錯誤" => "The library has {n} errors",
        "未加 --yes：只列出計畫，沒有寫入任何檔案。" => "No --yes: only the plan was listed; no files were written.",
        "已寫入 {w} 個、刪除 {d} 個、略過 {s} 個（衝突）" => "{w} written, {d} deleted, {s} skipped (conflicts)",
        "這次審查不允許使用 {name}（DBA 人設或隱私設定限制了可用的工具）" => "{name} is not allowed in this review (the DBA persona or privacy settings restrict the available tools)",
        "人設與技能" => "Persona and skills",
        "任務" => "Task",
        "AI 審查中（{who}）…" => "AI review in progress ({who})…",
        "{who} 的結論：{v}" => "Verdict from {who}: {v}",
        "會審結論（取最嚴格）：{v}" => "Panel verdict (strictest): {v}",
        "寫入 AI 資源庫設定失敗：{e}" => "Failed to write the AI library settings: {e}",
        "（已達工具呼叫回合上限，內容可能不完整）" => "(Tool-call turn limit reached; the content may be incomplete)",
        "【系統】已用完這次的工具呼叫額度：請根據目前取得的資訊直接給出結論，不要再呼叫工具。" => "[System] The tool-call budget for this review is used up: give your conclusion from the information gathered so far and do not call any more tools.",
        // ---- ssh/ftp.rs：FTP / FTPS ----
        "FTP 錯誤：{detail}" => "FTP error: {detail}",
        "TLS 設定錯誤：{e}" => "TLS configuration error: {e}",
        "{host} 的 TLS 憑證與先前信任的不同，已拒絕連線" => "The TLS certificate of {host} differs from the one trusted before; connection refused",
        "登入失敗：{msg}" => "Login failed: {msg}",
        "連線逾時" => "Connection timed out",
        "找不到主機 {host}：{e}" => "Host {host} not found: {e}",
        "找不到主機 {host}" => "Host {host} not found",
        "無法連線到 {host}：{e}" => "Couldn't connect to {host}: {e}",
        "伺服器不支援 FTPS（AUTH TLS 被拒：{msg}）" => "The server doesn't support FTPS (AUTH TLS was refused: {msg})",
        "FTP 連線已中斷" => "The FTP connection was lost",
        "FTP 傳輸逾時（伺服器沒有回應）" => "FTP transfer timed out (the server stopped responding)",
        "FTP 操作逾時" => "FTP request timed out",
        "未登入或帳號密碼錯誤" => "Not logged in, or wrong user name or password",
        "找不到檔案或目錄，或權限不足" => "File or directory not found, or permission denied",
        "伺服器空間不足" => "The server is out of storage space",
        "伺服器不接受這個檔名" => "The server doesn't accept this file name",
        "伺服器關閉了連線" => "The server closed the connection",
        "無法建立資料連線（可在主機設定切換主動 / 被動模式）" => "Couldn't open the data connection (try switching between active and passive mode in the host settings)",
        "伺服器回覆 {code}" => "The server replied {code}",
        "FTP 連線錯誤：{e}" => "FTP connection error: {e}",
        "TLS 錯誤：{e}" => "TLS error: {e}",
        "FTP 協定錯誤（伺服器的回覆格式不正確）" => "FTP protocol error (malformed server reply)",
        "伺服器回傳的資料連線位址無效：{e}" => "The server returned an invalid data connection address: {e}",
        "FTP 資料連線忙碌中" => "The FTP data connection is busy",
        "同時開啟的連線已達上限（{n}）" => "Too many open connections (limit {n})",

        // ---- filecmp/ + commands/filecmp.rs：檔案 / 資料夾 / 二進位比對 ----
        "比對錯誤：{detail}" => "Compare error: {detail}",
        "已取消比對" => "The comparison was cancelled",
        "無效的相對路徑：{rel}" => "Invalid relative path: {rel}",
        "{path}：{e}" => "{path}: {e}",
        "已有同名檔案，無法建立資料夾：{path}" => "A file with the same name exists, so the folder cannot be created: {path}",
        "不能刪除比對的根資料夾" => "The root folder of a comparison cannot be deleted",
        "項目超過 {max} 個，請改選範圍較小的資料夾或加上排除規則" => "More than {max} items. Choose a smaller folder or add exclude rules",
        "這是資料夾，不是檔案：{path}" => "This is a folder, not a file: {path}",
        "檔案在開啟之後已被修改：{path}" => "The file was modified after it was opened: {path}",
        "來源已不存在：{path}" => "The source no longer exists: {path}",

        "{n} 個檔案無法保留修改時間（FTP），重新比較時可能仍顯示時間不同" => "{n} files could not keep their modification time (FTP); comparing again may still show them as different",
        "{n} 段不同，共 {bytes} 個位元組（{a} / {b} bytes）" => "{n} differing ranges, {bytes} bytes in total ({a} / {b} bytes)",
        "{n} 項失敗" => "{n} items failed",
        "一邊是資料夾、一邊是檔案，無法比對" => "One side is a folder and the other is a file; they cannot be compared",
        "內容相同" => "The contents are identical",
        "兩個檔差異太大，無法逐行比對，請改用 --mode binary" => "The files differ too much to compare line by line; use --mode binary",
        "兩邊不同" => "The two sides differ",
        "兩邊已經一致，沒有需要處理的項目。" => "Both sides are already in sync; nothing to do.",
        "兩邊是資料夾，請改用資料夾比對" => "Both sides are folders; use a folder comparison",
        "同步 {left} ↔ {right}：複製 {c} 項、刪除 {d} 項" => "sync {left} ↔ {right}: copy {c} items, delete {d} items",
        "同步的兩邊都要是資料夾" => "Both sides of a sync must be folders",
        "失敗：{path}：{msg}" => "Failed: {path}: {msg}",
        "完成：複製 {c} 項、刪除 {d} 項" => "Done: copied {c} items, deleted {d} items",
        "寫入比對工作階段失敗：{e}" => "Failed to write saved comparisons: {e}",
        "找不到已存的比對：{name}" => "Saved comparison not found: {name}",
        "找不到：{path}" => "Not found: {path}",
        "檔案太大，無法逐行比對，請改用 --mode binary" => "The file is too large to compare line by line; use --mode binary",
        "比對工作階段檔案格式錯誤（{path}）：{e}" => "The saved comparisons file is malformed ({path}): {e}",
        "衝突（不處理）：{path}" => "Conflict (skipped): {path}",
        "請用 --rule 指定同步規則（mirror-lr / mirror-rl / update-lr / update-rl / update-both）" => "Choose a sync rule with --rule (mirror-lr / mirror-rl / update-lr / update-rl / update-both)",
        "請給左右兩邊的路徑，或用 --session 指定已存的比對" => "Give the left and right paths, or pick a saved comparison with --session",
        "警告：{side} 讀不到 {path}：{msg}" => "Warning: cannot read {path} on the {side} side: {msg}",
        "警告：無法比對內容 {path}：{msg}" => "Warning: could not compare the contents of {path}: {msg}",
        "讀取比對工作階段失敗：{e}" => "Failed to read saved comparisons: {e}",
        "資料夾比對的兩邊都要是資料夾" => "Both sides of a folder comparison must be folders",
        "比對兩個檔案或資料夾（本機路徑，或 ssh://<已存主機>/<路徑>）；檔案輸出 unified diff，資料夾列出不同的項目" => "Compare two files or folders (local paths, or ssh://<saved host>/<path>); files print a unified diff, folders list the differing items",
        "依規則同步兩個資料夾（鏡像 / 更新）。未加 --yes 只列出將執行的動作；會刪除檔案時另需 --force" => "Sync two folders by a rule (mirror / update). Without --yes it only lists what it would do; deleting files also needs --force",
        "大小與修改時間（預設）" => "Size and modification time (default)",
        "只看大小" => "Size only",
        "內容（逐位元組；遠端檔會先下載）" => "Contents (byte by byte; remote files are downloaded first)",
        "鏡像：讓右邊跟左邊一模一樣（覆蓋不同的、刪除只在右邊的）" => "Mirror: make the right side identical to the left (overwrite differences, delete right-only items)",
        "鏡像：讓左邊跟右邊一模一樣" => "Mirror: make the left side identical to the right",
        "把左邊較新或右邊沒有的檔複製到右邊，不刪除" => "Copy files that are newer on the left or missing on the right to the right; never delete",
        "把右邊較新或左邊沒有的檔複製到左邊，不刪除" => "Copy files that are newer on the right or missing on the left to the left; never delete",
        "兩邊互相補齊，不同的以較新的一邊為準" => "Fill in both sides; for differences the newer side wins",
        "左邊：本機路徑，或 ssh://<已存主機>/<路徑>（FTP 主機也用這個寫法；~ = 家目錄）" => "Left side: a local path, or ssh://<saved host>/<path> (also for FTP hosts; ~ = home directory)",
        "右邊（同上）" => "Right side (same as above)",
        "使用 GUI 已存的比對（名稱或 id）；兩邊與比對規則從那筆帶，命令列參數優先" => "Use a comparison saved in the GUI (name or id); both sides and rules come from it, command-line options take precedence",
        "比對方式（text / binary / folder；省略 = 依兩邊自動判斷）" => "Comparison mode (text / binary / folder; omitted = detected from both sides)",
        "資料夾比對判斷相同的準則" => "How a folder comparison decides two files are the same",
        "排除的名稱或路徑（可重複；支援 * 與 ?；給了就取代預設的 .git、node_modules）" => "Names or paths to exclude (repeatable; * and ? supported; replaces the default .git and node_modules)",
        "忽略整小時的時間差（時區 / 夏令時間）" => "Ignore whole-hour time differences (time zones / daylight saving)",
        "名稱不分大小寫對齊" => "Match names case-insensitively",
        "資料夾比對：連相同的項目也列出" => "Folder comparison: list identical items too",
        "文字比對的上下文行數" => "Lines of context in a text comparison",
        "左邊資料夾：本機路徑，或 ssh://<已存主機>/<路徑>" => "Left folder: a local path, or ssh://<saved host>/<path>",
        "使用 GUI 已存的比對（名稱或 id）；兩邊、排除規則與同步規則從那筆帶" => "Use a comparison saved in the GUI (name or id); both sides, exclude rules and the sync rule come from it",
        "同步規則（已存的比對有設定時可省略）" => "Sync rule (optional when the saved comparison has one)",
        "判斷相同的準則" => "How to decide two files are the same",
        "排除的名稱或路徑（可重複；支援 * 與 ?）" => "Names or paths to exclude (repeatable; * and ? supported)",
        "忽略整小時的時間差" => "Ignore whole-hour time differences",

        // ---- rd/ + commands/rd.rs + error.rs：遠端桌面（RDP / VNC / RustDesk）----
        "遠端桌面錯誤：{detail}" => "Remote desktop error: {detail}",
        "遠端桌面認證失敗：{detail}" => "Remote desktop authentication failed: {detail}",
        "使用者已取消遠端桌面連線" => "The remote desktop connection was cancelled by the user",
        "找不到遠端桌面主機：{id}" => "Remote desktop host not found: {id}",
        "未填寫遠端主機" => "No remote host was entered",
        "無法讀取檔案：{e}" => "Could not read the file: {e}",
        "檔案太大，不像是 .rdp 連線檔" => "The file is too large to be an .rdp file",
        "這個版本尚未內建 RustDesk 連線" => "This build does not include RustDesk connections yet",
        "這個版本未內建 RDP" => "This build does not include RDP",
        "這個版本未內建 VNC" => "This build does not include VNC",
        "RDP 連線執行緒意外結束" => "The RDP connection thread ended unexpectedly",
        "認證失敗次數過多" => "Too many failed authentication attempts",
        "無法寫入剪貼簿：{e}" => "Could not write to the clipboard: {e}",
        "無法讀取資料夾 {path}：{e}" => "Could not read folder {path}: {e}",
        "RustDesk 傳檔連線已中斷：{e}" => "The RustDesk file transfer connection was lost: {e}",
        "對方的 RustDesk 沒有回應（資料夾可能不存在或沒有權限）" => "The remote RustDesk did not respond (the folder may not exist or you may lack permission)",
        "對方的 RustDesk 沒有回應（傳輸停住了）" => "The remote RustDesk stopped responding (the transfer stalled)",
        "RustDesk 只能在同一個資料夾裡改名，不能搬到別的資料夾" => "RustDesk can only rename within the same folder, not move to another folder",
        "新的名稱不能是空的" => "The new name cannot be empty",
        "內容太大，無法直接存檔" => "The content is too large to save directly",
        "遠端已有同名的資料夾：{path}" => "A folder with the same name already exists on the remote: {path}",
        "RustDesk 傳檔不能改權限" => "RustDesk file transfer cannot change permissions",
        "只有 RustDesk 連線能傳檔" => "Only RustDesk connections support file transfer",
        "只有 RustDesk 連線能輸入作業系統密碼" => "Only RustDesk connections can type the OS password",
        "這台主機沒有存作業系統密碼" => "No OS password is saved for this host",
        "找不到可以存放錄影的資料夾" => "No folder is available to store recordings",
        "無法建立錄影資料夾：{e}" => "Could not create the recordings folder: {e}",
        "無法建立錄影檔：{e}" => "Could not create the recording file: {e}",
        "錄影已經結束" => "The recording has already ended",
        "寫入錄影檔失敗：{e}" => "Could not write the recording file: {e}",
        "不是錄影資料夾裡的檔案" => "Not a file in the recordings folder",
        "找不到可以存放截圖的資料夾" => "No folder is available to store screenshots",
        "無法建立截圖資料夾：{e}" => "Could not create the screenshots folder: {e}",
        "截圖存檔失敗：{e}" => "Could not save the screenshot: {e}",
        "找不到 RustDesk 連線元件（dbk-rustdesk-bridge），請重新安裝 db-kit" => "The RustDesk connection component (dbk-rustdesk-bridge) is missing. Please reinstall db-kit",
        "無法啟動 RustDesk 連線元件：{e}" => "Could not start the RustDesk connection component: {e}",
        "RustDesk 連線元件沒有回應：{e}" => "The RustDesk connection component is not responding: {e}",
        "RustDesk 連線元件意外結束" => "The RustDesk connection component exited unexpectedly",
        "RustDesk 連線逾時（對方沒有回應，或沒有在畫面上按接受）" => "RustDesk connection timed out (the other side didn't respond, or nobody clicked Accept on their screen)",
        "RustDesk 密碼錯誤" => "Wrong RustDesk password",
        "對方要求輸入密碼" => "The other side requires a password",
        "對方拒絕了連線：{m}" => "The other side refused the connection: {m}",
        "對方一直沒有回應登入：沒有人在對方畫面上按「接受」。請輸入對方的 RustDesk 密碼" => "The other side never answered the login: nobody clicked \"Accept\" on their screen. Enter the other side's RustDesk password",
        "對方的 RustDesk 開啟了雙重驗證（2FA），需要輸入驗證碼" => "The other side's RustDesk has two-factor authentication (2FA) turned on: a verification code is required",
        "雙重驗證碼錯誤" => "Wrong two-factor verification code",
        "密碼或驗證碼錯誤次數太多，對方暫時拒絕登入：請一分鐘後再試" => "Too many wrong passwords or verification codes; the other side is refusing logins for now. Try again in a minute",
        "密碼或驗證碼錯誤次數太多，對方的 RustDesk 已封鎖這台電腦的登入：請對方重新啟動 RustDesk 後再試" => "Too many wrong passwords or verification codes; the other side's RustDesk has blocked logins from this computer. Ask them to restart RustDesk, then try again",
        "驗證碼錯誤：請輸入驗證器 App 上目前顯示的那組（每 30 秒會換一組）" => "Wrong verification code: enter the code the authenticator app shows right now (it changes every 30 seconds)",
        "對方一直沒有在畫面上按「接受」（對方的 RustDesk 設定為只能按接受、不能用密碼登入）" => "Nobody clicked \"Accept\" on the other side's screen (its RustDesk only allows accepting on screen, not password login)",
        "對方的 RustDesk 設定為只能在畫面上按「接受」，不能用密碼登入：已請對方按接受，按了就會連上。" => "The other side's RustDesk only allows accepting the connection on its screen, not password login. They have been asked to click \"Accept\"; you'll be connected once they do.",
        "對方的 RustDesk 開啟了雙重驗證（2FA）：請輸入對方綁定的驗證器 App（如 Google Authenticator）上顯示的 6 位數驗證碼。" => "The other side's RustDesk has two-factor authentication (2FA) turned on: enter the 6-digit code shown in the authenticator app (e.g. Google Authenticator) it is linked to.",
        "更新失敗：{detail}" => "Update failed: {detail}",
        "這個安裝方式不支援自動更新，請到 GitHub 下載安裝檔" => "This installation doesn't support automatic updates; download the installer from GitHub",
        "版本號格式不對：{v}" => "Invalid version number: {v}",
        "查不到 v{v} 的 Release：{e}" => "Couldn't find the v{v} release: {e}",
        "{tag} 沒有這台電腦用的安裝檔" => "{tag} has no installer for this computer",
        "安裝檔的下載網址不對：{u}" => "Unexpected installer download URL: {u}",
        "GitHub 沒有提供安裝檔的 SHA-256，無法確認檔案完整，已取消更新" => "GitHub didn't provide the installer's SHA-256, so its integrity can't be checked; update cancelled",
        "下載的安裝檔 SHA-256 對不上，可能下載不完整或被竄改，已取消更新" => "The downloaded installer's SHA-256 doesn't match (incomplete or tampered download); update cancelled",
        "下載安裝檔失敗：{e}" => "Failed to download the installer: {e}",
        "無法啟動安裝程式：{e}" => "Couldn't start the installer: {e}",
        "已請對方在畫面上按「接受」，對方按了就會連上；也可以直接輸入對方的 RustDesk 密碼。" => "The other side has been asked to click \"Accept\" on their screen, and you'll be connected once they do. You can also enter the other side's RustDesk password.",
        "找不到這個 RustDesk ID：請確認 ID 沒有打錯，而且這裡的 ID 伺服器跟對方 RustDesk 設定的是同一台" => "RustDesk ID not found: check the ID, and make sure this ID server is the same one set in the other side's RustDesk",
        "對方不在線上：對方電腦沒開 RustDesk，或它連不到 ID 伺服器" => "The other side is offline: RustDesk isn't running on that computer, or it can't reach the ID server",
        "ID 伺服器拒絕連線：Key 不符。請在連線設定填入 ID 伺服器的公鑰（跟對方 RustDesk 設定的 Key 相同）" => "The ID server refused the connection: key mismatch. Enter the ID server's public key in the connection settings (the same Key set in the other side's RustDesk)",
        "ID 伺服器拒絕連線：這個 Key 的使用量已達上限" => "The ID server refused the connection: this key has reached its usage limit",
        "連不到 ID 伺服器：{m}" => "Could not reach the ID server: {m}",
        "ID 伺服器沒有回應（對方可能剛離線，稍後再試）" => "The ID server did not respond (the other side may have just gone offline; try again later)",
        "連不到中繼伺服器：{m}" => "Could not reach the relay server: {m}",
        "中繼伺服器拒絕連線：{m}" => "The relay server refused the connection: {m}",
        "經中繼伺服器連線失敗：{m}" => "Connecting through the relay server failed: {m}",
        "用 RustDesk ID 連線不能經 SSH 主機轉接：請改填對方電腦的 IP 位址（Direct IP），或取消「經 SSH 主機連線」" => "A RustDesk ID connection can't go through an SSH host: enter the other computer's IP address instead (Direct IP), or turn off \"Connect through SSH host\"",
        "VNC 握手逾時" => "The VNC handshake timed out",
        "VNC 伺服器無法建立 TLS 連線" => "The VNC server could not set up the TLS connection",
        "伺服器的 VeNCrypt 沒有支援的子型別（{list}）；可以在主機設定把認證方式改成「VNC 密碼」" => "The server's VeNCrypt offers no supported subtype ({list}); you can set the authentication method to “VNC password” in the host settings",
        "無法切換全螢幕：{e}" => "Could not toggle full screen: {e}",
        "遠端桌面連線已關閉" => "The remote desktop connection is closed",
        "同時開啟的遠端桌面連線已達上限（{n}）" => "Too many remote desktop connections open at once (limit {n})",
        "遠端桌面連線不存在或已關閉" => "The remote desktop connection does not exist or is closed",
        "找不到待回答的遠端桌面提示（可能已逾時）" => "No pending remote desktop prompt to answer (it may have timed out)",
        "無法連線到 {host}:{port}：{e}" => "Could not connect to {host}:{port}: {e}",
        "連線 {host}:{port} 逾時（{s} 秒）" => "Connecting to {host}:{port} timed out ({s} s)",
        "SSH 主機無法轉接到 {host}:{port}：{e}" => "The SSH host could not forward to {host}:{port}: {e}",
        "伺服器要求網路層級驗證（NLA），請在連線設定開啟 NLA" => "The server requires Network Level Authentication (NLA); turn on NLA in the connection settings",
        "伺服器不接受目前的安全層設定：{detail}" => "The server does not accept the current security layer setting: {detail}",
        "TLS 握手失敗：{e}" => "TLS handshake failed: {e}",
        "無法讀取已信任的遠端桌面憑證清單：{e}" => "Could not read the list of trusted remote desktop certificates: {e}",
        "無法記住憑證：{e}" => "Could not remember the certificate: {e}",
        "讀不到伺服器憑證的公鑰" => "Could not read the public key from the server certificate",
        "連線中斷：{e}" => "Connection lost: {e}",
        "RDP 協定錯誤：{e}" => "RDP protocol error: {e}",
        "重新啟用工作階段失敗：{e}" => "Failed to reactivate the session: {e}",
        "遠端主機結束了工作階段" => "The remote host ended the session",
        "遠端主機關閉了連線" => "The remote host closed the connection",
        "不支援的 VNC 認證型別：{n}" => "Unsupported VNC security type: {n}",
        "VNC 伺服器回應的版本字串格式不正確" => "The VNC server sent a malformed version string",
        "伺服器未提供指定的 VNC 認證方式（{name}）；實際提供：{list}" => "The server does not offer the selected VNC authentication method ({name}); it offers: {list}",
        "伺服器未提供任何支援的 VNC 認證方式；實際提供：{list}" => "The server offers no supported VNC authentication method; it offers: {list}",
        "VNC 伺服器拒絕連線" => "The VNC server refused the connection",
        "ARD 金鑰長度不合理" => "The ARD key length is invalid",
        "伺服器不接受 VeNCrypt 0.2" => "The server does not accept VeNCrypt 0.2",
        "伺服器未提供 VeNCrypt-Plain 子型別" => "The server does not offer the VeNCrypt-Plain subtype",
        "VNC 認證被伺服器拒絕" => "The server rejected the VNC authentication",
        "VNC 伺服器回應的原因字串過長" => "The reason string from the VNC server is too long",
        "VNC 連線 I/O 錯誤：{detail}" => "VNC connection I/O error: {detail}",
        "noVNC 端回應的 RFB 版本字串格式不正確" => "The noVNC side sent a malformed RFB version string",
        "noVNC 端選了非預期的認證型別：{n}" => "The noVNC side chose an unexpected security type: {n}",
        _ => return None,
    })
}
