// 指令輸出擷取（「執行並回饋」與命令列輸入條用）：把 xterm 收到的原始位元組去掉 ANSI，
// 等輸出閒置一小段就當作「這條指令跑完了」。純邏輯、只靠 setTimeout 與 Date，vitest fake timers 可測。
// 另附 guessOs / guessShell：從終端畫面尾巴猜作業系統與 shell，給 AI 上下文用；猜不到回 undefined，
// 由 AI 提示自己說「未知，請先給偵測指令」，不自動送任何偵測指令。

export interface StripResult {
  text: string;
  /** 尾端「還沒收完的逃逸序列」原文；下一段要接在前面重跑。 */
  carry: string;
}

const ESC = 0x1b;

/**
 * 去 ANSI（一段）。`ESC[3` | `2m` 被切在 chunk 邊界時，若不把殘段帶到下一段，色碼會漏一截進輸出。
 * 處理：CSI（ESC [ … 終止 0x40–0x7E）、OSC / DCS / SOS / PM / APC（… BEL 或 ST=ESC \）、
 * nF 型（ESC ( B、ESC # 8 …）、兩字元序列（ESC 7 / ESC = / ESC M …）；順手丟掉 \t \n \r 以外的 C0 控制字元。
 */
export function stripAnsiChunk(input: string): StripResult {
  let out = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input.charCodeAt(i);
    if (c !== ESC) {
      if (c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) out += input[i];
      i++;
      continue;
    }
    // ESC 落在最尾端：整段留到下一 chunk 再判斷
    if (i + 1 >= n) return { text: out, carry: input.slice(i) };
    const k = input.charCodeAt(i + 1);
    let end = -1; // 序列結束位置（exclusive）；-1 = 尚未收完
    if (k === 0x5b /* [ */) {
      let j = i + 2;
      while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x3f) j++;
      if (j < n) {
        const f = input.charCodeAt(j);
        // 合法終止字元一併吃掉；不合法（如控制字元、CJK）就只丟掉前面那截，該字元留下
        end = f >= 0x40 && f <= 0x7e ? j + 1 : j;
      }
    } else if (k === 0x5d /* ] */ || k === 0x50 /* P */ || k === 0x58 /* X */ || k === 0x5e /* ^ */ || k === 0x5f /* _ */) {
      let j = i + 2;
      while (j < n) {
        const cj = input.charCodeAt(j);
        if (cj === 0x07) {
          end = j + 1;
          break;
        }
        if (cj === ESC) {
          if (j + 1 >= n) break; // ESC 在尾端，還不知道是不是 ST
          if (input.charCodeAt(j + 1) === 0x5c /* \ */) {
            end = j + 2;
            break;
          }
        }
        j++;
      }
    } else if (k >= 0x20 && k <= 0x2f) {
      let j = i + 2;
      while (j < n && input.charCodeAt(j) >= 0x20 && input.charCodeAt(j) <= 0x2f) j++;
      if (j < n) end = j + 1;
    } else {
      end = i + 2;
    }
    if (end < 0) return { text: out, carry: input.slice(i) };
    i = end;
  }
  return { text: out, carry: "" };
}

/** 一次性去 ANSI（非串流）；尾端未收完的逃逸序列直接丟掉。 */
export function stripAnsi(s: string): string {
  return stripAnsiChunk(s).text;
}

/**
 * \r\n → \n；同一行內的孤立 \r 視為「回到行首重寫」，只留最後一段非空內容
 * （進度條 `50%\r100%\r` → `100%`）。
 */
export function normalizeLines(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segs = line.split("\r");
      for (let i = segs.length - 1; i >= 0; i--) if (segs[i] !== "") return segs[i];
      return "";
    })
    .join("\n");
}

