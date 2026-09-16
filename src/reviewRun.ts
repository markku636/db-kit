// 審查並執行：純函式（偏好設定、AI 結論解析、摘要統計、路徑組合）。UI 在 ReviewRunDialog.tsx，
// 核心（分析 / 擷取 / 回滾 / 報告）在後端 src-tauri/src/review_run/，GUI 與 `dbk run` 共用。
import type { DbKind, ReviewPrepared, ReviewRollbackLevel, ReviewStatement } from "./api";

/** 支援的連線種類：六種內建 SQL 引擎（external gateway 的結構 API 不可靠，後端也不收）。 */
export const REVIEW_RUN_KINDS: DbKind[] = ["mysql", "mariadb", "postgres", "sqlite", "mssql", "oracle"];

export function supportsReviewRun(kind: DbKind | null | undefined): boolean {
  return !!kind && REVIEW_RUN_KINDS.includes(kind);
}

// ---- 偏好設定（每台機器各自記住；輸出目錄是本機路徑，不該跟著連線設定走）----

export interface ReviewRunPrefs {
  /** 輸出目錄（每次執行在底下建立子目錄）。空字串 = 尚未設定。 */
  outDir: string;
  /** 每句前像的擷取上限。 */
  maxRows: number;
  /** 附給 AI 的前像樣本列數（0 = 不送資料給 AI）。 */
  sampleRows: number;
  /** 開啟對話框後自動送出 AI 審查。 */
  autoReview: boolean;
}

export const REVIEW_RUN_PREFS_KEY = "db-kit:reviewRun:prefs";
export const DEFAULT_REVIEW_RUN_PREFS: ReviewRunPrefs = { outDir: "", maxRows: 10_000, sampleRows: 0, autoReview: true };
export const MAX_CAPTURE_ROWS = 1_000_000;
export const MAX_SAMPLE_ROWS = 20;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 寬鬆解析：壞掉的欄位各自退回預設，不讓一個錯值毀掉整份設定。 */
export function parseReviewRunPrefs(raw: string | null): ReviewRunPrefs {
  if (!raw) return { ...DEFAULT_REVIEW_RUN_PREFS };
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_REVIEW_RUN_PREFS };
    o = parsed as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_REVIEW_RUN_PREFS };
  }
  return {
    outDir: typeof o.outDir === "string" ? o.outDir : "",
    maxRows: clampInt(o.maxRows, 1, MAX_CAPTURE_ROWS, DEFAULT_REVIEW_RUN_PREFS.maxRows),
    sampleRows: clampInt(o.sampleRows, 0, MAX_SAMPLE_ROWS, 0),
    autoReview: typeof o.autoReview === "boolean" ? o.autoReview : true,
  };
}

export function loadReviewRunPrefs(): ReviewRunPrefs {
  try {
    return parseReviewRunPrefs(localStorage.getItem(REVIEW_RUN_PREFS_KEY));
  } catch {
    return { ...DEFAULT_REVIEW_RUN_PREFS };
  }
}

