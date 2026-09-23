import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  AgentEvent,
  AgentMode,
  AgentProvider,
  AgentStatus,
  onAgentStream,
} from "./api";
import { useStore } from "./store";
import { baseUrlOf, CLAUDE_MODELS, isApiProvider, PROVIDERS, providerMeta, useAiProvider } from "./aiProvider";
import { currentSystemPrompt, useAiSkills } from "./aiSkills";
import AiSettingsDialog from "./AiSettingsDialog";
import CliSetupHint from "./CliSetupHint";
import { useTheme } from "./theme";
import { resolveHighlightColors, type ThemeColors } from "./editorThemes";
import { useAssistant } from "./assistant";
import { toast, copyToClipboard, pickSaveFile, uiConfirm, uiPrompt } from "./ui";
import Icon from "./ui/Icon";
import { IconButton } from "./ui/index";
import { Folder, Download, Trash2, PanelRightClose, RefreshCw, Settings, Settings2, Sparkles, Send, Square, Database, Play, ChevronDown, ChevronRight, GitBranch, ListFilter, AlertTriangle, MessageSquarePlus, MessagesSquare, Pencil } from "lucide-react";
import { useT, useLang } from "./i18n";
import type { DbKind } from "./api";
import type { ChatMsg, ChatRunResult, MentionChip, MentionRef } from "./chatTypes";
import { fmtRelativeTime } from "./sql";
import {
  activeConversation, addConversation, conversationTitle, findConversation, loadArchive, newConversation,
  pruneArchive, removeConversation, saveArchive, sortedConversations, updateConversation,
  type ChatArchive, type ChatConversation,
} from "./chatSessions";
import { applyToolEvent, dbTarget, isSqlToolCall, type ToolCallView } from "./agentTools";
import { buildAutoContext, estimateContext, expandMentions, parseMentions, stripMentions, type MentionEnv } from "./chatMentions";
import MentionPopover, { type MentionPopoverHandle, type PopoverItem } from "./MentionPopover";
import { expandSlash, parseSlash, SLASH_COMMANDS, type SlashEnv } from "./slashCommands";
import { classifyForRun, prepareStatements, persistableRun, reviewOutcomeToChatRun, routeToReviewRun, runFeedbackDisplay, runFeedbackPrompt, toChatRunResult } from "./chatRun";
import ChatSqlResult from "./ChatSqlResult";
import { parseBlocks, TextBlock } from "./MarkdownLite";
import { isProdConn } from "./api";

// 右側「AI 助手」面板：驅動本機 claude 或 codex CLI（皆用訂閱登入，不需 API key），
// 串流回答問題與撰寫腳本。對標右側詳細資料面板的版面與主題用色。
// 串流事件走後端 `agent-stream`（見 agent.rs / onAgentStream）。

type ChatRole = "user" | "assistant";

// ChatMsg / MentionChip / ChatRunResult 定義在 chatTypes.ts（見該檔說明：切斷循環相依）。

// ---- 對話 / 偏好持久化（localStorage；重開 db-kit 後保留）----
//
// 對話本體自 v0.32 起改存在 chatSessions.ts 的「多對話」存檔裡（db-kit:assistantSessions），
// 這個鍵只留偏好（模式 / 附帶內容 / 資料庫工具）。舊版的 messages / sessionId 仍會被
// chatSessions.loadArchive 讀走做一次性遷移，之後第一次寫偏好就自然被覆蓋掉。
const CHAT_KEY = "db-kit:assistantChat";

interface Persisted {
  mode: AgentMode;
  /** 舊版欄位（單一模型 / 各供應商模型）。v0.28 起模型改存 aiProvider store，
   *  這裡只保留讀取端的遷移路徑（見 aiProvider.readModels），不再寫入。 */
  model?: string;
  models?: Partial<Record<AgentProvider, string>>;
  ctxOn: boolean;
  /** 助手可否對目前連線下唯讀查詢（資料庫工具）。 */
  dbToolsOn?: boolean;
}

function loadPersisted(): Partial<Persisted> {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY) || "{}") as Partial<Persisted>;
  } catch {
    return {};
  }
}

