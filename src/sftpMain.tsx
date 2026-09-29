// SFTP 獨立視窗的進入點（sftp.html）。不載入主介面（App）：只有 SFTP 面板、對話框與提示。
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import ErrorBoundary from "./ErrorBoundary";
import SftpWindow from "./SftpWindow";
import { applyDocLang, readStoredLang, useLang } from "./i18n";
import { readStoredThemeId, useTheme } from "./theme";
import { readStoredUiFontSize, UI_FONT_KEY, useUiFont } from "./uiFont";
import "./fonts.css";
import "./styles.css";

const tabKey = new URLSearchParams(location.search).get("tab") ?? "";

// 主題、介面字級、語言與主視窗共用同一份 localStorage 偏好；主視窗改了（storage 事件）這裡跟著換。
useTheme.getState().setThemeId(useTheme.getState().themeId);
useUiFont.getState();
window.addEventListener("storage", (e) => {
  if (e.key === "dbkit:themeId") useTheme.getState().setThemeId(readStoredThemeId());
  else if (e.key === UI_FONT_KEY) useUiFont.getState().setSize(readStoredUiFontSize());
  else if (e.key === "dbkit:lang") {
    const l = readStoredLang();
    if (l !== useLang.getState().lang) void useLang.getState().setLang(l).catch(() => {});
  }
});

const render = () => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <SftpWindow tabKey={tabKey} />
      </ErrorBoundary>
    </React.StrictMode>,
  );
  // 視窗以 visible:false 建立：第一幀畫好才叫出來，免得 WebView2 初始化時閃一下白。
  requestAnimationFrame(() => requestAnimationFrame(() => { invoke("show_main_window").catch(() => {}); }));
};

const startLang = readStoredLang();
applyDocLang(startLang);
if (startLang === "zh-TW") render();
else void useLang.getState().setLang(startLang).catch(() => {}).then(render);