export function saveReviewRunPrefs(p: ReviewRunPrefs): void {
  try {
    localStorage.setItem(REVIEW_RUN_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 私密視窗 / 儲存空間滿：本次仍可用，只是下次要重選 */
  }
}

// ---- AI 審查結論 ----

export type Verdict = "go" | "caution" | "stop";

// 與後端 report::parse_verdict 同一套規則：第一個非空行，容許 Markdown 粗體 / 標題記號與全形冒號。
const VERDICT_RE = /^[*#\s]*VERDICT\s*[:：]?\s*\**\s*(GO|CAUTION|STOP)\b/i;

export function parseVerdict(text: string): Verdict | null {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const m = VERDICT_RE.exec(first);
  return m ? (m[1].toLowerCase() as Verdict) : null;
}

/** 顯示用：去掉開頭的 VERDICT 行（結論另外以徽章呈現）。 */
export function stripVerdictLine(text: string): string {
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => l.trim().length > 0);
  if (idx < 0 || !VERDICT_RE.test(lines[idx].trim())) return text;
  return lines.slice(idx + 1).join("\n").replace(/^\n+/, "");
}

// ---- 摘要 ----

export interface ReviewSummary {
  writes: number;
  full: number;
  partial: number;
  none: number;
  destructive: number;
  /** 寫入語句估算列數合計（有上限估算時為上限）。 */
  estimatedRows: number;
  /** 至少一句只有上限估算（JOIN fan-out）。 */
  estimateUpperBound: boolean;
}

export function summarizeStatements(stmts: ReviewStatement[]): ReviewSummary {
  const s: ReviewSummary = { writes: 0, full: 0, partial: 0, none: 0, destructive: 0, estimatedRows: 0, estimateUpperBound: false };
  for (const st of stmts) {
    if (!st.write) continue;
    s.writes++;
    if (st.rollback === "full") s.full++;
    else if (st.rollback === "partial") s.partial++;
    else if (st.rollback === "none") s.none++;
    if (st.destructive) s.destructive++;
    if (st.estimated_rows != null) {
      s.estimatedRows += st.estimated_rows;
      if (!st.estimate_exact) s.estimateUpperBound = true;
    }
  }
  return s;
}

/** 回滾不完整（部分 / 無）的寫入語句數。 */
export function incompleteCount(stmts: ReviewStatement[]): number {
  return stmts.filter((s) => s.write && (s.rollback === "partial" || s.rollback === "none")).length;
}

export type ExecuteBlockReason =
  | "loading"
  | "running"
  | "blocked"
  | "noWrites"
  | "readonly"
  | "noOutDir"
  | "aiRunning"
  | "needsAck"
  | "needsProdAck";

/**
 * 「執行」鈕為什麼不能按（null = 可以）。依序檢查，回傳第一個理由——按鈕旁只顯示一句話，
 * 使用者先處理那一件就好。
 */
export function executeBlockReason(input: {
  loading: boolean;
  running: boolean;
  prepared: ReviewPrepared["prepared"] | null;
  readonly: boolean;
  outDir: string;
  aiRunning: boolean;
  ackIncomplete: boolean;
  ackProd: boolean;
}): ExecuteBlockReason | null {
  if (input.running) return "running";
  if (input.loading || !input.prepared) return "loading";
  if (input.prepared.blockers.length > 0) return "blocked";
  if (!input.prepared.has_writes) return "noWrites";
  if (input.readonly) return "readonly";
  if (!input.outDir.trim()) return "noOutDir";
  if (input.aiRunning) return "aiRunning";
  if (input.prepared.needs_ack && !input.ackIncomplete) return "needsAck";
  if (input.prepared.prod && !input.ackProd) return "needsProdAck";
  return null;
}

/** 「只產生備份」的限制比執行少：唯讀連線也可以（只送唯讀查詢）。 */
export function backupBlockReason(input: {
  loading: boolean;
  running: boolean;
  prepared: ReviewPrepared["prepared"] | null;
  outDir: string;
  aiRunning: boolean;
}): ExecuteBlockReason | null {
  if (input.running) return "running";
  if (input.loading || !input.prepared) return "loading";
  if (input.prepared.blockers.length > 0) return "blocked";
  if (!input.outDir.trim()) return "noOutDir";
  if (input.aiRunning) return "aiRunning";
  return null;
}

export const ROLLBACK_LEVEL_ORDER: ReviewRollbackLevel[] = ["not_needed", "full", "partial", "none"];

/** 在輸出目錄後面接檔名：沿用目錄本身的分隔符（Windows 反斜線 / 其餘斜線）。 */
export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** 語句類型的顯示字：`create_table` → `CREATE TABLE`。 */
export function opLabel(op: string): string {
  return op.replace(/_/g, " ").toUpperCase();
}
