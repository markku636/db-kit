//! HTTP 供應商的對話歷史落地。
//!
//! 為什麼非落地不可：CLI 後端（Claude Code / Codex）的 session 活在它們自己的行程 / 伺服器端，
//! 重開 App 還接得回去；HTTP 供應商沒有伺服器端 session，歷史只存在 `AppState.llm_sessions`
//! 這個 HashMap 裡（見 `commands/mod.rs` 與 `agent.rs::llm_send`）。App 一關就全沒，但前端
//! 帶著同一個 session_id 與整段對話畫面回來——使用者看得到上文、模型卻一無所知，於是
//! 「你剛剛說的那張表」這種追問會答得莫名其妙，而且完全沒有徵兆。這裡補上那段落差。
//!
//! **安全性**：這些檔案會夾帶工具回傳的查詢結果（貨真價實的資料列），因此與 connections.json
//! 同放在 app config dir（OS 的使用者私有目錄），並在使用者清除對話時一併刪除。刻意不放
//! cache 目錄或系統暫存目錄：前者語意是「刪了無所謂」、後者在多數系統上是共用可讀的。
//!
//! 設計取捨（與 `schema_cache` 同一套模子，理由也一樣）：
//!
//! - **一 session 一檔**（`llm-sessions/<session_id>.json`）。全塞一個檔的話，每回合存檔都要
//!   重寫所有對話；對話裡夾著查詢結果，體積不是小數目。
//! - **讀失敗一律當成「沒有歷史」**，不往上拋。半截檔、手改壞、舊版格式，任何一種都只該讓
//!   模型少了上文，不該讓正在進行中的對話整個開不起來。`version` 不合亦同——過期的磁碟格式
//!   絕不能弄壞一段活著的對話。
//! - **全部函式吃 `dir: &Path`、不碰 tauri**，所以能單元測試；dir 由呼叫端（GUI 走
//!   `store::app_config_dir`）決定，與 connections.json 同一個目錄。
//! - **`prune_in` 的 `now_ms` 由呼叫端傳入**。自己讀時鐘的函式寫不出確定性的測試，
//!   而「過期」正是這裡唯一值得測的邏輯。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::Message;
use crate::error::{AppError, AppResult};
use crate::schema_cache::sanitize_id;
use crate::store::write_json_compact_in;

/// 對話檔所在的子目錄（相對於設定目錄）。
pub const SESSIONS_DIR: &str = "llm-sessions";

/// 保留政策的預設值。放在這裡而不是寫死在呼叫端，是為了讓「留多久 / 留幾份」只有一處可改。
pub const MAX_AGE_DAYS: i64 = 30;
pub const MAX_SESSIONS: usize = 50;

/// 磁碟格式版號。對不上就整份當成沒有歷史（見模組說明）。
///
/// 動到 `Message` 的 wire 形狀（改 variant 名稱、換欄位語意）時**必須**一起加號：
/// 忘了加，serde 會悄悄解析出半套歷史餵給模型，那比完全沒有歷史更難查。
const SESSION_VERSION: u32 = 1;

const DAY_MS: i64 = 86_400_000;

fn session_v1() -> u32 {
    1
}

/// 一段對話的整份磁碟格式。
///
/// `provider` / `model` 存的是「寫這份歷史時用的是誰」，純資訊性：換模型續聊是合法操作，
/// 所以讀取時不拿它們把關，只讓 UI 與日後的除錯看得出這段上文出自哪個端點。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionFile {
    #[serde(default = "session_v1")]
    pub version: u32,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    /// Unix epoch 毫秒。
    #[serde(default)]
    pub created_at_ms: i64,
    /// Unix epoch 毫秒；`prune_in` 的排序與過期判斷都只看這一欄。
    #[serde(default)]
    pub updated_at_ms: i64,
    #[serde(default)]
    pub messages: Vec<Message>,
}

/// `prune_in` 專用的寬鬆 header：只解時間戳，不碰 `messages`。
///
/// 特意不重用 `SessionFile`：使用者降版回舊 App 時，磁碟上可能躺著新版格式的檔案。
/// 若 prune 也要求整份解得開，那些檔會被當成垃圾清掉——使用者升回去就發現歷史沒了。
/// 只解時間戳則能照常按新舊保留。反過來，真正壞掉的檔（解不出 header）時間戳為 0，
/// 比任何過期界線都舊，會被年齡規則順手清掉，不會無限累積。
#[derive(Deserialize)]
struct SessionStamp {
    #[serde(default)]
    updated_at_ms: i64,
}

