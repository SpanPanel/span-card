import terser from "@rollup/plugin-terser";

const dev = process.env.ROLLUP_WATCH === "true";
const plugins = dev ? [] : [terser()];

export default [
  {
    input: "src/index.js",
    output: {
      file: "dist/span-panel-card.js",
      format: "iife",
      sourcemap: false,
    },
    plugins,
  },
  {
    input: "src/panel/index.js",
    output: {
      file: "dist/span-panel.js",
      format: "iife",
      sourcemap: false,
    },
    plugins,
  },
];
