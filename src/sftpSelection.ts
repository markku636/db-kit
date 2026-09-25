// SFTP 清單的多選（檔案總管 / Xftp 慣例）：單擊只選這一個、Ctrl 單擊切換、Shift 單擊從錨點選到這裡、
// Ctrl+A 全選。純函式——選取狀態是「名稱集合 + 錨點」，清單順序由呼叫端給（排序 / 篩選後的順序）。

export interface Selection {
  names: ReadonlySet<string>;
  /** Shift 範圍選取的起點；也是單一操作（Enter / F2 / 狀態列）的對象。 */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { names: new Set(), anchor: null };

export function single(name: string): Selection {
  return { names: new Set([name]), anchor: name };
}

/**
 * 滑鼠點一列。`order` 是目前畫面上的順序（Shift 範圍照它算）。
 * Shift+Ctrl：把範圍加進既有選取（不取代），與 Windows 檔案總管一致。
 */
export function clickSelect(
  sel: Selection,
  name: string,
  mods: { ctrl: boolean; shift: boolean },
  order: readonly string[],
): Selection {
  if (mods.shift && sel.anchor && order.includes(sel.anchor)) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(name);
    if (b >= 0) {
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const range = order.slice(lo, hi + 1);
      const names = new Set(mods.ctrl ? [...sel.names, ...range] : range);
      return { names, anchor: sel.anchor };
    }
  }
  if (mods.ctrl) {
    const names = new Set(sel.names);
    if (names.has(name)) names.delete(name);
    else names.add(name);
    return { names, anchor: name };
  }
  return single(name);
}

/** 右鍵點一列：已在選取裡就保留整組（對整組操作）；不在就改成只選它。 */
export function contextSelect(sel: Selection, name: string): Selection {
  return sel.names.has(name) ? sel : single(name);
}

export function selectAll(order: readonly string[]): Selection {
  return { names: new Set(order), anchor: order[0] ?? null };
}

/** 清單換了（重新整理 / 篩選 / 換資料夾）：丟掉已經看不到的名稱；錨點不在了就換成剩下的第一個。 */
export function pruneSelection(sel: Selection, order: readonly string[]): Selection {
  const visible = new Set(order);
  const names = new Set([...sel.names].filter((n) => visible.has(n)));
  if (names.size === sel.names.size && (sel.anchor == null || visible.has(sel.anchor))) return sel;
  const anchor = sel.anchor && visible.has(sel.anchor) ? sel.anchor : ([...names][0] ?? null);
  return { names, anchor };
}

/** 方向鍵：錨點往上 / 下一格並只選它（Shift+方向鍵延伸範圍）。 */
export function moveSelect(sel: Selection, delta: 1 | -1, order: readonly string[], extend: boolean): Selection {
  if (!order.length) return EMPTY_SELECTION;
  const i = sel.anchor ? order.indexOf(sel.anchor) : -1;
  const next = order[Math.min(order.length - 1, Math.max(0, i < 0 ? 0 : i + delta))];
  if (!extend) return single(next);
  const names = new Set(sel.names);
  names.add(next);
  return { names, anchor: next };
}

/** 依畫面順序列出選取的名稱（批次操作照這個順序跑，錯誤訊息才對得上畫面）。 */
export function selectedInOrder(sel: Selection, order: readonly string[]): string[] {
  return order.filter((n) => sel.names.has(n));
}
