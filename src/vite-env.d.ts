/// <reference types="vite/client" />

// 由 vite.config.ts 的 define 於建置期注入（值來自 package.json 的 version）。
declare const __APP_VERSION__: string;
// 外部 gateway（External）連線類型的顯示開關；開源版預設 false，下游可於建置期開啟。
declare const __EXTERNAL__: boolean;
