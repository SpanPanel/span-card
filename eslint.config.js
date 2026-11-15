import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Home Assistant is retiring the `friendly_name` state attribute, so nothing in `src/` may read it. A read is
// rejected wherever it writes the attribute's name out, in each of the forms a name can be written in:
// `attrs.friendly_name`, `attrs["friendly_name"]`, `` attrs[`friendly_name`] `` and `const { friendly_name } = attrs`.
const NO_FRIENDLY_NAME = "Do not read friendly_name: take the entity's own name from the registry, or ask hass.formatEntityName for the parts by name.";
const NO_FRIENDLY_NAME_SELECTORS = [
  // A property access, optional or not: `attrs.friendly_name`, `attrs?.friendly_name`.
  "MemberExpression[property.name='friendly_name']",
  // The name as a string, wherever it stands: `attrs["friendly_name"]`, `"friendly_name" in attrs`, a quoted key.
  "Literal[value='friendly_name']",
  // The name as a template literal's text: `` attrs[`friendly_name`] ``, a computed key.
  "TemplateElement[value.cooked='friendly_name']",
  // The name as a property key: `const { friendly_name } = attrs`, with or without a new name or a default, nested
  // or in a parameter; and a key of an object literal.
  "Property[key.name='friendly_name']",
];

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
      "no-restricted-syntax": ["error", ...NO_FRIENDLY_NAME_SELECTORS.map(selector => ({ selector, message: NO_FRIENDLY_NAME }))],
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
