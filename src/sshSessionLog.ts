// SSH 終端機的記錄與狀態列用的純函式：把收到的原始位元組變成可讀的文字記錄（去 ANSI、處理 \r 重寫、
// UTF-8 切在封包邊界）、連線時間、記錄檔預設檔名、把 xterm 的畫面內容攤成文字。
import { normalizeLines, stripAnsiChunk } from "./sshCapture";

export interface SessionRecorder {
  /** 收到一段輸出（原始位元組）。 */
  push(bytes: Uint8Array): void;
  /** 取走已經完整的行（以 \n 結尾）；還沒收完的最後一行留著，等下一段或 flush。 */
  take(): string;
  /** 結束記錄：連同還沒收完的最後一行全部取走。 */
  flush(): string;
}

/**
 * 串流的記錄器。逐段去掉 ANSI（色碼被切在封包邊界時帶到下一段）、\r\n → \n、同一行的 \r 重寫（進度條）
 * 只留最後一次的內容；最後一行要等換行才寫出，不然進度條的每一格都會各自變成一行。
 */
export function createRecorder(): SessionRecorder {
  const dec = new TextDecoder("utf-8");
  let carry = "";
  let pending = "";
  let ready = "";
  const absorb = (text: string) => {
    const all = pending + text;
    const nl = all.lastIndexOf("\n");
    if (nl >= 0) {
      ready += normalizeLines(all.slice(0, nl + 1));
      pending = all.slice(nl + 1);
    } else {
      pending = all;
    }
  };
  return {
    push(bytes) {
      const r = stripAnsiChunk(carry + dec.decode(bytes, { stream: true }));
      carry = r.carry;
      absorb(r.text);
    },
    take() {
      const out = ready;
      ready = "";
      return out;
    },
    flush() {
      absorb(dec.decode());
      let out = ready;
      const last = normalizeLines(pending);
      if (last) out += `${last}\n`;
      ready = "";
      pending = "";
      carry = "";
      return out;
    },
  };
}

/** 連線時間：`5:07`、`1:02:03`。 */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 記錄 / 匯出的預設檔名：`<主機>-20260928-150405.log`（檔名不能用的字元換成 _）。 */
export function defaultLogName(label: string, when: Date, ext = "log"): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  const safe = label.replace(/[<>:"/\\|?*\s]+/g, "_").replace(/^_+|_+$/g, "") || "ssh";
  return `${safe}-${stamp}.${ext}`;
}

/** xterm 緩衝區的每一行（`wrapped` = 這行是上一行太長自動折下來的）→ 文字；尾端的空行去掉。 */
export function bufferLinesToText(lines: readonly { text: string; wrapped: boolean }[]): string {
  const out: string[] = [];
  for (const l of lines) {
    if (l.wrapped && out.length) out[out.length - 1] += l.text;
    else out.push(l.text);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out.map((l) => l.replace(/\s+$/, "")).join("\n") + (out.length ? "\n" : "");
}
