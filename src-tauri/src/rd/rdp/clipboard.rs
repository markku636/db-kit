//! RDP 剪貼簿（CLIPRDR 通道，只做文字 `CF_UNICODETEXT`）。
//!
//! `CliprdrBackend` 的回呼拿不到 `Cliprdr` 本身（它被 ActiveStage 持有），所以這裡不直接回應，
//! 而是把「要做的事」排進佇列（`Action`），由工作階段迴圈在每輪處理完封包後取出來執行：
//! 呼叫 `CliprdrClient` 的方法、把產生的 SVC 訊息編成 frame 送出去。
//!
//! 流程：
//! - 遠端複製了文字 → `on_remote_copy`（格式清單有 CF_UNICODETEXT）→ 排 `Paste` → 迴圈 `initiate_paste`
//!   → `on_format_data_response` 拿到文字 → 排 `RemoteText` → 迴圈把文字交給前端（寫進本機剪貼簿）。
//! - 本機有新文字（前端 `rd_clipboard_set`）→ 迴圈記下並 `initiate_copy` 宣告有文字 →
//!   遠端貼上時 `on_format_data_request` → 排 `Submit` → 迴圈 `submit_format_data`。

use std::collections::VecDeque;
use std::sync::Arc;

use ironrdp::cliprdr::backend::CliprdrBackend;
use ironrdp::cliprdr::pdu::{
    ClipboardFormat, ClipboardFormatId, ClipboardGeneralCapabilityFlags, FileContentsRequest, FileContentsResponse,
    FormatDataRequest, FormatDataResponse, LockDataId, OwnedFormatDataResponse,
};
use parking_lot::Mutex;

/// 本機剪貼簿文字上限（避免誤貼一整份檔案把通道塞滿）。
pub const MAX_TEXT: usize = 4 * 1024 * 1024;

/// 迴圈要執行的動作。
#[derive(Debug)]
pub enum Action {
    /// 向遠端要文字（遠端剛複製了東西）。
    Paste,
    /// 回應遠端的貼上請求（`None` = 沒有文字，回錯誤）。
    Submit(OwnedFormatDataResponse),
    /// 遠端的文字到了，交給前端。
    RemoteText(String),
    /// 通道好了 / 遠端要格式清單：有本機文字就宣告。
    Advertise,
}

#[derive(Debug, Default)]
pub struct Shared {
    /// 本機最新的文字（遠端貼上時給它）。
    pub local: Option<String>,
    pub actions: VecDeque<Action>,
    pub ready: bool,
}

pub type SharedClip = Arc<Mutex<Shared>>;

#[derive(Debug)]
pub struct TextClipboard {
    shared: SharedClip,
}

impl TextClipboard {
    pub fn new(shared: SharedClip) -> Self {
        Self { shared }
    }
}

ironrdp::core::impl_as_any!(TextClipboard);

pub fn text_format() -> ClipboardFormat {
    ClipboardFormat::new(ClipboardFormatId::CF_UNICODETEXT)
}

impl CliprdrBackend for TextClipboard {
    fn temporary_directory(&self) -> &str {
        ""
    }

    fn client_capabilities(&self) -> ClipboardGeneralCapabilityFlags {
        ClipboardGeneralCapabilityFlags::USE_LONG_FORMAT_NAMES
    }

    fn on_ready(&mut self) {
        let mut s = self.shared.lock();
        s.ready = true;
        s.actions.push_back(Action::Advertise);
    }

    fn on_request_format_list(&mut self) {
        self.shared.lock().actions.push_back(Action::Advertise);
    }

    fn on_process_negotiated_capabilities(&mut self, _capabilities: ClipboardGeneralCapabilityFlags) {}

    fn on_remote_copy(&mut self, available_formats: &[ClipboardFormat]) {
        if available_formats.iter().any(|f| f.id == ClipboardFormatId::CF_UNICODETEXT) {
            self.shared.lock().actions.push_back(Action::Paste);
        }
    }

