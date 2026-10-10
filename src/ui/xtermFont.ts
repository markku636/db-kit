// SSH 終端機與容器終端機共用的 xterm 字型設定。
import type { Terminal } from "@xterm/xterm";

const BUNDLED = '"JetBrains Mono Variable"';

/**
 * App 內嵌的 JetBrains Mono（fonts.css 註冊名是 "JetBrains Mono Variable"）排第一，各平台英數都是同一套字；
 * 中文再往後找系統字。
 *
 * 不能只寫 "JetBrains Mono"：較舊的 WebKitGTK（例如 Ubuntu 24.04 原版的 2.44）遇到沒裝的字型，會照收
 * fontconfig 給的替代字——中文系統上是比例字 Noto Sans CJK TC。xterm 拿它的 'W' 量格寬（約 0.86em），
 * 每個字都落在這麼寬的格子裡，看起來就是字字隔一大格。
 */
export const TERM_FONT = `${BUNDLED}, "JetBrains Mono", "Cascadia Mono", Consolas, "Noto Sans Mono CJK TC", "Microsoft JhengHei", monospace`;

/**
 * 內嵌字型還沒載完就開的終端機，格寬是拿備援字量的；等字型到了再量一次、重畫字形快取
 * （xterm 只在字型 / 字級改了才重量）。
 * 不先用 fonts.check() 判斷要不要等：WebKit 在字型還沒載入時也回 true，會漏掉重量，格寬卡在備援字的寬度。
 * 回傳取消函式，卸載時呼叫。
 */
export function remeasureWhenFontLoads(term: Terminal, onRemeasured: () => void): () => void {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  if (!fonts) return () => undefined;
  const spec = `${term.options.fontSize ?? 13}px ${BUNDLED}`;
  let alive = true;
  void fonts.load(spec).then(() => {
    if (!alive) return;
    // 同一串字型多一個空白：值不同才會觸發 xterm 重量，CSS 上是同一組字。
    const family = term.options.fontFamily ?? TERM_FONT;
    term.options.fontFamily = family.endsWith(" ") ? family.trimEnd() : `${family} `;
    term.clearTextureAtlas();
    onRemeasured();
  }).catch(() => undefined);
  return () => { alive = false; };
}
