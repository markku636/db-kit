import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, Download, FileJson, FolderOpen, Loader2, Play, Plus, RefreshCw, Save, Sparkles, Square,
} from "lucide-react";
import {
  onSpTestProgress, spTest,
  type SpTestFileEntry, type SpTestFileReport, type SpTestMode, type SpTestProgress, type SpTestScenarioReport, type SpTestVerdict,
} from "./api";
import { useStore, type SpTestRequest } from "./store";
import { pickDirectory, toast } from "./ui";
import { Badge, Button, Modal, Segmented } from "./ui/index";
import type { BadgeTone } from "./ui/index";
import CompareTargetPicker from "./CompareTargetPicker";
import type { CompareTarget } from "./compareModel";
import { useOneShotGenerate } from "./useOneShotGenerate";
import { extractFirstCodeBlock } from "./nlPrompt";
import { readStoredLang, useT } from "./i18n";

const PREFS_KEY = "dbkit.sptest.prefs";

interface Prefs {
  dir: string;
  mode: SpTestMode;
  goldenDir: string;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { dir: "", mode: "assert", goldenDir: "", ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch { /* ignore */ }
  return { dir: "", mode: "assert", goldenDir: "" };
}

function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

const VERDICT_TONE: Record<SpTestVerdict, BadgeTone> = {
  pass: "success",
  both_error: "success",
  skipped: "neutral",
  fail: "danger",
  mismatch: "danger",
  perf_fail: "danger",
  error: "warning",
  seed_error: "warning",
  error_on_one_side: "warning",
};

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** 新檔骨架（帶程序名）。 */
function templateFor(kind: string, database: string, routine: string | undefined): string {
  return JSON.stringify(
    {
      version: 1,
      target: { kind, database },
      ...(routine ? { routine } : {}),
      fixtures: { base: { steps: [{ insert: "table_name", rows: [{ id: ">>id", name: "sample" }] }] } },
      scenarios: [
        {
          id: "happy_path",
          use: ["base"],
          steps: [
            { call: routine ?? "procedure_name", params: { Param1: "<<id" }, expect: { result_sets: [{ rows: [{ column: "value" }] }], effects: { table_name: { updated: 1 } } } },
            { query: "SELECT COUNT(*) AS n FROM table_name WHERE id = @id", expect: [{ n: 1 }] },
          ],
        },
      ],
    },
    null,
    2,
  );
}

/**
 * 預存程序整合測試：資料夾裡的測試檔（JSON）→ 選目標 / 模式 → 執行 → 情境紅綠 + 差異表。
 *
 * 核心全在後端（src-tauri/src/sptest/），`dbk sp-test` 走同一份執行器與報表；這裡只負責編輯檔案、
 * 蒐集選項、呈現結果，以及把「AI 產生情境」的提示送給一次性生成。
 */
export default function SpTestDialog({ request, onClose }: { request: SpTestRequest; onClose: () => void }) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === request.connId) ?? null);
  const kind = conn?.kind ?? "mysql";
  const connLabel = conn?.name ?? request.connId;

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  useEffect(() => savePrefs(prefs), [prefs]);
  const [files, setFiles] = useState<SpTestFileEntry[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [dst, setDst] = useState<CompareTarget>({ mode: "live", connId: request.connId, db: request.database });
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SpTestProgress | null>(null);
  const [reports, setReports] = useState<SpTestFileReport[]>([]);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"editor" | "result">("editor");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const runIdRef = useRef<string | null>(null);
  const ai = useOneShotGenerate({ mode: "review" });

  const current = useMemo(() => files.find((f) => f.name === selected) ?? null, [files, selected]);

  const loadDir = useCallback(async (dir: string) => {
    if (!dir) return;
    setLoadingFiles(true);
    try {
      const list = await spTest.loadDir(dir);
      setFiles(list);
      setSelected((cur) => (cur && list.some((f) => f.name === cur) ? cur : list[0]?.name ?? null));
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
      setFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  useEffect(() => { void loadDir(prefs.dir); }, [prefs.dir, loadDir]);
  useEffect(() => {
    if (current) { setText(current.text); setErrors(current.errors); setDirty(false); }
  }, [current]);

  const pickDir = async () => {
    const d = await pickDirectory();
    if (d) setPrefs((p) => ({ ...p, dir: d, goldenDir: p.goldenDir || joinPath(d, "golden") }));
  };

  const save = async () => {
    if (!current) return;
    try {
      const errs = await spTest.saveFile(current.path, text);
      setErrors(errs);
      setDirty(false);
      setFiles((fs) => fs.map((f) => (f.name === current.name ? { ...f, text, errors: errs } : f)));
      toast.success(t("已儲存"));
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const createFile = async () => {
    if (!prefs.dir) { toast.error(t("請先選擇測試資料夾")); return; }
    const base = (request.routine ?? "new_test").replace(/[^\w.-]+/g, "_");
    let name = `${base}.json`;
    let i = 2;
    while (files.some((f) => f.name === name)) name = `${base}_${i++}.json`;
    const path = joinPath(prefs.dir, name);
    try {
      const body = templateFor(kind, request.database, request.routine);
      await spTest.saveFile(path, body);
      await loadDir(prefs.dir);
      setSelected(name);
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  // AI 產生情境：後端組提示（盤點 + schema），一次性生成，回覆的 JSON 區塊放進編輯器（不自動存檔）。
  const generate = async () => {
    if (!request.routine) { toast.error(t("請從程序右鍵開啟，才能產生情境")); return; }
    try {
      const prompt = await spTest.testgenPrompt(request.connId, request.database, request.routine, readStoredLang());
      await ai.run(prompt);
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };
  useEffect(() => {
    if (ai.running || !ai.text) return;
    const block = extractFirstCodeBlock(ai.text, ["json"]) ?? ai.text;
    try {
      const parsed = JSON.parse(block);
      const pretty = JSON.stringify(parsed, null, 2);
      setText(pretty);
      setDirty(true);
      setTab("editor");
      void spTest.validate(pretty).then(setErrors).catch(() => {});
      ai.reset();
      if (!current && prefs.dir) {
        void createFile();
      }
    } catch {
      // 不是 JSON：留在原文讓使用者看
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.running, ai.text]);

  const run = async () => {
    if (running) return;
    const list = current ? [{ name: current.name, text }] : files.map((f) => ({ name: f.name, text: f.text }));
    if (list.length === 0) { toast.error(t("沒有測試檔")); return; }
    const targets = [{ conn_id: request.connId, database: request.database }];
    if (prefs.mode === "diff") {
      if (dst.mode !== "live") { toast.error(t("差分的目標必須是連線")); return; }
      targets.push({ conn_id: dst.connId, database: dst.db });
    }
    const runId = crypto.randomUUID();
    runIdRef.current = runId;
    setRunning(true);
    setRunErr(null);
    setProgress(null);
    setTab("result");
    const unlisten = await onSpTestProgress(runId, setProgress);
    try {
      const res = await spTest.run({
        runId, targets, files: list, mode: prefs.mode,
        goldenDir: prefs.mode === "golden" || prefs.mode === "record" ? prefs.goldenDir : null,
      });
      setReports(res);
      const bad = res.flatMap((r) => r.scenarios).filter((s) => !["pass", "skipped", "both_error"].includes(s.verdict)).length;
      if (bad === 0) toast.success(t("全部通過")); else toast.error(t("{n} 個情境未通過", { n: bad }));
    } catch (e: any) {
      setRunErr(e?.message ?? String(e));
    } finally {
      unlisten();
      runIdRef.current = null;
      setRunning(false);
    }
  };

  const cancel = () => {
    const id = runIdRef.current;
    if (id) void spTest.cancel(id).catch(() => {});
  };

  const exportReports = async () => {
    if (!prefs.dir || reports.length === 0) return;
    try {
      const [junit, md] = await spTest.export(prefs.dir, reports);
      toast.success(t("已寫入報表：{path}", { path: `${junit}, ${md}` }));
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    }
  };

  const toggle = (key: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const verdictLabel = (v: SpTestVerdict) => ({
    pass: t("通過"), fail: t("失敗"), error: t("錯誤"), seed_error: t("前置失敗"), skipped: t("略過"),
    mismatch: t("不一致"), error_on_one_side: t("單邊出錯"), both_error: t("兩邊皆錯"), perf_fail: t("效能未達標"),
  })[v];

  const scenarioRow = (s: SpTestScenarioReport, fileName: string) => {
    const key = `${fileName}:${s.id}:${s.case ?? ""}`;
    const diffs = s.steps.flatMap((st) => st.differences.map((d) => ({ ...d, step: st.label })));
    const open = expanded.has(key);
    return (
      <div key={key} className="border-b border-line/50">
        <button type="button" onClick={() => toggle(key)}
          className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-fg/5">
          {open ? <ChevronDown size={14} className="shrink-0 text-fg/50" /> : <ChevronRight size={14} className="shrink-0 text-fg/50" />}
          <Badge tone={VERDICT_TONE[s.verdict]}>{verdictLabel(s.verdict)}</Badge>
          <span className="text-sm truncate">{s.id}{s.case ? ` / ${s.case}` : ""}</span>
          <span className="ml-auto text-xs text-fg/50 tabular-nums">{s.elapsed_ms} ms</span>
        </button>
        {open && (
          <div className="px-3 pb-2 text-xs space-y-1">
            {s.error && <div className="text-danger">{s.error}</div>}
            {s.skipped !== undefined && s.skipped !== null && <div className="text-fg/60">{t("略過")}{s.skipped ? `：${s.skipped}` : ""}</div>}
            {diffs.length === 0 && !s.error && <div className="text-fg/60">{t("沒有差異")}</div>}
            {diffs.length > 0 && (
              <table className="w-full text-xs">
                <thead><tr className="text-fg/50 text-left"><th className="pr-2">{t("步驟")}</th><th className="pr-2">{t("類型")}</th><th className="pr-2">{t("位置")}</th><th className="pr-2">{t("期望")}</th><th className="pr-2">{t("實際")}</th><th>{t("備註")}</th></tr></thead>
                <tbody>
                  {diffs.map((d, i) => (
                    <tr key={i} className="align-top border-t border-line/40">
                      <td className="pr-2 whitespace-nowrap">{d.step}</td>
                      <td className="pr-2 whitespace-nowrap"><Badge tone="danger">{d.kind}</Badge></td>
                      <td className="pr-2 font-mono">{d.where}</td>
                      <td className="pr-2 font-mono break-all">{d.expected ?? ""}</td>
                      <td className="pr-2 font-mono break-all">{d.actual ?? ""}</td>
                      <td className="text-fg/60">{d.note ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    );
  };

  const modeOptions: { value: SpTestMode; label: string }[] = [
    { value: "assert", label: t("斷言") },
    { value: "golden", label: t("基線") },
    { value: "record", label: t("錄基線") },
    { value: "diff", label: t("差分") },
  ];

  return (
    <Modal title={`${t("預存程序整合測試")} — ${connLabel} / ${request.database}${request.routine ? ` / ${request.routine}` : ""}`}
      size="xl" onClose={onClose} bodyClassName="p-0 overflow-hidden flex flex-col" dismissOnBackdrop={false}>
      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line">
        <Button size="sm" variant="secondary" icon={FolderOpen} onClick={() => void pickDir()} data-testid="sp-test-pick-dir">
          {prefs.dir ? prefs.dir : t("選擇測試資料夾…")}
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void loadDir(prefs.dir)} disabled={!prefs.dir || loadingFiles} />
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => void createFile()} disabled={!prefs.dir}>{t("新檔")}</Button>
        <Segmented options={modeOptions} value={prefs.mode} onChange={(mode) => setPrefs((p) => ({ ...p, mode }))} />
        {(prefs.mode === "golden" || prefs.mode === "record") && (
          <input className="h-7 px-2 text-xs rounded border border-line bg-transparent w-56" value={prefs.goldenDir}
            placeholder={t("基線資料夾")} onChange={(e) => setPrefs((p) => ({ ...p, goldenDir: e.target.value }))} />
        )}
        {prefs.mode === "diff" && (
          <div className="min-w-[260px]">
            <CompareTargetPicker srcConnId={request.connId} srcKind={kind} srcDb={request.database} withTable={false} allowSnapshot={false}
              value={dst} onChange={setDst} disabled={running} />
          </div>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => void generate()} loading={ai.running}
            disabled={!request.routine || running} data-testid="sp-test-generate">{t("AI 產生情境")}</Button>
          <Button size="sm" variant="ghost" icon={Download} onClick={() => void exportReports()} disabled={reports.length === 0}>{t("匯出報表")}</Button>
          {running
            ? <Button size="sm" variant="danger" icon={Square} onClick={cancel}>{t("停止")}</Button>
            : <Button size="sm" variant="primary" icon={Play} onClick={() => void run()} disabled={files.length === 0} data-testid="sp-test-run">{t("執行")}</Button>}
        </div>
      </div>

      <div className="flex-1 min-h-0 flex">
        {/* 左：檔案 */}
        <div className="w-60 shrink-0 border-r border-line overflow-auto">
          {files.length === 0 && (
            <div className="p-3 text-xs text-fg/60">{prefs.dir ? t("資料夾裡沒有測試檔") : t("選一個資料夾存放測試檔；每支程序一個 JSON。")}</div>
          )}
          {files.map((f) => {
            const rep = reports.find((r) => r.file === f.name);
            const bad = rep?.scenarios.filter((s) => !["pass", "skipped", "both_error"].includes(s.verdict)).length ?? 0;
            return (
              <button key={f.name} type="button" onClick={() => setSelected(f.name)} data-testid="sp-test-file"
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-fg/5 ${selected === f.name ? "bg-fg/10" : ""}`}>
                <FileJson size={14} className="shrink-0 text-fg/60" />
                <span className="truncate">{f.name}</span>
                {f.errors.length > 0 && <Badge tone="warning">{f.errors.length}</Badge>}
                {rep && <Badge tone={bad ? "danger" : "success"} className="ml-auto">{bad ? `${bad}✗` : "✓"}</Badge>}
              </button>
            );
          })}
        </div>

        {/* 右：編輯器 / 結果 */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line">
            <Segmented options={[{ value: "editor", label: t("測試檔") }, { value: "result", label: t("結果") }]} value={tab} onChange={setTab} />
            {tab === "editor" && (
              <>
                <Button size="sm" variant={dirty ? "primary" : "ghost"} icon={Save} onClick={() => void save()} disabled={!current || !dirty}>{t("儲存")}</Button>
                {errors.length > 0 && <Badge tone="warning">{t("{n} 個問題", { n: errors.length })}</Badge>}
              </>
            )}
            {running && progress && (
              <span className="ml-auto flex items-center gap-1 text-xs text-fg/60">
                <Loader2 size={12} className="animate-spin" />
                {progress.scenario}{progress.case ? `/${progress.case}` : ""}{progress.step ? ` · ${progress.step}` : ""} ({progress.index + 1}/{progress.total})
              </span>
            )}
          </div>
          {tab === "editor" ? (
            <div className="flex-1 min-h-0 flex flex-col">
              {errors.length > 0 && (
                <ul className="px-3 py-1 text-xs text-warning space-y-0.5 border-b border-line max-h-24 overflow-auto">
                  {errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
              {ai.running && (
                <div className="px-3 py-1 text-xs text-fg/60 flex items-center gap-1 border-b border-line">
                  <Loader2 size={12} className="animate-spin" />{t("AI 產生中…")}
                  <button type="button" className="ml-2 underline" onClick={ai.cancel}>{t("停止")}</button>
                </div>
              )}
              {ai.error && <div className="px-3 py-1 text-xs text-danger border-b border-line">{ai.error}</div>}
              <textarea className="flex-1 min-h-0 w-full p-3 font-mono text-xs bg-transparent outline-none resize-none" spellCheck={false}
                value={text} placeholder={t("選一個測試檔，或按「新檔」/「AI 產生情境」")}
                onChange={(e) => { setText(e.target.value); setDirty(true); }} data-testid="sp-test-editor" />
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto" data-testid="sp-test-results">
              {runErr && <div className="p-3 text-sm text-danger">{runErr}</div>}
              {reports.length === 0 && !runErr && <div className="p-3 text-xs text-fg/60">{running ? t("執行中…") : t("還沒有執行結果")}</div>}
              {reports.map((r) => (
                <div key={r.file}>
                  <div className="px-2 py-1 text-xs text-fg/60 bg-fg/5">{r.file} · {r.mode} · {r.targets.join(" ↔ ")}</div>
                  {r.scenarios.map((s) => scenarioRow(s, r.file))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
