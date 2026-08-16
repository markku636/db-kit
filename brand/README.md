# 品牌素材（MAGIDB Connect）

原始高解析插畫與「去背」流程的存檔，方便日後重新匯出。

| 檔案 | 用途 |
| --- | --- |
| `logo.png` | 原始標誌（海豹吉祥物 + 字標），含近白底 |
| `icon-source.png` | App 圖示母檔（1024，圓角藍色圖磚 + 吉祥物），桌面圖示由它推近裁切而來 |
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

## 網頁 favicon

由 `logo-mark.png` 裁切出「海豹吉祥物」（寬版字標在小尺寸無法辨識），置中 contain 進正方形。腳本 [`../scripts/make-favicon.mjs`](../scripts/make-favicon.mjs)（Node + sharp，不需 Python）：

```bash
npm run make:favicon
```

輸出 → [`../public/`](../public/)：`favicon.ico`（16/32/48）、`favicon-32.png`、`apple-touch-icon.png`，由 [`../index.html`](../index.html) `<link rel="icon">` 引用。

## 桌面 App 圖示

來源是 `icon-source.png`（圓角藍色圖磚 + 吉祥物），**不是** favicon 那條線。母檔裡吉祥物含尾鰭橫跨整張畫布，主體只佔一半左右，縮到工作列 / 搜尋結果的 16~32px 會糊掉；因此 [`../scripts/make-app-icon.mjs`](../scripts/make-app-icon.mjs) 會把畫面往頭部推近（`ZOOM` / `CENTER` 兩個常數），尾鰭出血裁掉，再把母檔 alpha 貼回去維持圓角輪廓。

```bash
npm run make:app-icon                     # icon-source.png → src-tauri/app-icon.png（1024，已推近）
npm run tauri icon src-tauri/app-icon.png # 由來源產生 src-tauri/icons/ 全套平台圖示
```

`tauri icon` 重生 `src-tauri/icons/`（視窗 / 工作列 / 安裝檔用的 `icon.ico` / `icon.png` / Square*Logo 等）。改完要重新 build 安裝檔，Windows 才會換掉快取的舊圖示。
