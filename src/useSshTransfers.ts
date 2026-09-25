// SFTP 上下傳的進度追蹤：後端每 100ms 發一次 ssh-sftp-progress，全域只掛一個監聽、依 transfer_id 分派。
// 同時可能有多個檔案在傳（不同分頁 / 同分頁多選），所以是 map 而不是單一進度。
import { create } from "zustand";
import { api, onSftpProgress } from "./api";
import type { SftpProgress } from "./sshTypes";
import { t } from "./i18n";
import { toast } from "./ui";

export interface SftpJob {
  id: string;
  name: string;
  kind: "upload" | "download";
  tabKey: string;
  done: number;
  total: number | null;
  state: SftpProgress["state"];
  message: string | null;
  startedAt: number;
  /** 完成後的回呼（上傳完成 → 重新整理清單）。 */
  onDone?: () => void;
}

interface SshTransfersStore {
  jobs: Record<string, SftpJob>;
  track: (job: Pick<SftpJob, "id" | "name" | "kind" | "tabKey" | "onDone">) => void;
  apply: (p: SftpProgress) => void;
  dismiss: (id: string) => void;
  cancel: (id: string) => Promise<void>;
}

export const useSshTransfers = create<SshTransfersStore>((set, get) => ({
  jobs: {},
  track: (job) =>
    set((s) => ({
      jobs: { ...s.jobs, [job.id]: { ...job, done: 0, total: null, state: "running", message: null, startedAt: Date.now() } },
    })),
  apply: (p) => {
    const cur = get().jobs[p.transfer_id];
    if (!cur) return;
    const next: SftpJob = { ...cur, done: p.done, total: p.total, state: p.state, message: p.message ?? null };
    set((s) => ({ jobs: { ...s.jobs, [p.transfer_id]: next } }));
    if (p.state === "done") {
      toast.success(cur.kind === "upload" ? t("已上傳 {name}", { name: cur.name }) : t("已下載 {name}", { name: cur.name }));
      cur.onDone?.();
      // 完成的項目留 3 秒讓進度條走到底再消失。
      setTimeout(() => get().dismiss(p.transfer_id), 3000);
    } else if (p.state === "error") {
      toast.error(t("傳輸失敗：{name}：{msg}", { name: cur.name, msg: p.message ?? "" }));
    } else if (p.state === "cancelled") {
      toast.info(t("已取消傳輸 {name}", { name: cur.name }));
      setTimeout(() => get().dismiss(p.transfer_id), 1500);
    }
  },
  dismiss: (id) =>
    set((s) => {
      const jobs = { ...s.jobs };
      delete jobs[id];
      return { jobs };
    }),
  cancel: async (id) => {
    await api.sshSftpCancel(id).catch(() => undefined);
  },
}));

// 全域監聽只掛一次（第一個 SFTP 面板掛載時）；app 存活期間不解除，成本是一個 listener。
let listening: Promise<void> | null = null;
export function ensureSftpProgressListener(): Promise<void> {
  if (!listening) {
    listening = onSftpProgress((p) => useSshTransfers.getState().apply(p)).then(() => undefined).catch(() => { listening = null; });
  }
  return listening;
}
