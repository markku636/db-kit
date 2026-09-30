// 比對分頁的啟動畫面：選模式（文字 / 資料夾 / 二進位）、左右兩邊的來源（本機 / 已存主機 / 貼上文字），
// 或從「已存的比對」「最近的比對」一鍵開始。資料庫的結構 / 資料比對不在這裡重做，連到既有的對話框。
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeftRight, Binary, Clock, Database, FileDiff, FolderOpen, FolderTree, HardDrive, Play, Save, Server,
  Trash2, Type,
} from "lucide-react";
import { useT } from "./i18n";
import { useStore } from "./store";
import { useSshSessions, sessionLabel } from "./sshSessions";
import { fileProtocolLabel, isFtpHost } from "./sshTypes";
import { Button, Icon, Input, Segmented, Select, Textarea } from "./ui/index";
import { pickDirectory, pickOpenFile, toast, uiConfirm, uiPrompt } from "./ui";
import { api } from "./api";
import {
  compareTitle, endpointLong, sameEndpoint, type CompareMode, type CompareTab, type Endpoint,
} from "./compareTabs";
import {
  DEFAULT_FOLDER, clearRecent, fromSessionSide, loadRecent, pushRecent, toSessionSide, useCompareSessions,
  type CompareSession, type RecentCompare,
} from "./compareSessions";

type Kind = Endpoint["side"];

interface Draft {
  kind: Kind;
  path: string;
  hostId: string;
  remotePath: string;
  text: string;
}

function draftOf(ep: Endpoint | null): Draft {
  const d: Draft = { kind: "local", path: "", hostId: "", remotePath: "", text: "" };
  if (!ep) return d;
  if (ep.side === "local") return { ...d, path: ep.path };
  if (ep.side === "paste") return { ...d, kind: "paste", text: ep.text };
  return { ...d, kind: "remote", hostId: ep.target.kind === "session" ? ep.target.id : "", remotePath: ep.path };
}

function EndpointPicker({ label, mode, draft, onChange, testId }: {
  label: string; mode: CompareMode; draft: Draft; onChange: (d: Draft) => void; testId: string;
}) {
  const t = useT();
  const hosts = useSshSessions((s) => s.sessions);
  const kinds: { value: Kind; label: string }[] = [
    { value: "local", label: t("本機") },
    ...(hosts.length ? [{ value: "remote" as Kind, label: t("遠端主機") }] : []),
    ...(mode === "text" ? [{ value: "paste" as Kind, label: t("貼上文字") }] : []),
  ];
  const kind = kinds.some((k) => k.value === draft.kind) ? draft.kind : "local";
  const browse = async () => {
    const p = mode === "folder" ? await pickDirectory() : await pickOpenFile();
    if (p) onChange({ ...draft, kind: "local", path: p });
  };
  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2 p-3 rounded border border-fg/10 bg-panel" data-testid={testId}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-fg/70">{label}</span>
        <div className="ml-auto">
          <Segmented<Kind> size="sm" value={kind} onChange={(k) => onChange({ ...draft, kind: k })} options={kinds} ariaLabel={label} />
        </div>
      </div>
      {kind === "local" && (
        <div className="flex gap-1.5">
          <Input className="flex-1 mono" value={draft.path} onChange={(e) => onChange({ ...draft, path: e.target.value })}
            placeholder={mode === "folder" ? t("資料夾路徑") : t("檔案路徑")} aria-label={t("路徑")} />
          <Button size="sm" icon={FolderOpen} onClick={() => void browse()} className="shrink-0 whitespace-nowrap">{t("瀏覽…")}</Button>
        </div>
      )}
      {kind === "remote" && (
        <div className="flex flex-col gap-1.5">
          <Select value={draft.hostId} onChange={(e) => onChange({ ...draft, hostId: e.target.value })} aria-label={t("主機")}>
            <option value="">{t("選擇主機…")}</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>{sessionLabel(h)}{isFtpHost(h) ? ` (${fileProtocolLabel(h)})` : ""}</option>
            ))}
          </Select>
          <Input className="mono" value={draft.remotePath} onChange={(e) => onChange({ ...draft, remotePath: e.target.value })}
            placeholder={t("遠端路徑（~ = 家目錄）")} aria-label={t("遠端路徑")} />
        </div>
      )}
      {kind === "paste" && (
        <Textarea className="mono text-xs min-h-[8rem]" value={draft.text} onChange={(e) => onChange({ ...draft, text: e.target.value })}
          placeholder={t("在這裡貼上要比對的文字")} aria-label={t("貼上文字")} />
      )}
    </div>
  );
}

/** Draft → Endpoint；不完整回 null。 */
function toEndpoint(d: Draft, hosts: ReturnType<typeof useSshSessions.getState>["sessions"]): Endpoint | null {
  if (d.kind === "local") return d.path.trim() ? { side: "local", path: d.path.trim() } : null;
  if (d.kind === "paste") return { side: "paste", text: d.text };
  const h = hosts.find((x) => x.id === d.hostId);
  if (!h) return null;
  return { side: "remote", target: { kind: "session", id: h.id }, sessionId: h.id, label: sessionLabel(h), path: d.remotePath.trim() || "~" };
}

