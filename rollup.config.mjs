import terser from "@rollup/plugin-terser";

const dev = process.env.ROLLUP_WATCH === "true";

export default {
  input: "src/index.js",
  output: {
    file: "dist/span-panel-card.js",
    format: "iife",
    sourcemap: false,
  },
  plugins: dev ? [] : [terser()],
};
