// 拉取映像：輸入 repo[:tag]，逐層顯示下載進度。私有 registry 可填帳密（只用於這次拉取，不儲存）。
import { useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { Download } from "lucide-react";
import { api } from "./api";
import type { DockerPullProgress } from "./dockerTypes";
import { fmtBytes } from "./dockerModel";
import { Button, Field, Input, Modal, Select } from "./ui/index";
import { toast } from "./ui";
import { useStore } from "./store";
import { useT } from "./i18n";

interface Layer { status: string; current: number; total: number }

export default function DockerPullDialog({ connId, initialImage = "", initialUser = "", credConn, targets, onClose }: {
  connId: string;
  /** 可選的目標 Docker 連線（從 Registry / Harbor 發起、且連著多個 Docker 時給）。 */
  targets?: { id: string; name: string }[];
  initialImage?: string;
  initialUser?: string;
  /** 從 Registry / Harbor 連線發起：密碼留空時用該連線存在 keychain 的密碼。 */
  credConn?: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const t = useT();
  const [image, setImage] = useState(initialImage);
  const [target, setTarget] = useState(connId);
  const [user, setUser] = useState(initialUser);
  const [pass, setPass] = useState("");
  const [pulling, setPulling] = useState(false);
  const [layers, setLayers] = useState<Record<string, Layer>>({});
  const [lines, setLines] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const doneRef = useRef(false);

  const pull = async () => {
    const ref = image.trim();
    if (!ref || pulling) return;
    setPulling(true);
    setErr(null);
    setLayers({});
    setLines([]);
    doneRef.current = false;
    const ch = new Channel<DockerPullProgress>();
    ch.onmessage = (p) => {
      if (p.id) {
        setLayers((m) => ({ ...m, [p.id]: { status: p.status, current: p.current, total: p.total } }));
      } else if (p.status) {
        setLines((l) => [...l, p.status].slice(-20));
      }
    };
    try {
      await api.dockerImagePull(target, ref, "", user, pass, ch, credConn?.id ?? null);
      doneRef.current = true;
      toast.success(t("已拉取 {name}", { name: ref }));
      useStore.getState().requestTreeReload(target, "images");
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setPulling(false);
    }
  };

  const entries = Object.entries(layers);
  return (
    <Modal
      onClose={pulling ? () => undefined : onClose}
      title={t("拉取映像")}
      icon={Download}
      size="md"
      bodyClassName="p-5 space-y-3"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pulling}>{t("關閉")}</Button>
          <Button variant="primary" icon={Download} loading={pulling} disabled={!image.trim()} onClick={() => void pull()}>{t("拉取")}</Button>
        </>
      }
    >
      {targets && targets.length > 1 && (
        <Field label={t("拉到哪個 Docker")}>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} disabled={pulling}>
            {targets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
      )}
      <Field label={t("映像")} hint={t("例如 postgres:16、ghcr.io/org/app:1.2；省略 tag＝latest")}>
        <Input autoFocus value={image} onChange={(e) => setImage(e.target.value)} disabled={pulling}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void pull(); }}
          placeholder="nginx:latest" />
      </Field>
      <div className="flex gap-3">
        <Field label={t("Registry 使用者（選填）")} className="flex-1">
          <Input value={user} onChange={(e) => setUser(e.target.value)} disabled={pulling} />
        </Field>
        <Field label={t("密碼 / Token（選填）")} className="flex-1">
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} disabled={pulling}
            placeholder={credConn ? t("留空＝用連線「{name}」的密碼", { name: credConn.name }) : ""} />
        </Field>
      </div>
      {(entries.length > 0 || lines.length > 0) && (
        <div className="rounded border border-fg/10 bg-inset p-2 max-h-64 overflow-auto text-[11px] mono space-y-0.5">
          {entries.map(([id, l]) => (
            <div key={id} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-fg/50">{id}</span>
              <span className="w-36 shrink-0 truncate">{l.status}</span>
              {l.total > 0 && (
                <>
                  <div className="flex-1 h-1.5 rounded bg-fg/10 overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${Math.min(100, (l.current / l.total) * 100)}%` }} />
                  </div>
                  <span className="w-28 shrink-0 text-right text-fg/50">{fmtBytes(l.current)} / {fmtBytes(l.total)}</span>
                </>
              )}
            </div>
          ))}
          {lines.map((s, i) => <div key={i} className="text-fg/60">{s}</div>)}
        </div>
      )}
      {err && <div className="text-sm text-danger break-all">{err}</div>}
    </Modal>
  );
}
