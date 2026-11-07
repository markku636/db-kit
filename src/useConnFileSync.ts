// 切回視窗時重讀連線清單。
//
// `dbk conn add` / `dbk conn remove`（常是 AI 代理人在終端機下的）直接改 connections.json，
// App 開著也要看得到，不必重開。檔案內容沒變就不動 store（免得側欄白重繪）；有變時以磁碟為準合併，
// 已在記憶體的連線保留它的 secret 欄位（剛輸入過的密碼等——磁碟本來就不存）。
import { useEffect, useRef } from "react";
import { api } from "./api";
import { mergeSavedConnections } from "./connFileSync";
import { useStore } from "./store";

export function useConnFileSync(enabled: boolean) {
  const lastSavedJson = useRef("");
  useEffect(() => {
    if (!enabled) return;
    let busy = false;
    const onFocus = async () => {
      if (busy) return;
      busy = true;
      try {
        const [saved, groups] = await Promise.all([api.listSavedConnections(), api.listConnectionGroups()]);
        const s = useStore.getState();
        const json = JSON.stringify(saved);
        if (json !== lastSavedJson.current) {
          lastSavedJson.current = json;
          const next = mergeSavedConnections(s.connections, saved);
          if (JSON.stringify(next) !== JSON.stringify(s.connections)) s.setConnections(next);
        }
        if (JSON.stringify(groups) !== JSON.stringify(s.connGroups)) s.setConnGroups(groups);
      } catch {
        // 讀不到就維持現狀：這只是同步外部變更，不該打斷使用者。
      } finally {
        busy = false;
      }
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled]);
}
