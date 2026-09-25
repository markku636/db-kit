// SFTP 檔案的 App 內檢視 / 編輯（Xftp 的「編輯」：不用下載、開本機編輯器、再上傳回去）。
//
// 三道防線，都是為了「改一行設定檔，不要把整個檔弄壞」：
// 1. 內容不是乾淨的 UTF-8、看起來是二進位、或超過 1 MiB 被截斷 → 只給唯讀（照畫面存回去會壞檔）。
// 2. 換行照原檔：CodeMirror 一律用 \n 接回去，CRLF 的檔存檔時換回 CRLF。
// 3. 存檔前再 stat 一次：開啟之後遠端被改過（mtime / 大小變了）就先問，不默默蓋掉別人的修改。
import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { sql } from "@codemirror/lang-sql";
import { FileText, Lock, RotateCcw, Save } from "lucide-react";
import { api } from "./api";
import type { SftpEntry } from "./sshTypes";
import { useT } from "./i18n";
import { Button, Modal, Spinner, Icon } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { useTheme } from "./theme";
import { resolveEditorTheme } from "./editorThemes";
import { applyEol, detectEol, languageForFile, remoteChanged, type Eol } from "./sftpText";
import { fmtBytes } from "./schemaCache";

export interface SftpFileEditorProps {
  sftpId: string;
  /** 要開的檔（新增檔案時是剛建好的空檔）。 */
  entry: Pick<SftpEntry, "path" | "name" | "size" | "mtime">;
  onClose: () => void;
  /** 存檔成功後（面板用來更新清單裡的大小 / 時間）。 */
  onSaved?: (e: SftpEntry) => void;
}

