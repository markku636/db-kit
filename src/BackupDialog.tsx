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
import { Modal, Button, Segmented, Input } from "./ui/index";
import { DatabaseBackup } from "lucide-react";
import { t, useT } from "./i18n";

interface Props {
  conn: ConnectionConfig;
  database: string | null;
  onClose: () => void;
}

type Tab = "manual" | "schedules" | "history";

export default function BackupDialog({ conn, database, onClose }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("manual");

  return (
    <Modal
      onClose={onClose}
      title={<>{t("備份 / 還原")}<span className="text-xs text-fg/40 ml-1">· {conn.name}</span></>}
      icon={DatabaseBackup}
      size="lg"
      zClass="z-50"
      className="!w-[640px]"
      bodyClassName="p-0 flex flex-col min-h-0 overflow-hidden"
      footer={<Button variant="secondary" onClick={onClose}>{t("關閉")}</Button>}
    >
      {/* 分頁 */}
      <div className="flex border-b border-fg/10 text-sm shrink-0">
        {([["manual", t("手動")], ["schedules", t("排程")], ["history", t("歷史")]] as [Tab, string][]).map(
          ([t, label]) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={`px-4 py-2 border-b-2 -mb-px ${
                tab === t ? "border-accent text-accent" : "border-transparent text-fg/50 hover:text-fg/80"
              }`}>
              {label}
            </button>
          )
        )}
      </div>

      <div className="p-5 overflow-y-auto flex-1 min-h-0">
        {tab === "manual" && <ManualTab conn={conn} database={database} />}
        {tab === "schedules" && <SchedulesTab conn={conn} />}
        {tab === "history" && <HistoryTab conn={conn} />}
      </div>
    </Modal>
  );
}

