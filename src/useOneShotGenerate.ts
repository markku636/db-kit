import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, onAgentStream, type AgentEvent, type AgentMode } from "./api";
import { baseUrlOf, useAiProvider } from "./aiProvider";
import { currentSystemPrompt } from "./aiSkills";
import { useT } from "./i18n";

/**
 * 一次性 AI 生成：送出提示 → 串流累積文字 → 完成。不開 session。
 *
 * 三個呼叫端共用這一支（比對報告摘要、NL→SQL 查詢列、編輯器 AI 改寫），因為它們要的東西
 * 完全一樣：單回合、零工具、不要把上下文帶到下一次。留著 session 只會讓下一次生成沾到
 * 不相干的對話；而三份各自實作的串流迴圈遲早會在「取消」與「先掛監聽再送出」這兩件事上漂移。
 *
 * mode 的差別只在額度：
 * - `generate`（1024 token）：NL→SQL，輸出就是一條語句。
 * - `edit`（4096 token）：編輯器內改寫，要把整段 SQL 原樣吐回來，1024 對長查詢不夠。
 */
export function useOneShotGenerate(opts?: { mode?: Extract<AgentMode, "generate" | "edit"> }) {
  const mode = opts?.mode ?? "generate";
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
    // 後端 abort 後不一定還會送 done，本端先收尾，避免按鈕卡在「停止」。
    reqIdRef.current = null;
    unlistenRef.current?.();
    unlistenRef.current = null;
    setRunning(false);
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
      // 先掛監聽再送出：命令回來時整段可能已經串流完，晚掛會整個漏掉。
      unlistenRef.current?.();
      unlistenRef.current = await onAgentStream(reqId, (e: AgentEvent) => {
        switch (e.kind) {
          case "text":
            if (e.text) { acc += e.text; setText(acc); }
            break;
          case "result":
            // Codex 沒有 token 級增量，整段只會在這裡到齊。
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
        mode,
        provider,
        baseUrl: baseUrlOf(provider, baseUrls) || null,
        // 技能（skills）不帶：一次性生成要的是「照格式吐一段語句」，
        // 疊上「請附上風險說明」這類技能只會讓輸出多出程式碼區塊以外的東西。
        systemPrompt: currentSystemPrompt(false),
        // 一次性模式後端不給資料庫工具，故不附連線。
      });
    } catch (e: any) {
      setError(e?.message ?? String(e));
      setRunning(false);
      reqIdRef.current = null;
    }
  }, [provider, baseUrls, models, mode, t]);

  const reset = useCallback(() => { setText(""); setError(null); }, []);

  return { text, running, error, run, cancel, reset };
}
