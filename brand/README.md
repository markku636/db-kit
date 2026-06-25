# 品牌素材（MAGIDB Connect）

原始高解析插畫與「去背」流程的存檔，方便日後重新匯出。

| 檔案 | 用途 |
| --- | --- |
| `logo.png` | 原始標誌（海豹吉祥物 + 字標），含近白底 |
| `remove-bg.py` | 去背腳本：邊緣 flood-fill 移除近白底、羽化抗鋸齒邊、自動裁切、縮放 |

## 產生的素材（已被 App 使用，請勿手改）

`remove-bg.py` 會輸出到 [`../src/assets/`](../src/assets/)：

- `logo-mark.png` — 透明背景標誌（開場動畫 `SplashScreen` 使用）

## 重新匯出

```bash
pip install Pillow numpy scipy
python brand/remove-bg.py
```

去背原理：把與邊框相連的近白像素以 flood-fill 標為背景並設為透明；被插畫包圍的白色像素（如海豹白肚）因不與邊框相連而保留。邊界數像素帶內依「彩度」羽化 alpha，避免殘留白色光暈。

## favicon 與桌面 App 圖示

由 `logo-mark.png` 裁切出「海豹吉祥物」（寬版字標在小尺寸無法辨識），產生正方形圖示。腳本 [`../scripts/make-favicon.mjs`](../scripts/make-favicon.mjs)（Node + sharp，不需 Python）：

```bash
npm run make:favicon                      # 產生 favicon 與 app-icon.png 來源
npm run tauri icon src-tauri/app-icon.png # 由來源產生 src-tauri/icons/ 全套圖示
```

- 網頁 favicon → [`../public/`](../public/)：`favicon.ico`（16/32/48）、`favicon-32.png`、`apple-touch-icon.png`，由 [`../index.html`](../index.html) `<link rel="icon">` 引用。
- App 圖示來源 → `../src-tauri/app-icon.png`（1024，吉祥物置中留邊）；`tauri icon` 由它重生 `src-tauri/icons/`（視窗 / 工作列 / 安裝檔用的 `icon.ico` / `icon.png` 等）。
