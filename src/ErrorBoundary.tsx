import React from "react";
import { t } from "./i18n";

// 全域錯誤邊界：任一渲染錯誤時顯示友善訊息與重載鈕，避免整頁白屏。主視窗與 SFTP 獨立視窗共用。
export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-elevated border border-fg/10 rounded-lg p-6 space-y-3">
            <div className="text-red-300 font-medium">{t("發生未預期的錯誤")}</div>
            <pre className="text-xs text-fg/60 mono whitespace-pre-wrap break-all max-h-60 overflow-auto bg-inset rounded p-3">
              {this.state.error.message}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5"
              >
                {t("嘗試繼續")}
              </button>
              <button
                type="button"
                onClick={() => location.reload()}
                className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90"
              >
                {t("重新載入")}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
