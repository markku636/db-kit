import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  AgentEvent,
  AgentMode,
  ClaudeStatus,
  KIND_META,
  onClaudeStream,
} from "./api";
import { useStore } from "./store";
import { useTheme } from "./theme";
import { resolveHighlightColors, type ThemeColors } from "./editorThemes";
import { useAssistant } from "./assistant";
import { toast, copyToClipboard, pickSaveFile, uiConfirm } from "./ui";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/index";
import { Folder, Download, Trash2, PanelRightClose, RefreshCw, Settings, Sparkles, Send, Square } from "lucide-react";

// 右側「AI 助手」面板：驅動本機 claude CLI（使用 Claude 訂閱登入），
// 串流回答問題與撰寫腳本。對標右側詳細資料面板的版面與主題用色。
// 串流事件走後端 `claude-stream`（見 agent.rs / onClaudeStream）。

type ChatRole = "user" | "assistant";

interface ChatMsg {
  id: string;
  role: ChatRole;
  text: string;
  tools: string[];
  pending: boolean;
  error: boolean;
  ms?: number; // 本則回應耗時（result.duration_ms）
}

const MODELS: { value: string; label: string }[] = [
  { value: "", label: "預設模型" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

// ---- 對話 / 偏好持久化（localStorage；重開 db-kit 後保留）----
const CHAT_KEY = "db-kit:assistantChat";

interface Persisted {
  messages: ChatMsg[];
  sessionId: string | null;
  mode: AgentMode;
  model: string;
  ctxOn: boolean;
}

function loadPersisted(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY) || "{}") as Partial<Persisted>;
  } catch {
    return {};
  }
}