function errMsg(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

const baseTheme = EditorView.theme({ "&": { fontSize: "var(--code-font-size, 13px)" }, ".cm-scroller": { fontFamily: '"JetBrains Mono", Consolas, monospace' } });

export default function SftpFileEditor({ sftpId, entry, onClose, onSaved }: SftpFileEditorProps) {
  const t = useT();
  const themeId = useTheme((s) => s.themeId);
  const appTheme = useTheme((s) => s.theme);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const eolRef = useRef<Eol>("\n");
  // 衝突判斷的基準：開啟時（或上一次成功存檔後）遠端的 mtime / 大小。
  const baseRef = useRef<{ mtime: number | null; size: number }>({ mtime: entry.mtime, size: entry.size });
  const saveRef = useRef<() => void>(() => {});

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const r = await api.sshSftpReadText(sftpId, entry.path, 0);
      const eol = detectEol(r.text);
      eolRef.current = eol;
      const body = r.text.replace(/\r\n/g, "\n");
      setText(body);
      setOriginal(body);
      setReadOnlyReason(
        r.binary ? t("看起來是二進位檔，只能檢視。")
          : r.lossy ? t("內容不是 UTF-8（例如 Big5 / GBK），存回去會弄壞原檔，只能檢視。")
          : r.truncated ? t("檔案超過 1 MiB，只載入了前面一部分，只能檢視。")
          : null,
      );
      // 讀完再抓一次屬性當基準（清單上的大小可能已經舊了）。
      const st = await api.sshSftpStat(sftpId, entry.path).catch(() => null);
      baseRef.current = st ? { mtime: st.mtime, size: st.size } : { mtime: entry.mtime, size: r.size };
    } catch (e) {
      setLoadError(errMsg(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // 只在開啟時讀一次；「重新載入」按鈕另外呼叫。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpId, entry.path]);

  const dirty = !readOnlyReason && text !== original;

  const save = async () => {
    if (readOnlyReason || saving || !dirty) return;
    setSaving(true);
    try {
      const now = await api.sshSftpStat(sftpId, entry.path).catch(() => null);
      if (!now) {
        const ok = await uiConfirm(t("遠端的「{name}」已經不在了（被刪除或改名）。要以目前內容重新建立嗎？", { name: entry.name }), {
          title: t("檔案已不存在"), confirmText: t("重新建立"),
        });
        if (!ok) return;
      } else if (remoteChanged(baseRef.current, now)) {
        const ok = await uiConfirm(t("「{name}」在你開啟之後已被修改（大小或修改時間變了）。要用你的版本覆蓋嗎？", { name: entry.name }), {
          title: t("遠端檔案已變更"), danger: true, confirmText: t("覆蓋"),
        });
        if (!ok) return;
      }
      const saved = await api.sshSftpWriteText(sftpId, entry.path, applyEol(text, eolRef.current), !now);
      baseRef.current = { mtime: saved.mtime, size: saved.size };
      setOriginal(text);
      toast.success(t("已儲存 {name}", { name: entry.name }));
      onSaved?.(saved);
    } catch (e) {
      toast.error(t("儲存失敗：{msg}", { msg: errMsg(e) }));
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = () => void save();

  const reload = async () => {
    if (dirty) {
      const ok = await uiConfirm(t("捨棄尚未儲存的修改並重新載入？"), { title: t("重新載入"), danger: true, confirmText: t("重新載入") });
      if (!ok) return;
    }
    void load();
  };

  const requestClose = async () => {
    if (dirty) {
      const ok = await uiConfirm(t("「{name}」有尚未儲存的修改，確定關閉？", { name: entry.name }), {
        title: t("未儲存的修改"), danger: true, confirmText: t("不儲存，關閉"),
      });
      if (!ok) return;
    }
    onClose();
  };

  const extensions = useMemo<Extension[]>(() => {
    const lang = languageForFile(entry.name);
    const langExt = lang === "json" ? [json()] : lang === "javascript" ? [javascript({ typescript: true, jsx: true })] : lang === "sql" ? [sql()] : [];
    return [
      ...langExt,
      baseTheme,
      Prec.high(keymap.of([{ key: "Mod-s", run: () => { saveRef.current(); return true; }, preventDefault: true }])),
    ];
  }, [entry.name]);

  const lines = text ? text.split("\n").length : 0;

  return (
    <Modal
      open
      onClose={() => void requestClose()}
      title={<span className="inline-flex items-center gap-2 min-w-0"><span className="truncate mono">{entry.name}</span>{dirty && <span className="text-warning text-xs">●</span>}</span>}
      icon={FileText}
      size="full"
      codeZoom
      dismissOnBackdrop={false}
      bodyClassName="p-0 flex flex-col min-h-0 overflow-hidden"
      className="h-[80vh]"
      footer={
        <>
          <span className="mr-auto text-xs text-fg/45 mono truncate" title={entry.path}>
            {entry.path} · {eolRef.current === "\r\n" ? "CRLF" : "LF"} · UTF-8 · {t("{n} 行", { n: lines })} · {fmtBytes(new TextEncoder().encode(text).length)}
          </span>
          <Button variant="secondary" icon={RotateCcw} onClick={() => void reload()} disabled={loading || saving}>{t("重新載入")}</Button>
          <Button variant="secondary" onClick={() => void requestClose()}>{t("關閉")}</Button>
          {!readOnlyReason && (
            <Button variant="primary" icon={Save} loading={saving} disabled={!dirty || loading} onClick={() => void save()} title={t("儲存（Ctrl+S）")}>
              {t("儲存")}
            </Button>
          )}
        </>
      }
    >
      {readOnlyReason && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-xs bg-warning/10 text-warning border-b border-fg/10">
          <Icon icon={Lock} size={12} />{readOnlyReason}
        </div>
      )}
      <div className="flex-1 min-h-0" data-testid="sftp-editor">
        {loading ? (
          <div className="h-full flex items-center justify-center gap-2 text-sm text-fg/50"><Spinner size={14} />{t("載入中…")}</div>
        ) : loadError ? (
          <div className="p-4 text-sm text-danger">{loadError}</div>
        ) : (
          <CodeMirror
            value={text}
            onChange={setText}
            readOnly={!!readOnlyReason}
            editable={!readOnlyReason}
            theme={resolveEditorTheme(themeId, appTheme)}
            extensions={extensions}
            height="100%"
            className="h-full"
            autoFocus
            basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, bracketMatching: true, closeBrackets: false, autocompletion: false }}
          />
        )}
      </div>
    </Modal>
  );
}