export default function AssistantPanel() {
  const t = useT();
  const open = useAssistant((s) => s.open);
  const persisted = useMemo(loadPersisted, []);

  // ---- 多對話 ----
  // 畫面上的 `messages` 永遠屬於 `archive.activeId` 那一串。archive 只在「結構」變動
  // （新增 / 刪除 / 改名 / 切換）時 setState；訊息本身由下方的持久化 effect 折回去再落地。
  // 兩份狀態而不是一份，是為了不動到元件裡二十幾處既有的 setMessages —— 那才是真正會出錯的地方。
  const [archive, setArchive] = useState<ChatArchive>(() => loadArchive());
  const activeConvId = archive.activeId;
  const [messages, setMessages] = useState<ChatMsg[]>(() => activeConversation(archive).messages);
  const [convListOpen, setConvListOpen] = useState(false);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [ctxOn, setCtxOn] = useState(persisted.ctxOn ?? true);
  // 資料庫工具（唯讀查詢）：預設開。助手最常被問的就是「這個庫裡有什麼」，
  // 而沒有工具時它只能照著前端塞的那一張表硬猜。
  const [dbToolsOn, setDbToolsOn] = useState(persisted.dbToolsOn ?? true);
  const [mode, setMode] = useState<AgentMode>(persisted.mode || "advise");
  const provider = useAiProvider((s) => s.provider);
  const setProvider = useAiProvider((s) => s.setProvider);
  // 供應商設定（模型 / Base URL）改由 aiProvider store 持有：設定對話框與 NL 查詢列共用同一份。
  const models = useAiProvider((s) => s.models);
  const setModels = useAiProvider((s) => s.setModel);
  const baseUrls = useAiProvider((s) => s.baseUrls);
  const model = models[provider] || "";
  const setModel = (v: string) => setModels(provider, v);
  const baseUrl = baseUrlOf(provider, baseUrls);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const skills = useAiSkills((s) => s.all());
  const selectedSkills = useAiSkills((s) => s.selected);
  const toggleSkill = useAiSkills((s) => s.toggle);
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
  // 目前連線的種類（反應式）：工具呼叫要不要當成 SQL 上色，得跟著切換連線即時更新。
  const activeKind = useStore((s) => s.connections.find((c) => c.id === s.activeId)?.kind ?? null);

  // 供應商對不上就丟掉舊 session id（見 ChatConversation.agentProvider）。
  const sessionIdRef = useRef<string | null>(
    (() => {
      const c = activeConversation(archive);
      return c.agentProvider && c.agentProvider !== useAiProvider.getState().provider ? null : c.agentSessionId;
    })(),
  );
  // 本次對話已對哪些正式環境連線確認過「可以讓助手查」；同一段對話不重複問。
  const prodOkRef = useRef<Set<string>>(new Set());
  // ---- 輸入框補全（`@` 提及 / `/` 指令 / 「範圍」多選）----
  const [popover, setPopover] = useState<
    | { kind: "mention"; from: number; query: string; prefix: string | null }
    | { kind: "slash"; query: string }
    | { kind: "scope"; selected: Set<string> }
    | null
  >(null);
  const [popItems, setPopItems] = useState<PopoverItem[]>([]);
  const [popLoading, setPopLoading] = useState(false);
  const popRef = useRef<MentionPopoverHandle>(null);
  const reqIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const detect = async () => {
    setDetecting(true);
    try {
      setStatus(await api.agentDetect(provider, baseUrl || null));
    } catch {
      setStatus({ provider, installed: false, version: null, logged_in: false, path: null, db_tools: null });
    } finally {
      setDetecting(false);
    }
  };

  /** 展開 @ 提及所需的環境。每次現算而非放 state：連線 / 分頁隨時在換，快取只會過期。 */
  const mentionEnv = (): MentionEnv => {
    const s = useStore.getState();
    const target = dbTarget(s);
    return {
      connId: s.activeId,
      kind: s.connections.find((c) => c.id === s.activeId)?.kind ?? null,
      db: target?.database ?? "",
      editor: useAssistant.getState().editor,
      uiLang: useLang.getState().lang,
    };
  };

  // 掛載即偵測一次，之後每次換供應商再測一次（面板恆掛載，僅在 !open 時不渲染）。
  // 換供應商等於換一支 CLI，對方的 session / thread id 不通用，重置成新對話串（訊息保留）。
  const firstDetectRef = useRef(true);
  useEffect(() => {
    if (firstDetectRef.current) firstDetectRef.current = false;
    else sessionIdRef.current = null;
    setStatus(null);
    detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, baseUrl]);

  useEffect(() => {
    return () => {
      if (unlistenRef.current) unlistenRef.current();
    };
  }, []);

  // Ctrl/Cmd+L：關著就打開並聚焦、開著但焦點不在輸入框就聚焦、已經在輸入框就收起面板。
  // 掛在面板元件（它恆掛載，只在 !open 時不渲染），所以關著時也叫得出來。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "l") return;
      if (document.body.dataset.modalCount) return;
      e.preventDefault();
      const st = useAssistant.getState();
      if (!st.open) {
        st.setOpen(true);
        setTimeout(() => textareaRef.current?.focus(), 0);
      } else if (document.activeElement !== textareaRef.current) {
        textareaRef.current?.focus();
      } else {
        st.setOpen(false);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // 偏好變動即持久化（對話本體走下面的多對話存檔）。
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify({ mode, ctxOn, dbToolsOn } satisfies Persisted));
    } catch { /* 忽略寫入失敗 */ }
  }, [mode, ctxOn, dbToolsOn]);

  /** 把目前畫面上的訊息與 session 折進 archive 的作用中那一串。切換 / 落地前都要先過這關。 */
  const foldActive = (a: ChatArchive = archive): ChatArchive => {
    const s = useStore.getState();
    const conn = s.connections.find((c) => c.id === s.activeId) ?? null;
    return updateConversation(a, activeConvId, (c) => ({
      ...c,
      // 執行結果只留前 30 列：整張結果表寫進 localStorage 會很快撞上配額，
      // 撞上之後是「整串對話都存不進去」，不是只丟掉那張表。
      messages: messages.map((m) =>
        m.runs
          ? { ...m, runs: Object.fromEntries(Object.entries(m.runs).map(([k, v]) => [k, persistableRun(v)])) }
          : m,
      ),
      agentSessionId: sessionIdRef.current,
      agentProvider: provider,
      // 連線只在「這串第一次有內容」時記下來：使用者常是先開面板才選庫，空對話標到某個庫沒有意義。
      connId: c.connId ?? (messages.length ? conn?.id ?? null : null),
      connName: c.connName ?? (messages.length ? conn?.name ?? null : null),
    }));
  };

  // 對話變動即落地。saveArchive 會在配額爆掉時逐步丟最舊的對話再試（見 chatSessions.ts），
  // 一串都塞不下才回 0 —— 那時要出聲，靜默失敗等於使用者以為存著、其實沒有。
  const quotaWarnedRef = useRef(false);
  useEffect(() => {
    const saved = saveArchive(foldActive());
    if (saved === 0 && !quotaWarnedRef.current) {
      quotaWarnedRef.current = true;
      toast.error(t("瀏覽器儲存空間已滿，這串對話無法保存。請先刪除幾串舊對話。"));
    } else if (saved > 0) {
      quotaWarnedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, archive, activeConvId, provider]);

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
    // 自動送出只在「助手就緒（CLI 已安裝且登入）且未在串流中」時直接送出；
    // 否則（串流中 / 未就緒 / 非自動送出）一律保底把問題填回輸入框並聚焦——絕不靜默遺失。
    const ready = !!status && status.installed && status.logged_in;
    if (autoSend && ready && !streaming) {
      send(seed);
    } else {
      setInput(seed);
      setTimeout(() => textareaRef.current?.focus(), 0);
      // 串流中沒有就緒提示列可看，額外提示問題已填入、稍後可送出。
      if (autoSend && streaming) toast.info(t("助手回應中，已將問題填入輸入框，結束後按送出即可"));
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
    if (!messages.length) { toast.info(t("沒有可匯出的對話")); return; }
    const md = messages.map((m) => `## ${m.role === "user" ? t("我") : t("助手")}\n\n${m.text}`).join("\n\n---\n\n");
    const path = await pickSaveFile("db-kit-chat.md", [{ name: "Markdown", extensions: ["md"] }]);
    if (!path) return;
    try { await api.saveTextFile(path, md); toast.success(t("已匯出對話")); }
    catch (e: any) { toast.error(e?.message ?? t("匯出失敗")); }
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

  /**
   * 送出一輪。
   *
   * @param opts.extraContext 已組好、要接在問題前面的額外上下文（執行結果回饋、斜線命令展開）。
   * @param opts.extraChips   要顯示在使用者訊息底下的收據（與 extraContext 對應）。
   * @param opts.mode         覆寫這一輪的模式（`/sql` 走 generate）。
   * @param opts.ignoreSession 不要讓這一輪的 session_id 蓋掉聊天的 session。
   *   **這個旗標是必要的**：generate 是一次性回合，後端會另發一個 session id；
   *   若讓它寫回 sessionIdRef，接下來的對話就會悄悄接到那段空歷史上，上文整個不見。
   */
  const send = async (
    override?: string,
    noUserMsg = false,
    opts?: { extraContext?: string; extraChips?: MentionChip[]; mode?: AgentMode; ignoreSession?: boolean },
  ) => {
    const text = (override ?? input).trim();
    if (!text || streaming) return;
    if (override === undefined) setInput("");
    let turnMode: AgentMode = opts?.mode ?? mode;
    let ignoreSession = !!opts?.ignoreSession;
    let slashPrompt: string | null = null;
    let slashDisplay = text;
    let slashRefs: MentionRef[] = [];

    // 斜線命令：展開成一般的一輪（或就地處理）。放在最前面——它可能整段改寫要送出的內容。
    const slash = parseSlash(text);
    if (slash) {
      const node = useStore.getState().selectedNode;
      const env: SlashEnv = {
        ...mentionEnv(),
        selectedTable: node?.type === "table" ? node.table : null,
      };
      let action;
      try {
        action = await expandSlash(slash.cmd, slash.arg, env);
      } catch (e: any) {
        toast.error(e?.message ?? t("指令展開失敗"));
        return;
      }
      if (action.kind === "local") {
        if (action.action === "clear") void reset();
        else if (action.action === "export") void exportChat();
        else newTopic();
        return;
      }
      if (action.kind === "info") {
        // 前置條件不成立不該佔用一輪對話（也不該送出去問模型），就地提示即可。
        toast.info(action.message);
        setInput(text);
        return;
      }
      // 展開成功：改用它組好的 prompt 與顯示文字重跑一次送出流程。
      turnMode = action.mode ?? turnMode;
      ignoreSession = action.ignoreSession ?? ignoreSession;
      // 展開成功：它組好的 prompt 取代本文，顯示文字另外給（氣泡上不該出現整段指令文）。
      turnMode = action.mode ?? turnMode;
      ignoreSession = action.ignoreSession ?? ignoreSession;
      slashPrompt = action.prompt;
      slashDisplay = action.display;
      slashRefs = action.mentions ?? [];
    }

    // @ 提及：先解析、展開成預先烘焙好的上下文，再把 token 換成純名字當作使用者看到的訊息本文。
    // 送給模型的是展開後的結構，顯示給人看的是「解釋 orders」而不是「解釋 @table:orders」。
    //
    // 斜線命令已自己組好完整指令文，就不再對它做提及解析——那段指令文裡有 SQL，
    // 裡頭的 `@variable` 會被誤判成提及。它要附帶什麼由 action.mentions 明講。
    const refs = slashPrompt ? slashRefs : parseMentions(text);
    const display = slashPrompt ? slashDisplay : (refs.length ? stripMentions(text, refs) : text);
    let mentionCtx = "";
    let mentionChips: MentionChip[] = [];
    if (refs.length) {
      try {
        const r = await expandMentions(refs, mentionEnv());
        mentionCtx = r.context;
        mentionChips = r.chips;
      } catch { /* 展開失敗就只送問題本文，不讓一則 @ 打斷整輪對話 */ }
    }

    // 資料庫工具要附帶哪條連線（未連線 / 關閉時為 null，後端就不給工具）。
    // 也要看 status.db_tools：CLI 供應商找不到 dbk 時工具根本掛不上去，
    // 這時還跳一次「要讓 AI 查正式環境嗎」只是在問一件做不到的事。
    const toolsUsable = dbToolsOn && !!status?.db_tools && turnMode !== "generate" && turnMode !== "edit";
    let target = toolsUsable ? dbTarget(useStore.getState()) : null;
    // 正式環境連線：第一次要讓助手能對它下查詢時先問一聲。工具雖是唯讀，
    // 但「模型自己決定跑什麼」與「使用者自己按執行」是兩件事，正式庫上值得多一道確認。
    if (target?.prod && !prodOkRef.current.has(target.connectionId)) {
      const ok = await uiConfirm(
        t("「{name}」是正式環境連線。要讓 AI 助手對它執行唯讀查詢嗎？（只能讀，不會寫入）", {
          name: useStore.getState().connections.find((c) => c.id === target!.connectionId)?.name ?? target.connectionId,
        }),
        { title: t("正式環境"), danger: true, confirmText: t("允許查詢") },
      );
      if (ok) prodOkRef.current.add(target.connectionId);
      else target = null; // 不同意就這次不給工具，但問題照送（模型改用附帶的結構回答）。
    }

    const chips = [...mentionChips, ...(opts?.extraChips ?? [])];
    const userMsg: ChatMsg = {
      id: crypto.randomUUID(), role: "user", text: display, tools: [], pending: false, error: false,
      mentions: chips.length ? chips : undefined,
      ctxBytes: mentionCtx.length + (opts?.extraContext?.length ?? 0),
    };
    const aId = crypto.randomUUID();
    const aMsg: ChatMsg = { id: aId, role: "assistant", text: "", tools: [], pending: true, error: false, toolCalls: [] };
    setMessages((m) => (noUserMsg ? [...m, aMsg] : [...m, userMsg, aMsg]));
    setStreaming(true);

    const update = (fn: (msg: ChatMsg) => ChatMsg) =>
      setMessages((m) => m.map((x) => (x.id === aId ? fn(x) : x)));

    // 組裝提示：自動上下文（目前連線 / 選取資料表 schema）＋ @ 提及展開 ＋ 呼叫端給的額外上下文。
    const chunks: string[] = [];
    if (ctxOn) {
      try {
        // 已經 @ 過的表不要再由自動上下文列一次（見 buildAutoContext 的 skipTable 說明）。
        const mentionedTables = new Set(refs.filter((r) => r.kind === "table" && r.table).map((r) => r.table!));
        const node = useStore.getState().selectedNode;
        const skipTable = node?.type === "table" && mentionedTables.has(node.table) ? node.table : null;
        const ctx = await buildAutoContext(mentionEnv(), { skipTable });
        if (ctx) chunks.push(ctx);
      } catch { /* 上下文為加值，失敗就只送問題本文 */ }
    }
    if (mentionCtx) chunks.push(mentionCtx);
    if (opts?.extraContext) chunks.push(opts.extraContext);
    chunks.push(slashPrompt ?? display);
    const prompt = chunks.join("\n\n");

    const reqId = crypto.randomUUID();
    reqIdRef.current = reqId;

    try {
      const un = await onAgentStream(reqId, (e: AgentEvent) => {
        switch (e.kind) {
          case "system":
            if (e.session_id && !ignoreSession) sessionIdRef.current = e.session_id;
            break;
          case "text":
            if (e.text) update((x) => ({ ...x, pending: false, text: x.text + e.text }));
            break;
          case "tool":
          case "tool_result":
            // tools 是舊的名稱徽章（仍留著當快速一覽）；toolCalls 才是含 SQL 與結果的明細。
            update((x) => ({
              ...x,
              tools: e.tool && !x.tools.includes(e.tool) ? [...x.tools, e.tool] : x.tools,
              toolCalls: applyToolEvent((x.toolCalls as ToolCallView[]) ?? [], e),
            }));
            break;
          case "result":
            if (e.session_id && !ignoreSession) sessionIdRef.current = e.session_id;
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
              text: x.text + (x.text ? "\n\n" : "") + `⚠ ${e.text ?? t("發生錯誤")}`,
            }));
            break;
          case "done":
            update((x) => (x.pending ? { ...x, pending: false } : x));
            cleanup();
            break;
        }
      });
      unlistenRef.current = un;
      await api.agentSend({
        reqId,
        prompt,
        sessionId: ignoreSession ? null : sessionIdRef.current,
        model,
        mode: turnMode,
        provider,
        baseUrl: baseUrl || null,
        // 一次性回合不疊技能：技能講的是「回答時要附上風險說明」這類語氣要求，
        // 對「只回一個 ```sql 區塊」的生成只會製造區塊外的雜訊。
        systemPrompt: currentSystemPrompt(turnMode === "advise" || turnMode === "agent"),
        connectionId: target?.connectionId ?? null,
        database: target?.database ?? null,
      });
    } catch (err: any) {
      update((x) => ({
        ...x,
        pending: false,
        error: true,
        text: x.text + (x.text ? "\n\n" : "") + `⚠ ${err?.message ?? t("送出失敗")}`,
      }));
      cleanup();
    }
  };

  const cancel = async () => {
    const reqId = reqIdRef.current;
    if (reqId) {
      try { await api.agentCancel(reqId); } catch { /* 忽略 */ }
    }
    setMessages((m) =>
      m.map((x) =>
        x.role === "assistant" && x.pending
          ? { ...x, pending: false, text: x.text + (x.text ? "\n\n" : "") + t("（已取消）") }
          : x,
      ),
    );
    cleanup();
  };

  // 丟掉某個 session：記憶體與落地的歷史都清掉。
  // 只清畫面不清磁碟的話，使用者以為「清空對話」了，夾帶查詢結果的歷史卻還躺在設定目錄裡。
  const dropSessionId = (sid: string | null) => {
    if (sid && isApiProvider(provider)) void api.agentSessionDelete(sid).catch(() => {});
  };

  /** 丟掉「目前這串」的 session（畫面上的訊息不動）。 */
  const dropSession = () => {
    const sid = sessionIdRef.current;
    sessionIdRef.current = null;
    prodOkRef.current = new Set();
    dropSessionId(sid);
  };

  const reset = async () => {
    // 有對話內容才需要確認，避免空對話時多一步點擊。
    if (messages.length > 0) {
      const ok = await uiConfirm(t("確定要清空目前對話嗎？（其他對話串不受影響）"), { title: t("清空對話？"), danger: true, confirmText: t("清空") });
      if (!ok) return;
    }
    if (streaming) cancel();
    dropSession();
    setMessages([]);
  };

  // ---- 多對話：新增 / 切換 / 改名 / 刪除 ----
  //
  // 不同資料庫共用一串對話時，模型手上還握著上一個庫的表結構與結果，答案就串了庫。
  // 以前唯一的出路是「清空」，但那是不可逆的。現在一個庫開一串，切走再切回來歷史都在。

  /** 開一串新對話並切過去（目前這串原封不動留在清單裡）。 */
  const newChat = () => {
    if (streaming) return;
    const s = useStore.getState();
    const conn = s.connections.find((c) => c.id === s.activeId) ?? null;
    // 先把畫面上的現況折回舊那串，否則切走的瞬間這幾則就沒了。
    const folded = foldActive();
    const fresh = newConversation({ id: conn?.id ?? null, name: conn?.name ?? null });
    setArchive(pruneArchive(addConversation(folded, fresh)));
    setMessages([]);
    // 新對話從零開始：不沿用舊 session（沿用等於換了標題卻還帶著同一段上文）。
    sessionIdRef.current = null;
    prodOkRef.current = new Set();
    setConvListOpen(false);
  };

  /** 切到另一串既有對話。串流中不切——換走之後那些事件會落到錯的對話裡。 */
  const switchChat = (id: string) => {
    setConvListOpen(false);
    if (streaming || id === activeConvId) return;
    const folded = foldActive();
    const target = findConversation(folded, id);
    if (!target) return;
    setArchive({ ...folded, activeId: id });
    setMessages(target.messages);
    // 供應商對不上的 session id 對新端點毫無意義（見 ChatConversation.agentProvider）。
    sessionIdRef.current = target.agentProvider && target.agentProvider !== provider ? null : target.agentSessionId;
    prodOkRef.current = new Set();
  };

  const renameChat = async (id: string) => {
    const conv = findConversation(archive, id);
    if (!conv) return;
    const name = await uiPrompt(t("對話名稱"), {
      title: t("重新命名對話"),
      defaultValue: conversationTitle(id === activeConvId ? { ...conv, messages } : conv) ?? "",
    });
    if (name === null) return;
    setArchive((a) => updateConversation(a, id, (c) => ({ ...c, title: name.trim() })));
  };

  const deleteChat = async (id: string) => {
    const conv = findConversation(archive, id);
    if (!conv) return;
    if (id === activeConvId && streaming) return;
    const label = conversationTitle(id === activeConvId ? { ...conv, messages } : conv) ?? t("新對話");
    if (conv.messages.length > 0 || (id === activeConvId && messages.length > 0)) {
      const ok = await uiConfirm(t("確定要刪除對話「{name}」嗎？此動作無法復原。", { name: label }), {
        title: t("刪除對話？"), danger: true, confirmText: t("刪除"),
      });
      if (!ok) return;
    }
    dropSessionId(conv.agentSessionId);
    // 刪的是目前這串 → 先折回再刪，讓 removeConversation 選出的接手對象帶著正確的訊息。
    const base = id === activeConvId ? foldActive() : archive;
    const next = removeConversation(base, id);
    setArchive(next);
    if (id === activeConvId) {
      const now = activeConversation(next);
      setMessages(now.messages);
      sessionIdRef.current = now.agentProvider && now.agentProvider !== provider ? null : now.agentSessionId;
      prodOkRef.current = new Set();
    }
  };

  /**
   * 開新話題但留著畫面上的對話：插一條分隔線、斷開 session。
   * 比「清空」溫和——舊對話還看得到、可以複製，但不再跟著每一輪重送給模型
   * （HTTP 供應商每回合都要把整串歷史送上去，長對話換個話題時這一刀省的是真金白銀）。
   */
  const newTopic = () => {
    if (streaming) return;
    dropSession();
    setMessages((m) => [...m, { id: crypto.randomUUID(), role: "assistant", text: "", tools: [], pending: false, error: false, divider: true }]);
  };

  const fillInput = (text: string) => {
    setInput(text);
    textareaRef.current?.focus();
  };

  // ---- 輸入框補全 ----

  /** 游標前是否正在打一個 `@…`；是的話回它的起點、前綴與已輸入的字。 */
  const mentionTrigger = (text: string, caret: number) => {
    const before = text.slice(0, caret);
    const m = /(^|[\s([,;:：（【「，、；])@(?:(table|db|file):)?("?[A-Za-z0-9_$./-]*)$/.exec(before);
    if (!m) return null;
    return { from: caret - (m[0].length - m[1].length), prefix: m[2] ?? null, query: (m[3] ?? "").replace(/^"/, "") };
  };

  /** 取補全候選。表 / 庫 / 檔案各打各的 api，失敗一律當成「這一類沒有候選」。 */
  const loadItems = async (prefix: string | null, scopeMode = false): Promise<PopoverItem[]> => {
    const env = mentionEnv();
    const out: PopoverItem[] = [];
    const ed = env.editor;
    // 特殊情境只在真的有東西可帶時才列：列一個點了等於沒帶的 `@result` 只會讓人以為壞了。
    if (!scopeMode && !prefix && ed && ed.connId === env.connId) {
      if (ed.sql.trim()) out.push({ id: "sp:query", label: "@query", hint: t("目前編輯器的查詢"), group: "special", insert: "@query" });
      if (ed.result) out.push({ id: "sp:result", label: "@result", hint: t("目前的查詢結果"), group: "special", insert: "@result" });
      if (ed.error) out.push({ id: "sp:error", label: "@error", hint: t("上一次的執行錯誤"), group: "special", insert: "@error" });
    }
    if (prefix === "file") {
      try {
        for (const f of await api.agentWorkspaceFiles(null)) {
          out.push({ id: `file:${f}`, label: f, group: "file", insert: `@file:${f.includes(" ") ? `"${f}"` : f}` });
        }
      } catch { /* 工作資料夾讀不到就沒有檔案候選 */ }
      return out;
    }
    if (!env.connId) return out;
    if (prefix === "db") {
      try {
        for (const d of await api.listDatabases(env.connId)) {
          out.push({ id: `db:${d}`, label: d, group: "db", insert: `@db:${d}` });
        }
      } catch { /* 沒連線 / 沒權限 */ }
      return out;
    }
    try {
      for (const tb of await api.listTables(env.connId, env.db)) {
        out.push({
          id: `t:${tb.name}`,
          label: tb.name,
          hint: env.db,
          group: tb.kind === "view" ? "view" : "table",
          insert: `@${tb.name.includes(" ") ? `"${tb.name}"` : tb.name}`,
        });
      }
    } catch { /* 沒連線 / 沒權限 */ }
    if (!scopeMode && !prefix) {
      out.push({ id: "p:db", label: "@db:", hint: t("指定其他資料庫"), group: "db", insert: "@db:" });
      out.push({ id: "p:file", label: "@file:", hint: t("助手工作資料夾裡的檔案"), group: "file", insert: "@file:" });
    }
    return out;
  };

  /** 輸入變動 / 移動游標時重算要不要開補全。 */
  const syncPopover = (text: string, caret: number) => {
    // 多選面板由按鈕開關，不受打字影響。
    if (popover?.kind === "scope") return;
    // 只在「還在打命令名」時開清單：打完空白開始寫參數就收起來，免得擋住輸入。
    const slash = /^\/([a-z]*)$/.exec(text);
    if (slash) {
      setPopover({ kind: "slash", query: slash[1] });
      setPopItems(SLASH_COMMANDS.map((c) => ({
        id: c.name, label: c.name, hint: c.hint, group: "command" as const, insert: c.name,
      })));
      return;
    }
    const trig = mentionTrigger(text, caret);
    if (!trig) { setPopover(null); return; }
    setPopover({ kind: "mention", from: trig.from, query: trig.query, prefix: trig.prefix });
    setPopLoading(true);
    void loadItems(trig.prefix).then((items) => { setPopItems(items); }).finally(() => setPopLoading(false));
  };

  /** 選中一個候選：把游標前那段 token 換成它。 */
  const applyPick = (it: PopoverItem) => {
    if (popover?.kind === "slash") {
      setInput(`${it.insert} `);
      setPopover(null);
      textareaRef.current?.focus();
      return;
    }
    if (popover?.kind !== "mention") return;
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? input.length;
    const next = `${input.slice(0, popover.from)}${it.insert}${it.insert.endsWith(":") ? "" : " "}${input.slice(caret)}`;
    setInput(next);
    setPopover(null);
    // 游標擺回插入點之後，使用者可以接著打字（`@db:` 這種前綴尤其需要）。
    const pos = popover.from + it.insert.length + (it.insert.endsWith(":") ? 0 : 1);
    setTimeout(() => { ta?.focus(); ta?.setSelectionRange(pos, pos); }, 0);
  };

  /** 「範圍」按鈕：一次勾選多張表，比逐一打 @ 快。 */
  const openScope = async () => {
    setPopLoading(true);
    setPopover({ kind: "scope", selected: new Set(parseMentions(input).filter((r) => r.kind === "table" && r.table).map((r) => `t:${r.table}`)) });
    try { setPopItems(await loadItems(null, true)); } finally { setPopLoading(false); }
  };

  /** 勾選完成：把勾起來的表補成 @ token，取消勾選的移除。 */
  const applyScope = (selected: Set<string>) => {
    const want = new Set(Array.from(selected).map((id) => id.replace(/^t:/, "")));
    const refs = parseMentions(input).filter((r) => r.kind === "table" && r.table);
    // 先移除不再需要的（由後往前，位移才不會失效）。
    let next = input;
    for (const r of [...refs].sort((a, b) => b.from - a.from)) {
      if (want.has(r.table!)) want.delete(r.table!);
      else next = `${next.slice(0, r.from)}${next.slice(r.to)}`.replace(/ {2,}/g, " ");
    }
    const added = Array.from(want).map((tb) => `@${tb.includes(" ") ? `"${tb}"` : tb}`).join(" ");
    setInput(added ? `${next.trimEnd()} ${added} `.trimStart() : next);
    setPopover(null);
    textareaRef.current?.focus();
  };

  /** 目前輸入框裡的提及（chips 列用）。 */
  const inputRefs = useMemo(() => parseMentions(input), [input]);

  // 送出前先算一次「這則會帶多少東西」。debounce 400ms：每打一個字就去抓一輪表結構，
  // 打完一個表名等於打了十次 api。估算失敗就不顯示——它是加值資訊，不該冒出錯誤訊息。
  const [ctxEstimate, setCtxEstimate] = useState<{ tables: number; bytes: number } | null>(null);
  useEffect(() => {
    if (!inputRefs.length) { setCtxEstimate(null); return; }
    let alive = true;
    const id = setTimeout(() => {
      void expandMentions(inputRefs, mentionEnv())
        .then(({ chips }) => {
          if (!alive) return;
          const { bytes } = estimateContext(chips);
          setCtxEstimate({ tables: chips.filter((c) => c.kind === "table" && !c.skipped).length, bytes });
        })
        .catch(() => { if (alive) setCtxEstimate(null); });
    }, 400);
    return () => { alive = false; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);
  const removeMention = (from: number, to: number) => {
    setInput(`${input.slice(0, from)}${input.slice(to)}`.replace(/ {2,}/g, " "));
    textareaRef.current?.focus();
  };

  /**
   * 在對話裡直接執行一個 SQL 區塊。守門與查詢分頁同一套（chatRun.classifyForRun）：
   * 唯讀連線擋寫入、正式環境與破壞性語句要確認。少了這一層，「一鍵執行 AI 寫的 SQL」
   * 就是把查詢分頁辛苦建立的所有保護繞過去。
   */
  const runBlock: RunBlock = async (msgId, blockIdx, code, feedback) => {
    const s = useStore.getState();
    const connId = s.activeId;
    const conn = s.connections.find((c) => c.id === connId) ?? null;
    if (!connId || !conn || !s.connectedIds.has(connId)) { toast.info(t("請先連線再執行")); return; }

    const cls = classifyForRun(code, conn.kind, {
      readonly: !!s.readonlyConns[connId],
      prod: isProdConn(conn),
    });
    if (!cls.ok) {
      toast.info(
        cls.reason === "unsupported" ? t("這個連線種類不支援在對話中執行；請用「貼到編輯器」。")
          : cls.reason === "readonly" ? t("此連線為唯讀模式，已擋下寫入語句。")
          : t("沒有可執行的語句。"),
      );
      return;
    }
    // 寫入語句改走審查並執行：AI 審查、逐句備份前後像、產生回滾腳本後才執行，結果再掛回這則訊息。
    if (routeToReviewRun(cls, conn.kind)) {
      useStore.getState().openReviewRun({
        connId,
        database: dbTarget(s)?.database ?? "",
        sql: code,
        origin: "chat",
        onDone: (outcome) => {
          const result = reviewOutcomeToChatRun(code, outcome);
          if (!result) return;
          setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, runs: { ...(x.runs ?? {}), [String(blockIdx)]: result } } : x)));
          if (feedback) void send(runFeedbackDisplay(result), false, { extraContext: runFeedbackPrompt(result) });
        },
      });
      return;
    }
    for (const c of cls.confirm) {
      const ok = await uiConfirm(
        c === "prod" ? t("「{name}」是正式環境連線，確定要執行嗎？", { name: conn.name })
          : c === "danger" ? t("這段 SQL 含破壞性操作（DROP / TRUNCATE，或沒有 WHERE 的 DELETE / UPDATE）。確定執行？")
          : t("這段 SQL 會寫入 / 變更資料，確定在「{name}」執行？", { name: conn.name }),
        { title: t("確認執行"), danger: true, confirmText: t("執行") },
      );
      if (!ok) return;
    }

    const db = dbTarget(s)?.database ?? null;
    const stmts = prepareStatements(cls.statements, conn.kind, db);
    const started = performance.now();
    let last: Awaited<ReturnType<typeof api.runQuery>> | null = null;
    let err: string | null = null;
    try {
      // 逐句執行、遇錯即停：後面的語句多半依賴前面的結果，硬跑下去只會製造第二個錯誤。
      for (const stmt of stmts) last = await api.runQuery(connId, stmt, 200);
    } catch (e: any) {
      err = e?.message ?? String(e);
    }
    const result = toChatRunResult(code, last, Math.round(performance.now() - started), err);
    setMessages((m) => m.map((x) => (x.id === msgId ? { ...x, runs: { ...(x.runs ?? {}), [String(blockIdx)]: result } } : x)));
    if (feedback) void send(runFeedbackDisplay(result), false, { extraContext: runFeedbackPrompt(result) });
  };

  /** 以某則回應為引言開新話題：保留脈絡但不再拖著整段舊歷史（見 newTopic 的成本說明）。 */
  const fork = (msg: ChatMsg) => {
    newTopic();
    const quoted = msg.text.length > 2000 ? `${msg.text.slice(0, 2000)}\n…` : msg.text;
    fillInput(`${quoted.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
  };

  if (!open) return null;

  const notReady = !!status && (!status.installed || !status.logged_in);
  const meta = providerMeta(provider);
  // 資料庫工具現況：API 供應商內建；CLI 供應商要找得到 dbk 才有（見 agent_detect.db_tools）。
  const dbToolsReady = !!status?.db_tools;
  // 清單上的標題：作用中的那串要用畫面上的 messages 推導（archive 裡的副本要等 effect 才折回去，
  // 不然剛問完第一句，標題還會停在「新對話」）。
  const titleOf = (c: ChatConversation) =>
    conversationTitle(c.id === activeConvId ? { ...c, messages } : c) ?? t("新對話");
  const convList = sortedConversations(archive);

  return (
    <div className="shrink-0 bg-panel border-l border-fg/10 flex flex-col text-sm relative" style={{ width }}>
      <div onMouseDown={startResize} title={t("拖曳調整寬度")}
        className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 z-10" />
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10">
        <Icon icon={Sparkles} size={14} className="text-accent shrink-0" />
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("AI 助手")}</span>
        {sessionIdRef.current && <span className="text-[10px] text-fg/30">{t("· 對話中")}</span>}
        <div className="ml-auto flex items-center gap-1">
          <IconButton icon={MessageSquarePlus} label={t("開新對話（目前這串會留在清單裡）")} box="w-6 h-6"
            onClick={newChat} disabled={streaming} />
          <IconButton icon={MessagesSquare} label={t("對話清單（{n}）", { n: convList.length })} box="w-6 h-6"
            onClick={() => setConvListOpen((v) => !v)} />
          {mode === "agent" && (
            <IconButton icon={Folder} label={t("開啟助手工作資料夾（腳本檔存放處）")} box="w-6 h-6"
              onClick={() => api.openAgentWorkspace().catch(() => {})} />
          )}
          {messages.length > 0 && (
            <IconButton icon={Download} label={t("匯出對話為 Markdown")} box="w-6 h-6" onClick={exportChat} />
          )}
          <IconButton icon={Trash2} label={t("清空目前對話")} box="w-6 h-6" onClick={reset} />
          <IconButton icon={PanelRightClose} label={t("收合面板")} box="w-6 h-6"
            onClick={() => useAssistant.getState().setOpen(false)} />
        </div>
      </div>

      {/* 對話清單：一個資料庫一串，切走再切回來歷史都在（見 chatSessions.ts）。 */}
      {convListOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setConvListOpen(false)} />
          <div className="absolute right-2 top-9 z-30 w-[min(20rem,calc(100%-1rem))] max-h-80 overflow-auto
                          bg-panel border border-fg/15 rounded shadow-lg py-1">
            {convList.map((c) => {
              const isActive = c.id === activeConvId;
              const count = isActive ? messages.length : c.messages.length;
              return (
                <div key={c.id}
                  className={`group flex items-center gap-1 px-2 py-1.5 text-xs cursor-pointer hover:bg-fg/5 ${isActive ? "bg-accent/10" : ""}`}
                  onClick={() => switchChat(c.id)}>
                  <div className="min-w-0 flex-1">
                    <div className={`truncate ${isActive ? "text-fg" : "text-fg/80"}`}>{titleOf(c)}</div>
                    <div className="truncate text-[10px] text-fg/35">
                      {[c.connName, t("{n} 則", { n: count }), fmtRelativeTime(c.updatedAt)].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <IconButton icon={Pencil} label={t("重新命名")} box="w-5 h-5"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); void renameChat(c.id); }} />
                  <IconButton icon={Trash2} label={t("刪除對話")} box="w-5 h-5"
                    className="opacity-0 group-hover:opacity-100"
                    onClick={(e) => { e.stopPropagation(); void deleteChat(c.id); }} />
                </div>
              );
            })}
            <button type="button" onClick={newChat} disabled={streaming}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 text-xs text-fg/60 hover:text-fg hover:bg-fg/5
                         border-t border-fg/10 mt-1 disabled:opacity-40 disabled:hover:bg-transparent">
              <Icon icon={MessageSquarePlus} size={13} /> {t("開新對話")}
            </button>
          </div>
        </>
      )}

      {notReady && (
        <div className="shrink-0 px-3 py-2 border-b border-fg/10 bg-amber-500/10 text-[11px] text-amber-200/90 leading-relaxed">
          {isApiProvider(provider) ? (
            <>
              {!status!.installed
                ? t("尚未設定 {name} 的 Base URL。", { name: meta.label })
                : t("{name} 還沒有 API 金鑰（地端端點可以不用）。", { name: meta.label })}
              <button type="button" onClick={() => setAiSettingsOpen(true)}
                className="ml-1 underline hover:text-amber-100">
                {t("開啟 AI 設定")}
              </button>
            </>
          ) : (
            <CliSetupHint provider={provider} status={status!} detecting={detecting} onDetect={detect} />
          )}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 ? (
          <EmptyState onPick={(p) => send(p)} onFill={fillInput} disabled={notReady} />
        ) : (
          <>
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} kind={activeKind} onFork={fork} onRun={runBlock} />
            ))}
            {!streaming && messages[messages.length - 1].role === "assistant" && (
              <div className="flex justify-start gap-1.5">
                <button type="button" onClick={regenerate} disabled={notReady}
                  className="inline-flex items-center gap-1 text-[11px] text-fg/45 hover:text-fg border border-fg/10 rounded px-2 py-0.5 hover:bg-fg/5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg/45"><Icon icon={RefreshCw} size={13} /> {t("重新生成")}</button>
                <button type="button" onClick={newTopic}
                  title={t("斷開上文、開始新話題（畫面上的對話保留）")}
                  className="inline-flex items-center gap-1 text-[11px] text-fg/45 hover:text-fg border border-fg/10 rounded px-2 py-0.5 hover:bg-fg/5"><Icon icon={GitBranch} size={13} /> {t("新話題")}</button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="relative shrink-0 border-t border-fg/10 p-2 space-y-2">
        <div onMouseDown={startInputResize} onDoubleClick={() => setInputH(0)}
          title={t("拖曳調整輸入區高度（雙擊還原自動高度）")}
          className="absolute left-0 -top-0.5 w-full h-1.5 cursor-row-resize hover:bg-accent/40 z-10" />
        <div className="flex items-center gap-2 text-[11px] text-fg/50">
          <label className="flex items-center gap-1 cursor-pointer select-none" title={t("送出時附帶目前連線 / 選取資料表的結構")}>
            <input type="checkbox" checked={ctxOn} onChange={(e) => setCtxOn(e.target.checked)} className="accent-blue-500" />
            {t("附帶資料庫內容")}
          </label>
          <label className={`flex items-center gap-1 select-none ${dbToolsReady ? "cursor-pointer" : "opacity-40 cursor-not-allowed"}`}
            title={dbToolsReady
              ? t("讓助手自己對目前連線下唯讀查詢（列表 / 看結構 / 取樣 / SELECT）。它跑了哪些查詢會顯示在回應裡。")
              : t("需要 dbk 執行檔才能讓 CLI 供應商使用資料庫工具；可改用 API 供應商，或設定 DB_KIT_DBK_BIN。")}>
            <input type="checkbox" checked={dbToolsOn && dbToolsReady} disabled={!dbToolsReady}
              onChange={(e) => setDbToolsOn(e.target.checked)} className="accent-blue-500" />
            <Icon icon={Database} size={11} />
            {t("資料庫工具")}
          </label>
          <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider)}
            title={t("要用哪個供應商回答（CLI 走你的訂閱登入，API 走你自己的端點與金鑰）")}
            className="ml-auto bg-inset border border-fg/10 rounded px-1 py-0.5 text-fg/70">
            {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as AgentMode)}
            title={t("唯讀問答：只回答 / 產生腳本文字。可寫腳本檔：允許寫入助手工作資料夾")}
            className="bg-inset border border-fg/10 rounded px-1 py-0.5 text-fg/70">
            <option value="advise">{t("唯讀問答")}</option>
            <option value="agent">{t("可寫腳本檔")}</option>
          </select>
          {provider === "claude" ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}
              className="bg-inset border border-fg/10 rounded px-1 py-0.5 text-fg/70">
              {CLAUDE_MODELS.map((m) => <option key={m.value} value={m.value}>{t(m.label)}</option>)}
            </select>
          ) : (
            <input value={model} onChange={(e) => setModel(e.target.value)}
              placeholder={isApiProvider(provider) ? t("模型名稱") : t("預設模型")}
              title={isApiProvider(provider)
                ? t("這個端點的模型名稱（可在 AI 設定裡從端點抓清單）")
                : t("留白用 codex 自己的預設模型；也可填模型名稱，如 gpt-5-codex")}
              className="w-28 bg-inset border border-fg/10 rounded px-1 py-0.5 text-fg/70 outline-none focus:border-accent/60" />
          )}
          <button type="button" onClick={() => setAiSettingsOpen(true)} title={t("AI 設定（供應商 / 人設 / 技能）")}
            className="shrink-0 text-fg/45 hover:text-fg/80">
            <Icon icon={Settings2} size={13} />
          </button>
        </div>

        {skills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-fg/35 mr-0.5">{t("技能")}</span>
            {skills.map((sk) => {
              const on = selectedSkills.includes(sk.id);
              return (
                <button key={sk.id} type="button" onClick={() => toggleSkill(sk.id)}
                  title={sk.builtin ? t(sk.body) : sk.body}
                  className={`px-1.5 py-0.5 rounded-full border text-[10px] ${
                    on ? "border-accent/60 bg-accent/15 text-accent" : "border-fg/10 text-fg/45 hover:text-fg/70 hover:bg-fg/5"
                  }`}>
                  {sk.builtin ? t(sk.name) : sk.name}
                </button>
              );
            })}
          </div>
        )}
        {/* 輸入框裡目前的 @ 提及：送出前就看得到「這則會帶什麼」，而不是送出後才知道。 */}
        {inputRefs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {inputRefs.map((r) => (
              <span key={`${r.from}-${r.raw}`}
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-accent/30 bg-accent/10 text-accent/90">
                {r.raw}
                <button type="button" onClick={() => removeMention(r.from, r.to)}
                  className="text-accent/60 hover:text-accent" title={t("移除")}>×</button>
              </span>
            ))}
            <button type="button" onClick={() => void openScope()}
              className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-fg/15 text-fg/50 hover:bg-fg/10">
              <Icon icon={ListFilter} size={10} />{t("範圍")}
            </button>
            {ctxEstimate && (
              <span className="ml-auto text-[10px] text-fg/30">
                {ctxEstimate.tables > 0
                  ? t("已附帶 {n} 張表、約 {kb} KB", { n: ctxEstimate.tables, kb: (ctxEstimate.bytes / 1024).toFixed(1) })
                  : t("約 {kb} KB", { kb: (ctxEstimate.bytes / 1024).toFixed(1) })}
              </span>
            )}
          </div>
        )}
        <div className="relative flex items-end gap-2">
          {popover && (
            <MentionPopover
              ref={popRef}
              items={popItems}
              query={popover.kind === "mention" ? popover.query : popover.kind === "slash" ? popover.query : ""}
              loading={popLoading}
              onPick={applyPick}
              onClose={() => setPopover(null)}
              multi={popover.kind === "scope" ? {
                selected: popover.selected,
                onToggle: (id) => setPopover((p) => {
                  if (p?.kind !== "scope") return p;
                  const next = new Set(p.selected);
                  if (next.has(id)) next.delete(id); else next.add(id);
                  return { ...p, selected: next };
                }),
                onDone: () => applyScope(popover.selected),
              } : undefined}
            />
          )}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => { setInput(e.target.value); syncPopover(e.target.value, e.target.selectionStart ?? 0); }}
            onClick={(e) => syncPopover(input, e.currentTarget.selectionStart ?? 0)}
            onKeyDown={(e) => {
              // 補全開著時方向鍵 / Enter / Tab 先給它，否則「選第二項」會變成直接送出。
              if (popover && popover.kind !== "scope") {
                if (e.key === "ArrowDown") { e.preventDefault(); popRef.current?.move(1); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); popRef.current?.move(-1); return; }
                if (e.key === "Escape") { e.preventDefault(); setPopover(null); return; }
                if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
                  const it = popRef.current?.pick();
                  if (it) { e.preventDefault(); applyPick(it); return; }
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder={t("輸入問題，@ 附帶資料表、/ 用指令，Enter 送出、Shift+Enter 換行")}
            className="flex-1 resize-none bg-inset border border-fg/10 rounded px-2 py-1.5 text-fg/90 placeholder:text-fg/30 outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/20 min-h-[2.5rem] overflow-auto"
          />
          {streaming ? (
            <button type="button" onClick={cancel}
              className="shrink-0 inline-flex items-center gap-1 h-9 px-3 rounded bg-danger/15 text-danger hover:bg-danger/25 text-xs"><Icon icon={Square} size={13} />{t("停止")}</button>
          ) : (
            <button type="button" onClick={() => send()} disabled={!input.trim() || notReady}
              className="shrink-0 inline-flex items-center gap-1 h-9 px-3 rounded bg-accent text-white hover:bg-accent/90 active:bg-accent/80 disabled:opacity-30 text-xs"><Icon icon={Send} size={13} />{t("送出")}</button>
          )}
        </div>
      </div>

      {aiSettingsOpen && <AiSettingsDialog open onClose={() => setAiSettingsOpen(false)} />}
    </div>
  );
}

// ---- 空狀態：說明 + 依目前選取情境的起手式建議 ----
function EmptyState({ onPick, onFill, disabled }: {
  onPick: (prompt: string) => void;
  onFill: (text: string) => void;
  disabled: boolean;
}) {
  const t = useT();
  const node = useStore((s) => s.selectedNode);
  const conn = useStore((s) => s.connections.find((c) => c.id === s.activeId) ?? null);

  const quick: { label: string; prompt: string; fill?: boolean }[] = [];
  if (node?.type === "table") {
    quick.push({ label: t("解釋資料表 {table}", { table: node.table }), prompt: t("請解釋資料表 {db}.{table} 的用途，以及每個欄位代表什麼。", { db: node.db, table: node.table }) });
    quick.push({ label: t("為 {table} 寫常用查詢", { table: node.table }), prompt: t("針對資料表 {db}.{table}，寫出 5 個實用的 SQL 查詢，每個都加上中文註解說明用途。", { db: node.db, table: node.table }) });
  } else if (conn) {
    quick.push({ label: t("從哪開始探索這個資料庫"), prompt: t("我想了解目前連線的這個資料庫，建議我從哪些資料表 / 查詢開始探索？") });
  }
  quick.push({ label: t("最佳化一段 SQL"), prompt: t("幫我最佳化這段 SQL（保留語意、說明改了什麼）：\n\n"), fill: true });
  quick.push({ label: t("寫一個備份腳本"), prompt: t("幫我寫一個可重複執行的資料庫備份腳本，並說明怎麼設定排程。") });

  return (
    <div className="text-fg/40 text-xs leading-relaxed p-1 space-y-3">
      <div>
        {t("問我問題或請我撰寫腳本（SQL / Shell / Python…）。")}
        <br />{t("勾選「附帶資料庫內容」時，我會看到你目前選取的連線與資料表結構，寫出貼合的查詢。")}
        <br />{t("程式碼區塊可一鍵「複製 / 另存」，SQL 還能「貼到查詢編輯器」。")}
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

/** 使用者訊息底下的「這則帶了什麼」收據。沒帶成的也要顯示，見 MentionChip.skipped 的說明。 */
function MentionChips({ chips, bytes }: { chips: MentionChip[]; bytes?: number }) {
  const t = useT();
  const why: Record<NonNullable<MentionChip["skipped"]>, string> = {
    missing: t("找不到這個物件，未附帶"),
    budget: t("超出上下文預算，未附帶"),
    unavailable: t("目前取不到內容，未附帶"),
  };
  return (
    <div className="flex flex-wrap items-center gap-1 max-w-[85%] justify-end">
      {chips.map((c, i) => (
        <span key={`${c.label}-${i}`} title={c.skipped ? why[c.skipped] : undefined}
          className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border ${
            c.skipped ? "border-fg/10 text-fg/25 line-through" : "border-accent/30 bg-accent/10 text-accent/90"
          }`}>
          {c.skipped === "missing" && <Icon icon={AlertTriangle} size={9} />}
          {c.label}
        </span>
      ))}
      {bytes != null && bytes > 0 && (
        <span className="text-[10px] text-fg/25">{t("約 {kb} KB", { kb: (bytes / 1024).toFixed(1) })}</span>
      )}
    </div>
  );
}

