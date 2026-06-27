// ESLint 9 flat config for @smscode/sdk.
// TypeScript-aware (typescript-eslint), Node + ES2022. Generated types and the
// build output are excluded — they are machine-emitted, not authored.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["dist", "src/types.gen.ts"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        // DOM globals used by the fetch-based client (fetch, Response, Headers,
        // AbortController, DOMException, RequestInfo types, etc.).
        ...globals.browser,
      },
    },
    rules: {
      // The SDK is fully typed — keep `any` out of authored source.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
]);