fn sessions_dir(dir: &Path) -> PathBuf {
    dir.join(SESSIONS_DIR)
}

/// session id 由前端帶進來（`agent.rs` 產的 uuid，但終究是外部輸入），一律經過
/// `schema_cache::sanitize_id`——同一份規則只該有一份實作，兩份遲早會有一份忘了修。
fn file_name(session_id: &str) -> String {
    format!("{}.json", sanitize_id(session_id))
}

/// 讀一段對話。**沒有、壞了、版本不合都回 `None`**（見模組說明），呼叫端一律當成「從頭聊」。
pub async fn load_in(dir: &Path, session_id: &str) -> Option<SessionFile> {
    let path = sessions_dir(dir).join(file_name(session_id));
    let bytes = match tokio::fs::read(&path).await {
        Ok(b) => b,
        // 檔案不存在是每段新對話的第一回合都會走到的正常路徑，不印訊息（會洗版）。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            eprintln!("[llm_sessions] 讀取 {} 失敗，當成無歷史：{e}", path.display());
            return None;
        }
    };
    let file: SessionFile = match serde_json::from_slice(&bytes) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[llm_sessions] {} 解析失敗，當成無歷史：{e}", path.display());
            return None;
        }
    };
    if file.version != SESSION_VERSION {
        eprintln!(
            "[llm_sessions] {} 版本 {} 與目前 {} 不符，當成無歷史",
            path.display(),
            file.version,
            SESSION_VERSION
        );
        return None;
    }
    Some(file)
}

/// 覆寫一段對話（temp + rename 原子寫入，見 `store::write_json_compact_in`）。
///
/// `version` 一律由這裡蓋成當前值、不信呼叫端給的：整份結構是 `pub`，用 `..Default::default()`
/// 或手動組出來的話 `version` 很容易是 0，寫出去的檔下一次開 App 就會被 `load_in` 判成不相容
/// 而整段丟掉——而且丟得無聲無息。複製一份的代價（一次 `Vec<Message>` clone）遠小於這個風險，
/// 何況緊接著的序列化本來就要把同樣的內容再抄一遍。
pub async fn save_in(dir: &Path, file: &SessionFile) -> AppResult<()> {
    let out = SessionFile { version: SESSION_VERSION, ..file.clone() };
    write_json_compact_in(&sessions_dir(dir), &file_name(&file.session_id), &out).await
}

/// 刪一段對話。找不到不算錯（重複清除、或根本沒存過就按清除，都是正常操作）。
///
/// 與 `schema_cache::clear` 不同，真的刪不掉時**會回錯**：這些檔含查詢結果，
/// 使用者按了「清除對話」就該確定它沒了，靜默吞掉失敗等於騙人。
pub async fn delete_in(dir: &Path, session_id: &str) -> AppResult<()> {
    let path = sessions_dir(dir).join(file_name(session_id));
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Storage(tf!(
            "刪除 {file} 失敗：{e}",
            file = path.display(),
            e = e
        ))),
    }
}

/// 刪掉整個對話目錄（設定頁的「清除全部對話紀錄」）。目錄不存在不算錯。
pub async fn clear_in(dir: &Path) -> AppResult<()> {
    let path = sessions_dir(dir);
    match tokio::fs::remove_dir_all(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::Storage(tf!(
            "刪除 {file} 失敗：{e}",
            file = path.display(),
            e = e
        ))),
    }
}

