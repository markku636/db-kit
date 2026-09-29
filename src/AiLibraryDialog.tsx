import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  CircleHelp,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  FolderPlus,
  Info,
  Library,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Users,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import { api } from "./api";
import {
  copyLibraryEntry,
  deleteLibraryEntry,
  entriesOf,
  entryDescription,
  entryTitle,
  findEntry,
  loadAiLibrary,
  personas,
  renderTaskWith,
  resolveVariant,
  saveLibraryEntry,
  taskMeta,
  updateLibrarySettings,
  useAiLibrary,
  type LibEntry,
  type LibIssue,
  type LibKind,
  type LibrarySnapshot,
  type SyncPlan,
} from "./aiLibrary";
import { assistantPersonaName, useAiSkills } from "./aiSkills";
import { sampleVars, varLabel } from "./aiTaskVars";
import { defaultDbaPersona } from "./dbaReview";
import DbaReviewHelp, { isDbaReviewTemplate } from "./DbaReviewHelp";
import { useT } from "./i18n";
import { fieldBool, fieldList, fieldStr } from "./promptTemplate";
import { Badge, Button, EmptyState, Field, Icon, Input, MenuPanel, Modal, Select, Textarea } from "./ui/index";
import { pickDirectory, toast, uiConfirm, uiPrompt } from "./ui";

// AI 資源庫：人設 / 技能 / 提示範本全部是 Markdown + frontmatter 的靜態檔（相容 Claude Code 與 Codex），
// 分成內建（隨 App 升級）< 個人 < 團隊資料夾三層，同名時後者覆蓋前者。這個對話框只是檔案的
// 編輯器與總覽：分層、覆蓋、lint 都由後端做，存檔後重新拿快照。
//
// 內建項目直接就能改：第一次存檔寫成個人層的同名覆蓋（後端連同其他語言變體一起帶上來），
// 「還原預設」= 刪掉那份覆蓋。

type Tab = "agent" | "skill" | "prompt" | "sources";

const DB_TOOLS = ["list_databases", "list_tables", "describe_table", "explain_query", "run_query", "sample_rows"] as const;

const HOW_KEY = "db-kit:aiLibHowOpen";

