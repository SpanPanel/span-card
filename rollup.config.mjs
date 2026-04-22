import replace from "@rollup/plugin-replace";
import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const dev = process.env.ROLLUP_WATCH === "true";
const plugins = [
  // ECharts (and some Lit internals) reference process.env.NODE_ENV for
  // dev-mode warning code. ``process`` doesn't exist in the browser, so
  // without this replacement the bundle throws ``ReferenceError: process
  // is not defined`` on first import and the entire panel fails to
  // mount. Replace at build time so the dead branches get DCE'd by
  // terser.
  replace({
    preventAssignment: true,
    values: {
      "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production"),
    },
  }),
  resolve({ browser: true }),
  typescript(),
  ...(dev ? [] : [terser()]),
];

export default [
  {
    input: "src/index.ts",
    output: {
      file: "dist/span-panel-card.js",
      format: "esm",
      sourcemap: false,
    },
    plugins,
  },
  {
    input: "src/panel/index.ts",
    output: {
      file: "dist/span-panel.js",
      format: "esm",
      sourcemap: false,
    },
    plugins,
  },
];