export default function CompareLauncher({ tab, onStart, onCancel }: {
  tab: CompareTab;
  onStart: (patch: Pick<CompareTab, "mode" | "left" | "right"> & Partial<Pick<CompareTab, "savedId" | "folder">>) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const hosts = useSshSessions((s) => s.sessions);
  const { sessions, loaded, load, upsert, remove } = useCompareSessions();
  const [mode, setMode] = useState<CompareMode>(tab.mode);
  const [a, setA] = useState<Draft>(() => draftOf(tab.left));
  const [b, setB] = useState<Draft>(() => draftOf(tab.right));
  const [recent, setRecent] = useState<RecentCompare[]>(() => loadRecent());
  const [dbPick, setDbPick] = useState(false);

  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);

  const left = toEndpoint(a, hosts);
  const right = toEndpoint(b, hosts);
  const pasteLabel = t("貼上的文字");
  const same = sameEndpoint(left, right);
  const canStart = !!left && !!right && !same && !(mode !== "text" && (left.side === "paste" || right.side === "paste"));

  const start = (m = mode, l = left, r = right, extra: Partial<Pick<CompareTab, "savedId" | "folder">> = {}) => {
    if (!l || !r) return;
    pushRecent({ mode: m, left: l, right: r });
    onStart({ mode: m, left: l, right: r, ...extra });
  };

  const openSession = (s: CompareSession) => {
    const l = fromSessionSide(s.left, hosts);
    const r = fromSessionSide(s.right, hosts);
    if (!l || !r) { toast.error(t("這筆比對用到的主機已被刪除")); return; }
    start(s.mode, l, r, { savedId: s.id, folder: s.folder });
  };

  const saveSession = async () => {
    if (!left || !right) return;
    const ls = toSessionSide(left);
    const rs = toSessionSide(right);
    if (!ls || !rs) { toast.error(t("貼上的文字不能存成比對")); return; }
    const existing = sessions.find((s) => s.id === tab.savedId);
    const name = await uiPrompt(t("名稱"), { title: t("儲存比對"), defaultValue: existing?.name ?? compareTitle(left, right, pasteLabel) });
    if (!name?.trim()) return;
    const s: CompareSession = {
      id: existing?.id ?? crypto.randomUUID(),
      name: name.trim(),
      mode,
      left: ls,
      right: rs,
      folder: existing?.folder ?? tab.folder ?? DEFAULT_FOLDER,
      updated_at: Math.floor(Date.now() / 1000),
    };
    try {
      await upsert(s);
      toast.success(t("已儲存比對「{name}」", { name: s.name }));
    } catch (e) {
      toast.error(String((e as { message?: string })?.message ?? e));
    }
  };

  const modeOptions = useMemo(() => [
    { value: "text" as CompareMode, label: t("文字比對") },
    { value: "folder" as CompareMode, label: t("資料夾比對") },
    { value: "binary" as CompareMode, label: t("二進位比對") },
  ], [t]);
  const modeIcon = { text: FileDiff, folder: FolderTree, binary: Binary } as const;

  return (
    <div className="flex-1 min-h-0 overflow-auto" data-testid="compare-launcher">
      <div className="max-w-5xl mx-auto p-4 sm:p-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Icon icon={modeIcon[mode]} size={18} className="text-accent" />
          <h2 className="text-sm font-semibold">{t("新比對")}</h2>
          <Segmented<CompareMode> value={mode} onChange={setMode} options={modeOptions} ariaLabel={t("比對方式")} />
          <Button size="sm" variant="ghost" icon={Database} className="ml-auto whitespace-nowrap" onClick={() => setDbPick((v) => !v)}>
            {t("資料庫結構 / 資料比對…")}
          </Button>
        </div>

        {dbPick && <DbComparePicker onDone={() => setDbPick(false)} />}

        <div className="flex flex-col md:flex-row items-stretch gap-2">
          <EndpointPicker label={t("左邊")} mode={mode} draft={a} onChange={setA} testId="cmp-left" />
          <button type="button" onClick={() => { setA(b); setB(a); }} title={t("交換左右兩邊")} aria-label={t("交換左右兩邊")}
            className="self-center shrink-0 w-8 h-8 flex items-center justify-center rounded border border-fg/10 text-fg/60 hover:text-fg hover:bg-fg/10">
            <Icon icon={ArrowLeftRight} size={15} />
          </button>
          <EndpointPicker label={t("右邊")} mode={mode} draft={b} onChange={setB} testId="cmp-right" />
        </div>

        {same && <div className="text-xs text-warning">{t("左右兩邊是同一個來源。")}</div>}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" icon={Play} disabled={!canStart} onClick={() => start()} data-testid="cmp-start">{t("開始比對")}</Button>
          <Button icon={Save} disabled={!canStart} onClick={() => void saveSession()}>{tab.savedId ? t("更新已存的比對") : t("存成比對…")}</Button>
          <Button variant="ghost" onClick={onCancel}>{t("取消")}</Button>
        </div>

        {sessions.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-fg/60 flex items-center gap-1.5"><Icon icon={Save} size={13} />{t("已存的比對")}</h3>
            <ul className="rounded border border-fg/10 divide-y divide-fg/10">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-fg/5">
                  <Icon icon={modeIcon[s.mode] ?? FileDiff} size={13} className="shrink-0 text-fg/50" />
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openSession(s)} title={t("開始比對")}>
                    <span className="font-medium">{s.name}</span>
                    <span className="ml-2 mono text-fg/40 truncate">{sideText(s.left, hosts)} ↔ {sideText(s.right, hosts)}</span>
                  </button>
                  <button type="button" title={t("刪除")} aria-label={t("刪除")} className="shrink-0 text-fg/40 hover:text-danger"
                    onClick={() => void uiConfirm(t("刪除已存的比對「{name}」？", { name: s.name }), { danger: true, title: t("刪除") }).then((ok) => { if (ok) void remove(s.id); })}>
                    <Icon icon={Trash2} size={13} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {recent.length > 0 && (
          <section className="flex flex-col gap-1">
            <h3 className="text-xs font-medium text-fg/60 flex items-center gap-1.5"><Icon icon={Clock} size={13} />{t("最近的比對")}</h3>
            <ul className="rounded border border-fg/10 divide-y divide-fg/10">
              {recent.map((r, i) => (
                <li key={i}>
                  <button type="button" onClick={() => start(r.mode, r.left, r.right)}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-fg/5">
                    <Icon icon={modeIcon[r.mode] ?? FileDiff} size={13} className="shrink-0 text-fg/50" />
                    <Icon icon={r.left.side === "remote" ? Server : HardDrive} size={12} className="shrink-0 text-fg/30" />
                    <span className="mono truncate min-w-0 flex-1">{endpointLong(r.left, pasteLabel)}  ↔  {endpointLong(r.right, pasteLabel)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="self-start text-[11px] text-fg/40 hover:text-fg/70"
              onClick={() => { clearRecent(); setRecent([]); }}>
              {t("清除最近的比對")}
            </button>
          </section>
        )}

        <p className="text-[11px] text-fg/40 flex items-start gap-1.5">
          <Icon icon={Type} size={12} className="shrink-0 mt-px" />
          {t("在資料夾比對裡雙擊檔案，會另開一個文字比對分頁；二進位檔可切到二進位比對。已存的比對也能用 dbk diff / dbk sync --session 在命令列或排程裡執行。")}
        </p>
      </div>
    </div>
  );
}

function sideText(s: CompareSession["left"], hosts: ReturnType<typeof useSshSessions.getState>["sessions"]): string {
  if (s.side === "local") return s.path;
  const h = hosts.find((x) => x.id === s.session_id);
  return `${h ? sessionLabel(h) : "?"}:${s.path}`;
}

/** 資料庫結構 / 資料比對：選一條已連線的連線與資料庫，交給側欄既有的比對對話框。 */
function DbComparePicker({ onDone }: { onDone: () => void }) {
  const t = useT();
  const connections = useStore((s) => s.connections);
  const connectedIds = useStore((s) => s.connectedIds);
  const requestDbCompare = useStore((s) => s.requestDbCompare);
  const live = connections.filter((c) => connectedIds.has(c.id));
  const [connId, setConnId] = useState(live[0]?.id ?? "");
  const [dbs, setDbs] = useState<string[]>([]);
  const [db, setDb] = useState("");
  useEffect(() => {
    setDbs([]);
    setDb("");
    if (!connId) return;
    let alive = true;
    api.listDatabases(connId).then((l) => { if (alive) { setDbs(l); setDb(l[0] ?? ""); } }).catch(() => undefined);
    return () => { alive = false; };
  }, [connId]);
  const conn = live.find((c) => c.id === connId);
  if (!live.length) {
    return <div className="text-xs text-fg/50 p-3 rounded border border-fg/10">{t("先在左側連上一個資料庫，才能比對它的結構或資料。")}</div>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 p-3 rounded border border-fg/10 bg-panel text-xs">
      <span className="text-fg/60">{t("來源")}</span>
      <div className="w-56"><Select value={connId} onChange={(e) => setConnId(e.target.value)} aria-label={t("連線")}>
        {live.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select></div>
      <div className="w-48"><Select value={db} onChange={(e) => setDb(e.target.value)} aria-label={t("資料庫")}>
        {dbs.map((d) => <option key={d} value={d}>{d}</option>)}
      </Select></div>
      <Button size="sm" variant="primary" disabled={!conn || !db}
        onClick={() => { if (conn) { requestDbCompare({ connId: conn.id, db, kind: conn.kind }); onDone(); } }}>
        {t("開啟結構 / 資料比對")}
      </Button>
    </div>
  );
}
