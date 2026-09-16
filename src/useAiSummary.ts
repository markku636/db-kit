import { useOneShotGenerate } from "./useOneShotGenerate";

/**
 * 一次性 AI 摘要（比對報告用）。
 *
 * 本體已併入 `useOneShotGenerate`——NL→SQL 查詢列、編輯器 AI 改寫與這支摘要要的是同一件事：
 * 單回合、零工具、不開 session。三份各自實作的串流迴圈遲早會在「先掛監聽再送出」與
 * 「取消後誰負責收尾」這兩點上漂移，而那兩個 bug 都只在網路慢的時候才看得見。
 *
 * 保留這個名字是因為呼叫端（CompareDialog）讀起來就是「要一份摘要」，
 * 而不是「要跑一次一次性生成」。
 */
export function useAiSummary() {
  return useOneShotGenerate({ mode: "generate" });
}
