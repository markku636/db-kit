import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  Copy,
  Eye,
  FileText,
  FolderOpen,
  FolderPlus,
  Library,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  Users,
  Wand2,
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
import { useAiSkills } from "./aiSkills";
import { sampleVars, varLabel } from "./aiTaskVars";
import { useT } from "./i18n";
import { fieldBool, fieldList, fieldStr } from "./promptTemplate";
import { Badge, Button, EmptyState, Field, Icon, Input, Modal, Segmented, Select, Textarea } from "./ui/index";
import { pickDirectory, toast, uiConfirm, uiPrompt } from "./ui";

// AI 資源庫：人設 / 技能 / 提示範本全部是 Markdown + frontmatter 的靜態檔（相容 Claude Code 與 Codex），
// 分成內建（唯讀、隨 App 升級）< 個人 < 團隊資料夾三層，同名時後者覆蓋前者。這個對話框只是檔案的
// 編輯器與總覽：分層、覆蓋、lint 都由後端做，存檔後重新拿快照。

type Tab = "agent" | "skill" | "prompt" | "sources";

const DB_TOOLS = ["list_databases", "list_tables", "describe_table", "explain_query", "run_query", "sample_rows"] as const;

function layerTone(layer: string): "neutral" | "accent" | "info" {
  if (layer === "builtin") return "neutral";
  if (layer === "personal") return "accent";
  return "info";
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

/** 可寫的層（複製 / 新增的目標）。 */
function writableLayers(snap: LibrarySnapshot, t: (s: string) => string): { id: string; label: string }[] {
  const out = [{ id: "personal", label: t("個人") }];
  snap.settings.team_dirs.forEach((d, i) => {
    if (d.writable && d.path.trim()) out.push({ id: `team:${i}`, label: d.label.trim() || `${t("團隊")} ${i + 1}` });
  });
  return out;
}

// ---------------------------------------------------------------------------
// 單筆編輯器
// ---------------------------------------------------------------------------

function EntryEditor({ entry, snap }: { entry: LibEntry; snap: LibrarySnapshot }) {
  const t = useT();
  const langs = useMemo(() => Object.keys(entry.variants).sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b))), [entry]);
  const [lang, setLang] = useState("");
  const v = entry.variants[lang] ?? entry.variants[""];
  const base = entry.variants[""];
  const isBase = lang === "";
  const writable = entry.writable && entry.layer !== "builtin";
  const targets = writableLayers(snap, t);
  const [copyTarget, setCopyTarget] = useState(targets[0]?.id ?? "personal");

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
  const [draft, setDraft] = useState(init);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  // 共用的 Textarea 不轉發 ref：從外層容器找到 textarea，才拿得到游標位置插入變數。
  const bodyWrap = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(init()), [entry, lang]);
  useEffect(() => setLang(""), [entry.kind, entry.name]);
  const original = useMemo(init, [entry, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = JSON.stringify(draft) !== JSON.stringify(original);
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
      await saveLibraryEntry({ kind: entry.kind, name: entry.name, lang, layer: entry.layer, fields, body: draft.body });
    }, t("已儲存"));

  const copyAs = async () => {
    const hint = entry.layer === "builtin" ? t("用同一個名稱就是覆蓋內建版本；換個名稱則另存一份。") : t("輸入新名稱（英數與連字號）。");
    const name = await uiPrompt(hint, { title: t("複製為自訂"), defaultValue: entry.name, confirmText: t("複製") });
    if (!name?.trim()) return;
    await run(() => copyLibraryEntry(entry.kind, entry.name, name.trim(), copyTarget), t("已複製；之後就可以直接編輯"));
  };

  const restore = async () => {
    const ok = await uiConfirm(t("刪除「{layer}」裡的這份覆蓋，改回使用較低層（內建）的版本？", { layer: entry.layerLabel }), {
      title: t("還原內建"),
      danger: true,
      confirmText: t("還原"),
    });
    if (ok) await run(() => deleteLibraryEntry(entry.kind, entry.name, entry.layer), t("已還原"));
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
        layer: entry.layer,
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

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 標頭 */}
      <div className="px-4 py-3 border-b border-fg/10 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="text-sm font-medium text-fg/90">{entryTitle(entry)}</div>
          <span className="font-mono text-[11px] text-fg/50">{entry.name}</span>
          <Badge tone={layerTone(entry.layer)}>{entry.layerLabel}</Badge>
          {entry.shadowed.length > 0 && (
            <Badge tone="warning">{t("覆蓋了 {layers}", { layers: entry.shadowed.map((s) => s.layerLabel).join(" / ") })}</Badge>
          )}
          {!writable && (
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
            {targets.length > 1 && (
              <Select selectSize="sm" className="w-28" value={copyTarget} onChange={(e) => setCopyTarget(e.target.value)}>
                {targets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </Select>
            )}
            <Button variant="ghost" size="sm" icon={Copy} disabled={busy} onClick={() => void copyAs()}>
              {t("複製為自訂")}
            </Button>
            {writable && entry.builtin && (
              <Button variant="ghost" size="sm" icon={RotateCcw} disabled={busy} onClick={() => void restore()}>
                {t("還原內建")}
              </Button>
            )}
            {writable && (!entry.builtin || !isBase) && (
              <Button variant="ghost" size="sm" icon={Trash2} disabled={busy} onClick={() => void remove()}>
                {t("刪除")}
              </Button>
            )}
          </div>
        </div>
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
          {writable && (
            <Button variant="ghost" size="sm" icon={Plus} onClick={() => void addVariant()}>
              {t("語言變體")}
            </Button>
          )}
          <span className="text-[10px] text-fg/35 ml-1">{t("日 / 韓 / 越沒有變體時用英文，再沒有就用基底檔")}</span>
        </div>
      </div>

      {/* 內容 */}
      <div className="flex-1 min-h-0 overflow-auto px-4 py-3 space-y-3">
        {!writable && (
          <div className="text-[11px] text-fg/55 bg-fg/5 rounded px-2 py-1.5 leading-relaxed">
            {entry.layer === "builtin"
              ? t("內建版本唯讀，隨 App 升級更新。要修改請「複製為自訂」：同名就是覆蓋內建，之後升級也不會蓋掉你的版本。")
              : t("這個團隊資料夾設定為唯讀；請在它的 git repo 裡修改，或複製一份到個人層。")}
          </div>
        )}
        <IssueList issues={issues} />

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("顯示名稱（dbkit-title）")}>
            <Input value={draft.title} disabled={!writable} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label={t("說明（description）")} hint={entry.kind !== "prompt" ? t("Claude Code / Codex 用它決定何時使用；必填。") : undefined}>
            <Input value={draft.description} disabled={!writable} onChange={(e) => set("description", e.target.value)} />
          </Field>
        </div>

        {entry.kind === "agent" && isBase && (
          <div className="rounded border border-fg/10 p-3 space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <Field label={t("角色")}>
                <Select value={draft.role} disabled={!writable} onChange={(e) => set("role", e.target.value)}>
                  <option value="dba">{t("DBA 審查者")}</option>
                  <option value="assistant">{t("助手")}</option>
                </Select>
              </Field>
              <Field label={t("回合上限（maxTurns）")} hint={t("DBA agent 最多查幾輪資料庫再下結論")}>
                <Input value={draft.maxTurns} disabled={!writable} placeholder="10" onChange={(e) => set("maxTurns", e.target.value.replace(/[^\d]/g, ""))} />
              </Field>
              <Field label={t("可查資料庫")}>
                <label className="flex items-center gap-2 h-8 text-xs">
                  <input type="checkbox" checked={draft.dbTools} disabled={!writable} onChange={(e) => set("dbTools", e.target.checked)} />
                  {t("允許 DBA 自己呼叫唯讀資料庫工具")}
                </label>
              </Field>
            </div>
            {draft.dbTools && (
              <Field label={t("允許的工具（tools）")} hint={t("同步到 Claude Code 時也用這份清單；不限定 = 全部唯讀工具。")}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 text-[11px] mr-2">
                    <input type="checkbox" checked={draft.restrictTools} disabled={!writable} onChange={(e) => set("restrictTools", e.target.checked)} />
                    {t("限定")}
                  </label>
                  {draft.restrictTools &&
                    DB_TOOLS.map((tool) => {
                      const on = draft.tools.includes(tool);
                      return (
                        <button
                          key={tool}
                          type="button"
                          disabled={!writable}
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
            <Field label={t("預載技能（skills）")}>
              <div className="flex flex-wrap gap-1.5">
                {skillNames.map((s) => {
                  const on = draft.skills.includes(s);
                  const se = findEntry("skill", s, snap);
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={!writable}
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
                disabled={!writable}
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
              disabled={!writable}
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
        <div className="ml-auto flex gap-2">
          {dirty && writable && (
            <Button variant="ghost" onClick={() => setDraft(original)}>
              {t("捨棄變更")}
            </Button>
          )}
          <Button variant="primary" icon={Save} disabled={!writable || !dirty || busy} onClick={() => void save()}>
            {t("儲存")}
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
  const activeSkills = useAiSkills((s) => s.selected);
  const toggleSkill = useAiSkills((s) => s.toggle);
  // 只數還存在的技能：勾選清單裡可能留著已刪除技能的名稱。
  const activeCount = entriesOf("skill", snap).filter((e) => activeSkills.includes(e.name)).length;

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
  const current = kind ? (list.find((e) => e.name === sel) ?? list[0] ?? null) : null;

  const create = async () => {
    if (!kind || kind === "prompt") return;
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
      setSel(name.trim());
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const tabs = [
    { value: "agent" as const, label: t("人設"), icon: Users },
    { value: "skill" as const, label: t("技能"), icon: Wand2 },
    { value: "prompt" as const, label: t("提示範本"), icon: FileText },
    { value: "sources" as const, label: t("來源與同步"), icon: FolderOpen },
  ];
  const errCount = snap.issues.filter((i) => i.level === "error").length;

  return (
    <Modal open={open} onClose={onClose} title={t("AI 資源庫")} icon={Library} size="full" bodyClassName="p-0" className="h-[82vh]">
      <div className="flex flex-col h-full min-h-0">
        {/* 分頁放在整個對話框上方一列：左欄只有 w-72，四個分頁連圖示塞不下（以前被擠成「人 / 設」「來源 / 與同 / 步」）。 */}
        <div className="shrink-0 px-3 py-2 border-b border-fg/10">
          <Segmented options={tabs} value={tab} onChange={(v) => { setTab(v); setSel(null); }} ariaLabel={t("AI 資源庫")} />
        </div>
        <div className="flex flex-1 min-h-0">
        <div className="w-72 shrink-0 border-r border-fg/10 flex flex-col min-h-0">
          {kind && (
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
                  {t("勾選的技能會附在助手對話的人設後面（已選 {n} 個）", { n: activeCount })}
                </div>
              )}
            </div>
          )}
          <div className="flex-1 overflow-auto">
            {kind ? (
              list.map((e) => {
                const iss = issuesOf(snap, e);
                const role = e.kind === "agent" ? fieldStr(e.variants[""].fields, "dbkit-role") : null;
                const active = e.kind === "skill" && activeSkills.includes(e.name);
                return (
                  <div
                    key={`${e.kind}:${e.name}`}
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
                    <button type="button" onClick={() => setSel(e.name)} className="flex-1 min-w-0 text-left px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        {e.kind === "agent" && <Icon icon={role === "dba" ? Users : Bot} size={12} className="text-fg/45" />}
                        <span className="text-[12px] text-fg/90 truncate">{entryTitle(e)}</span>
                        {iss.some((i) => i.level !== "info") && <Icon icon={AlertTriangle} size={11} className="text-warning" />}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="font-mono text-[10px] text-fg/40 truncate">{e.name}</span>
                        <Badge tone={layerTone(e.layer)} className="ml-auto">
                          {e.layerLabel}
                        </Badge>
                        {e.shadowed.length > 0 && <Badge tone="warning">{t("覆蓋")}</Badge>}
                      </div>
                    </button>
                  </div>
                );
              })
            ) : (
              <div className="p-3 text-[11px] text-fg/50 leading-relaxed">
                {loaded ? t("資源庫已載入。") : t("正在使用內建資源庫（尚未讀到設定目錄）。")}
                {errCount > 0 && <div className="text-danger mt-1">{t("{n} 個錯誤，見右側檢查結果。", { n: errCount })}</div>}
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 min-w-0 min-h-0">
          {tab === "sources" ? (
            <SourcesPanel snap={snap} />
          ) : current ? (
            <EntryEditor key={`${current.kind}:${current.name}:${current.layer}`} entry={current} snap={snap} />
          ) : (
            <EmptyState icon={Library} title={t("沒有項目")} />
          )}
        </div>
        </div>
      </div>
    </Modal>
  );
}
