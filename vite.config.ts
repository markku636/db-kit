import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 版本號單一事實來源：讀 package.json（打包腳本 build-installer.ps1 會把
// package.json / tauri.conf.json / Cargo.toml 三者同步），於建置期注入成 __APP_VERSION__。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // 外部 gateway（External）連線類型的顯示開關。開源版預設不顯示（無內建驅動，選了也僅回 Unsupported）；
    // 提供私有 gateway 驅動的下游打包可設 DBKIT_EXTERNAL=1 於建置期開啟。
    __EXTERNAL__: JSON.stringify(process.env.DBKIT_EXTERNAL === "1"),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // CodeMirror 全家桶（含 @lezer 語法樹核心）獨立一包：只有 lazy 的
          // SqlEditor / MongoQueryEditor 等 chunk 依賴它，不進 initial load。
          if (/@codemirror|@uiw|@lezer|[\\/]node_modules[\\/]codemirror/.test(id)) return "codemirror";
          // React 核心獨立一包：快取穩定（App 改版時 vendor chunk hash 不變）。
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
});
