// SSH 終端機底部的命令列輸入條（Xshell 的「compose bar」）：在一般文字框裡打好、按 Enter 才送進 shell。
// 好處：可以貼多行、用 ↑/↓ 翻自己的歷史（跨主機）、AI「送到終端機」把建議放進來給你看過再送。
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CornerDownLeft } from "lucide-react";
import { useT } from "./i18n";
import { Icon } from "./ui/index";
import { toast } from "./ui";
import { useSshTerminals, termRegistry } from "./sshTerminals";
import { loadComposeHistory, pushComposeHistory } from "./sshPrefs";

export default function SshComposeBar({ tabKey, extra }: { tabKey: string; extra?: ReactNode }) {
  const t = useT();
  const value = useSshTerminals((s) => s.compose[tabKey] ?? "");
  const connected = useSshTerminals((s) => s.rt[tabKey]?.status === "connected");
  const setCompose = useSshTerminals((s) => s.setCompose);
  const sendCommand = useSshTerminals((s) => s.sendCommand);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 歷史瀏覽游標：-1 = 不在歷史裡（正在編輯新內容）；往上時把正在編輯的內容暫存，回到底部時還原。
  const [histIdx, setHistIdx] = useState(-1);
  const draftRef = useRef("");
  const historyRef = useRef<string[]>([]);
  useEffect(() => { historyRef.current = loadComposeHistory(); }, []);

  // 自動長高（1–5 行）：多行貼上看得到全貌，單行時不佔空間。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const lineH = 20;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, lineH), lineH * 5 + 8)}px`;
  }, [value]);

  const submit = async () => {
    const text = value.replace(/\s+$/, "");
    if (!text.trim()) return;
    if (!connected) { toast.info(t("終端機尚未連線")); return; }
    setCompose(tabKey, "");
    setHistIdx(-1);
    historyRef.current = pushComposeHistory(text);
    // 不等擷取結束（那是給 AI 回饋用的）；失敗才提示。
    sendCommand(tabKey, text).catch((e) => toast.error(String((e as Error)?.message ?? e)));
    termRegistry.get(tabKey)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      // 中文輸入法組字中的 Enter 是「選字」，不能當送出。
      if (e.nativeEvent.isComposing) return;
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      termRegistry.get(tabKey)?.focus();
      return;
    }
    const el = e.currentTarget;
    const hist = historyRef.current;
    if (e.key === "ArrowUp" && hist.length && el.value.slice(0, el.selectionStart).indexOf("\n") < 0) {
      // 游標在第一行才翻歷史；否則交給 textarea 自己移動游標。
      e.preventDefault();
      const next = histIdx < 0 ? hist.length - 1 : Math.max(0, histIdx - 1);
      if (histIdx < 0) draftRef.current = value;
      setHistIdx(next);
      setCompose(tabKey, hist[next]);
      return;
    }
    if (e.key === "ArrowDown" && histIdx >= 0 && el.value.slice(el.selectionEnd).indexOf("\n") < 0) {
      e.preventDefault();
      const next = histIdx + 1;
      if (next >= hist.length) { setHistIdx(-1); setCompose(tabKey, draftRef.current); }
      else { setHistIdx(next); setCompose(tabKey, hist[next]); }
    }
  };

  return (
    <div className="shrink-0 flex items-end gap-1.5 px-2 py-1.5 border-t border-fg/10 bg-panel">
      <span className="mono text-xs text-fg/40 pb-1 select-none" aria-hidden>❯</span>
      <textarea
        ref={ref}
        data-testid="ssh-compose"
        value={value}
        onChange={(e) => { setCompose(tabKey, e.target.value); if (histIdx >= 0) setHistIdx(-1); }}
        onKeyDown={onKeyDown}
        rows={1}
        spellCheck={false}
        placeholder={connected ? t("輸入指令…（Enter 送出、Shift+Enter 換行、↑↓ 歷史）") : t("終端機尚未連線")}
        className="mono flex-1 min-w-0 resize-none bg-transparent text-xs leading-5 py-1 outline-none placeholder:text-fg/30"
      />
      {extra}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!connected || !value.trim()}
        title={t("送出（Enter）")}
        aria-label={t("送出（Enter）")}
        className="w-7 h-7 grid place-items-center rounded text-fg/55 hover:text-fg hover:bg-fg/10 disabled:opacity-40 disabled:pointer-events-none"
      >
        <Icon icon={CornerDownLeft} size={14} />
      </button>
    </div>
  );
}
