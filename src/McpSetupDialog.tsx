import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Copy, Eye, EyeOff, FolderOpen, KeyRound, Play, PlugZap, RotateCw, Server, ShieldAlert, ShieldCheck, Square, Trash2,
} from "lucide-react";
import { api } from "./api";
import { useT } from "./i18n";
import { useStore } from "./store";
import { copyToClipboard, pickDirectory, toast, uiConfirm } from "./ui";
import { Badge, Button, Field, Icon, IconButton, Input, Modal, Segmented, Select } from "./ui/index";
import {
  isMcpKind, isProd, sameServerArgs, serverArgsOf, writableCount, useMcpDialog,
  type McpClientId, type McpFormState, type McpHttpStatus, type McpPreview, type McpSetupInfo, type McpSetupReq,
} from "./mcpSetup";

// 「MCP 設定」：把 dbk 接到 Claude Code / Codex / Cursor / VS Code / Claude Desktop / Windsurf。
//
// 由上而下就是使用者要做的決定：開放哪些連線 → 給不給寫 → 用哪個 AI 工具、怎麼連 → 看設定內容、一鍵寫入。
// 設定片段與寫檔都在後端（mcp_setup.rs，與 `dbk mcp config|install` 同一份），這裡每次選項一變就重新預覽。
// 設定檔永遠不放密碼：連線以 id 指向 db-kit 已存連線，執行時才從系統金鑰圈取。

const errText = (e: unknown) => (e as { message?: string })?.message ?? String(e);

