import resolve from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const dev = process.env.ROLLUP_WATCH === "true";
const plugins = [resolve({ browser: true }), typescript(), ...(dev ? [] : [terser({ output: { comments: false } })])];

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