function readHowOpen(): boolean {
  try {
    return localStorage.getItem(HOW_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeHowOpen(open: boolean) {
  try {
    localStorage.setItem(HOW_KEY, open ? "1" : "0");
  } catch {
    // 無痕 / 封鎖網站資料：只是記不住收合狀態。
  }
}

function roleOf(e: LibEntry): string {
  return fieldStr(e.variants[""].fields, "dbkit-role") ?? "assistant";
}

/** 列表上的狀態標籤：內建原封不動就不標（滿版都是「內建」只是雜訊）。 */
function statusBadge(e: LibEntry, t: (s: string) => string): { tone: "accent" | "info" | "warning"; label: string } | null {
  if (e.layer === "builtin") return null;
  if (e.builtin) return { tone: "warning", label: t("已修改") };
  if (e.layer === "personal") return { tone: "accent", label: t("自訂") };
  return { tone: "info", label: e.layerLabel };
}

/** 這位人設目前被哪些功能用到（和 dbaReview / aiSkills 挑預設的規則一致）。 */
function personaUses(e: LibEntry, snap: LibrarySnapshot, t: (s: string) => string): string[] {
  const out: string[] = [];
  if (roleOf(e) === "dba") {
    if (defaultDbaPersona(false) === e.name) out.push(t("DBA 審查預設"));
    if (defaultDbaPersona(true) === e.name) out.push(t("正式環境 DBA 審查"));
    if (snap.settings.panel_personas.includes(e.name)) out.push(t("多位 DBA 會審"));
  } else if (assistantPersonaName() === e.name) {
    out.push(t("AI 助手"));
  }
  return out;
}

/** 人設列的右鍵選單：把這位設成 DBA 審查 / 正式環境 / 助手的預設，或加進 / 移出會審陣容。 */
function PersonaMenu({ x, y, entry, snap, onClose }: { x: number; y: number; entry: LibEntry; snap: LibrarySnapshot; onClose: () => void }) {
  const t = useT();
  const name = entry.name;
  const upd = (patch: Partial<LibrarySnapshot["settings"]>) => {
    onClose();
    void updateLibrarySettings(patch).catch((e) => toast.error(e?.message ?? String(e)));
  };
  const inPanel = snap.settings.panel_personas.includes(name);
  const items: [string, boolean, () => void][] =
    roleOf(entry) === "dba"
      ? [
          [t("設為 DBA 審查預設"), defaultDbaPersona(false) === name, () => upd({ dba_persona: name })],
          [t("設為正式環境 DBA 審查預設"), defaultDbaPersona(true) === name, () => upd({ dba_persona_prod: name })],
          [
            inPanel ? t("移出多位 DBA 會審") : t("加入多位 DBA 會審"),
            inPanel,
            () => upd({ panel_personas: inPanel ? snap.settings.panel_personas.filter((n) => n !== name) : [...snap.settings.panel_personas, name] }),
          ],
        ]
      : [[t("設為 AI 助手人設"), assistantPersonaName() === name, () => upd({ assistant_persona: name })]];
  return (
    <MenuPanel x={x} y={y} minW={200} onClose={onClose}>
      {items.map(([label, on, fn]) => (
        <button key={label} type="button" onClick={fn}
          className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs hover:bg-fg/10 text-fg/80">
          <span className="w-3 shrink-0">{on && <Icon icon={Check} size={12} className="text-success" />}</span>
          {label}
        </button>
      ))}
    </MenuPanel>
  );
}

function issuesOf(snap: LibrarySnapshot, e: LibEntry): LibIssue[] {
  return snap.issues.filter((i) => i.kind === e.kind && (i.name === e.name || (i.name ?? "").startsWith(`${e.name}.`)));
}

function IssueList({ issues }: { issues: LibIssue[] }) {
  if (!issues.length) return null;
  return (
    <div className="space-y-1">
      {issues.map((i, n) => (
        <div
          key={n}
          className={`text-[11px] leading-relaxed rounded px-2 py-1 ${
            i.level === "error" ? "bg-danger/10 text-danger" : i.level === "warn" ? "bg-warning/10 text-warning" : "bg-fg/5 text-fg/60"
          }`}
        >
          <Icon icon={AlertTriangle} size={11} className="inline mr-1 -mt-0.5" />
          {i.name ? <span className="font-mono mr-1">{i.name}</span> : null}
          {i.message}
          {i.path ? <div className="font-mono text-[10px] opacity-70 break-all">{i.path}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** 可寫的層（複製 / 新增 / 覆蓋內建的目標）。 */
function writableLayers(snap: LibrarySnapshot, t: (s: string) => string): { id: string; label: string }[] {
  const out = [{ id: "personal", label: t("個人") }];
  snap.settings.team_dirs.forEach((d, i) => {
    if (d.writable && d.path.trim()) out.push({ id: `team:${i}`, label: d.label.trim() || `${t("團隊")} ${i + 1}` });
  });
  return out;
}

const chipCls = "inline-flex items-center gap-1 px-2 h-6 rounded text-[11px] border transition-colors";

// ---------------------------------------------------------------------------
// 分頁列 + 運作方式：分頁本身排成「人設 ＋ 技能 ＋ 提示範本 → 送給 AI」，一眼看出三者怎麼組起來
// ---------------------------------------------------------------------------

interface TabDef {
  value: Tab;
  label: string;
  sub: string;
  icon: LucideIcon;
  count?: number;
}

function TabButton({ tab, active, onClick }: { tab: TabDef; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={tab.label}
      title={tab.sub}
      onClick={onClick}
      className={`flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 rounded-md border text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent/60 ${
        active ? "border-accent bg-accent/15" : "border-fg/10 hover:border-fg/25 hover:bg-fg/5"
      }`}
    >
      <Icon icon={tab.icon} size={16} className={active ? "text-accent shrink-0" : "text-fg/45 shrink-0"} />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-fg/90 whitespace-nowrap">
          {tab.label}
          {tab.count != null && <span className="text-[10px] font-normal text-fg/40 tabular-nums">{tab.count}</span>}
        </span>
        <span className="block text-[11px] text-fg/50 truncate">{tab.sub}</span>
      </span>
    </button>
  );
}

function FlowTabs({ tabs, value, onChange }: { tabs: TabDef[]; value: Tab; onChange: (v: Tab) => void }) {
  const t = useT();
  const flow = tabs.filter((x) => x.value !== "sources");
  const sources = tabs.find((x) => x.value === "sources")!;
  return (
    <div role="radiogroup" aria-label={t("AI 資源庫")} className="flex items-stretch gap-1.5">
      {flow.map((tb, i) => (
        <Fragment key={tb.value}>
          {i > 0 && (
            <span aria-hidden className="self-center text-fg/30 text-sm">
              ＋
            </span>
          )}
          <TabButton tab={tb} active={value === tb.value} onClick={() => onChange(tb.value)} />
        </Fragment>
      ))}
      <span aria-hidden className="self-center flex items-center gap-1 text-[11px] text-fg/40 whitespace-nowrap px-1">
        <Icon icon={ArrowRight} size={12} />
        {t("送給 AI")}
      </span>
      <div aria-hidden className="w-px bg-fg/10 mx-1 my-1" />
      <div className="w-44 shrink-0 flex">
        <TabButton tab={sources} active={value === "sources"} onClick={() => onChange("sources")} />
      </div>
    </div>
  );
}

/** 「DBA 審查怎麼用」的 ? 鈕（運作方式那一列、review-* 範本的標頭）。 */
function HelpButton({ onClick }: { onClick: () => void }) {
  const t = useT();
  const label = t("DBA 審查怎麼用");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="w-5 h-5 grid place-items-center rounded shrink-0 text-accent/80 hover:text-accent hover:bg-accent/10 transition-colors"
    >
      <Icon icon={CircleHelp} size={13} />
    </button>
  );
}

function HowItWorks({ onJump }: { onJump: (tab: Tab, name?: string) => void }) {
  const t = useT();
  const [helpOpen, setHelpOpen] = useState(false);
  // 白話版：不講「系統提示 / 使用者訊息」，講「誰來做、多懂什麼、做什麼」。每一格點了就到那個分頁。
  const step = (n: string, tab: Tab, label: string, what: string, eg: string) => (
    <button
      type="button"
      onClick={() => onJump(tab)}
      className="text-left rounded border border-fg/10 bg-elevated px-2 py-1 hover:border-accent/60 transition-colors whitespace-nowrap"
    >
      <div className="text-[10px] text-fg/45">
        {n} {what}
        <span className="ml-1.5 text-[12px] font-medium text-accent">{label}</span>
      </div>
      <div className="text-[10px] text-fg/50">{eg}</div>
    </button>
  );
  const plus = <span className="text-fg/35">＋</span>;
  const rows: { what: string; who: string; knows: string; does: string; help?: () => void }[] = [
    {
      what: t("DBA 審查 / 會審"),
      who: t("你選的 DBA 人設（選多位＝會審）"),
      knows: t("那位人設「預載」的技能"),
      does: t("審查範本 review-*"),
      help: () => setHelpOpen(true),
    },
    { what: t("AI 助手對話"), who: t("助手人設"), knows: t("你在「技能」分頁勾選的"), does: t("你在對話框打的字") },
    { what: t("編輯器 AI 動作、自然語言轉 SQL"), who: t("助手人設"), knows: t("不帶技能"), does: t("該動作的提示範本（加上註解 → comment…）") },
  ];
  const th = "text-left font-normal text-fg/40 whitespace-nowrap pr-4";
  const td = "pr-4 text-fg/55";
  return (
    // 上：每次按 AI 功能時送出的三樣東西；下：各功能分別用哪幾樣。上下排（並排時表格太窄、每格都換行反而更高），
    // 有高度上限（小視窗捲動），別把下面的編輯區擠掉。
    <div className="rounded-md border border-fg/10 bg-inset/40 px-2.5 py-2 space-y-2 max-h-[30vh] overflow-y-auto">
      <div className="space-y-1">
        <div className="text-[11px] text-fg/60">{t("每按一次 AI 功能，db-kit 會把這三樣拼在一起送給 AI：")}</div>
        <div className="flex items-center gap-1.5">
          {step("①", "agent", t("人設"), t("請誰來做"), t("例：資深 DBA、資料庫助手"))}
          {plus}
          {step("②", "skill", t("技能"), t("讓它多懂什麼"), t("例：鎖與併發風險、團隊規範"))}
          {plus}
          {step("③", "prompt", t("提示範本"), t("這次要做什麼"), t("例：加上註解、解釋、DBA 審查"))}
          <span className="flex items-center gap-1 text-[11px] text-fg/50 whitespace-nowrap">
            <Icon icon={ArrowRight} size={12} />
            {t("AI")}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-fg/45">
          <Icon icon={Lock} size={9} className="text-warning/80 shrink-0" />
          {t("範本裡的 {{sql}} 會換成你當下的 SQL；有些範本最後附有鎖定的回覆格式，db-kit 靠它讀回結果，所以不能改。")}
        </div>
      </div>
      <div className="text-[11px] leading-[1.15rem] border-t border-fg/10 pt-1.5">
        <table>
          <thead>
            <tr>
              <th className={th}>{t("各功能用到哪幾樣")}</th>
              <th className={th}>{t("① 誰來做")}</th>
              <th className={th}>{t("② 多懂什麼")}</th>
              <th className={th}>{t("③ 做什麼")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.what} className="align-top">
                <td className="pr-4 text-fg/80 font-medium whitespace-nowrap">
                  <span className="inline-flex items-center gap-1">
                    {r.what}
                    {r.help && <HelpButton onClick={r.help} />}
                  </span>
                </td>
                <td className={td}>{r.who}</td>
                <td className={td}>{r.knows}</td>
                <td className="text-fg/55">{r.does}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {helpOpen && <DbaReviewHelp onClose={() => setHelpOpen(false)} onOpenTemplate={(name) => onJump("prompt", name)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 「用在哪裡」：人設 → 哪些功能用它；技能 → 助手對話有沒有啟用、哪些人設預載它
// ---------------------------------------------------------------------------

function UsageRow({ entry, snap, onJump }: { entry: LibEntry; snap: LibrarySnapshot; onJump: (tab: Tab, name?: string) => void }) {
  const t = useT();
  const activeSkills = useAiSkills((s) => s.selected);
  const toggleSkill = useAiSkills((s) => s.toggle);
  if (entry.kind === "agent") {
    const uses = personaUses(entry, snap, t);
    return (
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="text-fg/45">{t("用在：")}</span>
        {uses.length ? (
          uses.map((u) => (
            <span key={u} className={`${chipCls} border-accent/40 bg-accent/10 text-fg/80`}>
              <Icon icon={Check} size={10} />
              {u}
            </span>
          ))
        ) : (
          <span className="text-fg/40">{t("目前沒有功能使用這位人設（在左側列表按右鍵就能設為使用中）")}</span>
        )}
        <button type="button" className="text-accent hover:underline ml-1" onClick={() => onJump("sources")}>
          {t("到「來源與同步」調整")}
        </button>
      </div>
    );
  }
  if (entry.kind === "skill") {
    const on = activeSkills.includes(entry.name);
    const by = entriesOf("agent", snap).filter((a) => fieldList(a.variants[""].fields, "skills").includes(entry.name));
    return (
      <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
        <span className="text-fg/45">{t("用在：")}</span>
        <button
          type="button"
          onClick={() => toggleSkill(entry.name)}
          title={on ? t("點一下停用") : t("點一下啟用")}
          className={`${chipCls} ${on ? "border-accent/40 bg-accent/10 text-fg/80" : "border-fg/15 text-fg/50 hover:border-fg/30"}`}
        >
          {on && <Icon icon={Check} size={10} />}
          {on ? t("AI 助手對話：已啟用") : t("AI 助手對話：未啟用")}
        </button>
        <span className="text-fg/45 ml-2">{t("預載它的人設：")}</span>
        {by.length ? (
          by.map((a) => (
            <button
              key={a.name}
              type="button"
              onClick={() => onJump("agent", a.name)}
              className={`${chipCls} border-fg/15 text-fg/70 hover:border-accent/60`}
            >
              <Icon icon={roleOf(a) === "dba" ? Users : Bot} size={10} />
              {entryTitle(a)}
            </button>
          ))
        ) : (
          <span className="text-fg/40">{t("沒有人設預載它")}</span>
        )}
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 單筆編輯器
// ---------------------------------------------------------------------------

function EntryEditor({
  entry,
  snap,
  onJump,
  onDirtyChange,
}: {
  entry: LibEntry;
  snap: LibrarySnapshot;
  onJump: (tab: Tab, name?: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const langs = useMemo(() => Object.keys(entry.variants).sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))), [entry]);
  const [lang, setLang] = useState("");
  const v = entry.variants[lang] ?? entry.variants[""];
  const base = entry.variants[""];
  const isBase = lang === "";
  const isBuiltin = entry.layer === "builtin";
  /** 就地可寫（這一層本身可寫）。 */
  const writable = entry.writable && !isBuiltin;
  /** 表單可以改：內建的存檔會寫成可寫層的同名覆蓋。 */
  const editable = writable || isBuiltin;
  const targets = writableLayers(snap, t);
  const [copyTarget, setCopyTarget] = useState(targets[0]?.id ?? "personal");
  const saveLayer = writable ? entry.layer : copyTarget;
  const below = entry.shadowed[0] ?? null;

  // ---- 草稿 ----
  const init = () => ({
    title: fieldStr(v.fields, "dbkit-title") ?? "",
    description: fieldStr(v.fields, "description") ?? "",
    body: v.body,
    role: fieldStr(base.fields, "dbkit-role") ?? "assistant",
    dbTools: fieldBool(base.fields, "dbkit-db-tools", true),
    maxTurns: fieldStr(base.fields, "maxTurns") ?? "",
    skills: fieldList(base.fields, "skills"),
    tools: fieldList(base.fields, "tools").filter((x) => x.startsWith("mcp__dbkit__")).map((x) => x.slice("mcp__dbkit__".length)),
    restrictTools: fieldList(base.fields, "tools").length > 0,
  });
  // 視窗取得焦點時資源庫會重讀，快照物件每次都是新的；只在檔案內容真的變了才重設草稿，
  // 不然切出去查個東西再回來，沒存的修改就不見了。
  const source = `${entry.layer}\n${v.path}\n${v.raw}\n${base.raw}`;
  const [draft, setDraft] = useState(init);
  const [preview, setPreview] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 共用的 Textarea 不轉發 ref：從外層容器找到 textarea，才拿得到游標位置插入變數。
  const bodyWrap = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(init()), [source, lang]);
  useEffect(() => setLang(""), [entry.kind, entry.name]);
  // 還原預設後，只存在於覆蓋版的語言變體就沒了：退回基底。
  useEffect(() => {
    if (!(lang in entry.variants)) setLang("");
  }, [entry, lang]);
  const original = useMemo(init, [source, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = editable && JSON.stringify(draft) !== JSON.stringify(original);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const set = <K extends keyof typeof draft>(k: K, val: (typeof draft)[K]) => setDraft((d) => ({ ...d, [k]: val }));

  const skillNames = entriesOf("skill", snap).map((e) => e.name);
  const meta = entry.kind === "prompt" ? taskMeta(entry) : null;
  const contract = meta?.contract ? findEntry("contract", meta.contract, snap) : null;
  const tplLang = lang || fieldStr(base.fields, "dbkit-lang") || "zh-TW";

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await fn();
      if (ok) toast.success(ok);
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      const fields: Record<string, string | string[] | null> = {
        "dbkit-title": draft.title.trim() || null,
        description: draft.description.trim() || null,
      };
      if (isBase && entry.kind === "agent") {
        fields["dbkit-role"] = draft.role;
        fields["dbkit-db-tools"] = draft.dbTools ? "true" : "false";
        fields.maxTurns = draft.maxTurns.trim() || null;
        fields.skills = draft.skills;
        fields.tools = draft.restrictTools ? draft.tools.map((x) => `mcp__dbkit__${x}`) : null;
      }
      await saveLibraryEntry({ kind: entry.kind, name: entry.name, lang, layer: saveLayer, fields, body: draft.body });
    }, isBuiltin ? t("已存成自訂版本；隨時可以還原預設") : t("已儲存"));

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      e.stopPropagation();
      if (dirty && !busy) void save();
    }
  };

  const saveAsNew = async () => {
    const name = await uiPrompt(t("輸入新名稱（英數與連字號）。"), { title: t("另存新項目"), defaultValue: `${entry.name}-copy`, confirmText: t("另存") });
    const next = name?.trim();
    if (!next) return;
    await run(async () => {
      await copyLibraryEntry(entry.kind, entry.name, next, copyTarget);
      onJump(entry.kind as Tab, next);
    }, t("已另存為 {name}", { name: next }));
  };

  const restore = async () => {
    const msg =
      below?.layer === "builtin"
        ? t("捨棄你對「{name}」的修改，改回內建預設？所有語言變體一起還原。", { name: entryTitle(entry) })
        : t("刪除「{layer}」裡的這份覆蓋，改回使用「{below}」的版本？", { layer: entry.layerLabel, below: below?.layerLabel ?? "" });
    const ok = await uiConfirm(msg, { title: t("還原預設"), danger: true, confirmText: t("還原") });
    if (ok) await run(() => deleteLibraryEntry(entry.kind, entry.name, entry.layer), t("已還原預設"));
  };

  const remove = async () => {
    const what = isBase ? t("整筆（含所有語言變體）") : t("這個語言變體（{lang}）", { lang });
    const ok = await uiConfirm(t("刪除 {name} 的{what}？檔案會從磁碟移除。", { name: entry.name, what }), {
      title: t("刪除"),
      danger: true,
      confirmText: t("刪除"),
    });
    if (ok) await run(() => deleteLibraryEntry(entry.kind, entry.name, entry.layer, isBase ? null : lang), t("已刪除"));
  };

  const addVariant = async () => {
    const l = await uiPrompt(t("語言碼（en / zh-CN / ja / ko / vi）："), { title: t("新增語言變體"), defaultValue: "en" });
    const code = l?.trim();
    if (!code) return;
    await run(async () => {
      await saveLibraryEntry({
        kind: entry.kind,
        name: entry.name,
        lang: code,
        layer: saveLayer,
        fields: { description: fieldStr(base.fields, "description") ?? null, "dbkit-title": fieldStr(base.fields, "dbkit-title") ?? null },
        body: base.body,
      });
      setLang(code);
    });
  };

  const insertVar = (name: string) => {
    const el = bodyWrap.current?.querySelector("textarea") ?? null;
    const tag = `{{${name}}}`;
    if (!el) return set("body", draft.body + tag);
    const a = el.selectionStart ?? draft.body.length;
    const b = el.selectionEnd ?? a;
    const next = draft.body.slice(0, a) + tag + draft.body.slice(b);
    set("body", next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + tag.length, a + tag.length);
    });
  };

  const rendered = useMemo(() => {
    if (!preview || entry.kind !== "prompt") return null;
    try {
      return renderTaskWith(entry.name, sampleVars(meta?.vars ?? []), { lang: tplLang, body: draft.body });
    } catch (e: any) {
      return { text: String(e?.message ?? e), missing: [], lang: tplLang };
    }
  }, [preview, entry, draft.body, tplLang, meta]);

  const issues = issuesOf(snap, entry);
  const badge = statusBadge(entry, t);
  const canRestore = writable && !!entry.builtin && !!below;
  let note: ReactNode = null;
  if (isBuiltin) {
    note = t("內建版本：可以直接修改，儲存後存成你的自訂版本（App 升級不會蓋掉），之後隨時可以「還原預設」。");
  } else if (!writable) {
    note = t("這個團隊資料夾設定為唯讀；請在它的 git repo 裡修改，或複製一份到個人層。");
  } else if (canRestore && below?.layer === "builtin") {
    note = t("你修改過這個內建項目；App 升級帶來的內建更新不會套用到這裡。要改回請按「還原預設」。");
  }

  return (
    <div className="flex flex-col h-full min-h-0" onKeyDown={onKeyDown}>
      {/* 標頭 */}
      <div className="px-4 py-3 border-b border-fg/10 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-medium text-fg/90">{entryTitle(entry)}</div>
          <span className="font-mono text-[11px] text-fg/50">{entry.name}</span>
          {entry.kind === "prompt" && isDbaReviewTemplate(entry.name) && <HelpButton onClick={() => setHelpOpen(true)} />}
          {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : <Badge tone="neutral">{entry.layerLabel}</Badge>}
          {entry.shadowed.length > 0 && !entry.builtin && (
            <Badge tone="warning">{t("覆蓋了 {layers}", { layers: entry.shadowed.map((s) => s.layerLabel).join(" / ") })}</Badge>
          )}
          {!editable && (
            <span className="inline-flex items-center gap-1 text-[11px] text-fg/45">
              <Icon icon={Lock} size={11} />
              {t("唯讀")}
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {v.path && !v.path.startsWith("builtin:") && (
              <Button variant="ghost" size="sm" icon={FolderOpen} onClick={() => void api.aiLibraryReveal(v.path)}>
                {t("在檔案總管顯示")}
              </Button>
            )}
            {targets.length > 1 && (isBuiltin || entry.kind !== "prompt") && (
              <Select selectSize="sm" className="w-28" value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)} title={t("存到哪一層")}>
                {targets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </Select>
            )}
            {/* 範本名稱固定對應功能，另存一份新名稱的範本沒有人會用到。 */}
            {entry.kind !== "prompt" && (
              <Button variant="ghost" size="sm" icon={Copy} disabled={busy} onClick={() => void saveAsNew()}>
                {t("另存新項目")}
              </Button>
            )}
            {canRestore && (
              <Button variant="ghost" size="sm" icon={RotateCcw} disabled={busy} onClick={() => void restore()}>
                {t("還原預設")}
              </Button>
            )}
            {writable && (!entry.builtin || !isBase) && (
              <Button variant="ghost" size="sm" icon={Trash2} disabled={busy} onClick={() => void remove()}>
                {t("刪除")}
              </Button>
            )}
          </div>
        </div>
        <UsageRow entry={entry} snap={snap} onJump={onJump} />
        {helpOpen && <DbaReviewHelp focus={entry.name} onClose={() => setHelpOpen(false)} onOpenTemplate={(name) => onJump("prompt", name)} />}
        {/* 語言變體 */}
        <div className="flex items-center gap-1 flex-wrap">
          {langs.map((l) => (
            <button
              key={l || "base"}
              type="button"
              onClick={() => setLang(l)}
              className={`px-2 h-6 rounded text-[11px] border ${lang === l ? "border-accent bg-accent/15 text-fg" : "border-fg/10 text-fg/55 hover:border-fg/25"}`}
            >
              {l || t("基底（{lang}）", { lang: fieldStr(base.fields, "dbkit-lang") ?? "zh-TW" })}
            </button>
          ))}
          {editable && (
            <Button variant="ghost" size="sm" icon={Plus} onClick={() => void addVariant()}>
              {t("語言變體")}
            </Button>
          )}
          <span className="text-[10px] text-fg/35 ml-1">{t("日 / 韓 / 越沒有變體時用英文，再沒有就用基底檔")}</span>
        </div>
      </div>

      {/* 內容 */}
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3">
        {note && (
          <div className="flex items-start gap-2 text-[11px] text-fg/55 bg-fg/5 rounded px-2 py-1.5 leading-relaxed">
            <Icon icon={Info} size={12} className="mt-0.5 shrink-0 text-fg/40" />
            <span className="flex-1">{note}</span>
          </div>
        )}
        <IssueList issues={issues} />

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("顯示名稱（dbkit-title）")}>
            <Input value={draft.title} disabled={!editable} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label={t("說明（description）")} hint={entry.kind !== "prompt" ? t("Claude Code / Codex 用它決定何時使用；必填。") : undefined}>
            <Input value={draft.description} disabled={!editable} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>

        {entry.kind === "agent" && isBase && (
          <div className="rounded border border-fg/10 p-3 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <Field label={t("角色")}>
                <Select value={draft.role} disabled={!editable} onChange={(e) => set("role", e.target.value)}>
                  <option value="dba">{t("DBA 審查者")}</option>
                  <option value="assistant">{t("助手")}</option>
                </Select>
              </Field>
              <Field label={t("回合上限（maxTurns）")} hint={t("DBA agent 最多查幾輪資料庫再下結論")}>
                <Input value={draft.maxTurns} disabled={!editable} placeholder="10" onChange={(e) => set("maxTurns", e.target.value.replace(/[^\d]/g, ""))} />
              </Field>
              <Field label={t("可查資料庫")}>
                <label className="flex items-center gap-2 h-8 text-xs">
                  <input type="checkbox" checked={draft.dbTools} disabled={!editable} onChange={(e) => set("dbTools", e.target.checked)} />
                  {t("允許 DBA 自己呼叫唯讀資料庫工具")}
                </label>
              </Field>
            </div>
            {draft.dbTools && (
              <Field label={t("允許的工具（tools）")} hint={t("同步到 Claude Code 時也用這份清單；不限定 = 全部唯讀工具。")}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[11px] mr-2">
                    <input type="checkbox" checked={draft.restrictTools} disabled={!editable} onChange={(e) => set("restrictTools", e.target.checked)} />
                    {t("限定")}
                  </label>
                  {draft.restrictTools &&
                    DB_TOOLS.map((tool) => {
                      const on = draft.tools.includes(tool);
                      return (
                        <button
                          key={tool}
                          type="button"
                          disabled={!editable}
                          onClick={() => set("tools", on ? draft.tools.filter((x) => x !== tool) : [...draft.tools, tool])}
                          className={`font-mono px-1.5 h-6 rounded text-[11px] border ${on ? "border-accent bg-accent/15" : "border-fg/10 text-fg/45"}`}
                        >
                          {tool}
                        </button>
                      );
                    })}
                </div>
              </Field>
            )}
            <Field label={t("預載技能（skills）")} hint={t("這位人設每次都會帶上的技能，內容在「技能」分頁編輯。")}>
              <div className="flex flex-wrap gap-1.5">
                {skillNames.map((s) => {
                  const on = draft.skills.includes(s);
                  const se = findEntry("skill", s, snap);
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={!editable}
                      onClick={() => set("skills", on ? draft.skills.filter((x) => x !== s) : [...draft.skills, s])}
                      title={se ? entryDescription(se) : s}
                      className={`inline-flex items-center gap-1 px-2 h-6 rounded text-[11px] border ${on ? "border-accent bg-accent/15 text-fg" : "border-fg/10 text-fg/55"}`}
                    >
                      {on && <Icon icon={Check} size={10} />}
                      {se ? entryTitle(se) : s}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
        )}

        {meta && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[11px] text-fg/50 mr-1">{t("可用變數（點一下插入）：")}</span>
            {meta.vars.map((name) => (
              <button
                key={name}
                type="button"
                disabled={!editable}
                title={varLabel(name)}
                onClick={() => insertVar(name)}
                className={`font-mono px-1.5 h-5 rounded text-[10px] border ${meta.required.includes(name) ? "border-accent/60 text-accent" : "border-fg/15 text-fg/60"} hover:border-fg/40`}
              >
                {`{{${name}}}`}
              </button>
            ))}
            {meta.contract && (
              <span className="font-mono px-1.5 h-5 rounded text-[10px] border border-warning/50 text-warning" title={t("輸出契約放置的位置")}>
                {"{{contract}}"}
              </span>
            )}
            <span className="text-[10px] text-fg/35 ml-1">{t("區段：{{#x}}…{{/x}} 非空才輸出、{{^x}}…{{/x}} 為空才輸出")}</span>
          </div>
        )}

        <div className={preview ? "grid grid-cols-2 gap-3" : ""}>
          <Field
            label={entry.kind === "prompt" ? t("範本本文") : entry.kind === "skill" ? t("技能內容（SKILL.md 本文）") : t("人設（系統提示）")}
          >
            <div ref={bodyWrap}>
            <Textarea
              rows={18}
              className="font-mono text-[12px] leading-relaxed"
              value={draft.body}
              disabled={!editable}
              onChange={(e) => set("body", e.target.value)}
            />
            </div>
          </Field>
          {preview && rendered && (
            <Field label={t("預覽（以範例資料渲染）")}>
              <pre className="h-[27rem] overflow-auto rounded border border-fg/10 bg-inset/50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap font-mono">
                {rendered.text}
              </pre>
              {rendered.missing.length > 0 && (
                <div className="text-[11px] text-warning mt-1">
                  {t("範本沒有輸出必要變數 {vars}，送出時已自動附在最後。", { vars: rendered.missing.map((m) => `{{${m}}}`).join("、") })}
                </div>
              )}
            </Field>
          )}
        </div>

        {contract && (
          <Field label={t("輸出契約（鎖定，不可修改）")} hint={t("解析器依賴它（結論徽章、編輯器套用、dbk run 的 STOP 攔截）。範本沒放 {{contract}} 時會自動附在最後。")}>
            <pre className="rounded border border-warning/30 bg-warning/5 p-2 text-[11px] leading-relaxed whitespace-pre-wrap font-mono text-fg/70">
              {resolveVariant(contract, tplLang).body}
            </pre>
          </Field>
        )}
      </div>

      <div className="px-4 py-2 border-t border-fg/10 flex items-center gap-2">
        {entry.kind === "prompt" && (
          <Button variant="ghost" icon={Eye} onClick={() => setPreview((p) => !p)}>
            {preview ? t("關閉預覽") : t("預覽")}
          </Button>
        )}
        <span className="text-[11px] text-fg/40 truncate font-mono">{v.path}</span>
        <div className="ml-auto flex items-center gap-2">
          {dirty && <span className="text-[11px] text-warning">{t("未儲存")}</span>}
          {dirty && (
            <Button variant="ghost" onClick={() => setDraft(original)}>
              {t("捨棄變更")}
            </Button>
          )}
          <Button variant="primary" icon={Save} disabled={!dirty || busy} onClick={() => void save()} title="Ctrl+S">
            {isBuiltin ? t("儲存為自訂版本") : t("儲存")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 來源與同步
// ---------------------------------------------------------------------------

function SourcesPanel({ snap }: { snap: LibrarySnapshot }) {
  const t = useT();
  const s = snap.settings;
  const [plan, setPlan] = useState<SyncPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const dba = personas("dba", snap);
  const assistants = personas("assistant", snap);

  const upd = (patch: Partial<typeof s>) => void updateLibrarySettings(patch).catch((e) => toast.error(e?.message ?? String(e)));

  const addTeam = async () => {
    const dir = await pickDirectory();
    if (!dir) return;
    const label = dir.split(/[\\/]/).filter(Boolean).pop() ?? "";
    upd({ team_dirs: [...s.team_dirs, { path: dir, label, writable: true }] });
  };

  const previewSync = async () => {
    setBusy(true);
    try {
      setPlan(await api.aiLibrarySyncPlan());
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const applySync = async () => {
    setBusy(true);
    try {
      const r = await api.aiLibrarySyncApply();
      if (r.errors.length) toast.error(r.errors.join("\n"));
      else toast.success(t("已同步：寫入 {w} 個、刪除 {d} 個、略過 {s} 個（衝突）", { w: r.written, d: r.deleted, s: r.skipped }));
      setPlan(await api.aiLibrarySyncPlan());
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const actionable = plan?.items.filter((i) => i.action === "create" || i.action === "update" || i.action === "delete").length ?? 0;
  const actionTone = (a: string) => (a === "conflict" ? "danger" : a === "delete" ? "warning" : a === "unchanged" ? "neutral" : "success");
  const actionLabel = (a: string) =>
    ({ create: t("新增"), update: t("更新"), unchanged: t("未變更"), conflict: t("衝突（略過）"), delete: t("刪除") })[a] ?? a;

  return (
    <div className="h-full overflow-auto px-4 py-3 space-y-5">
      <section className="space-y-2">
        <div className="text-xs font-medium text-fg/70">{t("資料夾")}</div>
        <div className="flex items-center gap-2 text-[12px]">
          <Badge tone="neutral">{t("內建")}</Badge>
          <span className="text-fg/55">{t("隨 App 升級，唯讀")}</span>
        </div>
        <div className="flex items-center gap-2 text-[12px]">
          <Badge tone="accent">{t("個人")}</Badge>
          <span className="font-mono text-fg/70 break-all">{snap.dirs?.personal ?? "—"}</span>
          <Button variant="ghost" size="sm" icon={FolderOpen} onClick={() => void api.aiLibraryReveal(null)}>
            {t("開啟")}
          </Button>
        </div>
        {s.team_dirs.map((d, i) => {
          const info = snap.dirs?.teams[i];
          return (
            <div key={i} className="flex items-center gap-2 text-[12px]">
              <Badge tone="info">{t("團隊")}</Badge>
              <Input
                inputSize="sm"
                className="w-32"
                value={d.label}
                onChange={(e) => upd({ team_dirs: s.team_dirs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
              />
              <span className={`font-mono break-all ${info?.exists === false ? "text-danger" : "text-fg/70"}`}>{d.path}</span>
              {info?.exists === false && <span className="text-danger text-[11px]">{t("資料夾不存在")}</span>}
              <label className="flex items-center gap-1 text-[11px] ml-auto">
                <input
                  type="checkbox"
                  checked={d.writable}
                  onChange={(e) => upd({ team_dirs: s.team_dirs.map((x, j) => (j === i ? { ...x, writable: e.target.checked } : x)) })}
                />
                {t("可寫")}
              </label>
              <Button variant="ghost" size="sm" icon={FolderOpen} onClick={() => void api.aiLibraryReveal(info?.path ?? d.path)}>
                {t("開啟")}
              </Button>
              <Button variant="ghost" size="sm" icon={Trash2} onClick={() => upd({ team_dirs: s.team_dirs.filter((_, j) => j !== i) })}>
                {t("移除")}
              </Button>
            </div>
          );
        })}
        <Button variant="secondary" size="sm" icon={FolderPlus} onClick={() => void addTeam()}>
          {t("加入團隊資料夾…")}
        </Button>
        <div className="text-[11px] text-fg/45 leading-relaxed">
          {t("團隊資料夾可以是一個 git repo，用 agents/、skills/、prompts/ 結構，或直接用 Claude Code / Codex 的 .claude/agents、.claude/skills、.agents/skills 結構。後加入的資料夾優先；同名時覆蓋前面的層。可在 CI 跑 `dbk ai lint --dir <資料夾>` 檢查。")}
        </div>
      </section>

      <section className="space-y-3 border-t border-fg/10 pt-4">
        <div className="text-xs font-medium text-fg/70">{t("預設人設")}</div>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t("DBA 審查（一般連線）")}>
            <Select value={s.dba_persona ?? ""} onChange={(e) => upd({ dba_persona: e.target.value })}>
              {dba.map((e) => (
                <option key={e.name} value={e.name}>
                  {entryTitle(e)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("DBA 審查（正式環境連線）")}>
            <Select value={s.dba_persona_prod ?? ""} onChange={(e) => upd({ dba_persona_prod: e.target.value })}>
              {dba.map((e) => (
                <option key={e.name} value={e.name}>
                  {entryTitle(e)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("助手")}>
            <Select value={s.assistant_persona ?? "assistant"} onChange={(e) => upd({ assistant_persona: e.target.value })}>
              {assistants.map((e) => (
                <option key={e.name} value={e.name}>
                  {entryTitle(e)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t("多位 DBA 會審的預設陣容")} hint={t("會審時同一份 SQL 交給這幾位平行審查，綜合結論取最嚴格者。")}>
          <div className="flex flex-wrap gap-1.5">
            {dba.map((e) => {
              const on = s.panel_personas.includes(e.name);
              return (
                <button
                  key={e.name}
                  type="button"
                  onClick={() => upd({ panel_personas: on ? s.panel_personas.filter((x) => x !== e.name) : [...s.panel_personas, e.name] })}
                  className={`inline-flex items-center gap-1 px-2 h-6 rounded text-[11px] border ${on ? "border-accent bg-accent/15" : "border-fg/10 text-fg/55"}`}
                >
                  {on && <Icon icon={Check} size={10} />}
                  {entryTitle(e)}
                </button>
              );
            })}
          </div>
        </Field>
      </section>

      <section className="space-y-3 border-t border-fg/10 pt-4">
        <div className="text-xs font-medium text-fg/70">{t("同步到 Claude Code / Codex")}</div>
        <div className="text-[11px] text-fg/45 leading-relaxed">
          {t("把人設與技能寫成 Claude Code 的 subagent / skill 與 Codex 的 agent / skill，讓同一批 DBA 人設在 db-kit 之外也能用（例如 claude --agent dba-prod-gatekeeper）。只會覆寫 db-kit 自己寫過、且之後沒被手動修改的檔案。")}
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={s.sync.claude_user} onChange={(e) => upd({ sync: { ...s.sync, claude_user: e.target.checked } })} />
            {t("Claude Code（~/.claude）")}
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={s.sync.codex_user} onChange={(e) => upd({ sync: { ...s.sync, codex_user: e.target.checked } })} />
            {t("Codex（~/.agents/skills、~/.codex/agents）")}
          </label>
        </div>
        <Field label={t("只同步這些名稱（逗號分隔，可用結尾 *；留空 = 全部 DBA 人設與技能）")}>
          <Input
            value={s.sync.include.join(", ")}
            placeholder="dba-*, lock-risk"
            onChange={(e) => upd({ sync: { ...s.sync, include: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })}
          />
        </Field>
        <Field label={t("另外同步到這些專案資料夾")}>
          <div className="space-y-1">
            {s.sync.project_dirs.map((p, i) => (
              <div key={i} className="flex items-center gap-2 text-[12px]">
                <span className="font-mono text-fg/70 break-all flex-1">{p}</span>
                <Button variant="ghost" size="sm" icon={Trash2} onClick={() => upd({ sync: { ...s.sync, project_dirs: s.sync.project_dirs.filter((_, j) => j !== i) } })}>
                  {t("移除")}
                </Button>
              </div>
            ))}
            <Button
              variant="ghost"
              size="sm"
              icon={FolderPlus}
              onClick={async () => {
                const dir = await pickDirectory();
                if (dir) upd({ sync: { ...s.sync, project_dirs: [...s.sync.project_dirs, dir] } });
              }}
            >
              {t("加入專案資料夾…")}
            </Button>
          </div>
        </Field>
        <div className="flex gap-2">
          <Button variant="secondary" icon={Eye} disabled={busy} onClick={() => void previewSync()}>
            {t("預覽同步計畫")}
          </Button>
          <Button variant="primary" icon={RefreshCw} disabled={busy || !plan || actionable === 0} onClick={() => void applySync()}>
            {t("執行同步（{n} 個檔案）", { n: actionable })}
          </Button>
        </div>
        {plan && (
          <div className="space-y-2">
            <div className="max-h-56 overflow-auto rounded border border-fg/10">
              {plan.items.length === 0 ? (
                <div className="p-2 text-[11px] text-fg/50">{t("沒有要同步的項目（檢查同步目標與名稱過濾）")}</div>
              ) : (
                plan.items.map((i) => (
                  <div key={i.path} className="flex items-center gap-2 px-2 py-1 text-[11px] border-b border-fg/5 last:border-0">
                    <Badge tone={actionTone(i.action)}>{actionLabel(i.action)}</Badge>
                    <span className="font-mono text-fg/70 break-all flex-1">{i.path}</span>
                    <span className="text-fg/40">{i.source}</span>
                  </div>
                ))
              )}
            </div>
            <div className="text-[11px] text-fg/50 leading-relaxed bg-fg/5 rounded px-2 py-1.5">{plan.mcp_hint}</div>
          </div>
        )}
      </section>

      <section className="space-y-2 border-t border-fg/10 pt-4">
        <div className="text-xs font-medium text-fg/70">{t("檢查結果")}</div>
        {snap.issues.length === 0 ? <div className="text-[11px] text-fg/50">{t("沒有發現問題")}</div> : <IssueList issues={snap.issues} />}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 對話框
// ---------------------------------------------------------------------------

export default function AiLibraryDialog({
  open,
  onClose,
  initialTab = "agent",
  initialName = null,
}: {
  open: boolean;
  onClose: () => void;
  initialTab?: Tab;
  initialName?: string | null;
}) {
  const t = useT();
  const snap = useAiLibrary((s) => s.snapshot);
  const loaded = useAiLibrary((s) => s.loaded);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(initialName);
  // 人設列右鍵：直接設成預設 / 加入會審，不必繞去「來源與同步」。
  const [personaMenu, setPersonaMenu] = useState<{ x: number; y: number; e: LibEntry } | null>(null);
  const [howOpen, setHowOpen] = useState(readHowOpen);
  const activeSkills = useAiSkills((s) => s.selected);
  const toggleSkill = useAiSkills((s) => s.toggle);
  // 只數還存在的技能：勾選清單裡可能留著已刪除技能的名稱。
  const activeCount = entriesOf("skill", snap).filter((e) => activeSkills.includes(e.name)).length;
  const personaEntries = entriesOf("agent", snap);

  // 編輯器回報有沒有沒存的修改；換項目、換分頁、關對話框前先問一聲。
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d;
  }, []);
  const confirmLeave = async () =>
    !dirtyRef.current ||
    (await uiConfirm(t("有未儲存的修改，要捨棄嗎？"), { title: t("未儲存的修改"), danger: true, confirmText: t("捨棄") }));
  const close = async () => {
    if (await confirmLeave()) onClose();
  };

  useEffect(() => {
    if (open) void loadAiLibrary();
  }, [open]);

  const kind: LibKind | null = tab === "sources" ? null : tab;
  const list = useMemo(() => {
    if (!kind) return [];
    const needle = q.trim().toLowerCase();
    return entriesOf(kind, snap).filter(
      (e) => !needle || e.name.toLowerCase().includes(needle) || entryTitle(e).toLowerCase().includes(needle),
    );
  }, [kind, snap, q]);
  // 人設分兩群：DBA 審查者 / 助手——兩種用在不同功能，混在一起看不出誰是誰。
  const groups = useMemo(() => {
    if (kind !== "agent") return [{ key: "all", label: null as string | null, items: list }];
    return [
      { key: "dba", label: t("DBA 審查者"), items: list.filter((e) => roleOf(e) === "dba") },
      { key: "assistant", label: t("助手"), items: list.filter((e) => roleOf(e) !== "dba") },
    ].filter((g) => g.items.length > 0);
  }, [kind, list, t]);
  const ordered = groups.flatMap((g) => g.items);
  const current = kind ? (ordered.find((e) => e.name === sel) ?? ordered[0] ?? null) : null;

  const go = async (nextTab: Tab, name: string | null = null) => {
    // 點的就是正在編輯的那一筆（還沒選過時預設選第一筆）→ 什麼都不用做。
    if (nextTab === tab && (name === sel || (name !== null && name === current?.name))) return;
    if (!(await confirmLeave())) return;
    dirtyRef.current = false;
    if (nextTab !== tab) setQ("");
    setTab(nextTab);
    setSel(name);
  };

  const create = async () => {
    if (!kind || kind === "prompt") return;
    if (!(await confirmLeave())) return;
    const name = await uiPrompt(t("名稱（小寫英數與連字號，例如 dba-team）："), { title: kind === "agent" ? t("新增人設") : t("新增技能") });
    if (!name?.trim()) return;
    try {
      await saveLibraryEntry({
        kind,
        name: name.trim(),
        layer: "personal",
        fields:
          kind === "agent"
            ? { description: t("自訂的 DBA 人設"), "dbkit-title": name.trim(), "dbkit-role": "dba", "dbkit-db-tools": "true", maxTurns: "10" }
            : { description: t("自訂技能"), "dbkit-title": name.trim() },
        body: kind === "agent" ? t("你是……（描述這位 DBA 的專長、審查重點與結論分寸：什麼情況 STOP、什麼情況 CAUTION）") : t("（描述這個技能要模型怎麼做）"),
      });
      dirtyRef.current = false;
      setQ("");
      setSel(name.trim());
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const tabs: TabDef[] = [
    { value: "agent", label: t("人設"), sub: t("AI 扮演誰"), icon: Users, count: entriesOf("agent", snap).length },
    { value: "skill", label: t("技能"), sub: t("附加的專業知識"), icon: Wand2, count: entriesOf("skill", snap).length },
    { value: "prompt", label: t("提示範本"), sub: t("每個 AI 動作的指令"), icon: FileText, count: entriesOf("prompt", snap).length },
    { value: "sources", label: t("來源與同步"), sub: t("資料夾、預設與同步"), icon: FolderOpen },
  ];
  const intro: Record<Tab, string> = {
    agent: t("人設是系統提示的開頭，決定 AI 以什麼身分、什麼標準回答。DBA 審查者用在 DBA 審查與多位 DBA 會審，助手人設用在 AI 助手；誰是預設在「來源與同步」指定。"),
    skill: t("技能是一段可重複使用的專業知識（SKILL.md），接在人設後面送出。兩種帶法：在這裡勾選 → AI 助手對話會帶上；在人設裡「預載」→ 那位 DBA 審查時一定帶上。"),
    prompt: t("提示範本是每個 AI 動作（解釋、加註解、修正、DBA 審查、自然語言轉 SQL…）送出的指令，裡面的變數會換成當下的 SQL、方言與 schema。名稱固定對應功能，所以只能修改、不能新增。"),
    sources: t("檔案放在哪裡（內建 < 個人 < 團隊，同名時後者覆蓋前者）、各功能預設用哪位人設，以及同步到 Claude Code / Codex。"),
  };
  const errCount = snap.issues.filter((i) => i.level === "error").length;
  const toggleHow = () => {
    setHowOpen((o) => {
      writeHowOpen(!o);
      return !o;
    });
  };

  return (
    <Modal open={open} onClose={() => void close()} title={t("AI 資源庫")} icon={Library} size="full" bodyClassName="p-0" className="h-[82vh]">
      <div className="flex flex-col h-full min-h-0">
        <div className="px-3 pt-3 pb-2 space-y-2 border-b border-fg/10">
          <FlowTabs tabs={tabs} value={tab} onChange={(v) => void go(v)} />
          <div className="flex items-start gap-2">
            <p className="flex-1 text-[11px] text-fg/55 leading-relaxed pt-1">{intro[tab]}</p>
            <Button variant="ghost" size="sm" icon={Info} onClick={toggleHow} aria-expanded={howOpen}>
              {howOpen ? t("收起運作方式") : t("運作方式")}
            </Button>
          </div>
          {howOpen && <HowItWorks onJump={(v, name) => void go(v, name ?? null)} />}
        </div>
        <div className="flex flex-1 min-h-0">
          {kind && (
            <div className="w-72 shrink-0 border-r border-fg/10 flex flex-col min-h-0">
              <div className="p-2 space-y-2 border-b border-fg/10">
                <div className="flex gap-1">
                  <Input inputSize="sm" className="flex-1 min-w-0" value={q} placeholder={t("搜尋…")} onChange={(e) => setQ(e.target.value)} />
                  {kind !== "prompt" && (
                    <Button variant="ghost" size="sm" icon={Plus} onClick={() => void create()} title={t("新增到個人層")} />
                  )}
                  <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => void loadAiLibrary()} title={t("重新載入")} />
                </div>
                {kind === "skill" && (
                  <div className="text-[10px] text-fg/45 leading-relaxed px-0.5">
                    {t("打勾＝AI 助手對話會帶上（已勾 {n} 個）；標「預載」＝人設預載，那位 DBA 審查時自動帶上。", { n: activeCount })}
                  </div>
                )}
              </div>
              <div className="flex-1 overflow-auto">
                {ordered.length === 0 && <div className="p-3 text-[11px] text-fg/45">{t("沒有符合的項目")}</div>}
                {groups.map((g) => (
                  <div key={g.key}>
                    {g.label && (
                      <div className="px-3 pt-2.5 pb-1 text-[10px] font-medium text-fg/40 border-b border-fg/5">
                        {g.label}
                        <span className="ml-1 tabular-nums">{g.items.length}</span>
                      </div>
                    )}
                    {g.items.map((e) => {
                      const iss = issuesOf(snap, e);
                      const active = e.kind === "skill" && activeSkills.includes(e.name);
                      const badge = statusBadge(e, t);
                      const inUse = e.kind === "agent" && personaUses(e, snap, t).length > 0;
                      // 哪些人設預載這個技能（那位 DBA 審查時一定帶上）：直接標在列表上，不必點進去才看得到。
                      const preloadBy = e.kind === "skill" ? personaEntries.filter((a) => fieldList(a.variants[""].fields, "skills").includes(e.name)) : [];
                      return (
                        <div
                          key={`${e.kind}:${e.name}`}
                          onContextMenu={e.kind === "agent" ? (ev) => { ev.preventDefault(); setPersonaMenu({ x: ev.clientX, y: ev.clientY, e }); } : undefined}
                          className={`flex items-stretch border-b border-fg/5 ${current?.name === e.name ? "bg-accent/10" : "hover:bg-fg/5"}`}
                        >
                          {/* 技能列前的勾選框 = 助手對話要不要附帶它；點其餘部分才是選取來編輯。 */}
                          {e.kind === "skill" && (
                            <label
                              className="flex items-center pl-3 cursor-pointer"
                              title={active ? t("已在助手對話啟用（點擊停用）") : t("在助手對話啟用")}
                            >
                              <input
                                type="checkbox"
                                checked={active}
                                onChange={() => toggleSkill(e.name)}
                                aria-label={t("在助手對話啟用 {name}", { name: entryTitle(e) })}
                                className="accent-blue-500"
                              />
                            </label>
                          )}
                          <button type="button" onClick={() => void go(tab, e.name)} className="flex-1 min-w-0 text-left px-3 py-2">
                            <div className="flex items-center gap-1.5">
                              {e.kind === "agent" && <Icon icon={roleOf(e) === "dba" ? Users : Bot} size={12} className="text-fg/45" />}
                              <span className="text-[12px] text-fg/90 truncate">{entryTitle(e)}</span>
                              {iss.some((i) => i.level !== "info") && <Icon icon={AlertTriangle} size={11} className="text-warning" />}
                            </div>
                            <div className="flex items-center gap-1 mt-0.5">
                              <span className="font-mono text-[10px] text-fg/40 truncate">{e.name}</span>
                              <span className="ml-auto flex items-center gap-1">
                                {inUse && <Badge tone="success">{t("使用中")}</Badge>}
                                {preloadBy.length > 0 && (
                                  <span title={t("預載它的人設：{names}（那位 DBA 審查時一定帶上）", { names: preloadBy.map((a) => entryTitle(a)).join("、") })}>
                                    <Badge tone="accent">{t("預載 ×{n}", { n: preloadBy.length })}</Badge>
                                  </span>
                                )}
                                {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                              </span>
                            </div>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
              {personaMenu && (
                <PersonaMenu
                  x={personaMenu.x}
                  y={personaMenu.y}
                  entry={personaMenu.e}
                  snap={snap}
                  onClose={() => setPersonaMenu(null)}
                />
              )}
            </div>
          )}
          <div className="flex-1 min-w-0 min-h-0">
            {tab === "sources" ? (
              <SourcesPanel snap={snap} />
            ) : current ? (
              <EntryEditor
                key={`${current.kind}:${current.name}`}
                entry={current}
                snap={snap}
                onJump={(v, name) => void go(v, name ?? null)}
                onDirtyChange={onDirtyChange}
              />
            ) : (
              <EmptyState icon={Library} title={t("沒有項目")} />
            )}
          </div>
        </div>
        {tab === "sources" && !loaded && (
          <div className="px-3 py-1.5 border-t border-fg/10 text-[11px] text-fg/50">{t("正在使用內建資源庫（尚未讀到設定目錄）。")}</div>
        )}
        {tab === "sources" && errCount > 0 && (
          <div className="px-3 py-1.5 border-t border-fg/10 text-[11px] text-danger">{t("{n} 個錯誤，見下方「檢查結果」。", { n: errCount })}</div>
        )}
      </div>
    </Modal>
  );
}
