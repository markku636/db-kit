import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown, ChevronRight, CircleHelp, Copy, Download, ExternalLink, FileJson, FolderOpen, ListPlus,
  Loader2, Play, Plus, RefreshCw, RotateCcw, Save, Sparkles, Square, Terminal,
} from "lucide-react";
import {
  api, onSpTestProgress, spTest,
  type SpTestFileEntry, type SpTestFileReport, type SpTestMode, type SpTestProgress, type SpTestScenarioReport, type SpTestVerdict,
} from "./api";
import { useStore, type SpTestRequest } from "./store";
import { copyToClipboard, pickDirectory, toast } from "./ui";
import { Badge, Button, Modal, Segmented } from "./ui/index";
import type { BadgeTone } from "./ui/index";
import CompareTargetPicker from "./CompareTargetPicker";
import type { CompareTarget } from "./compareModel";
import { useOneShotGenerate } from "./useOneShotGenerate";
import { extractFirstCodeBlock } from "./nlPrompt";
import { readStoredLang, useT } from "./i18n";
import {
  adoptActual, buildCliCommand, countVerdicts, expandedSteps, insertRecipe, isGreen, mergeReports, RECIPE_KEYS,
  scenarioKey, type RecipeKey, type SpStepOutcome,
} from "./spTestModel";
import SpTestStepRow from "./SpTestStepRow";

const PREFS_KEY = "dbkit.sptest.prefs";
const DOCS_URL = "https://github.com/markku636/db-kit/blob/main/docs/sp-test.md";

interface Prefs {
  dir: string;
  mode: SpTestMode;
  goldenDir: string;
  /** 說明面板是否展開（第一次開預設展開）。 */
  help: boolean;
}

