import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, onAgentStream, type AgentEvent } from "./api";
import { baseUrlOf, useAiProvider } from "./aiProvider";
import { currentSystemPrompt } from "./aiSkills";
import { useT } from "./i18n";

/**
 * 一次性 AI 摘要（比對報告用）：送出提示 → 串流累積文字 → 完成。
 * 與 NlQueryBar 走同一套供應商設定與事件（agent-stream），但不做 code block 擷取，
 * 也不開 session —— 摘要是單回合的，留著 session 只會讓下一次摘要帶進不相干的上下文。
 */
export function useAiSummary() {
  const t = useT();
  const { provider, baseUrls, models } = useAiProvider();
  const reqIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 卸載時解除監聽並取消還在跑的請求：對話框關了還讓模型繼續吐是純浪費。
  useEffect(() => () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (reqIdRef.current) void api.agentCancel(reqIdRef.current).catch(() => {});
  }, []);

  const cancel = useCallback(() => {
    const id = reqIdRef.current;
    if (id) void api.agentCancel(id).catch(() => {});
  }, []);

  const run = useCallback(async (prompt: string) => {
    if (reqIdRef.current) return;
    const reqId = crypto.randomUUID();
    reqIdRef.current = reqId;
    setRunning(true);
    setError(null);
    setText("");
    let acc = "";
    try {
      // 先掛監聽再送出：命令回來時整段已經串流完，晚掛會整個漏掉。
      unlistenRef.current?.();
      unlistenRef.current = await onAgentStream(reqId, (e: AgentEvent) => {
        switch (e.kind) {
          case "text":
            if (e.text) { acc += e.text; setText(acc); }
            break;
          case "result":
            if (e.text && !acc) { acc = e.text; setText(acc); }
            break;
          case "error":
            setError(e.text ?? t("發生錯誤"));
            break;
          case "done":
            setRunning(false);
            reqIdRef.current = null;
            unlistenRef.current?.();
            unlistenRef.current = null;
            break;
        }
      });
      await api.agentSend({
        reqId,
        prompt,
        sessionId: null,
        model: models[provider] || null,
        mode: "generate",
        provider,
        baseUrl: baseUrlOf(provider, baseUrls) || null,
        systemPrompt: currentSystemPrompt(false),
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRunning(false);
      reqIdRef.current = null;
    }
  }, [provider, baseUrls, models, t]);

  return { text, running, error, run, cancel, reset: () => { setText(""); setError(null); } };
}
