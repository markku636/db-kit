// RustDesk 聊天（官方用戶端的「聊天」）：畫面右側的面板，對方的訊息靠左、自己的靠右；Enter 送出、Shift+Enter 換行。
// 訊息經 bridge 的 `Misc.chat_message` 來回；對方那邊會在 RustDesk 的連線管理視窗看到。
import { useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import { useT } from "./i18n";
import { IconButton } from "./ui/index";
import type { RdChatMsg } from "./rustdeskState";

function hhmm(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function RustDeskChat({ messages, peerName, connected, onSend, onClose }: {
  messages: RdChatMsg[];
  peerName: string;
  connected: boolean;
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = () => {
    const s = draft.trim();
    if (!s || !connected) return;
    onSend(s);
    setDraft("");
    inputRef.current?.focus();
  };

  return (
    <div className="absolute top-0 right-0 bottom-0 w-72 max-w-[85%] z-10 flex flex-col bg-panel border-l border-fg/10 shadow-2xl text-sm"
      data-rd-chat="" onKeyDown={(e) => e.stopPropagation()}>
      <div className="h-8 shrink-0 flex items-center gap-2 px-2 border-b border-fg/10">
        <span className="truncate text-fg/80">{t("和 {name} 聊天", { name: peerName })}</span>
        <IconButton icon={X} label={t("關閉聊天")} box="w-6 h-6" iconSize={14} className="ml-auto" onClick={onClose} />
      </div>
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2" data-rd-chat-list="">
        {messages.length === 0 && (
          <div className="text-xs text-fg/40 text-center mt-6 px-4">{t("訊息會出現在對方 RustDesk 的連線視窗裡。")}</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.from === "me" ? "items-end" : "items-start"}`} data-rd-chat-msg={m.from}>
            <div className={`max-w-[90%] px-2.5 py-1.5 rounded-lg whitespace-pre-wrap break-words ${m.from === "me" ? "bg-accent text-white" : "bg-fg/10 text-fg/90"}`}>
              {m.text}
            </div>
            <span className="text-[10px] text-fg/35 mt-0.5">{hhmm(m.at)}</span>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-t border-fg/10 p-2 flex items-end gap-1.5">
        <textarea ref={inputRef} value={draft} rows={2} disabled={!connected} data-rd-chat-input=""
          placeholder={connected ? t("輸入訊息，Enter 送出") : t("連線後才能傳訊息")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="flex-1 min-w-0 resize-none rounded border border-fg/15 bg-app px-2 py-1 text-sm outline-none focus:border-accent/60 disabled:opacity-50" />
        <IconButton icon={Send} label={t("送出")} disabled={!connected || !draft.trim()} onClick={submit} />
      </div>
    </div>
  );
}
