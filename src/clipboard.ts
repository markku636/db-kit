// 系統剪貼簿的文字讀寫：先走後端（arboard，見 src-tauri/src/commands/clipboard.rs），後端不行才退回
// webview 的 navigator.clipboard。webview 那條在 Linux（WebKitGTK）讀取一律被拒、有的版本連
// navigator.clipboard 都沒有（寫入就安靜地什麼都沒做）；macOS（WKWebView）讀取會跳出「貼上」小選單，
// 寫入只能在按鍵 / 點擊的當下（先等後端拿資料再寫就被拒）；Windows（WebView2）讀取會跳權限詢問。
import { api } from "./api";

/** 讀剪貼簿的文字（沒有文字回 ""）。後端和 webview 都讀不到才 reject。 */
export async function readClipboardText(): Promise<string> {
  try {
    return await api.clipboardReadText();
  } catch (e) {
    if (!navigator.clipboard?.readText) throw e;
    return navigator.clipboard.readText();
  }
}

/** 把文字寫進剪貼簿。後端和 webview 都寫不進才 reject。 */
export async function writeClipboardText(text: string): Promise<void> {
  try {
    await api.clipboardWriteText(text);
  } catch (e) {
    if (!navigator.clipboard?.writeText) throw e;
    await navigator.clipboard.writeText(text);
  }
}
