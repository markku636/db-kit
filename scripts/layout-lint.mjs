// 版面巡檢：在頁面裡持續掃描「跑版」的三種典型症狀，給 verify-ui 的 DBKIT_LAYOUT_LINT=1 模式用。
//
//   wrap     短標籤（按鈕 / 分頁 / 單選 / 選單項 / label / 表頭 / 標題…，2–16 字）被擠成多行——
//            中文沒有空白可斷，寬度不夠就一字一行（「人 / 設」、「重新連 / 線」）。
//   clipped  單行文字（nowrap）被裁掉卻沒有省略號：看起來像字寫錯，不像「放不下」。
//   hscroll  不該橫向捲動的容器出現橫向捲軸（表格、程式碼、終端機、編輯器除外），或整頁可橫向捲動。
//   cut      按鈕超出會裁切它的祖先（overflow 不是 visible）的邊界：按鈕不換行之後，外層那一列若不能
//            換行，按鈕就會被切掉一截——這比直排好，但一樣是跑版。
//
// 做法：MutationObserver + ResizeObserver 觸發、停 300ms 後掃一次（對話框開關、分頁切換都會被看到），
// 結果以「種類 + 位置 + 文字」去重累積在 window.__LAYOUT_ISSUES__。installLayoutLint 會被序列化
// 後當 init script 注入，所以只能用頁面內的東西、不能引用外部變數。

export function installLayoutLint() {
  const issues = new Map();
  window.__LAYOUT_ISSUES__ = issues;
  const LABELISH = "button,[role=tab],[role=radio],[role=menuitem],[role=option],label,th,h1,h2,h3,h4,legend,summary,dt";
  // 本來就該能橫向捲動的：資料表格、程式碼、終端機、編輯器、選單清單的虛擬捲動。
  const HSCROLL_OK = "table,pre,code,.xterm,.cm-editor,.cm-scroller,.at-grid,[data-hscroll-ok],[role=grid],[role=treegrid]";

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  };
  const where = (el) => {
    const dlg = el.closest("[role=dialog]");
    const title = dlg?.querySelector("h1,h2,h3,[data-modal-title]")?.textContent?.trim().slice(0, 30);
    const cls = (el.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 4).join(".");
    return `${title ? `〔${title}〕` : ""}${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  };
  const record = (kind, el, text, extra = {}) => {
    const key = `${kind}|${where(el)}|${text}`;
    if (issues.has(key)) return;
    const r = el.getBoundingClientRect();
    issues.set(key, { kind, where: where(el), text, w: Math.round(r.width), ...extra });
  };
  const lineCount = (node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const tops = [];
    for (const rect of range.getClientRects()) {
      if (rect.width < 1) continue;
      if (!tops.some((t) => Math.abs(t - rect.top) <= 3)) tops.push(rect.top);
    }
    return tops.length;
  };

  const scan = () => {
    // 1) 短標籤換行
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const text = n.textContent.replace(/\s+/g, " ").trim();
      if (text.length < 2 || text.length > 16) continue;
      const host = n.parentElement?.closest(LABELISH);
      if (!host || !visible(host)) continue;
      const lines = lineCount(n);
      if (lines >= 2) record("wrap", host, text, { lines });
    }
    // 2) 沒有省略號的裁字、3) 不該出現的橫向捲軸
    for (const el of document.body.querySelectorAll("*")) {
      if (el.closest(HSCROLL_OK) || !visible(el)) continue;
      const cs = getComputedStyle(el);
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 2) continue;
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.clientHeight > 0) {
        record("hscroll", el, (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40), { over });
        continue;
      }
      const ownText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
      if (ownText && (cs.overflowX === "hidden" || cs.overflowX === "clip") && cs.whiteSpace.startsWith("nowrap") && cs.textOverflow !== "ellipsis") {
        record("clipped", el, el.textContent.replace(/\s+/g, " ").trim().slice(0, 40), { over });
      }
    }
    // 4) 按鈕被外層裁掉
    // 只有「包含區塊鏈」上的 overflow 會裁切：fixed 元素不被任何祖先裁（除非祖先本身是 fixed 的容器）；
    // absolute 元素會跳過它與定位祖先之間那些 static 的 overflow 容器。
    for (const btn of document.body.querySelectorAll("button,[role=tab],[role=radio]")) {
      if (btn.closest(HSCROLL_OK) || !visible(btn)) continue;
      const r = btn.getBoundingClientRect();
      let pos = getComputedStyle(btn).position;
      if (pos === "fixed") continue;
      let skipStatic = pos === "absolute";
      for (let a = btn.parentElement; a && a !== document.body; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (skipStatic) {
          if (cs.position === "static") continue;
          skipStatic = false;
        }
        if (cs.overflowX !== "visible") {
          const box = a.getBoundingClientRect();
          const out = Math.max(0, r.right - box.right, box.left - r.left);
          if (out > 1.5) record("cut", btn, (btn.textContent || btn.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 30), { over: Math.round(out) });
          break;
        }
        pos = cs.position;
        if (pos === "fixed") break;
        if (pos === "absolute") skipStatic = true;
      }
    }
    const doc = document.scrollingElement;
    if (doc && doc.scrollWidth > window.innerWidth + 1) record("hscroll", document.body, "(整頁)", { over: doc.scrollWidth - window.innerWidth });
  };

  let timer = 0;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => { try { scan(); } catch { /* 掃描失敗不影響情境 */ } }, 300); };
  window.__LAYOUT_SCAN__ = scan;
  const start = () => {
    new MutationObserver(later).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    new ResizeObserver(later).observe(document.body);
    later();
  };
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

/** 立刻再掃一次（讓最後一個畫面也算到）後取回累積的問題。 */
export async function collectLayoutIssues(page) {
  return page.evaluate(() => {
    try { window.__LAYOUT_SCAN__?.(); } catch { /* ignore */ }
    return [...(window.__LAYOUT_ISSUES__?.values() ?? [])];
  }).catch(() => []);
}
