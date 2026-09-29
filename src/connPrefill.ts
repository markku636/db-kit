// 「開一個預填好的新增連線對話框」的全域請求。發起端（側欄容器右鍵、容器分頁的動作列）
// 與對話框的擁有者（App 根元件）相隔很遠，用一個小 store 傳遞，免得一路 prop drilling。
import { create } from "zustand";
import type { ConnectionConfig } from "./api";

interface ConnPrefillStore {
  prefill: Partial<ConnectionConfig> | null;
  open: (p: Partial<ConnectionConfig>) => void;
  clear: () => void;
}

export const useConnPrefill = create<ConnPrefillStore>((set) => ({
  prefill: null,
  open: (p) => set({ prefill: p }),
  clear: () => set({ prefill: null }),
}));

/** 「把這個映像拉到 Docker」的請求（Registry / Harbor 的 tag → 已連線的 Docker）。Sidebar 擁有拉取對話框。 */
export interface DockerPullRequest {
  image: string;
  user?: string;
  /** 密碼留空時用這個 Registry / Harbor 連線存在 keychain 的密碼。 */
  credConn?: { id: string; name: string } | null;
}

export const useDockerPullRequest = create<{
  req: (DockerPullRequest & { nonce: number }) | null;
  open: (r: DockerPullRequest) => void;
  clear: () => void;
}>((set) => ({
  req: null,
  open: (r) => set((s) => ({ req: { ...r, nonce: (s.req?.nonce ?? 0) + 1 } })),
  clear: () => set({ req: null }),
}));
