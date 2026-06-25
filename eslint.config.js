import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

// 最小化 ESLint 設定：專注守住 React Hooks 規則。
// 背景：曾發生 React #310（「Rendered more hooks than during the previous render」）——
// 即「在條件式 / 提前 return 之前呼叫 hook」導致跨 render hook 數量不一致而崩潰。
// 過去沒有 lint 把關，這類錯誤才會混進 build。rules-of-hooks 設為 error，build 時即攔下。
export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
];
