// 終端機「現在在哪個資料夾」：SFTP 面板開啟 / 跟隨終端機時要跳去那裡。
//
// 來源有兩個：OSC 7（shell 主動回報 file://host/path，最準，但要 shell 有設定）；沒有的話退而看
// 視窗標題——Debian / Ubuntu 預設的 bashrc 會把標題設成 `user@host: ~/dir`，RHEL 系是 `user@host:~/dir`，
// oh-my-zsh 也是同一個樣子。標題裡的 `~` 要等 SFTP 拿到家目錄才解得開，所以這裡回的可能是 `~` 開頭的路徑。

/** 從 `user@host: path` / `user@host:path` 形式的視窗標題取出路徑；不是這種樣子（vim、htop 改過標題）回 null。 */
export function cwdFromTitle(title: string | null | undefined): string | null {
  const m = /^[^\s@]+@[^\s:]+:\s?(~(?:\/.*)?|\/.*)$/.exec((title ?? "").trim());
  return m ? m[1].replace(/(.)\/+$/, "$1") : null;
}

/** 終端機目前的資料夾：OSC 7 優先，其次視窗標題；都沒有回 null。 */
export function terminalDir(rt: { cwd: string | null; title: string | null } | undefined): string | null {
  if (!rt) return null;
  return rt.cwd || cwdFromTitle(rt.title);
}

/** `terminalDir` 的結果 → 絕對路徑；`~` 開頭但還不知道家目錄時回 null（別拿 `~` 去列目錄）。 */
export function absTerminalDir(dir: string | null, home: string | null | undefined): string | null {
  if (!dir) return null;
  if (dir.startsWith("/")) return dir;
  return home ? expandHome(dir, home) : null;
}

/** `~` / `~/x` 接上家目錄；其餘（已經是絕對路徑）原樣。 */
export function expandHome(dir: string, home: string): string {
  if (dir === "~") return home || "/";
  if (dir.startsWith("~/")) return `${(home || "/").replace(/\/+$/, "")}/${dir.slice(2)}`;
  return dir;
}