// 提示符尾巴：$ # > ❯，或不接在數字後面的 %（`100%` 是輸出、`host %` 才是 zsh 提示符）。
const PROMPT_TAIL = /(?:[$#>❯]|(?<!\d)%)\s*$/;

/** 一行看起來像 shell 提示符（短、以 $ # % > 結尾）。只用來剔除輸出最後一行，寧可放過也別誤砍。 */
export function looksLikePrompt(line: string): boolean {
  const l = line.trim();
  return l.length > 0 && l.length <= 160 && PROMPT_TAIL.test(l);
}

export interface CaptureOptions {
  /** 多久沒有新資料就視為結束（預設 300）。 */
  idleMs?: number;
  /** 從開始算的總時限（預設 8000）；到了就帶著目前的輸出結束，truncated=true。 */
  maxMs?: number;
  /** 收到的位元組上限（預設 8192）；到了立刻結束，truncated=true。 */
  maxBytes?: number;
  /** 送出的指令；PTY 回聲的第一行若就是它（可帶提示符前綴）則剔除。 */
  echo?: string;
  /** 剔除最後一行看起來像提示符的短行（預設 true）。 */
  stripTrailingPrompt?: boolean;
}

export type CaptureEndReason = "idle" | "max_time" | "max_bytes" | "cancelled";

export interface CaptureResult {
  output: string;
  durationMs: number;
  /** 因 maxMs / maxBytes 提前結束（輸出可能不完整）。 */
  truncated: boolean;
  reason: CaptureEndReason;
}

export interface OutputCapture {
  push(chunk: Uint8Array | string): void;
  promise: Promise<CaptureResult>;
  /** 提前結束（resolve 目前已擷取的內容，不 reject）。 */
  cancel(): void;
  readonly done: boolean;
}

// OSC 沒收到終止符時 carry 會一直長；超過這個長度就當垃圾丟掉，別讓記憶體跟著輸出膨脹。
const MAX_CARRY = 4096;

function finalizeOutput(raw: string, opts: CaptureOptions): string {
  const lines = normalizeLines(raw).split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  const echo = opts.echo?.trim();
  if (echo && lines.length) {
    const first = lines[0].trim();
    if (first === echo || first.endsWith(echo)) lines.shift();
  }
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (opts.stripTrailingPrompt !== false && lines.length && looksLikePrompt(lines[lines.length - 1])) lines.pop();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.map((l) => l.replace(/\s+$/, "")).join("\n");
}

/**
 * 建立一次擷取。用法：`sendCommand` 先 `tapData(cap.push)` 再送指令，等 `cap.promise`。
 * 結束條件：閒置 idleMs（從建立那一刻就開始算，沒有任何輸出的指令也會在 idleMs 後結束）、
 * 距開始 maxMs、累計 maxBytes、或 cancel()。
 */
export function createOutputCapture(opts: CaptureOptions = {}): OutputCapture {
  const idleMs = opts.idleMs ?? 300;
  const maxMs = opts.maxMs ?? 8000;
  const maxBytes = opts.maxBytes ?? 8192;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();
  const start = Date.now();
  let buf = "";
  let carry = "";
  let bytes = 0;
  let done = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveP!: (r: CaptureResult) => void;
  const promise = new Promise<CaptureResult>((res) => {
    resolveP = res;
  });

  const finish = (reason: CaptureEndReason) => {
    if (done) return;
    done = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    // flush decoder 殘留的半個 UTF-8 序列（會變 U+FFFD）；carry 裡沒收完的逃逸序列直接丟
    buf += stripAnsiChunk(carry + decoder.decode()).text;
    if (buf.length > maxBytes) buf = buf.slice(0, maxBytes);
    resolveP({
      output: finalizeOutput(buf, opts),
      durationMs: Date.now() - start,
      truncated: reason === "max_time" || reason === "max_bytes",
      reason,
    });
  };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish("idle"), idleMs);
  };
  maxTimer = setTimeout(() => finish("max_time"), maxMs);
  armIdle();

  return {
    push(chunk) {
      if (done) return;
      let text: string;
      if (typeof chunk === "string") {
        text = chunk;
        bytes += encoder.encode(chunk).length;
      } else {
        text = decoder.decode(chunk, { stream: true });
        bytes += chunk.length;
      }
      const r = stripAnsiChunk(carry + text);
      buf += r.text;
      carry = r.carry.length > MAX_CARRY ? "" : r.carry;
      if (bytes >= maxBytes) {
        finish("max_bytes");
        return;
      }
      armIdle();
    },
    promise,
    cancel: () => finish("cancelled"),
    get done() {
      return done;
    },
  };
}

// ---- 環境猜測（給 AI 上下文）----

interface OsRule {
  re: RegExp;
  label: (m: RegExpMatchArray) => string;
}

