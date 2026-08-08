// 從 CHANGELOG.md 抽出指定版本的段落，組成 GitHub Release 的說明文字。
//
// 為什麼要這支：release.yml 原本把 releaseBody 寫死成一句「見 CHANGELOG.md」+ 下載指引，
// 於是每個版本的 Release 頁面長得一模一樣，使用者得自己去翻 commit 才知道改了什麼。
//
// 用法：
//   node scripts/changelog-section.mjs v0.23.0    # 標籤名（前面的 v 可有可無）
//   node scripts/changelog-section.mjs            # 不給版本則取 CHANGELOG 最上面那節
//
// 找不到對應版本時不會失敗（打標籤前忘了寫 CHANGELOG 不該讓整條發佈流程掛掉），
// 改為只輸出下載指引並在 stderr 留一行警告。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 各平台安裝檔的取用說明。未簽章這件事要講在前面，否則 macOS 使用者會以為檔案壞了。
const DOWNLOAD = `## 下載

| 平台 | 檔案 |
|------|------|
| Windows | \`.exe\`（NSIS 安裝精靈）或 \`.msi\` |
| macOS | \`.dmg\` —— Apple Silicon 選 \`aarch64\`、Intel 選 \`x64\` |
| Linux | \`.AppImage\`（免安裝）、\`.deb\`（Debian / Ubuntu）或 \`.rpm\`（Fedora / RHEL）|

安裝檔皆未付費簽章：macOS 首次開啟請在 Finder 對 App **右鍵 → 開啟**；Windows SmartScreen 出現時選「其他資訊 → 仍要執行」。

完整版本紀錄見 [CHANGELOG.md](https://github.com/markku636/db-kit/blob/main/CHANGELOG.md)。`;

/** 取出 `## vX.Y.Z` 到下一個 `## ` 之間的內容（不含標題那行）。 */
export function extractSection(md, version) {
  const lines = md.split(/\r?\n/);
  const isHeading = (l) => /^##\s+/.test(l);
  // 未指定版本 → 第一個 `## ` 標題那一節。
  const startIdx = version
    ? lines.findIndex((l) => isHeading(l) && l.replace(/^##\s+/, "").trim() === version)
    : lines.findIndex(isHeading);
  if (startIdx < 0) return null;

  let end = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (isHeading(lines[i])) { end = i; break; }
  }
  return lines.slice(startIdx + 1, end).join("\n").trim();
}

const raw = process.argv[2];
// 標籤是 v0.23.0，CHANGELOG 標題也是 v0.23.0；容忍使用者傳 0.23.0。
const version = raw ? (raw.startsWith("v") ? raw : `v${raw}`) : null;

const md = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const section = extractSection(md, version);

if (!section) {
  process.stderr.write(`changelog-section: 在 CHANGELOG.md 找不到 ${version ?? "任何版本"} 的段落，只輸出下載指引\n`);
  process.stdout.write(`${DOWNLOAD}\n`);
} else {
  process.stdout.write(`${section}\n\n${DOWNLOAD}\n`);
}