export default function AssistantPanel() {
  const open = useAssistant((s) => s.open);
  const persisted = useMemo(loadPersisted, []);

  const [messages, setMessages] = useState<ChatMsg[]>(() =>
    (persisted.messages || []).map((m) => ({ ...m, pending: false, tools: m.tools || [] })),
  );
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [ctxOn, setCtxOn] = useState(persisted.ctxOn ?? true);
  const [mode, setMode] = useState<AgentMode>(persisted.mode || "advise");
  const [model, setModel] = useState(persisted.model || "");
  const [width, setWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem("db-kit:assistantWidth"));
    return v >= 300 && v <= 900 ? v : 384;
  });
  // 輸入區高度：0 = 隨內容自動長高；> 0 = 使用者手動拖曳的固定高度。
  const [inputH, setInputH] = useState<number>(() => {
    const v = Number(localStorage.getItem("db-kit:assistantInputH"));
    return v >= 40 && v <= 400 ? v : 0;
  });
  const seed = useAssistant((s) => s.seed);

  const sessionIdRef = useRef<string | null>(persisted.sessionId ?? null);
  const reqIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const detect = async () => {
    setDetecting(true);
    try {
      setStatus(await api.claudeDetect());
    } catch {
      setStatus({ installed: false, version: null, logged_in: false, path: null });
    } finally {
      setDetecting(false);
    }
  };

  // 掛載即偵測一次（面板恆掛載，僅在 !open 時不渲染）。
  useEffect(() => {
    detect();
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  // 對話 / 偏好變動即持久化（訊息僅留最近 60 則，避免 localStorage 爆掉）。
  useEffect(() => {
    try {
      const data: Persisted = {
        messages: messages.slice(-60),
        sessionId: sessionIdRef.current,
        mode,
        model,
        ctxOn,
      };
      localStorage.setItem(CHAT_KEY, JSON.stringify(data));
    } catch { /* 忽略寫入失敗 */ }
  }, [messages, mode, model, ctxOn]);

  // 內容變動時自動捲到底：僅在使用者已接近底部、或剛送出自己的訊息時才跟隨，
  // 讓使用者可在串流途中往上閱讀而不被拉回底部。
  const prevLastRoleRef = useRef<ChatRole | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const last = messages[messages.length - 1];
    const justSentUser = !!last && last.role === "user" && prevLastRoleRef.current !== "user";
    prevLastRoleRef.current = last ? last.role : null;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom || justSentUser) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 面板每次開啟即定位到底部：載入既有對話時應顯示最新訊息，而非停在最頂端往下捲。
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open]);

  // 輸入框高度：手動拖曳過（inputH > 0）就固定；否則依內容自動長高（上限約 10 行）。
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    if (inputH) { ta.style.height = `${inputH}px`; return; }
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input, inputH]);

  // 持久化面板寬度。
  useEffect(() => {
    try { localStorage.setItem("db-kit:assistantWidth", String(width)); } catch { /* 忽略 */ }
  }, [width]);

  // 持久化輸入區高度。
  useEffect(() => {
    try { localStorage.setItem("db-kit:assistantInputH", String(inputH)); } catch { /* 忽略 */ }
  }, [inputH]);

  // 消費外部丟進來的問題（側欄右鍵「問 AI」、查詢錯誤「AI 分析修正」）：
  // 預設填進輸入框、聚焦，由使用者送出；seedSend=true（如修錯）則直接自動送出。
  useEffect(() => {
    if (seed == null) return;
    const autoSend = useAssistant.getState().seedSend;
    useAssistant.getState().clearSeed();
    // 自動送出只在「助手就緒（claude 已安裝且登入）且未在串流中」時直接送出；
    // 否則（串流中 / 未就緒 / 非自動送出）一律保底把問題填回輸入框並聚焦——絕不靜默遺失。
    const ready = !!status && status.installed && status.logged_in;
    if (autoSend && ready && !streaming) {
      send(seed);
    } else {
      setInput(seed);
      setTimeout(() => textareaRef.current?.focus(), 0);
      // 串流中沒有就緒提示列可看，額外提示問題已填入、稍後可送出。
      if (autoSend && streaming) toast.info("助手回應中，已將問題填入輸入框，結束後按送出即可");
    }
    // 僅需在 seed 變動時觸發；send / streaming / status 取當下 render 的值即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // 拖曳左緣調整寬度（面板在右側，往左拖變寬）。
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => setWidth(Math.max(300, Math.min(900, startW + (startX - ev.clientX))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  // 拖曳輸入區上緣調整高度（往上拖變高）。
  const startInputResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = textareaRef.current?.getBoundingClientRect().height ?? (inputH || 56);
    const onMove = (ev: MouseEvent) => setInputH(Math.max(40, Math.min(400, startH + (startY - ev.clientY))));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
  };

  const exportChat = async () => {
    if (!messages.length) { toast.info("沒有可匯出的對話"); return; }
    const md = messages.map((m) => `## ${m.role === "user" ? "我" : "助手"}\n\n${m.text}`).join("\n\n---\n\n");
    const path = await pickSaveFile("db-kit-chat.md", [{ name: "Markdown", extensions: ["md"] }]);
    if (!path) return;
    try { await api.saveTextFile(path, md); toast.success("已匯出對話"); }
    catch (e: any) { toast.error(e?.message ?? "匯出失敗"); }
  };

  const regenerate = () => {
    if (streaming) return;
    const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
    if (lastUserIdx < 0) return;
    const lastUser = messages[lastUserIdx];
    setMessages((m) => m.slice(0, lastUserIdx + 1));
    send(lastUser.text, true);
  };

  const cleanup = () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    reqIdRef.current = null;
    setStreaming(false);
  };

  const send = async (override?: string, noUserMsg = false) => {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    if (override === undefined) setInput("");

    const userMsg: ChatMsg = { id: crypto.randomUUID(), role: "user", text, tools: [], pending: false, error: false };
    const aId = crypto.randomUUID();
    const aMsg: ChatMsg = { id: aId, role: "assistant", text: "", tools: [], pending: true, error: false };
    setMessages((m) => (noUserMsg ? [...m, aMsg] : [...m, userMsg, aMsg]));
    setStreaming(true);

    const update = (fn: (msg: ChatMsg) => ChatMsg) =>
      setMessages((m) => m.map((x) => (x.id === aId ? fn(x) : x)));

    // 組裝提示：可選擇附帶目前 db-kit 的連線 / 選取資料表 schema。
    let prompt = text;
    if (ctxOn) {
      try {
        const ctx = await buildContext();
        if (ctx) prompt = `${ctx}\n\n${text}`;
      } catch { /* 上下文為加值，失敗就只送問題本文 */ }
    }

    const reqId = crypto.randomUUID();
    reqIdRef.current = reqId;

    try {
      const un = await onClaudeStream(reqId, (e: AgentEvent) => {
        switch (e.kind) {
          case "system":
            if (e.session_id) sessionIdRef.current = e.session_id;
            break;
          case "text":
            if (e.text) update((x) => ({ ...x, pending: false, text: x.text + e.text }));
            break;
          case "tool":
            if (e.tool) update((x) => ({ ...x, tools: x.tools.includes(e.tool!) ? x.tools : [...x.tools, e.tool!] }));
            break;
          case "result":
            if (e.session_id) sessionIdRef.current = e.session_id;
            update((x) => ({
              ...x,
              pending: false,
              text: x.text || (e.text ?? ""),
              error: x.error || !!e.is_error,
              ms: e.duration_ms ?? x.ms,
            }));
            // 失敗（如未登入 / 額度問題）時重新偵測，讓上方提示列即時更新。
            if (e.is_error) detect();
            break;
          case "error":
            update((x) => ({
              ...x,
              pending: false,
              error: true,
              text: x.text + (x.text ? "\n\n" : "") + `⚠ ${e.text ?? "發生錯誤"}`,
            }));
            break;
          case "done":
            update((x) => (x.pending ? { ...x, pending: false } : x));
            cleanup();
            break;
        }
      });
      unlistenRef.current = un;
      await api.claudeSend({ reqId, prompt, sessionId: sessionIdRef.current, model, mode });
    } catch (err: any) {
      update((x) => ({
        ...x,
        pending: false,
        error: true,
        text: x.text + (x.text ? "\n\n" : "") + `⚠ ${err?.message ?? "送出失敗"}`,
      }));
      cleanup();
    }
  };

  const cancel = async () => {
    const reqId = reqIdRef.current;
    if (reqId) {
      try { await api.claudeCancel(reqId); } catch { /* 忽略 */ }
    }
    setMessages((m) =>
      m.map((x) =>
        x.role === "assistant" && x.pending
          ? { ...x, pending: false, text: x.text + (x.text ? "\n\n" : "") + "（已取消）" }
          : x,
      ),
    );
    cleanup();
  };

  const reset = async () => {
    // 有對話內容才需要確認，避免空對話時多一步點擊。
    if (messages.length > 0) {
      const ok = await uiConfirm("確定要清空目前對話並開新對話嗎？", { title: "清空對話？", danger: true, confirmText: "清空" });
      if (!ok) return;
    }
    if (streaming) cancel();
    sessionIdRef.current = null;
    setMessages([]);
  };

  const fillInput = (text: string) => {
    setInput(text);
    textareaRef.current?.focus();
  };

  if (!open) return null;

  const notReady = !!status && (!status.installed || !status.logged_in);

  return (
    <div className="shrink-0 bg-panel border-l border-fg/10 flex flex-col text-sm relative" style={{ width }}>
      <div onMouseDown={startResize} title="拖曳調整寬度"
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 z-10" />
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10">
        <Icon icon={Sparkles} size={14} className="text-accent shrink-0" />
        <span className="text-xs text-fg/45 uppercase tracking-wide">AI 助手</span>
        {sessionIdRef.current && <span className="text-[10px] text-fg/30">· 對話中</span>}
        <div className="ml-auto flex items-center gap-1">
          {mode === "agent" && (
            <IconButton icon={Folder} label="開啟助手工作資料夾（腳本檔存放處）" box="w-6 h-6"
              onClick={() => api.openAgentWorkspace().catch(() => {})} />
          )}
          {messages.length > 0 && (
            <IconButton icon={Download} label="匯出對話為 Markdown" box="w-6 h-6" onClick={exportChat} />
          )}
          <IconButton icon={Trash2} label="清空對話 / 開新對話" box="w-6 h-6" onClick={reset} />
          <IconButton icon={PanelRightClose} label="收合面板" box="w-6 h-6"
            onClick={() => useAssistant.getState().setOpen(false)} />
        </div>
      </div>

      {notReady && (
        <div className="shrink-0 px-3 py-2 border-b border-fg/10 bg-amber-500/10 text-[11px] text-amber-200/90 leading-relaxed">
          {!status!.installed ? (
            <>找不到 <span className="mono">claude</span> CLI。請先安裝 Claude Code（<span className="mono">claude.ai/install</span>）。</>
          ) : (
            <>尚未登入 Claude。請在終端機執行 <span className="mono">claude</span> 並用你的訂閱帳號登入。</>
          )}
          <button type="button" onClick={detect} disabled={detecting}
            className="ml-1 underline hover:text-amber-100 disabled:opacity-50">
            {detecting ? "偵測中…" : "重新偵測"}
          </button>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <EmptyState onPick={(p) => send(p)} onFill={fillInput} disabled={notReady} />
        ) : (
          <>
            {messages.map((m) => <MessageBubble key={m.id} msg={m} />)}
            {!streaming && messages[messages.length - 1].role === "assistant" && (
              <div className="flex justify-start">
                <button type="button" onClick={regenerate} disabled={notReady}
                  className="inline-flex items-center gap-1 text-[11px] text-fg/45 hover:text-fg border border-fg/10 rounded px-2 py-0.5 hover:bg-fg/5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg/45"><Icon icon={RefreshCw} size={13} /> 重新生成</button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="relative shrink-0 border-t border-fg/10 p-2 space-y-2">
        <div onMouseDown={startInputResize} onDoubleClick={() => setInputH(0)}
          title="拖曳調整輸入區高度（雙擊還原自動高度）"
          className="absolute left-0 -top-0.5 w-full h-1.5 cursor-row-resize hover:bg-accent/40 z-10" />
        <div className="flex items-center gap-2 text-[11px] text-fg/50">
          <label className="flex items-center gap-1 cursor-pointer select-none" title="送出時附帶目前連線 / 選取資料表的結構">
            <input type="checkbox" checked={ctxOn} onChange={(e) => setCtxOn(e.target.checked)} className="accent-blue-500" />
            附帶資料庫內容
          </label>
          <select value={mode} onChange={(e) => setMode(e.target.value as AgentMode)}
            title="唯讀問答：只回答 / 產生腳本文字。可寫腳本檔：允許寫入助手工作資料夾"
            className="ml-auto bg-inset border border-fg/10 rounded px-1 py-0.5 text-fg/70">
            <option value="advise">唯讀問答</option>
            <option value="agent">可寫腳本檔</option>
          </select>
          <select value={model} onChange={(e) => setModel(e.target.value)}
            className="bg-inset border border-fg/10 rounded px-1 py-0.5 text-fg/70">
            {MODELS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="輸入問題，Enter 送出、Shift+Enter 換行"
            className="flex-1 resize-none bg-inset border border-fg/10 rounded px-2 py-1.5 text-fg/90 placeholder:text-fg/30 outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20 min-h-[2.5rem] overflow-auto"
          />
          {streaming ? (
            <button type="button" onClick={cancel}
              className="shrink-0 inline-flex items-center gap-1 h-9 px-3 rounded bg-danger/15 text-danger hover:bg-danger/25 text-xs"><Icon icon={Square} size={13} />停止</button>
          ) : (
            <button type="button" onClick={() => send()} disabled={!input.trim() || notReady}
              className="shrink-0 inline-flex items-center gap-1 h-9 px-3 rounded bg-accent text-white hover:bg-accent/90 active:bg-accent/80 disabled:opacity-30 text-xs"><Icon icon={Send} size={13} />送出</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- 空狀態：說明 + 依目前選取情境的起手式建議 ----
function EmptyState({ onPick, onFill, disabled }: {
  onPick: (prompt: string) => void;
  onFill: (text: string) => void;
  disabled: boolean;
}) {
  const node = useStore((s) => s.selectedNode);
  const conn = useStore((s) => s.connections.find((c) => c.id === s.activeId) ?? null);

  const quick: { label: string; prompt: string; fill?: boolean }[] = [];
  if (node?.type === "table") {
    quick.push({ label: `解釋資料表 ${node.table}`, prompt: `請解釋資料表 ${node.db}.${node.table} 的用途，以及每個欄位代表什麼。` });
    quick.push({ label: `為 ${node.table} 寫常用查詢`, prompt: `針對資料表 ${node.db}.${node.table}，寫出 5 個實用的 SQL 查詢，每個都加上中文註解說明用途。` });
  } else if (conn) {
    quick.push({ label: "從哪開始探索這個資料庫", prompt: "我想了解目前連線的這個資料庫，建議我從哪些資料表 / 查詢開始探索？" });
  }
  quick.push({ label: "最佳化一段 SQL", prompt: "幫我最佳化這段 SQL（保留語意、說明改了什麼）：\n\n", fill: true });
  quick.push({ label: "寫一個備份腳本", prompt: "幫我寫一個可重複執行的資料庫備份腳本，並說明怎麼設定排程。" });

  return (
    <div className="text-fg/40 text-xs leading-relaxed p-1 space-y-3">
      <div>
        問我問題或請我撰寫腳本（SQL / Shell / Python…）。
        <br />勾選「附帶資料庫內容」時，我會看到你目前選取的連線與資料表結構，寫出貼合的查詢。
        <br />程式碼區塊可一鍵「複製 / 另存」，SQL 還能「貼到查詢編輯器」。
      </div>
      <div className="flex flex-wrap gap-1.5">
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            disabled={disabled}
            onClick={() => (q.fill ? onFill(q.prompt) : onPick(q.prompt))}
            className="px-2 py-1 rounded-full border border-fg/10 bg-fg/5 text-fg/70 hover:bg-fg/10 hover:text-fg disabled:opacity-40 text-[11px]"
          >
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- 訊息泡泡 ----
function MessageBubble({ msg }: { msg: ChatMsg }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg px-3 py-2 bg-accent/12 text-fg/90 whitespace-pre-wrap break-words">
          {msg.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="group max-w-full w-full rounded-lg px-3 py-2 bg-fg/5 text-fg/90">
        {msg.tools.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {msg.tools.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/50"><Icon icon={Settings} size={13} /> {t}</span>
            ))}
          </div>
        )}
        {msg.pending && !msg.text ? (
          <div className="flex items-center gap-2 text-fg/40 text-xs">
            <span className="inline-block w-3 h-3 rounded-full border border-fg/40 border-t-transparent animate-spin" />
            思考中…
          </div>
        ) : (
          <Markdown text={msg.text} />
        )}
        <div className="mt-1 flex items-center gap-2">
          {msg.error && <span className="text-[11px] text-red-400">回應發生錯誤</span>}
          {!msg.pending && msg.ms != null && (
            <span className="text-[10px] text-fg/25">{(msg.ms / 1000).toFixed(1)}s</span>
          )}
          {!msg.pending && msg.text && (
            <button type="button"
              onClick={() => { copyToClipboard(msg.text); toast.success("已複製整則回應"); }}
              className="ml-auto opacity-60 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-[10px] text-fg/40 hover:text-fg">
              複製全部
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- 極簡 Markdown：純文字 + 反引號圍欄程式碼區塊（不引入額外套件）----
type Block = { type: "text"; text: string } | { type: "code"; lang: string; code: string };

function parseBlocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) {
      const t = text.slice(last, m.index).replace(/^\n+|\n+$/g, "");
      if (t) out.push({ type: "text", text: t });
    }
    out.push({ type: "code", lang: (m[1] || "").toLowerCase(), code: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < text.length) {
    const t = text.slice(last).replace(/^\n+|\n+$/g, "");
    if (t) out.push({ type: "text", text: t });
  }
  if (out.length === 0) out.push({ type: "text", text });
  return out;
}

function Markdown({ text }: { text: string }) {
  const parts = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className="space-y-2">
      {parts.map((p, i) =>
        p.type === "code" ? (
          <CodeBlock key={i} lang={p.lang} code={p.code} />
        ) : (
          <TextBlock key={i} text={p.text} />
        ),
      )}
    </div>
  );
}

// 行內樣式：`code`、**bold**、[text](url) 連結（其餘為純文字）。
function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={`${keyBase}-${i}`} className="mono text-[12px] px-1 py-0.5 rounded bg-fg/10 text-fg/90">{tok.slice(1, -1)}</code>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(<strong key={`${keyBase}-${i}`} className="font-semibold text-fg">{tok.slice(2, -2)}</strong>);
    } else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const url = lm?.[2] ?? "";
      const external = /^https?:\/\//i.test(url);
      nodes.push(
        <a
          key={`${keyBase}-${i}`}
          href={external ? url : undefined}
          title={url}
          onClick={(e) => { e.preventDefault(); if (external) api.openExternal(url).catch(() => {}); }}
          className={external ? "text-blue-400 hover:text-blue-300 underline cursor-pointer" : "text-fg/80"}
        >
          {label}
        </a>,
      );
    }
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/;
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
}

// 文字區塊：逐行處理表格（| a | b |）、標題（#）、清單（- / 1.）、空行間距，其餘為段落；行內再套 renderInline。
function TextBlock({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 表格：目前列為 |...| 且下一列為分隔列（|---|）。
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitTableRow(line);
      let j = i + 2;
      const rows: string[][] = [];
      while (j < lines.length && TABLE_ROW.test(lines[j]) && !TABLE_SEP.test(lines[j])) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      out.push(
        <div key={i} className="overflow-auto">
          <table className="text-[12px] border-collapse">
            <thead>
              <tr>{header.map((c, k) => <th key={k} className="border border-fg/10 px-2 py-1 text-left font-semibold">{renderInline(c, `th${i}-${k}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => <td key={ci} className="border border-fg/10 px-2 py-1 align-top">{renderInline(c, `td${i}-${ri}-${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      i = j;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const num = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (h) {
      out.push(<div key={i} className="font-semibold text-fg mt-1 break-words">{renderInline(h[2], `h${i}`)}</div>);
      i++;
    } else if (quote) {
      const qlines: string[] = [];
      while (i < lines.length) {
        const q = /^\s*>\s?(.*)$/.exec(lines[i]);
        if (q) { qlines.push(q[1]); i++; } else break;
      }
      out.push(
        <blockquote key={i} className="border-l-2 border-fg/20 pl-2 text-fg/70 italic break-words">
          {qlines.map((ql, k) => <p key={k} className="leading-relaxed">{renderInline(ql, `q${i}-${k}`)}</p>)}
        </blockquote>,
      );
    } else if (bullet || num) {
      const items: { num?: string; text: string }[] = [];
      while (i < lines.length) {
        const b = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        const n = /^\s*(\d+)\.\s+(.*)$/.exec(lines[i]);
        if (b) { items.push({ text: b[1] }); i++; }
        else if (n) { items.push({ num: n[1], text: n[2] }); i++; }
        else break;
      }
      out.push(
        <ul key={i} className="space-y-0.5 pl-1">
          {items.map((it, j) => (
            <li key={j} className="flex gap-1.5 break-words">
              <span className="text-fg/40 shrink-0">{it.num ? `${it.num}.` : "•"}</span>
              <span className="flex-1">{renderInline(it.text, `li${i}-${j}`)}</span>
            </li>
          ))}
        </ul>,
      );
    } else if (line.trim() === "") {
      out.push(<div key={i} className="h-1.5" />);
      i++;
    } else {
      out.push(<p key={i} className="leading-relaxed break-words">{renderInline(line, `p${i}`)}</p>);
      i++;
    }
  }
  return <div className="text-[13px] space-y-0.5">{out}</div>;
}

const SQL_LEAD = /^\s*(select|insert|update|delete|create|alter|drop|truncate|with|explain|grant|revoke)\b/i;

function looksLikeSql(code: string): boolean {
  return SQL_LEAD.test(code);
}

function extFor(lang: string): string {
  switch (lang) {
    case "sql": return "sql";
    case "bash": case "sh": case "shell": return "sh";
    case "powershell": case "ps1": return "ps1";
    case "python": case "py": return "py";
    case "javascript": case "js": return "js";
    case "typescript": case "ts": return "ts";
    case "json": return "json";
    case "yaml": case "yml": return "yaml";
    default: return "txt";
  }
}

// SQL 關鍵字 / 型別（比照 editorThemes 的 HighlightStyle：型別併入 keyword 色）。大小寫不敏感。
const SQL_KW = new Set([
  "select", "from", "where", "and", "or", "not", "in", "is", "null", "like", "between", "exists",
  "group", "by", "having", "order", "asc", "desc", "limit", "offset", "distinct", "as", "on", "using",
  "join", "inner", "left", "right", "full", "outer", "cross", "natural", "union", "all", "intersect", "except",
  "insert", "into", "values", "value", "update", "set", "delete", "truncate", "merge", "replace",
  "create", "alter", "drop", "table", "view", "index", "sequence", "unique", "primary", "key", "foreign", "references",
  "constraint", "default", "check", "cascade", "restrict", "add", "column", "modify", "change", "rename", "to",
  "database", "schema", "temporary", "if", "case", "when", "then", "else", "end", "elseif", "while", "loop",
  "begin", "commit", "rollback", "transaction", "start", "savepoint", "lock", "unlock",
  "grant", "revoke", "with", "recursive", "over", "partition", "window", "returning", "for", "each", "row",
  "use", "show", "describe", "desc", "explain", "analyze", "call", "declare", "procedure", "function",
  "trigger", "returns", "return", "language", "definer", "before", "after", "of", "asc",
  "like", "ilike", "rlike", "regexp", "match", "against", "collate", "cast", "convert", "interval",
  "true", "false", "unknown", "current_timestamp", "current_date", "current_time",
  // 型別
  "int", "integer", "bigint", "smallint", "tinyint", "mediumint", "decimal", "numeric", "float", "double",
  "real", "bit", "boolean", "bool", "char", "varchar", "text", "tinytext", "mediumtext", "longtext",
  "nchar", "nvarchar", "ntext", "blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary",
  "date", "datetime", "timestamp", "time", "year", "json", "jsonb", "uuid", "serial", "bigserial",
  "money", "enum", "unsigned", "zerofill", "auto_increment", "identity",
]);

const SQL_OP = "=<>!+-*/%|&^~";

// 近似 SQL tokenizer：單次線性掃描切出 token 並套主題色（比照 SqlEditor 的 HighlightStyle 對應）。
// 非 CodeMirror lexer，少數邊界會與編輯器略有出入（僅視覺；複製取用的仍是原文 code）。
function highlightSql(code: string, c: ThemeColors): ReactNode[] {
  const out: ReactNode[] = [];
  const n = code.length;
  let i = 0;
  let k = 0;
  const push = (text: string, color?: string) => {
    if (!text) return;
    out.push(color ? <span key={k++} style={{ color }}>{text}</span> : text);
  };
  const isWord = (ch: string) => /[A-Za-z0-9_]/.test(ch);
  while (i < n) {
    const ch = code[i];
    // 空白 / 換行：原樣保留排版。
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      let j = i + 1;
      while (j < n && /\s/.test(code[j])) j++;
      push(code.slice(i, j));
      i = j;
      continue;
    }
    // 行註解：-- …  或  # …（MySQL）。
    if ((ch === "-" && code[i + 1] === "-") || ch === "#") {
      let j = i;
      while (j < n && code[j] !== "\n") j++;
      push(code.slice(i, j), c.comment);
      i = j;
      continue;
    }
    // 區塊註解：/* … */（串流未閉合就吃到結尾）。
    if (ch === "/" && code[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(j + 2, n);
      push(code.slice(i, j), c.comment);
      i = j;
      continue;
    }
    // 字串：'…' / "…"（含 '' 與 \ 跳脫；未閉合吃到結尾）。
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === ch) {
          if (code[j + 1] === ch) { j += 2; continue; } // 加倍跳脫
          j++;
          break;
        }
        j++;
      }
      push(code.slice(i, j), c.string);
      i = j;
      continue;
    }
    // 數字。
    if (ch >= "0" && ch <= "9") {
      let j = i + 1;
      while (j < n && /[0-9.]/.test(code[j])) j++;
      push(code.slice(i, j), c.number);
      i = j;
      continue;
    }
    // 識別字 / 關鍵字。
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && isWord(code[j])) j++;
      const word = code.slice(i, j);
      push(word, SQL_KW.has(word.toLowerCase()) ? c.keyword : undefined);
      i = j;
      continue;
    }
    // 運算子。
    if (SQL_OP.includes(ch)) {
      let j = i + 1;
      while (j < n && SQL_OP.includes(code[j])) j++;
      push(code.slice(i, j), c.operator);
      i = j;
      continue;
    }
    // 其餘標點（括號、逗號、分號、點…）：前景色。
    push(ch);
    i++;
  }
  return out;
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const editorTheme = useTheme((s) => s.editorTheme);
  const appTheme = useTheme((s) => s.theme);
  const isSql = lang === "sql" || (!lang && looksLikeSql(code));
  // 套用使用者所選的編輯器主題：指定主題吃主題背景 / auto 維持面板底色。
  const { colors, useBg } = resolveHighlightColors(editorTheme, appTheme);

  const save = async () => {
    const ext = extFor(lang || (isSql ? "sql" : "txt"));
    const path = await pickSaveFile(`script.${ext}`, [
      { name: ext.toUpperCase(), extensions: [ext] },
      { name: "All", extensions: ["*"] },
    ]);
    if (!path) return;
    try {
      await api.saveTextFile(path, code);
      toast.success("已儲存腳本");
    } catch (e: any) {
      toast.error(e?.message ?? "儲存失敗");
    }
  };

  const btn = "px-1.5 py-0.5 rounded text-fg/55 hover:text-fg hover:bg-fg/10";
  return (
    <div className="rounded border border-fg/10 overflow-hidden bg-well">
      <div className="flex items-center gap-1 px-2 py-1 bg-fg/5 text-[10px] text-fg/45">
        <span className="uppercase tracking-wide">{lang || "程式碼"}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {isSql && (
            <button type="button" className={btn}
              onClick={() => { useStore.getState().requestQuery(code); toast.success("已貼到查詢編輯器"); }}>
              貼到編輯器
            </button>
          )}
          <button type="button" className={btn} onClick={save}>另存</button>
          <button type="button" className={btn}
            onClick={() => { copyToClipboard(code); toast.success("已複製"); }}>複製</button>
        </div>
      </div>
      <pre className="p-2 overflow-auto text-[12px] mono leading-relaxed"
        style={{ backgroundColor: useBg ? colors.bg : undefined, color: colors.fg }}>
        <code>{isSql ? highlightSql(code, colors) : code}</code>
      </pre>
    </div>
  );
}

// 依目前連線 / 選取節點組裝環境描述，注入提示讓回答貼合使用者的資料庫。
async function buildContext(): Promise<string> {
  const s = useStore.getState();
  const conn = s.connections.find((c) => c.id === s.activeId) ?? null;
  if (!conn) return "";
  const meta = KIND_META[conn.kind];
  const lines: string[] = [`資料庫類型：${meta.label}`];
  if (!meta.fileBased) lines.push(`連線位址：${conn.host}:${conn.port}`);
  if (conn.database) lines.push(`預設資料庫：${conn.database}`);

  const node = s.selectedNode;
  if (node && node.connId === conn.id) {
    if (node.type === "database") {
      lines.push(`目前選取資料庫：${node.db}`);
    } else if (node.type === "table") {
      lines.push(`目前選取${node.objKind === "view" ? "視圖" : "資料表"}：${node.db}.${node.table}`);
      try {
        const cols = await api.tableColumns(conn.id, node.db, node.table);
        if (cols.length) {
          const list = cols
            .slice(0, 80)
            .map((c) => `${c.name} ${c.data_type}${c.key === "PRI" ? " PK" : ""}${c.nullable ? "" : " NOT NULL"}`)
            .join(", ");
          lines.push(`欄位：${list}${cols.length > 80 ? " …" : ""}`);
        }
      } catch { /* schema 為加值，失敗略過 */ }
    }
  }
  return `【目前資料庫環境】\n${lines.join("\n")}\n（以上為使用者在 db-kit 的目前環境；若回答涉及 SQL，請貼合此資料庫類型與結構）`;
}