/** 在對話裡執行某個程式碼區塊：(訊息 id, 區塊序號, SQL, 是否把結果回饋給模型)。 */
type RunBlock = (msgId: string, blockIdx: number, code: string, feedback: boolean) => void;

// ---- 工具呼叫明細 ----

/**
 * 助手這一輪實際跑了哪些工具、下了哪條 SQL、拿回幾列。
 *
 * 為什麼一定要露出來：模型能自己對使用者的正式資料庫下查詢之後，「它到底查了什麼」
 * 就不再是實作細節而是稽核需求。只顯示一個工具名稱的徽章，等於要使用者盲信一段看不見的 SQL。
 */
function ToolCalls({ calls, kind }: { calls: ToolCallView[]; kind: DbKind | null }) {
  const t = useT();
  const themeId = useTheme((s) => s.themeId);
  const appTheme = useTheme((s) => s.theme);
  const { colors } = resolveHighlightColors(themeId, appTheme);
  const anyError = calls.some((c) => c.error);
  // 出錯就自動展開：失敗的查詢是使用者最需要看到的那一個。
  const [open, setOpen] = useState(anyError);

  if (!calls.length) return null;
  return (
    <div className="mb-1.5 rounded border border-fg/10 overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 w-full px-2 py-1 bg-fg/5 text-[10px] text-fg/50 hover:text-fg/80">
        <Icon icon={open ? ChevronDown : ChevronRight} size={12} />
        <Icon icon={Database} size={11} />
        {t("工具呼叫（{n}）", { n: calls.length })}
        {anyError && <span className="text-danger">· {t("有失敗")}</span>}
        {!open && (
          <span className="ml-1 truncate text-fg/35">{calls.map((c) => c.name).join(", ")}</span>
        )}
      </button>
      {open && (
        <div className="divide-y divide-fg/10">
          {calls.map((c, i) => (
            <div key={c.id || i} className="px-2 py-1.5 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className={`mono px-1 py-0.5 rounded ${c.error ? "bg-danger/15 text-danger" : "bg-fg/10 text-fg/60"}`}>{c.name}</span>
                {c.rows != null && <span className="text-fg/40">{t("{n} 列", { n: c.rows })}</span>}
                {c.truncated && <span className="text-amber-300/80">{t("已截斷")}</span>}
                {c.ms != null && <span className="text-fg/30">{c.ms} ms</span>}
                {!c.done && <span className="text-fg/40 animate-pulse">{t("執行中…")}</span>}
                {c.input && (
                  <button type="button" className="ml-auto text-fg/40 hover:text-fg"
                    onClick={() => { copyToClipboard(c.input!); toast.success(t("已複製")); }}>{t("複製")}</button>
                )}
                {c.input && isSqlToolCall(c, kind) && (
                  <button type="button" className="text-fg/40 hover:text-fg"
                    onClick={() => { useStore.getState().requestQuery(c.input!); toast.success(t("已貼到查詢編輯器")); }}>
                    {t("貼到編輯器")}
                  </button>
                )}
              </div>
              {c.input && (
                <pre className="px-1.5 py-1 rounded bg-inset overflow-auto text-[11px] mono max-h-24 whitespace-pre-wrap break-words"
                  style={{ color: colors.fg }}>
                  <code>{isSqlToolCall(c, kind) ? highlightSql(c.input, colors) : c.input}</code>
                </pre>
              )}
              {c.preview && (
                <pre className={`px-1.5 py-1 rounded bg-inset overflow-auto text-[10px] mono max-h-28 whitespace-pre-wrap break-words ${c.error ? "text-danger" : "text-fg/55"}`}>
                  {c.preview}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 訊息泡泡 ----
function MessageBubble({ msg, kind, onFork, onRun }: {
  msg: ChatMsg;
  kind: DbKind | null;
  onFork: (msg: ChatMsg) => void;
  onRun: RunBlock | null;
}) {
  const t = useT();
  // 「新話題」分隔線：不是一則訊息，只是視覺上把 session 斷開的地方標出來。
  if (msg.divider) {
    return (
      <div className="flex items-center gap-2 py-1 text-[10px] text-fg/30">
        <div className="flex-1 border-t border-fg/10" />
        {t("新話題")}
        <div className="flex-1 border-t border-fg/10" />
      </div>
    );
  }
  if (msg.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-lg px-3 py-2 bg-accent/12 text-fg/90 whitespace-pre-wrap break-words">
          {msg.text}
        </div>
        {!!msg.mentions?.length && <MentionChips chips={msg.mentions} bytes={msg.ctxBytes} />}
      </div>
    );
  }
  const calls = (msg.toolCalls as ToolCallView[] | undefined) ?? [];
  return (
    <div className="flex justify-start">
      <div className="group max-w-full w-full rounded-lg px-3 py-2 bg-fg/5 text-fg/90">
        <ToolCalls calls={calls} kind={kind} />
        {calls.length === 0 && msg.tools.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {msg.tools.map((item) => (
              <span key={item} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-fg/10 text-fg/50"><Icon icon={Settings} size={13} /> {item}</span>
            ))}
          </div>
        )}
        {msg.pending && !msg.text ? (
          <div className="flex items-center gap-2 text-fg/40 text-xs">
            <span className="inline-block w-3 h-3 rounded-full border border-fg/40 border-t-transparent animate-spin" />
            {t("思考中…")}
          </div>
        ) : (
          <Markdown text={msg.text} msgId={msg.id} runs={msg.runs} onRun={onRun} />
        )}
        <div className="mt-1 flex items-center gap-2">
          {msg.error && <span className="text-[11px] text-red-400">{t("回應發生錯誤")}</span>}
          {!msg.pending && msg.ms != null && (
            <span className="text-[10px] text-fg/25">{(msg.ms / 1000).toFixed(1)}s</span>
          )}
          {!msg.pending && msg.text && (
            <div className="ml-auto flex items-center gap-2 opacity-60 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity">
              <button type="button" onClick={() => onFork(msg)}
                title={t("引用這則回應開始新話題（不再帶著整段舊對話送給模型）")}
                className="text-[10px] text-fg/40 hover:text-fg">
                {t("以此開新話題")}
              </button>
              <button type="button"
                onClick={() => { copyToClipboard(msg.text); toast.success(t("已複製整則回應")); }}
                className="text-[10px] text-fg/40 hover:text-fg">
                {t("複製全部")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Markdown({ text, msgId, runs, onRun }: {
  text: string;
  msgId?: string;
  /** blockIdx（字串化）→ 該區塊已執行過的結果。 */
  runs?: Record<string, ChatRunResult>;
  onRun?: RunBlock | null;
}) {
  const parts = useMemo(() => parseBlocks(text), [text]);
  // 程式碼區塊的序號要獨立於 parts 的索引：文字段落也占 parts 的位置，
  // 用 parts 索引當 key 的話，模型多吐一段說明就會讓「第幾個區塊」整個位移，
  // 已經跑過的結果就掛到別的區塊底下去了。
  let codeIdx = -1;
  return (
    <div className="space-y-2">
      {parts.map((p, i) => {
        if (p.type !== "code") return <TextBlock key={i} text={p.text} />;
        codeIdx++;
        const idx = codeIdx;
        return (
          <CodeBlock key={i} lang={p.lang} code={p.code}
            run={runs?.[String(idx)]}
            onRun={onRun && msgId ? (feedback) => onRun(msgId, idx, p.code, feedback) : undefined} />
        );
      })}
    </div>
  );
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

function CodeBlock({ lang, code, run, onRun }: {
  lang: string;
  code: string;
  run?: ChatRunResult;
  /** 有值才顯示「執行」；參數為「是否把結果回饋給 AI」。 */
  onRun?: (feedback: boolean) => void;
}) {
  const t = useT();
  const themeId = useTheme((s) => s.themeId);
  const appTheme = useTheme((s) => s.theme);
  const isSql = lang === "sql" || (!lang && looksLikeSql(code));
  // 套用目前整體主題的色盤（統一後恆為指定變體 → 吃該變體背景，與編輯器一致）。
  const { colors, useBg } = resolveHighlightColors(themeId, appTheme);

  const save = async () => {
    const ext = extFor(lang || (isSql ? "sql" : "txt"));
    const path = await pickSaveFile(`script.${ext}`, [
      { name: ext.toUpperCase(), extensions: [ext] },
      { name: "All", extensions: ["*"] },
    ]);
    if (!path) return;
    try {
      await api.saveTextFile(path, code);
      toast.success(t("已儲存腳本"));
    } catch (e: any) {
      toast.error(e?.message ?? t("儲存失敗"));
    }
  };

  const btn = "px-1.5 py-0.5 rounded text-fg/55 hover:text-fg hover:bg-fg/10";
  return (
    <div className="rounded border border-fg/10 overflow-hidden bg-well">
      <div className="flex items-center gap-1 px-2 py-1 bg-fg/5 text-[10px] text-fg/45">
        <span className="uppercase tracking-wide">{lang || t("程式碼")}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {isSql && onRun && (
            <>
              <button type="button" className={btn} title={t("在目前連線執行這段 SQL（寫入語句會先進入審查並執行：AI 審查與備份）")}
                onClick={() => onRun(false)}>
                <span className="inline-flex items-center gap-0.5"><Icon icon={Play} size={11} />{t("執行")}</span>
              </button>
              <button type="button" className={btn} title={t("執行後把結果交給 AI 接著分析")}
                onClick={() => onRun(true)}>
                {t("執行並回饋")}
              </button>
            </>
          )}
          {isSql && (
            <button type="button" className={btn}
              onClick={() => { useStore.getState().requestQuery(code); toast.success(t("已貼到查詢編輯器")); }}>
              {t("貼到編輯器")}
            </button>
          )}
          <button type="button" className={btn} onClick={save}>{t("另存")}</button>
          <button type="button" className={btn}
            onClick={() => { copyToClipboard(code); toast.success(t("已複製")); }}>{t("複製")}</button>
        </div>
      </div>
      <pre className="p-2 overflow-auto text-[12px] mono leading-relaxed"
        style={{ backgroundColor: useBg ? colors.bg : undefined, color: colors.fg }}>
        <code>{isSql ? highlightSql(code, colors) : code}</code>
      </pre>
      {run && (
        <ChatSqlResult run={run}
          onOpenInTab={(sql) => useStore.getState().newQueryTab(sql, useStore.getState().activeId ?? undefined)}
          onFeedback={() => onRun?.(true)} />
      )}
    </div>
  );
}