// ---- 手動備份 / 還原（原有流程） ----
function ManualTab({ conn, database }: { conn: ConnectionConfig; database: string | null }) {
  const t = useT();
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
      setMsg({ ok: false, text: t("請填寫檔案路徑") });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      if (mode === "backup") {
        const res = await api.backupRun(conn, db, path);
        setMsg({ ok: true, text: t("備份完成（{method}）：{bytes} → {path}", { method: res.method, bytes: formatBytes(res.bytes), path: res.path }) });
      } else {
        await api.backupRestore(conn, db, path);
        setMsg({ ok: true, text: t("還原完成") });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? t("操作失敗") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <Segmented
        full
        ariaLabel={t("備份或還原")}
        value={mode}
        onChange={(m) => { setMode(m); setMsg(null); }}
        options={[
          { value: "backup", label: t("備份") },
          { value: "restore", label: t("還原") },
        ]}
      />

      {!fileBased && (
        <div className={`text-xs rounded px-2 py-1.5 ${
          cliOk === null ? "bg-fg/5 text-fg/40"
            : cliOk ? "bg-green-500/10 text-green-400"
            : "bg-amber-500/10 text-amber-400"
        }`}>
          {cliOk === null ? t("偵測工具中…") : cliOk ? t("已偵測到 {tool}", { tool: t(hint.tool) }) : t("找不到 {tool}，請先安裝再使用", { tool: t(hint.tool) })}
        </div>
      )}

      {!fileBased && conn.kind !== "redis" && (
        <Field label={t("資料庫名稱")}>
          <Input inputSize="md" className="mono" value={db} onChange={(e) => setDb(e.target.value)}
            placeholder={t("要備份 / 還原的資料庫")} />
        </Field>
      )}

      <Field label={mode === "backup" ? t("輸出檔案路徑") : t("備份檔路徑")}>
        <div className="flex gap-2">
          <Input inputSize="md" className="mono" value={path} onChange={(e) => setPath(e.target.value)}
            placeholder={t("例如 C:\\backups\\backup{ext}", { ext: hint.ext })} />
          <button type="button" title={t("瀏覽…")}
            onClick={async () => {
              const ext = hint.ext.replace(/^\./, "");
              const filters = ext ? [{ name: hint.tool, extensions: [ext] }] : undefined;
              const p = mode === "backup"
                ? await pickSaveFile(`${db || "backup"}${hint.ext}`, filters)
                : await pickOpenFile(filters);
              if (p) setPath(p);
            }}
            className="shrink-0 px-3 rounded border border-fg/15 hover:bg-fg/5 text-sm mono">
            {t("瀏覽…")}
          </button>
        </div>
      </Field>

      {conn.kind === "redis" && mode === "restore" && (
        <div className="text-xs text-amber-400/90 bg-amber-400/10 rounded px-2 py-1.5">
          {t("Redis 自動還原暫未支援，請以 redis-cli 手動匯入 RDB。")}
        </div>
      )}

      {msg && (
        <div className={`text-sm break-all ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</div>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={run} disabled={busy || (!fileBased && cliOk === false)}
          title={!fileBased && cliOk === false ? t("找不到 {tool}，請先安裝再使用", { tool: t(hint.tool) }) : undefined}
          className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50">
          {busy ? t("執行中…") : mode === "backup" ? t("開始備份") : t("開始還原")}
        </button>
      </div>
    </div>
  );
}

// ---- 排程管理 ----
function SchedulesTab({ conn }: { conn: ConnectionConfig }) {
  const t = useT();
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
      .catch((e) => setMsg(e?.message ?? t("讀取排程失敗")));

  useEffect(() => { reload(); }, [conn.id]);

  const buildCadence = (): Cadence => {
    if (cType === "every_minutes") return { type: "every_minutes", minutes: Math.max(1, minutes) };
    if (cType === "every_hours") return { type: "every_hours", hours: Math.max(1, hours) };
    return { type: "daily_at", hour, minute };
  };

  const add = async () => {
    if (!dir.trim()) { setMsg(t("請填寫備份目錄")); return; }
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
      setMsg(e?.message ?? t("儲存排程失敗"));
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); setMsg(null); reload(); }
    catch (e: any) { setMsg(e?.message ?? t("操作失敗")); }
  };

  return (
    <div className="space-y-4">
      <div className="text-xs text-fg/40">
        {t("排程僅在 db-kit 開啟時執行；關閉期間到期者不會補跑。")}
      </div>

      {/* 既有排程 */}
      <div className="space-y-2">
        {list.length === 0 && <div className="text-sm text-fg/30">{t("尚無排程。")}</div>}
        {list.map((s) => (
          <div key={s.id} className="border border-fg/10 rounded px-3 py-2 text-sm flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="truncate">
                <span className="text-fg/80">{s.database || t("（整庫）")}</span>
                <span className="text-fg/40"> · {cadenceText(s.cadence)}</span>
              </div>
              <div className="text-xs text-fg/40 truncate" title={s.target_dir}>
                → {s.target_dir}
                {s.next_run && t(" · 下次 {next_run}", { next_run: fmtTime(s.next_run) })}
                {s.retention_count ? t(" · 保留 {retention_count} 份", { retention_count: s.retention_count }) : ""}
              </div>
            </div>
            <button type="button" title={t("啟用 / 停用")}
              onClick={() => act(() => api.toggleSchedule(s.id, !s.enabled))}
              className={`px-2 py-0.5 rounded text-xs border ${
                s.enabled ? "border-green-500/50 text-green-400" : "border-fg/15 text-fg/40"
              }`}>
              {s.enabled ? t("啟用中") : t("已停用")}
            </button>
            <button type="button" onClick={() => act(() => api.runScheduleNow(s.id))}
              className="px-2 py-0.5 rounded text-xs border border-fg/15 hover:bg-fg/5">
              {t("立即執行")}
            </button>
            <button type="button" onClick={() => act(() => api.removeSchedule(s.id))}
              className="px-2 py-0.5 rounded text-xs border border-red-500/40 text-red-400 hover:bg-red-500/10">
              {t("刪除")}
            </button>
          </div>
        ))}
      </div>

      {/* 新增排程 */}
      <div className="border-t border-fg/10 pt-3 space-y-3">
        <div className="text-xs text-fg/50">{t("新增排程")}</div>
        <div className="flex gap-3">
          {conn.kind !== "redis" && (
            <Field label={t("資料庫名稱")} className="flex-1">
              <Input inputSize="md" className="mono" value={db} onChange={(e) => setDb(e.target.value)} placeholder={t("留空為整庫")} />
            </Field>
          )}
          <Field label={t("備份目錄")} className="flex-1">
            <div className="flex gap-2">
              <Input inputSize="md" className="mono" value={dir} onChange={(e) => setDir(e.target.value)}
                placeholder={t("例如 C:\\\\backups")} />
              <button type="button" title={t("選擇目錄…")}
                onClick={async () => { const d = await pickDirectory(); if (d) setDir(d); }}
                className="shrink-0 px-3 rounded border border-fg/15 hover:bg-fg/5 text-sm mono">
                {t("瀏覽…")}
              </button>
            </div>
          </Field>
        </div>

        <Segmented
          full
          ariaLabel={t("排程頻率")}
          value={cType}
          onChange={setCType}
          options={[
            { value: "every_minutes", label: t("每 N 分") },
            { value: "every_hours", label: t("每 N 時") },
            { value: "daily_at", label: t("每天定時") },
          ]}
        />

        <div className="flex gap-3 items-end">
          {cType === "every_minutes" && (
            <Field label={t("間隔（分鐘）")} className="w-32">
              <Input inputSize="md" className="mono" type="number" min={1} value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))} />
            </Field>
          )}
          {cType === "every_hours" && (
            <Field label={t("間隔（小時）")} className="w-32">
              <Input inputSize="md" className="mono" type="number" min={1} value={hours}
                onChange={(e) => setHours(Number(e.target.value))} />
            </Field>
          )}
          {cType === "daily_at" && (
            <>
              <Field label={t("時")} className="w-20">
                <Input inputSize="md" className="mono" type="number" min={0} max={23} value={hour}
                  onChange={(e) => setHour(Number(e.target.value))} />
              </Field>
              <Field label={t("分")} className="w-20">
                <Input inputSize="md" className="mono" type="number" min={0} max={59} value={minute}
                  onChange={(e) => setMinute(Number(e.target.value))} />
              </Field>
            </>
          )}
          <Field label={t("保留份數（選填）")} className="w-36">
            <Input inputSize="md" className="mono" type="number" min={1} value={retention}
              onChange={(e) => setRetention(e.target.value)} placeholder={t("全部保留")} />
          </Field>
          <button type="button" onClick={add}
            className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90 mb-px">
            {t("新增")}
          </button>
        </div>
      </div>

      {msg && <div className="text-sm text-red-400 break-all">{msg}</div>}
    </div>
  );
}

// ---- 備份歷史 ----
function HistoryTab({ conn }: { conn: ConnectionConfig }) {
  const t = useT();
  const [list, setList] = useState<BackupHistoryEntry[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () =>
    api.listBackupHistory()
      .then((all) => setList(all.filter((e) => e.connection_id === conn.id)))
      .catch((e) => setMsg({ ok: false, text: e?.message ?? t("讀取歷史失敗") }));

  useEffect(() => { reload(); }, [conn.id]);

  const restore = async (entry: BackupHistoryEntry) => {
    if (busy) return;
    const ok = await uiConfirm(t("從此備份還原到「{name}」？此動作會覆寫現有資料。", { name: entry.database || conn.name }), {
      title: t("還原備份"), danger: true, confirmText: t("還原"),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.restoreFromHistory(entry.id);
      setMsg({ ok: true, text: t("還原完成") });
    } catch (e: any) {
      setMsg({ ok: false, text: e?.message ?? t("還原失敗") });
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy) return;
    const ok = await uiConfirm(t("清空備份歷史紀錄？（不會刪除實際備份檔）"), {
      title: t("清空歷史"), danger: true, confirmText: t("清空"),
    });
    if (!ok) return;
    setBusy(true);
    try { await api.clearHistory(); reload(); }
    catch (e: any) { setMsg({ ok: false, text: e?.message ?? t("清空失敗") }); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {msg && (
        <div className={`text-sm break-all ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</div>
      )}
      {list.length === 0 ? (
        <div className="text-sm text-fg/30">{t("尚無備份歷史。")}</div>
      ) : (
        <div className="space-y-1.5">
          {list.map((e) => (
            <div key={e.id} className="border border-fg/10 rounded px-3 py-2 text-sm flex items-center gap-3">
              <span className={`w-2 h-2 rounded-full shrink-0 ${e.status === "ok" ? "bg-green-500" : "bg-red-500"}`} />
              <div className="flex-1 min-w-0">
                <div className="truncate">
                  <span className="text-fg/80">{e.database || t("（整庫）")}</span>
                  <span className="text-fg/40"> · {fmtTime(e.finished_at)}</span>
                </div>
                <div className="text-xs text-fg/40 truncate" title={e.error ?? e.path}>
                  {e.status === "ok"
                    ? `${formatBytes(e.bytes)} · ${e.method} · ${e.path}`
                    : t("失敗：{error}", { error: e.error ?? t("未知錯誤") })}
                </div>
              </div>
              {e.status === "ok" && e.kind !== "redis" && (
                <button type="button" onClick={() => restore(e)}
                  className="px-2 py-0.5 rounded text-xs border border-fg/15 hover:bg-fg/5 shrink-0">
                  {t("還原")}
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
            {t("清空歷史")}
          </button>
        </div>
      )}
    </div>
  );
}

const TOOL_HINT: Record<string, { tool: string; ext: string }> = {
  mysql: { tool: "mysqldump / mysql", ext: ".sql" },
  mariadb: { tool: "mysqldump / mysql（MariaDB 相容）", ext: ".sql" },
  postgres: { tool: "pg_dump / psql", ext: ".sql" },
  mongo: { tool: "mongodump / mongorestore", ext: ".archive" },
  redis: { tool: "redis-cli", ext: ".rdb" },
  sqlite: { tool: "（檔案複製，無需工具）", ext: ".db" },
};


function Field({ label, children, className = "" }: {
  label: string; children: React.ReactNode; className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs text-fg/50 mb-1 block">{label}</span>
      {children}
    </label>
  );
}

function cadenceText(c: Cadence): string {
  switch (c.type) {
    case "every_minutes": return t("每 {minutes} 分鐘", { minutes: c.minutes });
    case "every_hours": return t("每 {hours} 小時", { hours: c.hours });
    case "daily_at": return t("每天 {hour}:{minute}", { hour: pad(c.hour), minute: pad(c.minute) });
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
