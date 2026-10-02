// 虛擬鍵盤：點按鍵就送到遠端（RustDesk / RDP 的 rawKey，set-1 掃描碼）。本機 OS 會先吃掉的鍵（Win、Alt+Tab、
// PrintScreen）、本機鍵盤沒有的鍵（Pause、Menu、F13 以上不放），或要校正對方 CapsLock 指示燈時用。
// - Shift / Ctrl / Alt / Win / AltGr 按一下＝按住（標亮），再按一下放開；按了一般鍵之後自動全部放開（像系統的螢幕小鍵盤）。
// - 按鍵用 pointerdown 的 preventDefault 留住遠端畫面的鍵盤焦點（焦點跑掉時遠端畫面會把按著的鍵放開）。
// - 關掉鍵盤時把還按著的修飾鍵放開。
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "./i18n";
import { IconButton } from "./ui/index";
import { RD_SCANCODE_PAUSE } from "./rdInput";

const E0 = 0xe000;

export interface VKey {
  /** 顯示的字；`s` = 按住 Shift 時顯示的字。 */
  l: string;
  s?: string;
  sc: number;
  /** 寬度（一般鍵 = 1）。 */
  w?: number;
  /** 修飾鍵：按一下按住、再按一下放開。 */
  mod?: boolean;
  /** 空白（不是鍵，只佔位）。 */
  gap?: boolean;
}

const k = (l: string, sc: number, w?: number, s?: string): VKey => ({ l, sc, w, s });
const mod = (l: string, sc: number, w: number): VKey => ({ l, sc, w, mod: true });
const gap = (w: number): VKey => ({ l: "", sc: 0, w, gap: true });
const row = (chars: string, shifted: string, first: number): VKey[] =>
  [...chars].map((c, i) => k(c.toUpperCase(), first + i, 1, shifted[i] !== c.toUpperCase() ? shifted[i] : undefined));

/** 主鍵盤（每列寬 15）。 */
export const MAIN_ROWS: VKey[][] = [
  [k("Esc", 0x01), gap(1), ...["F1", "F2", "F3", "F4"].map((f, i) => k(f, 0x3b + i)), gap(0.5),
    ...["F5", "F6", "F7", "F8"].map((f, i) => k(f, 0x3f + i)), gap(0.5),
    k("F9", 0x43), k("F10", 0x44), k("F11", 0x57), k("F12", 0x58)],
  [k("`", 0x29, 1, "~"), ...[..."1234567890"].map((c, i) => k(c, 0x02 + i, 1, "!@#$%^&*()"[i])), k("-", 0x0c, 1, "_"), k("=", 0x0d, 1, "+"),
    k("Backspace", 0x0e, 2)],
  [k("Tab", 0x0f, 1.5), ...row("qwertyuiop", "QWERTYUIOP", 0x10), k("[", 0x1a, 1, "{"), k("]", 0x1b, 1, "}"), k("\\", 0x2b, 1.5, "|")],
  [k("CapsLock", 0x3a, 1.75), ...row("asdfghjkl", "ASDFGHJKL", 0x1e), k(";", 0x27, 1, ":"), k("'", 0x28, 1, "\""), k("Enter", 0x1c, 2.25)],
  [mod("Shift", 0x2a, 2.25), ...row("zxcvbnm", "ZXCVBNM", 0x2c), k(",", 0x33, 1, "<"), k(".", 0x34, 1, ">"), k("/", 0x35, 1, "?"),
    mod("Shift", 0x36, 2.75)],
  [mod("Ctrl", 0x1d, 1.25), mod("Win", E0 | 0x5b, 1.25), mod("Alt", 0x38, 1.25), k("Space", 0x39, 6.25), mod("AltGr", E0 | 0x38, 1.25),
    mod("Win", E0 | 0x5c, 1.25), k("Menu", E0 | 0x5d, 1.25), mod("Ctrl", E0 | 0x1d, 1.25)],
];

/** 編輯鍵與方向鍵（每列寬 3，跟主鍵盤同列對齊）。 */
export const NAV_ROWS: VKey[][] = [
  [k("PrtSc", E0 | 0x37), k("ScrLk", 0x46), k("Pause", RD_SCANCODE_PAUSE)],
  [k("Ins", E0 | 0x52), k("Home", E0 | 0x47), k("PgUp", E0 | 0x49)],
  [k("Del", E0 | 0x53), k("End", E0 | 0x4f), k("PgDn", E0 | 0x51)],
  [gap(3)],
  [gap(1), k("↑", E0 | 0x48), gap(1)],
  [k("←", E0 | 0x4b), k("↓", E0 | 0x50), k("→", E0 | 0x4d)],
];