export default function McpSetupDialog() {
  const t = useT();
  const open = useMcpDialog((s) => s.open);
  const presetConn = useMcpDialog((s) => s.connId);
  const close = useMcpDialog((s) => s.close);
  const connections = useStore((s) => s.connections);

  const [info, setInfo] = useState<McpSetupInfo | null>(null);
  const [form, setForm] = useState<McpFormState>({
    scope: "all", connId: null, database: "", only: [], allowWrite: false, allowDestructive: false, allowProd: false,
  });
  const [client, setClient] = useState<McpClientId>("claude-code");
  const [useHttp, setUseHttp] = useState(false);
  const [where, setWhere] = useState<"user" | "project">("user");
  const [project, setProject] = useState("");
  const [preview, setPreview] = useState<McpPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [http, setHttp] = useState<McpHttpStatus | null>(null);
  const [port, setPort] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);

  const usable = useMemo(() => connections.filter((c) => isMcpKind(c.kind)), [connections]);
  const unsupported = connections.length - usable.length;
  const clientInfo = info?.clients.find((c) => c.id === client);

  // 開啟時：讀環境（dbk 路徑 / 用戶端清單 / HTTP 狀態）；從連線右鍵進來就預選那條連線。
  useEffect(() => {
    if (!open) return;
    api.mcpSetupInfo().then((i) => { setInfo(i); setHttp(i.http); setPort(String(i.http.port)); }).catch((e) => toast.error(errText(e)));
    if (presetConn) setForm((f) => ({ ...f, scope: "one", connId: presetConn }));
  }, [open, presetConn]);

  // 這個用戶端不支援 HTTP / 專案層時退回可用的選項。
  useEffect(() => {
    if (clientInfo && !clientInfo.supportsHttp && useHttp) setUseHttp(false);
    if (clientInfo && !clientInfo.supportsProject && where === "project") setWhere("user");
  }, [clientInfo, useHttp, where]);

  const server = serverArgsOf(form);
  const req: McpSetupReq = {
    client,
    project: where === "project" && project.trim() ? project.trim() : null,
    server,
    http: useHttp,
  };
  const reqKey = JSON.stringify(req);

  // 選項一變就重新預覽（輕量，後端只產生文字、讀一次設定檔判斷是否已安裝）。
  useEffect(() => {
    if (!open) return;
    if (where === "project" && !project.trim()) { setPreview(null); setPreviewErr(t("請先選擇專案資料夾")); return; }
    let alive = true;
    const timer = window.setTimeout(() => {
      api.mcpSetupPreview(JSON.parse(reqKey) as McpSetupReq)
        .then((p) => { if (alive) { setPreview(p); setPreviewErr(null); } })
        .catch((e) => { if (alive) { setPreview(null); setPreviewErr(errText(e)); } });
    }, 120);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [open, reqKey, where, project, t]);

  const set = (patch: Partial<McpFormState>) => setForm((f) => ({ ...f, ...patch }));
  const toggleOnly = (id: string) => set({ only: form.only.includes(id) ? form.only.filter((x) => x !== id) : [...form.only, id] });

  const refreshPreview = () => api.mcpSetupPreview(req).then(setPreview).catch(() => {});

  const install = async () => {
    if (!preview) return;
    const label = clientInfo?.label ?? client;
    const lines = [
      t("把「{name}」寫進 {client} 的設定檔：", { name: preview.name, client: label }),
      preview.snippet.path ?? "",
      preview.installed ? t("已有同名項目，會被取代。") : "",
      t("原檔會先備份成 .dbkit-bak。"),
      form.allowWrite ? t("⚠ 這個設定允許 AI 修改資料（每次都要先預覽、經你同意才執行）。") : "",
    ].filter(Boolean);
    if (!(await uiConfirm(lines.join("\n"), { title: t("寫入 MCP 設定"), confirmText: t("寫入"), danger: form.allowWrite }))) return;
    setBusy(true);
    try {
      const o = await api.mcpSetupInstall(req);
      toast.success(t("已寫入 {path}，重新啟動 {client} 後生效", { path: o.path, client: label }));
      await refreshPreview();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const uninstall = async () => {
    if (!preview) return;
    if (!(await uiConfirm(t("從 {client} 的設定移除「{name}」？", { client: clientInfo?.label ?? client, name: preview.name }), { title: t("移除 MCP 設定"), danger: true, confirmText: t("移除") }))) return;
    setBusy(true);
    try {
      await api.mcpSetupUninstall(req);
      toast.success(t("已移除"));
      await refreshPreview();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const httpAction = async (fn: () => Promise<McpHttpStatus>) => {
    setBusy(true);
    try {
      const s = await fn();
      setHttp(s);
      setPort(String(s.port));
      if (s.error) toast.error(s.error);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum > 0 && portNum < 65536;
  const startHttp = () => httpAction(() => api.mcpHttpStart(server, portOk ? portNum : null));
  const httpStale = !!http?.running && !sameServerArgs(http.server, server);

  const pickProject = async () => {
    const dir = await pickDirectory();
    if (dir) setProject(dir);
  };

  const writable = writableCount(connections, form);
  const selected = form.scope === "one" ? connections.find((c) => c.id === form.connId) : undefined;
  const sectionTitle = "text-sm font-medium text-fg/90 flex items-center gap-2";
  const hint = "text-xs text-fg/50 leading-relaxed";

  return (
    <Modal
      open={open}
      onClose={close}
      title={t("MCP 伺服器（接到 AI 工具）")}
      icon={PlugZap}
      size="lg"
      footer={
        <>
          {preview?.installed && (
            <Button variant="ghost" icon={Trash2} disabled={busy} onClick={uninstall}>{t("從設定移除")}</Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" onClick={close}>{t("關閉")}</Button>
          <Button
            variant="primary"
            disabled={busy || !preview || client === "json" || (preview.dbkMissing && !useHttp)}
            title={client === "json" ? t("通用 JSON 沒有固定的設定檔，請複製後自行貼上") : undefined}
            onClick={install}
          >
            {preview?.installed ? t("更新設定檔") : t("寫入設定檔")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <p className={hint}>
          {t("讓 Claude Code、Codex、Cursor 等 AI 工具透過 MCP 直接查你的資料庫。設定檔只放連線代號，密碼仍留在系統金鑰圈；預設唯讀。")}
        </p>
        {info && !info.dbkPath && (
          <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning flex gap-2">
            <Icon icon={AlertTriangle} size={14} className="mt-0.5 shrink-0" />
            <span>{t("找不到 dbk 執行檔，AI 工具無法啟動 MCP 伺服器。請重新安裝 db-kit，或以環境變數 DB_KIT_DBK_BIN 指定路徑。")}</span>
          </div>
        )}

        {/* 1. 連線範圍 */}
        <section className="space-y-2">
          <div className={sectionTitle}><Icon icon={Server} size={15} /> {t("開放哪些連線")}</div>
          <Segmented
            value={form.scope}
            onChange={(v) => set({ scope: v, connId: v === "one" ? form.connId ?? usable[0]?.id ?? null : form.connId })}
            options={[
              { value: "all", label: t("多條連線（AI 自己挑）") },
              { value: "one", label: t("固定一條連線") },
            ]}
          />
          {form.scope === "all" ? (
            <>
              <p className={hint}>
                {t("AI 會先列出連線、再指定要查哪一條。不勾 = 全部可用的連線；勾選則只開放勾到的。")}
                {unsupported > 0 && " " + t("（{n} 條 Kafka / Elasticsearch / 容器類連線不支援，已略過）", { n: unsupported })}
              </p>
              <div className="flex flex-wrap gap-1.5 max-h-28 overflow-auto">
                {usable.map((c) => {
                  const on = form.only.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => toggleOnly(c.id)}
                      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${on ? "border-accent bg-accent/15 text-accent" : "border-fg/15 text-fg/70 hover:bg-fg/5"}`}
                    >
                      {c.name}
                      <span className="text-fg/40">{c.kind}</span>
                      {isProd(c) && <Badge tone="danger">prod</Badge>}
                    </button>
                  );
                })}
                {usable.length === 0 && <span className={hint}>{t("還沒有可用的連線")}</span>}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("連線")}>
                <Select selectSize="md" value={form.connId ?? ""} onChange={(e) => set({ connId: e.target.value || null })}>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>{c.name} ({c.kind}){isProd(c) ? " · prod" : ""}</option>
                  ))}
                </Select>
              </Field>
              <Field label={t("預設資料庫 / schema（選填）")}>
                <Input value={form.database} placeholder={selected?.database ?? ""} onChange={(e) => set({ database: e.target.value })} />
              </Field>
            </div>
          )}
        </section>

        {/* 2. 權限 */}
        <section className="space-y-2 pt-4 border-t border-fg/10">
          <div className={sectionTitle}>
            <Icon icon={form.allowWrite ? ShieldAlert : ShieldCheck} size={15} /> {t("權限")}
          </div>
          <label className="flex items-start gap-2 text-sm text-fg/80 cursor-pointer select-none">
            <input type="checkbox" className="mt-1" checked={form.allowWrite} onChange={(e) => set({ allowWrite: e.target.checked })} />
            <span>
              {t("允許 AI 修改資料")}
              <span className={`block ${hint}`}>
                {t("開啟後多兩支工具：preview_write 先估算影響列數與能否回滾，經你在 AI 工具裡核准後才以審查代碼 execute_write；執行前自動備份前像並產生回滾腳本。")}
              </span>
            </span>
          </label>
          {form.allowWrite && (
            <div className="ml-6 space-y-1.5">
              <label className="flex items-center gap-2 text-sm text-fg/80 cursor-pointer select-none">
                <input type="checkbox" checked={form.allowDestructive} onChange={(e) => set({ allowDestructive: e.target.checked })} />
                {t("也允許高破壞語句（DROP / TRUNCATE / 無 WHERE 的 UPDATE·DELETE）")}
              </label>
              <label className="flex items-center gap-2 text-sm text-fg/80 cursor-pointer select-none">
                <input type="checkbox" checked={form.allowProd} onChange={(e) => set({ allowProd: e.target.checked })} />
                {t("也允許寫入標記為正式環境的連線")}
              </label>
              <p className={hint}>
                {writable > 0
                  ? t("{n} 條連線可寫入（只支援 SQL 資料庫；Mongo / Redis 維持唯讀）。", { n: writable })
                  : t("目前選的連線都不能寫入（只支援 SQL 資料庫；正式環境要另外勾選）。")}
              </p>
            </div>
          )}
        </section>

        {/* 3. AI 工具與連法 */}
        <section className="space-y-3 pt-4 border-t border-fg/10">
          <div className={sectionTitle}><Icon icon={PlugZap} size={15} /> {t("AI 工具")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("用戶端")}>
              <Select selectSize="md" value={client} onChange={(e) => setClient(e.target.value as McpClientId)}>
                {(info?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.id === "json" ? t("通用 JSON（其他工具）") : c.label}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("連線方式")}>
              <Segmented
                full
                value={useHttp ? "http" : "stdio"}
                onChange={(v) => setUseHttp(v === "http")}
                options={[
                  { value: "stdio", label: t("由 AI 工具啟動") },
                  { value: "http", label: "HTTP", disabled: clientInfo ? !clientInfo.supportsHttp : false, title: clientInfo && !clientInfo.supportsHttp ? t("這個用戶端不支援 HTTP") : undefined },
                ]}
              />
            </Field>
          </div>
          {clientInfo?.supportsProject && (
            <Field label={t("寫到哪裡")} hint={where === "project" ? t("專案層設定通常會進版本控制；別在這裡開寫入權限給整個團隊。") : undefined}>
              <div className="flex items-center gap-2">
                <Segmented
                  value={where}
                  onChange={setWhere}
                  options={[
                    { value: "user", label: t("我的使用者設定") },
                    { value: "project", label: t("專案資料夾") },
                  ]}
                />
                {where === "project" && (
                  <>
                    <Input className="flex-1 min-w-0" value={project} placeholder={t("選擇專案資料夾…")} onChange={(e) => setProject(e.target.value)} />
                    <IconButton icon={FolderOpen} label={t("選擇資料夾")} onClick={pickProject} />
                  </>
                )}
              </div>
            </Field>
          )}

          {useHttp && http && (
            <div className="rounded border border-fg/10 bg-inset/40 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={http.running ? "success" : "neutral"} dot>{http.running ? t("執行中") : t("已停止")}</Badge>
                <span className="mono text-xs text-fg/70 truncate">{http.url}</span>
                <div className="flex-1" />
                {http.running ? (
                  <>
                    {httpStale && <Button variant="secondary" icon={RotateCw} disabled={busy} onClick={startHttp}>{t("套用選項並重啟")}</Button>}
                    <Button variant="ghost" icon={Square} disabled={busy} onClick={() => httpAction(api.mcpHttpStop)}>{t("停止")}</Button>
                  </>
                ) : (
                  <Button variant="secondary" icon={Play} disabled={busy || !portOk || !info?.dbkPath} onClick={startHttp}>{t("在背景啟動")}</Button>
                )}
              </div>
              {httpStale && <p className="text-xs text-warning">{t("伺服器仍以舊的連線 / 權限選項執行，按「套用選項並重啟」才會生效。")}</p>}
              <div className="grid grid-cols-[7rem_1fr] gap-2 items-center">
                <Field label={t("埠號")}>
                  <Input value={port} disabled={http.running} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
                </Field>
                <Field label={t("存取權杖")}>
                  <div className="flex items-center gap-1">
                    <Input readOnly className="flex-1 min-w-0 mono" value={showToken ? http.token : "•".repeat(24)} />
                    <IconButton icon={showToken ? EyeOff : Eye} label={showToken ? t("隱藏") : t("顯示")} onClick={() => setShowToken((v) => !v)} />
                    <IconButton icon={Copy} label={t("複製權杖")} onClick={() => copyToClipboard(http.token)} />
                    <IconButton
                      icon={KeyRound}
                      label={t("重新產生權杖")}
                      onClick={async () => {
                        if (await uiConfirm(t("重新產生權杖後，已寫進 AI 工具的 HTTP 設定要再寫一次。繼續？"), { title: t("重新產生權杖") })) {
                          await httpAction(api.mcpHttpRotateToken);
                          await refreshPreview();
                        }
                      }}
                    />
                  </div>
                </Field>
              </div>
              <p className={hint}>
                {t("只聽本機 127.0.0.1；關掉 db-kit 時伺服器一起停止。AI 工具要在 db-kit 開著時才連得上，想讓它隨時可用請改用「由 AI 工具啟動」。")}
              </p>
              {http.log.length > 0 && (
                <pre className="max-h-20 overflow-auto rounded bg-inset p-1.5 text-[11px] mono text-fg/55 whitespace-pre-wrap">{http.log.join("\n")}</pre>
              )}
            </div>
          )}
        </section>

        {/* 4. 設定內容 */}
        <section className="space-y-2 pt-4 border-t border-fg/10">
          <div className="flex items-center gap-2">
            <div className={sectionTitle}>{t("設定內容")}</div>
            {preview && <span className="mono text-xs text-fg/50">{preview.name}</span>}
            {preview?.installed && <Badge tone="success">{t("已寫入")}</Badge>}
            <div className="flex-1" />
            {preview && (
              <Button variant="ghost" icon={Copy} onClick={() => copyToClipboard(preview.snippet.text)}>{t("複製")}</Button>
            )}
          </div>
          {previewErr && <p className="text-xs text-warning">{previewErr}</p>}
          {preview && (
            <>
              {preview.snippet.path && (
                <p className={hint}>{t("設定檔：")}<span className="mono">{preview.snippet.path}</span></p>
              )}
              <pre className="max-h-56 overflow-auto rounded border border-fg/10 bg-inset/50 p-2 text-[11px] leading-relaxed mono whitespace-pre">
                {preview.snippet.text}
              </pre>
              {preview.snippet.cli && (
                <div className="flex items-center gap-1">
                  <span className={hint}>{t("或在終端機執行：")}</span>
                  <code className="flex-1 min-w-0 truncate mono text-[11px] text-fg/70" title={preview.snippet.cli}>{preview.snippet.cli}</code>
                  <IconButton icon={Copy} label={t("複製指令")} onClick={() => copyToClipboard(preview.snippet.cli ?? "")} />
                </div>
              )}
              {preview.snippet.notes.map((n) => (
                <p key={n} className="text-xs text-warning">{n}</p>
              ))}
              {preview.dbkMissing && !useHttp && (
                <p className="text-xs text-warning">{t("找不到 dbk，設定裡暫以「dbk」代替；請先確認 dbk 在 PATH 上。")}</p>
              )}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}
