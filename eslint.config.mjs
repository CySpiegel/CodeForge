import tseslint from "typescript-eslint";

// Minimal, non-type-aware lint layer on top of the strict tsc build. tsc already enforces types,
// no-unused-locals, and exhaustiveness; ESLint adds the rules tsc cannot express. Scoped to the TypeScript
// sources — the browser webview scripts under media/ have no build step and are checked with `node --check`.
export default tseslint.config(
  {
    ignores: ["out/**", "out-test/**", "media/**", "node_modules/**", "scripts/**", "eslint.config.mjs"]
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"]
    }
  },
  {
    // The sql.js/wasm loader intentionally uses conditional CommonJS require() to pick the vendored wasm
    // (packaged) over node_modules (dev/test) — there is no static import equivalent for that fallback.
    files: ["src/core/holographic/sqlite.ts"],
    rules: { "@typescript-eslint/no-require-imports": "off" }
  }
);
