import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";

const dev = process.env.ROLLUP_WATCH === "true";
const plugins = [typescript(), ...(dev ? [] : [terser()])];

export default [
  {
    input: "src/index.ts",
    output: {
      file: "dist/span-panel-card.js",
      format: "iife",
      sourcemap: false,
    },
    plugins,
  },
  {
    input: "src/panel/index.ts",
    output: {
      file: "dist/span-panel.js",
      format: "iife",
      sourcemap: false,
    },
    plugins,
  },
];
