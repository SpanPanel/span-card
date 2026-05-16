import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // happy-dom gives a real-enough DOM (custom elements, ResizeObserver
    // shim, getBoundingClientRect, classList) for the Lit-element and
    // observer tests under tests/. Pure-function tests don't depend on
    // the environment so they're not affected.
    environment: "happy-dom",
  },
});
