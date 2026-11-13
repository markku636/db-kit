// 設定對話框的「使用者變數」區塊 —— 只有 Windows 免安裝版看得到。
//
// 免安裝版沒有安裝程式，也就沒有人幫忙設環境變數：`dbk` 永遠不在 PATH 上（只能用完整路徑叫），
// ORACLE_HOME / HTTP_PROXY / DB_KIT_DATA_DIR 這類變數也只能在開 App 之前自己 set 一次、關掉就沒了。
// 這裡把那件事搬進 App：寫的是 Windows 的「使用者變數」（HKCU\Environment），只屬於登入的這個
// 帳戶、不需要系統管理員，也不會動到別人的系統變數。
//
// 後端回 null（非 Windows、或不是免安裝版）就整段不顯示——安裝版的 PATH 歸安裝程式管，
// 兩邊都插手只會留下移除不掉的殘渣（見 commands/winenv.rs 的檔頭）。
//
// 說明文字刻意把兩件違反免安裝版預期的事講明白：設定寫在**這台電腦的登錄檔**、不跟著資料夾走；
// 以及只有**之後新開**的程式讀得到，db-kit 自己要重開才會套用。
import { useEffect, useState } from "react";
import { Check, Pencil, Plus, SquareTerminal, Trash2, Variable, X } from "lucide-react";
import { api, type UserEnvSupport, type UserEnvVar } from "./api";
import Icon from "./ui/Icon";
import { Button, IconButton, Input, Textarea } from "./ui/index";
import { toast, uiConfirm } from "./ui";
import { useT } from "./i18n";

/** 新增時的名稱候選（datalist）：db-kit 自己看的，加上免安裝版最常要設的那幾個。 */
const SUGGESTED = [
  "DB_KIT_DATA_DIR",
  "DB_KIT_DBK_BIN",
  "ORACLE_HOME",
  "TNS_ADMIN",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
];

/** 正在編輯的那一筆；`editing` = 原本的變數名稱，null 代表新增。 */
interface Draft {
  editing: string | null;
  name: string;
  value: string;
}

