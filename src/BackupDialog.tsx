import { useEffect, useState } from "react";
import {
  api,
  BackupHistoryEntry,
  BackupSchedule,
  Cadence,
  ConnectionConfig,
  KIND_META,
} from "./api";
import { pickDirectory, pickOpenFile, pickSaveFile, uiConfirm } from "./ui";

interface Props {
  conn: ConnectionConfig;
  database: string | null;
  onClose: () => void;
}

type Tab = "manual" | "schedules" | "history";

export default function BackupDialog({ conn, database, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("manual");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[#1a212b] w-[640px] max-h-[85vh] flex flex-col rounded-lg border border-white/10 shadow-2xl"
        onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-white/10 font-medium text-sm flex items-center gap-2">
          備份 / 還原
          <span className="text-xs text-white/40">· {conn.name}</span>
        </div>

        {/* 分頁 */}
        <div className="flex border-b border-white/10 text-sm">
          {([["manual", "手動"], ["schedules", "排程"], ["history", "歷史"]] as [Tab, string][]).map(
            ([t, label]) => (
              <button key={t} type="button" onClick={() => setTab(t)}
                className={`px-4 py-2 border-b-2 -mb-px ${
                  tab === t ? "border-blue-500 text-blue-300" : "border-transparent text-white/50 hover:text-white/80"
                }`}>
                {label}
              </button>
            )
          )}
        </div>

        <div className="p-5 overflow-y-auto">
          {tab === "manual" && <ManualTab conn={conn} database={database} />}
          {tab === "schedules" && <SchedulesTab conn={conn} />}
          {tab === "history" && <HistoryTab conn={conn} />}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end">
          <button onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-white/15 hover:bg-white/5">
            關閉
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- 手動備份 / 還原（原有流程） ----
function ManualTab({ conn, database }: { conn: ConnectionConfig; database: string | null }) {
  const [mode, setMode] = useState<"backup" | "restore">("backup");
  const [db, setDb] = useState(database ?? conn.database ?? "");
  const [path, setPath] = useState("");
  const [cliOk, setCliOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const fileBased = KIND_META[conn.kind].fileBased;
  const hint = TOOL_HINT[conn.kind];

  useEffect(() => {
    api.backupDetectCli(conn.kind).then(setCliOk).catch(() => setCliOk(false));
  }, [conn.kind]);

  const run = async () => {
    if (!path) {
      setMsg({ ok: false, text: "請填寫檔案路徑" });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "backup") {
        const res = await api.backupRun(conn, db, path);
        setMsg({ ok: true, text: `備份完成（${res.method}）：${formatBytes(res.bytes)} → ${res.path}` });
      } else {
        await api.backupRestore(conn, db, path);
        setMsg({ ok: true, text: "還原完成" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? "操作失敗" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["backup", "restore"] as const).map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); setMsg(null); }}
            className={`flex-1 py-1.5 rounded text-sm border ${
              mode === m ? "border-blue-500 bg-blue-500/15 text-blue-300" : "border-white/10 text-white/50"
            }`}>
            {m === "backup" ? "備份" : "還原"}
          </button>
        ))}
      </div>

      {!fileBased && (
        <div className={`text-xs rounded px-2 py-1.5 ${
          cliOk === null ? "bg-white/5 text-white/40"
            : cliOk ? "bg-green-500/10 text-green-400"
            : "bg-amber-500/10 text-amber-400"
        }`}>
          {cliOk === null ? "偵測工具中…" : cliOk ? `已偵測到 ${hint.tool}` : `找不到 ${hint.tool}，請先安裝再使用`}
        </div>
      )}

      {!fileBased && conn.kind !== "redis" && (
        <Field label="資料庫名稱">
          <input className={input} value={db} onChange={(e) => setDb(e.target.value)}
            placeholder="要備份 / 還原的資料庫" />
        </Field>
      )}

      <Field label={mode === "backup" ? "輸出檔案路徑" : "備份檔路徑"}>
        <div className="flex gap-2">
          <input className={input} value={path} onChange={(e) => setPath(e.target.value)}
            placeholder={`例如 C:\\backups\\backup${hint.ext}`} />
          <button type="button" title="瀏覽…"
            onClick={async () => {
              const ext = hint.ext.replace(/^\./, "");
              const filters = ext ? [{ name: hint.tool, extensions: [ext] }] : undefined;
              const p = mode === "backup"
                ? await pickSaveFile(`${db || "backup"}${hint.ext}`, filters)
                : await pickOpenFile(filters);
              if (p) setPath(p);
            }}
            className="shrink-0 px-3 rounded border border-white/15 hover:bg-white/5 text-sm mono">
            瀏覽…
          </button>
        </div>
      </Field>

      {conn.kind === "redis" && mode === "restore" && (
        <div className="text-xs text-amber-400/90 bg-amber-400/10 rounded px-2 py-1.5">
          Redis 自動還原暫未支援，請以 redis-cli 手動匯入 RDB。
        </div>
      )}

      {msg && (
        <div className={`text-sm break-all ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</div>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={run} disabled={busy}
          className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50">
          {busy ? "執行中…" : mode === "backup" ? "開始備份" : "開始還原"}
        </button>
      </div>
    </div>
  );
}

// ---- 排程管理 ----
function SchedulesTab({ conn }: { conn: ConnectionConfig }) {
  const [list, setList] = useState<BackupSchedule[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  // 新增表單
  const [db, setDb] = useState(conn.database ?? "");
  const [dir, setDir] = useState("");
  const [cType, setCType] = useState<Cadence["type"]>("every_hours");
  const [minutes, setMinutes] = useState(30);
  const [hours, setHours] = useState(24);
  const [hour, setHour] = useState(3);
  const [minute, setMinute] = useState(0);
  const [retention, setRetention] = useState("");

  const reload = () =>
    api.listSchedules()
      .then((all) => setList(all.filter((s) => s.connection_id === conn.id)))
      .catch((e) => setMsg(e?.message ?? "讀取排程失敗"));

  useEffect(() => { reload(); }, [conn.id]);

  const buildCadence = (): Cadence => {
    if (cType === "every_minutes") return { type: "every_minutes", minutes: Math.max(1, minutes) };
    if (cType === "every_hours") return { type: "every_hours", hours: Math.max(1, hours) };
    return { type: "daily_at", hour, minute };
  };

  const add = async () => {
    if (!dir.trim()) { setMsg("請填寫備份目錄"); return; }
    const sched: BackupSchedule = {
      id: crypto.randomUUID(),
      connection_id: conn.id,
      database: db,
      target_dir: dir,
      cadence: buildCadence(),
      enabled: true,
      retention_count: retention.trim() ? Math.max(1, Number(retention)) : null,
      created_at: new Date().toISOString(),
    };
    try {
      await api.saveSchedule(sched);
      setMsg(null);
      setDir("");
      reload();
    } catch (e: any) {
      setMsg(e?.message ?? "儲存排程失敗");
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setMsg(null); reload(); }
    catch (e: any) { setMsg(e?.message ?? "操作失敗"); }
  };

  return (
    <div className="space-y-4">
      <div className="text-xs text-white/40">
        排程僅在 at-kit 開啟時執行；關閉期間到期者不會補跑。
      </div>

      {/* 既有排程 */}
      <div className="space-y-2">
        {list.length === 0 && <div className="text-sm text-white/30">尚無排程。</div>}
        {list.map((s) => (
          <div key={s.id} className="border border-white/10 rounded px-3 py-2 text-sm flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="truncate">
                <span className="text-white/80">{s.database || "（整庫）"}</span>
                <span className="text-white/40"> · {cadenceText(s.cadence)}</span>
              </div>
              <div className="text-xs text-white/40 truncate" title={s.target_dir}>
                → {s.target_dir}
                {s.next_run && ` · 下次 ${fmtTime(s.next_run)}`}
                {s.retention_count ? ` · 保留 ${s.retention_count} 份` : ""}
              </div>
            </div>
            <button type="button" title="啟用 / 停用"
              onClick={() => act(() => api.toggleSchedule(s.id, !s.enabled))}
              className={`px-2 py-0.5 rounded text-xs border ${
                s.enabled ? "border-green-500/50 text-green-400" : "border-white/15 text-white/40"
              }`}>
              {s.enabled ? "啟用中" : "已停用"}
            </button>
            <button type="button" onClick={() => act(() => api.runScheduleNow(s.id))}
              className="px-2 py-0.5 rounded text-xs border border-white/15 hover:bg-white/5">
              立即執行
            </button>
            <button type="button" onClick={() => act(() => api.removeSchedule(s.id))}
              className="px-2 py-0.5 rounded text-xs border border-red-500/40 text-red-400 hover:bg-red-500/10">
              刪除
            </button>
          </div>
        ))}
      </div>

      {/* 新增排程 */}
      <div className="border-t border-white/10 pt-3 space-y-3">
        <div className="text-xs text-white/50">新增排程</div>
        <div className="flex gap-3">
          {conn.kind !== "redis" && (
            <Field label="資料庫名稱" className="flex-1">
              <input className={input} value={db} onChange={(e) => setDb(e.target.value)} placeholder="留空為整庫" />
            </Field>
          )}
          <Field label="備份目錄" className="flex-1">
            <div className="flex gap-2">
              <input className={input} value={dir} onChange={(e) => setDir(e.target.value)}
                placeholder="例如 C:\\backups" />
              <button type="button" title="選擇目錄…"
                onClick={async () => { const d = await pickDirectory(); if (d) setDir(d); }}
                className="shrink-0 px-3 rounded border border-white/15 hover:bg-white/5 text-sm mono">
                瀏覽…
              </button>
            </div>
          </Field>
        </div>

        <div className="flex gap-2">
          {(["every_minutes", "every_hours", "daily_at"] as Cadence["type"][]).map((t) => (
            <button key={t} type="button" onClick={() => setCType(t)}
              className={`flex-1 py-1 rounded text-xs border ${
                cType === t ? "border-blue-500 bg-blue-500/15 text-blue-300" : "border-white/10 text-white/50"
              }`}>
              {t === "every_minutes" ? "每 N 分" : t === "every_hours" ? "每 N 時" : "每天定時"}
            </button>
          ))}
        </div>

        <div className="flex gap-3 items-end">
          {cType === "every_minutes" && (
            <Field label="間隔（分鐘）" className="w-32">
              <input className={input} type="number" min={1} value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))} />
            </Field>
          )}
          {cType === "every_hours" && (
            <Field label="間隔（小時）" className="w-32">
              <input className={input} type="number" min={1} value={hours}
                onChange={(e) => setHours(Number(e.target.value))} />
            </Field>
          )}
          {cType === "daily_at" && (
            <>
              <Field label="時" className="w-20">
                <input className={input} type="number" min={0} max={23} value={hour}
                  onChange={(e) => setHour(Number(e.target.value))} />
              </Field>
              <Field label="分" className="w-20">
                <input className={input} type="number" min={0} max={59} value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))} />
              </Field>
            </>
          )}
          <Field label="保留份數（選填）" className="w-36">
            <input className={input} type="number" min={1} value={retention}
              onChange={(e) => setRetention(e.target.value)} placeholder="全部保留" />
          </Field>
          <button type="button" onClick={add}
            className="px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-500 mb-px">
            新增
          </button>
        </div>
      </div>

      {msg && <div className="text-sm text-red-400 break-all">{msg}</div>}
    </div>
  );
}

// ---- 備份歷史 ----
function HistoryTab({ conn }: { conn: ConnectionConfig }) {
  const [list, setList] = useState<BackupHistoryEntry[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api.listBackupHistory()
      .then((all) => setList(all.filter((e) => e.connection_id === conn.id)))
      .catch((e) => setMsg({ ok: false, text: e?.message ?? "讀取歷史失敗" }));

  useEffect(() => { reload(); }, [conn.id]);

  const restore = async (entry: BackupHistoryEntry) => {
    if (busy) return;
    const ok = await uiConfirm(`從此備份還原到「${entry.database || conn.name}」？此動作會覆寫現有資料。`, {
      title: "還原備份", danger: true, confirmText: "還原",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.restoreFromHistory(entry.id);
      setMsg({ ok: true, text: "還原完成" });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? "還原失敗" });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    const ok = await uiConfirm("清空備份歷史紀錄？（不會刪除實際備份檔）", {
      title: "清空歷史", danger: true, confirmText: "清空",
    });
    if (!ok) return;
    setBusy(true);
    try { await api.clearHistory(); reload(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message ?? "清空失敗" }); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {msg && (
        <div className={`text-sm break-all ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</div>
      )}
      {list.length === 0 ? (
        <div className="text-sm text-white/30">尚無備份歷史。</div>
      ) : (
        <div className="space-y-1.5">
          {list.map((e) => (
            <div key={e.id} className="border border-white/10 rounded px-3 py-2 text-sm flex items-center gap-3">
              <span className={`w-2 h-2 rounded-full shrink-0 ${e.status === "ok" ? "bg-green-500" : "bg-red-500"}`} />
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  <span className="text-white/80">{e.database || "（整庫）"}</span>
                  <span className="text-white/40"> · {fmtTime(e.finished_at)}</span>
                </div>
                <div className="text-xs text-white/40 truncate" title={e.error ?? e.path}>
                  {e.status === "ok"
                    ? `${formatBytes(e.bytes)} · ${e.method} · ${e.path}`
                    : `失敗：${e.error ?? "未知錯誤"}`}
                </div>
              </div>
              {e.status === "ok" && e.kind !== "redis" && (
                <button type="button" onClick={() => restore(e)}
                  className="px-2 py-0.5 rounded text-xs border border-white/15 hover:bg-white/5 shrink-0">
                  還原
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {list.length > 0 && (
        <div className="flex justify-end">
          <button type="button" onClick={clear}
            className="px-2 py-1 text-xs rounded border border-red-500/40 text-red-400 hover:bg-red-500/10">
            清空歷史
          </button>
        </div>
      )}
    </div>
  );
}

const TOOL_HINT: Record<string, { tool: string; ext: string }> = {
  mysql: { tool: "mysqldump / mysql", ext: ".sql" },
  postgres: { tool: "pg_dump / psql", ext: ".sql" },
  mongo: { tool: "mongodump / mongorestore", ext: ".archive" },
  redis: { tool: "redis-cli", ext: ".rdb" },
  sqlite: { tool: "（檔案複製，無需工具）", ext: ".db" },
};

const input =
  "w-full bg-black/30 border border-white/10 rounded px-2 py-1.5 text-sm outline-none focus:border-blue-500 mono";

function Field({ label, children, className = "" }: {
  label: string; children: React.ReactNode; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs text-white/50 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function cadenceText(c: Cadence): string {
  switch (c.type) {
    case "every_minutes": return `每 ${c.minutes} 分鐘`;
    case "every_hours": return `每 ${c.hours} 小時`;
    case "daily_at": return `每天 ${pad(c.hour)}:${pad(c.minute)}`;
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
