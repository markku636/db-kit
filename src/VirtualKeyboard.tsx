// 虛擬鍵盤：點按鍵就送到遠端（rawKey，set-1 掃描碼；VNC 由 VncView 換成 keysym）。本機 OS 會先吃掉的鍵（Win、Alt+Tab、
// PrintScreen）、本機鍵盤沒有的鍵（Pause、Menu、F13 以上不放），或要校正對方 CapsLock 指示燈時用。
// - Shift / Ctrl / Alt / Win / AltGr 按一下＝按住（標亮），再按一下放開；按了一般鍵之後自動全部放開（像系統的螢幕小鍵盤）。
// - 按鍵用 pointerdown 的 preventDefault 留住遠端畫面的鍵盤焦點（焦點跑掉時遠端畫面會把按著的鍵放開）。
// - 關掉鍵盤時把還按著的修飾鍵放開。
// - CapsLock 跟本機連動（RustDesk + Windows，`onCapsLock`）：按 CapsLock 是切換作業系統的 CapsLock，對方跟著；
//   CapsLock 開著時這顆標亮，字母照「CapsLock 與 Shift」顯示大寫 / 小寫。
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "./i18n";
import { IconButton } from "./ui/index";
import { MAIN_ROWS, NAV_ROWS, type VKey } from "./vkLayout";

const SHIFTS = new Set([0x2a, 0x36]);
const CAPS_LOCK = 0x3a;

export interface VirtualKeyboardProps {
  /** 送一個按鍵（按下 / 放開）。 */
  onKey: (scancode: number, down: boolean) => void;
  onClose: () => void;
  /** RustDesk：打出來的大小寫跟著本機 CapsLock（說明文字不同）。 */
  rustdesk: boolean;
  /** 有給 = CapsLock 跟本機連動：按這顆改呼叫它（`wasOn` = 按之前本機的 CapsLock 開著沒），不送掃描碼。 */
  onCapsLock?: (wasOn: boolean) => void;
}

export default function VirtualKeyboard({ onKey, onClose, rustdesk, onCapsLock }: VirtualKeyboardProps) {
  const t = useT();
  /** 按住中的修飾鍵（已送出按下）。 */
  const [held, setHeld] = useState<number[]>([]);
  const heldRef = useRef<number[]>([]);
  const onKeyRef = useRef(onKey);
  useEffect(() => { onKeyRef.current = onKey; }, [onKey]);
  const setHeldBoth = (v: number[]) => { heldRef.current = v; setHeld(v); };
  // 關掉鍵盤：還按著的修飾鍵放開。
  useEffect(() => () => { for (const sc of [...heldRef.current].reverse()) onKeyRef.current(sc, false); }, []);

  /** 本機的 CapsLock（連動時才用）：從經過的鍵盤 / 滑鼠事件讀，實體鍵盤切換也跟得上。 */
  const linked = !!onCapsLock;
  const [caps, setCaps] = useState(false);
  const readCaps = (e: { getModifierState(key: string): boolean }) => { if (linked) setCaps(e.getModifierState("CapsLock")); };
  useEffect(() => {
    if (!linked) return;
    const h = (e: KeyboardEvent) => setCaps(e.getModifierState("CapsLock"));
    window.addEventListener("keydown", h, true);
    window.addEventListener("keyup", h, true);
    return () => {
      window.removeEventListener("keydown", h, true);
      window.removeEventListener("keyup", h, true);
    };
  }, [linked]);

  const press = (key: VKey, e: React.MouseEvent) => {
    if (key.gap) return;
    const cur = heldRef.current;
    if (key.mod) {
      if (cur.includes(key.sc)) {
        onKey(key.sc, false);
        setHeldBoth(cur.filter((x) => x !== key.sc));
      } else {
        onKey(key.sc, true);
        setHeldBoth([...cur, key.sc]);
      }
      return;
    }
    if (onCapsLock && key.sc === CAPS_LOCK) {
      const wasOn = e.getModifierState("CapsLock");
      setCaps(!wasOn);
      onCapsLock(wasOn);
    } else {
      onKey(key.sc, true);
      onKey(key.sc, false);
    }
    for (const sc of [...cur].reverse()) onKey(sc, false);
    if (cur.length) setHeldBoth([]);
  };

  const shifted = held.some((sc) => SHIFTS.has(sc));
  const labelOf = (key: VKey): string => {
    if (linked && /^[A-Z]$/.test(key.l)) return caps !== shifted ? key.l : key.l.toLowerCase();
    return shifted && key.s ? key.s : key.l;
  };
  const renderRow = (keys: VKey[], i: number) => (
    <div key={i} className="flex gap-1 h-8">
      {keys.map((key, j) => {
        const style = { flex: `${key.w ?? 1} ${key.w ?? 1} 0` };
        if (key.gap) return <span key={j} style={style} />;
        const on = (key.mod && held.includes(key.sc)) || (linked && key.sc === CAPS_LOCK && caps);
        return (
          <button key={j} type="button" style={style} data-vk-key={key.sc} data-vk-held={on ? "" : undefined}
            title={key.l}
            onPointerDown={(e) => e.preventDefault()}
            onClick={(e) => press(key, e)}
            className={`min-w-0 rounded border text-[11px] leading-none truncate px-0.5 select-none transition-colors ${
              on ? "bg-accent text-white border-accent" : "bg-fg/5 border-fg/15 text-fg/80 hover:bg-fg/15 active:bg-fg/25"}`}>
            {labelOf(key)}
          </button>
        );
      })}
    </div>
  );

  let help = t("Shift / Ctrl / Alt / Win 按一下會按住，按了下一個鍵就放開。");
  if (linked) help = t("Shift / Ctrl / Alt / Win 按一下會按住，按了下一個鍵就放開。CapsLock 跟本機連動：按這裡的 CapsLock 會切換本機的 CapsLock，對方跟著變。");
  else if (rustdesk) help = t("Shift / Ctrl / Alt / Win 按一下會按住，按了下一個鍵就放開。打出來的大小寫跟著本機的 CapsLock；對方畫面的 CapsLock 指示燈跟本機不一樣時，按這裡的 CapsLock 校正。");
  return (
    <div className="shrink-0 border-t border-fg/10 bg-panel px-2 pt-1.5 pb-2" data-rd-vk="" data-vk-caps={linked && caps ? "" : undefined}
      onPointerDown={(e) => { e.preventDefault(); readCaps(e); }} onPointerEnter={readCaps}>
      <div className="flex items-center gap-2 mb-1.5 text-[11px] text-fg/50">
        <span className="text-fg/70">{t("虛擬鍵盤")}</span>
        <span className="truncate" title={help}>{help}</span>
        <IconButton icon={X} iconSize={14} box="w-6 h-6" className="ml-auto" label={t("關閉虛擬鍵盤")} onClick={onClose} />
      </div>
      <div className="flex gap-3 max-w-[1100px] mx-auto">
        <div className="flex flex-col gap-1" style={{ flex: "15 15 0" }}>{MAIN_ROWS.map(renderRow)}</div>
        <div className="flex flex-col gap-1" style={{ flex: "3 3 0" }}>{NAV_ROWS.map(renderRow)}</div>
      </div>
    </div>
  );
}
