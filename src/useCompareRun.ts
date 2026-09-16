import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { api, onCompareProgress, type CompareProgress } from "./api";

/**
 * 一次比對執行的進度 / 取消管理（與 StressDialog 同一套慣例）：
 * - run_id 由前端產生並放 ref：事件 handler 在 listen 當下閉包起來，用 state 會讀到舊值而濾掉自己的進度。
 * - 先掛監聽再 invoke：命令回來時整輪已結束，晚掛會漏掉整段進度。
 * - 卸載時解除監聽並取消還在跑的比對：對話框沒了還繼續打資料庫是最糟的狀況。
 */
export function useCompareRun() {
  const runIdRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const [progress, setProgress] = useState<CompareProgress | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => () => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (runIdRef.current) void api.compareDataCancel(runIdRef.current).catch(() => {});
  }, []);

  const start = useCallback(async function <T>(fn: (runId: string) => Promise<T>): Promise<T> {
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunning(true);
    setProgress(null);
    try {
      unlistenRef.current?.();
      unlistenRef.current = await onCompareProgress(runId, (p) => setProgress(p));
      return await fn(runId);
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
      runIdRef.current = null;
      setRunning(false);
    }
  }, []);

  // 取消只是設旗標；後端命令仍會回傳（部分的）結果並標記 cancelled。
  const cancel = useCallback(() => {
    const id = runIdRef.current;
    if (id) void api.compareDataCancel(id).catch(() => {});
  }, []);

  return { progress, running, start, cancel };
}
