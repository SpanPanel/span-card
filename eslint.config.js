import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        customElements: "readonly",
        HTMLElement: "readonly",
        CustomEvent: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        console: "readonly",
        fetch: "readonly",
        URL: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        IntersectionObserver: "readonly",
        performance: "readonly",
        localStorage: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "no-shadow": "off",
      "@typescript-eslint/no-shadow": "error",
      "consistent-return": "error",
    },
  },
  {
    files: ["rollup.config.mjs", "eslint.config.js", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "span-panel-card.js", "tests/"],
  }
);
