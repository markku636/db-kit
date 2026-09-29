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
  /** 批次工作（多選 / 資料夾）：完成時把後端的略過摘要接在提示後面。 */
  batch?: boolean;
  /** 結束（完成 / 失敗 / 取消）後的回呼：上傳即使失敗或取消，也可能已經寫了一部分，清單都要重列。 */
  onDone?: () => void;
  /**
   * 斷點續傳：用同一組來源 / 目的地、續傳模式重新開始，回新的 transfer_id。
   * 吃的是「現在」的 sftpId：斷線重連後舊的 sftp 通道已經不在了。
   */
  retry?: (sftpId: string) => Promise<string>;
}

type JobSpec = Pick<SftpJob, "id" | "name" | "kind" | "tabKey" | "onDone" | "batch" | "retry">;

interface SshTransfersStore {
  jobs: Record<string, SftpJob>;
  track: (job: JobSpec) => void;
  apply: (p: SftpProgress) => void;
  dismiss: (id: string) => void;
  cancel: (id: string) => Promise<void>;
  /** 續傳一個失敗的工作（見 `SftpJob.retry`）：舊的那列換成新的。 */
  resume: (id: string, sftpId: string) => Promise<void>;
}

/**
 * 還沒 track 就先到的進度。invoke 的回應與事件誰先到沒有保證：很快就結束的工作（續傳時整個
 * 已經傳完而略過）可能在前端拿到 transfer_id 之前就發完「完成」，沒接住的話那一列會永遠停在傳輸中。
 */
const early = new Map<string, SftpProgress>();
const EARLY_MAX = 64;

export const useSshTransfers = create<SshTransfersStore>((set, get) => ({
  jobs: {},
  track: (job) => {
    set((s) => ({
      jobs: { ...s.jobs, [job.id]: { ...job, done: 0, total: null, state: "running", message: null, startedAt: Date.now() } },
    }));
    const pending = early.get(job.id);
    if (pending) {
      early.delete(job.id);
      get().apply(pending);
    }
  },
  apply: (p) => {
    const cur = get().jobs[p.transfer_id];
    if (!cur) {
      early.set(p.transfer_id, p);
      if (early.size > EARLY_MAX) early.delete(early.keys().next().value!);
      return;
    }
    const next: SftpJob = { ...cur, done: p.done, total: p.total, state: p.state, message: p.message ?? null };
    set((s) => ({ jobs: { ...s.jobs, [p.transfer_id]: next } }));
    if (p.state === "done") {
      const msg = cur.kind === "upload" ? t("已上傳 {name}", { name: cur.name }) : t("已下載 {name}", { name: cur.name });
      // 批次的完成訊息是「略過了哪些」；單檔的是本機路徑，不必顯示。
      toast.success(cur.batch && p.message ? t("{msg}（{detail}）", { msg, detail: p.message }) : msg);
      cur.onDone?.();
      // 完成的項目留 3 秒讓進度條走到底再消失。
      setTimeout(() => get().dismiss(p.transfer_id), 3000);
    } else if (p.state === "error") {
      toast.error(cur.retry
        ? t("傳輸失敗：{name}：{msg}。可按「續傳」從中斷的地方接著傳", { name: cur.name, msg: p.message ?? "" })
        : t("傳輸失敗：{name}：{msg}", { name: cur.name, msg: p.message ?? "" }));
      cur.onDone?.();
    } else if (p.state === "cancelled") {
      toast.info(t("已取消傳輸 {name}", { name: cur.name }));
      cur.onDone?.();
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
  resume: async (id, sftpId) => {
    const cur = get().jobs[id];
    if (!cur?.retry || cur.state !== "error") return;
    try {
      const nid = await cur.retry(sftpId);
      get().dismiss(id);
      get().track({ id: nid, name: cur.name, kind: cur.kind, tabKey: cur.tabKey, batch: cur.batch, onDone: cur.onDone, retry: cur.retry });
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      toast.error(t("無法續傳 {name}：{msg}", { name: cur.name, msg }));
    }
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