/// 清掉過期與超量的對話，回傳實際刪掉幾個。
///
/// 兩條規則依序套用：先丟掉 `updated_at_ms` 早於 `now_ms - max_age_days` 的，再只留最新的
/// `max_count` 份。`max_age_days <= 0` 或 `max_count == 0` 代表**不套用該條規則**，而不是
/// 「全刪」——設定值不小心變成 0 時，最糟只該是沒清到，不該是把使用者的歷史靜默清光；
/// 要全清請用 `clear_in`（那是使用者按下去的、有明確意圖的動作）。
///
/// 刪不掉的檔只記 log 不算數、也不往上拋：prune 是背景維護，失敗頂多是多佔一點空間。
pub async fn prune_in(dir: &Path, now_ms: i64, max_age_days: i64, max_count: usize) -> usize {
    let root = sessions_dir(dir);
    let mut rd = match tokio::fs::read_dir(&root).await {
        Ok(rd) => rd,
        // 目錄還沒建立（沒用過 HTTP 供應商）＝沒東西可清。
        Err(_) => return 0,
    };

    let mut entries: Vec<(i64, PathBuf)> = Vec::new();
    while let Ok(Some(ent)) = rd.next_entry().await {
        let path = ent.path();
        // 只認 `.json`：`write_json_compact_in` 中途的 `*.json.tmp` 不該被當成一段對話刪掉。
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let at = match tokio::fs::read(&path).await {
            Ok(b) => serde_json::from_slice::<SessionStamp>(&b).map(|s| s.updated_at_ms).unwrap_or(0),
            Err(_) => continue,
        };
        entries.push((at, path));
    }

    // 新 → 舊。時間相同時以路徑排序：read_dir 的順序隨檔案系統而異，不定序會讓
    // 「超量時該砍哪一個」變成擲骰子，測試也就跟著時好時壞。
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));

    let cutoff = if max_age_days > 0 { Some(now_ms - max_age_days * DAY_MS) } else { None };
    let mut removed = 0usize;
    for (i, (at, path)) in entries.iter().enumerate() {
        let too_old = matches!(cutoff, Some(c) if *at < c);
        // 排序已是新到舊，所以「年齡規則砍掉的」必定落在尾端，用同一個索引套數量上限
        // 與「先過濾再取前 N 名」等價，不必先做一次 retain。
        let over_cap = max_count > 0 && i >= max_count;
        if !too_old && !over_cap {
            continue;
        }
        match tokio::fs::remove_file(path).await {
            Ok(()) => removed += 1,
            Err(e) => eprintln!("[llm_sessions] 清理 {} 失敗：{e}", path.display()),
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{ToolCall, ToolOutput};
    use serde_json::json;

    /// 每個測試各自一個目錄：`prune_in` 會掃整個目錄，共用一個的話測試之間會互相看到對方的檔案
    /// （cargo test 預設同進程多執行緒並行）。
    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("dbkit-llm-sessions-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 一輪完整的工具對話：提問 → 助理要求呼叫工具 → 工具回傳，三種 variant 都在。
    fn sample_messages() -> Vec<Message> {
        vec![
            Message::User("列出前 10 筆訂單".into()),
            Message::Assistant {
                text: "我先查一下這張表。".into(),
                tool_calls: vec![ToolCall {
                    id: "tc-1".into(),
                    name: "run_query".into(),
                    args: json!({ "sql": "select * from orders limit 10" }),
                }],
            },
            Message::ToolResults(vec![ToolOutput {
                id: "tc-1".into(),
                name: "run_query".into(),
                content: "共 10 列".into(),
                is_error: false,
            }]),
        ]
    }

    fn sample(session_id: &str, updated_at_ms: i64) -> SessionFile {
        SessionFile {
            version: SESSION_VERSION,
            session_id: session_id.into(),
            provider: "anthropic-api".into(),
            model: "claude-x".into(),
            created_at_ms: 1_000,
            updated_at_ms,
            messages: sample_messages(),
        }
    }

    /// 存 → 讀要完整還原三種 variant；尤其 Assistant 的 tool_calls 必須與後面那則
    /// ToolResults 的 id 對得上，對不上的話續聊時送出去的歷史在兩家供應商都會被打回票。
    #[tokio::test]
    async fn round_trip_preserves_every_message_variant() {
        let dir = tmpdir("roundtrip");
        save_in(&dir, &sample("s1", 5_000)).await.unwrap();

        let back = load_in(&dir, "s1").await.expect("存得進去就該讀得回來");
        assert_eq!(back.version, SESSION_VERSION);
        assert_eq!(back.session_id, "s1");
        assert_eq!(back.provider, "anthropic-api");
        assert_eq!(back.model, "claude-x");
        assert_eq!(back.created_at_ms, 1_000);
        assert_eq!(back.updated_at_ms, 5_000);
        assert_eq!(back.messages.len(), 3);

        match &back.messages[0] {
            Message::User(s) => assert_eq!(s, "列出前 10 筆訂單"),
            other => panic!("第 1 則應為 User，實得 {other:?}"),
        }
        let call_id = match &back.messages[1] {
            Message::Assistant { text, tool_calls } => {
                assert_eq!(text, "我先查一下這張表。");
                assert_eq!(tool_calls.len(), 1);
                assert_eq!(tool_calls[0].name, "run_query");
                assert_eq!(tool_calls[0].args["sql"], "select * from orders limit 10");
                tool_calls[0].id.clone()
            }
            other => panic!("第 2 則應為 Assistant，實得 {other:?}"),
        };
        match &back.messages[2] {
            Message::ToolResults(outs) => {
                assert_eq!(outs.len(), 1);
                assert_eq!(outs[0].id, call_id, "工具結果要對得回 tool_call id");
                assert_eq!(outs[0].content, "共 10 列");
                assert!(!outs[0].is_error);
            }
            other => panic!("第 3 則應為 ToolResults，實得 {other:?}"),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 沒存過 / 半截檔 / 未來版本，三種都只該是「沒有歷史」，不 panic 也不回錯。
    #[tokio::test]
    async fn load_returns_none_for_missing_corrupt_and_version_mismatch() {
        let dir = tmpdir("load-none");
        let sub = sessions_dir(&dir);
        tokio::fs::create_dir_all(&sub).await.unwrap();

        assert!(load_in(&dir, "nope").await.is_none(), "沒存過 → None");

        // 寫到一半斷電的樣子。
        tokio::fs::write(sub.join("broken.json"), b"{\"messages\":[{\"User\":\"hi")
            .await
            .unwrap();
        assert!(load_in(&dir, "broken").await.is_none(), "解析失敗 → None");

        // 降版回舊 App 時會遇到的：欄位都在、版本不同。
        tokio::fs::write(
            sub.join("future.json"),
            br#"{"version":999,"session_id":"future","provider":"p","model":"m","created_at_ms":1,"updated_at_ms":2,"messages":[{"User":"hi"}]}"#,
        )
        .await
        .unwrap();
        assert!(load_in(&dir, "future").await.is_none(), "版本不合 → None");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 清除對話會在「本來就沒存過」時被按到（例如一句都還沒送出），不能因此回錯。
    #[tokio::test]
    async fn delete_and_clear_are_idempotent() {
        let dir = tmpdir("delete");
        save_in(&dir, &sample("s1", 1)).await.unwrap();

        delete_in(&dir, "s1").await.unwrap();
        assert!(load_in(&dir, "s1").await.is_none());
        delete_in(&dir, "s1").await.unwrap();
        delete_in(&dir, "never-existed").await.unwrap();

        save_in(&dir, &sample("s2", 1)).await.unwrap();
        clear_in(&dir).await.unwrap();
        assert!(load_in(&dir, "s2").await.is_none());
        // 目錄已經不在了，再清一次仍是 Ok。
        clear_in(&dir).await.unwrap();

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 年齡規則：只看 `updated_at_ms`，界線上（剛好等於 cutoff）的算「還沒過期」。
    #[tokio::test]
    async fn prune_drops_by_age() {
        let dir = tmpdir("prune-age");
        let now = 100 * DAY_MS;
        save_in(&dir, &sample("fresh", now - DAY_MS)).await.unwrap();
        save_in(&dir, &sample("edge", now - 30 * DAY_MS)).await.unwrap(); // 剛好在界線上
        save_in(&dir, &sample("stale", now - 31 * DAY_MS)).await.unwrap();
        // 解不開的檔時間戳算 0，比任何界線都舊，會被一起清掉（否則永遠清不掉）。
        tokio::fs::write(sessions_dir(&dir).join("junk.json"), b"not json at all")
            .await
            .unwrap();

        let n = prune_in(&dir, now, MAX_AGE_DAYS, 0).await;
        assert_eq!(n, 2, "stale 與 junk 各一");
        assert!(load_in(&dir, "fresh").await.is_some());
        assert!(load_in(&dir, "edge").await.is_some(), "界線上不算過期");
        assert!(load_in(&dir, "stale").await.is_none());
        assert!(!sessions_dir(&dir).join("junk.json").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 數量上限：留最新的 N 份，其餘不論多新都刪。
    #[tokio::test]
    async fn prune_caps_by_count_keeping_newest() {
        let dir = tmpdir("prune-count");
        let now = 100 * DAY_MS;
        for i in 0..5i64 {
            // i 越大越新，全部都在有效期內。
            save_in(&dir, &sample(&format!("s{i}"), now - (5 - i) * 1_000)).await.unwrap();
        }

        let n = prune_in(&dir, now, MAX_AGE_DAYS, 2).await;
        assert_eq!(n, 3);
        assert!(load_in(&dir, "s4").await.is_some());
        assert!(load_in(&dir, "s3").await.is_some());
        for old in ["s0", "s1", "s2"] {
            assert!(load_in(&dir, old).await.is_none(), "{old} 應被清掉");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 兩條規則一起套用時不該重複計數，且 0 代表「不套用該規則」而非全刪
    /// ——設定值意外歸零時最糟只能是沒清到。
    #[tokio::test]
    async fn prune_combines_rules_and_treats_zero_as_no_limit() {
        let dir = tmpdir("prune-both");
        let now = 100 * DAY_MS;
        save_in(&dir, &sample("new1", now - 1_000)).await.unwrap();
        save_in(&dir, &sample("new2", now - 2_000)).await.unwrap();
        save_in(&dir, &sample("new3", now - 3_000)).await.unwrap();
        save_in(&dir, &sample("old1", now - 40 * DAY_MS)).await.unwrap();
        save_in(&dir, &sample("old2", now - 50 * DAY_MS)).await.unwrap();

        // 先關掉兩條規則：一個都不該被刪。
        assert_eq!(prune_in(&dir, now, 0, 0).await, 0);

        // 過期 2 個 + 超量 1 個（new3），合計 3，不是 4（old* 不能被算兩次）。
        let n = prune_in(&dir, now, MAX_AGE_DAYS, 2).await;
        assert_eq!(n, 3);
        assert!(load_in(&dir, "new1").await.is_some());
        assert!(load_in(&dir, "new2").await.is_some());
        assert!(load_in(&dir, "new3").await.is_none());

        // 已經清乾淨了，再跑一次就沒得刪。
        assert_eq!(prune_in(&dir, now, MAX_AGE_DAYS, 2).await, 0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 目錄還沒建立時 prune 不該炸（開 App 就跑一次背景清理，多數人根本沒用過 HTTP 供應商）。
    #[tokio::test]
    async fn prune_on_missing_dir_is_zero() {
        let dir = tmpdir("prune-missing");
        assert_eq!(prune_in(&dir, 0, MAX_AGE_DAYS, MAX_SESSIONS).await, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// session id 來自前端，帶路徑的 id 絕不能把檔案寫到對話目錄外面
    /// （`../x` 若原樣接上就會落在 config 目錄根部，跟 connections.json 當鄰居）。
    #[tokio::test]
    async fn traversal_session_id_stays_inside_dir() {
        let dir = tmpdir("traversal");
        save_in(&dir, &sample("../x", 1)).await.unwrap();

        assert!(!dir.join("x.json").exists(), "不得逃出 llm-sessions 目錄");
        assert!(sessions_dir(&dir).join("___x.json").exists());
        // 逃不出去，但仍然讀得回來（同一份 sanitize 規則進出一致）。
        let back = load_in(&dir, "../x").await.expect("讀得回來");
        assert_eq!(back.session_id, "../x", "原始 id 原樣保留在檔案內容裡");

        delete_in(&dir, "../x").await.unwrap();
        assert!(load_in(&dir, "../x").await.is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 呼叫端忘了填 `version`（用 0）時，save 要自己蓋成當前版號，
    /// 否則寫出去的檔下次一定被 `load_in` 判成不相容而整段丟掉。
    #[tokio::test]
    async fn save_stamps_current_version() {
        let dir = tmpdir("stamp");
        let mut f = sample("s1", 1);
        f.version = 0;
        save_in(&dir, &f).await.unwrap();
        assert_eq!(load_in(&dir, "s1").await.expect("應可讀回").version, SESSION_VERSION);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
