import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, onAgentStream, type AgentEvent } from "./api";
import { applyToolEvent, type ToolCallView } from "./agentTools";
import { baseUrlOf, useAiProvider } from "./aiProvider";
import { useT } from "./i18n";
import { combineVerdicts, parseVerdict, type Verdict } from "./verdict";

/** 一位審查者：人設的系統提示 + agent 參數（來自資源庫；執行前審查則由後端組好）。 */
export interface DbaReviewer {
  persona: string;
  title: string;
  system: string;
  maxTurns: number;
  /** 允許的唯讀資料庫工具；null = 這位審查者不查資料庫（走一次性 review 模式）。 */
  dbTools: string[] | null;
}

export interface DbaReviewRequest {
  /** 使用者訊息（任務範本 + 上下文 + 結論契約），所有審查者共用。 */
  prompt: string;
  reviewers: DbaReviewer[];
  /** 已連線的連線；沒有就不給資料庫工具（照樣能審，只是不能自己驗證）。 */
  connId: string | null;
  database: string | null;
}

export interface DbaRun {
  persona: string;
  title: string;
  text: string;
  running: boolean;
  queued: boolean;
  error: string | null;
  tools: ToolCallView[];
  verdict: Verdict | null;
  /** 這位實際用的模式（dba = 可查資料庫的 agent；review = 一次性）。 */
  mode: "dba" | "review";
}

/** 會審同時跑幾位：CLI 供應商每位是一個子程序，太多會把機器與額度一起吃掉。 */
export const MAX_PARALLEL = 4;

/**
 * DBA 審查：同一份提示交給一位或多位審查者（會審），各自串流、各自的工具呼叫稽核清單，
 * 綜合結論取最嚴格者。與 useOneShotGenerate 同一套「先掛監聽再送出、卸載即取消」的紀律。
 */
export function useDbaReview() {
  const t = useT();
  const { provider, baseUrls, models } = useAiProvider();
  const [runs, setRuns] = useState<DbaRun[]>([]);
  const reqIds = useRef<Map<number, string>>(new Map());
  const unlisten = useRef<Map<number, UnlistenFn>>(new Map());
  const generation = useRef(0);

  const patch = useCallback((gen: number, i: number, f: (r: DbaRun) => DbaRun) => {
    if (gen !== generation.current) return;
    setRuns((rs) => rs.map((r, j) => (j === i ? f(r) : r)));
  }, []);

  const cleanup = useCallback((i: number) => {
    unlisten.current.get(i)?.();
    unlisten.current.delete(i);
    reqIds.current.delete(i);
  }, []);

  const cancel = useCallback(() => {
    generation.current++;
    for (const [i, id] of reqIds.current) {
      void api.agentCancel(id).catch(() => {});
      cleanup(i);
    }
    setRuns((rs) => rs.map((r) => (r.running || r.queued ? { ...r, running: false, queued: false } : r)));
  }, [cleanup]);

  // 卸載時取消所有還在跑的：對話框關了還讓模型繼續查資料庫是純浪費。
  useEffect(() => () => {
    generation.current++;
    for (const [i, id] of reqIds.current) {
      void api.agentCancel(id).catch(() => {});
      unlisten.current.get(i)?.();
    }
    reqIds.current.clear();
    unlisten.current.clear();
  }, []);

  const start = useCallback(
    async (req: DbaReviewRequest) => {
      cancel();
      const gen = ++generation.current;
      const initial: DbaRun[] = req.reviewers.map((r) => ({
        persona: r.persona,
        title: r.title,
        text: "",
        running: false,
        queued: true,
        error: null,
        tools: [],
        verdict: null,
        mode: r.dbTools && req.connId ? "dba" : "review",
      }));
      setRuns(initial);

      const runOne = async (i: number) => {
        const r = req.reviewers[i];
        const mode = initial[i].mode;
        const reqId = crypto.randomUUID();
        reqIds.current.set(i, reqId);
        patch(gen, i, (x) => ({ ...x, running: true, queued: false }));
        let acc = "";
        await new Promise<void>((resolve) => {
          void (async () => {
            try {
              const un = await onAgentStream(reqId, (e: AgentEvent) => {
                switch (e.kind) {
                  case "text":
                    if (e.text) {
                      acc += e.text;
                      const text = acc;
                      patch(gen, i, (x) => ({ ...x, text, verdict: parseVerdict(text) }));
                    }
                    break;
                  case "result":
                    // Codex 沒有 token 級增量，整段只會在這裡到齊。
                    if (e.text && !acc) {
                      acc = e.text;
                      const text = acc;
                      patch(gen, i, (x) => ({ ...x, text, verdict: parseVerdict(text) }));
                    }
                    break;
                  case "tool":
                  case "tool_result":
                    patch(gen, i, (x) => ({ ...x, tools: applyToolEvent(x.tools, e) }));
                    break;
                  case "error":
                    patch(gen, i, (x) => ({ ...x, error: e.text ?? t("發生錯誤") }));
                    break;
                  case "done":
                    patch(gen, i, (x) => ({ ...x, running: false, tools: x.tools.map((c) => ({ ...c, done: true })) }));
                    cleanup(i);
                    resolve();
                    break;
                }
              });
              unlisten.current.set(i, un);
              await api.agentSend({
                reqId,
                prompt: req.prompt,
                sessionId: null,
                model: models[provider] || null,
                mode,
                provider,
                baseUrl: baseUrlOf(provider, baseUrls) || null,
                systemPrompt: r.system,
                connectionId: mode === "dba" ? req.connId : null,
                database: mode === "dba" ? req.database : null,
                maxTurns: mode === "dba" ? r.maxTurns : null,
                dbTools: mode === "dba" ? r.dbTools : null,
              });
            } catch (e: any) {
              patch(gen, i, (x) => ({ ...x, running: false, error: e?.message ?? String(e) }));
              cleanup(i);
              resolve();
            }
          })();
        });
      };

      // 最多同時 MAX_PARALLEL 位，其餘排隊。
      let next = 0;
      const worker = async () => {
        while (next < req.reviewers.length && gen === generation.current) {
          const i = next++;
          await runOne(i);
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, req.reviewers.length) }, worker));
    },
    [cancel, cleanup, patch, provider, baseUrls, models, t],
  );

  const reset = useCallback(() => {
    cancel();
    setRuns([]);
  }, [cancel]);

  const running = runs.some((r) => r.running || r.queued);
  const combined = useMemo(() => {
    const done = runs.filter((r) => r.text || r.error);
    return done.length ? combineVerdicts(done.map((r) => r.verdict)) : null;
  }, [runs]);

  return { runs, running, combined, start, cancel, reset };
}

/** 寫進 review.md / 交給助手追問用的合併文字：單人照原文，會審每位一節。 */
export function combinedReviewText(runs: readonly DbaRun[]): string {
  const withText = runs.filter((r) => r.text.trim());
  if (withText.length <= 1) return withText[0]?.text ?? "";
  return withText.map((r) => `# ${r.title}\n\n${r.text.trim()}`).join("\n\n---\n\n");
}