function loadPrefs(): Prefs {
  const base: Prefs = { dir: "", mode: "assert", goldenDir: "", help: true };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) return { ...base, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch { /* ignore */ }
  return base;
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

/** 沒有程序可盤點時的新檔骨架（從資料庫右鍵開、或盤點失敗）。 */
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
 * 預存程序整合測試：資料夾裡的測試檔（JSON）→ 選目標 / 模式 → 執行 → 情境紅綠、逐步實際輸出、差異表。
 *
 * 核心全在後端（src-tauri/src/sptest/），`dbk sp-test` 走同一份執行器與報表；這裡負責編輯檔案、
 * 蒐集選項、呈現結果，以及幾個讓新手上手的捷徑：從程序產生骨架、範例情境庫、「採用實際值」寫回期望、
 * 只重跑單一情境、對應的 CLI 指令。純邏輯在 spTestModel.ts（有單元測試）。
 */
export default function SpTestDialog({ request, onClose }: { request: SpTestRequest; onClose: () => void }) {
  const t = useT();
  const conn = useStore((s) => s.connections.find((c) => c.id === request.connId) ?? null);
  const connections = useStore((s) => s.connections);
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
  const [onlyFailed, setOnlyFailed] = useState(false);
  /** 範例選單的位置（開著時才有）：用 portal + fixed 畫在對話框之上，才不會被 Modal 的 overflow 裁掉。 */
  const [recipeAt, setRecipeAt] = useState<{ left: number; top: number; maxH: number } | null>(null);
  const recipeOpen = recipeAt !== null;
  const [creating, setCreating] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const recipeRef = useRef<HTMLDivElement>(null);
  const recipeMenuRef = useRef<HTMLDivElement>(null);
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

  // 範例選單：點外面關閉（Esc 交給 Modal——選單開著時先關選單）。
  useEffect(() => {
    if (!recipeOpen) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!recipeRef.current?.contains(n) && !recipeMenuRef.current?.contains(n)) setRecipeAt(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); setRecipeAt(null); }
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [recipeOpen]);

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

  // 新檔：從程序開啟時先盤點產生骨架（前置資料、參數、錯誤分支），失敗才退回通用範本。
  const createFile = async (body?: string) => {
    if (!prefs.dir) { toast.error(t("請先選擇測試資料夾")); return; }
    const base = (request.routine ?? "new_test").replace(/[^\w.-]+/g, "_");
    let name = `${base}.json`;
    let i = 2;
    while (files.some((f) => f.name === name)) name = `${base}_${i++}.json`;
    const path = joinPath(prefs.dir, name);
    setCreating(true);
    try {
      let content = body;
      if (content === undefined && request.routine) {
        try {
          content = await spTest.scaffold(request.connId, request.database, request.routine);
        } catch (e: any) {
          toast.error(t("產生骨架失敗，改用通用範本：{e}", { e: e?.message ?? String(e) }));
        }
      }
      await spTest.saveFile(path, content ?? templateFor(kind, request.database, request.routine));
      await loadDir(prefs.dir);
      setSelected(name);
      setTab("editor");
      if (request.routine && body === undefined) toast.success(t("已從 {routine} 產生骨架：先執行一次看實際輸出", { routine: request.routine }));
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setCreating(false);
    }
  };

  const toggleRecipes = () => {
    if (recipeOpen) { setRecipeAt(null); return; }
    const r = recipeRef.current?.getBoundingClientRect();
    if (!r) return;
    const top = r.bottom + 4;
    setRecipeAt({ left: Math.min(r.left, window.innerWidth - 300), top, maxH: Math.max(160, window.innerHeight - top - 8) });
  };

  const insertExample = (key: RecipeKey) => {
    setRecipeAt(null);
    const res = insertRecipe(text || templateFor(kind, request.database, request.routine), key, request.routine);
    if (!res.ok) { toast.error(t("測試檔不是有效的 JSON，無法插入範例")); return; }
    setText(res.text);
    setDirty(true);
    setTab("editor");
    void spTest.validate(res.text).then(setErrors).catch(() => {});
    toast.success(t("已插入情境「{id}」：把佔位的表名 / 參數 / 值換成自己的", { id: res.id }));
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
      ai.reset();
      if (!current && prefs.dir) {
        void createFile(pretty);
        return;
      }
      setText(pretty);
      setDirty(true);
      setTab("editor");
      void spTest.validate(pretty).then(setErrors).catch(() => {});
    } catch {
      // 不是 JSON：留在原文讓使用者看
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.running, ai.text]);

  /** 檔名 → 要送去跑的文字（目前開著的檔用編輯器內容，未存檔的修改也算）。 */
  const textOf = useCallback((name: string) => (current && current.name === name ? text : files.find((f) => f.name === name)?.text ?? ""), [current, files, text]);

  const targetsFor = (): { conn_id: string; database: string }[] | null => {
    const targets = [{ conn_id: request.connId, database: request.database }];
    if (prefs.mode === "diff") {
      if (dst.mode !== "live") { toast.error(t("差分的目標必須是連線")); return null; }
      targets.push({ conn_id: dst.connId, database: dst.db });
    }
    return targets;
  };

  /** 執行。`scope` 有給 = 只重跑某檔的某些情境，結果併回原報表。 */
  const run = async (scope?: { file: string; only: string[] }) => {
    if (running) return;
    const list = scope
      ? [{ name: scope.file, text: textOf(scope.file) }]
      : current ? [{ name: current.name, text }] : files.map((f) => ({ name: f.name, text: f.text }));
    if (list.length === 0) { toast.error(t("沒有測試檔")); return; }
    const targets = targetsFor();
    if (!targets) return;
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
        only: scope ? scope.only : null,
      });
      const merged = scope ? mergeReports(reports, res) : res;
      setReports(merged);
      const bad = res.flatMap((r) => r.scenarios).filter((s) => !isGreen(s.verdict)).length;
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

  const verdictHelp = (v: SpTestVerdict) => ({
    pass: t("每一步都符合期望（基線 / 差分模式另外比對也一致）"),
    fail: t("有步驟的實際輸出與期望不符：展開看差異表"),
    error: t("沒寫 expect_error 卻出錯、或連線 / 測試檔本身有問題；出錯後的步驟不再跑"),
    seed_error: t("fixture / insert 前置資料灌不進去，情境沒有真正開始"),
    skipped: t("情境帶 skip，沒有執行"),
    mismatch: t("差分模式：兩個連線的輸出不同"),
    error_on_one_side: t("差分模式：只有一邊出錯"),
    both_error: t("差分模式：兩邊都出錯且錯誤類別相同，視為一致"),
    perf_fail: t("效能門檻未達標"),
  })[v];

  const modeOptions: { value: SpTestMode; label: string }[] = [
    { value: "assert", label: t("斷言") },
    { value: "golden", label: t("基線") },
    { value: "record", label: t("錄基線") },
    { value: "diff", label: t("差分") },
  ];
  const modeHelp: Record<SpTestMode, string> = {
    assert: t("比對測試檔裡寫的期望。日常開發用。"),
    golden: t("比期望，也比上次錄下的基線：程序行為一變就紅燈（CI 回歸用）。"),
    record: t("把每一步的實際輸出錄成基線檔（golden/），之後用「基線」模式比。"),
    diff: t("同一份測試檔在兩個連線各跑一次、逐步互比（例如 SQL Server → PostgreSQL 遷移驗證）。"),
  };

  const recipeLabel: Record<RecipeKey, [string, string]> = {
    happy: [t("正常流程"), t("呼叫 → 比結果集與副作用")],
    error: [t("預期錯誤"), t("錯的輸入要被程序擋下（expect_error）")],
    out: [t("OUT 參數"), t("擷取 OUT 參數再拿去查")],
    cases: [t("資料驅動"), t("同一組步驟、不同參數（cases）")],
    flow: [t("業務流程"), t("多支程序串起來，中間查狀態")],
    invariant: [t("不變量"), t("加總 / 計數在流程前後要守恆")],
    strict: [t("不准動其他表"), t("effects_strict：沒列出的表有變化就失敗")],
    compare: [t("前後比對"), t("擷取整個結果集，做完再比一次（compare）")],
  };

  // CLI：目前設定的等價指令（測試資料夾；有選檔時用那個檔）。
  const cliCommand = useMemo(() => {
    const dstConn = connections.find((c) => c.id === (dst.mode === "live" ? dst.connId : ""));
    return buildCliCommand({
      mode: prefs.mode,
      path: prefs.dir ? (current ? current.path : prefs.dir) : "tests/",
      conn: connLabel,
      database: request.database,
      goldenDir: prefs.goldenDir,
      dst: prefs.mode === "diff" && dst.mode === "live" ? { conn: dstConn?.name ?? dst.connId, database: dst.db } : null,
    });
  }, [prefs.mode, prefs.dir, prefs.goldenDir, current, connLabel, request.database, dst, connections]);

  const counts = useMemo(() => countVerdicts(reports), [reports]);
  const failedCount = counts.filter((c) => !isGreen(c.verdict)).reduce((n, c) => n + c.n, 0);

  // ---- 單一步驟：可採用實際值的條件——單一引擎、非 case、檔案是編輯器裡那份、情境自己的 call / query / sql ----
  const stepRow = (r: SpTestFileReport, s: SpTestScenarioReport, i: number) => {
    const st = s.steps[i];
    const source = expandedSteps(textOf(r.file), s.id)?.[i];
    const canAdopt = r.mode !== "diff" && !s.case && current?.name === r.file && !!source && !source.fixture && ["call", "query", "sql"].includes(source.kind);
    const adopt = (o: SpStepOutcome) => {
      const res = adoptActual(text, s.id, i, o);
      if (!res.ok) { toast.error(t("無法採用：{reason}", { reason: res.reason })); return; }
      setText(res.text);
      setDirty(true);
      void spTest.validate(res.text).then(setErrors).catch(() => {});
      toast.success(t("已把實際值寫進 {step} 的期望：檢查後儲存，再執行一次", { step: st.label }));
    };
    return (
      <SpTestStepRow key={`${r.file}:${scenarioKey(s)}:${i}`} label={st.label} outcomes={st.outcomes} differenceCount={st.differences.length}
        source={source} onAdopt={canAdopt ? adopt : undefined} />
    );
  };

  const scenarioRow = (r: SpTestFileReport, s: SpTestScenarioReport) => {
    const key = `${r.file}:${scenarioKey(s)}`;
    const diffs = s.steps.flatMap((st) => st.differences.map((d) => ({ ...d, step: st.label })));
    const open = expanded.has(key);
    return (
      <div key={key} className="border-b border-line/50" data-sp-scenario={scenarioKey(s)}>
        <div className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-fg/5">
          <button type="button" onClick={() => toggle(key)} className="flex items-center gap-2 flex-1 min-w-0 text-left">
            {open ? <ChevronDown size={14} className="shrink-0 text-fg/50" /> : <ChevronRight size={14} className="shrink-0 text-fg/50" />}
            <span title={verdictHelp(s.verdict)}><Badge tone={VERDICT_TONE[s.verdict]}>{verdictLabel(s.verdict)}</Badge></span>
            <span className="text-sm truncate">{s.id}{s.case ? ` / ${s.case}` : ""}</span>
            {diffs.length > 0 && <span className="text-xs text-danger shrink-0">{t("{n} 處差異", { n: diffs.length })}</span>}
          </button>
          <button type="button" className="shrink-0 p-1 rounded hover:bg-fg/10 text-fg/60 disabled:opacity-40" disabled={running}
            title={t("只重跑這個情境")} data-sp-rerun={scenarioKey(s)} onClick={() => void run({ file: r.file, only: [scenarioKey(s)] })}>
            <RotateCcw size={13} />
          </button>
          <span className="text-xs text-fg/50 tabular-nums w-14 text-right">{s.elapsed_ms} ms</span>
        </div>
        {open && (
          <div className="px-3 pb-2 text-xs space-y-2">
            <div className="text-fg/50">{verdictHelp(s.verdict)}</div>
            {s.error && <div className="text-danger whitespace-pre-wrap">{s.error}</div>}
            {s.skipped !== undefined && s.skipped !== null && <div className="text-fg/60">{t("略過")}{s.skipped ? `：${s.skipped}` : ""}</div>}
            {s.steps.length > 0 && (
              <div className="border border-line/50 rounded" data-sp-steps>
                <div className="px-2 py-1 text-fg/50 bg-fg/5">{t("步驟（點一下看實際輸出）")}</div>
                {s.steps.map((_, i) => stepRow(r, s, i))}
              </div>
            )}
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

  const helpPanel = (
    <div className="border-b border-line bg-fg/[0.03] px-3 py-2 text-xs grid gap-3 md:grid-cols-3" data-testid="sp-test-help">
      <div className="space-y-1">
        <div className="font-medium">{t("三步上手")}</div>
        <ol className="list-decimal pl-4 space-y-0.5 text-fg/70">
          <li>{request.routine ? t("按「新檔」：從 {routine} 產生骨架（前置資料、參數、每個錯誤分支一個情境）", { routine: request.routine }) : t("按「新檔」或「插入範例」；從程序右鍵開啟可直接產生骨架")}</li>
          <li>{t("按「執行」，在「結果」展開情境，點步驟看實際輸出")}</li>
          <li>{t("對的就按「採用實際值」寫成期望、儲存；之後改了程序再跑，紅燈就是行為變了")}</li>
        </ol>
        <div className="text-fg/50 pt-1">{t("每個情境在交易裡跑完自動 rollback，不會留下資料。")}</div>
      </div>
      <div className="space-y-1">
        <div className="font-medium">{t("模式")} · <span className="text-fg/60">{modeOptions.find((m) => m.value === prefs.mode)?.label}</span></div>
        <div className="text-fg/70">{modeHelp[prefs.mode]}</div>
        <div className="font-medium pt-1">{t("符號")}</div>
        <div className="text-fg/70 font-mono leading-5">
          <div>"&gt;&gt;oid" <span className="font-sans text-fg/50">{t("擷取（自動編號、OUT、結果集的欄）")}</span></div>
          <div>"&lt;&lt;oid" <span className="font-sans text-fg/50">{t("引用；SQL 裡寫 @oid")}</span></div>
          <div>"total?" <span className="font-sans text-fg/50">{t("欄名加 ? = 只比值、不當配對鍵")}</span></div>
        </div>
      </div>
      <div className="space-y-1 min-w-0">
        <div className="font-medium">{t("同樣的事用 CLI / CI")}</div>
        <div className="flex items-start gap-1">
          <code className="flex-1 min-w-0 break-all rounded bg-fg/5 px-1.5 py-1 font-mono text-[11px]" data-testid="sp-test-cli">{cliCommand}</code>
          <button type="button" className="p-1 rounded hover:bg-fg/10" title={t("複製")} onClick={() => void copyToClipboard(cliCommand)}><Copy size={12} /></button>
        </div>
        <div className="text-fg/50">{t("加 --junit report.xml --exit-code 就能進 CI；dbk sp-test list 列出可用的 --only 名稱。")}</div>
        <button type="button" className="inline-flex items-center gap-1 text-accent hover:underline" onClick={() => void api.openExternal(DOCS_URL).catch(() => {})}>
          <ExternalLink size={11} />{t("完整說明與 8 個範例")}
        </button>
      </div>
    </div>
  );

  return (
    <Modal title={`${t("預存程序整合測試")} — ${connLabel} / ${request.database}${request.routine ? ` / ${request.routine}` : ""}`}
      size="xl" className="h-[86vh]" onClose={onClose} bodyClassName="p-0 overflow-hidden flex flex-col min-h-0" dismissOnBackdrop={false}>
      {/* 工具列 */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-line">
        <Button size="sm" variant="secondary" icon={FolderOpen} onClick={() => void pickDir()} data-testid="sp-test-pick-dir">
          {prefs.dir ? prefs.dir : t("選擇測試資料夾…")}
        </Button>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void loadDir(prefs.dir)} disabled={!prefs.dir || loadingFiles} />
        <Button size="sm" variant="ghost" icon={Plus} onClick={() => void createFile()} disabled={!prefs.dir} loading={creating}
          title={request.routine ? t("從 {routine} 產生測試檔骨架", { routine: request.routine }) : undefined} data-testid="sp-test-new">{t("新檔")}</Button>
        <div className="relative" ref={recipeRef}>
          <Button size="sm" variant="ghost" icon={ListPlus} onClick={toggleRecipes} data-testid="sp-test-recipes">{t("插入範例")}</Button>
          {recipeAt && createPortal(
            <div ref={recipeMenuRef} className="fixed z-[100] w-72 overflow-auto rounded border border-fg/10 bg-elevated shadow-2xl py-1" role="menu"
              style={{ left: recipeAt.left, top: recipeAt.top, maxHeight: recipeAt.maxH }}>
              {RECIPE_KEYS.map((k) => (
                <button key={k} type="button" role="menuitem" data-sp-recipe={k} onClick={() => insertExample(k)}
                  className="w-full text-left px-3 py-1.5 hover:bg-fg/5">
                  <div className="text-sm">{recipeLabel[k][0]}</div>
                  <div className="text-xs text-fg/50">{recipeLabel[k][1]}</div>
                </button>
              ))}
            </div>,
            document.body,
          )}
        </div>
        <span title={modeHelp[prefs.mode]}>
          <Segmented options={modeOptions} value={prefs.mode} onChange={(mode) => setPrefs((p) => ({ ...p, mode }))} />
        </span>
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
          <Button size="sm" variant="ghost" icon={Terminal} onClick={() => void copyToClipboard(cliCommand, t("已複製 CLI 指令"))}
            title={cliCommand} data-testid="sp-test-copy-cli">{t("CLI")}</Button>
          <Button size="sm" variant="ghost" icon={Download} onClick={() => void exportReports()} disabled={reports.length === 0}>{t("匯出報表")}</Button>
          <Button size="sm" variant={prefs.help ? "secondary" : "ghost"} icon={CircleHelp} onClick={() => setPrefs((p) => ({ ...p, help: !p.help }))}
            data-testid="sp-test-help-toggle">{t("使用說明")}</Button>
          {running
            ? <Button size="sm" variant="danger" icon={Square} onClick={cancel}>{t("停止")}</Button>
            : <Button size="sm" variant="primary" icon={Play} onClick={() => void run()} disabled={files.length === 0} data-testid="sp-test-run">{t("執行")}</Button>}
        </div>
      </div>
      {prefs.help && helpPanel}

      <div className="flex-1 min-h-0 flex">
        {/* 左：檔案 */}
        <div className="w-60 shrink-0 border-r border-line overflow-auto">
          {files.length === 0 && (
            <div className="p-3 text-xs text-fg/60 space-y-2">
              <div>{prefs.dir ? t("資料夾裡沒有測試檔") : t("選一個資料夾存放測試檔；每支程序一個 JSON。")}</div>
              {prefs.dir && <div>{request.routine ? t("按「新檔」從 {routine} 產生骨架。", { routine: request.routine }) : t("按「新檔」建立範本，或從程序右鍵開啟以產生骨架。")}</div>}
            </div>
          )}
          {files.map((f) => {
            const rep = reports.find((r) => r.file === f.name);
            const bad = rep?.scenarios.filter((s) => !isGreen(s.verdict)).length ?? 0;
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
            {tab === "result" && counts.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap" data-testid="sp-test-summary">
                {counts.map((c) => (
                  <span key={c.verdict} title={verdictHelp(c.verdict)}><Badge tone={VERDICT_TONE[c.verdict]}>{verdictLabel(c.verdict)} {c.n}</Badge></span>
                ))}
                <label className="flex items-center gap-1 text-xs text-fg/70 ml-1 cursor-pointer">
                  <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} data-testid="sp-test-only-failed" />
                  {t("只看未通過")}
                </label>
                {failedCount > 0 && !running && (
                  <button type="button" className="text-xs text-accent hover:underline" data-testid="sp-test-rerun-failed"
                    onClick={() => {
                      const r = reports.find((x) => x.scenarios.some((s) => !isGreen(s.verdict)));
                      if (r) void run({ file: r.file, only: r.scenarios.filter((s) => !isGreen(s.verdict)).map(scenarioKey) });
                    }}>
                    {t("重跑未通過")}
                  </button>
                )}
              </div>
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
                value={text} placeholder={t("選一個測試檔，或按「新檔」/「插入範例」/「AI 產生情境」")}
                onChange={(e) => { setText(e.target.value); setDirty(true); }} data-testid="sp-test-editor" />
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto" data-testid="sp-test-results">
              {runErr && <div className="p-3 text-sm text-danger">{runErr}</div>}
              {reports.length === 0 && !runErr && <div className="p-3 text-xs text-fg/60">{running ? t("執行中…") : t("還沒有執行結果")}</div>}
              {reports.map((r) => {
                const shown = onlyFailed ? r.scenarios.filter((s) => !isGreen(s.verdict)) : r.scenarios;
                return (
                  <div key={r.file}>
                    <div className="px-2 py-1 text-xs text-fg/60 bg-fg/5">{r.file} · {r.mode} · {r.targets.join(" ↔ ")}</div>
                    {shown.map((s) => scenarioRow(r, s))}
                    {shown.length === 0 && <div className="px-3 py-2 text-xs text-fg/50">{t("這個檔案的情境都通過了")}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