export function WinEnvSettings() {
  const t = useT();
  const [support, setSupport] = useState<UserEnvSupport | null>(null);
  const [vars, setVars] = useState<UserEnvVar[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .userEnvSupport()
      .then(async (s) => {
        if (!alive || !s) return;
        // 讀不到清單（權限、登錄檔被鎖）不該讓整段消失：至少還能用「加進 PATH」。
        const list = await api.userEnvList().catch(() => [] as UserEnvVar[]);
        if (!alive) return;
        setSupport(s);
        setVars(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!support) return null;

  const reload = async () => {
    const [s, list] = await Promise.all([api.userEnvSupport(), api.userEnvList()]);
    if (s) setSupport(s);
    setVars(list);
  };

  const run = (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void fn()
      .catch((e: unknown) => toast.error((e as { message?: string })?.message ?? String(e)))
      .finally(() => setBusy(false));
  };

  const togglePath = () =>
    run(async () => {
      const enable = !support.on_user_path;
      setSupport(await api.userEnvPath(enable));
      // Path 自己也是一筆使用者變數，清單要跟著換。
      setVars(await api.userEnvList().catch(() => vars));
      toast.success(enable ? t("已加進 PATH。新開的終端機就能直接執行 dbk") : t("已從 PATH 移除"));
    });

  const save = () =>
    run(async () => {
      if (!draft) return;
      const name = draft.name.trim();
      // 後端也會擋；這裡先擋一次，免得按了半天只換來一個 toast。
      if (!name) {
        toast.error(t("變數名稱不可空白"));
        return;
      }
      await api.userEnvSet(name, draft.value);
      setDraft(null);
      await reload();
      toast.success(t("已儲存 {name}", { name }));
    });

  const remove = (v: UserEnvVar) =>
    run(async () => {
      const ok = await uiConfirm(
        t("刪除使用者變數「{name}」？之後新開的程式就讀不到它了。", { name: v.name }),
        { title: t("刪除使用者變數"), danger: true, confirmText: t("刪除") },
      );
      if (!ok) return;
      await api.userEnvRemove(v.name);
      await reload();
      toast.success(t("已刪除 {name}", { name: v.name }));
    });

  const editor = draft && (
    <div className="rounded border border-accent/40 px-2.5 py-2 space-y-1.5">
      <Input
        value={draft.name}
        // 改名等於「刪一條、加一條」，很容易留下一條沒人記得的舊變數，所以只有新增時能填名稱。
        disabled={draft.editing !== null}
        autoFocus={draft.editing === null}
        list="dbkit-user-env-names"
        placeholder={t("變數名稱，例如 ORACLE_HOME")}
        className="mono"
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <Textarea
        rows={2}
        value={draft.value}
        autoFocus={draft.editing !== null}
        placeholder={t("變數值；%USERPROFILE% 這類寫法會由系統展開")}
        className="mono text-xs"
        // 環境變數裡不能有換行 / Tab（後端也擋），貼進來的就地清掉，不要等按下儲存才報錯。
        onChange={(e) => setDraft({ ...draft, value: e.target.value.replace(/[\r\n\t]+/g, " ") })}
      />
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button variant="primary" icon={Check} disabled={busy || !draft.name.trim()} onClick={save}>
          {t("儲存")}
        </Button>
        <Button variant="ghost" icon={X} disabled={busy} onClick={() => setDraft(null)}>
          {t("取消")}
        </Button>
        {draft.name.trim().toLowerCase() === "path" && (
          <span className="text-[11px] text-warning">{t("PATH 決定所有程式找不找得到指令，改之前先看清楚。")}</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="pt-4 border-t border-fg/10 space-y-2">
      <div className="text-sm font-medium text-fg/90 flex items-center gap-2">
        <Icon icon={Variable} size={15} /> {t("使用者變數")}
      </div>
      <p className="text-xs text-fg/50 leading-relaxed">
        {t("免安裝版沒有安裝程式，不會替你設環境變數。這裡可以直接寫進 Windows 的「使用者變數」——只屬於你這個帳戶、不需要系統管理員，也不會動到系統變數。設定寫在這台電腦的登錄檔，不跟著資料夾走：隨身碟換一台電腦要再設一次。改完之後新開的終端機與程式才讀得到，db-kit 自己也要重開才會套用。")}
      </p>

      <div className="rounded border border-fg/10 bg-inset px-3 py-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-fg/80 inline-flex items-center gap-1.5">
            <Icon icon={SquareTerminal} size={14} />
            {t("在終端機直接執行 dbk")}
          </span>
          {support.on_user_path ? (
            <Button variant="ghost" disabled={busy} onClick={togglePath}>{t("從 PATH 移除")}</Button>
          ) : support.on_machine_path ? (
            <span className="text-xs text-fg/50">{t("已在系統 PATH")}</span>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={togglePath}>{t("加進 PATH")}</Button>
          )}
        </div>
        <p className="text-[11px] text-fg/40 break-all font-mono">{support.app_dir}</p>
        <p className="text-[11px] text-fg/40 leading-relaxed">
          {support.on_user_path || support.on_machine_path
            ? t("這個資料夾已經在 PATH 上：新開的終端機可以直接執行 dbk（已經開著的要重開）。資料夾搬家後記得回來重設一次。")
            : t("把這個資料夾加進 PATH，任何終端機都能直接執行 dbk，不必打完整路徑。")}
        </p>
        {!support.has_dbk && (
          <p className="text-[11px] text-warning">{t("這個資料夾裡找不到 dbk.exe，加進 PATH 也叫不出來。")}</p>
        )}
      </div>

      <div className="space-y-1">
        {vars.map((v) =>
          draft?.editing === v.name ? (
            <div key={v.name}>{editor}</div>
          ) : (
            <div key={v.name} className="group rounded border border-fg/10 px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <span className="mono text-xs text-fg/90 truncate" title={v.name}>{v.name}</span>
                <div className="ml-auto flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <IconButton
                    icon={Pencil}
                    label={t("編輯 {name}", { name: v.name })}
                    box="w-6 h-6"
                    iconSize={12}
                    disabled={busy}
                    onClick={() => setDraft({ editing: v.name, name: v.name, value: v.value })}
                  />
                  <IconButton
                    icon={Trash2}
                    label={t("刪除 {name}", { name: v.name })}
                    box="w-6 h-6"
                    iconSize={12}
                    disabled={busy}
                    onClick={() => remove(v)}
                  />
                </div>
              </div>
              <div className="text-[11px] text-fg/50 break-all line-clamp-2" title={v.value}>
                {v.value || t("（空值）")}
              </div>
            </div>
          ),
        )}
        {draft?.editing === null && editor}
        {!vars.length && !draft && <p className="text-xs text-fg/40">{t("這個帳戶目前沒有使用者變數。")}</p>}
      </div>

      {!draft && (
        <Button variant="secondary" icon={Plus} disabled={busy} onClick={() => setDraft({ editing: null, name: "", value: "" })}>
          {t("新增變數…")}
        </Button>
      )}

      {/* 名稱候選：打幾個字就會列出來，省得去記 DB_KIT_DATA_DIR 這種名字怎麼拼。 */}
      <datalist id="dbkit-user-env-names">
        {SUGGESTED.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  );
}