const SHIFTS = new Set([0x2a, 0x36]);

export interface VirtualKeyboardProps {
  /** 送一個按鍵（按下 / 放開）。 */
  onKey: (scancode: number, down: boolean) => void;
  onClose: () => void;
  /** RustDesk：打出來的大小寫跟著本機 CapsLock（說明文字不同）。 */
  rustdesk: boolean;
}

export default function VirtualKeyboard({ onKey, onClose, rustdesk }: VirtualKeyboardProps) {
  const t = useT();
  /** 按住中的修飾鍵（已送出按下）。 */
  const [held, setHeld] = useState<number[]>([]);
  const heldRef = useRef<number[]>([]);
  const onKeyRef = useRef(onKey);
  useEffect(() => { onKeyRef.current = onKey; }, [onKey]);
  const setHeldBoth = (v: number[]) => { heldRef.current = v; setHeld(v); };
  // 關掉鍵盤：還按著的修飾鍵放開。
  useEffect(() => () => { for (const sc of [...heldRef.current].reverse()) onKeyRef.current(sc, false); }, []);

  const press = (key: VKey) => {
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
    onKey(key.sc, true);
    onKey(key.sc, false);
    for (const sc of [...cur].reverse()) onKey(sc, false);
    if (cur.length) setHeldBoth([]);
  };

  const shifted = held.some((sc) => SHIFTS.has(sc));
  const renderRow = (keys: VKey[], i: number) => (
    <div key={i} className="flex gap-1 h-8">
      {keys.map((key, j) => {
        const style = { flex: `${key.w ?? 1} ${key.w ?? 1} 0` };
        if (key.gap) return <span key={j} style={style} />;
        const on = key.mod && held.includes(key.sc);
        const label = shifted && key.s ? key.s : key.l;
        return (
          <button key={j} type="button" style={style} data-vk-key={key.sc} data-vk-held={on ? "" : undefined}
            title={key.l}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => press(key)}
            className={`min-w-0 rounded border text-[11px] leading-none truncate px-0.5 select-none transition-colors ${
              on ? "bg-accent text-white border-accent" : "bg-fg/5 border-fg/15 text-fg/80 hover:bg-fg/15 active:bg-fg/25"}`}>
            {label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="shrink-0 border-t border-fg/10 bg-panel px-2 pt-1.5 pb-2" data-rd-vk=""
      onPointerDown={(e) => e.preventDefault()}>
      <div className="flex items-center gap-2 mb-1.5 text-[11px] text-fg/50">
        <span className="text-fg/70">{t("虛擬鍵盤")}</span>
        <span className="truncate" title={rustdesk
          ? t("Shift / Ctrl / Alt / Win 按一下會按住，按了下一個鍵就放開。打出來的大小寫跟著本機的 CapsLock；對方畫面的 CapsLock 指示燈跟本機不一樣時，按這裡的 CapsLock 校正。")
          : t("Shift / Ctrl / Alt / Win 按一下會按住，按了下一個鍵就放開。")}>
          {rustdesk
            ? t("Shift / Ctrl / Alt / Win 按一下會按住，按了下一個鍵就放開。打出來的大小寫跟著本機的 CapsLock；對方畫面的 CapsLock 指示燈跟本機不一樣時，按這裡的 CapsLock 校正。")
            : t("Shift / Ctrl / Alt / Win 按一下會按住，按了下一個鍵就放開。")}
        </span>
        <IconButton icon={X} iconSize={14} box="w-6 h-6" className="ml-auto" label={t("關閉虛擬鍵盤")} onClick={onClose} />
      </div>
      <div className="flex gap-3 max-w-[1100px] mx-auto">
        <div className="flex flex-col gap-1" style={{ flex: "15 15 0" }}>{MAIN_ROWS.map(renderRow)}</div>
        <div className="flex flex-col gap-1" style={{ flex: "3 3 0" }}>{NAV_ROWS.map(renderRow)}</div>
      </div>
    </div>
  );
}
