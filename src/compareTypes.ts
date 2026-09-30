// 檔案 / 資料夾 / 二進位比對的型別（後端 src-tauri/src/filecmp/ 與 commands/filecmp.rs）。

/** 後端 command 的一邊：本機路徑，或一條已開的檔案工作階段（SFTP / FTP）。 */
export type SideSpec =
  | { kind: "local"; path: string }
  | { kind: "remote"; sftp_id: string; path: string };

export interface CmpText {
  text: string;
  truncated: boolean;
  size: number;
  mtime: number | null;
  lossy: boolean;
  binary: boolean;
}

export interface CmpStat {
  exists: boolean;
  is_dir: boolean;
  size: number;
  mtime: number | null;
}

export interface CmpFetched {
  local: string;
  size: number;
  mtime: number | null;
}

export type FolderCriteria = "size_mtime" | "size" | "content";

export interface FolderOpts {
  excludes: string[];
  criteria: FolderCriteria;
  tolerance_secs: number;
  ignore_hour_offset: boolean;
  case_insensitive: boolean;
}

export type RowStatus = "same" | "diff" | "left_only" | "right_only" | "type_mismatch" | "unchecked";

export interface RowMeta {
  rel: string;
  name: string;
  is_dir: boolean;
  size: number;
  mtime: number | null;
}

export interface FolderRow {
  key: string;
  left: RowMeta | null;
  right: RowMeta | null;
  status: RowStatus;
  newer: "left" | "right" | null;
}

export interface FolderDiff {
  rows: FolderRow[];
  left_count: number;
  right_count: number;
  skipped: number;
  errors: ["left" | "right", string, string][];
}

export interface ContentPair { key: string; left: string; right: string }
export interface ContentResult { key: string; equal: boolean | null; error: string | null }

export type SyncOpKind = "copy_lr" | "copy_rl" | "delete_left" | "delete_right";
export interface SyncOp { kind: SyncOpKind; src: string; dst?: string | null; is_dir: boolean }

export interface SyncReport {
  copied: number;
  deleted: number;
  failed: [string, string][];
  mtime_not_kept: number;
}

export interface BinDiff {
  size_a: number;
  size_b: number;
  /** [offset, length] */
  ranges: [number, number][];
  diff_bytes: number;
  truncated: boolean;
}

/** 後端事件 `fcmp-progress`。 */
export interface FcmpProgress {
  job_id: string;
  phase: "scan" | "content" | "sync";
  done: number;
  total: number | null;
  items: [number, number] | null;
  current: string | null;
  left: number | null;
  right: number | null;
}
