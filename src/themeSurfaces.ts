// app 表面景深階梯：每一階 = mix(colors.bg → app.top, 比例)。editorThemes.buildAppVars 據此產生
// --c-well … --c-elevated；終端機（sshTerminalTheme）也從這裡取 --c-app 那一階當底色，
// 才會跟查詢編輯器（跟隨 App 時透明、透出 bg-app）是同一個顏色。
// 獨立一支檔：sshTerminalTheme 被純邏輯測試載入，不能經由 editorThemes 把 CodeMirror 拖進來。
export const SURFACE_STEPS = {
  well: 0,
  inset: 0.22,
  app: 0.42,
  panel: 0.6,
  bar: 0.8,
  elevated: 1,
} as const;
