// 遠端桌面錄影：用 MediaRecorder 錄畫面 <canvas>（WebM），每秒交一段給後端依序寫檔（rd::recording）。
// 錄的是這端看到的畫面（所有螢幕模式就是拼起來那張），不必等對方重送、也不用另外解碼。
import { api } from "./api";

/** 這個 WebView 的 MediaRecorder 能錄的格式（先 VP9，再 VP8）。 */
export function pickRecordingMime(isSupported: (m: string) => boolean): string | null {
  for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) {
    if (isSupported(m)) return m;
  }
  return null;
}

export interface RdRecording {
  path: string;
  /** 停止並關檔；回傳檔案路徑（什麼都沒錄到 → null）。 */
  stop(): Promise<string | null>;
}

/**
 * 開始錄 `canvas`。`name` 是主機名稱（只用來取檔名）。寫檔失敗 → `onError`（錄影會自己停）。
 * 不支援 MediaRecorder / captureStream → 丟錯（呼叫端提示）。
 */
export async function startRecording(canvas: HTMLCanvasElement, name: string, onError: (e: unknown) => void): Promise<RdRecording> {
  if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") throw new Error("MediaRecorder");
  const mimeType = pickRecordingMime((m) => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error("MediaRecorder");
  const { id, path } = await api.rdRecordStart(name);
  const stream = canvas.captureStream(30);
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop());
    await api.rdRecordStop(id).catch(() => null);
    throw e;
  }
  // 一段一段排隊寫，順序不能亂（WebM 是接著寫的）。
  let queue: Promise<void> = Promise.resolve();
  let failed = false;
  rec.ondataavailable = (e) => {
    if (!e.data.size || failed) return;
    const blob = e.data;
    queue = queue.then(async () => {
      if (failed) return;
      try {
        await api.rdRecordWrite(id, new Uint8Array(await blob.arrayBuffer()));
      } catch (err) {
        failed = true;
        onError(err);
        if (rec.state !== "inactive") rec.stop();
      }
    });
  };
  rec.start(1000);
  let stopped: Promise<string | null> | null = null;
  return {
    path,
    stop() {
      stopped ??= (async () => {
        if (rec.state !== "inactive") {
          await new Promise<void>((resolve) => {
            rec.addEventListener("stop", () => resolve(), { once: true });
            rec.stop();
          });
        }
        stream.getTracks().forEach((t) => t.stop());
        await queue;
        return api.rdRecordStop(id);
      })();
      return stopped;
    },
  };
}