// 順序即優先序：前面的先中。版本抓得到就帶上（Ubuntu 22.04 / Debian 12 / FreeBSD 14.0）。
const OS_RULES: OsRule[] = [
  { re: /\bUbuntu(?:\s+(\d+\.\d+))?/, label: (m) => (m[1] ? `Ubuntu ${m[1]}` : "Ubuntu") },
  { re: /\bDebian(?:\s+GNU\/Linux)?(?:\s+(\d+(?:\.\d+)?))?/, label: (m) => (m[1] ? `Debian ${m[1]}` : "Debian") },
  { re: /\bCentOS\s+Stream(?:\s+(?:release\s+)?(\d+))?/, label: (m) => (m[1] ? `CentOS Stream ${m[1]}` : "CentOS Stream") },
  { re: /\bCentOS(?:\s+Linux)?(?:\s+(?:release\s+)?(\d+(?:\.\d+)?))?/, label: (m) => (m[1] ? `CentOS ${m[1]}` : "CentOS") },
  { re: /\bRocky\s+Linux(?:\s+(?:release\s+)?(\d+(?:\.\d+)?))?/, label: (m) => (m[1] ? `Rocky Linux ${m[1]}` : "Rocky Linux") },
  { re: /\bAlmaLinux(?:\s+(?:release\s+)?(\d+(?:\.\d+)?))?/, label: (m) => (m[1] ? `AlmaLinux ${m[1]}` : "AlmaLinux") },
  { re: /\bFedora(?:\s+Linux)?(?:\s+(?:release\s+)?(\d+))?/, label: (m) => (m[1] ? `Fedora ${m[1]}` : "Fedora") },
  { re: /\bAlpine\s+Linux(?:\s+v?(\d+\.\d+))?/, label: (m) => (m[1] ? `Alpine Linux ${m[1]}` : "Alpine Linux") },
  { re: /\bArch\s*Linux\b/, label: () => "Arch Linux" },
  { re: /\bopenSUSE(?:\s+(Leap|Tumbleweed))?(?:\s+(\d+\.\d+))?/, label: (m) => ["openSUSE", m[1], m[2]].filter(Boolean).join(" ") },
  { re: /\bFreeBSD(?:\s+(\d+\.\d+))?/, label: (m) => (m[1] ? `FreeBSD ${m[1]}` : "FreeBSD") },
  { re: /\bmacOS(?:\s+(\d+(?:\.\d+)?))?/, label: (m) => (m[1] ? `macOS ${m[1]}` : "macOS") },
  { re: /\bDarwin\b/, label: () => "macOS" },
  { re: /Windows PowerShell|\bPowerShell \d|Microsoft Windows|Windows \[Version|^PS [A-Za-z]:\\/m, label: () => "Windows" },
];

/**
 * 從終端畫面尾巴（已去 ANSI）猜作業系統。優先吃 /etc/os-release 的 PRETTY_NAME，
 * 再比對 banner / uname / 提示符裡的發行版關鍵字；猜不到回 undefined。
 */
export function guessOs(tail: string): string | undefined {
  if (!tail) return undefined;
  const pretty = tail.match(/^\s*PRETTY_NAME="?([^"\n]+)"?\s*$/m);
  if (pretty?.[1]?.trim()) return pretty[1].trim();
  for (const rule of OS_RULES) {
    const m = tail.match(rule.re);
    if (m) return rule.label(m);
  }
  return undefined;
}

/**
 * 從最後一行提示符猜 shell：`$` / `#` → bash、`%` → zsh、`PS …>` → pwsh、`C:\…>` → cmd、其餘 `>` → fish。
 * 最後一行不像提示符就回 undefined。
 */
export function guessShell(tail: string): string | undefined {
  if (!tail) return undefined;
  const lines = tail.split(/\r?\n/);
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") {
      last = lines[i].trim();
      break;
    }
  }
  if (!last || last.length > 160) return undefined;
  if (/^PS\s.*>$/.test(last)) return "pwsh";
  if (/^[A-Za-z]:\\.*>$/.test(last)) return "cmd";
  const tailCh = last[last.length - 1];
  if (tailCh === "$" || tailCh === "#") return "bash";
  if (tailCh === "%") return /\d%$/.test(last) ? undefined : "zsh";
  if (tailCh === ">") return "fish";
  return undefined;
}