    fn on_format_data_request(&mut self, request: FormatDataRequest) {
        let mut s = self.shared.lock();
        let resp = match (&s.local, request.format == ClipboardFormatId::CF_UNICODETEXT) {
            (Some(text), true) => OwnedFormatDataResponse::new_unicode_string(text),
            _ => OwnedFormatDataResponse::new_error(),
        };
        s.actions.push_back(Action::Submit(resp));
    }

    fn on_format_data_response(&mut self, response: FormatDataResponse<'_>) {
        if response.is_error() {
            return;
        }
        if let Ok(text) = response.to_unicode_string() {
            // Windows 的 CF_UNICODETEXT 以 NUL 結尾。
            let text = text.trim_end_matches('\0').to_string();
            if !text.is_empty() {
                self.shared.lock().actions.push_back(Action::RemoteText(text));
            }
        }
    }

    fn on_file_contents_request(&mut self, _request: FileContentsRequest) {}

    fn on_file_contents_response(&mut self, _response: FileContentsResponse<'_>) {}

    fn on_lock(&mut self, _data_id: LockDataId) {}

    fn on_unlock(&mut self, _data_id: LockDataId) {}
}

/// 前端送來的本機文字：過長截斷（依字元邊界）、換行統一成 CRLF（Windows 的慣例）。
pub fn normalize_local(text: &str) -> String {
    let mut t = text.replace("\r\n", "\n").replace('\n', "\r\n");
    if t.len() > MAX_TEXT {
        let mut cut = MAX_TEXT;
        while !t.is_char_boundary(cut) {
            cut -= 1;
        }
        t.truncate(cut);
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clip() -> (TextClipboard, SharedClip) {
        let s: SharedClip = Arc::default();
        (TextClipboard::new(s.clone()), s)
    }

    fn drain(s: &SharedClip) -> Vec<Action> {
        s.lock().actions.drain(..).collect()
    }

    #[test]
    fn remote_copy_of_text_requests_paste_other_formats_ignored() {
        let (mut c, s) = clip();
        c.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::new(2))]);
        assert!(drain(&s).is_empty(), "只有圖片：不要求");
        c.on_remote_copy(&[ClipboardFormat::new(ClipboardFormatId::new(2)), text_format()]);
        assert!(matches!(drain(&s).as_slice(), [Action::Paste]));
    }

    #[test]
    fn format_data_request_answers_with_local_text_or_error() {
        let (mut c, s) = clip();
        c.on_format_data_request(FormatDataRequest { format: ClipboardFormatId::CF_UNICODETEXT });
        match drain(&s).as_slice() {
            [Action::Submit(r)] => assert!(r.is_error(), "沒有本機文字 → 錯誤回應"),
            a => panic!("{a:?}"),
        }
        s.lock().local = Some("hello".into());
        c.on_format_data_request(FormatDataRequest { format: ClipboardFormatId::CF_UNICODETEXT });
        match drain(&s).as_slice() {
            [Action::Submit(r)] => assert_eq!(r.to_unicode_string().unwrap().trim_end_matches('\0'), "hello"),
            a => panic!("{a:?}"),
        }
    }

    #[test]
    fn format_data_response_becomes_remote_text() {
        let (mut c, s) = clip();
        let r = OwnedFormatDataResponse::new_unicode_string("遠端文字");
        c.on_format_data_response(r);
        match drain(&s).as_slice() {
            [Action::RemoteText(t)] => assert_eq!(t, "遠端文字"),
            a => panic!("{a:?}"),
        }
        c.on_format_data_response(OwnedFormatDataResponse::new_error());
        assert!(drain(&s).is_empty());
    }

    #[test]
    fn ready_advertises_and_normalize() {
        let (mut c, s) = clip();
        c.on_ready();
        assert!(s.lock().ready);
        assert!(matches!(drain(&s).as_slice(), [Action::Advertise]));
        assert_eq!(normalize_local("a\nb\r\nc"), "a\r\nb\r\nc");
    }
}
